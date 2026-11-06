// Brevo's transactional email API: POST /v3/smtp/email.
//
// Brevo keeps its own log of every send, filterable by the tag each one
// carries (the mail's kind). mail_deliveries keeps ours, and the receipt this
// returns is what ties a Brevo webhook back to a row (events.ingestBrevo).
//
// One attempt, like the other transports: these sends ride on always-200
// endpoints, so a hung provider degrades to "not delivered" quickly, and a
// timeout may already have sent the mail.
//
// BREVO_API_KEY is shared with Brevo SMS, so having it says nothing about
// mail. That is why ../select.js only uses this transport when it is named,
// by an admin in Admin → Email delivery or by PLATFORM_MAIL_PROVIDER, and
// never under auto.
'use strict';

const log = require('../../logger');
const { buildMessage, KINDS } = require('../templates');
const { normalizeBrevoMessageId } = require('../events');

const PROVIDER = 'brevo';
const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const SEND_TIMEOUT_MS = 8000;

function apiKeyOf(env) {
  return ((env && env.BREVO_API_KEY) || '').trim();
}

function missingKeys(env) {
  return apiKeyOf(env) ? [] : ['BREVO_API_KEY'];
}

// "Homeroom <no-reply@onhomeroom.com>" or a bare address, into Brevo's
// { name, email }. Null when there is no address in it.
function parseSender(value) {
  const text = String(value || '').trim();
  const named = text.match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  if (named) {
    const name = named[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return name ? { name, email: named[2] } : { email: named[2] };
  }
  return /^[^<>\s]+@[^<>\s]+$/.test(text) ? { email: text } : null;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPayload(sender, to, kind, message) {
  return {
    sender,
    to: [{ email: to }],
    subject: message.subject,
    // Brevo requires htmlContent.
    htmlContent: message.html || `<pre>${escapeHtml(message.text)}</pre>`,
    textContent: message.text,
    tags: [String(kind)],
    // A kind's own headers (activity mail's List-Unsubscribe).
    ...(message.headers ? { headers: { ...message.headers } } : {}),
  };
}

async function post(apiKey, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    let id = '';
    try { id = normalizeBrevoMessageId((JSON.parse(body) || {}).messageId); }
    catch { /* not JSON: no receipt, still sent */ }
    return id ? { providerMessageId: id.slice(0, 128) } : undefined;
  } finally {
    clearTimeout(timer);
  }
}

function create(env, { sender = null } = {}) {
  const apiKey = apiKeyOf(env);
  if (!apiKey) return null;
  const parsedSender = parseSender(sender);
  if (!parsedSender) {
    log.error('platform-mail-brevo',
      'Brevo mail has no usable sender address: set PLATFORM_MAIL_FROM');
    return null;
  }

  return {
    provider: PROVIDER,
    from: sender,
    async send({ to, kind, ...payload }) {
      const mailKind = kind || 'otp';
      const message = buildMessage(mailKind, payload);
      return post(apiKey, buildPayload(parsedSender, to, mailKind, message));
    },
  };
}

module.exports = { create, missingKeys, parseSender, PROVIDER, ENDPOINT, SEND_TIMEOUT_MS };
