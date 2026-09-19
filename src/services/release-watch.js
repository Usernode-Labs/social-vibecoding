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
 * Each (sha, kind) is reported once — a group message, an app_health
 * notification to the admins, and a record on apps.release_stall that the
 * board banner draws — and the record is cleared with a closing message when
 * the running build catches up. Main moving on to a further commit starts
 * over for that commit; a release of it carries the earlier one too.
 */
const log = require('./logger');

// How long after main moved before a not-yet-running commit is a stall
// rather than a release in progress. Today's releases land in three to four
// minutes from push to pod ready; ten is late by any reading of that.
function graceMs() {
  const v = parseInt(process.env.RELEASE_GRACE_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
}

const WORKFLOW_PATH = '.github/workflows/build-kubernetes-images.yml';
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
    };
  } catch (err) {
    log.debug('release-watch', 'Could not read the release workflow run', {
      repo: `${owner}/${repo}`, sha: short(sha), err: err.message,
    });
    return null;
  }
}

// Pure: what to say about a merged commit that is not running, given how
// long ago main moved and what GitHub says about its workflow. `null` is
// "nothing yet" — the release is still within its normal time.
function classify({ ageMs, run, grace = graceMs() }) {
  if (run && run.status === 'completed' && FAILED_CONCLUSIONS.has(run.conclusion)) return 'workflow_failed';
  if (!(ageMs >= grace)) return null;
  if (run && run.status !== 'completed') return 'workflow_running';
  if (run && run.conclusion === 'success') return 'rollout_missing';
  return 'unknown';
}

function minutes(ms) {
  const m = Math.round(ms / 60000);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

// The group message for a verdict. One spelling, so the record, the chat and
// the tests agree.
function stallMessage(record) {
  const merged = record.prNumber
    ? `PR #${record.prNumber} merged (${short(record.sha)})`
    : `Commit ${short(record.sha)} landed on main`;
  const ago = record.since && record.detectedAt
    ? ` ${minutes(Date.parse(record.detectedAt) - Date.parse(record.since))} ago` : '';
  const running = record.running ? ` The platform is still running ${short(record.running)}.` : '';
  const run = record.runUrl ? ` ${record.runUrl}` : '';
  switch (record.kind) {
    case 'workflow_failed':
      return `⚠️ ${merged}${ago} but was not released: the "Build Kubernetes images" workflow failed.${run}`
        + `${running} Re-run its failed jobs to release it; the next merge would carry it too.`;
    case 'workflow_running':
      return `⚠️ ${merged}${ago} and its release workflow is still running; a release normally takes `
        + `a couple of minutes.${run}${running}`;
    case 'rollout_missing':
      return `⚠️ ${merged}${ago} and its release workflow succeeded, but the platform has not rolled onto it.`
        + `${running} Check Argo CD and the platform Deployment.`;
    default:
      return `⚠️ ${merged}${ago} but is not running yet, and no release workflow run could be found for it.`
        + `${running} Check the repository's Actions.`;
  }
}

function releasedMessage(record, runningSha) {
  const what = record && record.prNumber
    ? `PR #${record.prNumber} (${short(record.sha)})`
    : `Commit ${short(record && record.sha)}`;
  const carried = record && runningSha && !sameSha(record.sha, runningSha)
    ? `, carried by ${short(runningSha)}` : '';
  return `✅ ${what} is live now${carried}.`;
}

async function postGroup(pool, appId, content) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, appId, content, 'system');
  } catch (err) {
    log.warn('release-watch', 'group message failed', { appId, err: err.message });
  }
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
  if (octokit) {
    const parsed = require('./github').parseGithubUrl(app.repo_url);
    if (parsed) run = await workflowRun(octokit, parsed.owner, parsed.repo, sha);
  }

  const kind = classify({ ageMs, run });
  if (!kind) {
    return { status: 'release_pending', slug: app.slug, sha, running, ageMs, run };
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
  await postGroup(pool, app.id, stallMessage(record));
  // A red is news the moment it is red; the same commit escalating from
  // "still running" to "failed" is too. Notifications de-duplicate on
  // unread, so a stall nobody has looked at does not stack.
  await notifyAdmins(pool, app.id);
  return { status: 'release_stalled', slug: app.slug, sha, running, kind, reported: true, record };
}

/**
 * The running build is at main again. Clears a recorded stall (the release
 * landed — this is the new process, or a later merge carried the commit)
 * and closes the thread in the group. A no-op when nothing was recorded.
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
  await postGroup(pool, app.id, releasedMessage(record, app.main_sha));
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

/** The app's recorded stall, for routes that do not already hold the row. */
async function readStall(pool, appId, runningSha) {
  if (!pool || appId == null) return describe(null);
  try {
    const { rows } = await pool.query('SELECT release_stall FROM apps WHERE id = $1', [appId]);
    return describe(rows[0], runningSha);
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
  classify,
  prNumberFrom,
  stallMessage,
  releasedMessage,
  graceMs,
  WORKFLOW_PATH,
  _forTest: { resetFirstSeen: () => firstSeen.clear() },
};
