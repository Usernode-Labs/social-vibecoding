'use strict';

// Outbound SMS: one way to validate a number, find its country and Sender
// ID, send through the selected gateway (Brevo or Twilio), and record what
// happened.
//
// The three entry points a caller uses:
//
//   sendOtpSms       a sign-in code, type "transactional", tag "otp"
//   sendMarketingSms type "marketing", after consent, opt-out and quiet-hour
//                    gates, with an opt-out line appended
//   sendTestSms      the admin console's plain test message
//
// Every one validates first, resolves the Sender ID (fail closed), and then
// sends — or, on a staging preview, logs the content and sends nothing, the
// way platform mail selects the log transport. Each attempt writes one
// sms_deliveries row and one log line carrying the kind, provider, country,
// Sender ID, status, the provider's message id and the number's last four
// digits. The full number is never stored in that table.
//
// The gateway is the selected provider when that is Brevo or Twilio
// (select.js), or `deps.provider` when a caller names one; anything else
// (Firebase, which sends its own texts) leaves Brevo, the first gateway.
// Each gateway has its own client and its own Sender ID registry.

const log = require('../logger');
const smsSelect = require('./select');
const brevo = require('./brevo');
const twilio = require('./twilio');
const senders = require('./senders');
const { countryOf } = require('./countries');
const { SmsError } = require('./errors');

const PROVIDER = 'brevo';
const CLIENTS = { brevo, twilio };
const DEFAULT_OPT_OUT = 'Reply STOP to unsubscribe';
const OTP_TEXT = (code) => `Your Homeroom code is ${code}. It expires in 10 minutes.`;
const TEST_TEXT = 'Homeroom test message from Admin, SMS delivery. No action needed.';

function last4(phone) {
  return typeof phone === 'string' && /^[0-9]{4}$/.test(phone.slice(-4)) ? phone.slice(-4) : null;
}

/**
 * A caller's number as E.164 plus its country. Reuses the phone-auth
 * service's normalisation so the whole platform accepts exactly one shape,
 * then refuses a country the calling-code table does not know.
 */
function validatePhone(raw) {
  // Lazy to avoid a require cycle: firebase-phone-auth.js requires this file.
  const { normalizePhone } = require('../firebase-phone-auth');
  const phone = normalizePhone(raw);
  if (!phone) throw new SmsError('invalid_phone', 'Enter a valid phone number.', 400);
  const country = countryOf(phone);
  if (!country) throw new SmsError('unsupported_country', 'That country is not supported yet.', 422);
  return { phone, country };
}

function isStaging(deps = {}) {
  return smsSelect.isStaging(deps.env || process.env);
}

/** The gateway a send goes through: see the header. */
function providerFor(config, deps = {}) {
  if (deps.provider && smsSelect.isGateway(deps.provider)) return deps.provider;
  const selected = smsSelect.selectedSync(config);
  return smsSelect.isGateway(selected) ? selected : PROVIDER;
}

function credentialsSet(config, provider) {
  if (!config) return false;
  if (provider === 'twilio') return !!(config.twilioAccountSid && config.twilioAuthToken);
  return !!config.brevoApiKey;
}

async function recordDelivery(pool, row) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO sms_deliveries
         (kind, provider, country, sender_id, phone_last4, status, error_code,
          provider_code, provider_message_id, attempts, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        row.kind,
        row.provider || PROVIDER,
        row.country,
        row.senderId || null,
        last4(row.phone),
        row.status,
        row.errorCode || null,
        row.providerCode || null,
        row.messageId || null,
        row.attempts || 0,
      ]
    );
  } catch (err) {
    // A delivery log that cannot be written must not fail the send itself.
    log.warn('sms', 'sms_deliveries write failed', { err: err.message, kind: row.kind });
  }
}

function logDelivery(row) {
  log.info('sms', 'SMS delivery', {
    kind: row.kind,
    provider: row.provider || PROVIDER,
    country: row.country,
    senderId: row.senderId || null,
    status: row.status,
    messageId: row.messageId || null,
    providerCode: row.providerCode || null,
    phone: row.phone ? `…${last4(row.phone)}` : null,
    attempts: row.attempts || 0,
  });
}

/**
 * The shared path every send takes. `content` is already final (the
 * marketing gate appends its opt-out line before this runs).
 */
async function deliver(pool, config, { kind, type, tag, phone, country, content }, deps = {}) {
  const provider = providerFor(config, deps);
  const entry = senders.senderFor(config, country, provider);
  const base = {
    kind,
    provider,
    country,
    senderId: entry.sender,
    phone,
  };

  if (isStaging(deps)) {
    // Nothing leaves a staging preview. The code is written to the log on
    // purpose, as the mail log transport does, so a tester can finish sign-in.
    log.info('sms', 'SMS logged only (staging)', {
      kind, provider, country, senderId: entry.sender,
      phone: `…${last4(phone)}`, content,
    });
    await recordDelivery(pool, { ...base, status: 'logged' });
    return { status: 'logged', provider, country, senderId: entry.sender, messageId: null };
  }

  if (!credentialsSet(config, provider)) {
    await recordDelivery(pool, { ...base, status: 'refused', errorCode: 'provider_not_configured' });
    logDelivery({ ...base, status: 'refused', errorCode: 'provider_not_configured' });
    throw new SmsError('provider_not_configured', 'Text messages are not configured for this server.', 503);
  }

  const answer = await CLIENTS[provider].send(config, {
    sender: entry.sender,
    recipient: phone,
    content,
    type,
    tag,
  }, deps);

  if (answer.ok) {
    const row = { ...base, status: 'sent', messageId: answer.messageId, attempts: answer.attempts };
    await recordDelivery(pool, row);
    logDelivery(row);
    return { status: 'sent', provider, country, senderId: entry.sender, messageId: answer.messageId };
  }

  const status = answer.unreachable ? 'failed' : 'refused';
  const errorCode = answer.unreachable ? 'provider_unreachable' : 'provider_refused';
  await recordDelivery(pool, {
    ...base, status, errorCode,
    providerCode: answer.providerCode,
    attempts: answer.attempts,
  });
  logDelivery({
    ...base, status, errorCode,
    providerCode: answer.providerCode,
    attempts: answer.attempts,
  });

  const error = new SmsError(
    errorCode,
    answer.unreachable
      ? 'Could not send the text. Try again.'
      : 'The text provider refused the message.',
    answer.unreachable ? 502 : 422
  );
  error.providerCode = answer.providerCode || null;
  throw error;
}

