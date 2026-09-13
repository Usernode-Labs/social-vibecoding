'use strict';

// #2038 — this module is now a forwarding shim. The work moved to
// services/merge-queue.js.
//
// What used to be here: an app-level drain in two phases, a per-session
// resolve-and-retry, and two GitHub polling loops (pollMergeable,
// waitForMergeableTrue) with three tuning env vars and a post-push settling
// delay between them. Together those could spend fourteen reads and about
// thirty seconds asking a lazily-computed `mergeable` field whether a branch
// merges — a question the local mirror now answers exactly, before the call,
// for nothing.
//
// The phase split existed because a blocked proposal's minutes-long sync ran
// inside the single-flight drain and froze clean siblings behind it. In a
// queue a blocked proposal LEAVES the queue, so there is nothing to split.
//
// The names are kept because a dozen call sites import them — routes/votes.js,
// services/visuals.js, services/main-drift-poller.js, server.js and the
// status routes. Nothing here has its own behaviour.

const mergeQueue = require('./merge-queue');

module.exports = {
  checkAndResolveConflicts: mergeQueue.checkAndResolveConflicts,

  // The queue integrates whatever is next for the app rather than a named
  // session, so a per-session request becomes "make progress on this app".
  // The one caller that passed a session id did so to retry a merge it had
  // just tried itself, which the queue does anyway.
  resolveAndMaybeRetry(config, target, options = {}) {
    const appId = target && (target.app_id || target.session?.app_id);
    if (appId != null) return mergeQueue.enqueue(config, appId, options);
    // A bare sessionId: look the app up, then enqueue.
    const { getPool } = require('../db/pool');
    const pool = getPool(config);
    return pool
      .query('SELECT app_id FROM chat_sessions WHERE id = $1', [target && target.sessionId])
      .then(({ rows }) => (rows[0] ? mergeQueue.enqueue(config, rows[0].app_id, options) : null));
  },

  // Read by GET /api/sessions/:id/status and the vote-panel badge.
  isResolving: mergeQueue.isIntegratingSession,
  isAppResolving: mergeQueue.isIntegrating,
};
