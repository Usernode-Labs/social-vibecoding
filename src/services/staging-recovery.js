'use strict';

// Shared staging recovery helpers — the single source of truth for
// "does this session's staging preview need rebuilding?" and "rebuild
// it from the branch's latest commit". Extracted from server.js so the
// three callers never drift apart:
//   1. startup recovery        (server.js recoverSessions)
//   2. periodic heal sweep     (server.js sweeper Pass 3)
//   3. on-demand preview click (routes/sessions.js ensure-staging)
//
// Behaviour is identical to the former in-server implementations.

const log = require('./logger');

// Does a session need its staging preview (re)built?
//
// THREE failure shapes leave a card without a working preview:
//   1. staging_url IS NULL — GC reclaimed it (or it was GC'd before
//      promotion). The Preview button is hidden (gated on staging_url).
//   2. staging_url is set but the staging container is gone — the
//      Preview button renders but the hostname has no upstream, so the
//      iframe 502s / fails to connect. (Pre-wildcard-Caddy this also
//      surfaced as "secure connection failed" when the per-host route
//      was dropped; routing is now container-name based so the only
//      remaining cause is a missing/stopped container.)
//   3. #851: the container is running, but its ENVIRONMENT is out of date —
//      it was assembled by an older platform build. This shape is invisible
//      to a liveness check and is why #850 needed a manual sweep at all: a
//      pre-#848 preview boots fine and then cannot recognise the signed-in
//      user, so the on-demand route answered {status:'ready'} and opened the
//      app's login screen. Detected by comparing the `usernode.env.fp` label
//      stamped at build time (services/staging-env.js) against the digest the
//      platform would produce today.
// All three are healable by a rebuild. We deliberately do NOT rebuild on a
// merely-unhealthy-but-running container (that's a 502, an app bug, not
// a missing preview) to avoid churn.
//
// `config` is optional. Without it the staleness comparison is skipped and
// the verdict is liveness-only — the pre-#851 behaviour. Every real caller
// passes one; the fallback keeps the function usable from a context that has
// no config and makes the added parameter non-breaking.
async function stagingNeedsRebuild(session, { config = null } = {}) {
  if (!session.staging_url) return true;
  if (!session.staging_container_id) return true;
  const docker = require('./docker');
  const state = await docker.inspectContainer(session.staging_container_id);
  // The inspect could not be PERFORMED (unreachable daemon). Distinct from
  // 'not_found', which means the container is genuinely gone and is handled
  // below by the status check. Leave the preview strictly alone here: a docker
  // hiccup must never be read as evidence that a preview is broken or stale,
  // because the heal sweep and the reap pass both act on this verdict.
  if (!state) return false;
  // Covers 'not_found' (shape 2 — the container is gone) as well as
  // exited/dead/created.
  if (state.status !== 'running') return true;
  if (!config) return false;

  const stagingEnv = require('./staging-env');
  const expected = stagingEnv.expectedStagingFingerprint(config);
  const actual = state.labels[stagingEnv.LABEL_ENV_FP] || null;
  if (actual === expected) return false;

  log.info('staging-recovery', 'Preview env is stale — rebuild needed', {
    sessionId: session.id, expected, actual,
  });
  return true;
}

