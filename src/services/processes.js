'use strict';

/**
 * The platform's processes (docs/plans/draining-releases.md), and what this
 * one is doing, for its own drain.
 *
 * A release no longer cuts the Pod it replaces: that Pod finishes what it
 * started and exits when it is idle, while the new one serves. What another
 * process needs to know about work is never read from here: a turn is its
 * machine's work item (src/workflow/turn/), and who works on a session is
 * its durable records (src/workflow/session-work.ts workedOnSql).
 *
 * PROCESSES. One row each in platform_processes, written at start, beaten
 * every HEARTBEAT_MS, marked `draining` (with its deadline) when shutdown
 * begins and deleted as it exits. A row whose beat is older than
 * LIVE_SECONDS is a process that is gone, whatever it says. The roster says
 * which build serves (the clocks' newest build, the release), which
 * processes run the workflow (the admin view), and whether a draining
 * process has a successor.
 *
 * HOLDS. `hold(kind, ref)` says this process is doing `kind` for `ref` (a
 * session's turn or operation, a hand-off pipeline, a fleet rollover's
 * deploy) and returns the release; `heldMap`/`heldSet` are registries whose
 * keys are holds. They are this process's alone, in memory: what its drain
 * waits for (localCount). No process of this release reads another's.
 *
 * ROLLOUT-ONLY: the holds are also written to process_holds, the whole set
 * at once, on every change and every beat (writeHolds), for a release from
 * before the turn machine while it runs beside this one. That release reads
 * them to decide what is left behind: a session busy elsewhere (its idle
 * eviction skips one), a turn or headless run it would adopt or resume, a
 * Stop it forwards to the process running the turn (services/turn-
 * leftovers.js receiveOlderStop). (A worker kept warm is no hold any more:
 * that release may adopt and evict an idle one of this release's, which
 * costs its next turn a re-warm.) Nothing here reads them back but
 * turn-leftovers' own rollout-only reads of other processes' rows.
 * Delete the write once no release older than this one can run.
 */

const crypto = require('crypto');
const os = require('os');
const log = require('./logger');
const { successorRoles } = require('./process-role');

const HEARTBEAT_MS = 10 * 1000;
// A process that has not beaten for this long is gone (four beats missed).
const LIVE_SECONDS = 45;
// Rows the process-reap clock deletes: long gone, so nothing could still
// read them as live.
const REAP_AFTER_SECONDS = 10 * 60;

// Every statement of the roster about this process runs on the process's
// lock connection, never through the main pool (db/session-locks.js
// coordinationQuery): a draining process's pool can be all checked out by
// the work it is finishing, and its heartbeat and its reads of who started
// since must not wait behind that (item 4, the connection budget).
function q(db, sql, params) {
  return require('../db/session-locks').coordinationQuery(db, sql, params);
}

const KINDS = Object.freeze([
  'session',        // a turn or an operation on a dev session (active-workers.js)
  'handoff',        // a hand-off pipeline (handoff-pipeline.js)
  'deploy',         // a fleet rollover's deploy, by app slug (app-deploy-status.js)
  'agent_turn',     // the Mayor's turn in an agent session (mayor/agent-turn.js)
]);
const KNOWN = new Set(KINDS);

const ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

let pool = null;
let started = false;
let role = 'all';
let heartbeatTimer = null;
let draining = null; // { since, deadline } once shutdown has begun
// Connections held above the drain sizes (the roster's above_drain): 1 from
// the moment it is marked draining until its drain reports what it holds.
let aboveDrain = 0;

// key -> count, for this process. key = `${kind}\u0000${ref}`
const local = new Map();

// ROLLOUT-ONLY (see the header): the writes of the holds to process_holds,
// one after another, and whether one not yet begun is queued (it reads
// `local` when it runs, so one queued write covers every change before it).
let writes = Promise.resolve();
let writeQueued = false;
const WRITE_HOLDS_SQL = `
  WITH held AS (SELECT * FROM unnest($2::text[], $3::text[]) AS h(kind, ref)),
       gone AS (DELETE FROM process_holds p
                 WHERE p.process_id = $1
                   AND NOT EXISTS (SELECT 1 FROM held h WHERE h.kind = p.kind AND h.ref = p.ref))
  INSERT INTO process_holds (process_id, kind, ref)
  SELECT $1, kind, ref FROM held
  ON CONFLICT (process_id, kind, ref) DO NOTHING`;

function keyOf(kind, ref) {
  return `${kind}\u0000${ref}`;
}

function splitKey(key) {
  const at = key.indexOf('\u0000');
  return { kind: key.slice(0, at), ref: key.slice(at + 1) };
}

function refOf(ref) {
  if (ref === null || ref === undefined || ref === '') throw new Error('a hold needs a ref');
  return String(ref);
}

