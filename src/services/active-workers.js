'use strict';

// Shared in-flight worker registry.
//
// This Set tracks sessions whose Claude Code worker is mid-exec right
// now. It used to live as a module-local `const activeWorkers = new Set()`
// inside routes/sessions.js, but the sync-main flow (now extracted into
// services/sync-main.js so the proposal machine's sync can drive it without a
// route-requires-route cycle) also needs to add/remove from the same
// registry. Hoisting it into this tiny shared module keeps a single
// process-wide instance that both the route handlers and the service
// share — server.js's graceful-shutdown drain (getActiveWorkerCount)
// reads the same Set the chat handler and sync turns write to.
// #1038: every mutation of this Set is a turn-boundary that some client
// surface wants to know about (the header cog, the Dev board's session
// cards). There are ~15 direct `.add()` / `.delete()` call sites across
// routes/sessions.js and services/sync-main.js, so rather than sprinkle a
// broadcast at each one — and miss the next one somebody adds — the Set
// itself notifies. `session-state` coalesces and only publishes when the
// derived state actually changed, so the add()/inFlight pair at a turn's
// start is still one event. Lazy require: session-state pulls this module
// back in for isSessionBusy.
function notifySessionState(sessionId) {
  try {
    require('./session-state').touch(sessionId);
  } catch { /* notifier is best-effort; never break turn bookkeeping */ }
}

// ── The durable record ──────────────────────────────────────────────────
//
// What this module keeps in memory is seen only by this process. Each
// operation and each worker's turn is also recorded on the session's
// preview instance (src/workflow/preview/: OperationStarted, then
// OperationEnded), naming this process, and counted while this process is
// alive (services/process-presence.js). That is how another process (the
// workflow's carry search for a merge, and the machine's own retirement
// guard) sees who is working on a session. Readers in this process keep
// reading memory, as before. A start is recorded before the work goes on;
// an end is recorded after it, in order. Recording never fails the work: a
// record that cannot be written is logged and the work proceeds. Without a
// workflow runtime (a script, a test) nothing is recorded.
const recorded = new Map(); // sessionId -> Map<recordId, Promise<boolean>> (this process's open records)

function previews() {
  try {
    const platform = require('../workflow/platform.ts');
    return platform.previewsEnabled() ? platform : null;
  } catch {
    return null;
  }
}

// Resolves whether an end must be recorded too: once the start may have
// been appended (even if waiting for it failed), its end is, so a record
// never outlives the work while this process lives.
async function recordStart(sessionId, id, kind) {
  const platform = previews();
  if (!platform) return false;
  const presence = require('./process-presence');
  try {
    await presence.ensure({ databaseUrl: require('../db/pool').getPool({}).options.connectionString });
  } catch (err) {
    require('./logger').warn('active-workers', 'Could not record work on a session; this process alone sees it', {
      sessionId, kind, err: err.message,
    });
    return false;
  }
  presence.hold();
  try {
    await platform.operationStarted({ sessionId, id, kind, holder: presence.holder() });
  } catch (err) {
    require('./logger').warn('active-workers', 'Recording work on a session did not answer; its end is recorded anyway', {
      sessionId, kind, err: err.message,
    });
  }
  return true;
}

function recordEnd(sessionId, id, started) {
  Promise.resolve(started).then((ok) => {
    if (!ok) return undefined;
    const platform = previews();
    const ended = platform ? platform.operationEnded({ sessionId, id }) : Promise.resolve();
    return ended.finally(() => require('./process-presence').release());
  }).catch((err) => {
    require('./logger').warn('active-workers', 'Could not record the end of work on a session; it ends with this process', {
      sessionId, err: err.message,
    });
  });
}

function open(sessionId, id, kind) {
  const started = recordStart(sessionId, id, kind);
  if (!recorded.has(sessionId)) recorded.set(sessionId, new Map());
  recorded.get(sessionId).set(id, started);
  return started;
}