/** A sign-in code, transactional. `code` is the texted code. */
async function sendOtpSms(pool, config, { phoneNumber, code }, deps = {}) {
  const { phone, country } = validatePhone(phoneNumber);
  return deliver(pool, config, {
    kind: 'otp', type: 'transactional', tag: 'otp',
    phone, country, content: OTP_TEXT(code),
  }, deps);
}

/** The admin console's test, transactional and tagged apart from real codes. */
async function sendTestSms(pool, config, { phoneNumber }, deps = {}) {
  const { phone, country } = validatePhone(phoneNumber);
  return deliver(pool, config, {
    kind: 'test', type: 'transactional', tag: 'admin-test',
    phone, country, content: TEST_TEXT,
  }, deps);
}

function optOutLine(entry) {
  return entry.optOut || DEFAULT_OPT_OUT;
}

function appendOptOut(content, line) {
  if (typeof content !== 'string' || !content.trim()) return content;
  // An operator's own opt-out sentence counts; do not say it twice.
  if (/\bSTOP\b/i.test(content)) return content;
  return `${content.trim()} ${line}`;
}

/**
 * A marketing text, promotional. Gates, in this order:
 *
 *   1. a recorded opt-in that has not been withdrawn   (no_consent, opted_out)
 *   2. the recipient country's quiet hours             (quiet_hours)
 *   3. an opt-out line, appended once
 *
 * `now` is injectable so a test can sit on the edge of a window.
 */
async function sendMarketingSms(pool, config, { phoneNumber, content, tag = 'marketing', now = new Date() }, deps = {}) {
  const { phone, country } = validatePhone(phoneNumber);

  const consent = await consentFor(pool, phone);
  if (!consent || !consent.opted_in_at) {
    throw new SmsError('no_consent', 'That number has not opted in to marketing texts.', 422);
  }
  if (isOptedOut(consent)) {
    throw new SmsError('opted_out', 'That number has opted out of marketing texts.', 422);
  }

  const { quietHoursAllow } = require('./countries');
  if (!quietHoursAllow(country, now)) {
    throw new SmsError('quiet_hours', 'Marketing texts are not allowed in that country at this hour.', 422);
  }

  const entry = senders.senderFor(config, country, providerFor(config, deps));
  const body = appendOptOut(content, optOutLine(entry));
  return deliver(pool, config, {
    kind: 'marketing', type: 'marketing', tag: tag || 'marketing',
    phone, country, content: body,
  }, deps);
}

/**
 * Whether a consent row says no. An opt-out (a STOP reply, a provider event,
 * a switch turned off) wins over every opt-in before it; a NEW opt-in the
 * person gives afterwards (#6044: the switch in Settings, or the box at
 * sign-up) wins over that opt-out. Both timestamps stay on the row, so the
 * history of the number's answers is never erased.
 */
function isOptedOut(consent) {
  if (!consent || !consent.opted_out_at) return false;
  if (!consent.opted_in_at) return true;
  return new Date(consent.opted_out_at).getTime() >= new Date(consent.opted_in_at).getTime();
}

async function consentFor(pool, phone) {
  if (!pool) return null;
  const { rows } = await pool.query(
    'SELECT opted_in_at, opted_out_at FROM sms_marketing_consents WHERE phone_e164 = $1',
    [phone]
  );
  return rows[0] || null;
}

/** Record an opt-in. An earlier opt-out stays on the row; this opt-in, being
 *  newer, is what isOptedOut reads. Only a person's own explicit answer
 *  should call this (services/contact-preferences.js, #6044). */
async function recordConsent(pool, { phoneNumber, userId = null, source = null }) {
  const { phone } = validatePhone(phoneNumber);
  await pool.query(
    `INSERT INTO sms_marketing_consents (phone_e164, user_id, opted_in_at, opt_in_source)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (phone_e164) DO UPDATE
       SET opted_in_at = NOW(),
           opt_in_source = EXCLUDED.opt_in_source,
           user_id = COALESCE(EXCLUDED.user_id, sms_marketing_consents.user_id)`,
    [phone, userId, source]
  );
  return { phone };
}

/** Record an opt-out (a STOP reply, or a Brevo or Twilio opt-out event). */
async function recordOptOut(pool, phoneNumber, source = null) {
  const { phone } = validatePhone(phoneNumber);
  await pool.query(
    `INSERT INTO sms_marketing_consents (phone_e164, opted_out_at, opt_out_source)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (phone_e164) DO UPDATE
       SET opted_out_at = NOW(), opt_out_source = EXCLUDED.opt_out_source`,
    [phone, source]
  );
  return { phone };
}

module.exports = {
  SmsError,
  PROVIDER,
  CLIENTS,
  DEFAULT_OPT_OUT,
  OTP_TEXT,
  TEST_TEXT,
  validatePhone,
  providerFor,
  sendOtpSms,
  sendMarketingSms,
  sendTestSms,
  recordConsent,
  recordOptOut,
  isOptedOut,
  recordDelivery,
  appendOptOut,
  last4,
};