// Rebuild the staging preview for a single session that has a branch +
// commits ahead of main but a NULL/dead staging_url. Shared by the
// startup recovery sweep (recoverSessions), the periodic sweeper's
// staging-heal pass (Pass 3), and the on-demand ensure-staging route so
// they never drift apart.
//
// Returns 'built' on success, 'skipped' when there's nothing to do (no
// owner/repo, no bot token, branch not ahead of main), or throws on a
// genuine build failure (caller logs + decides whether to retry).
//
// Creates a PR only when one is missing — the active-session recovery case
// where CC finished but post-processing died before opening the PR.
// 'promoted'/'merging' sessions always already have one, so that branch is
// a no-op for them. On success it pings BOTH the dev-chat tail
// (broadcastGlobal session_event) AND the group-chat vote panel
// (pushSessionUpdate) so the Preview button reappears on the PR card
// without anyone needing to reload.
async function rebuildSessionStaging({ config, pool, session, reason }) {
  const staging = require('./staging');
  const { broadcastGlobal, pushSessionUpdate } = require('./ws');

  const [, owner, repo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!owner || !repo) {
    // #461: every no-op below used to return silently, leaving check_state
    // NULL — the merge gate blocks NULL as "still running its tests" and the
    // stuck-checks sweeper re-picked the row every pass, re-skipped, forever.
    // Record an explicit terminal verdict instead: 'skipped' (gate-passing)
    // when checks genuinely cannot/need not run, 'error' (retryable with
    // backoff) when the cause is transient.
    await recordChecksSkipped({
      config, pool, session, commitSha: session.checks_commit_sha || null,
      reason: 'checks unavailable — GitHub is not configured',
    });
    return 'skipped';
  }

  const pat = process.env.GITHUB_BOT_TOKEN;
  if (!pat) {
    await recordChecksSkipped({
      config, pool, session, commitSha: session.checks_commit_sha || null,
      reason: 'checks unavailable — GitHub is not configured',
    });
    return 'skipped';
  }

  const { Octokit } = await import('@octokit/rest');
  const ok = new Octokit({ auth: pat });

  // Only build when the branch actually carries work — a branch level with
  // (or behind) main has nothing to preview.
  let compare;
  try {
    const { data } = await ok.rest.repos.compareCommits({
      owner, repo, base: 'main', head: session.branch_name,
    });
    compare = data;
  } catch (err) {
    // Transient (API hiccup) or a deleted branch — record a retryable
    // 'error' verdict so the existing exponential backoff +
    // CHECK_MAX_AUTO_RETRIES bound the retries instead of the old silent
    // infinite skip loop (#461).
    const visuals = require('./visuals');
    await visuals.storeChecks(
      pool, session.id, session.checks_commit_sha || null,
      { state: 'error', results: [] },
      `could not compare ${session.branch_name} with main: ${err.message}`.slice(0, 280)
    ).catch((e) => log.warn('staging-recovery', 'compare-failure verdict write failed', {
      sessionId: session.id, err: e.message,
    }));
    return 'skipped';
  }

  if (compare.ahead_by === 0) {
    await recordChecksSkipped({
      config, pool, session,
      commitSha: compare.base_commit?.sha || session.checks_commit_sha || null,
      reason: 'branch has no commits beyond main — nothing to test',
    });
    return 'skipped';
  }

  log.info('staging-recovery', 'Rebuilding staging preview', {
    sessionId: session.id, status: session.status, branch: session.branch_name,
    aheadBy: compare.ahead_by, reason,
  });

  const commitHash = compare.commits[compare.commits.length - 1]?.sha || 'latest';
  const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };

  // Create PR if missing (active-session recovery only). Route through
  // applyPrMetadata — NOT a bare createPR — so the PR gets a real
  // generated title/body and pr_title/session_title are persisted. A
  // bare createPR here used to mint PRs titled "Changes on <branch>"
  // with pr_title left NULL; the promote path then trusted pr_number's
  // presence and skipped its own metadata pass, so the throwaway title
  // stuck (the UI then renders its own "Change by <user>" NULL-fallback).
  if (!session.pr_number) {
    try {
      // username + latest user message give applyPrMetadata the same
      // signals the live dev-turn path has; without the username the
      // fallback title would read "undefined's changes".
      const { rows: ctxRows } = await pool.query(
        `SELECT u.username,
                (SELECT content FROM chat_session_messages
                  WHERE session_id = cs.id AND role = 'user'
                  ORDER BY id DESC LIMIT 1) AS last_user_message
           FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.id = $1`,
        [session.id]
      );
      const username = ctxRows[0]?.username || session.username || 'someone';
      const recoveredUserMessage = ctxRows[0]?.last_user_message || '';
      const prMetadata = require('./pr-metadata');
      await prMetadata.applyPrMetadata({
        pool, session, repoOwner: owner, repoName: repo,
        userMessage: recoveredUserMessage,
        ccSummary: '',
        username,
        userId: session.user_id,
        broadcast: (event, data) =>
          broadcastGlobal({ type: 'session_event', sessionId: session.id, event, ...data }),
      });
    } catch (err) {
      log.warn('staging-recovery', 'Recovery PR creation via applyPrMetadata failed', {
        sessionId: session.id, code: err.code || null,
        ...require('./github').describeGithubError(err),
      });
    }
  }

  let stagingResult;
  try {
    stagingResult = await staging.buildAndDeployStaging(config, session, app, commitHash);
  } catch (err) {
    // The staging preview failed to build or boot. Before #237's fix this
    // threw straight past the checks capture below, leaving check_state NULL
    // — the merge gate fail-closes on NULL with no signal and the sweeper
    // retried the identical failing build forever (silent deadlock). Record
    // a TERMINAL 'error' verdict carrying a concise reason + nudge the owner
    // once per streak, then re-throw so callers keep their existing WARN
    // logging + retry-cooldown bookkeeping.
    await recordStagingBootFailure({ config, pool, session, commitHash, err }).catch((e) =>
      log.warn('staging-recovery', 'recordStagingBootFailure failed (non-fatal)', {
        sessionId: session.id, err: e.message,
      }));
    throw err;
  }
  await pool.query(
    `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
    [stagingResult.containerId, stagingResult.stagingUrl, session.id]
  );

  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3)`,
    [
      session.id,
      reason === 'startup' ? 'Staging recovered after restart' : 'Staging preview rebuilt',
      JSON.stringify({ stagingUrl: stagingResult.stagingUrl }),
    ]
  );

  broadcastGlobal({
    type: 'session_event', sessionId: session.id,
    event: 'staging_ready', url: stagingResult.stagingUrl,
    // #127: keep any open dev-chat's testing affordances in sync after a
    // staging rebuild (the guidance itself lives on the session row).
    testingMd: session.testing_md || null,
    testingPath: session.testing_path || null,
  });
  pushSessionUpdate({ action: 'staging_ready', sessionId: session.id, appSlug: session.app_slug });

  // #447: re-run the proposal checks ("CI for proposals") against the fresh
  // build. Before this, rebuildSessionStaging — the shared path behind
  // startup recovery, the heal sweep (Pass 3), and the on-demand
  // ensure-staging preview click — rebuilt the preview but never refreshed
  // check_state, so a proposal whose staging was GC'd and rebuilt kept a
  // stale 'pending'/NULL verdict and stayed blocked from merging forever.
  // Fire-and-forget with the same failure-swallowing as the dev-turn
  // callers; captureForSession is itself _inFlight-guarded so a concurrent
  // live capture isn't duplicated.
  const visuals = require('./visuals');
  visuals.captureForSession(config, session, app, commitHash, stagingResult, { send: () => {} })
    .catch((err) => log.warn('staging-recovery', 'Post-rebuild checks capture failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));

  log.info('staging-recovery', 'Staging preview rebuilt', { sessionId: session.id, url: stagingResult.stagingUrl, reason });
  return 'built';
}

// #461: record a terminal, gate-passing 'skipped' checks verdict (with its
// reason) for a session whose checks genuinely cannot / need not run, then
// tell open clients and re-drive the auto-merge drain — a proposal whose vote
// already passed should merge the moment its checks resolve to 'skipped',
// exactly as it would on 'passing'. Best-effort: never throws.
async function recordChecksSkipped({ config, pool, session, commitSha, reason }) {
  const visuals = require('./visuals');
  try {
    await visuals.storeChecksSkipped(pool, session.id, commitSha, reason);
  } catch (err) {
    log.warn('staging-recovery', 'skipped-verdict write failed', {
      sessionId: session.id, err: err.message,
    });
    return;
  }
  log.info('staging-recovery', 'Checks marked skipped', { sessionId: session.id, reason });
  try {
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({ type: 'session_event', sessionId: session.id, event: 'checks_ready', state: 'skipped' });
  } catch (err) {
    log.warn('staging-recovery', 'skipped-verdict notify failed', { sessionId: session.id, err: err.message });
  }
  visuals.maybeAutoMergeAfterChecks(config, pool, session, 'skipped');
}

// #237: record a staging build/boot failure as a terminal proposal-checks
// 'error' verdict (with a concise reason) and nudge the proposal owner — once
// per failure streak — so an app that crashes only in staging no longer
// dead-ends as a silent, unexplained "votes passed but nothing merges".
// Idempotent across retries: storeChecks bumps consecutive_check_failures +
// schedules the next backoff retry; the owner notification + thread post fire
// only on the first failure of a streak (check_error_notified_at gate), which
// setChecksPending clears when a new commit is pushed.
async function recordStagingBootFailure({ config, pool, session, commitHash, err }) {
  const visuals = require('./visuals');
  const detail = visuals.summarizeBootFailure(err);

  await visuals.storeChecks(pool, session.id, commitHash, { state: 'error', results: [] }, detail);

  // Read back the streak bookkeeping to decide whether this is the first
  // failure of the streak (→ notify + post) or a quiet backoff retry.
  let row = null;
  try {
    const { rows } = await pool.query(
      `SELECT user_id, app_id, pr_number, consecutive_check_failures, check_error_notified_at
         FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    row = rows[0] || null;
  } catch (e) {
    log.warn('staging-recovery', 'boot-failure readback failed', { sessionId: session.id, err: e.message });
  }

  log.warn('staging-recovery', 'Staging preview failed to boot — recorded checks error', {
    sessionId: session.id,
    failures: row ? row.consecutive_check_failures : null,
    detail,
  });

  const alreadyNotified = row && row.check_error_notified_at;
  if (!row || alreadyNotified) return;

  // First failure of this streak: stamp so we don't re-nudge on every retry.
  await pool.query(
    `UPDATE chat_sessions SET check_error_notified_at = NOW() WHERE id = $1`,
    [session.id]
  ).catch(() => {});

  // Visible-in-thread record of why the preview won't come up.
  try {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [
        session.id,
        `⚠️ Staging preview failed to start, so automated checks can't run and this proposal can't merge yet. Reason: ${detail}`,
        JSON.stringify({ checkError: true, detail }),
      ]
    );
  } catch (e) {
    log.warn('staging-recovery', 'boot-failure thread post failed', { sessionId: session.id, err: e.message });
  }

  // Notify the owner + refresh any open card's checks badge.
  try {
    const notifications = require('./notifications');
    const created = await notifications.createCheckFailedNotification(pool, {
      userId: row.user_id, appId: row.app_id, sessionId: session.id,
    });
    if (created.length) await notifications.hydrateAndPush(pool, created[0]);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({ type: 'session_event', sessionId: session.id, event: 'checks_ready', state: 'error' });
  } catch (e) {
    log.warn('staging-recovery', 'boot-failure notify failed', { sessionId: session.id, err: e.message });
  }
}

// #447: reconcile a single session's proposal checks. Used by the manual
// "Re-run checks" endpoint and the boot-time / periodic stale-check sweep.
// If the staging preview is missing or dead, rebuild it (the rebuild now
// re-runs the checks via the capture fired above). Otherwise the preview is
// healthy, so re-run the checks directly against the live container. Both
// paths are fire-and-forget at the capture layer and never throw for the
// no-op cases (no repo / no bot token → rebuildSessionStaging returns
// 'skipped'); a genuine build failure propagates to the caller.
async function recheckSessionChecks({ config, pool, session, reason }) {
  // #607: stamp 'pending' + tell open clients the moment the re-run is
  // requested — a needed staging rebuild can take minutes, and before this
  // the badge kept showing the stale verdict (or nothing at all for a
  // NULL-verdict row) the whole time. Best-effort; captureForSession
  // re-stamps idempotently (same commit sha → failure streak preserved).
  {
    const visuals = require('./visuals');
    await visuals.setChecksPending(pool, session.id, session.checks_commit_sha || null)
      .catch((err) => log.warn('staging-recovery', 'recheck setChecksPending failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      }));
    visuals.notifyChecksPending(session.id, session.checks_commit_sha || null);
  }
  if (await stagingNeedsRebuild(session, { config })) {
    // rebuildSessionStaging owns the capture (see above) and the no-op
    // short-circuits (missing owner/repo or bot token → 'skipped').
    return rebuildSessionStaging({ config, pool, session, reason });
  }
  // Healthy preview: re-run the checks directly. captureForSession reaches
  // the staging container by name over the docker network, so it needs only
  // the app descriptor + a commit to stamp (best-effort: the commit the
  // prior verdict described). _inFlight-guarded internally.
  const visuals = require('./visuals');
  const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
  visuals.captureForSession(config, session, app, session.checks_commit_sha || null, null, { send: () => {} })
    .catch((err) => log.warn('staging-recovery', 'Direct checks re-run failed (non-fatal)', {
      sessionId: session.id, reason, err: err.message,
    }));
  return 'rechecked';
}

module.exports = {
  stagingNeedsRebuild,
  rebuildSessionStaging,
  recheckSessionChecks,
  // #461: exported so the dev-turn tails (routes/sessions.js) and the
  // post-promote build catch (routes/votes.js) can record an 'error'
  // verdict when their staging build fails, instead of leaving the
  // previous commit's check_state in place.
  recordStagingBootFailure,
  recordChecksSkipped,
};
