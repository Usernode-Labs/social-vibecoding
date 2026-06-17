const log = require('./logger');
const github = require('./github');
const limits = require('./limits');
const { runSyncMain, persistConflictState } = require('./sync-main');
const { getActiveUserStats } = require('./active-users');
const { getPool } = require('../db/pool');

// GitHub computes PR mergeability asynchronously: for a few seconds
// after the base branch (main) changes it returns `mergeable: null`
// while a background job recomputes. The old resolver checked once,
// immediately, un-awaited, and treated `null` as "nothing to do" — so
// it almost always no-op'd right after a merge. We now poll until the
// value settles before deciding.
const MERGEABLE_POLL_TRIES = parseInt(process.env.CONFLICT_MERGEABLE_POLL_TRIES, 10) || 6;
// Env-overridable so tests can drop it to 0 (the default 2s × up to 5
// sleeps would make the suite crawl).
const MERGEABLE_POLL_DELAY_MS = Number.isFinite(parseInt(process.env.CONFLICT_MERGEABLE_POLL_DELAY_MS, 10))
  ? parseInt(process.env.CONFLICT_MERGEABLE_POLL_DELAY_MS, 10)
  : 2000;

// Post-sync gate: after the worker pushes the integration commit (or for
// an already-clean branch) we must wait for GitHub to report
// `mergeable === true` BEFORE calling pulls.merge. Right after a push,
// GitHub flips mergeable to null while it recomputes; merging in that
// window 405s with "Pull Request has merge conflicts" even though the
// branch is clean. This is exactly the 405 we hit on the first #25/#26
// run. A longer, true-only wait closes it.
const MERGEABLE_TRUE_TRIES = parseInt(process.env.CONFLICT_MERGEABLE_TRUE_TRIES, 10) || 8;
const MERGEABLE_TRUE_DELAY_MS = Number.isFinite(parseInt(process.env.CONFLICT_MERGEABLE_TRUE_DELAY_MS, 10))
  ? parseInt(process.env.CONFLICT_MERGEABLE_TRUE_DELAY_MS, 10)
  : 2500;
// Give GitHub a beat to invalidate the pre-push mergeable cache before
// we start polling, so we don't read a stale `true`.
const MERGEABLE_AFTER_PUSH_INITIAL_MS = Number.isFinite(parseInt(process.env.CONFLICT_MERGEABLE_AFTER_PUSH_INITIAL_MS, 10))
  ? parseInt(process.env.CONFLICT_MERGEABLE_AFTER_PUSH_INITIAL_MS, 10)
  : 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRepo(repoUrl) {
  const [, owner, repo] = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/) || [];
  return owner && repo ? { owner, repo } : null;
}

// Poll GitHub until it has computed PR mergeability. Returns the final
// boolean (`true` mergeable / `false` conflicting) or `null` if it
// never settled within the budget. Throws are surfaced to the caller.
async function pollMergeable(owner, repo, prNumber) {
  // getOctokit (PAT-preferred), NOT getInstallationOctokit: the
  // self-app's repo owner (e.g. Usernode-Labs) has no GitHub App
  // installation, so the installation path throws on every poll and
  // the resolver flies blind on exactly the PR class (selfHosted)
  // where a wrong merge decision hurts most. mergePR already goes
  // through the PAT path; mergeability reads must match.
  const octokit = await github.getOctokit(owner);
  for (let i = 0; i < MERGEABLE_POLL_TRIES; i++) {
    const { data: pr } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner, repo, pull_number: prNumber }
    );
    if (pr.mergeable === true || pr.mergeable === false) return pr.mergeable;
    if (i < MERGEABLE_POLL_TRIES - 1) {
      await sleep(MERGEABLE_POLL_DELAY_MS);
    }
  }
  return null;
}

