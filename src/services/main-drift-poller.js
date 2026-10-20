/**
 * main's drift: the I/O of the main-drift clock (src/workflow/clock/).
 *
 * For every app with a `repo_url` and status='running', reads GitHub's
 * `main` and, when it differs from `apps.main_sha`, tells app delivery
 * (MainMoved, keyed by the commit, so a second look adds nothing). App
 * delivery decides whether to deploy it: not while a deploy of the app
 * runs (it serves it after), not a commit whose image runs as root, and a
 * commit whose deploy failed again only after its own backoff. Closes the
 * gap for repos the platform doesn't own (the import-existing flow) and for
 * any out-of-band pushes by the bot to its own repos.
 *
 * The platform's own row (apps.self_hosted) is read too, but never
 * deployed from here: its main_sha is the build that is serving, and its
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
 * We deliberately do NOT flip `apps.status` while a deploy runs: dropping
 * `running` mid-deploy would also drop the URL from the home-page tile
 * (see routes/apps.js: URL is only computed when status='running').
 */
const log = require('./logger');
const { getPool } = require('../db/pool');
const github = require('./github');
const releaseWatch = require('./release-watch');
const githubBudget = require('./github-budget');

// MAIN_DRIFT_POLL_MS: how often the clock looks (5 minutes). GitHub's rest
// API has a 5000 req/hr limit per token. A plain read of every running
// app's main every five minutes is 12 requests an app an hour, which alone
// spends the whole budget at about 400 apps. Two things keep it from doing
// that now: the read is conditional (fetchRemoteHead below; an unchanged
// main answers 304, which GitHub does not count), and a pass is held while
// the budget is nearly gone (scan below).
const POLL_INTERVAL_MS = parseInt(process.env.MAIN_DRIFT_POLL_MS, 10) || 5 * 60 * 1000;

// Whether the clock runs: GitHub, with the bot's token.
function enabled() {
  return !!(github.isEnabled() && process.env.GITHUB_BOT_TOKEN);
}

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

// One app's main, looked at. Resolves a structured result, which the
// admin's "Check for updates" returns to its client.
//
// `status` is one of:
//   no_drift         — remote HEAD matches `apps.main_sha`, nothing to do
//   deploy_requested — drift: app delivery was told, and deploys it
//   already_asked, waits_for_new_commit, … — drift: app delivery was told,
//                      and said why it does not deploy it now
//   invalid_repo     — `apps.repo_url` couldn't be parsed (shouldn't happen for healthy rows)
//   fetch_failed     — GitHub API call rejected (bot lost access, rate limit, …)
//   first_seen       — main_sha was NULL; backfilled, no deploy
//   release_pending  — the self-hosted row: main is ahead of the running
//                      build, within a release's normal time
//   release_stalled  — the self-hosted row: main is ahead and the release
//                      has not come (services/release-watch.js)
//
// `byHand` (the admin's "Check for updates"): app delivery deploys even a
// commit that failed or was refused for running as root, without waiting.
async function checkOne(config, pool, app, { byHand = false } = {}) {
  const platform = require('../workflow/platform.ts');
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
  const remoteSha = head.sha ? String(head.sha).toLowerCase() : null;
  if (!remoteSha) return { status: 'fetch_failed', slug: app.slug, error: 'GitHub returned no SHA' };

  // main's unit suite runs on every new main, merge or direct push (the
  // app's main-check machine, src/workflow/main-check/). Its claim is per
  // commit, so a merge commit the merge already asked about is not run twice.
  if (remoteSha !== app.main_check_sha || !app.main_check_state || app.main_check_state === 'error') {
    await platform.requestMainCheck({ appId: app.id, sha: remoteSha }).catch((err) => {
      log.warn('drift-poller', 'Main check on a new main could not be asked', { slug: app.slug, err: err.message });
    });
  }

  // First-time backfill: no prior SHA recorded → just save it. This
  // shouldn't happen often (creation and every deploy record the SHA), but
  // if it did we don't want to needlessly redeploy on the very next look
  // just because main_sha was NULL.
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

  const outcome = await platform.reportMainMoved(app.id, remoteSha, { byHand });
  if (outcome.status === 'accepted') {
    log.info('drift-poller', 'main moved; app delivery told', {
      appId: app.id, slug: app.slug, from: app.main_sha.slice(0, 7), to: remoteSha.slice(0, 7), byHand,
    });
    // main moved out-of-band: the app's merge queue looks again (a proposal
    // may conflict now, or merge). Once per commit.
    await platform.wantMerge({ appId: app.id, reason: 'drift', requestKey: `want:drift:${app.id}:${remoteSha}` }).catch((err) => {
      log.error('drift-poller', 'Post-drift merge ask failed', { slug: app.slug, err: err.message });
    });
  }
  // What app delivery decided: deploy_requested, or why not (already_asked:
  // a deploy for it is owed; waits_for_new_commit: its image runs as root).
  return { status: outcome.status === 'accepted' ? 'deploy_requested' : (outcome.reason || outcome.status),
    slug: app.slug, from: app.main_sha, to: remoteSha };
}

// The main-drift clock's run: every running app with a repository looked
// at, one after another. Background work: while GitHub's hourly budget is
// nearly used up, the rest of the pass waits for the next run, so what
// people start keeps the reserve. Asked before every app, because a first
// pass after a restart has no ETags yet and costs one read each.
// services/github-budget.js logs the hold once per window, not per app.
// The admin's "Check for updates" is never held.
async function scan(config, pool, { shouldStop = () => false } = {}) {
  if (!enabled()) return { off: true };
  const { rows } = await pool.query(
    `SELECT id, slug, repo_url, main_sha, self_hosted, release_stall, release_run, main_check_sha, main_check_state
       FROM apps
      WHERE repo_url IS NOT NULL AND status = 'running'
      ORDER BY id`
  );
  let checked = 0;
  const reported = [];
  for (const app of rows) {
    if (shouldStop()) return { apps: rows.length, checked, reported, stopped: true };
    if (!githubBudget.budgetAllows('background')) {
      log.debug('drift-poller', 'Pass held for the GitHub budget', { checked, left: rows.length - checked });
      return { apps: rows.length, checked, reported, held: true };
    }
    checked += 1;
    try {
      const r = await checkOne(config, pool, app);
      if (r.to && r.from) reported.push({ slug: app.slug, status: r.status });
    } catch (err) {
      log.warn('drift-poller', 'Per-app check threw (continuing)', { slug: app.slug, err: err.message });
    }
  }
  return { apps: rows.length, checked, reported };
}

module.exports = {
  enabled,
  intervalMs: () => POLL_INTERVAL_MS,
  scan,
  checkOne,
  // The admin "Check for updates" button: one app, now, by hand.
  checkByHand: (config, pool, app) => checkOne(config, pool, app, { byHand: true }),
  _forTest: {
    resetHeadCache: () => headCache.clear(),
    POLL_INTERVAL_MS,
  },
};
