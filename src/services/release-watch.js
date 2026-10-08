/**
 * Notice when a merged commit of the platform's own app has not become the
 * running release, and say so.
 *
 * A child app's merge deploys through staging.rebuildProduction, in this
 * process: a failure throws here, lands on apps.last_failure, and notifies
 * the app's admins. The platform's own merge does not. routes/votes.js merges
 * the PR and logs "GitHub Actions publishes the release for Argo CD", and
 * from there the path runs entirely outside the platform: the push-to-main
 * workflow builds the image, publishes a Helm release, Argo CD syncs it, the
 * Deployment rolls, and the new process boots and writes its own GIT_SHA to
 * the self-hosted row's main_sha (seedSelfApp). When a link in that chain
 * fails, nothing in here hears about it. #2589 merged at 18:26Z, the image
 * workflow's registry lookup lost one connection to GHCR's blob CDN, the
 * release step was skipped, and production served the previous commit until
 * someone noticed at 19:01Z and re-ran the workflow by hand. The proposal
 * read "merged" the whole time.
 *
 * What this process CAN see is both ends of the gap. The drift poller
 * (services/main-drift-poller.js) already asks GitHub for main's head every
 * five minutes and compares it to apps.main_sha for every running app; for
 * the self-hosted row, main_sha is the build that is serving, so a
 * difference means "merged, not released". The poller hands those here
 * rather than to rebuildProduction, which for the platform's own row can
 * only fail (it did, three times, during the #2589 gap: "missing required
 * secrets", because the platform's dapp.json declares secrets a child app
 * would hold in app_secrets).
 *
 * Verdicts, from GitHub's own account of the release workflow for that
 * commit when the bot's token can read Actions, and from elapsed time when
 * it cannot:
 *
 *   workflow_failed   the run concluded red. Definitive; said at once.
 *   workflow_running  past the grace and the run is still going. A release
 *                     takes about ninety seconds when it works.
 *   rollout_missing   past the grace, the run succeeded, and the running
 *                     build is still the old one: Argo CD or the rollout.
 *   unknown           past the grace, and no run to read (a token without
 *                     actions:read, or a workflow that never started).
 *
 * The grace runs from the merge, but a release cannot start before the ones
 * ahead of it: the workflow queues every push to main and runs them one at a
 * time (build-kubernetes-images.yml, `queue: max`), and a run whose commit is
 * no longer main's tip builds and then skips its publish. So a burst of
 * merges releases one after another, and the newest waits for all of them.
 * On 5 Oct 2026 ten merges landed in two minutes; ten minutes after the last
 * one (#3860) its run was still waiting its turn, and the Dev board called it
 * "Stuck going live" while the release was on its way. A run that has not
 * finished is therefore late only once the queue it waits in has stood still
 * for the grace: no run of the workflow on main has finished within it. And
 * a run that succeeded gives Argo CD and the rollout their own grace, from
 * when the run finished rather than from the merge.
 *
 * The queue can also stand still on purpose. Since 7 Oct 2026, when the
 * platform rolled out four times in sixteen minutes, a run at main's tip
 * waits in its release job until the run that published the previous release
 * finished RELEASE_MIN_GAP_MINUTES ago. Nothing is stuck while it waits, so an
 * unfinished run is late only once the queue has stood still for the grace
 * plus that gap (RELEASE_MIN_GAP_MS).
 *
 * Each (sha, kind) is reported once — an app_health notification to the
 * admins, and a record on apps.release_stall that the board banner draws
 * (dev-board/release-stall-store.ts words it) — and the record is cleared
 * when the running build catches up. Main moving on to a further commit starts
 * over for that commit; a release of it carries the earlier one too, so a
 * recorded commit that the running build already carries reads as resolved
 * (carriedBy) even before the poller clears it.
 */
const log = require('./logger');

