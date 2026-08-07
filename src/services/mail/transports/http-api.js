// Generic "POST JSON with a bearer token" mail transport — the original
// platform transport, moved here unchanged in behaviour when the mailer
// grew a second provider (see ../select.js).
//
// Deliberately not SMTP: SMTP would mean a new dependency (nodemailer)
// and the runtime image installs with `npm ci --production`. Every
// provider worth using (Resend, Postmark, SendGrid, SES behind API
// Gateway) speaks this shape, and the provider-specific part is confined
// to buildPayload() below.
//
// Configuration lives in platform_env (dapp.json → "Platform mail" and
// the older "Topochain mail" group), NOT in a child app's `secrets`
// block — this is the platform's own env.
'use strict';

const log = require('../../logger');
const { buildMessage } = require('../templates');

const PROVIDER = 'http';

// Hard cap on how long a send may block the request it rides on. The
// callers are always-200 endpoints, so a hung provider must degrade to
// "not delivered" quickly rather than holding the user's request open.
const SEND_TIMEOUT_MS = 8000;

const KEYS = ['TOPOCHAIN_MAIL_API_URL', 'TOPOCHAIN_MAIL_API_KEY', 'TOPOCHAIN_MAIL_FROM'];

function readEnv(env) {
  return {
    endpoint: ((env && env.TOPOCHAIN_MAIL_API_URL) || '').trim(),
    apiKey: ((env && env.TOPOCHAIN_MAIL_API_KEY) || '').trim(),
    from: ((env && env.TOPOCHAIN_MAIL_FROM) || '').trim(),
  };
}

// Which of the three keys are absent. Used both by create() (to name an
// operator mistake at boot) and by select.js (to decide whether this
// provider is even a candidate).
function missingKeys(env) {
  const { endpoint, apiKey, from } = readEnv(env);
  return [
    !endpoint && 'TOPOCHAIN_MAIL_API_URL',
    !apiKey && 'TOPOCHAIN_MAIL_API_KEY',
    !from && 'TOPOCHAIN_MAIL_FROM',
  ].filter(Boolean);
}

// Resend/Postmark-shaped JSON body. Kept in one function so pointing at a
// different provider is a single edit rather than a hunt.
function buildPayload(from, to, message) {
  return {
    from,
    to: [to],
    subject: message.subject,
    text: message.text,
  };
}

// Build the transport, or null when this provider isn't configured.
// Returning null (rather than a transport that throws) is what lets
// select.js fall through to the next candidate and what keeps the "no
// transport configured" branch — and its loud production error — intact.
function create(env, { sender = null } = {}) {
  const { endpoint, apiKey, from } = readEnv(env || {});

  // All three are needed for a send to be possible. A partial config is an
  // operator mistake worth naming at boot rather than discovering when the
  // first login code goes missing.
  if (!endpoint && !apiKey && !from) return null;
  if (!endpoint || !apiKey || !from) {
    log.error('platform-mail-http',
      'Mail is partially configured — email will NOT be delivered',
      { missing: missingKeys(env || {}) });
    return null;
  }

  return {
    provider: PROVIDER,
    from: sender || from,
    async send({ to, kind, ...payload }) {
      const message = buildMessage(kind || 'otp', payload);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(buildPayload(sender || from, to, message)),
          signal: controller.signal,
        });
        if (!res.ok) {
          // Read a bounded slice of the body for the log — provider errors
          // are usually one useful line, and we must never log the code.
          const detail = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
        }
        // Most providers answer with { id: "..." }. Optional detail:
        // send() ignores it, sendTest() shows it as the provider's own
        // receipt. A non-JSON success body is still a success.
        const body = await res.text().catch(() => '');
        try {
          const id = (JSON.parse(body) || {}).id;
          if (id) return { providerMessageId: String(id).slice(0, 128) };
        } catch { /* not JSON: no receipt, still sent */ }
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// The LEGACY presence summary, kept byte-compatible with what the admin
// console's mail-status row used before this transport had siblings: it
// names only the three TOPOCHAIN_MAIL_* keys. ../select.js has the
// provider-aware describe() the console renders today; this one stays so
// the old `mail-transport.js` shim's contract is unchanged.
//
// Deliberately returns NO values — not even a masked key — so an admin
// can see whether mail works without the page ever carrying a credential.
function describe(env) {
  const missing = missingKeys(env || {});
  return {
    configured: missing.length === 0,
    missing,
    // The flows that silently stop working while this is unconfigured.
    affectedFlows: [
      'Mobile email login (one-time codes)',
      'Onboarding waitlist confirmations',
      'Waitlist release notifications',
    ],
  };
}

module.exports = { create, describe, missingKeys, PROVIDER, KEYS, SEND_TIMEOUT_MS };