// Wait specifically for `mergeable === true` (clean) before a merge
// attempt. Returns true (clean), false (GitHub still sees a real
// conflict), or null (never finished recomputing within budget — caller
// should NOT merge, to avoid the null-window 405). `afterPush` adds a
// short initial delay so we don't read the stale pre-push value.
async function waitForMergeableTrue(owner, repo, prNumber, { afterPush = false } = {}) {
  // PAT-preferred for the same reason as pollMergeable above.
  const octokit = await github.getOctokit(owner);
  if (afterPush && MERGEABLE_AFTER_PUSH_INITIAL_MS > 0) {
    await sleep(MERGEABLE_AFTER_PUSH_INITIAL_MS);
  }
  for (let i = 0; i < MERGEABLE_TRUE_TRIES; i++) {
    const { data: pr } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner, repo, pull_number: prNumber }
    );
    if (pr.mergeable === true) return true;
    if (pr.mergeable === false) return false;
    if (i < MERGEABLE_TRUE_TRIES - 1) {
      await sleep(MERGEABLE_TRUE_DELAY_MS);
    }
  }
  return null;
}

// Re-fetch a session joined with its app so callers always work from a
// fresh row (status / behind_main / votes may have moved since the
// trigger fired).
async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.name AS app_name,
            a.self_hosted AS app_self_hosted
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

// Post-merge sweep: sync ONLY a single promoted PR that has ALREADY reached
// the merge vote threshold (the highest-voted such sibling) with main
// (worker git-merge + Claude-on-markers) and, if it's clean, retry the
// merge. Fired (un-awaited) from checkAndMerge after a successful merge, and
// from the drift poller after an out-of-band main move.
//
// #380: previously this swept EVERY other promoted PR, spinning a worker
// conflict-resolution turn for each — including PRs with barely any votes
// that won't merge for a long time (if ever) — which burned the system-token
// budget on speculative work. The policy is now strictly on-demand: resolve
// conflicts ONLY for a PR that can actually merge right now, i.e. one whose
// yes-vote count already meets the per-app majority threshold. PRs short of
// the threshold are never pre-emptively resolved; they're healed lazily when
// a vote pushes them over (checkAndMerge's behind_main path), and this sweep
// re-runs after every merge / drift redeploy to drain the eligible PRs one
// at a time. Among multiple already-eligible PRs we pick the highest-voted
// (longest-waiting on a tie); the cascade handles the rest.
async function checkAndResolveConflicts(config, mergedSession) {
  const pool = getPool(config);

  // The eligibility bar is the same active-user majority checkAndMerge gates
  // the actual merge on (routes/votes.js), so the sweep only ever touches a
  // PR that is genuinely ready to merge.
  const { majority } = await getActiveUserStats(pool, mergedSession.app_id);

  // Select only promoted siblings whose yes-vote count already meets the
  // threshold, highest-voted first; tie-break longest-waiting (earliest
  // promoted_at, NULLS LAST) then earliest created_at for determinism. The
  // ordering only disambiguates among already-eligible PRs — the WHERE clause
  // guarantees a below-threshold PR is never picked, so nothing is resolved
  // pre-emptively.
  const { rows: conflictCandidates } = await pool.query(
    `SELECT cs.id,
            (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') AS yes_count
     FROM chat_sessions cs
     WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.id != $2
       AND (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') >= $3
     ORDER BY yes_count DESC, cs.promoted_at ASC NULLS LAST, cs.created_at ASC
     LIMIT 1`,
    [mergedSession.app_id, mergedSession.id || 0, majority]
  );

  if (!conflictCandidates.length) return;

  const { id } = conflictCandidates[0];
  try {
    await resolveAndMaybeRetry(config, { sessionId: id });
  } catch (err) {
    log.error('conflict', 'resolveAndMaybeRetry failed', { sessionId: id, err: err.message });
  }
}

// Sync one promoted PR with main via the worker when it's drifted /
// conflicting, then — once GitHub confirms the branch is mergeable —
// re-attempt the merge for an already-approved PR. Also merges an
// already-clean approved PR that was left stuck (e.g. a prior merge
// 405'd in GitHub's post-push mergeable-recompute window).
//
// `target` is either { session } (a pre-loaded joined row) or
// { sessionId } (we'll load it). Returns a small status object; never
// throws (logs + group-chat on failure).
//
// Per-session coalescing: this is fired from multiple places that can
// overlap on the SAME session — an explicit trigger and the post-merge
// sibling sweep, or two sweeps from back-to-back merges. Two concurrent
// resolves for one session both call runSyncMain(id), and the second
// hits the worker's "a turn is already in flight for session N" guard
// (the exact error seen on the whiteboard #26 run). We dedupe by
// sessionId so concurrent callers share one in-flight resolve (and thus
// one worker turn / one merge attempt) and receive the same result.
const _inFlightResolves = new Map(); // sessionId -> Promise<result>

