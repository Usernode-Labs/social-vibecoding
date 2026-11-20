'use strict';

// The platform limits area at the top of Notifications, for full admins: every
// platform-wide limit that is near, at or over the line where Homeroom stops
// working until an admin raises something by hand, worst first.
//
// The limits in it:
//
//   apps            non-errored apps against the app limit. At it, POST
//                   /api/apps and /fork refuse everyone but full admins.
//   sessions        active and promoted coding sessions against the session
//                   limit. At it, new sessions pause idle ones, then are
//                   refused.
//   openrouter_credit
//                   the bot's building credit (services/openrouter-credit.js,
//                   #6867): the lower of the account's credit and the bot
//                   key's own limit. Out, the bot stops planning and building.
//   db_connections  client connections on the shared Postgres server against
//                   the line where ordinary logins (every app's) are refused:
//                   platform-limit-alerts.js's `connections` limit, so it
//                   has a stored level and bell notices like the others.
//
// Nothing here makes a new outside call when the area is opened. The counted
// limits are read through platform-limit-alerts.js's own LIMITS (the count and
// cap queries the enforcing routes use) and its stored level, the credit from
// the state its own sweep keeps. The apps row's count of people turned away
// is #6901's (refusalSummary). The figures are held for CACHE_MS. Only "Check
// again" (`refresh`) runs the sweeps, which is what reads OpenRouter.
//
// A row's level is decided with platform-limit-alerts.decide(), so it leaves
// only once its figure is back under its line by the same margin that stops
// the alerts repeating (REARM_RATIO): the area and the alerts never disagree
// about whether a limit is near. Nothing else takes a row away: there is no
// dismiss.
//
// `changed()` is how a level change reaches an open sheet and the bell: the
// sweeps call it when a level moves, and it pings every admin socket with
// `platform_limits_changed`. The ping carries no figures; the page reads them
// again through the full-admin route.

const log = require('./logger');

const CACHE_MS = 30 * 1000;
// The credit sweep runs every 15 minutes (workflow/clock/services.ts): three
// missed reads make the last figure too old to stand on.
const CREDIT_STALE_MS = 45 * 60 * 1000;
const COUNTED = Object.freeze(['apps', 'sessions', 'connections']);
// The alerts' key for a limit, and the row's (the client's) key for it.
const ROW_KEY = Object.freeze({ apps: 'apps', sessions: 'sessions', connections: 'db_connections' });
// Worst first; then the order the mockup lists them in.
const STATE_RANK = Object.freeze({ over: 0, at: 1, out: 1, near: 2, unknown: 3 });
const KEY_RANK = Object.freeze({ apps: 0, openrouter_credit: 1, sessions: 2, db_connections: 3 });
// The states the bell's red dot is for: Homeroom is refusing something now.
const BROKEN = Object.freeze(new Set(['over', 'at', 'out']));

const caches = new WeakMap();
// Bumped by changed(): every held answer from before a level moved is dropped.
let generation = 0;

function alerts() {
  return require('./platform-limit-alerts');
}

/**
 * One counted limit as a row, or null when it is under its line. Pure.
 * `level` is the one platform-limit-alerts last stored, so a row that has
 * crossed a line stays until the count is back under it by the margin.
 */
function countedRow(key, { used, cap, percent, level }) {
  const at = alerts().lines(cap, percent);
  if (!at) return null;
  const n = Number.isFinite(Number(used)) && Number(used) > 0 ? Math.floor(Number(used)) : 0;
  const { level: held } = alerts().decide({ used: n, cap: at.full, percent, level });
  if (held === 'ok') return null;
  const state = n > at.full ? 'over' : (n >= at.full ? 'at' : 'near');
  return {
    key,
    state,
    level: held,
    used: n,
    cap: at.full,
    warnAt: at.warn,
    left: Math.max(0, at.full - n),
    percent: Math.min(100, Math.round((n / at.full) * 100)),
  };
}

/**
 * The credit as a row, or null when there is nothing to say. Pure. `status`
 * is openrouter-credit.status(): the stored state the sweep keeps.
 *
 *   out      a turn found the credit gone (the stored outage), or the last
 *            read found none left
 *   near     under the warn line ($500 by default; `urgent` once under $200)
 *   unknown  a figure was known, but the last read got no answer, or the
 *            last read is older than CREDIT_STALE_MS
 *
 * A deploy that has never had a figure (no management key and an unlimited
 * bot key) says nothing: that is not a limit anybody can watch.
 */
function creditRow(status, { now = Date.now() } = {}) {
  if (!status || typeof status !== 'object') return null;
  const known = Number.isFinite(status.balanceCents);
  const base = {
    key: 'openrouter_credit',
    balanceCents: known ? Math.max(0, Math.round(status.balanceCents)) : null,
    warnCents: Number.isFinite(status.warnCents) ? status.warnCents : null,
    urgentCents: Number.isFinite(status.urgentCents) ? status.urgentCents : null,
    daysLeft: Number.isFinite(status.daysLeft) ? status.daysLeft : null,
    measuredAt: status.at || null,
  };
  if (status.outage && status.outage.since) {
    return { ...base, state: 'out', since: status.outage.since };
  }
  if (!known) return null;
  const at = Date.parse(status.at || '');
  const noAnswer = status.accountCents == null && status.keyCents == null;
  if (noAnswer || !Number.isFinite(at) || now - at > CREDIT_STALE_MS) {
    return { ...base, state: 'unknown', reason: noAnswer ? 'no_answer' : 'stale' };
  }
  if (base.balanceCents <= 0) return { ...base, state: 'out', since: null };
  if (base.warnCents != null && base.balanceCents < base.warnCents) {
    return {
      ...base,
      state: 'near',
      urgent: base.urgentCents != null && base.balanceCents < base.urgentCents,
    };
  }
  return null;
}

