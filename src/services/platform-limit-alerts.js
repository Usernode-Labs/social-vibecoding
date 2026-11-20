'use strict';

// Early warning for the platform's server-wide caps.
//
// Two ceilings bound the whole server rather than one person or one app:
//
//   apps      the app limit — every non-errored app on the host. A hard
//             wall: past it, POST /api/apps and /fork answer 429 "This
//             server is at its app limit" to everyone but full admins. Set
//             in Admin → Limits, else MAX_APPS (services/app-limit.js).
//   connections  the shared Postgres server's client connections against
//             the line where ordinary logins are refused (max_connections
//             less the reserved blocks). Postgres itself refuses past it.
//   sessions  the session limit — active + promoted coding workers. A soft
//             wall: at it, starting or reopening a session pauses somebody
//             else's idle one, and 429s "Platform is at capacity" when
//             nothing is idle. Set in Admin → Limits, else
//             MAX_GLOBAL_SESSIONS (services/session-limit.js).
//
// and the cluster's own, measured outside the database by
// services/platform-capacity.js (which says how each is read):
//
//   db_disk   the shared Postgres server's volume, MiB used against its
//             capacity. Full, Postgres stops writing.
//   quota_apps, quota_workers, quota_builds
//             each runtime namespace's ResourceQuota, its tightest resource
//             in thousandths of the hard value. Full, Kubernetes refuses the
//             next pod: an app, a session or check, a build.
//   node_pool the worker nodes' local volume pool, the fullest node's MiB
//             taken against its size. Full, new volumes fail to mount.
//
// and one that is GitHub's rather than ours, its hourly REST budget as the
// last response reported it (services/github-budget.js):
//
//   github_app  the GitHub App installation's (the most-used one).
//
// A `github` line watched the bot token's budget until GitHub suspended that
// account (25 Oct 2026) and the platform dropped its token. Its detail token
// still parses, so a notification it sent before still reads.
//
// GitHub's line is fixed rather than PLATFORM_LIMIT_WARN_PERCENT: warn
// when a fifth of the hour's budget is left (GITHUB_WARN_PERCENT used), and
// again when it is used up. A new hour re-arms both, so each window pages
// at most once per level. The figures are in memory on the leader, which is
// the process that sweeps.
//
// Until now the first anybody heard of either was a user reading that
// refusal and asking an admin to raise the limit. This module measures each
// cap and tells the full admins (the only people who can raise one) twice
// on the way up: once at PLATFORM_LIMIT_WARN_PERCENT of the cap, and again
// when the cap is reached.
//
// `decide()` below is the whole policy, pure, so
// tests/platform-limit-alerts.test.js pins every transition without a
// database:
//
//   ok --(>= warn line)--> warn --(>= cap)--> full
//
// Upward transitions notify; downward ones only re-arm, and only once the
// count has fallen a margin (REARM_RATIO) under the line it crossed. The
// margin is the point. The session count moves every minute, and without it
// a server idling at the warning line would page every admin each time one
// session paused and another started. The same rule keeps "full" from
// repeating when one app is deleted and the next one created.
//
// The level last reached is kept per cap in platform_limit_alerts, read and
// written under a row lock in the same transaction that inserts the
// notifications, so the sweep and a create route racing it cannot both
// claim the same crossing.
//
// Evaluated by the platform-limits clock (src/workflow/clock/services.ts)
// for every cap, and — for apps only — right after a create or fork
// succeeds or is refused at the cap, and right after an admin changes the
// app limit (routes/admin.js), so the alert does not wait for the next
// sweep.
//
// STAGING: a preview's users table is a clone of production's, so a
// notification there would reach real admins' phones about a throwaway
// copy. The level is still recorded; the notifications are skipped (same
// stance as services/app-storage-cap.js).

const log = require('./logger');
const { withTransaction } = require('./cli-auth');
const appLimit = require('./app-limit');
const sessionLimit = require('./session-limit');
const githubBudget = require('./github-budget');

