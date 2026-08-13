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
const { activeWorkers, beginSessionOperation } = require('./active-workers');

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

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

function repoOf(session) {
  const m = (session?.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// #955: durable provenance for a commit the PLATFORM pushed onto a proposal
// branch. Written on EVERY successful sync push — before the review advance is
// even attempted — so a reconciliation that runs after a race, a skipped
// advance, or a process restart can still recognise the commit as ours rather
// than mistaking it for an author push and wiping the tally. Best-effort: a
// failed insert only costs us the safety net, never the sync itself.
async function recordPlatformPush(pool, session, {
  sha, firstParentSha = null, priorReviewedSha = null,
  kind = 'sync_main', syncResult = null,
}) {
  if (!session?.id || typeof sha !== 'string' || !COMMIT_SHA_RE.test(sha)) return false;
  try {
    await pool.query(
      `INSERT INTO session_platform_pushes
         (session_id, sha, first_parent_sha, prior_reviewed_head_sha, kind, sync_result)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, sha) DO UPDATE
          SET first_parent_sha = COALESCE(session_platform_pushes.first_parent_sha,
                                          EXCLUDED.first_parent_sha)`,
      [
        session.id, sha.toLowerCase(),
        firstParentSha ? String(firstParentSha).toLowerCase() : null,
        priorReviewedSha ? String(priorReviewedSha).toLowerCase() : null,
        kind, syncResult,
      ]
    );
    return true;
  } catch (err) {
    log.warn('sync-main', 'recordPlatformPush failed (non-fatal)', {
      sessionId: session.id, sha, err: err.message,
    });
    return false;
  }
}

// Look one platform push up by exact SHA. Used by the reconciler's head-move
// classifier (routes/votes.js) to prove provenance before preserving votes.
async function findPlatformPush(pool, sessionId, sha) {
  if (sessionId == null || typeof sha !== 'string' || !COMMIT_SHA_RE.test(sha)) return null;
  try {
    const { rows } = await pool.query(
      `SELECT sha, first_parent_sha, kind, sync_result
         FROM session_platform_pushes
        WHERE session_id = $1 AND LOWER(sha) = LOWER($2)
        LIMIT 1`,
      [sessionId, sha]
    );
    return rows[0] || null;
  } catch (err) {
    log.warn('sync-main', 'findPlatformPush failed', { sessionId, sha, err: err.message });
    return null;
  }
}

// Fill in a platform push's first parent after the fact (the GitHub read can
// fail at push time). Keeps the chain walk a pure DB read on later passes.
async function backfillPlatformPushParent(pool, sessionId, sha, firstParentSha) {
  if (!firstParentSha) return;
  try {
    await pool.query(
      `UPDATE session_platform_pushes SET first_parent_sha = $3
        WHERE session_id = $1 AND LOWER(sha) = LOWER($2) AND first_parent_sha IS NULL`,
      [sessionId, sha, String(firstParentSha).toLowerCase()]
    );
  } catch (err) {
    log.warn('sync-main', 'backfillPlatformPushParent failed', {
      sessionId, sha, err: err.message,
    });
  }
}

// A main-sync changes the branch commit without changing the proposal patch,
// so the approval it already earned still describes the code under review —
// that is why a sync commit has never reset votes. Since the reviewed revision
// became an exact SHA pin (#872) the platform has to say so explicitly:
// advance the pinned revision to the commit we just pushed and carry the
// matching vote stamps with it, or the very next reconciliation reads OUR
// merge commit as an author push and deletes the tally (#955).
//
// The safety gate is the pushed commit's FIRST parent: it must be the revision
// currently under review. A merge made on top of an author commit nobody
// reviewed fails that test, and we then advance nothing — the ordinary
// author-push reset is the correct outcome there.
//
// Checks policy follows who wrote the tree: a `clean` merge is pure git, so the
// existing verdict carries forward with the stamp; a `resolved` merge contains
// Claude's edits, so the verdict is dropped and an exact-SHA re-check kicked
// (visuals.maybeAutoMergeAfterChecks re-drives the merge when it turns green).
//
// This lives in the service—not the HTTP route—so resume auto-sync and conflict
// resolution get identical semantics while runSyncMain's cross-surface
// operation claim is still held.
async function advanceReviewAfterPlatformSync(pool, session, result, opts = {}) {
  if (!session || session.source === 'imported') return false;
  if (!['clean', 'resolved'].includes(result?.syncResult)
      || !result.pushOk || typeof result.sha !== 'string'
      || !COMMIT_SHA_RE.test(result.sha)) return false;
  const { config = null, dstep = null } = opts;
  const nextSha = result.sha.toLowerCase();
  const priorChecksSha = session.checks_commit_sha || session.handoff_head_sha || null;
  const priorReviewedSha = session.reviewed_head_sha
    ? session.reviewed_head_sha.toLowerCase()
    : null;
  const carryChecks = result.syncResult === 'clean';

  // eslint-disable-next-line global-require
  const github = require('./github');
  const repo = repoOf(session);
  const externalBranch = github.isEnabled() && !!repo;

  // Provenance read + record BEFORE the advance, so the safety net exists even
  // if the advance below is skipped, raced, or interrupted by a restart.
  let firstParent = null;
  let parentsKnown = !externalBranch; // nothing external to verify against
  if (externalBranch) {
    try {
      const parents = await github.getCommitParents(repo.owner, repo.repo, nextSha);
      firstParent = parents[0] || null;
      parentsKnown = true;
    } catch (err) {
      // Fail CLOSED on the carry: without the parents we cannot prove this
      // commit sits on the reviewed revision, and guessing would let an
      // author push inherit an approval.
      log.warn('sync-main', 'Could not read pushed commit parents; skipping vote carry', {
        sessionId: session.id, sha: nextSha, err: err.message,
      });
    }
  }
  await recordPlatformPush(pool, session, {
    sha: nextSha,
    firstParentSha: firstParent,
    priorReviewedSha,
    syncResult: result.syncResult,
  });

  // The gate only bites when there IS a pin to protect and a real branch to
  // verify against:
  //   - no pin yet (legacy row): stamping it here is what binds it, and
  //     pre-#872 semantics counted its unbound votes anyway, so nothing is lost;
  //   - GitHub off / PR-less local session: no external mutable branch exists,
  //     so there is no author push to defend against (reconcileNativeReviewedHead
  //     returns enforced:false in that mode for the same reason);
  //   - otherwise: the pushed commit must sit directly on the reviewed revision,
  //     and an unreadable parent list fails CLOSED (guessing would let an author
  //     push inherit an approval).
  const gatePassed = !priorReviewedSha || !externalBranch
    ? true
    : (parentsKnown && firstParent === priorReviewedSha);
  if (!gatePassed) {
    log.info('sync-main', 'Platform sync did not sit on the reviewed revision; review unchanged', {
      sessionId: session.id, reviewedHead: priorReviewedSha, firstParent, pushed: nextSha,
    });
    if (dstep) {
      await dstep({
        phase: 'platform_advance', level: 'warn',
        message: 'Sync commit does not sit directly on the reviewed revision — votes are not carried.',
        detail: { reviewedHead: priorReviewedSha, firstParent, pushed: nextSha },
      });
    }
    return false;
  }

  const { rows = [] } = await pool.query(
    `WITH advanced AS (
       UPDATE chat_sessions
          SET checks_commit_sha = CASE WHEN $5::boolean THEN $1 ELSE checks_commit_sha END,
              reviewed_head_sha = $1,
              last_activity_at = NOW()
        WHERE id = $2 AND COALESCE(source, '') <> 'imported'
          AND status IN ('active', 'promoted', 'merging')
          AND reviewed_head_sha IS NOT DISTINCT FROM $3::varchar
          AND checks_commit_sha IS NOT DISTINCT FROM $4::varchar
        RETURNING id, reviewed_head_sha, checks_commit_sha
     ), moved_votes AS (
       UPDATE pr_votes SET head_sha = $1
        WHERE session_id IN (SELECT id FROM advanced)
          AND head_sha IS NOT DISTINCT FROM $3::varchar
        RETURNING 1
     )
     SELECT reviewed_head_sha, checks_commit_sha,
            (SELECT COUNT(*)::int FROM moved_votes) AS votes_moved
       FROM advanced`,
    [nextSha, session.id, priorReviewedSha, priorChecksSha, carryChecks]
  );
  if (!rows.length) return false;

  const votesMoved = parseInt(rows[0]?.votes_moved, 10) || 0;
  session.reviewed_head_sha = nextSha;
  if (carryChecks) session.checks_commit_sha = nextSha;

  log.info('sync-main', 'Proposal review advanced after platform sync', {
    sessionId: session.id,
    reviewedFrom: priorReviewedSha,
    checksFrom: priorChecksSha,
    to: nextSha,
    syncResult: result.syncResult,
    votesCarried: votesMoved,
    checksCarried: carryChecks,
  });
  if (dstep) {
    await dstep({
      phase: 'platform_advance',
      message: `Review advanced to the pushed sync commit — ${votesMoved} vote${votesMoved === 1 ? '' : 's'} carried, checks ${carryChecks ? 'carried forward' : 're-running'}.`,
      detail: {
        from: priorReviewedSha, to: nextSha,
        syncResult: result.syncResult, votesCarried: votesMoved,
      },
    });
  }

  // Claude edited this tree — the old green verdict says nothing about it.
  // Drop it and rebuild exactly this SHA; #451's post-checks drain merges the
  // preserved votes the moment it turns green.
  if (!carryChecks) {
    await kickChecksForSyncedHead(config, pool, session, nextSha);
  }

  try {
    const { pushVoteUpdate } = require('./ws');
    pushVoteUpdate({
      sessionId: session.id,
      appSlug: session.app_slug || null,
      merged: false,
      headMoved: true,
      votesKept: true,
    });
  } catch (_) { /* ws failures are non-fatal */ }

  if (votesMoved > 0) {
    const label = session.pr_number
      ? `PR #${session.pr_number}`
      : 'This proposal';
    const how = result.syncResult === 'resolved'
      ? 'was synced with main and its merge conflicts were resolved automatically'
      : 'was synced with main';
    const checksNote = carryChecks
      ? ''
      : ' Its checks are re-running against the new commit and it will merge on its own once they pass.';
    try {
      const { sendSystemMessage } = require('./ws');
      await sendSystemMessage(
        pool, session.app_id,
        `${label} ${how} — existing votes were kept (now pinned to commit ${nextSha.slice(0, 8)}).${checksNote}`,
        'system',
        { headChanged: true, votesKept: true, headSha: nextSha },
        { type: 'session', ref: session.id }
      );
    } catch (err) {
      log.warn('sync-main', 'votes-kept message failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    }
  }
  return true;
}

// Invalidate the stale verdict and rebuild staging pinned to the exact commit
// the sync pushed. Mirrors routes/votes.js kickNativeRevisionChecks; kept here
// so the sync path owns it now that the reconciler no longer sees a head move.
async function kickChecksForSyncedHead(config, pool, session, headSha) {
  const visuals = require('./visuals');
  await visuals.setChecksPending(pool, session.id, headSha, 'building', 'sync-main')
    .catch((err) => log.warn('sync-main', 'setChecksPending failed (non-fatal)', {
      sessionId: session.id, headSha, err: err.message,
    }));
  try { visuals.notifyChecksPending(session.id, headSha, 'building', 'sync-main'); } catch (_) {}
  session.check_state = 'pending';
  session.checks_commit_sha = headSha;
  require('./pr-import-sync').rerunChecksForNewHead({
    config, pool, session, newHead: headSha,
  }).catch((err) => log.warn('sync-main', 'post-sync checks re-run failed', {
    sessionId: session.id, headSha, err: err.message,
  }));
}

// Historical name, kept because routes/sessions.js re-exports it and callers
// (plus tests) import it from there.
const advanceSharedReviewAfterSync = advanceReviewAfterPlatformSync;

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

  const releaseOperation = beginSessionOperation(key);
  const entry = { phase: 'starting', startedAt: Date.now(), promise: null };
  _inFlightSyncs.set(key, entry);
  entry.promise = runSyncMainInner(config, pool, sessionId, opts, entry)
    .finally(() => {
      if (_inFlightSyncs.get(key) === entry) _inFlightSyncs.delete(key);
      releaseOperation();
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
        onProgress,
    });

    activeWorkers.add(session.id);
    // #937: a sync turn is a NEW turn, so it owns the pending-stop
    // boundary the same way a chat turn does. Without this, a stop
    // requested against an earlier chat turn would still be pending in the
    // registry and execInWorker's pre-dispatch gate would refuse to
    // dispatch this sync — a sync turn isn't in stopRegistry, so nothing
    // else would ever clear it.
    worker.clearPendingStop(session.id);
    let result;
    try {
      result = await worker.execInWorker(session.id, {
        mode: 'sync',
        prompt: '(sync turn — see MODE=sync block in run-cc.sh)',
        // Use a small fast model — the prompt is short and the task is
        // mechanical. The route's caller doesn't get to pick.
        model: 'claude-sonnet-5',
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
      dstep({ phase: 'sync_result', level: 'error', message: 'Worker sync: Claude could not resolve the conflicts.', detail: { syncResult, conflictFiles: result.conflictFiles || [], costUsd: result.costUsd || 0, pushOk: !!result.pushOk } });
    } else {
      await persistConflictState(pool, session, { state: 'clean', files: [] });
      dstep({ phase: 'sync_result', message: `Worker sync ${syncResult}${result.sha ? ` — pushed ${String(result.sha).slice(0, 9)}` : ''}.`, detail: { syncResult, sha: result.sha || null, behind: result.behind || 0, conflictFiles: result.conflictFiles || [], costUsd: result.costUsd || 0, pushOk: !!result.pushOk } });
    }

    // #788 follow-up: a sync that pushed changed the branch's contents,
    // so the explicit-approval classification may no longer hold (e.g. a
    // merge commit that brings the branch's dapp.json in line with
    // main's). Re-stamp on promoted rows so a stale flag clears (or a
    // fresh one lands) without waiting for the next vote or sweeper
    // pass. Best-effort: refreshExplicitApproval swallows GitHub
    // failures and leaves the column untouched when indeterminate.
    // Deliberately does NOT reset votes — a sync commit never has.
    if ((syncResult === 'clean' || syncResult === 'resolved')
        && result.pushOk && session.status === 'promoted') {
      // eslint-disable-next-line global-require
      await require('./app-admins').refreshExplicitApproval(pool, session, session);
    }

    // #955: bind the reviewed revision (and the votes stamped on it) to the
    // commit we just pushed. Runs for every native row, not just CLI handoffs.
    await advanceReviewAfterPlatformSync(pool, session, {
      syncResult,
      pushOk: !!result.pushOk,
      sha: result.sha || null,
    }, { config, dstep }).catch((err) => log.warn('sync-main', 'Review advance after sync failed', {
      sessionId: session.id, err: err.message,
    }));

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

module.exports = {
  runSyncMain,
  persistBehindMain,
  persistConflictState,
  getSyncState,
  advanceReviewAfterPlatformSync,
  advanceSharedReviewAfterSync,
  recordPlatformPush,
  findPlatformPush,
  backfillPlatformPushParent,
};
