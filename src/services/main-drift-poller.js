/**
 * Periodic main-branch drift detector.
 *
 * For every app with a `repo_url` and status='running', polls GitHub for
 * the current `main` SHA and, if it differs from `apps.main_sha`, kicks
 * off the same `staging.rebuildProduction` flow that the dev-chat
 * PR-merge path uses. Closes the gap for repos the platform doesn't own
 * (the import-existing flow) and for any out-of-band pushes by the bot
 * to its own repos.
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
 * Why not bypass `rebuildProduction` and do a lighter rebuild?
 *   By going through the same function the merge path uses, drift
 *   redeploys get the same docker build → recreate → healthcheck flow
 *   and emit the same `app_version_changed` event the UI's commit pill
 *   already listens for. One code path, fewer surprises.
 *
 * Concurrency:
 *   In-memory `inFlight` Set blocks a second poll from re-triggering
 *   a redeploy already running on this process. We deliberately do
 *   NOT flip `apps.status` to a `redeploying` sentinel even though
 *   that'd be more correct — the dev-chat merge path keeps status
 *   at `running` throughout its own rebuilds, and dropping the
 *   `running` flag mid-rebuild would also drop the URL from the
 *   home-page tile (see routes/apps.js — URL is only computed when
 *   status='running'). Matching the merge path's UX matters more
 *   than the small added safety from the row-level claim.
 */
const log = require('./logger');
const { getPool } = require('../db/pool');
const github = require('./github');
const staging = require('./staging');
const { broadcastGlobal } = require('./ws');
const { checkAndResolveConflicts } = require('./conflict-resolver');
const releaseWatch = require('./release-watch');

// 5 minutes default. GitHub's rest API has a 5000 req/hr limit per token,
// so even with ~100 imported apps polling every minute we'd be at ~6000
// calls/hr — well over budget. 5min keeps us comfortably under.
const POLL_INTERVAL_MS = parseInt(process.env.MAIN_DRIFT_POLL_MS, 10) || 5 * 60 * 1000;
// Run the first poll soon after boot so newly-imported apps with stale
// SHAs converge quickly, but not instantly (lets the rest of startup
// settle first).
const FIRST_POLL_DELAY_MS = 30_000;

const inFlight = new Set();

// Back off a rebuild that keeps failing for the same commit.
//
// A drift rebuild that fails is retried on the next tick, forever, at full
// cadence. That is right when the fault is transient (GitHub hiccup, the
// build host busy). It is wrong when the fault is in the commit itself: a
// Dockerfile the build sandbox cannot build, a syntax error on main. That
// fails identically every time, and every attempt costs a full image build
// plus, until staging.js learned to suppress repeats, a "Deploy failed"
// notification to everyone who could fix it. Twenty-five in a night for
// one falling-sands commit.
//
// So: while the sha a rebuild is ATTEMPTING stays the same, each failure
// doubles the wait before the next attempt, from one tick up to a cap. A
// new commit on main is a new attempt and starts over; so does a rebuild
// that succeeds, and the admin's "Check for updates" button ignores the
// wait entirely (an admin asking now has usually just fixed something).
//
// In memory on purpose: the poller runs on the leader, and a restart
// merely costs one extra attempt.
const BACKOFF_MAX_MS = parseInt(process.env.MAIN_DRIFT_BACKOFF_MAX_MS, 10) || 60 * 60 * 1000;
const failedAttempts = new Map(); // app.id -> { sha, failures, notBefore }
let now = () => Date.now();

function backoffRemaining(appId, sha) {
  const entry = failedAttempts.get(appId);
  if (!entry || entry.sha !== sha) return 0;
  return Math.max(0, entry.notBefore - now());
}

function noteFailure(appId, sha) {
  const prev = failedAttempts.get(appId);
  const failures = prev && prev.sha === sha ? prev.failures + 1 : 1;
  const delayMs = Math.min(POLL_INTERVAL_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  failedAttempts.set(appId, { sha, failures, notBefore: now() + delayMs });
  return { failures, delayMs };
}

// main's tip: its sha, and — for the self-hosted row's release watch — when
// it landed and what it says, so a stall can be dated from the merge and
// name its PR. Both are null when the API shape lacks them.
async function fetchRemoteHead(owner, repo) {
  const octokit = await github.getOctokit(owner);
  // `repos.getBranch` returns the tip commit; cheaper than listing
  // commits and authoritative for "what would `git clone` get right
  // now". The default branch is hardcoded to `main` because every
  // platform-managed repo (template + import flow) uses `main` and
  // we'd need to read the repo's default_branch otherwise — not
  // worth the extra call.
  const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch: 'main' });
  const commit = data.commit || {};
  return {
    sha: commit.sha || null,
    committedAt: commit.commit?.committer?.date || commit.commit?.author?.date || null,
    subject: commit.commit?.message || null,
    octokit,
  };
}

