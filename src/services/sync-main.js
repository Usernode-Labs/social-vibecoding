'use strict';

// Worker-driven "sync with main" flow.
//
// Extracted from routes/sessions.js so non-route callers (notably
// services/conflict-resolver.js) can drive a MODE=sync worker turn
// without a route-requires-route dependency cycle. The route handlers
// in routes/sessions.js re-export these for backwards compatibility, so
// POST /api/sessions/:id/sync-main and the /resume auto-trigger keep
// calling the same implementation.
const log = require('./logger');
const worker = require('./worker');
const limits = require('./limits');
const { activeWorkers } = require('./active-workers');

// #8: persist the latest behind-origin/main count for a session and
// broadcast a session_update so the dev-chat banner refreshes live.
// No-op (with logging) if the write fails — drift accounting is
// best-effort; the next turn will refresh it.
async function persistBehindMain(pool, session, behind) {
  try {
    const n = Number.isFinite(behind) ? Math.max(0, behind) : 0;
    await pool.query(
      'UPDATE chat_sessions SET behind_main = $1 WHERE id = $2',
      [n, session.id]
    );
    try {
      const { pushSessionUpdate } = require('./ws');
      pushSessionUpdate({
        action: 'behind_main',
        sessionId: session.id,
        appSlug: session.app_slug || null,
        behindMain: n,
      });
    } catch (_) { /* ws failures are non-fatal */ }
  } catch (err) {
    log.warn('sync-main', 'persistBehindMain failed', { sessionId: session?.id, err: err.message });
  }
}

// #252: in-flight sync registry. One entry per session while a
// MODE=sync turn is running, holding the coarse phase the UI banner
// shows. Process-local — same single-Node-process assumption as the
// conflict-resolver's isResolving registry.
//   sessionId(Number) -> { phase, startedAt, promise }
const _inFlightSyncs = new Map();

// Read by GET /api/sessions/:id/status for reload recovery and the
// client's poll fallback. Null when nothing is syncing.
function getSyncState(sessionId) {
  const entry = _inFlightSyncs.get(Number(sessionId));
  return entry ? { phase: entry.phase, startedAt: entry.startedAt } : null;
}

// Map the worker's __USERNODE_PHASE__ markers (forwarded by
// services/worker.js parseLine as "[sync_*]" progress lines) onto the
// coarse phases the banner labels: merging → resolving → pushing.
const SYNC_PHASE_MAP = {
  sync_fetch_main: 'merging',
  sync_merge: 'merging',
  sync_conflict_cc: 'resolving',
  sync_push: 'pushing',
};

// #252: lifecycle broadcast for the dev-chat sync banner. Same
// session_update channel as behind_main; clients key on
// action='sync_status'. state ∈ starting | merging | resolving |
// pushing | done | failed; terminal events carry syncResult/message.
function broadcastSyncStatus(session, state, extra = {}) {
  try {
    const { pushSessionUpdate } = require('./ws');
    pushSessionUpdate({
      action: 'sync_status',
      sessionId: session.id,
      appSlug: session.app_slug || null,
      state,
      ...extra,
    });
  } catch (_) { /* ws failures are non-fatal */ }
}

// #8: dispatch a MODE=sync worker turn for the given session. Used by
// POST /api/sessions/:id/sync-main (explicit user click), the silent
// auto-trigger inside POST /resume, and the auto-conflict-resolver.
// Idempotent / safe to call when nothing's behind (the worker
// short-circuits with sync_result=already_synced).
//
// #252: concurrent calls for one session coalesce onto a single
// in-flight promise (mirroring the conflict-resolver's
// _inFlightResolves), so a user click that races the resume-triggered
// background sync joins the running turn instead of tripping
// execInWorker's "a turn is already in flight" guard.
//
// Returns an object the route can serialise verbatim:
//   { ok: true, syncResult, behind, sha, pushOk, message }
// Throws on infrastructure errors (image build, ensureWorker) — the
// route catches and 500s; background callers catch and warn.
async function runSyncMain(config, pool, sessionId, opts = {}) {
  const key = Number(sessionId);
  const existing = _inFlightSyncs.get(key);
  if (existing) return existing.promise;

  const entry = { phase: 'starting', startedAt: Date.now(), promise: null };
  _inFlightSyncs.set(key, entry);
  entry.promise = runSyncMainInner(config, pool, sessionId, opts, entry)
    .finally(() => {
      if (_inFlightSyncs.get(key) === entry) _inFlightSyncs.delete(key);
    });
  return entry.promise;
}

