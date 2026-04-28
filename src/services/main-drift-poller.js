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

// 5 minutes default. GitHub's rest API has a 5000 req/hr limit per token,
// so even with ~100 imported apps polling every minute we'd be at ~6000
// calls/hr — well over budget. 5min keeps us comfortably under.
const POLL_INTERVAL_MS = parseInt(process.env.MAIN_DRIFT_POLL_MS, 10) || 5 * 60 * 1000;
// Run the first poll soon after boot so newly-imported apps with stale
// SHAs converge quickly, but not instantly (lets the rest of startup
// settle first).
const FIRST_POLL_DELAY_MS = 30_000;

const inFlight = new Set();

async function fetchRemoteHeadSha(owner, repo) {
  const octokit = await github.getOctokit(owner);
  // `repos.getBranch` returns the tip commit; cheaper than listing
  // commits and authoritative for "what would `git clone` get right
  // now". The default branch is hardcoded to `main` because every
  // platform-managed repo (template + import flow) uses `main` and
  // we'd need to read the repo's default_branch otherwise — not
  // worth the extra call.
  const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch: 'main' });
  return data.commit?.sha || null;
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
//   first_seen       — main_sha was NULL; backfilled, no redeploy
async function checkAndRedeployOne(config, pool, app) {
  if (inFlight.has(app.id)) {
    return { status: 'in_flight', slug: app.slug };
  }

  const parsed = github.parseGithubUrl(app.repo_url);
  if (!parsed) {
    log.warn('drift-poller', 'Skipping app with unparseable repo_url', { slug: app.slug, repoUrl: app.repo_url });
    return { status: 'invalid_repo', slug: app.slug, repoUrl: app.repo_url };
  }

  let remoteSha;
  try {
    remoteSha = await fetchRemoteHeadSha(parsed.owner, parsed.repo);
  } catch (err) {
    log.debug('drift-poller', 'Failed to fetch remote HEAD', {
      slug: app.slug, repo: `${parsed.owner}/${parsed.repo}`, err: err.message,
    });
    return { status: 'fetch_failed', slug: app.slug, error: err.message };
  }
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
    return { status: 'no_drift', slug: app.slug, sha: remoteSha };
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
    log.info('drift-poller', 'Drift redeploy succeeded', { slug: app.slug, sha: (sha || '').slice(0, 7) });
    return { status: 'redeployed', slug: app.slug, from: app.main_sha, to: sha || remoteSha };
  } catch (err) {
    log.error('drift-poller', 'Drift redeploy failed', { slug: app.slug, err: err.message });
    // Don't update main_sha on failure — the next poll will see the
    // same drift and retry. Eventually the upstream fault (e.g. bot
    // lost access, syntax error in the new commit) gets fixed and
    // we converge. No status flip needed.
    return { status: 'rebuild_failed', slug: app.slug, from: app.main_sha, attempted: remoteSha, error: err.message };
  } finally {
    inFlight.delete(app.id);
  }
}

async function poll(config) {
  const pool = getPool(config);
  // Snapshot the candidate set once. Apps whose status changes during
  // the loop are filtered by the per-row claim above, not here.
  const { rows } = await pool.query(
    `SELECT id, slug, repo_url, main_sha
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
};
