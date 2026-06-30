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
const events = require('./events');
const { activeWorkers } = require('./active-workers');

// Translate the worker's terse "[sync_*]" phase markers into the
// human-readable lines that stream into the timeline's collapsible
// progress log (mirroring how a build turn narrates its work). Anything
// not in the map (other worker chatter forwarded by parseLine) is
// passed through verbatim so nothing is silently dropped.
const SYNC_PROGRESS_LABELS = {
  sync_fetch_main: 'Fetching main…',
  sync_merge: 'Merging origin/main…',
  sync_conflict_cc: 'Resolving conflicts with Claude…',
  sync_push: 'Pushing…',
};

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

// #361: persist the derived merge-conflict snapshot used by proposal
// cards (merge_conflict_state + conflict_files + conflict_checked_at).
// state ∈ clean | behind | conflict | resolving | failed. Best-effort —
// a failed write just leaves the prior snapshot in place; the next
// drift/sync refreshes it. Broadcasts nothing itself; callers (the
// conflict-resolver lifecycle, the /promoted refetch on vote_update)
// own the live update.
async function persistConflictState(pool, session, { state, files }) {
  try {
    await pool.query(
      `UPDATE chat_sessions
         SET merge_conflict_state = $1,
             conflict_files = $2::jsonb,
             conflict_checked_at = NOW()
       WHERE id = $3`,
      [state || null, JSON.stringify(Array.isArray(files) ? files : []), session.id]
    );
  } catch (err) {
    log.warn('sync-main', 'persistConflictState failed', { sessionId: session?.id, err: err.message });
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

async function runSyncMainInner(config, pool, sessionId, { sessionRow, trigger, debugRunId } = {}, entry) {
  // Admin /debug: when the conflict-resolver passes its run id, narrate each
  // worker sync phase + the outcome into that run. Fire-and-forget; a null
  // runId (manual sync / resume auto-sync) makes every call a no-op.
  const md = require('./merge-debug');
  const dstep = (o) => md.step(pool, debugRunId, o);
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

  // --- Session-native activity primitives -----------------------------
  // Mirror runHeadlessSession's send/sendStatus so a sync turn emits the
  // SAME artifacts a build turn does: live session_event broadcasts plus
  // persisted chat_session_messages rows. The banner broadcasts above are
  // kept as-is and are complementary — this is purely additive.
  const seqPrefix = `s${Date.now().toString(36)}`;
  let eventSeq = 0;
  const send = (type, data) => {
    try {
      const { broadcastGlobal } = require('./ws');
      const sessionBus = require('./session-bus');
      const event = { type, _seq: `${seqPrefix}-${++eventSeq}`, ...data };
      broadcastGlobal({ type: 'session_event', sessionId: session.id, event: type, ...event });
      sessionBus.publish(session.id, event);
    } catch (_) { /* ws/bus failures are non-fatal */ }
  };
  const sendStatus = async (text, metadata) => {
    send('status', { text, ...(metadata || {}) });
    try {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [session.id, text, JSON.stringify(metadata || {})]
      );
    } catch (_) { /* persistence failure is non-fatal */ }
  };

  // Confirmed decision: gate the visible activity on a non-zero `behind`
  // pre-check. Auto/silent syncs (/resume auto-sync, conflict-resolver)
  // run through here too; when nothing is behind, the worker
  // short-circuits to already_synced and we must NOT leave a noisy
  // self-resolving "Syncing with main…" entry in the timeline. The banner
  // broadcasts still fire regardless. `behind_main` is the last persisted
  // drift count (the same value the banner reads).
  const behindPrecheck = Number(session.behind_main) || 0;
  const emitActivity = behindPrecheck > 0;

  // The collapsible progress row is created lazily on the first progress
  // line so an already-synced run that never streams a marker leaves no
  // orphan row behind. Captured id is reused for every subsequent append.
  let progressMsgId = null;
  const appendProgress = async (text) => {
    if (!emitActivity) return;
    send('cc_progress', { text });
    try {
      if (progressMsgId == null) {
        const { rows } = await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', 'Claude Code progress', $2) RETURNING id`,
          [session.id, JSON.stringify({ progressLog: [] })]
        );
        progressMsgId = rows[0].id;
      }
      await pool.query(
        `UPDATE chat_session_messages SET metadata = jsonb_set(
          metadata, '{progressLog}',
          (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
        ) WHERE id = $2`,
        [JSON.stringify([text]), progressMsgId]
      );
    } catch (_) { /* progress persistence is best-effort */ }
  };

  // The opening "action enqueued" entry — only when there's a real merge
  // to do (see emitActivity above).
  if (emitActivity) {
    await sendStatus('Syncing with main…');
  }

  // Forward the worker's "[sync_*]" phase lines into the registry +
  // a sync_status broadcast (the banner). Everything before the first
  // marker (image build, ensureWorker bootstrap) stays 'starting'.
  // Additively, translate each marker into a human progress line that
  // streams into the collapsible log so the timeline narrates the sync.
  const onProgress = (line) => {
    if (typeof line !== 'string') return;
    const pm = line.match(/^\[(sync_[a-z_]+)\]$/);
    if (!pm) return;
    const label = SYNC_PROGRESS_LABELS[pm[1]];
    if (label) {
      appendProgress(label);
      dstep({ phase: `sync:${pm[1]}`, message: `Worker sync: ${label}` });
    }
    const phase = SYNC_PHASE_MAP[pm[1]];
    if (!phase || entry.phase === phase) return;
    entry.phase = phase;
    broadcastSyncStatus(session, phase);
  };

  try {
    // #361: merge-conflict / sync turns are platform housekeeping, not
    // work the owner asked for, so they draw from the dedicated
    // "system tokens" budget rather than any individual's allowance.
    // Gate on the system cap up front; when it's exhausted, throw — the
    // route 500s with the message and the conflict-resolver group-chats
    // it (it also pre-checks the same gate before calling us). Always run
    // with the platform key (anthropicApiKey: null → proxy path); system
    // work must never touch a user's BYOK key.
    const sysBudget = await limits.checkSystemBudget(pool);
    if (sysBudget.error) throw new Error(sysBudget.error);
    const userApiKey = null;

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

    // #361: record the turn's cost against the system-token budget. Same
    // costUsd→cents conversion build turns use. Closes the long-standing
    // gap where conflict turns were enforced live but never persisted to
    // any ledger.
    await limits.recordSystemSpend(pool, Math.round((result.costUsd || 0) * 100));

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

    // #361: persist the derived merge-conflict snapshot for proposal
    // cards. An unresolved conflict leaves the branch broken → 'failed'
    // (record which files conflicted, from the worker's CONFLICT_FILES);
    // every other outcome (clean / resolved / already_synced) means the
    // branch now merges → 'clean' with an empty file list.
    if (syncResult === 'conflict') {
      await persistConflictState(pool, session, { state: 'failed', files: result.conflictFiles || [] });
      dstep({ phase: 'sync_result', level: 'error', message: 'Worker sync: Claude could not resolve the conflicts.', detail: { syncResult, conflictFiles: result.conflictFiles || [], costUsd: result.costUsd || 0 } });
    } else {
      await persistConflictState(pool, session, { state: 'clean', files: [] });
      dstep({ phase: 'sync_result', message: `Worker sync ${syncResult}${result.sha ? ` — pushed ${String(result.sha).slice(0, 9)}` : ''}.`, detail: { syncResult, sha: result.sha || null, behind: result.behind || 0, conflictFiles: result.conflictFiles || [], costUsd: result.costUsd || 0 } });
    }

    // Close the activity with a terminal status. Routing through
    // sendStatus both persists the breadcrumb row (so it survives reload)
    // AND broadcasts a live status event (so open viewers see the outcome
    // without re-fetching). The metadata carries the syncMain summary the
    // timeline keys on. Only emitted when we opened an activity entry (a
    // real merge); a behind==0 short-circuit leaves no row, matching the
    // banner-only behaviour callers had before this change.
    const syncMeta = { syncMain: { syncResult, behind: result.behind || 0, sha: result.sha || null, pushOk: !!result.pushOk } };
    if (emitActivity) {
      await sendStatus(message, syncMeta);
    }

    // Analytics: record the sync outcome on the terminal path. Attributed
    // to session.user_id (the owner) to match the billing decision above —
    // the clicking actor may be a collaborator. Fire-and-forget. Gated the
    // same way as the visible activity so a silent already-synced resume
    // doesn't flood the events table.
    if (emitActivity) {
      events.record(pool, {
        type: events.EVENT_TYPES.SYNC_MAIN,
        userId: session.user_id,
        appId: session.app_id,
        sessionId: session.id,
        metadata: {
          syncResult,
          behind: result.behind || 0,
          sha: result.sha || null,
          pushOk: !!result.pushOk,
          trigger: trigger || 'manual',
        },
      });
    }

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
      conflictFiles: result.conflictFiles || [],
      message,
    };
  } catch (err) {
    // Thrown infrastructure/budget errors are terminal too — close the
    // activity entry (if we opened one) and tell the banner before
    // rethrowing to the caller.
    if (emitActivity) {
      await sendStatus(
        `Sync with main failed: ${err.message}`,
        { syncMain: { syncResult: 'error', behind: behindPrecheck, sha: null, pushOk: false } }
      ).catch(() => {});
    }
    broadcastSyncStatus(session, 'failed', { message: err.message });
    throw err;
  }
}

module.exports = { runSyncMain, persistBehindMain, persistConflictState, getSyncState };