const DEFAULT_WARN_PERCENT = 80;
// GitHub's warning line: 80% of the hour's budget used, a fifth left.
const GITHUB_WARN_PERCENT = 80;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A level re-arms once the count is this far under the line it crossed.
const REARM_RATIO = 0.9;
// #6901: while people keep being turned away at the app limit, the full
// admins get one count notice at most this often. The first refusal of a run
// notifies at once, whatever the level already says.
const REFUSAL_NOTICE_INTERVAL_MS = 3 * 60 * 60 * 1000;

const LEVELS = Object.freeze(['ok', 'warn', 'full']);
const RANK = Object.freeze({ ok: 0, warn: 1, full: 2 });

// The caps this watches. `count` must be the exact query the enforcing
// route uses, and `cap` the exact cap it enforces, so the alert can never
// disagree with the refusal. `enabled` answers without the database, so a
// nudge for a cap the deploy switched off costs nothing.
const LIMITS = Object.freeze([
  Object.freeze({
    key: 'apps',
    envKey: 'MAX_APPS',
    enabled: (config) => appLimit.deployDefault(config) > 0,
    cap: (config, pool) => appLimit.effective(pool, config),
    async count(pool) {
      // routes/apps.js POST /api/apps and /fork; services/app-allowance.js.
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'`
      );
      return Number(rows[0] && rows[0].n);
    },
  }),
  Object.freeze({
    key: 'sessions',
    envKey: 'MAX_GLOBAL_SESSIONS',
    // Always on: there is no off switch for the session limit, and an
    // admin's setting applies whatever the deploy's value.
    enabled: () => true,
    cap: (config, pool) => sessionLimit.effective(pool, config),
    // The count every start, resume and reopen asks
    // (session-caps.countGlobalSessions), so the alert and the refusal agree.
    count: (pool) => require('./session-caps').countGlobalSessions(pool),
  }),
  Object.freeze({
    // The shared Postgres server's client connections, against the line
    // where ordinary logins (every app's) are refused: max_connections less
    // the superuser and reserved blocks (services/server-budget.js keeps the
    // platform's own pools inside the reserved block, so apps meet the wall
    // first). Postgres itself enforces it; the count is the census the
    // status screen shows (db/connection-census.js).
    key: 'connections',
    envKey: 'max_connections',
    enabled: () => true,
    async cap(_config, pool) {
      const { rows } = await pool.query(
        `SELECT current_setting('max_connections')::int
                - current_setting('superuser_reserved_connections')::int
                - COALESCE(NULLIF(current_setting('reserved_connections', true), ''), '0')::int AS cap`
      );
      return Number(rows[0] && rows[0].cap);
    },
    async count(pool) {
      const census = await require('../db/connection-census').connectionCensus(pool);
      if (!census) throw new Error('the connection census could not be taken');
      return census.used;
    },
  }),
  Object.freeze({
    key: 'github_app',
    // Read off GitHub's answers to this process: unknown (no cap) until it
    // has made a call, which says nothing about the level.
    fromAnswers: true,
    envKey: 'GITHUB_APP_ID',
    enabled: () => githubBudget.alertFigures('installation').cap > 0,
    percent: () => GITHUB_WARN_PERCENT,
    cap: async () => githubBudget.alertFigures('installation').cap,
    count: async () => githubBudget.alertFigures('installation').used,
    window: () => githubBudget.alertFigures('installation').resetAt,
  }),
]);
// The cluster's own ceilings (services/platform-capacity.js). Each is one
// `measure` rather than a cap and a count, because one outside read answers
// both, and what it was about (the claim, the resource, the node) is kept
// beside the figure in `detail`. A measure of null means the limit does not
// apply here (off Kubernetes, in a preview, no read grant yet): nothing is
// recorded and the area shows no row.
const CAPACITY_ENV = Object.freeze({
  db_disk: 'CHECK_POOL_METRICS_URL',
  quota_apps: 'APP_NAMESPACE',
  quota_workers: 'WORKER_NAMESPACE',
  quota_builds: 'BUILD_NAMESPACE',
  node_pool: 'APP_RUNTIME',
});
function capacity() {
  return require('./platform-capacity');
}
const CAPACITY_LIMITS = Object.freeze(Object.entries(CAPACITY_ENV).map(([key, envKey]) => Object.freeze({
  key,
  envKey,
  enabled: (config) => capacity().enabled(config, key),
  measure: (config, _pool, deps) => capacity().measure(config, key, deps),
})));
const ALL_LIMITS = Object.freeze([...LIMITS, ...CAPACITY_LIMITS]);
const LIMIT_BY_KEY = new Map(ALL_LIMITS.map((limit) => [limit.key, limit]));

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