function close(sessionId, id) {
  const records = recorded.get(sessionId);
  const started = records?.get(id);
  if (!records || !started) return;
  records.delete(id);
  if (!records.size) recorded.delete(sessionId);
  recordEnd(sessionId, id, started);
}

// The record of the worker's current turn on a session: a new one per
// turn, so a later turn is recorded as its own (a record's request keys are
// kept for the instance's life).
const workerRecords = new Map(); // sessionId -> record id


// docs/plans/draining-releases.md: what this process is doing on a session is
// also its HOLD (services/processes.js), so another process (one finishing
// its work after a release, or the one that replaced it) sees the session
// busy and neither adopts, pauses nor tears it down under it.
function processes() {
  return require('./processes');
}

class ActiveWorkerSet extends Set {
  constructor() {
    super();
    this._holds = new Map(); // sessionId -> release
  }

  add(sessionId) {
    const had = this.has(sessionId);
    const out = super.add(sessionId);
    if (!had) {
      try { this._holds.set(sessionId, processes().hold('session', sessionId)); } catch { /* a ref-less id holds nothing */ }
      notifySessionState(sessionId);
      const id = `worker:${require('crypto').randomUUID()}`;
      workerRecords.set(Number(sessionId), id);
      open(Number(sessionId), id, 'turn');
    }
    return out;
  }

  // add(), and wait until the record another process reads is written.
  async enter(sessionId) {
    this.add(sessionId);
    await recorded.get(Number(sessionId))?.get(workerRecords.get(Number(sessionId)));
  }

  generation(sessionId) {
    return this.has(sessionId) ? workerRecords.get(Number(sessionId)) || null : null;
  }

  deleteIf(sessionId, generation) {
    return generation != null && this.generation(sessionId) === generation ? this.delete(sessionId) : false;
  }

  delete(sessionId) {
    const out = super.delete(sessionId);
    if (out) {
      const release = this._holds.get(sessionId);
      this._holds.delete(sessionId);
      if (release) release();
      notifySessionState(sessionId);
      const id = workerRecords.get(Number(sessionId));
      workerRecords.delete(Number(sessionId));
      if (id) close(Number(sessionId), id);
    }
    return out;
  }

  clear() {
    for (const release of this._holds.values()) release();
    this._holds.clear();
    super.clear();
  }
}

const activeWorkers = new ActiveWorkerSet();
const activeSessionOperations = new Map();

// Register non-worker operations that must not overlap a coding turn (for
// example, adopting and checking an exact commit submitted by a local agent).
// Reference counts make independent callers safe, and the returned release
// closure is idempotent so every owner can clean up in a finally block.
// This process sees the operation at once; `release.recorded` resolves once
// it is recorded where another process sees it too (above), and a caller
// that can wait awaits it before its work goes on.
function beginSessionOperation(sessionId, kind = 'operation') {
  const key = Number(sessionId);
  const prior = activeSessionOperations.get(key) || 0;
  activeSessionOperations.set(key, prior + 1);
  let releaseHold = null;
  try { releaseHold = processes().hold('session', key); } catch { /* a ref-less id holds nothing */ }
  // Only the 0→1 edge changes the session's observable busy state; nested
  // operations on an already-busy session are invisible to clients.
  if (prior === 0) notifySessionState(key);
  const id = `op:${require('crypto').randomUUID()}`;
  const started = open(key, id, kind);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    close(key, id);
    if (releaseHold) releaseHold();
    const remaining = (activeSessionOperations.get(key) || 1) - 1;
    if (remaining > 0) activeSessionOperations.set(key, remaining);
    else {
      activeSessionOperations.delete(key);
      notifySessionState(key);
    }
  };
  release.recorded = started.then(() => undefined);
  // The record's id: a decision this operation asks for while it holds it
  // (a hand-off's promote) names it, so the operation does not count as
  // somebody else working on the session (src/workflow/session-work.ts).
  release.id = id;
  return release;
}