function unknownRow(key, reason) {
  return { key, state: 'unknown', reason };
}

/** Worst first, then a fixed order. Pure. */
function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const s = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
    return s || (KEY_RANK[a.key] ?? 9) - (KEY_RANK[b.key] ?? 9);
  });
}

async function storedLevels(pool) {
  const out = new Map();
  try {
    const { rows } = await pool.query(
      'SELECT limit_key, level FROM platform_limit_alerts WHERE limit_key = ANY($1::text[])',
      [COUNTED],
    );
    for (const row of rows) out.set(row.limit_key, row.level);
  } catch (err) {
    // Never recorded yet, or unreadable: the live figures still decide.
    log.warn('platform-limits', 'Could not read the stored limit levels', { err: err.message });
  }
  return out;
}

/**
 * Every row, worst first, and whether anything is refusing now. Reads only
 * the database; never throws for one limit (that limit's row says it could
 * not be checked).
 */
async function compute(pool, config) {
  const limits = alerts();
  const percent = limits.warnPercent();
  const levels = await storedLevels(pool);
  const rows = [];
  for (const key of COUNTED) {
    const limit = limits.LIMITS.find((l) => l.key === key);
    if (!limit || !limit.enabled(config)) continue;
    try {
      const cap = await limit.cap(config, pool);
      const used = await limit.count(pool);
      const row = countedRow(ROW_KEY[key], { used, cap, percent, level: levels.get(key) });
      if (row) rows.push(row);
    } catch (err) {
      log.warn('platform-limits', 'Could not read a limit', { limit: key, err: err.message });
      rows.push(unknownRow(ROW_KEY[key], 'no_answer'));
    }
  }
  // #6901 counts the people turned away at the app limit while it is full;
  // the row says that count, from that one source.
  const apps = rows.find((row) => row.key === 'apps' && BROKEN.has(row.state));
  if (apps) {
    try {
      const refused = await limits.refusalSummary(pool, 'apps');
      if (refused.turnedAway > 0) Object.assign(apps, { turnedAway: refused.turnedAway, turnedAwaySince: refused.since });
    } catch (err) {
      log.warn('platform-limits', 'Could not read the refusal count', { err: err.message });
    }
  }
  try {
    const row = creditRow(await require('./openrouter-credit').status(pool));
    if (row) rows.push(row);
  } catch (err) {
    log.warn('platform-limits', 'Could not read the credit state', { err: err.message });
  }
  const sorted = sortRows(rows);
  return {
    rows: sorted,
    broken: sorted.some((row) => BROKEN.has(row.state)),
    checkedAt: new Date().toISOString(),
  };
}

/** What GET /api/admin/platform-limits answers, held for CACHE_MS per pool. */
async function read(pool, config, { fresh = false } = {}) {
  const held = caches.get(pool);
  if (!fresh && held && held.generation === generation && Date.now() - held.at < CACHE_MS) return held.value;
  const started = generation;
  const value = await compute(pool, config);
  caches.set(pool, { at: Date.now(), generation: started, value });
  return value;
}

/**
 * "Check again": run the sweeps that read each figure afresh (the counted
 * limits' evaluate, and the credit sweep, which reads OpenRouter), then answer
 * the area anew. The sweeps notify as they always do on a crossing.
 */
async function refresh(pool, config) {
  const limits = alerts();
  for (const key of COUNTED) {
    await limits.evaluate(pool, config, key).catch((err) =>
      log.warn('platform-limits', 'A limit check failed', { limit: key, err: err.message }));
  }
  await require('./openrouter-credit').sweep(pool, config);
  return read(pool, config, { fresh: true });
}

/**
 * A level moved: drop the held figures and tell every admin socket, so an
 * open sheet and the bell read them again. Never throws.
 */
function changed() {
  generation += 1;
  try {
    require('./ws').broadcastToAdmins({ type: 'platform_limits_changed' });
  } catch (err) {
    log.warn('platform-limits', 'Could not tell the admins a limit moved', { err: err.message });
  }
}

/**
 * The credit sweep's hook: tell the admins when the credit's row would
 * change state (low, out, unknown, or gone). Pure decision, then `changed`.
 */
function creditMoved(before, after, settings = {}, { now = Date.now() } = {}) {
  const row = (state) => creditRow(state ? { ...settings, ...state } : null, { now });
  const was = row(before);
  const is = row(after);
  if ((was && was.state) !== (is && is.state)) {
    changed();
    return true;
  }
  return false;
}

/** Tests only: drop the held figures. */
function resetForTests() {
  generation += 1;
}

module.exports = {
  CACHE_MS,
  CREDIT_STALE_MS,
  BROKEN,
  countedRow,
  creditRow,
  sortRows,
  compute,
  read,
  refresh,
  changed,
  creditMoved,
  resetForTests,
};
