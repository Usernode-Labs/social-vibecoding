'use strict';

// The platform-wide session cap, as every reader must resolve it.
//
// MAX_GLOBAL_SESSIONS was the whole story: an environment variable, read
// once into config.maxGlobalSessions. On the Kubernetes deploy it is a value
// in the infra repository's platform chart, so raising it meant an infra
// commit, an Argo sync and a rollout of every platform pod. On 19 Oct 2026
// the platform sat at 133 of 140 with 126 proposals in review, and the only
// lever was that commit.
//
// The cap is now an admin setting too, stored in platform_settings like the
// app limit (services/app-limit.js), edited from the same console section
// (Admin → Limits), and read here through a short cache so it applies on
// every server within CACHE_TTL_MS of a save with no deploy. Precedence:
//
//   1. The admin's setting, when one is stored.
//   2. MAX_GLOBAL_SESSIONS.
//
// There is no off switch: 0 has never meant "no cap" for sessions (every
// start would have to free a slot), so nothing relies on one.
//
// Every reader goes through effective(): every start, resume and reopen
// (session-lifecycle.claimGlobalSlot, routes/sessions.js resumePausedSession
// for the proposal machine's Resume), the platform limit alert
// (services/platform-limit-alerts.js) and the status page
// (services/status.js). None of them reads config.maxGlobalSessions for the
// cap itself any more, which is what keeps the refusal, the alert and the
// meter agreeing.
//
// The setting is a policy, not capacity. Each session in review keeps a
// staging preview running, so the namespaces' ResourceQuota (in the infra
// repository) is the real ceiling: the console card shows it beside the
// field, and raising the cap past it only moves the refusal from here to
// Kubernetes.

const log = require('./logger');

const KEY = 'max_global_sessions';
const CACHE_TTL_MS = 10 * 1000;
// A ceiling on what the console accepts, not a platform limit: a typo of an
// extra zero or two should be refused rather than let the fleet outgrow its
// cluster.
const MAX_SETTING = 2000;
// What the readers used when config carried no cap at all.
const FALLBACK = 100;

// Per pool, so route tests that each mount their own fake pool never read
// one another's cached answer.
const caches = new WeakMap();

function deployDefault(config) {
  if (!config || config.maxGlobalSessions == null) return FALLBACK;
  const n = Number(config.maxGlobalSessions);
  return Number.isFinite(n) ? Math.floor(n) : FALLBACK;
}

function parseStored(raw) {
  const n = parseInt(raw == null ? '' : String(raw), 10);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SETTING ? n : null;
}

/**
 * The stored setting: { value, updatedAt, updatedBy } or null when none is
 * stored (or it is unreadable). Cached for CACHE_TTL_MS per pool. A read
 * failure answers null, so the deploy's MAX_GLOBAL_SESSIONS applies and the
 * platform keeps a cap rather than losing it to a database hiccup.
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
    const value = parseStored(rows && rows[0] && rows[0].value);
    setting = value == null ? null : {
      value,
      updatedAt: rows[0].updated_at || null,
      updatedBy: rows[0].updated_by || null,
    };
  } catch (err) {
    log.warn('session-limit', 'Session limit setting read failed; using MAX_GLOBAL_SESSIONS', { err: err.message });
    return null;
  }
  caches.set(pool, { setting, at: Date.now() });
  return setting;
}

function invalidate(pool) {
  if (pool) caches.delete(pool);
}

/** The cap every reader enforces. Never throws. */
async function effective(pool, config) {
  const setting = pool ? await readSetting(pool) : null;
  return setting ? setting.value : deployDefault(config);
}

/** null when acceptable, else the reason. `null` itself means "clear". */
function validate(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return 'The session limit must be a whole number.';
  }
  if (value < 1 || value > MAX_SETTING) {
    return `The session limit must be between 1 and ${MAX_SETTING}.`;
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

// The quota beside the field: pods and requested CPU and memory in each
// namespace the platform runs workers and previews in, as Kubernetes
// counts them. Null off Kubernetes, in a preview (which has no authority
// over the parent's cluster), or when the read fails.
const QUOTA_RESOURCES = ['pods', 'requestsCpu', 'requestsMemory'];

async function readQuota(config) {
  if (process.env.USERNODE_ENV === 'staging') return null;
  try {
    if (require('./application-runtime').mode(config) !== 'kubernetes') return null;
    const namespaces = await require('./kubernetes').listNamespaceCapacity(config);
    const out = (namespaces || [])
      .filter((n) => n && n.resources)
      .map((n) => ({
        namespace: n.namespace,
        ...Object.fromEntries(QUOTA_RESOURCES
          .filter((k) => n.resources[k])
          .map((k) => [k, { used: n.resources[k].used, hard: n.resources[k].hard, percent: n.resources[k].percent }])),
      }));
    return out.length ? out : null;
  } catch (err) {
    log.warn('session-limit', 'Namespace quota read failed', { err: err.message });
    return null;
  }
}

/**
 * What the console's Session limit card draws: the cap in force and where
 * it comes from, the deploy's MAX_GLOBAL_SESSIONS, the stored setting, how
 * many sessions count against it (the same count the refusal makes) and the
 * cluster quota that bounds what raising it can do.
 */
async function adminPayload(pool, config) {
  const defaultLimit = deployDefault(config);
  const [setting, used, quota] = await Promise.all([
    readSetting(pool),
    require('./session-caps').countGlobalSessions(pool),
    readQuota(config),
  ]);
  return {
    limit: setting ? setting.value : defaultLimit,
    source: setting ? 'admin' : 'default',
    defaultLimit,
    setting,
    used: Number(used) || 0,
    max: MAX_SETTING,
    warnPercent: require('./platform-limit-alerts').warnPercent(),
    quota,
  };
}

module.exports = {
  KEY,
  CACHE_TTL_MS,
  MAX_SETTING,
  FALLBACK,
  deployDefault,
  readSetting,
  invalidate,
  effective,
  validate,
  set,
  readQuota,
  adminPayload,
};
