'use strict';

// The SMS webhooks: STOP replies and delivery receipts, from Brevo and from
// Twilio.
//
// ── Brevo ──
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
//
// ── Twilio ──
//
// Twilio posts form-encoded bodies here, as each message's StatusCallback
// and, when the operator points the sending number's "A message comes in"
// webhook here too, for replies. It sends no token: every request carries
// X-Twilio-Signature, an HMAC-SHA1 of the public URL Twilio called plus the
// sorted parameters, keyed by TWILIO_AUTH_TOKEN. That URL is
// TWILIO_STATUS_CALLBACK_URL (the server sits behind a proxy and cannot
// rebuild it from the request), so with no URL or no auth token the route
// answers 404, and a signature that does not match answers 401.
//
//   - a reply Twilio marks OptOutType=STOP (its Advanced Opt-Out), or whose
//     Body is one of the STOP words, records an opt-out for From. Twilio
//     itself stops texting that number from that sender; the record gates
//     Homeroom's own marketing, as Brevo's does.
//   - a MessageSid with a MessageStatus updates the matching sms_deliveries
//     row (queued, sent, delivered, undelivered, failed).
//   - everything else answers 200 and is ignored. Every answer that is not
//     an error is an empty TwiML document, so Twilio sends no reply text.

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

/**
 * Twilio's request signature: base64 HMAC-SHA1, keyed by the auth token, of
 * the URL followed by every POST parameter's name and value, sorted by name.
 */
function twilioSignature(authToken, url, params) {
  const data = Object.keys(params || {}).sort().reduce((acc, key) => {
    const value = params[key];
    return acc + key + (Array.isArray(value) ? value.join('') : String(value ?? ''));
  }, String(url));
  return crypto.createHmac('sha1', String(authToken)).update(Buffer.from(data, 'utf8')).digest('base64');
}

function twilioSignatureMatches(header, authToken, url, params) {
  if (typeof header !== 'string' || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(twilioSignature(authToken, url, params));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

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

  router.post('/api/sms/webhooks/twilio', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const url = config?.twilioStatusCallbackUrl || process.env.TWILIO_STATUS_CALLBACK_URL;
    const authToken = config?.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;
    if (!url || !authToken) return res.status(404).json({ error: 'Not found' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!twilioSignatureMatches(req.get('x-twilio-signature'), authToken, url, body)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const pool = getPool(config);
    const sms = require('../services/sms');
    const reply = String(body.Body ?? '').trim().toUpperCase();
    const isOptOut = String(body.OptOutType || '').toUpperCase() === 'STOP'
      || (typeof body.Body === 'string' && STOP_WORDS.has(reply));

    try {
      if (isOptOut) {
        const phone = typeof body.From === 'string' ? body.From : null;
        if (phone) {
          try {
            await sms.recordOptOut(pool, phone, 'twilio_webhook');
            log.info('sms', 'Marketing opt-out recorded', { provider: 'twilio', phone: `…${phone.slice(-4)}` });
          } catch (err) {
            // An unusable number is not something Twilio can fix by retrying.
            if (!sms.SmsError || !(err instanceof sms.SmsError)) throw err;
            log.warn('sms', 'Marketing opt-out ignored for an unusable number', { code: err.code });
          }
        }
      } else {
        const messageId = typeof body.MessageSid === 'string' ? body.MessageSid
          : (typeof body.SmsSid === 'string' ? body.SmsSid : null);
        const status = body.MessageStatus || body.SmsStatus;
        if (messageId && typeof status === 'string' && status) {
          await pool.query(
            `UPDATE sms_deliveries
                SET delivery_status = $2
              WHERE provider = 'twilio' AND provider_message_id = $1`,
            [messageId, status.slice(0, 64)]
          );
        }
      }
      return res.type('text/xml').send(EMPTY_TWIML);
    } catch (err) {
      log.error('sms', 'Twilio SMS webhook failed', { err: err.message });
      return res.status(503).json({ error: 'Webhook temporarily unavailable' });
    }
  });

  return router;
}

module.exports = { smsWebhookRoutes, tokenMatches, twilioSignature, twilioSignatureMatches, STOP_WORDS };