function checkKind(kind) {
  if (!KNOWN.has(kind)) throw new Error(`unknown hold kind: ${kind}`);
}

// ROLLOUT-ONLY: this process's holds, as they are when the write runs, are
// the rows process_holds has for it. A write that fails is the next beat's
// to make again.
function writeHolds() {
  if (!started || !pool || writeQueued) return writes;
  writeQueued = true;
  writes = writes.then(async () => {
    writeQueued = false;
    if (!started || !pool) return;
    const held = [...local.keys()].map(splitKey);
    try {
      await q(pool, WRITE_HOLDS_SQL, [ID, held.map((h) => h.kind), held.map((h) => h.ref)]);
    } catch (err) {
      log.warn('processes', 'Could not write this process\'s holds; the next beat writes them', { err: err.message });
    }
  });
  return writes;
}

/**
 * This process holds `kind` for `ref` until the returned function is called
 * (idempotent). What its drain waits for; never throws for a database
 * problem (the rollout-only write is logged and made again).
 */
function hold(kind, ref) {
  checkKind(kind);
  const key = keyOf(kind, refOf(ref));
  const n = local.get(key) || 0;
  local.set(key, n + 1);
  if (n === 0) writeHolds();
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const left = (local.get(key) || 1) - 1;
    if (left > 0) { local.set(key, left); return; }
    local.delete(key);
    writeHolds();
  };
}

/**
 * A Map (or Set) whose every key is also a hold of `kind`: the registries
 * that said "this process is doing X for key" change their constructor and
 * nothing else. `refFor(key)` turns a key into the hold's ref (default: the
 * key); a key with no ref is kept but holds nothing.
 */
function heldMap(kind, refFor = (key) => key) {
  checkKind(kind);
  const releases = new Map();
  const take = (key) => {
    if (releases.has(key)) return;
    try { releases.set(key, hold(kind, refFor(key))); } catch { /* no ref: nothing to hold */ }
  };
  const give = (key) => {
    const release = releases.get(key);
    releases.delete(key);
    if (release) release();
  };
  class HeldMap extends Map {
    set(key, value) { take(key); return super.set(key, value); }
    delete(key) { const out = super.delete(key); if (out) give(key); return out; }
    clear() { for (const key of [...releases.keys()]) give(key); super.clear(); }
  }
  return new HeldMap();
}

function heldSet(kind, refFor = (key) => key) {
  checkKind(kind);
  const releases = new Map();
  class HeldSet extends Set {
    add(key) {
      if (!releases.has(key)) {
        try { releases.set(key, hold(kind, refFor(key))); } catch { /* no ref: nothing to hold */ }
      }
      return super.add(key);
    }
    delete(key) {
      const out = super.delete(key);
      if (out) { const release = releases.get(key); releases.delete(key); if (release) release(); }
      return out;
    }
    clear() { for (const release of releases.values()) release(); releases.clear(); super.clear(); }
  }
  return new HeldSet();
}

/** Whether this process holds `kind` for `ref`. */
function heldHere(kind, ref) {
  return local.has(keyOf(kind, refOf(ref)));
}

/** How many things this process holds now: what its drain waits for. */
function localCount() {
  let n = 0;
  for (const count of local.values()) n += count > 0 ? 1 : 0;
  return n;
}

/** What this process holds, by kind: [{ kind, ref }], for the drain's log. */
function localSnapshot(limit = 50) {
  return [...local.keys()].map(splitKey).slice(0, limit);
}

// The row, written again with every beat: a row the process-reap clock
// reaped while this process was stalled comes back.
function writeRow(db) {
  return q(db,
    `INSERT INTO platform_processes (id, release, role, host, ip, state, drain_started_at, drain_deadline_at, above_drain)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET heartbeat_at = NOW(), state = EXCLUDED.state,
       drain_started_at = EXCLUDED.drain_started_at, drain_deadline_at = EXCLUDED.drain_deadline_at,
       above_drain = EXCLUDED.above_drain`,
    [ID, process.env.GIT_SHA || null, role, os.hostname(), process.env.POD_IP || null,
      draining ? 'draining' : 'serving', draining?.since || null, draining?.deadline || null, aboveDrain]);
}

async function beat() {
  if (!started || !pool) return;
  await writeRow(pool);
  await writeHolds();
}

function every(ms, fn, label) {
  const timer = setInterval(() => {
    fn().catch((err) => log.warn('processes', `${label} failed`, { err: err.message }));
  }, ms);
  timer.unref?.();
  return timer;
}

/**
 * Register this process and start beating. `role` is what it runs
 * (services/process-role.js: 'all', 'web' or 'conductor'). Resolves once the
 * first beat is done; a database that will not take it is logged and
 * retried by the timer, never thrown.
 */
