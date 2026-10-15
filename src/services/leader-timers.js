'use strict';

// The leader's background timers, in one place.
//
// becomeLeader() (server.js) starts some seventy sweepers, pollers and
// reconcilers, most of them a bare setInterval in whichever module owns the
// work. Two things went wrong with that, and both are fixed here rather than
// in each timer:
//
//   1. Nothing stopped them at shutdown. cleanup() cleared the handful of
//      handles server.js kept and nothing else, so through the whole drain
//      the eligible-merge sweep, the drift poller, app-heal, main-watch and
//      the rest kept firing: a merge or a rebuild started moments before
//      the process exited, and died with it. Every tick here is skipped once
//      lifecycle.isShuttingDown() is true, stopAll() clears every handle,
//      and a tick already running is held in services/inflight-work.js so
//      the drain gives it its deadline to finish.
//
//   2. A long interval never fired. The leader changes with every release,
//      on a busy day every twenty minutes or so, and a setInterval with no
//      first run starts its clock again at each election, so an hourly
//      sweep (stale proposals, archived volume GC, the Workshop's daily
//      re-draft, grant pruning) went days without running. A `durable`
//      timer keeps its last completed run in the leader_sweeps table and,
//      on election, runs when that says it is due: at
//      max(settleMs, last_run + interval - now), plus up to jitterMs so the
//      overdue ones do not all start in the same second; then every
//      interval. A sweep that never ran (no row) is due at once.
//
// `every(name, fn, intervalMs, options)` replaces `setInterval(fn, ms)` for
// leader work. Names are unique: starting one that is already running is a
// no-op, which is the guard the modules' own `if (timer) return` used to be.
// Every handle is unref'd, so no timer holds the process open.

const lifecycle = require('./lifecycle');
const inflight = require('./inflight-work');
const log = require('./logger');

// A durable timer's first run waits at least this long after election, so it
// lands after the boot recovery chain and the role bootstraps rather than in
// the middle of them, the way the fixed first-run delays elsewhere do.
const DURABLE_SETTLE_MS = 30 * 1000;
// ...and up to this much more, at random, capped at a tenth of its interval.
const DURABLE_JITTER_MS = 30 * 1000;

const timers = new Map(); // name → entry

// What a tick returns (or resolves to) when it did not run its sweep — its
// own single-flight guard found another pass under way — so a durable timer
// does not record a run that never happened and push the real one a whole
// interval away.
const SKIPPED = Symbol('leader-timers.skipped');

