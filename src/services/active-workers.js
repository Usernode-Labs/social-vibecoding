'use strict';

// Shared in-flight worker registry.
//
// This Set tracks sessions whose Claude Code worker is mid-exec right
// now. It used to live as a module-local `const activeWorkers = new Set()`
// inside routes/sessions.js, but the sync-main flow (now extracted into
// services/sync-main.js so the conflict-resolver can drive it without a
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

// docs/plans/draining-releases.md: what this process is doing on a session is
// also its HOLD (services/processes.js), so another process (one finishing
// its work after a release, or the one that replaced it) sees the session
// busy and neither adopts, pauses nor tears it down under it.
function processes() {
  return require('./processes');
}

// With the preview machine on, the work waits until its hold is written
// before it goes on: a decision in another process reads who works on a
// session from these holds (the preview machine's retirement guard, the
// workflow's carry search for a merge: src/workflow/session-work.ts
// sessionHeldSql), and must not miss work that has already begun. Off, as
// [main]: the hold is written behind the work. Never fails the work: a write
// that does not go through is retried, then left to the next beat.
function written(release) {
  if (!release?.written) return Promise.resolve();
  try {
    if (!require('../workflow/platform.ts').previewsEnabled()) return Promise.resolve();
  } catch { return Promise.resolve(); }
  return release.written;
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
    }
    return out;
  }

  // add(), and wait until the hold another process reads is written.
  async enter(sessionId) {
    this.add(sessionId);
    await written(this._holds.get(sessionId));
  }

  delete(sessionId) {
    const out = super.delete(sessionId);
    if (out) {
      const release = this._holds.get(sessionId);
      this._holds.delete(sessionId);
      if (release) release();
      notifySessionState(sessionId);
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
// its hold is written where another process sees it too (`written` above),
// and a caller that can wait awaits it before its work goes on.
function beginSessionOperation(sessionId) {
  const key = Number(sessionId);
  const prior = activeSessionOperations.get(key) || 0;
  activeSessionOperations.set(key, prior + 1);
  let releaseHold = null;
  try { releaseHold = processes().hold('session', key); } catch { /* a ref-less id holds nothing */ }
  // Only the 0→1 edge changes the session's observable busy state; nested
  // operations on an already-busy session are invisible to clients.
  if (prior === 0) notifySessionState(key);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (releaseHold) releaseHold();
    const remaining = (activeSessionOperations.get(key) || 1) - 1;
    if (remaining > 0) activeSessionOperations.set(key, remaining);
    else {
      activeSessionOperations.delete(key);
      notifySessionState(key);
    }
  };
  release.recorded = written(releaseHold);
  return release;
}

function hasSessionOperation(sessionId) {
  return activeSessionOperations.has(Number(sessionId));
}

function getActiveWorkerCount() {
  return new Set([...activeWorkers, ...activeSessionOperations.keys()]).size;
}

// Shared "any part of a turn is running" predicate — the same one the
// /api/sessions/:id/status endpoint and the session-list routes use. For
// every live platform process: this one's memory, then what the others hold
// (services/processes.js, at most one refresh behind), so a sweeper on the
// new leader never pauses a session a draining process is still finishing.
// `activeWorkers` covers the chat handler's full window (added before
// ensureWorker, deleted in run(Scout|ClaudeCode)Tool's finally — i.e.
// including the post-exec PR/staging tail) plus the restart-recovery
// flows; `worker.isInFlight` covers the inner docker-exec window. The
// auto-pause / staging-GC sweepers in server.js MUST use this instead
// of the bare isInFlight, or they can tear a session down mid-wrap-up
// (the sessions 2391/2386 incident).
function isSessionBusy(sessionId) {
  if (hasSessionOperation(sessionId)) return true;
  // Lazy require: worker.js is pulled in by the route layer that also
  // requires this module — a top-level require here would be a cycle.
  const worker = require('./worker');
  if (activeWorkers.has(sessionId) || worker.isInFlight(sessionId)) return true;
  return isSessionBusyElsewhere(sessionId);
}

/** Whether another live process holds the session (processes.js mirror). */
function isSessionBusyElsewhere(sessionId) {
  if (sessionId === null || sessionId === undefined || sessionId === '') return false;
  try { return processes().heldElsewhere('session', Number(sessionId)); } catch { return false; }
}

/** Only this process's part of isSessionBusy: what it runs itself. */
function isSessionBusyHere(sessionId) {
  if (hasSessionOperation(sessionId)) return true;
  const worker = require('./worker');
  return activeWorkers.has(sessionId) || worker.isInFlight(sessionId);
}

module.exports = {
  activeWorkers,
  beginSessionOperation,
  hasSessionOperation,
  getActiveWorkerCount,
  isSessionBusy,
  isSessionBusyHere,
  isSessionBusyElsewhere,
  notifySessionState,
};
