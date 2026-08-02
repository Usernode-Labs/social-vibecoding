// The one concrete mail transport behind mailer.js's `{ async send(...) }`
// interface (see src/services/topochain/mailer.js for the contract and for
// why every failure path is swallowed).
//
// Two callers depend on this today, and BOTH looked healthy while sending
// nothing:
//   - POST /api/v4/mobile/auth/otp/request — the shell's email login. The
//     endpoint is always-200 by contract (SPEC 1667) so the user waits for
//     a code that never arrives.
//   - the onboarding waitlist join — same degrade-silently contract, same
//     silent non-delivery.
//
// Deliberately an HTTP-API transport rather than SMTP: no new dependency
// (SMTP would mean nodemailer), and every mail provider worth using
// (Resend, Postmark, SendGrid, SES via API Gateway) speaks
// "POST JSON with a bearer token". The provider-specific part is confined
// to buildPayload() below.
//
// Configuration lives in platform_env (dapp.json → "Topochain mail"), NOT
// in a child app's `secrets` block — this is the platform's own env. See
// the "Editing the PLATFORM itself" convention.
'use strict';

const log = require('../logger');

// Hard cap on how long a send may block the request it rides on. The
// callers are always-200 endpoints, so a hung provider must degrade to
// "not delivered" quickly rather than holding the user's request open.
const SEND_TIMEOUT_MS = 8000;

// Subject + body per message kind. `kind` is the discriminator mailer.js
// passes; an unknown kind is a programming error, so it throws rather than
// sending a blank email (the caller swallows it and logs).
function buildMessage(kind, payload) {
  switch (kind) {
    case 'otp':
      return {
        subject: 'Your Usernode login code',
        text: `Your Usernode login code is ${payload.code}.\n\n` +
          'It expires in 10 minutes. If you did not request it, you can ignore this email.',
      };
    case 'waitlist_joined':
      return {
        subject: "You're on the Usernode waitlist",
        text: 'Thanks for joining the Usernode waitlist.\n\n' +
          "We'll email you at this address as soon as your access is ready.",
      };
    default:
      throw new Error(`unknown mail kind: ${kind}`);
  }
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

// Build the transport object mailer.js expects, or null when the platform
// isn't configured for mail. Returning null (rather than a transport that
// throws) is what keeps mailer.js's "no transport configured" branch — and
// its loud production error — intact.
function create(env) {
  const endpoint = (env.TOPOCHAIN_MAIL_API_URL || '').trim();
  const apiKey = (env.TOPOCHAIN_MAIL_API_KEY || '').trim();
  const from = (env.TOPOCHAIN_MAIL_FROM || '').trim();

  // All three are needed for a send to be possible. A partial config is an
  // operator mistake worth naming at boot rather than discovering when the
  // first login code goes missing.
  if (!endpoint && !apiKey && !from) return null;
  if (!endpoint || !apiKey || !from) {
    const missing = [
      !endpoint && 'TOPOCHAIN_MAIL_API_URL',
      !apiKey && 'TOPOCHAIN_MAIL_API_KEY',
      !from && 'TOPOCHAIN_MAIL_FROM',
    ].filter(Boolean);
    log.error('topochain-mail-transport',
      'Mail is partially configured — email will NOT be delivered', { missing });
    return null;
  }

  return {
    async send({ to, kind, code }) {
      const message = buildMessage(kind || 'otp', { code });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(buildPayload(from, to, message)),
          signal: controller.signal,
        });
        if (!res.ok) {
          // Read a bounded slice of the body for the log — provider errors
          // are usually one useful line, and we must never log the code.
          const detail = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Presence/shape summary for the Admin console's Topochain → Settings row.
// Deliberately returns NO values — not even a masked key — so an admin can
// see whether mail works without the page ever carrying the credential.
function describe(env) {
  const endpoint = (env.TOPOCHAIN_MAIL_API_URL || '').trim();
  const apiKey = (env.TOPOCHAIN_MAIL_API_KEY || '').trim();
  const from = (env.TOPOCHAIN_MAIL_FROM || '').trim();
  const missing = [
    !endpoint && 'TOPOCHAIN_MAIL_API_URL',
    !apiKey && 'TOPOCHAIN_MAIL_API_KEY',
    !from && 'TOPOCHAIN_MAIL_FROM',
  ].filter(Boolean);
  return {
    configured: missing.length === 0,
    missing,
    // The flows that silently stop working while this is unconfigured.
    affectedFlows: [
      'Mobile email login (one-time codes)',
      'Onboarding waitlist confirmations',
    ],
  };
}

module.exports = { create, describe, buildMessage, SEND_TIMEOUT_MS };
