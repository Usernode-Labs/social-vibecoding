'use strict';
const crypto = require('node:crypto');
const events = require('./events');
const { PRODUCTION_ORIGIN } = require('../cli-auth-constants');
const ID_RE = /^[a-f0-9]{48}$/;
function secret() { return process.env.PLATFORM_MAIL_TRACKING_SECRET || ''; }
function sign(purpose, id, key = secret()) {
  return key ? crypto.createHmac('sha256', key).update(`mail:${purpose}:${id}`).digest('base64url') : null;
}
function matches(purpose, id, signature) {
  const want = ID_RE.test(id || '') && sign(purpose, id);
  return !!(want && typeof signature === 'string' && signature.length === want.length
    && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(want)));
}
function destination(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}
function attributedPayload(kind, payload) {
  if (!events.isTracked(kind) || !payload.trackingEnabled || !ID_RE.test(payload.messageId || '') || !secret()) return payload;
  if (!payload.unsubscribeUrl) return payload;
  try {
    const url = new URL(payload.unsubscribeUrl);
    if (url.origin !== PRODUCTION_ORIGIN || url.pathname !== '/mail/unsubscribe') return payload;
    url.searchParams.set('m', payload.messageId);
    url.searchParams.set('s', sign('unsubscribe', payload.messageId));
    return { ...payload, unsubscribeUrl: String(url) };
  } catch { return payload; }
}
function decorate(kind, message, payload) {
  if (!events.isTracked(kind) || !payload.trackingEnabled || !ID_RE.test(payload.messageId || '') || !secret()) return message;
  const links = [];
  const id = payload.messageId;
  const html = message.html.replace(/(<a\b[^>]*\bhref=")([^"]*)(")/g, (match, start, escaped, end) => {
    const url = destination(escaped.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    if (!url) return match;
    // RFC 8058 must POST to the original endpoint, and a GET still only
    // asks for confirmation. Neither clients nor scanners unsubscribe by click.
    if (new URL(url).pathname === '/mail/unsubscribe') return match;
    let index = links.indexOf(url);
    if (index < 0) { index = links.length; links.push(url); }
    return `${start}${PRODUCTION_ORIGIN}/mail/c/${id}/${index}?s=${sign(`click:${index}`, id)}${end}`;
  });
  const pixel = `<img src="${PRODUCTION_ORIGIN}/mail/o/${id}.gif?s=${sign('open', id)}" width="1" height="1" alt="" style="display:none" />`;
  return { ...message, html: html.replace('</body>', pixel + '</body>'), trackingLinks: links };
}
function classify(userAgent) {
  const ua = String(userAgent || '');
  if (/GoogleImageProxy|ggpht\.com/i.test(ua)) return 'image_proxy';
  if (/YahooMailProxy|Outlook.*(proxy|image)|Microsoft Office Existence Discovery/i.test(ua)) return 'image_proxy';
  if (/AppleMail|Mail\/|iPhone.*AppleWebKit/i.test(ua)) return 'possible_privacy_proxy';
  if (/bot|crawler|spider|preview|prefetch|Headless|Proofpoint|Mimecast|Barracuda/i.test(ua)) return 'scanner_or_prefetch';
  return ua ? 'unknown_client' : 'unknown';
}
async function recordUnsubscribe(pool, { userId, messageId, signature }) {
  if (!matches('unsubscribe', messageId, signature)) return;
  await pool.query(
    `INSERT INTO mail_events (delivery_id, type, event_key)
     SELECT d.id, 'unsubscribed', 'unsubscribe:' || d.message_id
       FROM mail_deliveries d JOIN users u ON lower(u.email) = lower(d.recipient)
      WHERE d.message_id = $1 AND d.engagement_tracked AND u.id = $2 AND d.kind = ANY($3::text[])
     ON CONFLICT (event_key) DO NOTHING`, [messageId, userId, events.trackedKinds()]
  );
}
module.exports = { secret, sign, matches, destination, attributedPayload, decorate, classify, recordUnsubscribe };