// How long after main moved before a not-yet-running commit is a stall
// rather than a release in progress. Today's releases land in three to four
// minutes from push to pod ready; ten is late by any reading of that.
function graceMs() {
  const v = parseInt(process.env.RELEASE_GRACE_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
}

// The release workflow's RELEASE_MIN_GAP_MINUTES: the longest a run at
// main's tip waits for the previous release to age before it publishes.
// tests/release-watch.test.js holds the two equal.
const RELEASE_MIN_GAP_MS = 10 * 60 * 1000;

const WORKFLOW_PATH = '.github/workflows/build-kubernetes-images.yml';
const WORKFLOW_FILE = 'build-kubernetes-images.yml';
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);

function short(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

function sameSha(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// The PR a squash merge came from, off its subject: "Retry a dropped
// connection (#2593)". Null when the subject does not say (a direct push).
function prNumberFrom(subject) {
  const m = String(subject || '').split('\n')[0].match(/\(#(\d+)\)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// The release workflow's run for a commit, in its own words, or null when
// there is none to read: no run yet, or a token that cannot list Actions.
// Never throws — the verdict falls back to elapsed time.
async function workflowRun(octokit, owner, repo, sha) {
  try {
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner, repo, head_sha: sha, per_page: 30,
    });
    const runs = (data && data.workflow_runs) || [];
    const run = runs.find((r) => r && r.path === WORKFLOW_PATH)
      || runs.find((r) => r && /kubernetes images/i.test(r.name || ''));
    if (!run) return null;
    return {
      status: run.status || null,
      conclusion: run.conclusion || null,
      url: run.html_url || null,
      id: run.id || null,
      // A finished run's last update is when it finished.
      completedAt: run.status === 'completed' ? (run.updated_at || null) : null,
    };
  } catch (err) {
    log.debug('release-watch', 'Could not read the release workflow run', {
      repo: `${owner}/${repo}`, sha: short(sha), err: err.message,
    });
    return null;
  }
}

// When the release workflow last finished a run on main, as epoch ms: the
// last time the queue a merge's release waits in moved. Null when there is
// none to read. Never throws — the verdict falls back to the merge's age.
async function queueMovedAt(octokit, owner, repo) {
  try {
    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: WORKFLOW_FILE, branch: 'main', status: 'completed', per_page: 5,
    });
    let latest = null;
    for (const run of (data && data.workflow_runs) || []) {
      const at = Date.parse((run && run.updated_at) || '');
      if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
    }
    return latest;
  } catch (err) {
    log.debug('release-watch', 'Could not read the release workflow queue', {
      repo: `${owner}/${repo}`, err: err.message,
    });
    return null;
  }
}

// Pure: what to say about a merged commit that is not running, given how
// long ago main moved and what GitHub says about its workflow. `null` is
// "nothing yet" — the release is still within its normal time.
//
// `idleMs` is how long the release queue has stood still (since the
// workflow last finished a run on main) and `doneAgoMs` how long ago this
// commit's own run finished; either is null when it could not be read, and
// the verdict is then measured from the merge alone, as it always was.
function classify({ ageMs, run, idleMs = null, doneAgoMs = null, grace = graceMs() }) {
  if (run && run.status === 'completed' && FAILED_CONCLUSIONS.has(run.conclusion)) return 'workflow_failed';
  if (!(ageMs >= grace)) return null;
  if (run && run.status !== 'completed') {
    // Waiting behind earlier merges' releases, running right after them,
    // or waiting out the release gap: on its way while the queue keeps
    // moving, or has been still for no longer than that wait explains.
    if (Number.isFinite(idleMs) && idleMs < grace + RELEASE_MIN_GAP_MS) return null;
    return 'workflow_running';
  }
  if (run && run.conclusion === 'success') {
    // Argo CD and the rollout get their time from when the run finished.
    if (Number.isFinite(doneAgoMs) && doneAgoMs < grace) return null;
    return 'rollout_missing';
  }
  return 'unknown';
}

async function notifyAdmins(pool, appId) {
  try {
    const notifications = require('./notifications');
    const created = await notifications.createAppHealthNotification(pool, { appId, detail: 'release_stalled' });
    await Promise.all(created.map((row) => notifications.hydrateAndPush(pool, row)));
  } catch (err) {
    log.warn('release-watch', 'App-health notification failed', { appId, err: err.message });
  }
}

function asRecord(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && value.sha ? value : null;
}

/**
 * The drift poller found the self-hosted app's main ahead of its running
 * build. `head` is main's tip as the poller fetched it: { sha, committedAt,
 * subject }. Returns the poller's result shape:
 *
 *   release_pending   within the grace; nothing said
 *   release_stalled   past it (or the workflow is red); `reported` says
 *                     whether this call was the one that said so
 */
async function observe(config, pool, app, head, { now = Date.now(), octokit = null } = {}) {
  const sha = head && head.sha;
  const running = app.main_sha || null;
  const committedAt = head && head.committedAt ? Date.parse(head.committedAt) : NaN;
  // A head with no date (an API shape without one) is measured from the
  // first time this process saw it, which is at most one tick late.
  const since = Number.isFinite(committedAt) ? committedAt : firstSeenAt(app.id, sha, now);
  const ageMs = Math.max(0, now - since);

  let run = null;
  let idleMs = null;
  if (octokit) {
    const parsed = require('./github').parseGithubUrl(app.repo_url);
    if (parsed) run = await workflowRun(octokit, parsed.owner, parsed.repo, sha);
    // Only a run that is late by the merge's clock and has not finished
    // costs the second read: is it stuck, or waiting its turn?
    if (parsed && run && run.status !== 'completed' && ageMs >= graceMs()) {
      const movedAt = await queueMovedAt(octokit, parsed.owner, parsed.repo);
      if (movedAt != null) idleMs = Math.max(0, now - movedAt);
    }
  }
  const doneAt = Date.parse((run && run.completedAt) || '');
  const doneAgoMs = Number.isFinite(doneAt) ? Math.max(0, now - doneAt) : null;

  const kind = classify({ ageMs, run, idleMs, doneAgoMs });
  if (!kind) {
    return { status: 'release_pending', slug: app.slug, sha, running, ageMs, run, idleMs };
  }

  const previous = asRecord(app.release_stall);
  if (previous && sameSha(previous.sha, sha) && previous.kind === kind) {
    return { status: 'release_stalled', slug: app.slug, sha, running, kind, reported: false, record: previous };
  }

  const record = {
    sha,
    prNumber: prNumberFrom(head.subject),
    kind,
    since: new Date(since).toISOString(),
    detectedAt: new Date(now).toISOString(),
    running,
    runUrl: run ? run.url : null,
    runStatus: run ? run.status : null,
    runConclusion: run ? run.conclusion : null,
  };
  await pool.query('UPDATE apps SET release_stall = $1 WHERE id = $2', [JSON.stringify(record), app.id]);
  log.warn('release-watch', 'A merged self-app commit has not become the release', {
    appId: app.id, slug: app.slug, sha: short(sha), running: short(running), kind,
    prNumber: record.prNumber, ageMs, runUrl: record.runUrl,
  });
  // A red is news the moment it is red; the same commit escalating from
  // "still running" to "failed" is too. Notifications de-duplicate on
  // unread, so a stall nobody has looked at does not stack.
  await notifyAdmins(pool, app.id);
  return { status: 'release_stalled', slug: app.slug, sha, running, kind, reported: true, record };
}

/**
 * The running build is at main again. Clears a recorded stall (the release
 * landed — this is the new process, or a later merge carried the commit)
 * and the banner goes with it. A no-op when nothing was recorded.
 */
async function converged(config, pool, app) {
  const record = asRecord(app.release_stall);
  firstSeen.delete(app.id);
  if (!record) return { cleared: false };
  const { rowCount } = await pool.query(
    'UPDATE apps SET release_stall = NULL WHERE id = $1 AND release_stall IS NOT NULL',
    [app.id]
  );
  if (!rowCount) return { cleared: false };
  log.info('release-watch', 'The stalled self-app commit is running now', {
    appId: app.id, slug: app.slug, sha: short(record.sha), running: short(app.main_sha),
  });
  return { cleared: true, record };
}

// When this process first saw main at a sha it could not date. In memory:
// a restart costs at most one tick of grace.
const firstSeen = new Map(); // app.id -> { sha, at }
function firstSeenAt(appId, sha, now) {
  const prev = firstSeen.get(appId);
  if (prev && sameSha(prev.sha, sha)) return prev.at;
  firstSeen.set(appId, { sha, at: now });
  return now;
}

// A row's release-watch block, in the shape the API serializes. Never throws
// and is correct on a row that predates the column. `runningSha` is the
// build answering the request; a record that names it (or that a boot has
// not yet cleared) is already resolved and reads as no stall.
function describe(appRow, runningSha = process.env.GIT_SHA || null) {
  const record = asRecord(appRow && appRow.release_stall);
  if (!record || (runningSha && sameSha(record.sha, runningSha))) {
    return { stalled: false, sha: null, prNumber: null, kind: null, since: null, detectedAt: null, running: null, runUrl: null };
  }
  const runUrl = /^https:\/\/github\.com\//.test(String(record.runUrl || '')) ? record.runUrl : null;
  return {
    stalled: true,
    sha: record.sha,
    prNumber: record.prNumber || null,
    kind: record.kind || 'unknown',
    since: record.since || null,
    detectedAt: record.detectedAt || null,
    running: record.running || null,
    runUrl,
  };
}

/**
 * Whether the build at `runningSha` already carries the recorded commit `sha`.
 * A release ships main's tip, so a later merge's build holds every merge
 * before it: several merges land, one release goes out, and the commit the
 * record names never runs by itself. Read off the order the two merged
 * changes merged in, the same order the Done column's deploy states use
 * (routes/votes.js annotateDeploymentState). False whenever it cannot tell:
 * a direct push has no merged change to order, and a failed read is no
 * evidence either way. Never throws.
 */
async function carriedBy(pool, appId, sha, runningSha) {
  if (!sha || !runningSha) return false;
  if (sameSha(sha, runningSha)) return true;
  if (!pool || appId == null) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1
         FROM chat_sessions recorded
         JOIN chat_sessions serving ON serving.app_id = recorded.app_id
        WHERE recorded.app_id = $1
          AND recorded.status = 'merged' AND serving.status = 'merged'
          AND LOWER(recorded.merge_commit_sha) = LOWER($2)
          AND LOWER(serving.merge_commit_sha) = LOWER($3)
          AND (COALESCE(recorded.merged_at, recorded.created_at), recorded.id)
              <= (COALESCE(serving.merged_at, serving.created_at), serving.id)
        LIMIT 1`,
      [appId, sha, runningSha]
    );
    return rows.length > 0;
  } catch (err) {
    log.warn('release-watch', 'Could not order the recorded commit against the running build', {
      appId, sha: short(sha), running: short(runningSha), err: err.message,
    });
    return false;
  }
}

/**
 * The app's recorded stall, for routes that do not already hold the row.
 * A record whose commit the answering build already carries is resolved.
 */
async function readStall(pool, appId, runningSha = process.env.GIT_SHA || null) {
  if (!pool || appId == null) return describe(null);
  try {
    const { rows } = await pool.query('SELECT release_stall FROM apps WHERE id = $1', [appId]);
    const stall = describe(rows[0], runningSha);
    if (stall.stalled && await carriedBy(pool, appId, stall.sha, runningSha)) return describe(null);
    return stall;
  } catch (err) {
    log.warn('release-watch', 'Could not read release_stall', { appId, err: err.message });
    return describe(null);
  }
}

module.exports = {
  observe,
  converged,
  describe,
  readStall,
  carriedBy,
  classify,
  prNumberFrom,
  graceMs,
  RELEASE_MIN_GAP_MS,
  WORKFLOW_PATH,
  _forTest: { resetFirstSeen: () => firstSeen.clear() },
};