async function runSyncMainInner(config, pool, sessionId, { sessionRow } = {}, entry) {
  let session = sessionRow;
  if (!session) {
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
       FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
       WHERE cs.id = $1`,
      [sessionId]
    );
    if (!rows.length) throw new Error('Session not found');
    session = rows[0];
  }

  if (!session.repo_url) {
    throw new Error('Session has no repo_url; cannot sync');
  }
  const m = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Unparseable repo_url: ${session.repo_url}`);
  const [, repoOwner, repoName] = m;

  // #252: from here on the session (and its app_slug) is known, so
  // every exit — phase change, done, failed — gets broadcast.
  broadcastSyncStatus(session, 'starting');

  // Forward the worker's "[sync_*]" phase lines into the registry +
  // a sync_status broadcast. Everything before the first marker
  // (image build, ensureWorker bootstrap) stays 'starting'.
  const onProgress = (line) => {
    if (typeof line !== 'string') return;
    const pm = line.match(/^\[(sync_[a-z_]+)\]$/);
    if (!pm) return;
    const phase = SYNC_PHASE_MAP[pm[1]];
    if (!phase || entry.phase === phase) return;
    entry.phase = phase;
    broadcastSyncStatus(session, phase);
  };

  try {
    // Sync turns charge to the session owner — they're the one who
    // benefits from the integration. Limit-first (#212), matching the
    // build-turn flow: the owner's daily allowance while it has headroom
    // (worker bills the platform proxy via WORKER_JWT), then their BYOK
    // key once it's exhausted. Allowance gone and no key → throw; the
    // route 500s with the budget message and the conflict-resolver gates
    // with the same resolver before ever calling us.
    const billing = await limits.resolveBillingPath(pool, config.jwtSecret, session.user_id);
    if (billing.error) throw new Error(billing.error);
    const userApiKey = billing.apiKey;

    await worker.ensureWorkerImage();
    await worker.ensureWorker(session.id, {
      repoOwner,
      repoName,
      branchName: session.branch_name,
      anthropicApiKey: userApiKey || null,
      onProgress,
    });

    activeWorkers.add(session.id);
    let result;
    try {
      result = await worker.execInWorker(session.id, {
        mode: 'sync',
        prompt: '(sync turn — see MODE=sync block in run-cc.sh)',
        // Use a small fast model — the prompt is short and the task is
        // mechanical. The route's caller doesn't get to pick.
        model: 'claude-sonnet-4-6',
        commitMsg: '',
        // Don't pass cc_session_id — we don't want sync turns polluting
        // the session's main CC conversation thread.
        resumeSessionId: null,
        branchName: session.branch_name,
        anthropicApiKey: userApiKey || null,
        onProgress,
      });
    } finally {
      activeWorkers.delete(session.id);
    }

    // Persist the new behind count regardless of outcome (a failed
    // sync still teaches us how stale we are).
    await persistBehindMain(pool, session, result.behind || 0);

    const syncResult = result.syncResult || (result.exitCode === 0 ? 'clean' : 'conflict');
    let message;
    switch (syncResult) {
      case 'already_synced':
        message = 'Already up to date with main — nothing to merge.';
        break;
      case 'clean':
        message = `Merged main cleanly. Pushed ${result.sha ? result.sha.slice(0, 7) : 'merge commit'}.`;
        break;
      case 'resolved':
        message = `Claude resolved merge conflicts with main and pushed ${result.sha ? result.sha.slice(0, 7) : 'the merge commit'}.`;
        break;
      case 'conflict':
      default:
        message = 'Tried to sync with main but Claude couldn\'t resolve the conflicts. The branch is unchanged; try again or resolve locally.';
        break;
    }

    // Drop a system note into the session chat so the user has a
    // breadcrumb on refresh.
    try {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [session.id, message, JSON.stringify({ syncMain: { syncResult, behind: result.behind || 0, sha: result.sha || null } })]
      );
    } catch (_) { /* non-fatal */ }

    // #252: terminal broadcast. 'failed' covers the unresolved-conflict
    // outcome (branch unchanged) so the banner shows the failure +
    // re-enabled Try again; everything else is 'done'.
    broadcastSyncStatus(
      session,
      syncResult === 'conflict' ? 'failed' : 'done',
      { syncResult, message }
    );

    return {
      ok: syncResult !== 'conflict',
      syncResult,
      behind: result.behind || 0,
      sha: result.sha || null,
      pushOk: !!result.pushOk,
      message,
    };
  } catch (err) {
    // Thrown infrastructure/budget errors are terminal too — tell the
    // banner before rethrowing to the caller.
    broadcastSyncStatus(session, 'failed', { message: err.message });
    throw err;
  }
}

module.exports = { runSyncMain, persistBehindMain, getSyncState };