// Returns a structured result so callers (the periodic poll loop, and
// the admin "Check for updates" route) can act on or report the
// outcome. The poll loop ignores the return value; the route returns
// it to the client.
//
// `status` is one of:
//   no_drift         — remote HEAD matches `apps.main_sha`, nothing to do
//   redeployed       — drift detected, rebuild + DB update succeeded
//   in_flight        — another caller is already redeploying this app
//   invalid_repo     — `apps.repo_url` couldn't be parsed (shouldn't happen for healthy rows)
//   fetch_failed     — GitHub API call rejected (bot lost access, rate limit, …)
//   rebuild_failed   — rebuildProduction threw (clone/build/healthcheck etc.)
//   backing_off      — drift detected, but the same commit failed to rebuild
//                      recently; not retried until `retryInMs` has passed
//   first_seen       — main_sha was NULL; backfilled, no redeploy
//   release_pending  — the self-hosted row: main is ahead of the running
//                      build, within a release's normal time
//   release_stalled  — the self-hosted row: main is ahead and the release
//                      has not come (services/release-watch.js)
//
// `manual: true` (the admin's "Check for updates") skips the backoff wait.
async function checkAndRedeployOne(config, pool, app, { manual = false } = {}) {
  if (inFlight.has(app.id)) {
    return { status: 'in_flight', slug: app.slug };
  }

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

  // First-time backfill: no prior SHA recorded → just save it. This
  // shouldn't happen often (createApp/rebuildProduction both record
  // the SHA), but if it did we don't want to needlessly redeploy on
  // the very next poll just because main_sha was NULL.
  if (!app.main_sha) {
    await pool.query(
      'UPDATE apps SET main_sha = $1 WHERE id = $2 AND main_sha IS NULL',
      [remoteSha, app.id]
    );
    return { status: 'first_seen', slug: app.slug, sha: remoteSha };
  }

  if (remoteSha === app.main_sha) {
    // Converged, by us or by some other path (a merge, a manual redeploy);
    // whatever was failing is no longer what main points at.
    failedAttempts.delete(app.id);
    // For the platform's own row this is the new build's first look after
    // a release: close out a stall the previous build recorded, if any.
    if (app.self_hosted) await releaseWatch.converged(config, pool, app);
    return { status: 'no_drift', slug: app.slug, sha: remoteSha };
  }

  // The platform's own row. Its main_sha is the build that is serving
  // (seedSelfApp writes GIT_SHA at boot), and its releases come from the
  // repository's Actions workflow through Argo CD, never from here:
  // rebuildProduction on this row can only fail — it did, every tick, during
  // the #2589 gap ("missing required secrets", because the platform's
  // dapp.json declares secrets a child app would hold in app_secrets). What
  // main ahead of the running build means here is "merged, not released",
  // and the watch says so once it is late (services/release-watch.js).
  if (app.self_hosted) {
    return releaseWatch.observe(config, pool, app, head, { octokit: head.octokit });
  }

  const retryInMs = manual ? 0 : backoffRemaining(app.id, remoteSha);
  if (retryInMs > 0) {
    const { failures } = failedAttempts.get(app.id);
    log.debug('drift-poller', 'Drift rebuild backing off after repeated failure', {
      slug: app.slug, attempted: remoteSha.slice(0, 7), failures, retryInMs,
    });
    return { status: 'backing_off', slug: app.slug, from: app.main_sha, attempted: remoteSha, failures, retryInMs };
  }

  // Drift detected. Claim the in-memory slot before doing any work
  // so a second poll firing while we're rebuilding (e.g. an unrefed
  // setInterval running long) doesn't double-trigger.
  inFlight.add(app.id);
  log.info('drift-poller', 'Detected main-branch drift; redeploying', {
    appId: app.id,
    slug: app.slug,
    from: app.main_sha.slice(0, 7),
    to: remoteSha.slice(0, 7),
  });

  try {
    const { containerId, sha } = await staging.rebuildProduction(config, app);
    // No PR number — this redeploy was triggered out-of-band, so we
    // explicitly null `main_pr_number` instead of leaving a stale PR
    // pointer that no longer corresponds to the running SHA.
    await pool.query(
      `UPDATE apps
         SET container_id = $1,
             main_sha = $2,
             main_pr_number = NULL
         WHERE id = $3`,
      [containerId, sha || null, app.id]
    );
    try {
      broadcastGlobal({
        type: 'app_version_changed',
        appSlug: app.slug,
        sha: sha || null,
        prNumber: null,
      });
    } catch (_) { /* ws failures are non-fatal */ }
    failedAttempts.delete(app.id);
    log.info('drift-poller', 'Drift redeploy succeeded', { slug: app.slug, sha: (sha || '').slice(0, 7) });
    // main moved out-of-band (direct push / bot commit). Any promoted PR
    // on this app may now conflict — sweep them through the worker-based
    // resolver (sync + retry). Fire-and-forget so the poll loop isn't
    // blocked behind per-PR worker turns.
    checkAndResolveConflicts(config, { app_id: app.id }).catch((err) => {
      log.error('drift-poller', 'Post-drift conflict resolution failed', { slug: app.slug, err: err.message });
    });
    return { status: 'redeployed', slug: app.slug, from: app.main_sha, to: sha || remoteSha };
  } catch (err) {
    // Don't update main_sha on failure — a later poll sees the same drift
    // and retries, after the backoff above. Eventually the upstream fault
    // (bot lost access, syntax error in the new commit) gets fixed and we
    // converge. No status flip needed.
    const { failures, delayMs } = noteFailure(app.id, remoteSha);
    log.error('drift-poller', 'Drift redeploy failed', {
      slug: app.slug, attempted: remoteSha.slice(0, 7), failures, retryInMs: delayMs, err: err.message,
    });
    return {
      status: 'rebuild_failed', slug: app.slug, from: app.main_sha, attempted: remoteSha,
      failures, retryInMs: delayMs, error: err.message,
    };
  } finally {
    inFlight.delete(app.id);
  }
}

