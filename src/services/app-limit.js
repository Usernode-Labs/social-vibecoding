'use strict';

// The server-wide app limit, as every reader must resolve it.
//
// MAX_APPS used to be the whole story: an environment variable, read once
// into config.maxApps. That left admins no lever on the Kubernetes deploy,
// whose Helm chart does not pass MAX_APPS through and which the Platform
// variables panel does not feed, so "This server is at its app limit (50).
// Ask an admin to … raise the limit." asked for something no admin could do
// without a chart change and an infra-repo commit.
//
// The limit is now an admin setting, stored in platform_settings like the
// Spend limits (services/limits.js), edited from the same console section,
// and read here through a short cache so it applies on every server within
// CACHE_TTL_MS of a save with no deploy. Precedence, in order:
//
//   1. MAX_APPS <= 0 switches the cap OFF, and the stored setting with it.
//      This is the deploy's own off switch, and it has to stay absolute:
//      visual-evidence runtimes set MAX_APPS=0 so app-creation flows can be
//      exercised (services/visual-evidence-environment.js), and their
//      databases are clones in which production's stored setting is
//      present. Honouring the setting there would put back the cap the
//      runtime deliberately removed.
//   2. The admin's setting, when one is stored.
//   3. MAX_APPS.
//
// Every reader goes through effective(): POST /api/apps and /fork (the
// refusal), the allowance panel (routes/apps.js, routes/auth.js), and the
// platform limit alerts (services/platform-limit-alerts.js). None of them
// reads config.maxApps for the cap itself any more, which is what keeps the
// panel, the refusal and the alert agreeing.

const log = require('./logger');

const KEY = 'max_apps';
const CACHE_TTL_MS = 10 * 1000;
// A ceiling on what the console accepts, not a platform limit: a typo of
// three extra zeros should be refused rather than silently remove the cap.
const MAX_SETTING = 100000;

// Per pool, so route tests that each mount their own fake pool never read
// one another's cached answer.
const caches = new WeakMap();

function deployDefault(config) {
  const n = Number(config && config.maxApps);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function parseStored(raw) {
  const n = parseInt(raw == null ? '' : String(raw), 10);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SETTING ? n : null;
}

/**
 * The stored setting: { value, updatedAt, updatedBy } or null when none is
 * stored (or it is unreadable). Cached for CACHE_TTL_MS per pool. A read
 * failure answers null, so the deploy's MAX_APPS applies and app creation
 * keeps its cap rather than losing it to a database hiccup.
 */
async function readSetting(pool) {
  const cached = caches.get(pool);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.setting;
  let setting = null;
  try {
    const { rows } = await pool.query(
      `SELECT s.value, s.updated_at, u.username AS updated_by
         FROM platform_settings s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.key = $1`,
      [KEY]
    );
    const value = parseStored(rows[0] && rows[0].value);
    setting = value == null ? null : {
      value,
      updatedAt: rows[0].updated_at || null,
      updatedBy: rows[0].updated_by || null,
    };
  } catch (err) {
    log.warn('app-limit', 'App limit setting read failed; using MAX_APPS', { err: err.message });
    return null;
  }
  caches.set(pool, { setting, at: Date.now() });
  return setting;
}

function invalidate(pool) {
  if (pool) caches.delete(pool);
}

/**
 * The cap every reader enforces. 0 means no cap. Never throws. Does not
 * touch the database when the deploy has switched the cap off.
 */
async function effective(pool, config) {
  const fallback = deployDefault(config);
  if (fallback <= 0) return 0;
  const setting = await readSetting(pool);
  return setting ? setting.value : fallback;
}

/** null when acceptable, else the reason. `null` itself means "clear". */
function validate(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return 'The app limit must be a whole number.';
  }
  if (value < 1 || value > MAX_SETTING) {
    return `The app limit must be between 1 and ${MAX_SETTING}.`;
  }
  return null;
}

/** Store the setting (a number) or clear it (null). Validated by the caller. */
async function set(pool, { value, actorId = null }) {
  if (value === null) {
    await pool.query('DELETE FROM platform_settings WHERE key = $1', [KEY]);
  } else {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [KEY, String(value), actorId]
    );
  }
  invalidate(pool);
}

/**
 * What the console's App limit card draws: the cap in force and where it
 * comes from, the deploy's MAX_APPS, the stored setting, and how many live
 * apps count against it (the same count the refusal makes).
 */
async function adminPayload(pool, config) {
  const defaultLimit = deployDefault(config);
  const setting = defaultLimit > 0 ? await readSetting(pool) : null;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'`
  );
  const limit = defaultLimit <= 0 ? 0 : (setting ? setting.value : defaultLimit);
  return {
    limit,
    source: defaultLimit <= 0 ? 'disabled' : (setting ? 'admin' : 'default'),
    defaultLimit: Math.max(0, defaultLimit),
    setting,
    used: Number(rows[0] && rows[0].n) || 0,
    max: MAX_SETTING,
    warnPercent: require('./platform-limit-alerts').warnPercent(),
  };
}

module.exports = {
  KEY,
  CACHE_TTL_MS,
  MAX_SETTING,
  deployDefault,
  readSetting,
  invalidate,
  effective,
  validate,
  set,
  adminPayload,
};