// Read at call time so a value set in the Platform variables panel applies
// on the first sweep after the deploy that carries it, and tests can set it
// without re-requiring the module. Declared in dapp.json's platform_env.
function warnPercent() {
  const n = parseInt(process.env.PLATFORM_LIMIT_WARN_PERCENT || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : DEFAULT_WARN_PERCENT;
}

// The count at which each level begins, or null when the cap is off
// (MAX_APPS <= 0 disables the app cap; a non-number is treated the same).
function lines(cap, percent) {
  const c = Number(cap);
  if (!Number.isFinite(c) || c <= 0) return null;
  const whole = Math.floor(c);
  return { warn: Math.max(1, Math.ceil((whole * percent) / 100)), full: whole };
}

function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : 'ok';
}

/**
 * The policy, pure. Given the count, the cap, the warning percent and the
 * level last recorded, returns the level to record now and the level to
 * notify about (null for none).
 *
 *   - a rise to a higher level notifies that level (a jump from ok straight
 *     to full notifies only full);
 *   - staying put notifies nothing;
 *   - a fall re-arms a level only once the count is under
 *     REARM_RATIO x that level's line, and never notifies;
 *   - a cap that is off records ok, so switching it back on starts clean.
 */
function decide({ used, cap, percent = DEFAULT_WARN_PERCENT, level }) {
  const at = lines(cap, percent);
  const stored = normalizeLevel(level);
  if (!at) return { level: 'ok', notify: null };
  const n = Number.isFinite(Number(used)) && Number(used) > 0 ? Number(used) : 0;
  const raw = n >= at.full ? 'full' : (n >= at.warn ? 'warn' : 'ok');
  if (RANK[raw] > RANK[stored]) return { level: raw, notify: raw };
  if (RANK[raw] === RANK[stored]) return { level: stored, notify: null };
  let held = stored;
  if (held === 'full' && n < at.full * REARM_RATIO) held = 'warn';
  if (held === 'warn' && n < at.warn * REARM_RATIO) held = 'ok';
  return { level: held, notify: null };
}

// notifications.detail token: "<limit>_<level>:<used>:<cap>", e.g.
// "apps_warn:40:50". The drawer and the push copy parse it back; neither
// shows it raw. Figures are clamped to seven digits so the widest token
// ("node_pool_full:9999999:9999999", 30) stays inside the 32 characters every
// creator keeps to. A quota's figure is thousandths, clamped to four digits
// (platform-capacity.js), so "quota_workers_full:9999:1000" is 28.
const MAX_FIGURE = 9999999;

function figure(n) {
  return Math.min(MAX_FIGURE, Math.max(0, Math.floor(Number(n) || 0)));
}

function detailToken(key, level, used, cap) {
  return `${key}_${level}:${figure(used)}:${figure(cap)}`;
}

const DETAIL_RE = /^(apps|sessions|connections|db_disk|quota_apps|quota_workers|quota_builds|node_pool|github|github_app)_(warn|full):(\d{1,7}):(\d{1,7})$/;

function parseDetail(detail) {
  const m = DETAIL_RE.exec(String(detail || ''));
  if (!m) return null;
  return { limit: m[1], level: m[2], used: Number(m[3]), cap: Number(m[4]) };
}

