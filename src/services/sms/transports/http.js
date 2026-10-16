// Generic "POST JSON with a bearer token" SMS transport - the same shape as
// the generic mail transport (services/mail/transports/http-api.js), so a
// provider swap is one endpoint and one body builder rather than a rewrite.
//
// Configuration lives in platform_env (dapp.json -> "Platform SMS"), NOT in
// a child app's `secrets` block - this is the platform's own env.
'use strict';

const log = require('../../logger');

const PROVIDER = 'http';

const SEND_TIMEOUT_MS = 8000;

const KEYS = ['TOPOCHAIN_SMS_API_URL', 'TOPOCHAIN_SMS_API_KEY', 'TOPOCHAIN_SMS_FROM'];

function readEnv(env) {
  const e = env || {};
  return {
    endpoint: (e.TOPOCHAIN_SMS_API_URL || '').trim(),
    apiKey: (e.TOPOCHAIN_SMS_API_KEY || '').trim(),
    from: (e.TOPOCHAIN_SMS_FROM || '').trim(),
  };
}

function missingKeys(env) {
  const { endpoint, apiKey, from } = readEnv(env);
  return [
    !endpoint && 'TOPOCHAIN_SMS_API_URL',
    !apiKey && 'TOPOCHAIN_SMS_API_KEY',
    !from && 'TOPOCHAIN_SMS_FROM',
  ].filter(Boolean);
}

// A minimal provider-shaped body. Kept in one function so pointing at a
// different provider is a single edit.
function buildPayload(from, to, body) {
  return { from, to, body };
}

function create(env, { sender = null } = {}) {
  const { endpoint, apiKey, from } = readEnv(env || {});

  if (!endpoint && !apiKey && !from) return null;
  if (!endpoint || !apiKey || !from) {
    log.error('platform-sms-http',
      'SMS over HTTP is partially configured - texts will NOT be delivered',
      { missing: missingKeys(env || {}) });
    return null;
  }

  return {
    provider: PROVIDER,
    from: sender || from,
    async send({ to, kind, ...payload }) {
      const body = payload.body || '';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(buildPayload(sender || from, to, body)),
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
        }
        const text = await res.text().catch(() => '');
        try {
          const receipt = JSON.parse(text) || {};
          const id = receipt.id || receipt.sid || receipt.message_id;
          if (id) return { providerMessageId: String(id).slice(0, 128) };
        } catch { /* not JSON: no receipt, still sent */ }
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function describe(env) {
  const missing = missingKeys(env || {});
  return { configured: missing.length === 0, missing };
}

module.exports = { create, describe, missingKeys, PROVIDER, KEYS, SEND_TIMEOUT_MS };