// Process-local "is a resolve currently in flight for this session?" —
// authoritative because the platform runs as a single Node process.
// Read by GET /api/sessions/:id/status (the banner's reload-recovery
// poll) and GET /api/apps/:slug/promoted (the vote-panel badge).
function isResolving(sessionId) {
  return _inFlightResolves.has(sessionId);
}

// #239: map the inner resolve's exit `reason` onto the coarse outcome
// the client banner switches on. `failed` covers every exit where the
// branch is still broken (or the sync never ran for a budget/error
// reason after a real conflict was detected); `synced` means the branch
// is fixed but the merge still needs votes; everything that did nothing
// user-visible is `noop`.
function resolutionOutcomeFor(reason) {
  if (reason === 'synced_and_merged' || reason === 'merged') return 'merged';
  if (reason === 'synced_awaiting_votes' || reason === 'mergeable_recompute_pending') return 'synced';
  if (['unresolved_conflict', 'sync_threw', 'still_conflicting', 'over_budget', 'retry_threw'].includes(reason)) {
    return 'failed';
  }
  return 'noop';
}

async function resolveAndMaybeRetry(config, target) {
  const sessionId = target.sessionId != null ? target.sessionId : target.session?.id;
  if (sessionId != null && _inFlightResolves.has(sessionId)) {
    return _inFlightResolves.get(sessionId);
  }
  const p = resolveAndMaybeRetryInner(config, target);
  if (sessionId != null) {
    _inFlightResolves.set(sessionId, p);
    p.finally(() => {
      if (_inFlightResolves.get(sessionId) === p) _inFlightResolves.delete(sessionId);
    });
  }
  // #239: terminal lifecycle broadcast — exactly once per in-flight
  // resolve (deduped callers share `p`, so they share this too). The
  // inner resolve decorates its result with appSlug/selfHosted once the
  // session row is loaded; exits before that (session_not_found) carry
  // no appSlug and are skipped. Clients use this to clear the resolving
  // banner / vote-panel badge.
  p.then((result) => {
    if (!result || !result.appSlug) return;
    try {
      const { pushVoteUpdate } = require('./ws');
      const outcome = resolutionOutcomeFor(result.reason);
      // #361: map the terminal resolve outcome onto the persisted
      // merge-conflict snapshot so open cards update their badge without
      // a refetch. 'failed' covers every still-broken exit; 'merged'/
      // 'synced'/'noop' all leave the branch clean.
      const mergeConflictState = outcome === 'failed' ? 'failed' : 'clean';
      pushVoteUpdate({
        sessionId: result.sessionId != null ? result.sessionId : sessionId,
        appSlug: result.appSlug,
        resolving: false,
        resolutionOutcome: outcome,
        mergeConflictState,
        selfHosted: !!result.selfHosted,
      });
    } catch (_) { /* ws non-fatal */ }
  }).catch(() => { /* inner never throws by contract; belt-and-braces */ });
  return p;
}

async function resolveAndMaybeRetryInner(config, target) {
  const pool = getPool(config);
  let session = target.session || null;
  if (!session) {
    session = await loadSession(pool, target.sessionId);
    if (!session) return { ok: false, reason: 'session_not_found' };
  }
  const result = await resolveWithSession(config, pool, session);
  // #239: decorate every loaded-session exit with the fields the
  // wrapper's terminal broadcast needs. Pre-loaded sessions from
  // checkAndMerge already carry app_slug / app_self_hosted; loadSession
  // selects them too.
  return {
    ...result,
    sessionId: session.id,
    appSlug: session.app_slug,
    selfHosted: !!session.app_self_hosted,
  };
}