// #6901: a refusal notice's token, "apps_away:<people>:<cap>:<ago>", e.g.
// "apps_away:3:210:180". `ago` is the minutes from the run's start to the
// notice: 0 means "someone was just turned away". People clamp to five
// digits, cap to seven and ago to four, so the widest is 28 characters,
// inside the 32 every creator keeps to. The drawer and the push copy parse
// it back; neither shows it raw.
function refusalToken(people, cap, agoMinutes) {
  const p = Math.min(99999, Math.max(0, Math.floor(Number(people) || 0)));
  const ago = Math.min(9999, Math.max(0, Math.floor(Number(agoMinutes) || 0)));
  return `apps_away:${p}:${figure(cap)}:${ago}`;
}

const REFUSAL_DETAIL_RE = /^apps_away:(\d{1,5}):(\d{1,7}):(\d{1,4})$/;

function parseRefusalDetail(detail) {
  const m = REFUSAL_DETAIL_RE.exec(String(detail || ''));
  if (!m) return null;
  return { people: Number(m[1]), cap: Number(m[2]), agoMinutes: Number(m[3]) };
}

// Resolved at call time so a test can swap either without a database.
function defaultCreate(db, args) {
  return require('./notifications').createPlatformLimitNotifications(db, args);
}
function defaultPublish(pool, row) {
  return require('./notifications').hydrateAndPush(pool, row);
}

/**
 * Measure one cap and apply `decide()` to it. Returns
 * { key, used, cap, level, notified } and never notifies twice for one
 * crossing, however many callers race it.
 *
 * deps.create   overrides notifications.createPlatformLimitNotifications
 * deps.publish  overrides notifications.hydrateAndPush
 * deps.staging  overrides the USERNODE_ENV check
 */
