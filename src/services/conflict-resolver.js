const log = require('./logger');
const github = require('./github');
const limits = require('./limits');
const { runSyncMain } = require('./sync-main');
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

function parseRepo(repoUrl) {
  const [, owner, repo] = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/) || [];
  return owner && repo ? { owner, repo } : null;
}

// Poll GitHub until it has computed PR mergeability. Returns the final
// boolean (`true` mergeable / `false` conflicting) or `null` if it
// never settled within the budget. Throws are surfaced to the caller.
async function pollMergeable(owner, repo, prNumber) {
  const octokit = await github.getInstallationOctokit(owner);
  for (let i = 0; i < MERGEABLE_POLL_TRIES; i++) {
    const { data: pr } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner, repo, pull_number: prNumber }
    );
    if (pr.mergeable === true || pr.mergeable === false) return pr.mergeable;
    if (i < MERGEABLE_POLL_TRIES - 1) {
      await new Promise((r) => setTimeout(r, MERGEABLE_POLL_DELAY_MS));
    }
  }
  return null;
}

// Re-fetch a session joined with its app so callers always work from a
// fresh row (status / behind_main / votes may have moved since the
// trigger fired).
async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.name AS app_name
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

// Post-merge sweep: for every OTHER promoted PR on the same app, sync it
// with main (worker git-merge + Claude-on-markers) and, if it's already
// approved, retry the merge. Fired (un-awaited) from checkAndMerge after
// a successful merge, and from the drift poller after an out-of-band
// main move.
async function checkAndResolveConflicts(config, mergedSession) {
  const pool = getPool(config);

  const { rows: conflictCandidates } = await pool.query(
    `SELECT cs.id
     FROM chat_sessions cs
     WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.id != $2`,
    [mergedSession.app_id, mergedSession.id || 0]
  );

  if (!conflictCandidates.length) return;

  // Sequential: each candidate may spin a worker (real git merge). Doing
  // them in parallel would stampede the docker host the same way the
  // drift poller avoids.
  for (const { id } of conflictCandidates) {
    try {
      await resolveAndMaybeRetry(config, { sessionId: id });
    } catch (err) {
      log.error('conflict', 'resolveAndMaybeRetry failed', { sessionId: id, err: err.message });
    }
  }
}

// Decide whether a promoted PR's branch actually needs to be integrated
// with main. True when we have a recorded drift (behind_main > 0) or
// GitHub reports a real conflict once its mergeability computation
// settles. Returning false means "leave it alone".
async function needsIntegration(session, repo) {
  if ((session.behind_main || 0) > 0) return true;
  try {
    const mergeable = await pollMergeable(repo.owner, repo.repo, session.pr_number);
    return mergeable === false;
  } catch (err) {
    log.warn('conflict', 'pollMergeable failed; falling back to behind_main', {
      sessionId: session.id, pr: session.pr_number, err: err.message,
    });
    return false;
  }
}

// Sync one promoted PR with main via the worker, and — if it integrates
// cleanly and the PR is already approved — retry the merge.
//
// `target` is either { session } (a pre-loaded joined row) or
// { sessionId } (we'll load it). Returns a small status object; never
// throws (logs + group-chat on failure).
async function resolveAndMaybeRetry(config, target) {
  const pool = getPool(config);
  let session = target.session || null;
  if (!session) {
    session = await loadSession(pool, target.sessionId);
    if (!session) return { ok: false, reason: 'session_not_found' };
  }

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

  let integration;
  try {
    integration = await needsIntegration(session, repo);
  } catch (err) {
    log.error('conflict', 'needsIntegration threw', { sessionId: session.id, err: err.message });
    return { ok: false, reason: 'needs_integration_error' };
  }
  if (!integration) return { ok: true, reason: 'no_conflict' };

  log.info('conflict', 'Conflict detected, syncing PR with main', {
    sessionId: session.id, pr: session.pr_number,
  });

  // The worker sync charges the session owner (their BYOK key, or the
  // platform proxy). Gate on their daily cap so a runaway conflict
  // loop can't blow the budget; surface the skip in group chat so the
  // owner knows to sync manually or wait for the cap to reset.
  const budgetCheck = await limits.checkBudget(pool, session.user_id);
  if (budgetCheck.error) {
    log.info('conflict', 'Skipped — session owner over daily cap', {
      sessionId: session.id, ownerId: session.user_id, reason: budgetCheck.error,
    });
    await postGroupMessage(pool, session,
      `Auto-conflict-resolution skipped on PR #${session.pr_number}: the PR owner has hit their daily LLM limit. Resolve manually via "Sync with main" or wait for the cap to reset.`
    );
    return { ok: false, reason: 'over_budget' };
  }

  let sync;
  try {
    sync = await runSyncMain(config, pool, session.id, { sessionRow: session });
  } catch (err) {
    log.error('conflict', 'runSyncMain threw', { sessionId: session.id, err: err.message });
    await postGroupMessage(pool, session,
      `Couldn't auto-resolve conflicts on PR #${session.pr_number} (sync failed: ${err.message}). Try "Sync with main" from the session's dev-chat.`
    );
    return { ok: false, reason: 'sync_threw' };
  }

  if (sync.syncResult === 'conflict') {
    const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
    await postGroupMessage(pool, session,
      `PR #${session.pr_number} couldn't be auto-merged with main — Claude couldn't resolve the conflicts. ${owner}: open the session's dev-chat to resolve it.`
    );
    return { ok: false, reason: 'unresolved_conflict' };
  }

  // Synced cleanly (clean | resolved | already_synced) → branch is no
  // longer behind. Re-attempt the merge for an already-approved PR.
  // Pass autoResolve:false so checkAndMerge's own conflict paths don't
  // re-trigger us — bounds the resolve+retry to a single cycle.
  const fresh = await loadSession(pool, session.id);
  if (!fresh || fresh.status !== 'promoted') {
    return { ok: true, reason: 'synced_no_longer_promoted', syncResult: sync.syncResult };
  }

  let mergeResult;
  try {
    const { checkAndMerge } = require('../routes/votes');
    mergeResult = await checkAndMerge(config, pool, fresh, { autoResolve: false });
  } catch (err) {
    log.error('conflict', 'retry checkAndMerge threw', { sessionId: session.id, err: err.message });
    return { ok: true, reason: 'synced_retry_threw', syncResult: sync.syncResult };
  }

  if (mergeResult?.merged) {
    try {
      const { pushVoteUpdate } = require('./ws');
      pushVoteUpdate({ sessionId: fresh.id, appSlug: fresh.app_slug, merged: true });
    } catch (_) { /* ws non-fatal */ }
    return { ok: true, reason: 'synced_and_merged', syncResult: sync.syncResult };
  }

  // Synced but not merged — almost always "not enough yes votes yet".
  // Leave a breadcrumb so the group knows the conflict is cleared and
  // only votes are outstanding.
  if (typeof mergeResult?.yesCount === 'number' && typeof mergeResult?.needed === 'number') {
    await postGroupMessage(pool, fresh,
      `PR #${fresh.pr_number} is now synced with main and conflict-free — ${mergeResult.yesCount}/${mergeResult.needed} yes votes needed to merge.`
    );
  }
  return { ok: true, reason: 'synced_awaiting_votes', syncResult: sync.syncResult };
}

async function postGroupMessage(pool, session, content) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, session.app_id, content, 'conflict');
  } catch (err) {
    log.warn('conflict', 'Failed to post group-chat message', { sessionId: session?.id, err: err.message });
  }
}

module.exports = { checkAndResolveConflicts, resolveAndMaybeRetry, pollMergeable };