async function poll(config) {
  const pool = getPool(config);
  // Snapshot the candidate set once. Apps whose status changes during
  // the loop are filtered by the per-row claim above, not here.
  const { rows } = await pool.query(
    `SELECT id, slug, repo_url, main_sha, self_hosted, release_stall
       FROM apps
      WHERE repo_url IS NOT NULL AND status = 'running'`
  );
  if (rows.length === 0) return;

  log.debug('drift-poller', 'Polling apps for main drift', { count: rows.length });
  // Sequential, not parallel: rebuild kicks docker build / run / health
  // wait, which can saturate the host. Even if we wanted parallelism,
  // we'd want a small concurrency cap, not "fire all of them". For
  // typical fleets of < 50 apps this finishes in well under the next
  // poll interval.
  for (const app of rows) {
    try {
      await checkAndRedeployOne(config, pool, app);
    } catch (err) {
      log.warn('drift-poller', 'Per-app check threw (continuing)', { slug: app.slug, err: err.message });
    }
  }
}

function start(config) {
  if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
    log.info('drift-poller', 'Disabled (no GitHub bot token)');
    return;
  }
  log.info('drift-poller', 'Starting', { intervalMs: POLL_INTERVAL_MS });
  setTimeout(() => {
    poll(config).catch((err) => log.error('drift-poller', 'Initial poll failed', { err: err.message }));
  }, FIRST_POLL_DELAY_MS).unref?.();
  setInterval(() => {
    poll(config).catch((err) => log.error('drift-poller', 'Poll failed', { err: err.message }));
  }, POLL_INTERVAL_MS).unref?.();
}

module.exports = {
  start,
  poll,
  // Exposed so the admin "Check for updates" button can run the same
  // single-app code path on demand without waiting for the next tick.
  checkAndRedeployOne,
  _forTest: {
    resetBackoff: () => failedAttempts.clear(),
    setClock: (fn) => { now = fn || (() => Date.now()); },
    POLL_INTERVAL_MS,
    BACKOFF_MAX_MS,
  },
};