async function evaluate(pool, config, key, deps = {}) {
  const limit = LIMIT_BY_KEY.get(key);
  if (!limit) throw new Error(`unknown platform limit: ${key}`);
  const unknown = { key, used: null, cap: null, level: null, notified: null, recipients: 0, unknown: true };
  let cap;
  let used;
  let detail = null;
  if (limit.measure) {
    const measured = limit.enabled(config) ? await limit.measure(config, pool, deps.capacity || {}) : null;
    if (!measured) return unknown;
    ({ used, cap } = measured);
    detail = measured.detail || null;
  } else {
    cap = await limit.cap(config, pool);
  }
  // A process that has not heard from GitHub yet knows no figures: recording
  // "ok" would re-arm a crossing already told (each new process used to).
  if (limit.fromAnswers && !(Number(cap) > 0)) return unknown;
  const percent = limit.percent ? limit.percent() : warnPercent();
  if (!limit.measure) used = await limit.count(pool);
  if (!Number.isFinite(used) || used < 0) throw new Error(`bad ${key} count`);
  const staging = deps.staging ?? isStaging();
  const create = deps.create || defaultCreate;
  const publish = deps.publish || defaultPublish;

  const outcome = await withTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO platform_limit_alerts (limit_key) VALUES ($1)
       ON CONFLICT (limit_key) DO NOTHING`,
      [key]
    );
    const { rows } = await db.query(
      `SELECT level, (EXTRACT(EPOCH FROM window_reset_at) * 1000)::float8 AS window_ms
         FROM platform_limit_alerts WHERE limit_key = $1 FOR UPDATE`,
      [key]
    );
    // GitHub's figures are each process's own last answer, about the quota
    // window GitHub named (its reset). The level is that window's: within it
    // a level only rises (another process's older answer re-arms nothing),
    // an answer about a window before it is not recorded at all, and a new
    // window starts from ok, so its own crossings are told.
    let baseline = rows[0] && rows[0].level;
    let sameWindow = false;
    let window = null;
    if (limit.fromAnswers) {
      window = Number(limit.window()) || null;
      const storedWindow = rows[0] && rows[0].window_ms != null ? Number(rows[0].window_ms) : null;
      if (storedWindow && storedWindow > Date.now() && (!window || window < storedWindow)) {
        return { decision: null, inserted: [], stale: true };
      }
      sameWindow = !!storedWindow && window === storedWindow;
      if (!sameWindow) baseline = 'ok';
    }
    let decision = decide({ used, cap, percent, level: baseline });
    const stored = normalizeLevel(rows[0] && rows[0].level);
    if (sameWindow && RANK[decision.level] < RANK[stored]) decision = { level: stored, notify: null };
    await db.query(
      `UPDATE platform_limit_alerts
          SET level = $2, used = $3, cap = $4, measured_at = NOW(),
              notified_at = CASE WHEN $5::boolean THEN NOW() ELSE notified_at END,
              window_reset_at = CASE WHEN $6::float8 IS NULL THEN window_reset_at ELSE to_timestamp($6::float8 / 1000) END,
              refusals_since = CASE WHEN $4::int IS NULL OR $3::int < $4::int THEN NULL ELSE refusals_since END,
              detail = $7::jsonb
        WHERE limit_key = $1`,
      [key, decision.level, used, Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null,
        !!decision.notify, window, detail ? JSON.stringify(detail) : null]
    );
    let inserted = [];
    if (decision.notify && !staging) {
      inserted = await create(db, {
        detail: detailToken(key, decision.notify, used, cap),
      });
    }
    return { decision, inserted, previous: stored };
  });

  if (outcome.stale) {
    return { key, used: null, cap: null, level: null, notified: null, recipients: 0, stale: true };
  }
  if (outcome.decision.notify) {
    log.info('platform-limits', 'Platform limit crossed', {
      limit: key, level: outcome.decision.notify, used, cap, percent,
      recipients: outcome.inserted.length, staging,
    });
  }
  for (const row of outcome.inserted) {
    await Promise.resolve(publish(pool, row)).catch(() => {});
  }
  // The admin limits area at the top of Notifications reads this level
  // (services/platform-limits-view.js): when it moves, an open sheet and the
  // bell's dot read it again. GitHub's budget is not in the area.
  if (outcome.previous !== outcome.decision.level && key !== 'github_app') {
    (deps.limitsChanged || (() => require('./platform-limits-view').changed()))();
  }
  return {
    key, used, cap, level: outcome.decision.level,
    notified: outcome.decision.notify, recipients: outcome.inserted.length,
  };
}

/**
 * Count the people refused since the last refusal notice and, when there are
 * any, notify them. The platform_limit_alerts row must already be locked by
 * the caller's transaction. `since` is `refusals_notified_at` (the run's
 * start for its first count). Returns { token, inserted }, token null when
 * nobody is waiting to be reported.
 *
 * deps.create and deps.staging work as in evaluate().
 */
async function flushRefusals(db, key, cap, since, deps = {}, now = null) {
  const staging = deps.staging ?? isStaging();
  const create = deps.create || defaultCreate;
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT user_id)::int AS n
       FROM platform_limit_refusals
      WHERE limit_key = $1 AND refused_at > $2`,
    [key, since]
  );
  const people = Number(rows[0] && rows[0].n) || 0;
  if (people <= 0) return { token: null, inserted: [] };
  const at = now ? new Date(now) : new Date();
  const ago = Math.max(0, Math.round((at.getTime() - new Date(since).getTime()) / 60000));
  const token = refusalToken(people, cap, ago);
  const inserted = staging ? [] : await create(db, { detail: token, repeatable: true });
  await db.query(
    'UPDATE platform_limit_alerts SET refusals_notified_at = $2 WHERE limit_key = $1',
    [key, at]
  );
  return { token, inserted };
}

/** Publish what a refusal notice created, after its transaction committed. */
async function publishAll(pool, inserted, deps = {}) {
  const publish = deps.publish || defaultPublish;
  for (const row of inserted) {
    await Promise.resolve(publish(pool, row)).catch(() => {});
  }
}

