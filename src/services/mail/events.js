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
  // The statement is atomic: concurrent retries cannot duplicate either
  // the event or the suppression. Never persist the provider's raw payload,
  // which can contain addresses, bodies, IPs and user agents.
  await pool.query(
    `WITH inserted AS (
       INSERT INTO mail_events (delivery_id, type, event_key, meta)
       SELECT $1, $2, $3, jsonb_build_object('provider', 'resend', 'hardBounce', $4::boolean)
       WHERE $5::boolean
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id
     )
     INSERT INTO mail_suppressions (recipient, reason)
     SELECT lower($6), $7 WHERE $7::text IS NOT NULL
     ON CONFLICT (recipient) DO UPDATE SET
       reason = CASE WHEN mail_suppressions.reason = 'complaint' THEN 'complaint' ELSE EXCLUDED.reason END`,
    [delivery.id, type, `resend:${eventId}`, hardBounce, isTracked(delivery.kind), delivery.recipient, reason]
  );
  return 'recorded';
}

module.exports = { trackedKinds: () => [...TRACKED_KINDS], isTracked, messageId, suppression, verifyResend, ingestResend };