async function start({ pool: db, role: r = 'all' } = {}) {
  if (started) return;
  pool = db;
  role = r;
  // In a Kubernetes Pod the host is the Pod's name, and a Pod runs one
  // platform process: a row of the same host is this container's
  // predecessor, which died (an OOM kill, a failed liveness probe) and must
  // not be read as live for LIVE_SECONDS after its last beat. Elsewhere one machine may run several (tests, local development).
  if (process.env.KUBERNETES_SERVICE_HOST) {
    try {
      const { rowCount } = await q(pool, 'DELETE FROM platform_processes WHERE host = $1 AND id <> $2', [os.hostname(), ID]);
      if (rowCount) log.info('processes', 'Removed the row of this Pod\'s previous process', { count: rowCount });
    } catch (err) {
      log.warn('processes', 'Could not remove this Pod\'s previous process', { err: err.message });
    }
  }
  try { await writeRow(pool); } catch (err) {
    log.warn('processes', 'Could not register this process yet; the beat will', { err: err.message });
  }
  started = true;
  // Holds taken before it started.
  if (local.size) writeHolds();
  heartbeatTimer = every(HEARTBEAT_MS, beat, 'Process heartbeat');
  log.info('processes', 'Process registered', { id: ID, role });
}

/** Shutdown has begun: refuse new work, finish this, by `deadline`. */
async function markDraining(deadline) {
  draining = { since: new Date(), deadline: deadline ? new Date(deadline) : null };
  aboveDrain = 1;
  if (!started || !pool) return;
  await q(pool,
    `UPDATE platform_processes SET state = 'draining', drain_started_at = $2, drain_deadline_at = $3,
            above_drain = $4, heartbeat_at = NOW() WHERE id = $1`, [ID, draining.since, draining.deadline, aboveDrain]);
}

/**
 * How many newer releases have processes that could replace this one
 * (process-role.js successorRoles) draining, begun after this one began:
 * releases faster than work finishes. The drain ends early when there are
 * too many, rather than keep one Pod per release. Counted by release, not by
 * process: one release replaces every replica of the conductor, and a
 * fellow replica of this process's own release draining beside it is not a
 * newer release (a process with no release recorded counts as one of its own).
 */
async function newerDraining() {
  if (!started || !pool || !draining) return 0;
  const { rows: [row] } = await q(pool,
    `SELECT count(DISTINCT COALESCE(release, id))::int AS n FROM platform_processes
      WHERE id <> $1 AND role = ANY($2::text[]) AND state = 'draining' AND drain_started_at > $3
        AND heartbeat_at > NOW() - make_interval(secs => $4)
        AND (release IS NULL OR $5::text IS NULL OR release <> $5)`,
    [ID, successorRoles(role), draining.since, LIVE_SECONDS, process.env.GIT_SHA || null]);
  return row?.n || 0;
}

/**
 * How many live processes that could replace this one (process-role.js
 * successorRoles: a conductor for a conductor, a web process for a web one,
 * an 'all' for either) started after it and are serving (not draining): a
 * successor, beside which this process may finish its work. A process of a
 * release from before the roster writes no row: it is never counted, and a
 * process it replaces keeps the cutover it always had. Neither is one older
 * than this one, nor one stopping with it (docs/plans/draining-releases.md).
 */
async function servingOthers() {
  if (!started || !pool) return 0;
  const { rows: [row] } = await q(pool,
    `SELECT count(*)::int AS n FROM platform_processes p
      WHERE p.id <> $1 AND p.role = ANY($2::text[]) AND p.state = 'serving'
        AND p.heartbeat_at > NOW() - make_interval(secs => $3)
        AND p.started_at > COALESCE((SELECT started_at FROM platform_processes WHERE id = $1), '-infinity'::timestamptz)`,
    [ID, successorRoles(role), LIVE_SECONDS]);
  return row?.n || 0;
}

/**
 * How many live processes that could replace this one started after its
 * drain began, in any state: the next Pod of a rollout. The connection
 * budget counts a draining process at its drain sizes, so one that still
 * holds more (connections checked out when it shrank) hands its work over
 * when another starts (server.js drainUntilIdle): no two processes of a
 * role are above their drain sizes beside the serving ones.
 */
async function startedSinceDrain() {
  if (!started || !pool || !draining) return 0;
  const { rows: [row] } = await q(pool,
    `SELECT count(*)::int AS n FROM platform_processes
      WHERE id <> $1 AND role = ANY($2::text[]) AND started_at > $3
        AND heartbeat_at > NOW() - make_interval(secs => $4)`,
    [ID, successorRoles(role), draining.since, LIVE_SECONDS]);
  return row?.n || 0;
}

