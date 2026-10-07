// Platform outbound SMS - the one door every text goes through.
//
// THE CONTRACT, copied from services/mail/index.js because the same
// constraints hold: a send never throws and never returns a value the caller
// must check. The waitlist join is always-200 by contract (SPEC 1667) so it
// cannot be used to enumerate numbers, and a release notice rides an admin
// action that must not fail because a carrier hiccuped. So a provider
// outage, a missing credential, a throttled recipient and a successful
// delivery must all look identical from outside. The compensating visibility
// is the `sms_deliveries` table and the admin waitlist row's "Invite text:"
// line: the operator can see what happened even though the user can't.
//
// What this module owns, in order:
//   1. rendering is delegated to ./templates
//   2. the throttle decision (./rate-limit, fed from sms_deliveries)
//   3. picking the transport (./select, resolved once at boot in config.js)
//   4. recording the outcome in sms_deliveries
//   5. swallowing absolutely everything
//
// The three named senders at the bottom (sendWaitlistJoinSms /
// sendWaitlistCodeSms / sendWaitlistReleaseSms) mirror the mailer's
// signatures so a caller swapping a channel changes one argument.
'use strict';

const log = require('../logger');
const { PRODUCTION_ORIGIN } = require('../cli-auth-constants');
const { buildBody, KINDS, MAX_SEGMENT_CHARS } = require('./templates');
const rateLimit = require('./rate-limit');
const select = require('./select');

// How long a delivery record is kept. Long enough to answer "did that number
// ever get their code last week", short enough that the table is not a
// growing archive of who signed up when. Same figure as mail.
const RETENTION_DAYS = 30;
const PRUNE_LIMIT = 2000;

function poolFor(config) {
  if (!config || !config.databaseUrl) return null;
  try {
    return require('../../db/pool').getPool(config);
  } catch (err) {
    log.error('platform-sms', 'Could not resolve a database pool for SMS bookkeeping',
      { message: err.message });
    return null;
  }
}

function stagingLogOnly(config) {
  if (config && typeof config.smsStagingLogOnly === 'boolean') {
    return config.smsStagingLogOnly;
  }
  return process.env.USERNODE_ENV === 'staging';
}

function maxPerHour(config) {
  const fromConfig = Number(config && config.smsMaxPerHour);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  const fromEnv = Number(process.env.PLATFORM_SMS_MAX_PER_HOUR);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return rateLimit.DEFAULT_MAX_PER_HOUR;
}

// ─── sms_deliveries bookkeeping ─────────────────────────────────────────

async function record(pool, { kind, to, provider, status, error, providerMessageId = null }) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO sms_deliveries (kind, recipient, provider, status, error, provider_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [String(kind || '').slice(0, 64), String(to || '').slice(0, 32),
        provider ? String(provider).slice(0, 32) : null,
        String(status).slice(0, 24),
        error ? String(error).slice(0, 500) : null,
        providerMessageId ? String(providerMessageId).slice(0, 128) : null]
    );
  } catch (err) {
    // Bookkeeping must never be able to fail a send.
    log.error('platform-sms', 'Could not record an SMS delivery', { message: err.message });
  }
}

