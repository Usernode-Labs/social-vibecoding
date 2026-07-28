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
// #361: dedicated daily cap for platform-driven merge-conflict / sync
// resolution turns. Lives in platform_settings like the other two and
// is admin-tunable from /admin. Defaults to $25/day (2500 cents).
const KEY_SYSTEM = 'system_tokens_daily_limit_cents';

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

// #361: the system-tokens daily cap (cents). Same 10s-cached read as the
// other two caps; admin writes call invalidate(KEY_SYSTEM).
async function getSystemTokensLimitCents(pool) {
  return readSettingCents(pool, KEY_SYSTEM, 2500);
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

// Shared BYOK key lookup + decrypt (#30/#212). Previously duplicated in
// routes/sessions.js (loadUserApiKey + an inline copy in the chat route)
// and services/sync-main.js — now the single home, used by
// resolveBillingPath below. Returns the decrypted key string or null
// (missing key, decrypt failure — both mean "no key on file").
async function loadUserApiKey(pool, userId, dataKey) {
  try {
    const { rows } = await pool.query(
      'SELECT anthropic_key_enc FROM users WHERE id = $1',
      [userId]
    );
    if (rows[0]?.anthropic_key_enc) {
      const secrets = require('./secrets');
      const key = secrets.decrypt(rows[0].anthropic_key_enc, dataKey);
      if (!key) {
        log.warn('limits', 'BYOK key decryption failed; treating as no key', { userId });
      }
      return key || null;
    }
  } catch (err) {
    log.warn('limits', 'Failed to load user API key', { userId, err: err.message });
  }
  return null;
}

// #212: decide who pays for the next billable unit (a chat turn, a
// headless phase, a sync run). LIMIT-FIRST: the shared daily allowance
// is consumed while it has headroom; the user's own BYOK key (#30)
// takes over only once the budget — their per-user cap OR the global
// cap — is exhausted. Returns exactly one of:
//   { apiKey: null, byok: false }   — budget headroom: bill the
//     platform key (counts against the daily caps via recordSpend).
//   { apiKey: '<key>', byok: true } — budget exhausted and a BYOK key
//     is on file: bill the user's own key (display-only bucket).
//   { error: '...' }                — budget exhausted, no usable key:
//     the same user-facing message checkBudget produces today.
// Key decryption failures keep the existing tolerance (warn + treat as
// "no key") — which now means a 429 once the cap is hit, instead of
// the old silent payer switch.
async function resolveBillingPath(pool, dataKey, userId) {
  const budget = await checkBudget(pool, userId);
  if (!budget.error) return { apiKey: null, byok: false };
  const apiKey = await loadUserApiKey(pool, userId, dataKey);
  if (apiKey) return { apiKey, byok: true };
  // #463: this branch is only reachable with NO usable key on file, so
  // the BYOK hint is always accurate here. checkBudget itself stays
  // hint-free — it also runs on paths where the caller has a key.
  return { error: `${budget.error} Add your own Anthropic API key in Settings to keep going.` };
}

// Daily-ledger upsert shared by every spend site (Mayor turns, Claude
// Code dispatches, PR-metadata Haiku calls, feedback titles). Routes
// the cost into the bucket matching who paid Anthropic (#119):
//   byok: false → total_cost_cents (counts against the daily caps)
//   byok: true  → byok_cost_cents  (billed to the user's own key once
//                 the daily allowance ran out — see resolveBillingPath;
//                 display only, checkBudget never reads it)
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

// #664: turn-end settlement for a CC turn that may have SWITCHED payers
// mid-flight. The worker Anthropic proxy falls back to the user's own
// key per-call once the daily allowance is exhausted, so a single turn
// can carry both platform-billed and BYOK-billed calls. Attributing the
// whole turn to one bucket would either leak pre-switch platform spend
// out of the capped bucket (ledger never reaches the cap → every turn
// burns platform money before switching) or over-count the user's
// key spend against their allowance. Split instead:
//   turnByok: true  → the whole turn ran on the user's key (dispatch-time
//     BYOK, proxy never involved) → all of it lands in the byok bucket.
//   turnByok: false → platform-dispatched turn; `byokObservedCents` is
//     the proxy's per-call tally of switched spend (an SSE-tee estimate,
//     clamped to the turn total — CC's self-reported costUsd is the
//     authoritative sum). Remainder is platform spend.
// Returns { platformCents, byokCents } so call sites can emit per-bucket
// usage events. Same swallow-and-log tolerance as recordSpend.
async function settleTurnSpend(pool, userId, totalCents, { turnByok = false, byokObservedCents = 0 } = {}) {
  const total = Number(totalCents);
  if (!userId || !Number.isFinite(total) || !(total > 0)) {
    return { platformCents: 0, byokCents: 0 };
  }
  if (turnByok) {
    await recordSpend(pool, userId, total, { byok: true });
    return { platformCents: 0, byokCents: total };
  }
  const observed = Number(byokObservedCents);
  const byokCents = Math.min(Number.isFinite(observed) && observed > 0 ? observed : 0, total);
  const platformCents = total - byokCents;
  if (platformCents > 0) await recordSpend(pool, userId, platformCents, { byok: false });
  if (byokCents > 0) await recordSpend(pool, userId, byokCents, { byok: true });
  return { platformCents, byokCents };
}

// #361: gate for "may the platform incur another merge-conflict /
// sync-resolution turn right now?". Reads today's accumulated
// system-token spend and compares to the system cap. Returns
// `{ ok: true, remaining }` or `{ error: '...user-facing message...' }`
// mirroring checkBudget's shape so call sites can branch the same way.
async function checkSystemBudget(pool) {
  const limit = await getSystemTokensLimitCents(pool);
  let spent = 0;
  try {
    const { rows } = await pool.query(
      'SELECT cost_cents FROM system_token_usage WHERE date = CURRENT_DATE'
    );
    spent = parseFloat(rows[0]?.cost_cents || 0);
  } catch (err) {
    // Table may not exist yet on first boot before migrate() runs, or a
    // transient DB hiccup — fail open (treat as headroom) so housekeeping
    // isn't blocked by bookkeeping. The mid-stream proxy gate still caps
    // runaway spend.
    log.warn('limits', 'system_token_usage read failed; allowing turn', { err: err.message });
    return { ok: true, remaining: limit };
  }
  if (spent >= limit) {
    return { error: `System token budget reached ($${(limit / 100).toFixed(2)}). Resets at midnight UTC.` };
  }
  return { ok: true, remaining: limit - spent };
}

// #361: daily-ledger upsert for system-token spend. One row per day,
// keyed on date (no user). Same swallow-and-log tolerance as recordSpend
// — billing bookkeeping must never fail the turn that incurred it.
async function recordSystemSpend(pool, costCents) {
  if (!(costCents > 0)) return;
  try {
    await pool.query(
      `INSERT INTO system_token_usage (date, cost_cents) VALUES (CURRENT_DATE, $1)
       ON CONFLICT (date) DO UPDATE
         SET cost_cents = system_token_usage.cost_cents + EXCLUDED.cost_cents,
             updated_at = NOW()`,
      [costCents]
    );
  } catch (err) {
    log.warn('limits', 'Failed to record system_token_usage spend', { costCents, err: err.message });
  }
}

module.exports = {
  getGlobalLimitCents,
  getDefaultUserLimitCents,
  getSystemTokensLimitCents,
  checkSystemBudget,
  recordSystemSpend,
  getEffectiveUserLimitCents,
  checkBudget,
  loadUserApiKey,
  resolveBillingPath,
  recordSpend,
  settleTurnSpend,
  invalidate,
  KEY_USER,
  KEY_GLOBAL,
  KEY_SYSTEM,
};
