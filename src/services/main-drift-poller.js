/**
 * Periodic main-branch drift detector.
 *
 * For every app with a `repo_url` and status='running', polls GitHub for
 * the current `main` SHA and, if it differs from `apps.main_sha`, asks
 * app delivery for a deploy (the app-delivery workflow machine, which
 * every production deploy goes through). Closes the gap for repos the
 * platform doesn't own (the import-existing flow) and for any out-of-band
 * pushes by the bot to its own repos.
 *
 * The platform's own row (apps.self_hosted) is polled too, but never
 * rebuilt from here: its main_sha is the build that is serving, and its
 * releases come from the repository's Actions workflow through Argo CD.
 * Drift on that row means "merged, not released", and goes to
 * services/release-watch.js, which says so once the release is late.
 *
 * Why polling and not webhooks?
 *   Webhooks would be lower-latency but require a public callback URL
 *   and the bot to register them on every repo. Polling at a 5-minute
 *   cadence is "good enough" and keeps the server zero-config behind
 *   any networking topology.
 *
 * Concurrency:
 *   Nothing is asked twice while a deploy of the app runs, and a commit
 *   whose deploy failed is asked again only after a wait. Both are read
 *   from the app's row (deploy_state, last_failure), so another Pod, or
 *   this one after a restart, decides the same. We deliberately do NOT flip
 *   `apps.status` while a deploy runs: dropping `running` mid-deploy would
 *   also drop the URL from the home-page tile (see routes/apps.js — URL is
 *   only computed when status='running').
 */
const log = require('./logger');
const { getPool } = require('../db/pool');
const github = require('./github');
const releaseWatch = require('./release-watch');
const deployFailure = require('./deploy-failure');
const githubBudget = require('./github-budget');
const lifecycle = require('./lifecycle');
const leaderTimers = require('./leader-timers');

// 5 minutes default. GitHub's rest API has a 5000 req/hr limit per token.
// A plain read of every running app's main every five minutes is 12 requests
// an app an hour, which alone spends the whole budget at about 400 apps. Two
// things keep it from doing that now: the read is conditional (fetchRemoteHead
// below; an unchanged main answers 304, which GitHub does not count), and a
// pass is held while the budget is nearly gone (poll below).
const POLL_INTERVAL_MS = parseInt(process.env.MAIN_DRIFT_POLL_MS, 10) || 5 * 60 * 1000;
// Run the first poll soon after boot so newly-imported apps with stale
// SHAs converge quickly, but not instantly (lets the rest of startup
// settle first).
const FIRST_POLL_DELAY_MS = 30_000;

let now = () => Date.now();

// The last answer per repo, for conditional reads: "owner/repo" (lowercased)
// -> { etag, sha, committedAt, subject }. In memory on purpose: a restart
// costs one ordinary read per app.
const headCache = new Map();

// main's tip: its sha, and (for the self-hosted row's release watch) when
// it landed and what it says, so a stall can be dated from the merge and
// name its PR. Both are null when the API shape lacks them.
//
// CONDITIONAL. The read sends If-None-Match with the ETag of the last answer
// for this repo. An unchanged main answers 304 Not Modified, which GitHub
// does not count against the hourly budget, and the cached sha, committedAt
// and subject are returned as if read, with `notModified: true`. Octokit
// reports a 304 as a thrown RequestError, so that is caught here. Every
// caller sees the same shape either way: { sha, committedAt, subject,
// octokit }.
//
// Why not `git ls-remote`: it would leave the REST budget alone entirely,
// but it is a subprocess per app per tick, it cannot give the self-hosted
// row its commit date and subject, and a 304 already costs nothing.
async function fetchRemoteHead(owner, repo) {
  // A read: through the App installation when GITHUB_READS_VIA_APP says so,
  // with the bot token behind it (services/github.js getReadOctokit). A 304
  // is passed through as itself, never retried with the bot token.
  const octokit = await github.getReadOctokit(owner);
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = headCache.get(key);
  // `repos.getBranch` returns the tip commit; cheaper than listing
  // commits and authoritative for "what would `git clone` get right
  // now". The default branch is hardcoded to `main` because every
  // platform-managed repo (template + import flow) uses `main` and
  // we'd need to read the repo's default_branch otherwise, which is not
  // worth the extra call.
  let response;
  try {
    response = await octokit.rest.repos.getBranch({
      owner, repo, branch: 'main',
      ...(cached ? { headers: { 'if-none-match': cached.etag } } : {}),
    });
  } catch (err) {
    if (cached && err && err.status === 304) {
      return {
        sha: cached.sha,
        committedAt: cached.committedAt,
        subject: cached.subject,
        octokit,
        notModified: true,
      };
    }
    throw err;
  }
  const commit = (response && response.data && response.data.commit) || {};
  const head = {
    sha: commit.sha || null,
    committedAt: commit.commit?.committer?.date || commit.commit?.author?.date || null,
    subject: commit.commit?.message || null,
  };
  const headers = (response && response.headers) || {};
  const etag = headers.etag || headers.ETag || null;
  if (etag && head.sha) headCache.set(key, { etag: String(etag), ...head });
  else headCache.delete(key);
  return { ...head, octokit };
}