async function readHistory(pool, { kind, to }) {
  if (!pool) return { recipientHistory: [], globalCount: 0 };
  try {
    const [recipient, global] = await Promise.all([
      pool.query(
        `SELECT status, created_at FROM sms_deliveries
          WHERE recipient = $1 AND kind = $2
            AND created_at > NOW() - INTERVAL '24 hours'
          ORDER BY created_at DESC
          LIMIT 50`,
        [to, kind]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM sms_deliveries
          WHERE status IN ('sent', 'skipped_staging')
            AND created_at > NOW() - INTERVAL '1 hour'`
      ),
    ]);
    return {
      recipientHistory: recipient.rows,
      globalCount: (global.rows[0] && global.rows[0].n) || 0,
    };
  } catch (err) {
    // A read failure must not block a text. Fail OPEN on the throttle.
    log.error('platform-sms', 'Could not read SMS history - throttle skipped',
      { message: err.message });
    return { recipientHistory: [], globalCount: 0 };
  }
}

async function suppression(pool, recipient) {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      'SELECT reason FROM sms_suppressions WHERE recipient = $1', [recipient]
    );
    return (rows[0] && rows[0].reason) || null;
  } catch (err) {
    log.error('platform-sms', 'Could not read SMS suppressions', { message: err.message });
    return null;
  }
}

// Retention sweep, called opportunistically (never on a timer of its own).
async function pruneDeliveries(pool) {
  if (!pool) return 0;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM sms_deliveries
        WHERE id IN (
          SELECT id FROM sms_deliveries
           WHERE created_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
           LIMIT ${PRUNE_LIMIT}
        )`
    );
    return rowCount || 0;
  } catch (err) {
    log.error('platform-sms', 'sms_deliveries prune failed', { message: err.message });
    return 0;
  }
}

// ─── the send door ──────────────────────────────────────────────────────

// send(config, { kind, to, ...payload }) -> always resolves undefined.
async function send(config, { kind, to, ...payload } = {}) {
  try {
    if (!to || !kind) {
      log.error('platform-sms', 'Refusing a text with no recipient or kind', { kind });
      return;
    }
    // Render first: an unknown kind is a programming error and there is no
    // point consulting a throttle or a carrier for it. The body also rides
    // the payload to the transport, so a transport never re-renders.
    const body = buildBody(kind, payload);

    const transport = (config && config.smsTransport) || null;
    const provider = (transport && transport.provider)
      || (config && config.smsProvider)
      || (transport ? 'injected' : null);
    const pool = poolFor(config);

    if (!transport) {
      await record(pool, { kind, to, provider: null, status: 'no_transport' });
      if (config && (config.env === 'production' || process.env.USERNODE_ENV === 'production')) {
        // Never log the raw code in production. An unconfigured transport in
        // prod is an operational failure - log it loudly - but the caller
        // still gets its normal success response.
        log.error('platform-sms',
          'No SMS transport configured - text NOT delivered', { kind, to });
        return;
      }
      log.info('platform-sms', 'Text not delivered (no transport configured)',
        { kind, to, body });
      return;
    }

    const blocked = await suppression(pool, to);
    if (blocked) {
      await record(pool, { kind, to, provider, status: 'suppressed_bounce', error: blocked });
      return;
    }
    const { recipientHistory, globalCount } = await readHistory(pool, { kind, to });
    const decision = rateLimit.decide({
      kind,
      now: Date.now(),
      recipientHistory,
      globalCount,
      maxPerHour: maxPerHour(config),
    });
    if (!decision.allowed) {
      await record(pool, { kind, to, provider, status: 'suppressed_rate_limit', error: decision.reason });
      log.warn('platform-sms', 'Text suppressed by the outbound throttle',
        { kind, to, reason: decision.reason });
      return;
    }

    if (body.length > MAX_SEGMENT_CHARS) {
      // A body over one segment splits and can arrive out of order, which is
      // the exact failure the short templates exist to prevent. Refuse it
      // rather than spend two segments - this is a programming error, and it
      // is recorded as such.
      await record(pool, { kind, to, provider, status: 'failed', error: 'body exceeds one SMS segment' });
      log.error('platform-sms', 'Refusing a text body over one segment', { kind, to, length: body.length });
      return;
    }

    try {
      const detail = await transport.send({ to, kind, body, ...payload });
      await record(pool, {
        kind, to, provider,
        status: stagingLogOnly(config) ? 'skipped_staging' : 'sent',
        providerMessageId: detail && detail.providerMessageId,
      });
    } catch (err) {
      await record(pool, { kind, to, provider, status: 'failed', error: err.message });
      log.error('platform-sms', 'SMS transport failed to send',
        { kind, to, provider, message: err.message });
    }
  } catch (err) {
    // The outermost net. Nothing below here may reach a caller.
    log.error('platform-sms', 'SMS send failed before reaching a carrier',
      { kind, message: err.message });
  }
}

// ─── the named senders (the caller-facing API) ──────────────────────────

// A first join (or an idempotent re-join that minted nothing). `code` is
// optional: present on the join branch, absent when the row already existed.
async function sendWaitlistJoinSms(config, phone, { code = null } = {}) {
  await send(config, { kind: 'waitlist_joined_sms', to: phone, code });
}

// A code the recipient asked for again: the resend path and the re-join
// branch. Its own kind so the join's one-per-number-per-day rule cannot
// swallow it.
async function sendWaitlistCodeSms(config, phone, { code = null } = {}) {
  await send(config, { kind: 'waitlist_code_sms', to: phone, code });
}

// The "you're in" text on release. `url` is the plain sign-in or sign-up
// link; `hasAccount` picks which of the two.
async function sendWaitlistReleaseSms(config, phone, { hasAccount = false, url = null } = {}) {
  await send(config, {
    kind: 'waitlist_released_sms',
    to: phone,
    hasAccount,
    url: url || (hasAccount
      ? `${PRODUCTION_ORIGIN}/?login=1`
      : `${PRODUCTION_ORIGIN}/?signup=1`),
  });
}

module.exports = {
  send,
  sendWaitlistJoinSms,
  sendWaitlistCodeSms,
  sendWaitlistReleaseSms,
  pruneDeliveries,
  buildBody,
  KINDS,
  chooseTransport: select.chooseTransport,
  describe: select.describe,
  RETENTION_DAYS,
  PRUNE_LIMIT,
};
