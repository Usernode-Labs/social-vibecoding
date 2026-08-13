'use strict';

// #687 Slice 3 — sync poller for IMPORTED PR proposals.
//
// An imported row tracks a GitHub PR whose branch the platform does
// NOT own; the external author keeps pushing to it. Votes and checks are
// cast/run against a specific commit (imported_pr_head_sha), so when the
// author pushes new commits the head moves. This module notices that on the
// next sweeper pass and advances the row to the new head:
//
//   - update imported_pr_head_sha to the new head,
//   - once the row is promoted, clear the old-head vote tally and request
//     re-review,
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

// Human label for the proposal in thread notes ("PR #123 — Fix the footer").
function prLabel(session) {
  return session.pr_title
    ? `PR #${session.pr_number} — ${session.pr_title}`
    : `PR #${session.pr_number}`;
}

// #866: post a note into an imported proposal's VISIBLE thread.
//
// The native staging flows narrate build start/finish/failure into
// chat_session_messages — the dev-chat transcript. An imported proposal has
// no dev chat (nobody in the app owns its session), so those rows render
// nowhere and every minute of a multi-minute build looks like nothing
// happening. The thread an imported proposal DOES have is the group
// discussion keyed ('session', id) — the same channel checkAndMerge and the
// head-change note use. Best-effort by construction: narration must never
// affect the build's outcome.
async function postProposalNote(pool, session, text, metadata) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(
      pool, session.app_id, text, 'system',
      { prNumber: session.pr_number || null, ...(metadata || {}) },
      { type: 'session', ref: session.id }
    );
  } catch (err) {
    log.warn('pr-import-sync', 'proposal thread note failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }
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

// Apply a head change: advance the stored SHA, refresh drift, and re-run
// SHA-pinned checks. A promoted row also resets its old-head tally and posts
// the re-review note; an active import has no votes to invalidate yet.
async function applyHeadChange({ config, pool, session, pr, repo, newHead, oldHead }) {
  const { sendSystemMessage, pushVoteUpdate } = require('./ws');
  const upForVote = session.status === 'promoted' || session.status === 'merging';

  // 1. Advance the head the checks/votes now describe.
  await pool.query(
    `UPDATE chat_sessions SET imported_pr_head_sha = $1 WHERE id = $2`,
    [newHead, session.id]
  );
  session.imported_pr_head_sha = newHead;

  const label = prLabel(session);
  if (upForVote) {
    // Every existing vote describes the superseded code. The gate is also
    // head-scoped; this cleanup keeps the visible tally honest.
    await pool.query(`DELETE FROM pr_votes WHERE session_id = $1`, [session.id]);
    await require('./app-admins').refreshExplicitApproval(pool, session, session);
    await pool.query(
      `UPDATE chat_sessions SET stale_notified_at = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    await sendSystemMessage(
      pool, session.app_id,
      `${label} was updated on GitHub — earlier votes were cleared, please re-review the new changes. `
        + 'The staging preview and automated checks are being rebuilt against the new commit.',
      'system',
      { headChanged: true, prNumber: session.pr_number, headSha: newHead },
      { type: 'session', ref: session.id }
    ).catch((err) => log.warn('pr-import-sync', 're-review note failed', {
      sessionId: session.id, err: err.message,
    }));
    try {
      pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug || null, merged: false });
    } catch (_) { /* ws failures are non-fatal */ }
  } else {
    await sendSystemMessage(
      pool, session.app_id,
      `${label} was updated on GitHub. The staging preview and automated checks are being rebuilt against the new commit.`,
      'system',
      { headChanged: true, prNumber: session.pr_number, headSha: newHead },
      { type: 'session', ref: session.id }
    ).catch((err) => log.warn('pr-import-sync', 'head-change note failed', {
      sessionId: session.id, err: err.message,
    }));
  }

  // 5. Refresh behind_main / conflict snapshot the way the native path does.
  await refreshDriftState({ pool, session, pr, repo }).catch((err) =>
    log.warn('pr-import-sync', 'drift refresh failed', { sessionId: session.id, err: err.message }));

  // 6. Re-run the proposal checks against the NEW head — the SHA-pinned
  //    staging build from Slice 1 (storeChecks / storeChecksSkipped).
  await rerunChecksForNewHead({ config, pool, session, newHead }).catch((err) =>
    log.warn('pr-import-sync', 'checks re-run failed', { sessionId: session.id, err: err.message }));

  log.info('pr-import-sync', 'Imported PR head changed — refreshed preview and checks', {
    sessionId: session.id, prNumber: session.pr_number, oldHead, newHead, upForVote,
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
  await visuals.setChecksPending(pool, session.id, newHead, 'building', 'pr-import')
    .catch((err) => log.warn('pr-import-sync', 'setChecksPending failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
  visuals.notifyChecksPending(session.id, newHead, 'building', 'pr-import');

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
    notifyStagingFailed({ session, app });
    throw err;
  }

  // #866: the author can withdraw (or the group can close) the proposal
  // while a minutes-long rebuild runs. See kickImportedChecks for the full
  // rationale — persisting a preview onto a no-longer-open row leaks a
  // container and re-arms a Preview button on a dead proposal.
  if (!(await stillOpenForPreview(pool, session))) {
    await discardStagingResult({ staging, session, app, result });
    return;
  }

  await pool.query(
    `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
    [result.containerId, result.stagingUrl, session.id]
  );
  try {
    await staging.verifyStagingEdge(session, result.hostname, result.stagingUrl);
  } catch (_) { /* edge verification is best-effort */ }

  await visuals.captureForSession(config, session, app, newHead || null, result, { send: () => {}, trigger: 'pr-import' })
    .catch((err) => log.warn('pr-import-sync', 'checks capture failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
}

// #866: is this proposal still one a staging preview belongs to?
//
// Re-read from the DB rather than trusting the in-memory `session` — it was
// loaded before a build that takes minutes. A withdrawn proposal is
// 'archived'; a merged one is 'merged'. Fails OPEN (returns true) if the row
// can't be read, so a transient DB hiccup never throws away a good build.
async function stillOpenForPreview(pool, session) {
  try {
    const { rows } = await pool.query(
      `SELECT status FROM chat_sessions WHERE id = $1`, [session.id]
    );
    const status = rows[0] ? rows[0].status : null;
    if (rows.length && status !== 'active' && status !== 'promoted' && status !== 'merging') {
      log.info('pr-import-sync', 'Imported PR is no longer live while its preview was building — discarding the build', {
        sessionId: session.id, status,
      });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('pr-import-sync', 'post-build status re-check failed — keeping the build', {
      sessionId: session.id, err: err.message,
    });
    return true;
  }
}

// #866: throw away a preview that finished building for a proposal which is
// no longer open. Without this the row keeps a staging_container_id nothing
// will ever reclaim (the idle GC skips 'archived'/'merged' rows) and the card
// re-grows a Preview button pointing at a withdrawn proposal. The fresh
// container id + URL are threaded in explicitly: teardownStaging derives the
// staging DB name from `staging_url`, and the persisted row deliberately
// never got one.
async function discardStagingResult({ staging, session, app, result }) {
  try {
    await staging.teardownStaging(
      { ...session, staging_container_id: result.containerId, staging_url: result.stagingUrl },
      { slug: app.slug }
    );
  } catch (err) {
    log.warn('pr-import-sync', 'discarding staging build failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }
}

// #866: flip open proposal cards from "Preview building…" to "Preview
// unavailable" the moment a build fails, instead of leaving a spinner up
// until something else happens to refetch.
//
// The narration itself is NOT here: recordStagingBootFailure (called
// immediately before this, on both build paths) is the one chokepoint that
// posts the reason, and it is imported-aware — it routes an imported row's
// note to the group thread rather than the invisible dev-chat transcript,
// and it dedups to one post per failure streak. Duplicating the note here
// would double-post every import-time failure.
function notifyStagingFailed({ session, app }) {
  try {
    const { pushSessionUpdate } = require('./ws');
    pushSessionUpdate({
      action: 'staging_failed', sessionId: session.id,
      appSlug: (app && app.slug) || session.app_slug || null,
    });
  } catch (e) {
    log.warn('pr-import-sync', 'staging_failed notify failed (non-fatal)', {
      sessionId: session.id, err: e.message,
    });
  }
}

// #687 Slice 1 / #846 — the IMPORT-TIME checks kick. Called (un-awaited) by
// POST /api/apps/:slug/pr-import once the proposal row exists, so the route
// can answer immediately while the SHA-pinned staging build runs behind it.
// Sibling of rerunChecksForNewHead above — same sequence, same mock-mode
// short-circuit — kept here rather than inline in the route so it is
// testable on its own.
//
// #846: the staging_ready broadcast at the end is what makes an open
// proposal page grow its Preview pill the moment the build lands, instead of
// waiting minutes for the checks verdict to arrive and trigger a refetch.
// It must fire AFTER the staging_url persist: Caddy's on-demand TLS gate
// only approves a host once chat_sessions.staging_url equals it.
//
// Never throws — every failure is logged, and a genuine build failure is
// recorded as a terminal 'error' verdict by recordStagingBootFailure so the
// merge gate doesn't dead-end on a NULL/pending state.
async function kickImportedChecks({ config, pool, session, app, headSha }) {
  const visuals = require('./visuals');
  const staging = require('./staging');
  try {
    await visuals.setChecksPending(pool, session.id, headSha || null, 'building', 'pr-import')
      .catch((err) => log.warn('pr-import-sync', 'import setChecksPending failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      }));
    visuals.notifyChecksPending(session.id, headSha || null, 'building', 'pr-import');

    // #687 Slice 6: in mock-GitHub mode there is no real repo to clone, so
    // skip the staging build entirely and record a gate-passing 'skipped'
    // verdict — the imported proposal shows a neutral (mergeable) check so
    // the whole preview flow (import → vote → merge) is exercisable.
    if (usesMockGithubForImports()) {
      await visuals.storeChecksSkipped(pool, session.id, headSha || null,
        'mock GitHub preview — automated checks not run')
        .catch((err) => log.warn('pr-import-sync', 'import mock storeChecksSkipped failed (non-fatal)', {
          sessionId: session.id, err: err.message,
        }));
      return;
    }

    // #866: say out loud that a build started. This is the note that makes
    // the minutes between "proposal appeared" and "Preview button appeared"
    // legible — the card's "Preview building…" pill says the same thing, and
    // this leaves a timestamped trace in the thread for anyone who arrives
    // later or was looking at the discussion rather than the card.
    await postProposalNote(
      pool, session,
      `Building a staging preview for ${prLabel(session)} — this usually takes a few minutes. `
        + 'The automated checks run against it, and a Preview button appears on this proposal when it\'s ready.',
      { stagingBuild: 'started', headSha: headSha || null }
    );

    let result;
    try {
      result = await staging.buildAndDeployStaging(config, session, app, headSha || 'latest');
    } catch (err) {
      const stagingRecovery = require('./staging-recovery');
      await stagingRecovery.recordStagingBootFailure({
        config, pool, session, commitHash: headSha || null, err,
      }).catch((e) => log.warn('pr-import-sync', 'import recordStagingBootFailure failed (non-fatal)', {
        sessionId: session.id, err: e.message,
      }));
      notifyStagingFailed({ session, app });
      throw err;
    }

    // #866: a proposal can be withdrawn (or merged) during the build. The
    // row we loaded minutes ago says 'promoted'; re-read before writing a
    // preview onto it. Persisting anyway would (a) leak the container —
    // the idle-GC sweep skips non-open statuses, so nothing would ever
    // reclaim it — and (b) put a live Preview button back on a card whose
    // vote is over.
    if (!(await stillOpenForPreview(pool, session))) {
      await discardStagingResult({ staging, session, app, result });
      return;
    }

    await pool.query(
      `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
      [result.containerId, result.stagingUrl, session.id]
    );
    await staging.verifyStagingEdge(session, result.hostname, result.stagingUrl);

    // #866: and that it landed. The URL rides in metadata rather than the
    // body — a preview host is long, ugly, and rotates on every rebuild,
    // while the Preview button on the card is the durable way in.
    await postProposalNote(
      pool, session,
      `The staging preview for ${prLabel(session)} is ready — use the Preview button on this proposal to try the change. Automated checks are running against it now.`,
      { stagingBuild: 'ready', headSha: headSha || null, stagingUrl: result.stagingUrl }
    );

    // Tell any open proposal page the preview is live (see above for why
    // this is ordered after the persist). No chat_session_messages row: an
    // imported proposal has no transcript surface to render it.
    try {
      const { broadcastGlobal, pushSessionUpdate } = require('./ws');
      broadcastGlobal({
        type: 'session_event', sessionId: session.id,
        event: 'staging_ready', url: result.stagingUrl,
      });
      pushSessionUpdate({
        action: 'staging_ready', sessionId: session.id, appSlug: app.slug,
      });
    } catch (err) {
      log.warn('pr-import-sync', 'import staging_ready notify failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    }

    visuals.captureForSession(config, session, app, headSha || null, result, { trigger: 'pr-import' })
      .catch((err) => log.warn('pr-import-sync', 'import visuals capture failed', {
        sessionId: session.id, err: err.message,
      }));
  } catch (err) {
    log.warn('pr-import-sync', 'import staging build failed', {
      sessionId: session.id, err: err.message,
    });
  }
}

module.exports = {
  syncImportedProposal,
  applyHeadChange,
  refreshDriftState,
  rerunChecksForNewHead,
  kickImportedChecks,
  parseRepo,
  // #866: exported for the thread-narration + withdrawn-mid-build tests.
  prLabel,
  postProposalNote,
  stillOpenForPreview,
  discardStagingResult,
  notifyStagingFailed,
};