/**
 * Record that `userId` was turned away at `key`'s cap (#6901). One row per
 * account per UTC day, so a retry counts once.
 *
 * The first refusal of a run notifies the full admins AT ONCE, whatever the
 * level says: a cap raised while the count stayed above the re-arm line
 * leaves the level at "full", and that is exactly the case that used to tell
 * nobody. After that at most one count notice every
 * REFUSAL_NOTICE_INTERVAL_MS. Previews record the refusal but notify nobody.
 *
 * deps.create, deps.publish and deps.staging work as in evaluate().
 */
async function recordRefusal(pool, config, key, userId, deps = {}) {
  if (key !== 'apps' || !userId) return { notified: null, recipients: 0 };
  const limit = LIMIT_BY_KEY.get(key);
  if (!limit || !limit.enabled(config)) return { notified: null, recipients: 0 };
  const cap = await limit.cap(config, pool);
  if (!(Number(cap) > 0)) return { notified: null, recipients: 0 };
  const staging = deps.staging ?? isStaging();
  const create = deps.create || defaultCreate;

  const outcome = await withTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO platform_limit_refusals (limit_key, user_id, day)
       VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date)
       ON CONFLICT DO NOTHING`,
      [key, userId]
    );
    await db.query(
      `INSERT INTO platform_limit_alerts (limit_key) VALUES ($1)
       ON CONFLICT (limit_key) DO NOTHING`,
      [key]
    );
    const { rows } = await db.query(
      `SELECT refusals_since, refusals_notified_at, NOW() AS now
         FROM platform_limit_alerts WHERE limit_key = $1 FOR UPDATE`,
      [key]
    );
    const row = rows[0] || {};
    const now = row.now ? new Date(row.now) : new Date();
    if (!row.refusals_since) {
      // A new run: the server was full and nobody had been recorded yet.
      await db.query(
        `UPDATE platform_limit_alerts
            SET refusals_since = $2, refusals_notified_at = $2
          WHERE limit_key = $1`,
        [key, now]
      );
      const token = refusalToken(1, cap, 0);
      const inserted = staging ? [] : await create(db, { detail: token, repeatable: true });
      return { token, inserted };
    }
    const since = row.refusals_notified_at || row.refusals_since;
    if (now.getTime() - new Date(since).getTime() < REFUSAL_NOTICE_INTERVAL_MS) {
      return { token: null, inserted: [] };
    }
    const flushed = await flushRefusals(db, key, cap, since, { ...deps, staging, create }, now);
    return flushed;
  });

  await publishAll(pool, outcome.inserted, deps);
  if (outcome.token) {
    log.info('platform-limits', 'Someone was turned away at a platform limit', {
      limit: key, cap, detail: outcome.token, recipients: outcome.inserted.length, staging,
    });
    // The admin limits area shows the count (services/platform-limits-view.js).
    (deps.limitsChanged || (() => require('./platform-limits-view').changed()))();
  }
  return { notified: outcome.token, recipients: outcome.inserted.length };
}

/**
 * The leaders' sweep reports refusals that have stopped as well: with nobody
 * new refused, the pending count still goes out once the interval is up.
 * Never throws; the caller records a failure like the others.
 */
async function sweepRefusals(pool, config, key, deps = {}) {
  const limit = LIMIT_BY_KEY.get(key);
  if (!limit || !limit.enabled(config)) return null;
  const cap = await limit.cap(config, pool);
  if (!(Number(cap) > 0)) return null;
  const staging = deps.staging ?? isStaging();

  const outcome = await withTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT refusals_since, refusals_notified_at, NOW() AS now
         FROM platform_limit_alerts WHERE limit_key = $1 FOR UPDATE`,
      [key]
    );
    const row = rows[0];
    if (!row || !row.refusals_since) return { token: null, inserted: [] };
    const since = row.refusals_notified_at || row.refusals_since;
    const now = row.now ? new Date(row.now) : new Date();
    if (now.getTime() - new Date(since).getTime() < REFUSAL_NOTICE_INTERVAL_MS) {
      return { token: null, inserted: [] };
    }
    return flushRefusals(db, key, cap, since, { ...deps, staging }, now);
  });
  await publishAll(pool, outcome.inserted, deps);
  return outcome.token;
}

