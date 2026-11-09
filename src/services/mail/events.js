'use strict';

const crypto = require('node:crypto');

// Engagement and delivery reports are opt-in. Codes and recovery links
// must never acquire pixels or redirects when new templates are added.
const TRACKED_KINDS = new Set(['build_ready', 'invite_activity', 'waitlist_released', 'project_invite']);
function isTracked(kind) { return TRACKED_KINDS.has(kind); }
function messageId() { return crypto.randomBytes(24).toString('hex'); }

async function suppression(pool, recipient) {
  if (!pool) return null;
  const { rows } = await pool.query(
    'SELECT reason FROM mail_suppressions WHERE recipient = lower($1)', [recipient]
  );
  return rows[0]?.reason || null;
}

// Verify Resend's Svix signature against the exact raw request bytes.
// https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
function verifyResend(raw, headers, secret, now = Date.now()) {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatures = headers['svix-signature'];
  if (!Buffer.isBuffer(raw) || !secret || !/^whsec_[A-Za-z0-9+/]+=*$/.test(secret)
      || typeof id !== 'string' || !id || id.length > 255
      || typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)
      || typeof signatures !== 'string' || signatures.length > 4096
      || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice(6), 'base64');
  if (!key.length) return false;
  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.`).update(raw).digest();
  return signatures.split(/\s+/).some((part) => {
    const [version, signature] = part.split(',');
    if (version !== 'v1' || !signature || !/^[A-Za-z0-9+/]+=*$/.test(signature)) return false;
    const actual = Buffer.from(signature, 'base64');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
}

const RESEND_TYPES = Object.freeze({
  'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained',
});

async function ingestResend(pool, event, eventId) {
  const type = Object.prototype.hasOwnProperty.call(RESEND_TYPES, event?.type)
    ? RESEND_TYPES[event.type] : null;
  if (!type) return 'ignored';
  const providerId = event?.data?.email_id;
  if (typeof providerId !== 'string' || !providerId || providerId.length > 128) return 'invalid';
  // Retry an early webhook: the provider can call back before send() has
  // persisted its receipt. Never resolve a delivery by an untrusted address.
  const { rows } = await pool.query(
    `SELECT id, kind, recipient FROM mail_deliveries
      WHERE provider = 'http' AND provider_message_id = $1`, [providerId]
  );
  const delivery = rows[0];
  if (!delivery) return 'pending';
  const hardBounce = type === 'bounced' && event.data?.bounce?.type === 'Permanent';
  const reason = type === 'complained' ? 'complaint' : hardBounce ? 'bounce' : null;
  await recordProviderEvent(pool, delivery, {
    type, provider: 'resend', eventKey: `resend:${eventId}`, hardBounce, reason,
  });
  return 'recorded';
}

// The statement is atomic: concurrent retries cannot duplicate either
// the event or the suppression. Never persist the provider's raw payload,
// which can contain addresses, bodies, IPs and user agents.
async function recordProviderEvent(pool, delivery, { type, provider, eventKey, hardBounce, reason }) {
  await pool.query(
    `WITH inserted AS (
       INSERT INTO mail_events (delivery_id, type, event_key, meta)
       SELECT $1, $2, $3, jsonb_build_object('provider', $8::text, 'hardBounce', $4::boolean)
       WHERE $5::boolean
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id
     )
     INSERT INTO mail_suppressions (recipient, reason)
     SELECT lower($6), $7 WHERE $7::text IS NOT NULL
     ON CONFLICT (recipient) DO UPDATE SET
       reason = CASE WHEN mail_suppressions.reason = 'complaint' THEN 'complaint' ELSE EXCLUDED.reason END`,
    [delivery.id, type, eventKey, hardBounce, isTracked(delivery.kind), delivery.recipient, reason, provider]
  );
}

// What Brevo's transactional webhook reports, in mail_events' words.
//
// A hard bounce or an invalid address will never be delivered and a spam
// report means stop, so those suppress the address here, as Resend's do.
// `blocked` does not: Brevo is already refusing that address, and it can be
// unblocked there, which a second copy here would not hear about.
//
// Opens and clicks are left out on purpose. The platform's own link and pixel
// (./tracking.js) count those and class scanners and image proxies, and the
// admin Journey reads them as a person's unless so classed. Brevo's own counts
// stay in Brevo's dashboard, along with the rest of what it reports.
const BREVO_TYPES = Object.freeze({
  delivered: { type: 'delivered' },
  hard_bounce: { type: 'bounced', hardBounce: true, reason: 'bounce' },
  invalid_email: { type: 'bounced', hardBounce: true, reason: 'bounce' },
  soft_bounce: { type: 'bounced' },
  blocked: { type: 'bounced' },
  spam: { type: 'complained', reason: 'complaint' },
});

// How long an event about a message with no row yet is worth retrying. The
// wait is for send() to save its receipt, which takes moments. The same Brevo
// account can send mail that was never ours, and asking Brevo to retry those
// forever would help nobody.
const BREVO_PENDING_WINDOW_MS = 15 * 60 * 1000;

// Brevo answers a send with the id in angle brackets. Webhooks carry the same
// id, so both sides go through this before they are compared.
function normalizeBrevoMessageId(value) {
  return typeof value === 'string' ? value.trim().replace(/^<|>$/g, '') : '';
}

function brevoEventTime(event) {
  const ms = Number(event?.ts_epoch);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(event?.ts_event ?? event?.ts);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

async function ingestBrevo(pool, event, now = Date.now()) {
  const mapped = typeof event?.event === 'string' && Object.prototype.hasOwnProperty.call(BREVO_TYPES, event.event)
    ? BREVO_TYPES[event.event] : null;
  if (!mapped) return 'ignored';
  const providerId = normalizeBrevoMessageId(event['message-id']);
  if (!providerId || providerId.length > 128) return 'invalid';
  // As with Resend, never resolve a delivery by the address in the payload.
  const { rows } = await pool.query(
    `SELECT id, kind, recipient FROM mail_deliveries
      WHERE provider = 'brevo' AND provider_message_id = $1`, [providerId]
  );
  const delivery = rows[0];
  if (!delivery) {
    const at = brevoEventTime(event);
    return at !== null && now - at < BREVO_PENDING_WINDOW_MS ? 'pending' : 'ignored';
  }
  // Brevo's events have no id of their own, and a retry repeats the payload.
  await recordProviderEvent(pool, delivery, {
    type: mapped.type,
    provider: 'brevo',
    eventKey: `brevo:${providerId}:${event.event}`,
    hardBounce: !!mapped.hardBounce,
    reason: mapped.reason || null,
  });
  return 'recorded';
}

module.exports = { trackedKinds: () => [...TRACKED_KINDS], isTracked, messageId, suppression, verifyResend, ingestResend, ingestBrevo, normalizeBrevoMessageId };
