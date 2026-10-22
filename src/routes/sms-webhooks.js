'use strict';

// Brevo's SMS webhook: STOP replies and delivery receipts.
//
// Brevo posts here with `Authorization: Bearer <BREVO_SMS_WEBHOOK_TOKEN>`.
// Like the mail and GitHub webhooks it mounts BEFORE the global JSON parser
// and authentication (server.js): the caller is Brevo, which has no session.
// With no token configured the route answers 404, and a token that does not
// match answers 401, compared in constant time.
//
// What it does:
//   - an `unsubscribe`/`unsubscribed` event, or a `reply` whose trimmed,
//     upper-cased text is one of the STOP words, records an opt-out for that
//     number. Sign-in codes still reach it: opt-outs gate marketing only.
//   - any other event carrying a message id and a status updates the matching
//     sms_deliveries row (delivered, bounced, …). The webhook cannot be
//     trusted for anything else, so everything else answers 200 and is
//     ignored — Brevo retries non-2xx, and a malformed extra event must not
//     become a retry storm.

const crypto = require('crypto');
const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

const STOP_WORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'QUIT', 'CANCEL', 'ARRET',
]);

function tokenMatches(header, expected) {
  const given = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
  const a = Buffer.from(given);
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function phoneOf(body) {
  const value = body?.phone || body?.recipient || body?.to || body?.number;
  return typeof value === 'string' ? value : null;
}

function messageIdOf(body) {
  const value = body?.messageId ?? body?.message_id ?? body?.id;
  return value != null && String(value) ? String(value) : null;
}

function smsWebhookRoutes(config) {
  const router = express.Router();

  router.post('/api/sms/webhooks/brevo', express.json({ limit: '64kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const expected = config?.brevoSmsWebhookToken || process.env.BREVO_SMS_WEBHOOK_TOKEN;
    if (!expected) return res.status(404).json({ error: 'Not found' });
    if (!tokenMatches(req.get('authorization'), expected)) {
      return res.status(401).json({ error: 'Invalid webhook token' });
    }

    const body = req.body || {};
    const event = String(body.event || body.type || '').toLowerCase();
    const pool = getPool(config);
    const sms = require('../services/sms');

    const reply = String(body.text ?? body.message ?? body.content ?? '').trim().toUpperCase();
    const isOptOut = event === 'unsubscribe' || event === 'unsubscribed'
      || (event === 'reply' && STOP_WORDS.has(reply));

    try {
      if (isOptOut) {
        const raw = phoneOf(body);
        // Brevo's payloads spell numbers both ways; the platform stores
        // E.164, so a digits-only value gets its '+'.
        const phone = raw && !raw.startsWith('+') && /^[0-9]{7,15}$/.test(raw)
          ? `+${raw}` : raw;
        if (phone) {
          try {
            await sms.recordOptOut(pool, phone, 'brevo_webhook');
            log.info('sms', 'Marketing opt-out recorded', { phone: `…${phone.slice(-4)}` });
          } catch (err) {
            // An unusable number is not something Brevo can fix by retrying:
            // record nothing and answer 200, as an unhandled event does.
            if (!sms.SmsError || !(err instanceof sms.SmsError)) throw err;
            log.warn('sms', 'Marketing opt-out ignored for an unusable number', { code: err.code });
          }
        }
        return res.json({ ok: true });
      }

      const messageId = messageIdOf(body);
      const status = body.deliveryStatus || body.delivery_status || body.status;
      if (messageId && typeof status === 'string' && status) {
        await pool.query(
          `UPDATE sms_deliveries
              SET delivery_status = $2
            WHERE provider = 'brevo' AND provider_message_id = $1`,
          [messageId, status.slice(0, 64)]
        );
      }
      return res.json({ ok: true });
    } catch (err) {
      log.error('sms', 'Brevo SMS webhook failed', { err: err.message, event });
      return res.status(503).json({ error: 'Webhook temporarily unavailable' });
    }
  });

  return router;
}

module.exports = { smsWebhookRoutes, tokenMatches, STOP_WORDS };
