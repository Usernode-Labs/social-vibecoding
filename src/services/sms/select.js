'use strict';

// Which provider sends Homeroom's texts, and what the admin console is told
// about it.
//
// Order of decisions, most binding first:
//
//  1. A row saved by an admin (platform_settings `sms_provider`) → that one.
//  2. PLATFORM_SMS_PROVIDER (config.smsProviderDefault) → that one, when it
//     names a provider this build knows.
//  3. Neither → firebase, today's behaviour.
//
// The read is cached for ten seconds, like the other platform settings
// (services/shots-density.js), because the offer gate is synchronous and is
// consulted on every phone-auth request. setProvider invalidates the cache
// and publishes the new value to the synchronous readers immediately.
//
// A provider that is not ready is still SELECTED if an admin saved it (or the
// deploy named it): the offer gate then closes — real numbers get no text —
// and the admin status card says which settings are missing. That is the
// fail-closed behaviour the platform's other provider switches use.

const log = require('../logger');

const KEY = 'sms_provider';
const CACHE_MS = 10_000;

function isStaging(env) {
  return (env && env.USERNODE_ENV) === 'staging';
}

function firebaseMissing(config) {
  const missing = [];
  if (!config || config.firebasePhoneAuthEnabled !== true) missing.push('FIREBASE_PHONE_AUTH_ENABLED');
  if (!config || !config.firebaseWebApiKey) missing.push('FIREBASE_WEB_API_KEY');
  if (!config || !config.firebaseProjectId) missing.push('FIREBASE_PROJECT_ID');
  if (!config || !config.firebaseServiceAccountJsonB64) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON_B64');
  return missing;
}

function brevoMissing(config, env = process.env) {
  const missing = [];
  // A staging preview never reaches Brevo, so the key is not needed there.
  if (!isStaging(env) && !(config && config.brevoApiKey)) missing.push('BREVO_API_KEY');
  const registry = config && config.brevoSmsSenderIds;
  if (!registry || typeof registry !== 'object' || Object.keys(registry).length === 0) {
    missing.push('BREVO_SMS_SENDER_IDS');
  }
  return missing;
}

const PROVIDERS = [
  {
    name: 'firebase',
    label: 'Firebase',
    missing: (config) => firebaseMissing(config),
  },
  {
    name: 'brevo',
    label: 'Brevo',
    missing: (config, env) => brevoMissing(config, env),
  },
];

function providerByName(name) {
  return PROVIDERS.find((p) => p.name === name) || null;
}

let cache = null;        // { at, value } for the saved-or-default selection
let lastSelection = null; // what selectedSync returns, before the first read

// The deploy's choice, read from the environment the way mail/select.js
// reads PLATFORM_MAIL_PROVIDER. An unknown value is loud and falls back.
function envDefault(env = process.env) {
  const raw = ((env && env.PLATFORM_SMS_PROVIDER) || '').trim().toLowerCase();
  if (!raw) return { provider: 'firebase', source: 'default' };
  if (providerByName(raw)) return { provider: raw, source: 'env' };
  log.error('sms', 'PLATFORM_SMS_PROVIDER is not a known provider — falling back to firebase', {
    allowed: PROVIDERS.map((p) => p.name),
  });
  return { provider: 'firebase', source: 'default' };
}

/**
 * The provider in force, { provider, source: 'admin' | 'env' | 'default' }.
 * Never throws: an unreadable setting falls back to the deploy's default,
 * so a broken database cannot take phone sign-in down.
 */
async function selection(pool, { now = Date.now(), env = process.env } = {}) {
  if (cache && now - cache.at < CACHE_MS && cache.value) return cache.value;

  let value = null;
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [KEY]);
      const saved = rows[0]?.value;
      if (typeof saved === 'string' && providerByName(saved)) {
        value = { provider: saved, source: 'admin' };
      }
    } catch (err) {
      // platform_settings may not exist yet on a very first boot.
      log.warn('sms', 'sms_provider read failed', { err: err.message });
    }
  }
  if (!value) value = envDefault(env);

  cache = { at: now, value };
  lastSelection = value;
  return value;
}

/** The last value read, or the deploy's default before the first read. */
function selectedSync(config) {
  if (lastSelection && lastSelection.provider) return lastSelection.provider;
  const raw = config && typeof config.smsProviderDefault === 'string'
    ? config.smsProviderDefault.trim().toLowerCase()
    : '';
  return providerByName(raw) ? raw : 'firebase';
}

async function setProvider(pool, name, userId = null) {
  if (!providerByName(name)) throw new Error(`Unknown SMS provider: ${name}`);
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [KEY, name, userId]
  );
  lastSelection = { provider: name, source: 'admin' };
  cache = { at: Date.now(), value: lastSelection };
  return lastSelection;
}

function invalidate() {
  cache = null;
  lastSelection = null;
}

/**
 * What Admin → SMS delivery renders: the selected provider, where the choice
 * came from, and per-provider readiness with the names of missing settings
 * (never their values).
 */
function describe(config, chosen = null, env = process.env) {
  const current = chosen && chosen.provider ? chosen.provider : selectedSync(config);
  const source = chosen && chosen.source ? chosen.source : 'default';
  return {
    selected: current,
    source,
    options: PROVIDERS.map((provider) => {
      const missing = provider.missing(config, env);
      return {
        name: provider.name,
        label: provider.label,
        ready: missing.length === 0,
        missing,
      };
    }),
    stagingLogOnly: isStaging(env),
  };
}

function optionReady(config, name, env = process.env) {
  const provider = providerByName(name);
  return !!provider && provider.missing(config, env).length === 0;
}

module.exports = {
  KEY,
  CACHE_MS,
  PROVIDERS,
  isStaging,
  firebaseMissing,
  brevoMissing,
  envDefault,
  selection,
  selectedSync,
  setProvider,
  invalidate,
  describe,
  optionReady,
};
