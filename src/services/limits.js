'use strict';

const log = require('./logger');

// Daily LLM-spend caps. Both values live in `platform_settings` and are
// admin-tunable from /admin (see src/routes/admin.js endpoints
// /api/admin/limits + /api/admin/users/:id/daily-limit). Reads here are
// cached for CACHE_TTL_MS so a chat-heavy hour doesn't hammer Postgres
// for the same two rows on every turn; admin writes call invalidate()
// to flip the cache forward immediately.
//
// Per-user override: users.daily_limit_cents (NULL = use platform
// default). Lets admins grant trusted users a higher cap without
// raising it for everyone.

const KEY_USER  = 'user_daily_limit_cents';
const KEY_GLOBAL = 'global_daily_limit_cents';

const CACHE_TTL_MS = 10_000;
const cache = new Map();

function fromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function toCache(key, value) {
  cache.set(key, { value, at: Date.now() });
}

function invalidate(...keys) {
  if (!keys.length) cache.clear();
  for (const k of keys) cache.delete(k);
}

async function readSettingCents(pool, key, fallback) {
  const cached = fromCache(key);
  if (cached != null) return cached;
  try {
    const { rows } = await pool.query(
      'SELECT value FROM platform_settings WHERE key = $1',
      [key]
    );
    const raw = rows[0]?.value;
    const n = raw != null ? parseInt(raw, 10) : NaN;
    const value = Number.isFinite(n) && n >= 0 ? n : fallback;
    toCache(key, value);
    return value;
  } catch (err) {
    // platform_settings may not exist yet on the very first boot
    // before migrate() has run, or if a manual `pg_dump` restore wiped
    // the table mid-flight. Falling back to the legacy hardcoded value
    // keeps chat working until the next request, by which point the
    // schema will have caught up.
    log.warn('limits', 'platform_settings read failed; using fallback', { key, err: err.message, fallback });
    return fallback;
  }
}

async function getGlobalLimitCents(pool) {
  return readSettingCents(pool, KEY_GLOBAL, 20000);
}

async function getDefaultUserLimitCents(pool) {
  return readSettingCents(pool, KEY_USER, 2500);
}

async function getEffectiveUserLimitCents(pool, userId) {
  // Per-user override takes precedence over the platform default. NULL
  // (or row missing) means "use the default", which the COALESCE
  // implements at the SQL layer so we don't have to do a second round
  // trip when the user has no override set.
  try {
    const { rows } = await pool.query(
      'SELECT daily_limit_cents FROM users WHERE id = $1',
      [userId]
    );
    const override = rows[0]?.daily_limit_cents;
    if (override != null && Number.isFinite(Number(override)) && Number(override) >= 0) {
      return Number(override);
    }
  } catch (err) {
    log.warn('limits', 'user override read failed; using default', { userId, err: err.message });
  }
  return getDefaultUserLimitCents(pool);
}

// Decision gate for "may this user incur another LLM call right now?".
// Mirrors the legacy checkBudget() in src/routes/sessions.js so callers
// can swap in this module without changing behaviour. Returns either
// `{ ok: true, userRemaining, globalRemaining }` or
// `{ error: '...user-facing message...' }`.
async function checkBudget(pool, userId) {
  const userLimit = await getEffectiveUserLimitCents(pool, userId);
  const globalLimit = await getGlobalLimitCents(pool);

  const { rows: userRows } = await pool.query(
    'SELECT total_cost_cents FROM llm_usage WHERE user_id = $1 AND date = CURRENT_DATE',
    [userId]
  );
  const userSpent = parseFloat(userRows[0]?.total_cost_cents || 0);
  if (userSpent >= userLimit) {
    return { error: `Daily limit reached ($${(userLimit / 100).toFixed(2)}). Resets at midnight UTC.` };
  }

  const { rows: globalRows } = await pool.query(
    'SELECT SUM(total_cost_cents) as total FROM llm_usage WHERE date = CURRENT_DATE'
  );
  const globalSpent = parseFloat(globalRows[0]?.total || 0);
  if (globalSpent >= globalLimit) {
    return { error: 'Global daily limit reached. Try again tomorrow.' };
  }

  return {
    ok: true,
    userLimit,
    globalLimit,
    userRemaining: userLimit - userSpent,
    globalRemaining: globalLimit - globalSpent,
  };
}

// Daily-ledger upsert shared by every spend site (Mayor turns, Claude
// Code dispatches, PR-metadata Haiku calls, feedback titles). Routes
// the cost into the bucket matching who paid Anthropic (#119):
//   byok: false → total_cost_cents (counts against the daily caps)
//   byok: true  → byok_cost_cents  (billed to the user's own key;
//                 display only — checkBudget never reads it)
// No-ops on a missing user or non-positive cost, and swallows+logs DB
// errors — billing bookkeeping must never fail the request that
// incurred the spend (same tolerance the call sites had inline).
async function recordSpend(pool, userId, costCents, { byok = false } = {}) {
  if (!userId || !(costCents > 0)) return;
  const column = byok ? 'byok_cost_cents' : 'total_cost_cents';
  try {
    await pool.query(
      `INSERT INTO llm_usage (user_id, date, ${column}) VALUES ($1, CURRENT_DATE, $2)
       ON CONFLICT (user_id, date) DO UPDATE SET ${column} = llm_usage.${column} + EXCLUDED.${column}`,
      [userId, costCents]
    );
  } catch (err) {
    log.warn('limits', 'Failed to record llm_usage spend', { userId, costCents, byok, err: err.message });
  }
}

module.exports = {
  getGlobalLimitCents,
  getDefaultUserLimitCents,
  getEffectiveUserLimitCents,
  checkBudget,
  recordSpend,
  invalidate,
  KEY_USER,
  KEY_GLOBAL,
};