function unref(handle) {
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

// How long until `name` is due, by the database's clock on both sides so a
// pod's clock cannot move it: 0 when it never ran or is overdue, never more
// than one interval.
async function dueInMs(pool, name, intervalMs) {
  const { rows } = await pool.query(
    `SELECT GREATEST(0, EXTRACT(EPOCH FROM (last_run_at - NOW())) * 1000 + $2::bigint)::bigint AS due_in_ms
       FROM leader_sweeps WHERE name = $1`,
    [name, intervalMs]
  );
  if (!rows.length) return 0;
  const due = Number(rows[0].due_in_ms);
  return Number.isFinite(due) ? Math.min(Math.max(0, due), intervalMs) : 0;
}

async function recordRun(pool, name) {
  try {
    await pool.query(
      `INSERT INTO leader_sweeps (name, last_run_at) VALUES ($1, NOW())
       ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`,
      [name]
    );
  } catch (err) {
    // The next election runs it again a little early; nothing worse.
    log.warn('leader-timers', 'Could not record a sweep run', { name, err: err.message });
  }
}

// One tick: nothing once shutdown has begun or the timer was cleared;
// otherwise the run, held in the in-flight registry until it settles (the
// durable record included), with any throw logged rather than left
// unhandled. Returns the run's promise (resolving true when fn completed,
// false when it threw or returned SKIPPED), or null when not started.
function tick(entry) {
  if (lifecycle.isShuttingDown() || timers.get(entry.name) !== entry) return null;
  entry.runs += 1;
  return inflight.track(`timer:${entry.name}`, async () => {
    try {
      if ((await entry.fn()) === SKIPPED) return false;
    } catch (err) {
      log.warn('leader-timers', 'Timer tick failed', { name: entry.name, err: err && err.message });
      return false;
    }
    if (entry.durable) await recordRun(entry.durable, entry.name);
    return true;
  });
}

function startRepeating(entry) {
  if (timers.get(entry.name) !== entry || entry.repeat) return;
  entry.repeat = unref(setInterval(() => { tick(entry); }, entry.intervalMs));
}

/**
 * Run `fn` every `intervalMs` while this process leads.
 *
 * Options:
 *   firstDelayMs  a first run this long after start, before the interval
 *                 (plain timers only; omit for none, as setInterval)
 *   durable       a pg pool: keep the last completed run in leader_sweeps
 *                 and schedule the first run from it (see the header)
 *   settleMs, jitterMs, random   the durable first run's floor, spread and
 *                 source of randomness (tests pin these)
 *
 * Returns a function that stops this timer.
 */
function every(name, fn, intervalMs, {
  firstDelayMs = null,
  durable = null,
  settleMs = DURABLE_SETTLE_MS,
  jitterMs = DURABLE_JITTER_MS,
  random = Math.random,
} = {}) {
  const stop = () => clear(name);
  if (timers.has(name)) return stop;
  // Never a throw: becomeLeader() starts every timer in one pass, and one
  // mis-set interval must not cost the rest of the leader's duties.
  if (!(intervalMs > 0)) {
    log.warn('leader-timers', 'Timer not started: its interval is not a positive number', { name, intervalMs });
    return stop;
  }
  // A follower promoted while it is itself shutting down starts nothing.
  if (lifecycle.isShuttingDown()) return stop;
  const entry = {
    name, fn, intervalMs, durable, runs: 0,
    first: null, repeat: null, firstDelayMs: null, ready: null,
  };
  timers.set(name, entry);

  if (!durable) {
    if (firstDelayMs != null) {
      entry.firstDelayMs = Math.max(0, firstDelayMs);
      entry.first = unref(setTimeout(() => { entry.first = null; tick(entry); }, entry.firstDelayMs));
    }
    startRepeating(entry);
    entry.ready = Promise.resolve(entry.firstDelayMs);
    return stop;
  }

  entry.ready = dueInMs(durable, name, intervalMs)
    .catch((err) => {
      log.warn('leader-timers', 'Could not read a sweep\'s last run; running it as if it never ran', {
        name, err: err.message,
      });
      return 0;
    })
    .then((dueIn) => {
      if (timers.get(name) !== entry) return null;
      const spread = Math.max(0, Math.min(jitterMs, Math.floor(intervalMs / 10)));
      const delay = Math.max(settleMs, dueIn) + Math.floor(random() * spread);
      entry.firstDelayMs = delay;
      entry.first = unref(setTimeout(() => {
        entry.first = null;
        tick(entry);
        startRepeating(entry);
      }, delay));
      return delay;
    });
  return stop;
}

/** Stop one timer. A tick already running is left to finish. */
function clear(name) {
  const entry = timers.get(name);
  if (!entry) return false;
  timers.delete(name);
  if (entry.first) clearTimeout(entry.first);
  if (entry.repeat) clearInterval(entry.repeat);
  entry.first = null;
  entry.repeat = null;
  return true;
}

/** Stop every timer (cleanup() calls this as shutdown begins). Returns their names. */
function stopAll() {
  const names = [...timers.keys()];
  for (const name of names) clear(name);
  return names;
}

function has(name) {
  return timers.has(name);
}

/** The timers running now: [{ name, intervalMs, durable, firstDelayMs, runs }]. */
function snapshot() {
  return [...timers.values()].map((e) => ({
    name: e.name, intervalMs: e.intervalMs, durable: !!e.durable, firstDelayMs: e.firstDelayMs, runs: e.runs,
  }));
}

/** Test hook: resolves once `name`'s first run is scheduled (durable timers read the table first). */
function ready(name) {
  const entry = timers.get(name);
  return entry ? entry.ready : Promise.resolve(null);
}

module.exports = {
  SKIPPED,
  every,
  clear,
  stopAll,
  has,
  snapshot,
  ready,
  dueInMs,
  recordRun,
  DURABLE_SETTLE_MS,
  DURABLE_JITTER_MS,
};
