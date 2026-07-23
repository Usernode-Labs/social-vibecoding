'use strict';

// #687 Slice 3 — sync poller for IMPORTED PR proposals.
//
// An imported proposal tracks a GitHub PR whose branch the platform does
// NOT own; the external author keeps pushing to it. Votes and checks are
// cast/run against a specific commit (imported_pr_head_sha), so when the
// author pushes new commits the head moves and everyone approved code that
// is no longer what would merge. This module notices that on the next
// sweeper pass and re-opens the proposal against the new head:
//
//   - update imported_pr_head_sha to the new head,
//   - CLEAR the vote tally (votes were cast on the old code),
//   - post a "the PR was updated — please re-review" note into the
//     proposal's own thread (same sendSystemMessage channel checkAndMerge
//     uses),
//   - refresh behind_main / conflict state from GitHub (the native path's
//     drift snapshot), and
//   - re-run the proposal checks against the new head via the SHA-pinned
//     staging build from Slice 1.
//
// Purely additive to the native proposal/vote/merge path.

const log = require('./logger');
const github = require('./github');
const githubMock = require('./github-mock');
const { usesMockGithubForImports } = require('../config');

function parseRepo(url) {
  const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo } : null;
}

// #687: talk to the in-memory mock GitHub source in staging previews (no
// GitHub credentials there — see usesMockGithubForImports in config.js);
// the real client everywhere else.
function activeGithub() {
  return usesMockGithubForImports() ? githubMock : github;
}

// Fetch the imported PR's current head SHA and, when it has moved since the
// stored imported_pr_head_sha, reset the proposal against the new head.
//
// Returns one of:
//   'skipped'   — not an imported row, GitHub not configured, or
//                 the getPR fetch failed (transient — retried next sweep).
//   'unchanged' — the head SHA matches the stored one (the common case);
//                 exactly one getPR call and nothing else.
//   'updated'   — the head moved: tally cleared, note posted, drift +
//                 checks refreshed against the new head.
//
// `session` must carry (at least): id, app_id, app_slug, source, pr_number,
// pr_title, branch_name, repo_url, imported_pr_head_sha — i.e. the
// `cs.*, a.slug AS app_slug, a.repo_url` shape the sweeper selects. Never
// throws: infrastructure failures are logged and swallowed so one bad PR
// can't wedge the sweep.
async function syncImportedProposal({ config, pool, session }) {
  try {
    if (!session || session.source !== 'imported' || !session.pr_number) return 'skipped';
    const repo = parseRepo(session.repo_url);
    const gh = activeGithub();
    if (!repo || !gh.isEnabled()) return 'skipped';

    let pr;
    try {
      pr = await gh.getPR(repo.owner, repo.repo, session.pr_number);
    } catch (err) {
      log.warn('pr-import-sync', 'getPR failed — will retry next sweep', {
        sessionId: session.id, prNumber: session.pr_number, err: err.message,
      });
      return 'skipped';
    }

    const newHead = pr.head && pr.head.sha ? pr.head.sha : null;
    if (!newHead) return 'skipped';
    const oldHead = session.imported_pr_head_sha || null;
    if (newHead === oldHead) return 'unchanged';

    await applyHeadChange({ config, pool, session, pr, repo, newHead, oldHead });
    return 'updated';
  } catch (err) {
    log.warn('pr-import-sync', 'syncImportedProposal failed', {
      sessionId: session && session.id, err: err.message,
    });
    return 'skipped';
  }
}

// Apply a head change: advance the stored SHA, reset the tally, post the
// re-review note, refresh drift, and re-run SHA-pinned checks. Each side
// effect is best-effort past the first two DB writes so a hiccup in one
// (e.g. the drift refresh) doesn't skip the others.
async function applyHeadChange({ config, pool, session, pr, repo, newHead, oldHead }) {
  const { sendSystemMessage, pushVoteUpdate } = require('./ws');

  // 1. Advance the head the checks/votes now describe.
  await pool.query(
    `UPDATE chat_sessions SET imported_pr_head_sha = $1 WHERE id = $2`,
    [newHead, session.id]
  );
  session.imported_pr_head_sha = newHead;

  // 2. Clear the vote tally — every vote was cast on the superseded code.
  //    (The gate is also head-scoped, so a vote that raced this reset still
  //    won't count against the new head; this DELETE keeps the visible pill
  //    honest and re-arms the stale-PR clock.)
  await pool.query(`DELETE FROM pr_votes WHERE session_id = $1`, [session.id]);
  await pool.query(
    `UPDATE chat_sessions SET stale_notified_at = NULL WHERE id = $1`,
    [session.id]
  ).catch(() => {});

  // 3. "the PR was updated — please re-review", into the proposal's own
  //    thread (same channel + thread targeting checkAndMerge uses).
  const label = session.pr_title
    ? `PR #${session.pr_number} — ${session.pr_title}`
    : `PR #${session.pr_number}`;
  await sendSystemMessage(
    pool, session.app_id,
    `${label} was updated on GitHub — earlier votes were cleared, please re-review the new changes.`,
    'system',
    { headChanged: true, prNumber: session.pr_number, headSha: newHead },
    { type: 'session', ref: session.id }
  ).catch((err) => log.warn('pr-import-sync', 're-review note failed', {
    sessionId: session.id, err: err.message,
  }));

  // 4. Tell open clients the tally reset to zero so the pill refreshes live.
  try {
    pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug || null, merged: false });
  } catch (_) { /* ws failures are non-fatal */ }

  // 5. Refresh behind_main / conflict snapshot the way the native path does.
  await refreshDriftState({ pool, session, pr, repo }).catch((err) =>
    log.warn('pr-import-sync', 'drift refresh failed', { sessionId: session.id, err: err.message }));

  // 6. Re-run the proposal checks against the NEW head — the SHA-pinned
  //    staging build from Slice 1 (storeChecks / storeChecksSkipped).
  await rerunChecksForNewHead({ config, pool, session, newHead }).catch((err) =>
    log.warn('pr-import-sync', 'checks re-run failed', { sessionId: session.id, err: err.message }));

  log.info('pr-import-sync', 'Imported PR head changed — reset tally + re-ran checks', {
    sessionId: session.id, prNumber: session.pr_number, oldHead, newHead,
  });
}

