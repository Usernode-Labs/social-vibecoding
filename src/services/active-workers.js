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

module.exports = { activeWorkers, getActiveWorkerCount };
