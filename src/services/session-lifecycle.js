'use strict';

// Shared session lifecycle transitions, callable from both HTTP route
// handlers (manual pause/resume) and the background sweeper (auto-pause).
//
// Why a service instead of inline route logic: the auto-pause sweeper in
// server.js needs to run the exact same teardown the manual POST /pause
// endpoint does (status flip + staging teardown + worker destroy + WS
// notify), and we don't want two copies drifting apart. Resume's LRU
// logic in routes/sessions.js also leans on pauseSession here.

const log = require('./logger');
const staging = require('./staging');
const worker = require('./worker');
const workerProgress = require('./worker-progress');

// Transition a session 'active'|'promoted' -> 'paused'. Reversible: keeps
// the CC volume, branch, and PR so /resume restores cleanly. Mirrors the
// historical POST /pause handler body, minus the HTTP-only concerns
// (auth scoping, already-paused soft-200, the in-flight activeWorkers
// set that lives in routes/sessions.js).
//
// Callers that pause a session which might have a CC turn in flight (the
// manual endpoint, where the user may pause to abort) handle the
// activeWorkers bookkeeping themselves before calling this. The sweeper
// only ever calls this for sessions that are NOT in flight, so there's
// nothing to clear there.
//
// Params:
//   pool      - pg pool
//   sessionId - numeric session id
//   userId    - optional; when set, scopes the status flip to that owner
//               (authz for the manual endpoint). Omit for system actions.
//   reason    - free-form string for logs ('manual' | 'auto-idle' | 'lru')
//
// Returns { paused: boolean, appSlug?: string }. paused=false means the
// row wasn't in a pausable state (already paused/archived/merged, or not
// owned by userId) and nothing was torn down.
async function pauseSession({ pool, sessionId, userId = null, reason = 'manual' }) {
  const params = [sessionId];
  let ownerClause = '';
  if (userId != null) {
    params.push(userId);
    ownerClause = ' AND user_id = $2';
  }

  const { rows } = await pool.query(
    `UPDATE chat_sessions SET status = 'paused'
     WHERE id = $1${ownerClause} AND status IN ('active', 'promoted')
     RETURNING id`,
    params
  );
  if (!rows.length) return { paused: false };

  const { rows: sessionRows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = sessionRows[0];
  const appSlug = session?.app_slug;

  if (session?.staging_container_id) {
    await staging.teardownStaging(session, { slug: appSlug }).catch(() => {});
  }

  // Clear any lingering progress + tear down the worker container. Both
  // are no-ops if there's nothing there (the common auto-pause case:
  // worker was already idle-evicted minutes ago).
  workerProgress.clear(sessionId);
  await worker.destroyWorker(worker.workerContainerName(sessionId)).catch(() => {});

  const { pushSessionUpdate } = require('./ws');
  pushSessionUpdate({ action: 'paused', sessionId, appSlug });
  log.info('session-lifecycle', 'Session paused', { sessionId, reason });

  return { paused: true, appSlug };
}

module.exports = { pauseSession };