// Returns a structured result so callers (the periodic poll loop, and
// the admin "Check for updates" route) can act on or report the
// outcome. The poll loop ignores the return value; the route returns
// it to the client.
//
// `status` is one of:
//   no_drift         — remote HEAD matches `apps.main_sha`, nothing to do
//   deploy_requested — drift detected; a deploy was asked of app delivery
//   in_flight        — a deploy of this app is already running
//   invalid_repo     — `apps.repo_url` couldn't be parsed (shouldn't happen for healthy rows)
//   fetch_failed     — GitHub API call rejected (bot lost access, rate limit, …)
//   waits_for_new_commit — main's commit was refused for running as root;
//                      not asked again until main moves
//   backing_off      — drift detected, but the same commit failed to deploy
//                      recently; not asked again until `retryInMs` has passed
//   first_seen       — main_sha was NULL; backfilled, no redeploy
//   release_pending  — the self-hosted row: main is ahead of the running
//                      build, within a release's normal time
//   release_stalled  — the self-hosted row: main is ahead and the release
//                      has not come (services/release-watch.js)
//
// `manual: true` (the admin's "Check for updates") skips both waits, and
// its deploy retries even a commit refused for running as root.
async function checkAndRedeployOne(config, pool, app, { manual = false } = {}) {
  const parsed = github.parseGithubUrl(app.repo_url);
  if (!parsed) {
    log.warn('drift-poller', 'Skipping app with unparseable repo_url', { slug: app.slug, repoUrl: app.repo_url });
    return { status: 'invalid_repo', slug: app.slug, repoUrl: app.repo_url };
  }

  let head;
  try {
    head = await fetchRemoteHead(parsed.owner, parsed.repo);
  } catch (err) {
    log.debug('drift-poller', 'Failed to fetch remote HEAD', {
      slug: app.slug, repo: `${parsed.owner}/${parsed.repo}`, err: err.message,
    });
    return { status: 'fetch_failed', slug: app.slug, error: err.message };
  }
  const remoteSha = head.sha;
  if (!remoteSha) return { status: 'fetch_failed', slug: app.slug, error: 'GitHub returned no SHA' };

  // main's unit suite runs on every new main, merge or direct push (the
  // app's main-check machine, src/workflow/main-check/). Its claim is per
  // commit, so a merge commit the merge already asked about is not run twice.
  if (remoteSha !== app.main_check_sha || !app.main_check_state || app.main_check_state === 'error') {
    await require('../workflow/platform.ts').requestMainCheck({ appId: app.id, sha: remoteSha }).catch((err) => {
      log.warn('drift-poller', 'Main check on a new main could not be asked', { slug: app.slug, err: err.message });
    });
  }

  // First-time backfill: no prior SHA recorded → just save it. This
  // shouldn't happen often (createApp and every deploy record the SHA),
  // but if it did we don't want to needlessly redeploy on the very next
  // poll just because main_sha was NULL.
  if (!app.main_sha) {
    await pool.query(
      'UPDATE apps SET main_sha = $1 WHERE id = $2 AND main_sha IS NULL',
      [remoteSha, app.id]
    );
    return { status: 'first_seen', slug: app.slug, sha: remoteSha };
  }

  if (remoteSha === app.main_sha) {
    // For the platform's own row this is the new build's first look after
    // a release: close out a stall the previous build recorded, if any.
    if (app.self_hosted) await releaseWatch.converged(config, pool, app);
    return { status: 'no_drift', slug: app.slug, sha: remoteSha };
  }

  // The platform's own row. Its main_sha is the build that is serving
  // (seedSelfApp writes GIT_SHA at boot), and its releases come from the
  // repository's Actions workflow through Argo CD, never from here: a
  // deploy of this row can only fail — it did, every tick, during the #2589
  // gap ("missing required secrets", because the platform's dapp.json
  // declares secrets a child app would hold in app_secrets). What main ahead
  // of the running build means here is "merged, not released", and the
  // watch says so once it is late (services/release-watch.js).
  if (app.self_hosted) {
    return releaseWatch.observe(config, pool, app, head, { octokit: head.octokit });
  }

  // This commit's image was refused for running as root, and no retry can
  // change that (deploy-failure.js waitsForNewCommit): wait for a commit that
  // changes the Dockerfile. "Check for updates" still tries it.
  if (!manual && deployFailure.waitsForNewCommit(app.last_failure, remoteSha)) {
    return { status: 'waits_for_new_commit', slug: app.slug, from: app.main_sha, attempted: remoteSha };
  }

  return requestDriftDeploy(config, pool, app, remoteSha, { manual });
}

// How long a commit whose deploy failed waits before the poller asks for it
// again (an admin's "Check for updates" does not wait).
const DRIFT_RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;

