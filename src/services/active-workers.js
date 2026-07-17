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
const activeWorkers = new Set();

function getActiveWorkerCount() {
  return activeWorkers.size;
}

// Shared "any part of a turn is running" predicate — the same one the
// /api/sessions/:id/status endpoint and the session-list routes use.
// `activeWorkers` covers the chat handler's full window (added before
// ensureWorker, deleted in run(Scout|ClaudeCode)Tool's finally — i.e.
// including the post-exec PR/staging tail) plus the restart-recovery
// flows; `worker.isInFlight` covers the inner docker-exec window. The
// auto-pause / staging-GC sweepers in server.js MUST use this instead
// of the bare isInFlight, or they can tear a session down mid-wrap-up
// (the sessions 2391/2386 incident).
function isSessionBusy(sessionId) {
  // Lazy require: worker.js is pulled in by the route layer that also
  // requires this module — a top-level require here would be a cycle.
  const worker = require('./worker');
  return activeWorkers.has(sessionId) || worker.isInFlight(sessionId);
}

module.exports = { activeWorkers, getActiveWorkerCount, isSessionBusy };