/**
 * A draining process says how many connections it still holds above its
 * drain sizes (server.js drainUntilIdle), at once when that changes.
 */
async function setAboveDrain(n) {
  const value = Math.max(0, Math.floor(Number(n) || 0));
  if (!draining || value === aboveDrain) return;
  aboveDrain = value;
  if (!started || !pool) return;
  await q(pool, 'UPDATE platform_processes SET above_drain = $2 WHERE id = $1', [ID, value]);
}

// The roles a process of `r` replaces (successorRoles read the other way).
function replacedRoles(r) {
  return ['all', 'web', 'conductor'].filter((x) => successorRoles(x).includes(r));
}

/**
 * Admission for the connection budget (item 4). The chart counts a draining
 * process at its drain sizes and a rollout's next Pod at its full ones. A
 * draining process can still hold more (the connections checked out when it
 * shrank): it hands its work over once a process of its role starts
 * (startedSinceDrain), and this process, starting, does not start its work
 * until every older one it replaces holds nothing above them, or is gone. It
 * waits on its lock connection (q), holding no pool. A roster it cannot read
 * is logged and does not keep it from starting.
 */
async function waitForRoom({ pollMs = 1000, reportEveryMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!started || !pool) return { waitedMs: 0 };
  const began = Date.now();
  let reported = began;
  for (;;) {
    let above;
    try {
      ({ rows: [above] } = await q(pool,
        `SELECT count(*)::int AS processes, COALESCE(sum(above_drain), 0)::int AS connections FROM platform_processes p
          WHERE p.id <> $1 AND p.role = ANY($2::text[]) AND p.state = 'draining' AND p.above_drain > 0
            AND p.heartbeat_at > NOW() - make_interval(secs => $3)
            AND p.started_at < COALESCE((SELECT started_at FROM platform_processes WHERE id = $1), 'infinity'::timestamptz)`,
        [ID, replacedRoles(role), LIVE_SECONDS]));
    } catch (err) {
      log.warn('processes', 'Could not read whether older processes still hold connections; starting', { err: err.message });
      return { waitedMs: Date.now() - began };
    }
    if (!above || above.processes === 0) return { waitedMs: Date.now() - began };
    if (Date.now() - reported >= reportEveryMs) {
      reported = Date.now();
      log.info('processes', 'Waiting for older processes to give back connections above their drain sizes', above);
    }
    await sleep(pollMs);
  }
}

/** The process-reap clock: delete the rows of processes long gone. */
async function reap(db = pool) {
  if (!db) return 0;
  const { rowCount } = await db.query(
    'DELETE FROM platform_processes WHERE heartbeat_at < NOW() - make_interval(secs => $1)', [REAP_AFTER_SECONDS]);
  return rowCount || 0;
}

/** Live processes, for the admin console and the logs. */
async function list(db = pool) {
  if (!db) return [];
  const { rows } = await db.query(
    `SELECT p.id, p.release, p.role, p.host, p.state, p.started_at, p.heartbeat_at,
            p.drain_started_at, p.drain_deadline_at
       FROM platform_processes p
      WHERE p.heartbeat_at > NOW() - make_interval(secs => $1)
      ORDER BY p.started_at`, [LIVE_SECONDS]);
  return rows;
}

/**
 * The last step before exit: this process's row goes, so it is not counted
 * as live after it, and its holds' rows with it (ON DELETE CASCADE). Bounded
 * by the caller.
 */
async function stop() {
  if (!started) return;
  started = false;
  clearInterval(heartbeatTimer); heartbeatTimer = null;
  const db = pool;
  if (db) await q(db, 'DELETE FROM platform_processes WHERE id = $1', [ID]).catch((err) => {
    log.warn('processes', 'Could not remove this process\'s row; it lapses on its own', { err: err.message });
  });
}

/** Tests: forget everything, as a fresh process would know it. */
function _reset() {
  clearInterval(heartbeatTimer); heartbeatTimer = null;
  started = false;
  pool = null;
  role = 'all';
  draining = null;
  aboveDrain = 0;
  local.clear();
  writes = Promise.resolve();
  writeQueued = false;
}

module.exports = {
  ID,
  KINDS,
  HEARTBEAT_MS,
  LIVE_SECONDS,
  REAP_AFTER_SECONDS,
  hold,
  heldMap,
  heldSet,
  heldHere,
  localCount,
  localSnapshot,
  start,
  markDraining,
  newerDraining,
  startedSinceDrain,
  setAboveDrain,
  waitForRoom,
  servingOthers,
  reap,
  list,
  stop,
  beat,
  writeHolds,
  get role() { return role; },
  get draining() { return draining; },
  get started() { return started; },
  _reset,
};