// The drift, asked of the app-delivery machine, which runs one deploy of an
// app at a time and writes main_sha when it succeeds. What decides whether
// to ask is durable (the app's deploy_state and last_failure), so another
// Pod or a restarted one reads the same: nothing asked twice while a deploy
// runs, and a commit whose deploy failed asked again after a wait.
async function requestDriftDeploy(config, pool, app, remoteSha, { manual }) {
  const { rows: [row] } = await pool.query('SELECT deploy_state, last_failure FROM apps WHERE id = $1', [app.id]);
  if (row?.deploy_state === 'deploying') return { status: 'in_flight', slug: app.slug };
  const failure = row?.last_failure && typeof row.last_failure === 'object' ? row.last_failure : null;
  const failedAt = failure?.at ? Date.parse(failure.at) : NaN;
  // A failure that names no commit (a clone that failed, a rollover's
  // respawn) counts as this commit's: what failed is what main is now.
  if (!manual && failure && (failure.sha == null || failure.sha === remoteSha) && Number.isFinite(failedAt)
      && now() - failedAt < DRIFT_RETRY_AFTER_FAILURE_MS) {
    return { status: 'backing_off', slug: app.slug, from: app.main_sha, attempted: remoteSha,
      retryInMs: DRIFT_RETRY_AFTER_FAILURE_MS - (now() - failedAt) };
  }
  log.info('drift-poller', 'Detected main-branch drift; asking for a deploy', {
    appId: app.id, slug: app.slug, from: app.main_sha.slice(0, 7), to: remoteSha.slice(0, 7),
  });
  await require('../workflow/platform.ts').requestDeploy(app.id, manual ? 'check_updates' : 'drift');
  // main moved out-of-band: the app's merge queue looks again (a proposal
  // may conflict now, or merge).
  await require('../workflow/platform.ts').wantMerge({ appId: app.id, reason: 'drift' }).catch((err) => {
    log.error('drift-poller', 'Post-drift merge ask failed', { slug: app.slug, err: err.message });
  });
  return { status: 'deploy_requested', slug: app.slug, from: app.main_sha, to: remoteSha };
}

async function poll(config) {
  const pool = getPool(config);
  // Snapshot the candidate set once. Apps whose status changes during
  // the loop are filtered by the per-row claim above, not here.
  const { rows } = await pool.query(
    `SELECT id, slug, repo_url, main_sha, self_hosted, release_stall, release_run, main_check_sha, main_check_state, last_failure
       FROM apps
      WHERE repo_url IS NOT NULL AND status = 'running'`
  );
  if (rows.length === 0) return { apps: 0, checked: 0, held: false };

  log.debug('drift-poller', 'Polling apps for main drift', { count: rows.length });
  // Sequential, not parallel: rebuild kicks docker build / run / health
  // wait, which can saturate the host. Even if we wanted parallelism,
  // we'd want a small concurrency cap, not "fire all of them". For
  // typical fleets of < 50 apps this finishes in well under the next
  // poll interval.
  //
  // Background work: while GitHub's hourly budget is nearly used up, the
  // rest of the pass waits for the next tick after the reset, so what
  // people start keeps the reserve. Asked before every app, because a
  // first pass after a restart has no ETags yet and costs one read each.
  // services/github-budget.js logs the hold once per window, not per app.
  // The admin's "Check for updates" calls checkAndRedeployOne directly and
  // is never held.
  let checked = 0;
  for (const app of rows) {
    // A redeploy started now would die with the process; the next leader's
    // first poll picks the rest up.
    if (lifecycle.isShuttingDown()) {
      return { apps: rows.length, checked, held: false, stopped: true };
    }
    if (!githubBudget.budgetAllows('background')) {
      log.debug('drift-poller', 'Pass held for the GitHub budget', { checked, left: rows.length - checked });
      return { apps: rows.length, checked, held: true };
    }
    checked += 1;
    try {
      await checkAndRedeployOne(config, pool, app);
    } catch (err) {
      log.warn('drift-poller', 'Per-app check threw (continuing)', { slug: app.slug, err: err.message });
    }
  }
  return { apps: rows.length, checked, held: false };
}

function start(config) {
  if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
    log.info('drift-poller', 'Disabled (no GitHub bot token)');
    return;
  }
  log.info('drift-poller', 'Starting', { intervalMs: POLL_INTERVAL_MS });
  // A leader timer (services/leader-timers.js): no poll starts once shutdown
  // has begun, and one under way is given the drain to finish.
  leaderTimers.every('main-drift-poller', () => poll(config)
    .catch((err) => log.error('drift-poller', 'Poll failed', { err: err.message })),
  POLL_INTERVAL_MS, { firstDelayMs: FIRST_POLL_DELAY_MS });
}

module.exports = {
  start,
  poll,
  // Exposed so the admin "Check for updates" button can run the same
  // single-app code path on demand without waiting for the next tick.
  checkAndRedeployOne,
  _forTest: {
    resetHeadCache: () => headCache.clear(),
    setClock: (fn) => { now = fn || (() => Date.now()); },
    POLL_INTERVAL_MS,
  },
};