// Refresh the proposal card's behind_main + merge-conflict snapshot from
// GitHub, mirroring the native drift path (services/sync-main.js
// persistBehindMain / persistConflictState) — but WITHOUT a worker turn,
// because the platform doesn't own an imported PR's branch. behind_by comes
// from compareCommits(base…head); the conflict verdict from GitHub's
// mergeable flag (true → clean, false → conflict; null = still computing,
// left as-is for the next sweep).
async function refreshDriftState({ pool, session, pr, repo }) {
  const syncMain = require('./sync-main');
  const base = (pr.base && pr.base.ref) || 'main';
  const head = session.branch_name || (pr.head && pr.head.ref) || null;
  if (!head) return;

  let behindBy = null;
  try {
    const octokit = await activeGithub().getOctokit(repo.owner);
    const { data } = await octokit.rest.repos.compareCommits({
      owner: repo.owner, repo: repo.repo, base, head,
    });
    behindBy = Number.isFinite(data.behind_by) ? data.behind_by : null;
  } catch (err) {
    log.warn('pr-import-sync', 'compareCommits failed', { sessionId: session.id, err: err.message });
  }

  if (behindBy != null) {
    await syncMain.persistBehindMain(pool, session, behindBy);
  }

  // GitHub's mergeable is true / false / null (null = still being computed).
  if (pr.mergeable === true) {
    await syncMain.persistConflictState(pool, session, { state: 'clean', files: [] });
  } else if (pr.mergeable === false) {
    await syncMain.persistConflictState(pool, session, { state: 'conflict', files: [] });
  }
  // mergeable === null: leave the prior snapshot; the next sweep re-checks.
}

// Re-run the proposal's checks against the new head. Builds a fresh staging
// preview pinned to `newHead` (Slice 1's exact-SHA clone) and captures the
// checks against it — the same shape as the import-time kick — rather than
// re-checking the still-running old-head container, which would test the
// superseded code. Fire-and-forget at the capture layer, matching the
// import + dev-turn callers; a genuine build failure is recorded as a
// terminal 'error' verdict (recordStagingBootFailure) so the gate never
// dead-ends on a NULL/pending state.
async function rerunChecksForNewHead({ config, pool, session, newHead }) {
  const visuals = require('./visuals');
  const staging = require('./staging');
  const app = {
    id: session.app_id, slug: session.app_slug,
    name: session.app_name, repo_url: session.repo_url,
  };

  // Stamp 'pending' immediately so the badge stops showing the old-head
  // verdict while the (minutes-long) rebuild runs.
  await visuals.setChecksPending(pool, session.id, newHead)
    .catch((err) => log.warn('pr-import-sync', 'setChecksPending failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
  visuals.notifyChecksPending(session.id, newHead);

  // #687: in mock-GitHub mode (staging previews) there is no real repo to
  // clone against the new head — record a gate-passing 'skipped' verdict
  // instead of building staging, so the head-change flow stays clickable.
  if (usesMockGithubForImports()) {
    await visuals.storeChecksSkipped(pool, session.id, newHead,
      'mock GitHub preview — automated checks not run')
      .catch((err) => log.warn('pr-import-sync', 'mock storeChecksSkipped failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      }));
    return;
  }

  let result;
  try {
    result = await staging.buildAndDeployStaging(config, session, app, newHead || 'latest');
  } catch (err) {
    const stagingRecovery = require('./staging-recovery');
    await stagingRecovery.recordStagingBootFailure({
      config, pool, session, commitHash: newHead || null, err,
    }).catch((e) => log.warn('pr-import-sync', 'recordStagingBootFailure failed (non-fatal)', {
      sessionId: session.id, err: e.message,
    }));
    throw err;
  }

  await pool.query(
    `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
    [result.containerId, result.stagingUrl, session.id]
  );
  try {
    await staging.warmStagingCert(session, result.hostname, result.stagingUrl);
  } catch (_) { /* cert warm is best-effort */ }

  await visuals.captureForSession(config, session, app, newHead || null, result, { send: () => {} })
    .catch((err) => log.warn('pr-import-sync', 'checks capture failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
}

module.exports = {
  syncImportedProposal,
  applyHeadChange,
  refreshDriftState,
  rerunChecksForNewHead,
  parseRepo,
};