/**
 * How many people were turned away since the server last had room, and when
 * that run began (ISO), for Admin → Limits (#6901). { turnedAway: 0,
 * since: null } when no run is open.
 */
async function refusalSummary(pool, key = 'apps') {
  const { rows } = await pool.query(
    `SELECT a.refusals_since,
            (SELECT COUNT(DISTINCT r.user_id)::int
               FROM platform_limit_refusals r
              WHERE r.limit_key = a.limit_key
                AND r.refused_at >= a.refusals_since) AS n
       FROM platform_limit_alerts a
      WHERE a.limit_key = $1`,
    [key]
  );
  const row = rows[0];
  if (!row || !row.refusals_since) return { turnedAway: 0, since: null };
  return {
    turnedAway: Number(row.n) || 0,
    since: new Date(row.refusals_since).toISOString(),
  };
}

/**
 * Fire-and-forget for request paths: record a refusal after the response has
 * been decided, never throw, never delay the caller. A no-op when the cap is
 * off, so route tests that mount with `maxApps: 0` never see it.
 */
function noteRefusal(pool, config, key, userId) {
  const limit = LIMIT_BY_KEY.get(key);
  if (!limit || !limit.enabled(config) || !userId) return;
  Promise.resolve()
    .then(() => recordRefusal(pool, config, key, userId))
    .catch((err) => {
      log.warn('platform-limits', 'Platform limit refusal not recorded', { limit: key, err: err.message });
    });
}

/** Evaluate every cap. Never throws; errors are collected per cap. */
async function sweep(pool, config, deps = {}) {
  const summary = { results: [], errors: [] };
  for (const limit of ALL_LIMITS) {
    try {
      summary.results.push(await evaluate(pool, config, limit.key, deps));
    } catch (err) {
      summary.errors.push(`${limit.key}: ${err.message}`);
      log.warn('platform-limits', 'Platform limit check failed', { limit: limit.key, err: err.message });
    }
  }
  // Refusals that have stopped still get their last count once the interval
  // is up, so nobody goes unreported.
  try {
    await sweepRefusals(pool, config, 'apps', deps);
  } catch (err) {
    summary.errors.push(`apps refusals: ${err.message}`);
    log.warn('platform-limits', 'Platform limit refusal check failed', { err: err.message });
  }
  return summary;
}

/**
 * Fire-and-forget for request paths: evaluate one cap after the response
 * has been decided, never throw, never delay the caller. A no-op when the
 * cap is off, so route tests that mount with `maxApps: 0` never see it.
 */
function nudge(pool, config, key) {
  const limit = LIMIT_BY_KEY.get(key);
  if (!limit || !limit.enabled(config)) return;
  Promise.resolve()
    .then(() => evaluate(pool, config, key))
    .catch((err) => {
      log.warn('platform-limits', 'Platform limit nudge failed', { limit: key, err: err.message });
    });
}

module.exports = {
  LIMITS,
  CAPACITY_LIMITS,
  ALL_LIMITS,
  REARM_RATIO,
  SWEEP_INTERVAL_MS,
  REFUSAL_NOTICE_INTERVAL_MS,
  DEFAULT_WARN_PERCENT,
  warnPercent,
  lines,
  decide,
  detailToken,
  parseDetail,
  refusalToken,
  REFUSAL_DETAIL_RE,
  parseRefusalDetail,
  evaluate,
  recordRefusal,
  flushRefusals,
  sweepRefusals,
  refusalSummary,
  sweep,
  nudge,
  noteRefusal,
};