function hasSessionOperation(sessionId) {
  return activeSessionOperations.has(Number(sessionId));
}

function getActiveWorkerCount() {
  return new Set([...activeWorkers, ...activeSessionOperations.keys()]).size;
}

// Shared "any part of a turn is running in this process" predicate.
// `activeWorkers` covers the chat handler's full window (added before
// ensureWorker, deleted in run(Scout|ClaudeCode)Tool's finally — i.e.
// including the post-exec PR/staging tail) plus the recovery flows;
// `worker.isInFlight` covers the inner docker-exec window (the sessions
// 2391/2386 incident). What another process runs is answered from the
// database, not from this process's memory: isSessionBusyAnywhere.
function isSessionBusy(sessionId) {
  if (hasSessionOperation(sessionId)) return true;
  // Lazy require: worker.js is pulled in by the route layer that also
  // requires this module — a top-level require here would be a cycle.
  const worker = require('./worker');
  return activeWorkers.has(sessionId) || worker.isInFlight(sessionId);
}

// This process's holder, as its recorded operations name it: what it
// answers from memory (its operations end here before their OperationEnded
// reaches the preview machine).
function ownHolder() {
  try { return require('./process-presence').holder(); } catch { return null; }
}

// The same, for the platform's every process: this one's memory, then what
// the database says works on the session (src/workflow/session-work.ts
// workedOnSql: a turn's record, a turn its machine runs, a local agent's
// turn, a shots run, a durable build, a sync, a recorded operation). For a
// decision about a session another process may be working on. A database
// that cannot answer leaves this process's own answer, as a reader that
// cannot see another process never calls it busy. `exceptTurn`: asked by a
// person's turn about its own change, whose turn machine instance is that
// turn (session-work.ts workedOnSql turns: false).
async function isSessionBusyAnywhere(sessionId, { pool = null, exceptTurn = false } = {}) {
  if (isSessionBusy(sessionId)) return true;
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  try {
    const db = pool || require('../db/pool').getPool();
    const { rows: [r] } = await db.query(
      `SELECT ${require('../workflow/session-work.ts').workedOnSql({ turns: !exceptTurn, exceptHolder: ownHolder() })} AS busy FROM chat_sessions cs WHERE cs.id = $1`, [id]);
    return !!(r && r.busy);
  } catch (err) {
    require('./logger').warn('active-workers', 'Could not read whether a session is worked on elsewhere', { sessionId: id, err: err.message });
    return false;
  }
}

// Of the sessions `ids`, those worked on by any process: this one's memory,
// then one read of the database (as isSessionBusyAnywhere). For a pass over
// many sessions whose pure picker takes a synchronous predicate.
async function busySessionsAnywhere(ids, { pool = null } = {}) {
  const wanted = [...new Set((ids || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const busy = new Set(wanted.filter((id) => isSessionBusy(id)));
  if (!wanted.length) return busy;
  try {
    const db = pool || require('../db/pool').getPool();
    const { rows } = await db.query(
      `SELECT cs.id FROM chat_sessions cs WHERE cs.id = ANY($1::int[]) AND ${require('../workflow/session-work.ts').workedOnSql({ exceptHolder: ownHolder() })}`,
      [wanted]);
    for (const r of rows) busy.add(Number(r.id));
  } catch (err) {
    require('./logger').warn('active-workers', 'Could not read which sessions are worked on elsewhere', { err: err.message });
  }
  return busy;
}

/** Only this process's part: what it runs itself (isSessionBusy). */
const isSessionBusyHere = isSessionBusy;

module.exports = {
  activeWorkers,
  beginSessionOperation,
  hasSessionOperation,
  getActiveWorkerCount,
  isSessionBusy,
  isSessionBusyHere,
  isSessionBusyAnywhere,
  busySessionsAnywhere,
  notifySessionState,
};
