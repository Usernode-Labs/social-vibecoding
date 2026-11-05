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
// mail. That is why ../select.js only uses this transport when
// PLATFORM_MAIL_PROVIDER names it, and never under auto.
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

// BREVO_MAIL_TEMPLATES: {"<kind>": <Brevo template id>}. Anything unusable is
// logged and left out, and that kind keeps Homeroom's own template. The admin
// test mail never moves: it exists to show the exact words it says it sent.
function parseTemplates(env) {
  const raw = ((env && env.BREVO_MAIL_TEMPLATES) || '').trim();
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.error('platform-mail-brevo', 'BREVO_MAIL_TEMPLATES is not a JSON object: using Homeroom\'s templates');
    return {};
  }
  const templates = {};
  for (const [kind, id] of Object.entries(parsed)) {
    if (KINDS.includes(kind) && kind !== 'admin_test' && Number.isSafeInteger(id) && id > 0) {
      templates[kind] = id;
    } else {
      log.error('platform-mail-brevo', 'BREVO_MAIL_TEMPLATES entry ignored', { kind });
    }
  }
  return templates;
}

// What a Brevo template can use as {{ params.<name> }}: the values the mail was
// sent with. Not the mail layer's own bookkeeping, and not an empty value, so a
// template's {% if params.code %} reads as it looks.
const NOT_PARAMS = new Set(['translate', 'resolved', 'messageId', 'trackingEnabled']);
function paramsFrom(payload) {
  const params = {};
  for (const [name, value] of Object.entries(payload)) {
    if (NOT_PARAMS.has(name) || value == null || typeof value === 'function') continue;
    params[name] = value;
  }
  return params;
}

function buildPayload(sender, to, kind, message) {
  return {
    sender,
    to: [{ email: to }],
    subject: message.subject,
    // Brevo documents htmlContent as required without a template.
    htmlContent: message.html || `<pre>${escapeHtml(message.text)}</pre>`,
    textContent: message.text,
    tags: [String(kind)],
    // A kind's own headers (activity mail's List-Unsubscribe).
    ...(message.headers ? { headers: { ...message.headers } } : {}),
  };
}

// The template brings the subject and body. The sender stays ours, overriding
// the template's, so a template cannot send from an address nobody authorised.
function templatePayload(own, templateId, payload) {
  const { subject, htmlContent, textContent, ...rest } = own;
  const params = paramsFrom(payload);
  return { ...rest, templateId, ...(Object.keys(params).length ? { params } : {}) };
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
  const templates = parseTemplates(env);

  // A Brevo template holds one language, so somebody who reads another gets
  // Homeroom's own template, translated.
  const templateFor = (kind, payload) => (
    !(payload && (payload.translate || payload.resolved?.readerHasLanguage)) && Object.prototype.hasOwnProperty.call(templates, kind)
      ? templates[kind]
      : null
  );

  return {
    provider: PROVIDER,
    from: sender,
    // send() asks before it renders: a Brevo template carries no tracked links
    // or pixel, so that mail must not be recorded as one that could report them.
    usesProviderTemplate: (kind, payload) => templateFor(kind, payload) !== null,
    async send({ to, kind, ...payload }) {
      const mailKind = kind || 'otp';
      const message = buildMessage(mailKind, payload);
      const own = buildPayload(parsedSender, to, mailKind, message);
      const templateId = templateFor(mailKind, payload);
      if (templateId === null) return post(apiKey, own);
      try {
        return await post(apiKey, templatePayload(own, templateId, payload));
      } catch (err) {
        // Refused, so nothing was sent: a deleted or inactive template must not
        // cost somebody their sign-in code. Anything else may already have sent.
        if (err.status !== 400 && err.status !== 404) throw err;
        log.error('platform-mail-brevo', 'Brevo refused a template: sending Homeroom\'s own',
          { kind: mailKind, templateId, message: err.message });
        return post(apiKey, own);
      }
    },
  };
}

module.exports = { create, missingKeys, parseSender, parseTemplates, PROVIDER, ENDPOINT, SEND_TIMEOUT_MS };
