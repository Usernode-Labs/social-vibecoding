'use strict';

// Whether versions are on: originals offer their merged changes down to the
// versions that follow them, and ready-mades are made as versions of their
// original (docs/plans/versions.md, "The off switch"). Every reader resolves
// it here.
//
// An admin setting like projects in previews
// (services/preview-projects-setting.js): stored in platform_settings,
// edited from Admin > Limits, and read through a short cache so a change
// applies on every server within CACHE_TTL_MS, with no deploy. Precedence,
// in order:
//
//   1. VERSIONS_ENABLED=false switches it OFF, and the stored setting with
//      it: the operator's own off switch, which has to stay absolute.
//   2. The admin's setting, when one is stored.
//   3. On.
//
// While it is off no update is planned or opened (services/upstream-offers.js),
// ready-mades are made from app-templates as before, and the screens draw no
// update cards. Lineage (apps.upstream) is recorded either way, so turning it
// back on picks up where it left off.

const log = require('./logger');

const KEY = 'versions';
const CACHE_TTL_MS = 10 * 1000;

// Per pool, so route tests that each mount their own fake pool never read
// one another's cached answer.
const caches = new WeakMap();

// What the deploy leaves an admin to decide: null when it is theirs, else
// why it is off whatever they choose. `config.versionsEnabled` is honoured
// when a deploy's config carries it; the environment is read directly so
// the switch needs no config.js entry to work.
function deployBlock(config) {
  if (config?.versionsEnabled === false) return 'off';
  if (String(process.env.VERSIONS_ENABLED || '').trim().toLowerCase() === 'false') return 'off';
  return null;
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
    log.warn('versions', 'Versions setting read failed; using the default', { err: err.message });
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

/** What the console's Versions card draws: whether it is on, why, and the stored setting. */
async function adminPayload(pool, config) {
  const block = deployBlock(config);
  const setting = block ? null : await readSetting(pool);
  return {
    enabled: block ? false : (setting ? setting.value : true),
    source: block || (setting ? 'admin' : 'default'),
    setting,
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
