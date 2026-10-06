// Twilio SMS transport. The REST shape Twilio documents is the simplest to
// transcribe of the carriers worth using: one POST to the Messages resource,
// form-encoded, with the account SID as a basic-auth username and the auth
// token as the password.
//
// A sender may be named either by a From number or by a Messaging Service
// SID (Twilio's own recommended way to send A2P traffic, because the service
// picks a registered number from the campaign). When a Messaging Service SID
// is set it wins over From, matching Twilio's own precedence.
//
// Configuration lives in platform_env (dapp.json -> "Platform SMS"), NOT in
// a child app's `secrets` block - this is the platform's own env.
'use strict';

const log = require('../../logger');

const PROVIDER = 'twilio';

// Hard cap on how long a send may block the request it rides on. The
// callers are always-200 endpoints, so a hung carrier must degrade to
// "not delivered" quickly rather than holding the user's request open.
const SEND_TIMEOUT_MS = 8000;

function readEnv(env) {
  const e = env || {};
  return {
    accountSid: (e.TWILIO_ACCOUNT_SID || '').trim(),
    authToken: (e.TWILIO_AUTH_TOKEN || '').trim(),
    messagingServiceSid: (e.TWILIO_MESSAGING_SERVICE_SID || '').trim(),
    from: (e.PLATFORM_SMS_FROM || '').trim(),
  };
}

// Which of the keys are absent. A send needs the SID and the token plus a
// sender: either the messaging service or a From number.
function missingKeys(env) {
  const { accountSid, authToken, messagingServiceSid, from } = readEnv(env);
  return [
    !accountSid && 'TWILIO_ACCOUNT_SID',
    !authToken && 'TWILIO_AUTH_TOKEN',
    !messagingServiceSid && !from && 'TWILIO_MESSAGING_SERVICE_SID or PLATFORM_SMS_FROM',
  ].filter(Boolean);
}

// Build the transport, or null when this provider isn't configured.
// Returning null (rather than a transport that throws) is what lets
// select.js fall through to the next candidate and what keeps the
// "no transport configured" branch intact.
function create(env, { sender = null } = {}) {
  const { accountSid, authToken, messagingServiceSid, from } = readEnv(env || {});

  const anyKey = accountSid || authToken || messagingServiceSid || from;
  if (!anyKey) return null;
  if (missingKeys(env || {}).length) {
    log.error('platform-sms-twilio',
      'Twilio is partially configured - texts will NOT be delivered',
      { missing: missingKeys(env || {}) });
    return null;
  }

  return {
    provider: PROVIDER,
    from: from || sender || null,
    async send({ to, kind, ...payload }) {
      const body = payload.body || '';
      const params = new URLSearchParams();
      params.set('To', to);
      if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
      else params.set('From', from || sender);
      params.set('Body', body);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
            },
            body: params.toString(),
            signal: controller.signal,
          }
        );
        if (!res.ok) {
          // A bounded slice for the log - provider errors are usually one
          // useful line, and we must never log the body.
          const detail = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
        }
        const text = await res.text().catch(() => '');
        try {
          const receipt = JSON.parse(text) || {};
          if (receipt.sid) return { providerMessageId: String(receipt.sid).slice(0, 128) };
        } catch { /* not JSON: no receipt, still sent */ }
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Presence only - never a value - so the admin card can name what is missing.
function describe(env) {
  const missing = missingKeys(env || {});
  return { configured: missing.length === 0, missing };
}

module.exports = { create, describe, missingKeys, PROVIDER, SEND_TIMEOUT_MS };
