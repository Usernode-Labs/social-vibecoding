'use strict';

// Whether platform previews may have projects made in them
// (services/preview-projects.js), as every reader must resolve it.
//
// It was a chart value only, off by default, so turning it on took an
// infra-repo commit and a rollout. It is now ON unless somebody says
// otherwise, and an admin setting like the app limit (services/app-limit.js):
// stored in platform_settings, edited from Admin > Limits, and read through
// a short cache so a change applies on every server within CACHE_TTL_MS,
// with no deploy. Precedence, in order:
//
//   1. Never in a preview itself, and only on Kubernetes: the broker builds
//      and runs on the cluster, and a Docker preview shares one alias per
//      session with the project it would run.
//   2. PREVIEW_PROJECTS_ENABLED=false (the chart's config.previewProjects:
//      false) switches it OFF, and the stored setting with it: the
//      operator's own off switch, which has to stay absolute.
//   3. The admin's setting, when one is stored.
//   4. On.
//
// Turned off, previews deployed from then on get no credential, and the
// broker refuses the ones that have one; projects already made run on until
// their preview retires, which removes them as always.

const log = require('./logger');

const KEY = 'preview_projects';
const CACHE_TTL_MS = 10 * 1000;

// Per pool, so route tests that each mount their own fake pool never read
// one another's cached answer.
const caches = new WeakMap();

// What the deploy leaves an admin to decide: null when it is theirs, else
// why it is off whatever they choose.
function deployBlock(config) {
  if (process.env.USERNODE_ENV === 'staging') return 'preview';
  if (config?.previewProjectsEnabled === false) return 'off';
  const mode = config?.appRuntime || process.env.APP_RUNTIME || 'docker';
  return mode === 'kubernetes' ? null : 'unsupported';
}

function parseStored(raw) {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return null;
}

/**
 * The stored setting: { value, updatedAt, updatedBy } or null when none is
 * stored (or it is unreadable). Cached for CACHE_TTL_MS per pool. A read
 * failure answers null, so the default applies.
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
    log.warn('preview-projects', 'Preview projects setting read failed; using the default', { err: err.message });
    return null;
  }
  caches.set(pool, { setting, at: Date.now() });
  return setting;
}

function invalidate(pool) {
  if (pool) caches.delete(pool);
}

/** Whether it is on, here and now. Never throws; no database read when the deploy decides. */
async function enabled(config, pool) {
  if (deployBlock(config)) return false;
  const setting = await readSetting(pool);
  return setting ? setting.value : true;
}

/** null when acceptable, else the reason. `null` itself means "back to the default". */
function validate(value) {
  if (value === null || value === true || value === false) return null;
  return 'enabled must be true, false, or null for the default.';
}

/** Store the setting (true or false) or clear it (null). Validated by the caller. */
async function set(pool, { value, actorId = null }) {
  if (value === null) {
    await pool.query('DELETE FROM platform_settings WHERE key = $1', [KEY]);
  } else {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [KEY, value ? 'on' : 'off', actorId]
    );
  }
  invalidate(pool);
}

/**
 * What the console's card draws: whether it is on and why, the stored
 * setting, how many projects previews have made right now, and the caps.
 */
async function adminPayload(pool, config) {
  const block = deployBlock(config);
  const setting = block ? null : await readSetting(pool);
  let live = 0;
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM preview_projects');
    live = Number(rows[0]?.n) || 0;
  } catch {
    live = 0;
  }
  const projects = require('./preview-projects');
  return {
    enabled: block ? false : (setting ? setting.value : true),
    source: block || (setting ? 'admin' : 'default'),
    setting,
    live,
    perPreview: projects.maxPerPreview(),
    total: projects.maxTotal(),
  };
}

module.exports = {
  KEY,
  CACHE_TTL_MS,
  deployBlock,
  readSetting,
  invalidate,
  enabled,
  validate,
  set,
  adminPayload,
};