async function resolveWithSession(config, pool, session) {
  if (!github.isEnabled() || !session.repo_url || !session.pr_number) {
    return { ok: false, reason: 'github_disabled_or_no_pr' };
  }
  if (session.status !== 'promoted') {
    // Only promoted PRs are candidates — anything else (active, merging,
    // merged) is either not up for a vote or already in flight.
    return { ok: false, reason: `status_${session.status}` };
  }

  const repo = parseRepo(session.repo_url);
  if (!repo) return { ok: false, reason: 'unparseable_repo' };

  // Decide whether a worker sync is needed: recorded drift, or GitHub
  // currently reporting a real conflict (mergeable === false) once its
  // computation settles.
  let mergeable0;
  try {
    mergeable0 = await pollMergeable(repo.owner, repo.repo, session.pr_number);
  } catch (err) {
    log.warn('conflict', 'pollMergeable failed', { sessionId: session.id, err: err.message });
    mergeable0 = null;
  }
  const behind = session.behind_main || 0;
  const needsSync = behind > 0 || mergeable0 === false;

  // #361: persist a derived merge-conflict snapshot so proposal cards
  // reflect drift/conflict state even before (or independently of) a
  // resolve. A real GitHub conflict → 'conflict'; clean-but-behind →
  // 'behind'; clean and even → 'clean'. The 'resolving'/'failed'
  // transitions are written below / by sync-main as the turn runs.
  if (mergeable0 === false) {
    await persistConflictState(pool, session, { state: 'conflict', files: [] });
  } else if (mergeable0 === true) {
    await persistConflictState(pool, session, { state: behind > 0 ? 'behind' : 'clean', files: [] });
  }

  let didSync = false;
  let syncResult = null;

  if (needsSync) {
    log.info('conflict', 'Conflict/drift detected, syncing PR with main', {
      sessionId: session.id, pr: session.pr_number, behind, mergeable0,
    });

    // #361: the worker sync draws from the dedicated "system tokens"
    // budget (platform housekeeping, not the owner's spend). Skip — and
    // surface it in group chat — when that budget is exhausted, so a
    // runaway conflict loop can't blow past the system cap. runSyncMain
    // re-checks the same gate at turn time.
    const sysBudget = await limits.checkSystemBudget(pool);
    if (sysBudget.error) {
      log.info('conflict', 'Skipped — system token budget exhausted', {
        sessionId: session.id, reason: sysBudget.error,
      });
      await postGroupMessage(pool, session,
        `Auto-conflict-resolution skipped on PR #${session.pr_number}: the system token budget is exhausted — resolve manually via "Sync with main" or wait for the midnight-UTC reset.`
      );
      return { ok: false, reason: 'over_budget' };
    }

    // #239: start lifecycle broadcast — emitted only here, past the
    // needsSync + billing gates, so the frequent no-op sweeps (post-merge
    // sibling sweep / drift poller calls that find nothing to do) never
    // flash the resolving banner. Clients arm the non-blocking
    // "resolving merge conflicts" banner (self-hosted) and the
    // vote-panel badge off this.
    // #361: snapshot the in-flight state so a reload (or a card rendered
    // mid-resolve) shows the animated "Resolving conflicts…" badge.
    await persistConflictState(pool, session, { state: 'resolving', files: session.conflict_files || [] });
    try {
      const { pushVoteUpdate } = require('./ws');
      pushVoteUpdate({
        sessionId: session.id,
        appSlug: session.app_slug,
        resolving: true,
        mergeConflictState: 'resolving',
        selfHosted: !!session.app_self_hosted,
      });
    } catch (_) { /* ws non-fatal */ }

    let sync;
    try {
      sync = await runSyncMain(config, pool, session.id, { sessionRow: session, trigger: 'conflict_resolver' });
    } catch (err) {
      log.error('conflict', 'runSyncMain threw', { sessionId: session.id, err: err.message });
      await postGroupMessage(pool, session,
        `Couldn't auto-resolve conflicts on PR #${session.pr_number} (sync failed: ${err.message}). Try "Sync with main" from the session's dev-chat.`
      );
      return { ok: false, reason: 'sync_threw' };
    }
    didSync = true;
    syncResult = sync.syncResult;

    if (sync.syncResult === 'conflict') {
      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      await postGroupMessage(pool, session,
        `PR #${session.pr_number} couldn't be auto-merged with main — Claude couldn't resolve the conflicts. ${owner}: open the session's dev-chat to resolve it.`
      );
      return { ok: false, reason: 'unresolved_conflict' };
    }
  } else if (mergeable0 !== true) {
    // No recorded drift and GitHub never settled to a definite state
    // (null). Nothing actionable — don't risk a 405 on an unknown state.
    return { ok: true, reason: 'no_conflict' };
  }

  // Before retrying the merge, wait for GitHub to confirm the branch is
  // mergeable. After our sync push it returns mergeable:null for a few
  // seconds; merging in that window 405s even though the branch is
  // clean (the failure mode on the first #25/#26 run).
  let mergeableNow;
  try {
    mergeableNow = await waitForMergeableTrue(repo.owner, repo.repo, session.pr_number, { afterPush: didSync });
  } catch (err) {
    log.warn('conflict', 'waitForMergeableTrue failed', { sessionId: session.id, err: err.message });
    mergeableNow = null;
  }

  if (mergeableNow === false) {
    // GitHub still sees a real conflict (shouldn't happen right after a
    // resolved sync, but bail cleanly rather than 405).
    if (didSync) {
      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      await postGroupMessage(pool, session,
        `PR #${session.pr_number} still conflicts with main after an auto-sync. ${owner}: open the session's dev-chat to resolve it.`
      );
    }
    return { ok: false, reason: 'still_conflicting', syncResult };
  }
  if (mergeableNow !== true) {
    // null: GitHub hasn't finished recomputing within our budget. Don't
    // risk the null-window 405 — the next vote or drift sweep retries.
    if (didSync) {
      await postGroupMessage(pool, session,
        `PR #${session.pr_number} is synced with main and conflict-free — GitHub is still finalizing mergeability, the merge will complete on the next vote or sweep.`
      );
    }
    return { ok: true, reason: 'mergeable_recompute_pending', syncResult };
  }

  // mergeable === true → re-attempt the merge for an approved PR. Pass
  // autoResolve:false so checkAndMerge's own conflict paths don't
  // re-trigger us — bounds the resolve+retry to a single cycle.
  const fresh = await loadSession(pool, session.id);
  if (!fresh || fresh.status !== 'promoted') {
    return { ok: true, reason: 'no_longer_promoted', syncResult };
  }

  let mergeResult;
  try {
    const { checkAndMerge } = require('../routes/votes');
    mergeResult = await checkAndMerge(config, pool, fresh, { autoResolve: false });
  } catch (err) {
    log.error('conflict', 'retry checkAndMerge threw', { sessionId: session.id, err: err.message });
    return { ok: true, reason: 'retry_threw', syncResult };
  }

  if (mergeResult?.merged) {
    try {
      const { pushVoteUpdate } = require('./ws');
      pushVoteUpdate({ sessionId: fresh.id, appSlug: fresh.app_slug, merged: true });
    } catch (_) { /* ws non-fatal */ }
    return { ok: true, reason: didSync ? 'synced_and_merged' : 'merged', syncResult };
  }

  // Not merged — almost always "not enough yes votes yet". Only announce
  // when we actually synced, so the post-merge sibling sweep doesn't spam
  // vote-status lines for every clean-but-unapproved promoted PR.
  if (didSync && typeof mergeResult?.yesCount === 'number' && typeof mergeResult?.needed === 'number') {
    await postGroupMessage(pool, fresh,
      `PR #${fresh.pr_number} is now synced with main and conflict-free — ${mergeResult.yesCount}/${mergeResult.needed} yes votes needed to merge.`
    );
  }
  return { ok: true, reason: didSync ? 'synced_awaiting_votes' : 'awaiting_votes', syncResult };
}

async function postGroupMessage(pool, session, content) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, session.app_id, content, 'conflict');
  } catch (err) {
    log.warn('conflict', 'Failed to post group-chat message', { sessionId: session?.id, err: err.message });
  }
}

module.exports = { checkAndResolveConflicts, resolveAndMaybeRetry, pollMergeable, isResolving };
