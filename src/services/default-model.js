'use strict';

// The platform's default OpenRouter coding model, as every reader must
// resolve it.
//
// OPENROUTER_DEFAULT_CODEX_MODEL was the whole story: an environment
// variable read once into config.openrouterDefaultCodexModel, with a
// fallback in src/config.js. On the Kubernetes deploy the variable is not
// set (the platform chart's ConfigMap does not carry it, and the console's
// Platform variables panel is not applied there), so the default was the
// code's fallback and changing it meant a proposal, a merge and a rollout.
//
// The default is now an admin setting too, stored in platform_settings and
// edited from Admin → Homeroom bot → Settings → Models, read here through a
// short cache so it applies on every server within CACHE_TTL_MS of a save
// with no deploy. Precedence:
//
//   1. The admin's setting, when one is stored.
//   2. OPENROUTER_DEFAULT_CODEX_MODEL, else src/config.js's fallback.
//
// What follows it: a new agent chat for an account that never picked a
// model (routes/sessions.js; provisioning stores "follow the default",
// services/openrouter-managed-keys.js), the model catalog's recommended
// model (services/agent-models.js), the bot's stages that have no model of
// their own and its voice in DMs and chats (services/homeroom-bot.js
// stageModel and platformDefaultModel). A model a person or a stage picked
// is theirs and does not move.

const log = require('./logger');

const KEY = 'openrouter_default_codex_model';
const CACHE_TTL_MS = 10 * 1000;
// An OpenRouter model id: `vendor/model`, as the catalog spells them
// (homeroom-bot.js MODEL_ID_RE, the same rule).
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}\/[a-z0-9][a-z0-9._:-]{0,100}$/i;

// Per pool, so route tests that each mount their own fake pool never read
// one another's cached answer.
const caches = new WeakMap();

function deployDefault(config) {
  const id = String((config && config.openrouterDefaultCodexModel) || '').trim();
  return id || null;
}

function parseStored(raw) {
  const id = String(raw == null ? '' : raw).trim();
  return MODEL_ID_RE.test(id) ? id : null;
}

// Callers hand in a transaction client (routes/sessions.js); the setting is
// read on the app's pool, so the cache is shared and a failed read never
// aborts the caller's transaction. A test's config names no database, and
// its fake pool serves instead.
function storage(pool, config) {
  return config && config.databaseUrl ? require('../db/pool').getPool(config) : pool;
}

/**
 * The stored setting, or null when none is stored (or it is unreadable).
 * Cached for CACHE_TTL_MS per pool. A read failure answers null, so the
 * deploy's default applies rather than no model at all.
 */
async function readSetting(pool) {
  const cached = caches.get(pool);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  let value = null;
  try {
    const { rows } = await pool.query(
      'SELECT value FROM platform_settings WHERE key = $1',
      [KEY],
    );
    value = parseStored(rows && rows[0] && rows[0].value);
  } catch (err) {
    log.warn('default-model', 'Default model setting read failed; using OPENROUTER_DEFAULT_CODEX_MODEL', { err: err.message });
    return null;
  }
  caches.set(pool, { value, at: Date.now() });
  return value;
}

function invalidate(pool, config) {
  if (pool) caches.delete(pool);
  if (config && config.databaseUrl) caches.delete(storage(pool, config));
}

/**
 * The same answer from settings already read with the bot's
 * (homeroom-bot.js readSettings carries KEY as `defaultModel`), for a
 * caller that has them and need not read again.
 */
function fromSettings(settings, config) {
  return parseStored(settings && settings.defaultModel) || deployDefault(config);
}

/** The default every reader uses. Never throws; null only when nothing is configured. */
async function effective(pool, config) {
  const db = storage(pool, config);
  const setting = db ? await readSetting(db) : null;
  return setting || deployDefault(config);
}

module.exports = {
  KEY,
  CACHE_TTL_MS,
  MODEL_ID_RE,
  deployDefault,
  parseStored,
  readSetting,
  invalidate,
  fromSettings,
  effective,
};
