'use strict';
// The daily security bot's configuration (#4678), stored in platform_settings
// under `security_bot.*`. Every value is finite and bounded: a write that is
// zero, negative, unbounded ("unlimited", Infinity) or out of range is
// refused, and a reader that finds a missing or malformed value falls back
// to the shipped default rather than to "no limit". The shipped default for
// `enabled` is false, so nothing runs until an operator switches it on.

const { ADMIN_MUTATION_LOCK } = require('../advisory-locks');
const log = require('../logger');

const PREFIX = 'security_bot.';

// kind: 'bool' | 'int' | 'usd'. min is inclusive and above zero for every
// cap, so a cap can never be switched off by storing 0.
const SPECS = Object.freeze({
  enabled:               { kind: 'bool', default: false },
  schedule_hour_utc:     { kind: 'int', default: 6, min: 0, max: 23 },
  daily_budget_usd:      { kind: 'usd', default: 5, min: 0.01, max: 100 },
  weekly_budget_usd:     { kind: 'usd', default: 35, min: 0.01, max: 700 },
  max_run_minutes:       { kind: 'int', default: 30, min: 1, max: 120 },
  max_target_requests:   { kind: 'int', default: 300, min: 1, max: 1000 },
  max_attacker_calls:    { kind: 'int', default: 60, min: 1, max: 200 },
  max_output_tokens:     { kind: 'int', default: 4096, min: 1, max: 16384 },
  max_parallel_requests: { kind: 'int', default: 2, min: 1, max: 8 },
});

const NAMES = Object.freeze(Object.keys(SPECS));

const DEFAULTS = Object.freeze(Object.fromEntries(NAMES.map((n) => [n, SPECS[n].default])));

class SettingError extends Error {
  constructor(message, name) {
    super(message);
    this.code = 'invalid_setting';
    this.setting = name || null;
  }
}

const INT_RE = /^[0-9]{1,9}$/;
const USD_RE = /^[0-9]{1,6}(\.[0-9]{1,2})?$/;

/**
 * Parse one value strictly. Answers { ok: true, value } or
 * { ok: false, error }. Accepts the stored string form or a JS value.
 */
function parseValue(name, raw) {
  const spec = SPECS[name];
  if (!spec) return { ok: false, error: `Unknown security bot setting: ${name}` };
  if (spec.kind === 'bool') {
    if (raw === true || raw === 'true') return { ok: true, value: true };
    if (raw === false || raw === 'false') return { ok: true, value: false };
    return { ok: false, error: `${name} must be true or false.` };
  }
  let text;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: `${name} must be a finite number.` };
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw.trim();
  } else {
    return { ok: false, error: `${name} must be a number.` };
  }
  const re = spec.kind === 'int' ? INT_RE : USD_RE;
  if (!re.test(text)) {
    return { ok: false, error: spec.kind === 'int'
      ? `${name} must be a whole number between ${spec.min} and ${spec.max}.`
      : `${name} must be an amount in dollars between ${spec.min} and ${spec.max}.` };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
    return { ok: false, error: `${name} must be between ${spec.min} and ${spec.max}.` };
  }
  return { ok: true, value };
}

/** Stored text for a parsed value: "06" for the hour, "5.00" for dollars. */
function storedText(name, value) {
  const spec = SPECS[name];
  if (spec.kind === 'bool') return value ? 'true' : 'false';
  if (spec.kind === 'usd') return value.toFixed(2);
  if (name === 'schedule_hour_utc') return String(value).padStart(2, '0');
  return String(value);
}

/** The weekly cap may not be below the daily cap. null when consistent. */
function crossCheck(values) {
  if (values.weekly_budget_usd < values.daily_budget_usd) {
    return new SettingError('weekly_budget_usd must be at least daily_budget_usd.', 'weekly_budget_usd');
  }
  return null;
}

/**
 * Turn stored rows into a full settings object. Missing or malformed values
 * fail closed to the default; a stored pair whose weekly cap is under its
 * daily cap falls back to both defaults.
 */
function fromRows(rows) {
  const out = { ...DEFAULTS };
  for (const row of rows || []) {
    if (!row || typeof row.key !== 'string' || !row.key.startsWith(PREFIX)) continue;
    const name = row.key.slice(PREFIX.length);
    if (!SPECS[name]) continue;
    const parsed = parseValue(name, row.value);
    if (parsed.ok) out[name] = parsed.value;
  }
  if (crossCheck(out)) {
    out.daily_budget_usd = DEFAULTS.daily_budget_usd;
    out.weekly_budget_usd = DEFAULTS.weekly_budget_usd;
  }
  return out;
}

/** Every setting. Never throws: a read failure answers the defaults (disabled). */
async function read(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])',
      [NAMES.map((n) => PREFIX + n)],
    );
    return fromRows(rows);
  } catch (err) {
    log.warn('security-bot', 'Settings read failed; using defaults', { err: err.message });
    return { ...DEFAULTS };
  }
}

/**
 * Validate and store a partial update under ADMIN_MUTATION_LOCK. Throws a
 * SettingError (code 'invalid_setting') and writes nothing when any value is
 * invalid, or when the result would put the weekly cap under the daily one.
 * Answers the full settings after the write.
 */
async function write(pool, patch, { actorId = null } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SettingError('Settings must be an object.');
  }
  const parsed = {};
  for (const [name, raw] of Object.entries(patch)) {
    const result = parseValue(name, raw);
    if (!result.ok) throw new SettingError(result.error, name);
    parsed[name] = result.value;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);
    const { rows } = await client.query(
      'SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])',
      [NAMES.map((n) => PREFIX + n)],
    );
    const merged = { ...fromRows(rows), ...parsed };
    const bad = crossCheck(merged);
    if (bad) throw bad;
    for (const [name, value] of Object.entries(parsed)) {
      await client.query(
        `INSERT INTO platform_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [PREFIX + name, storedText(name, value), actorId],
      );
    }
    await client.query('COMMIT');
    return merged;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The caps a run starts under, frozen into security_bot_runs.limits_snapshot. */
function limitsSnapshot(settings) {
  const s = { ...DEFAULTS, ...settings };
  return {
    daily_budget_usd: s.daily_budget_usd,
    weekly_budget_usd: s.weekly_budget_usd,
    max_run_minutes: s.max_run_minutes,
    max_target_requests: s.max_target_requests,
    max_attacker_calls: s.max_attacker_calls,
    max_output_tokens: s.max_output_tokens,
    max_parallel_requests: s.max_parallel_requests,
  };
}

module.exports = {
  PREFIX, SPECS, NAMES, DEFAULTS, SettingError,
  parseValue, storedText, fromRows, read, write, limitsSnapshot,
};
