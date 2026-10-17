'use strict';

// Main watch — the safety net under direct merges.
//
// A proposal's checks judge its own head against the main of the time
// (services/check-admission.js). Under direct-merge lanes it then merges as
// it stands, so every merge lands a tree that nobody has run the checks
// against AS A WHOLE: two proposals that each pass alone can fail together,
// and the old bring-up-to-date-then-re-check step that used to catch that
// is gone on purpose — it cost a worker sync and a full re-run per sibling
// per merge (#2100's thundering herd).
//
// So the check moves to where the whole tree exists: after each merge, the
// repo's own unit suite runs once more on the merge commit. Green is the
// common case and costs one container that nobody waits on. Red PAUSES the
// app's merges — the merge gate's main_healthy step refuses every proposal
// until a fix lands (the next merge that comes back green) or an admin
// resumes them (POST /api/apps/:slug/main-check/resume, an explicit "I know").
// Nothing is rolled back and nothing is blamed: the culprit is whatever
// landed since the last green, which the group can see.
//
// Three refinements, each from a pause that should not have happened or
// should not have been felt:
//
//   * A first red is provisional. Suites have flaky tests, and one such
//     test paused the platform's merges for an afternoon while main was in
//     fact fine. So the first red re-runs the suite once on the same
//     commit before anyone is told main is broken: green on the re-run is
//     recorded as passing (the flake is kept in the detail); red again is a
//     confirmed failure. Merges pause during the re-run — a genuine red
//     must not let untested merges through for five more minutes — but the
//     board says "checking", not "broken". MAIN_WATCH_CONFIRM=0 turns the
//     re-run off.
//
//   * The pause is a fact of its own. main_check_paused_sha holds the red
//     commit the pause is about and is cleared by exactly two things: a
//     green verdict, or an admin's resume. A later run that could not
//     happen ('error') leaves it alone — a run that says nothing about
//     main cannot lift a pause either.
//
//   * A pause holds back what the red could be hiding, not everything.
//     The gate lets a proposal through while paused when its head is level
//     with main, merges clean, and its own checks — the same unit suite —
//     passed on that exact tree: its merge is the fix candidate, and its
//     verdict re-tests main. Everything else waits. (services/votes.js,
//     the main_healthy gate.)
//
// And three from the nine pauses of 26 September to 10 October 2026, every
// one of which an admin ended by hand:
//
//   * A paused main asks again by itself (recheckPaused). A red that a
//     re-run could not confirm is retried within minutes; a confirmed red
//     is re-run every quarter hour, up to MAIN_WATCH_RECHECKS times, and a
//     green one lifts the pause like any green. Twice, a flaky test's red
//     stood for hours because the confirming re-run never happened.
//
//   * A test that failed and then passed on the same commit is remembered
//     as flaky (main_test_flakes), and a request to fix it is filed for the
//     app. A red whose failures are ALL such tests, named in full, is
//     recorded but pauses nothing: it says nothing new about the code.
//
//   * The verdict keeps the failing tests by name (`failingTests`), from
//     the suite's own recap of them at the end of its output.
//
// Only the unit suite. The dapp.json assertions need a built preview of
// main, which is production itself; a red production is caught by the
// deploy's own health check and the rollback that follows it.
//
// State lives on the apps row (main_check_*; see schema.sql). Every write is
// compare-and-swap on the merge commit, so a slow run for an older merge
// cannot overwrite the verdict for a newer one.
//
// A run takes a slot in the checks queue (services/checks-queue.js) before
// its Job exists, like a proposal's run: first in line, with a slot of its
// own besides the proposals' cap, because it gates every merge on the app
// and its suite runs against a Postgres in its own pod. A run still waiting
// when a newer merge claims the row leaves the line; nobody would read it.

const crypto = require('crypto');
const log = require('./logger');
const unitSuite = require('./unit-suite');
const unitSuiteRow = require('./unit-suite-row');
const checkRuns = require('./check-runs');
const checksQueue = require('./checks-queue');

// How many failing tests a verdict keeps by name, in its detail.
const MAX_FAILING_TESTS = 20;
// A red is taken for flaky tests only when it named this few: a dozen
// tests failing and then passing is the run's environment, not each test.
const MAX_FLAKES_PER_RED = 3;
// A flake is known for this long after it was last seen.
const FLAKE_MEMORY_DAYS = 30;
// One request per flaky test per this many days, and none while the last
// one is still open.
const FLAKE_REQUEST_DAYS = 14;

// The flow's own switches (MAIN_WATCH_ENABLED, _CONFIRM, _RECHECKS,
// _RECHECK_MS, _CONFIRM_RETRY_MS) are the main-check machine's
// (src/workflow/main-check/machine.ts depsFromEnv).

// File a request for each newly flaky test. On by default.
function flakeRequestsEnabled() {
  const v = String(process.env.MAIN_WATCH_FLAKE_REQUESTS ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function parseRepo(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function sameSha(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// The first failing test's name out of a unit-suite failureReason
// (services/unit-suite.js failureDetail joins its parts with ` | `). The
// reason groups failures by file —
// `tests/sessions.test.js (2): shared-sessions returns linked_issues per row; … | # tests …`
// — and a reason stored before that change lists raw TAP lines —
// `not ok 6972 - shared-sessions returns linked_issues per row | # tests …`;
// both are read. Null when the reason names no test (a setup failure, a
// killed run, a file whose names did not fit), so callers fall back to the
// whole reason.
function firstFailingTest(failureReason) {
  for (const part of String(failureReason || '').split(' | ')) {
    // The old form first: its prefix is unambiguous, and a test name in it
    // may itself contain `(2): `.
    const m = part.trim().match(/^not ok\s+\d+\s*-?\s*(.+)$/);
    if (m) {
      const name = m[1].replace(/\s+#\s*(SKIP|TODO).*$/i, '').trim();
      if (name) return name.slice(0, 200);
      continue;
    }
    const grouped = part.trim().match(/^\S.*? \(\d+\): (.+)$/);
    if (!grouped) continue;
    const name = grouped[1].split('; ')[0].replace(/…$/, '').trim();
    if (name) return name.slice(0, 200);
  }
  return null;
}

// A row's main-watch block, in the shape the API serializes. Never throws
// and is correct on a row that predates the columns (state null: never run).
function describe(appRow) {
  const a = appRow || {};
  const state = a.main_check_state || null;
  const sha = a.main_check_sha || null;
  const resumedSha = a.main_check_resumed_sha || null;
  // The pause is its own column. A row from before it existed (the ALTER
  // runs at boot, the backfill right after) still answers the old way: red
  // at a sha the admin has not resumed.
  const pausedSha = a.main_check_paused_sha !== undefined
    ? (a.main_check_paused_sha || null)
    : ((state === 'failing' || state === 'confirming') && !!sha && !sameSha(resumedSha, sha) ? sha : null);
  const detail = a.main_check_detail && typeof a.main_check_detail === 'object' ? a.main_check_detail : null;
  return {
    state,
    sha,
    at: a.main_check_at ? new Date(a.main_check_at).toISOString() : null,
    detail,
    resumedSha,
    pausedSha,
    paused: !!pausedSha,
    // 'confirming': a first red is being re-run; the pause is provisional.
    confirming: state === 'confirming',
    failingTest: detail ? firstFailingTest(detail.failureReason) : null,
  };
}

/** Is this app's merging paused by a red main? */
async function mergePause(pool, appId) {
  if (!pool || appId == null) return { paused: false, state: null };
  try {
    const { rows } = await pool.query(
      `SELECT main_check_state, main_check_sha, main_check_at, main_check_detail,
              main_check_resumed_sha, main_check_paused_sha
         FROM apps WHERE id = $1`,
      [appId]
    );
    return describe(rows[0]);
  } catch (err) {
    // An unreadable row must not wedge every merge on the app; the pause is
    // a safety net, and a net that cannot be read is not a net that caught
    // something.
    log.warn('main-watch', 'pause read failed; not pausing', { appId, err: err.message });
    return { paused: false, state: null, error: err.message };
  }
}

// The verdict a run produced, from the unit-suite row. 'error' is a run
// that could not happen — its Job could not be created, the clone or the
// install failed (the row's `couldNotRun`, unit-suite.js notRunOutcome),
// output that never reached a test, or a runner killed at its deadline —
// and says nothing about main, so it pauses nothing. A verdict about the
// code is 'passing' or 'failing'.
//
// A red keeps its failing tests by name (`failingTests`, `{ file, test }`)
// and whether those are all of them (`failingTestsComplete`); the tests'
// excerpts ride beside the verdict for a flake request, never stored.
function classify(outcome) {
  if (!outcome || !outcome.row) return { state: 'skipped', detail: { reason: 'no runnable test script' } };
  const row = outcome.row;
  const named = outcome.failingTests && Array.isArray(outcome.failingTests.tests) ? outcome.failingTests : null;
  const detail = {
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(row.status !== 'pass' && named && named.tests.length ? {
      failingTests: named.tests.slice(0, MAX_FAILING_TESTS)
        .map((t) => ({ file: t.file || null, test: String(t.test || '') })),
      failingTestsComplete: !!named.complete && named.tests.length <= MAX_FAILING_TESTS,
    } : {}),
  };
  if (row.status === 'pass') return { state: 'passing', detail };
  // A suite that never reached `npm test`: it could not run at all, or its
  // install failed (`setupFailed`, unit-suite.js INSTALL_FAILURES). Neither
  // has ever paused merges.
  if (unitSuiteRow.isNotRunRow(row) || row.setupFailed === true) return { state: 'error', detail };
  const reason = String(row.failureReason || '');
  if (/^Suite setup failed/.test(reason) || /^Suite run exceeded/.test(reason)) {
    return { state: 'error', detail };
  }
  const excerpts = Array.isArray(row.failureDetails) ? row.failureDetails : [];
  return { state: 'failing', detail, ...(excerpts.length ? { excerpts } : {}) };
}

// Is `mergeSha` still the merge the app's row is about? A run waiting for
// its slot asks each time it polls; any doubt answers yes, so a read that
// fails never drops a run.
async function stillTheMerge(pool, appId, mergeSha) {
  try {
    const { rows } = await pool.query('SELECT main_check_sha FROM apps WHERE id = $1', [appId]);
    return !rows[0] || sameSha(rows[0].main_check_sha, mergeSha);
  } catch {
    return true;
  }
}

// The run's slot in the checks queue, on the cluster where its Job would run
// (the unit suite runs where the workers do). Resolves `{ superseded,
// release }`: superseded when a newer merge claimed the row while this one
// waited; `release` gives the slot back. Never throws, and fails open: a
// queue that cannot be joined lets the run go, as before the queue existed.
async function takeSlot(config, pool, app, mergeSha, { onRunId = null } = {}) {
  const none = { superseded: false, runId: null, release: async () => {} };
  if (config?.workerRuntime !== 'kubernetes' || !checksQueue.isEnabled()) return none;
  const runId = crypto.randomUUID();
  const place = await checksQueue.enqueue(pool, {
    runId, kind: 'main', appId: app.id, commitSha: mergeSha, manifest: { kind: 'main' },
  });
  if (!place) return none;
  // The run's name, kept by the caller (the main-check machine's work
  // checkpoints it) before its Jobs exist: an attempt after a crash adopts them.
  if (onRunId) await onRunId(runId);
  const stopHeartbeat = checkRuns.startHeartbeat(pool, runId);
  const release = async () => { stopHeartbeat(); await checkRuns.finish(pool, runId); };
  const slot = await checksQueue.waitForSlot(pool, {
    runId, stillWanted: () => stillTheMerge(pool, app.id, mergeSha),
  });
  if (slot.outcome === 'superseded') {
    await release();
    log.info('main-watch', 'Left the checks queue: a newer merge took the row', {
      appId: app.id, sha: mergeSha, waitedMs: slot.waitedMs,
    });
    return { superseded: true, runId: null, release: async () => {} };
  }
  if (slot.waitedMs >= checksQueue.POLL_MS) {
    log.info('main-watch', 'Checks slot granted', { appId: app.id, sha: mergeSha, waitedMs: slot.waitedMs });
  }
  return { superseded: false, runId, release };
}

// One run of the suite on the merge commit, as a verdict. Never throws: a
// runner that could not be reached is an 'error' verdict. 'superseded' is a
// run that never started because a newer merge took the row while it
// waited for its slot; afterMerge stores nothing for it.
async function runSuite(config, pool, app, parsed, mergeSha, { adopt = null, onRunId = null } = {}) {
  let slot = null;
  try {
    if (adopt) {
      const adopted = await adoptRun(config, pool, app, mergeSha, adopt);
      if (adopted) return adopted;
    }
    slot = await takeSlot(config, pool, app, mergeSha, { onRunId });
    if (slot.superseded) return { state: 'superseded', detail: {} };
    const outcome = await unitSuite.maybeRunUnitSuite({
      config, pool, appId: app.id,
      // Not a proposal's run: named for the app so a session's own cleanup
      // (kubernetes.cancelPreviewChecks matches on `s<sessionId>-`) cannot
      // take it down, and so the container name is stable per app.
      sessionId: mainSessionId(app),
      // The Jobs carry the queue row's run id, so a process that takes over
      // after this one dies finds them (adoptRun).
      ...(slot.runId ? { previewRunId: slot.runId } : {}),
      repoOwner: parsed.owner, repoName: parsed.repo, ref: mergeSha, prNumber: null,
    });
    return classify(outcome);
  } catch (err) {
    return { state: 'error', detail: { failureReason: String(err && err.message || err).slice(0, 600) } };
  } finally {
    if (slot) await slot.release().catch(() => {});
  }
}

const mainSessionId = (app) => `main-${app.id}`;

// How long past the suite's own timeout a run's Jobs are waited on when
// adopted, as the proposal harvest waits (check-harvest.js).
const ADOPT_SLACK_MS = 2 * 60 * 1000;

/**
 * Take over a run whose process died: its Jobs go on on the cluster, so
 * wait for them and read the verdict from their logs, as the proposal
 * harvest does (check-harvest.adopt), rather than start the suite again.
 * A release restarts the platform, and a run it caught used to hold main
 * in 'running' or 'confirming' until it was 12 minutes stale and then ran
 * from the start (12 Oct 2026: 13 minutes on one confirmation). `dead` is
 * the queue row ({ runId, owner }) as resumeInterrupted saw it. Resolves a
 * verdict as runSuite does, 'superseded' when another process took it
 * first, or null when there is nothing to adopt and the suite must run
 * again. Never throws.
 *
 * The queue row is cleared only by the adopter that claimed it. One that
 * lost the claim leaves it alone: the winner heartbeats that row while its
 * Jobs run, and the row is the queue slot they hold (checks-queue.js).
 */
async function adoptRun(config, pool, app, mergeSha, dead) {
  if (config?.workerRuntime !== 'kubernetes' || !dead || !dead.runId) return null;
  const kubernetes = require('./kubernetes');
  const harvest = require('./check-harvest');
  const sessionId = mainSessionId(app);
  let stopHeartbeat = () => {};
  let claimed = false;
  try {
    if (!(await checkRuns.claim(pool, dead.runId, dead.owner))) return { state: 'superseded', detail: {} };
    claimed = true;
    stopHeartbeat = checkRuns.startHeartbeat(pool, dead.runId);
    const jobs = await kubernetes.findCheckJobs(config, { sessionId, previewRunId: dead.runId });
    const unitJobs = Array.isArray(jobs.unitSuites) && jobs.unitSuites.length
      ? jobs.unitSuites : (jobs.unitSuite ? [jobs.unitSuite] : []);
    const shards = Number(jobs.unitShards) || 1;
    if (!unitJobs.length || unitJobs.length < shards) {
      log.info('main-watch', 'Interrupted run left no Jobs to read; running the suite again', {
        appId: app.id, sha: mergeSha, runId: dead.runId, jobs: unitJobs.length, shards,
      });
      return null;
    }
    log.info('main-watch', 'Adopting an interrupted run\'s Jobs', {
      appId: app.id, slug: app.slug, sha: mergeSha, runId: dead.runId, jobs: unitJobs.length,
      states: unitJobs.map((j) => j.state),
    });
    const results = await Promise.all(unitJobs.map((job) => kubernetes.collectCheckJob(config, {
      name: job.name, kind: 'unit-suite',
      timeoutMs: unitSuite.UNIT_SUITE_TIMEOUT_MS + ADOPT_SLACK_MS, maxBuffer: unitSuite.UNIT_SUITE_MAX_BUFFER,
    })));
    const unit = harvest.joinUnitResults(results, shards);
    if (!unit || !(unit.state === 'succeeded' || unit.state === 'failed')) {
      log.info('main-watch', 'Interrupted run\'s Jobs could not be read; running the suite again', {
        appId: app.id, sha: mergeSha, runId: dead.runId, state: unit ? unit.state : null,
      });
      return null;
    }
    let graduated = false;
    try {
      graduated = (await require('./check-history').loadGraduated(pool, app.id, { sessionId }))
        .has(require('./app-manifest').checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH));
    } catch { /* advisory on any doubt, as a live run */ }
    const outcome = await unitSuite.outcomeFromLog({
      pool, appId: app.id, sessionId, succeeded: unit.state === 'succeeded',
      stdout: unit.stdout, stderr: unit.stderr, timedOut: unit.timedOut, exitCode: unit.exitCode, graduated,
    });
    kubernetes.deleteSettledCheckJobs(config, { sessionId, previewRunId: dead.runId }).catch(() => {});
    return classify(outcome);
  } catch (err) {
    log.warn('main-watch', 'Could not adopt an interrupted run (non-fatal); running the suite again', {
      appId: app.id, sha: mergeSha, err: err.message,
    });
    return null;
  } finally {
    stopHeartbeat();
    if (claimed) await checkRuns.finish(pool, dead.runId).catch(() => {});
  }
}

// ── Flaky tests ──────────────────────────────────────────────────────────
//
// A test that failed on a commit and then passed on the same commit failed
// for a reason outside the code: it is flaky. main_test_flakes remembers it
// per app, and a red made only of such tests stops pausing merges. Twelve
// first reds of 26 September to 10 October 2026 were flakes the confirming
// re-run cleared, and three more paused merges for hours.

const testKey = (t) => `${t.file || ''}\u0000${t.test}`;

// Record the tests of each red that a green on the same commit showed to
// be flaky, then file a request for each. A red counts only when it named
// all of its failures and no more than MAX_FLAKES_PER_RED of them. Never
// throws; returns the tests recorded.
async function noteFlakes(config, pool, app, mergeSha, reds, excerpts = []) {
  const tests = new Map();
  for (const red of reds) {
    const named = red && Array.isArray(red.failingTests) ? red.failingTests : [];
    if (!named.length || red.failingTestsComplete !== true || named.length > MAX_FLAKES_PER_RED) continue;
    for (const t of named) tests.set(testKey(t), t);
  }
  const recorded = [];
  for (const t of tests.values()) {
    try {
      await pool.query(
        `INSERT INTO main_test_flakes (app_id, file, test, last_sha)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (app_id, file, test) DO UPDATE
           SET seen_count = main_test_flakes.seen_count + 1, last_seen_at = NOW(), last_sha = EXCLUDED.last_sha`,
        [app.id, t.file || '', t.test, mergeSha]
      );
      recorded.push(t);
    } catch (err) {
      log.warn('main-watch', 'flake record failed (non-fatal)', { appId: app.id, test: t.test, err: err.message });
    }
  }
  if (recorded.length) {
    log.info('main-watch', 'Recorded flaky tests', {
      appId: app.id, slug: app.slug, sha: mergeSha, tests: recorded.map((t) => t.test),
    });
    await fileFlakeRequests(config, pool, app, recorded, { mergeSha, excerpts });
  }
  return recorded;
}

async function fileFlakeRequests(config, pool, app, tests, { mergeSha, excerpts = [] } = {}) {
  const filed = [];
  for (const t of tests) {
    const excerpt = (excerpts.find((d) => d && d.test === t.test && (d.file || null) === (t.file || null)) || {}).excerpt;
    const n = await fileFlakeRequest(config, pool, app, t, { mergeSha, excerpt });
    if (n) filed.push(n);
  }
  return filed;
}

// A fence longer than any run of backticks in `text`.
function fenceFor(text) {
  const longest = (String(text).match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function flakeRequestText(t, { mergeSha, seenCount, firstSeenAt, excerpt }) {
  const name = t.test.length > 120 ? `${t.test.slice(0, 119)}…` : t.test;
  const where = t.file ? ` in \`${t.file}\`` : '';
  const since = firstSeenAt ? new Date(firstSeenAt).toISOString().slice(0, 10) : null;
  const lines = [
    `The test "${t.test}"${where} failed on main and then passed on the same commit`
      + `${mergeSha ? ` (${String(mergeSha).slice(0, 9)})` : ''}, so its result does not depend only on the code.`,
    '',
    `- Seen flaking on main ${seenCount === 1 ? 'once' : `${seenCount} times`}${since ? `, first on ${since}` : ''}.`,
    '- While it stays flaky, a red main whose only failures are known flaky tests is recorded but does not pause merges.',
    '- The fix is to make the test deterministic: find what it waits on or races (time, timers, ordering, a shared resource) and remove the dependence.',
  ];
  if (excerpt) {
    const text = String(excerpt).slice(0, 1500);
    const fence = fenceFor(text);
    lines.push('', 'What it printed when it failed:', '', `${fence}text`, text, fence);
  }
  lines.push('', '---', 'Filed by Homeroom\'s main watch, which re-runs main\'s unit suite after every merge.');
  return { title: `Flaky test: ${name}`, body: lines.join('\n') };
}

// A request on the app's repo, filed as Homeroom bot: the GitHub issue, its
// row, and the notices a person's request gets. Resolves the issue number;
// throws when the issue could not be filed. Shared with the request to fix a
// red main (services/main-red-fix.js).
async function fileBotIssue(config, pool, app, parsed, { title, body }) {
  const github = require('./github');
  const bot = require('./homeroom-bot');
  const botUser = await bot.ensureBotUser(pool, config);
  const created = await github.createIssue(parsed.owner, parsed.repo, {
    title, body: typeof github.safeMention === 'function' ? github.safeMention(body) : body,
  });
  const issueNumber = Number(created && created.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('invalid issue number');
  try { github.noteIssueCreated?.(parsed.owner, parsed.repo, created); } catch {}
  const { rows } = await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
     VALUES ($1, $2, $3, $4, 'general', '{}', $5) RETURNING id`,
    [app.id, issueNumber, title, body, botUser.id]
  );
  try {
    require('./notifications').notifyIssueFiled?.(pool, {
      appId: app.id, issueNumber, authorId: botUser.id, text: `${title}\n\n${body}`,
    });
  } catch {}
  try {
    require('./ws').pushIssueUpdate?.({ action: 'created', appSlug: app.slug, appId: app.id, issueId: rows[0]?.id, kind: 'general' });
  } catch {}
  try { bot.noteIssueActivity?.({ appId: app.id, issueNumber, reason: 'created' }); } catch {}
  return issueNumber;
}

// One request for a flaky test, filed as Homeroom bot: at most once per
// FLAKE_REQUEST_DAYS, and never while the last one is still open. The
// request_filed_at claim keeps two processes from filing the same one.
// Never throws; returns the issue number, or null.
async function fileFlakeRequest(config, pool, app, t, { mergeSha = null, excerpt = '' } = {}) {
  if (!flakeRequestsEnabled()) return null;
  const parsed = parseRepo(app.repo_url);
  const github = require('./github');
  if (!parsed || !github.isEnabled()) return null;
  const key = [app.id, t.file || '', t.test];
  let claimed;
  try {
    ({ rows: claimed } = await pool.query(
      `UPDATE main_test_flakes f
          SET request_filed_at = NOW()
        WHERE f.app_id = $1 AND f.file = $2 AND f.test = $3
          AND (f.request_filed_at IS NULL OR f.request_filed_at < NOW() - ($4::int * interval '1 day'))
          AND NOT EXISTS (
            SELECT 1 FROM issues i
             WHERE i.app_id = f.app_id AND i.github_issue_number = f.request_issue_number
               AND i.status = 'open')
      RETURNING f.seen_count, f.first_seen_at`,
      [...key, FLAKE_REQUEST_DAYS]
    ));
  } catch (err) {
    log.warn('main-watch', 'flake request claim failed (non-fatal)', { appId: app.id, test: t.test, err: err.message });
    return null;
  }
  if (!claimed || !claimed.length) return null;
  try {
    const { title, body } = flakeRequestText(t, {
      mergeSha, seenCount: Number(claimed[0].seen_count) || 1, firstSeenAt: claimed[0].first_seen_at, excerpt,
    });
    const issueNumber = await fileBotIssue(config, pool, app, parsed, { title, body });
    await pool.query(
      'UPDATE main_test_flakes SET request_issue_number = $4 WHERE app_id = $1 AND file = $2 AND test = $3',
      [...key, issueNumber]
    );
    log.info('main-watch', 'Filed a request for a flaky test', { appId: app.id, slug: app.slug, issueNumber, test: t.test });
    return issueNumber;
  } catch (err) {
    log.warn('main-watch', 'flake request failed (non-fatal)', { appId: app.id, test: t.test, err: err.message });
    await pool.query(
      'UPDATE main_test_flakes SET request_filed_at = NULL WHERE app_id = $1 AND file = $2 AND test = $3',
      key
    ).catch(() => {});
    return null;
  }
}

// One run of the suite on `sha` for the main-check machine's main.suite work
// (src/workflow/main-check/): `onRunId` is told the checks-queue row's run id
// before its Jobs exist, and an attempt after a crash passes it back
// (`resumeRunId`) to read the dead run's Jobs rather than run the suite
// again, once the dead process's row is still there. Resolves a verdict
// (classify); never throws.
async function runMainSuite(config, pool, { app, sha, resumeRunId = null, onRunId = null } = {}) {
  const parsed = parseRepo(app && app.repo_url);
  if (!parsed) return { state: 'skipped', detail: { reason: 'no repository' } };
  let adopt = null;
  if (resumeRunId) {
    try {
      const { rows: [r] } = await pool.query(
        'SELECT owner FROM check_runs WHERE run_id = $1 AND admitted_at IS NOT NULL', [resumeRunId]);
      if (r) adopt = { runId: resumeRunId, owner: r.owner };
    } catch { /* nothing to adopt: the suite runs again */ }
  }
  return runSuite(config, pool, app, parsed, sha, { adopt, onRunId });
}

module.exports = {
  mergePause,
  describe,
  classify,
  firstFailingTest,
  parseRepo,
  runMainSuite,
  noteFlakes,
  fileFlakeRequests,
  fileFlakeRequest,
  fileBotIssue,
  flakeRequestText,
  MAX_FLAKES_PER_RED,
  FLAKE_MEMORY_DAYS,
};
