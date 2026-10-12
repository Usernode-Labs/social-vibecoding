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
// app's merges — checkAndMerge's main_healthy gate refuses every proposal
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

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// How many times a paused main is re-run before only a fix or an admin
// can lift the pause. 0 turns the rechecks off.
function maxRechecks() { return intEnv('MAIN_WATCH_RECHECKS', 3); }
// How long after its last verdict a confirmed red is re-run.
function recheckMs() { return intEnv('MAIN_WATCH_RECHECK_MS', 15 * 60 * 1000); }
// How long after a confirming re-run that could not happen it is tried again.
function confirmRetryMs() { return intEnv('MAIN_WATCH_CONFIRM_RETRY_MS', 3 * 60 * 1000); }

// File a request for each newly flaky test. On by default.
function flakeRequestsEnabled() {
  const v = String(process.env.MAIN_WATCH_FLAKE_REQUESTS ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function isEnabled() {
  const v = String(process.env.MAIN_WATCH_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

// Re-run a first red once before calling main broken. On by default.
function confirmEnabled() {
  const v = String(process.env.MAIN_WATCH_CONFIRM ?? '1').trim().toLowerCase();
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

// The suite's own account of a red, without the bookkeeping a run keeps
// around it: what a re-run carries over as the red it is re-asking about.
function redOf(detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const out = {};
  for (const key of ['summary', 'failureReason', 'failingTests', 'failingTestsComplete']) {
    if (d[key] !== undefined) out[key] = d[key];
  }
  return out;
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
async function takeSlot(config, pool, app, mergeSha) {
  const none = { superseded: false, release: async () => {} };
  if (config?.workerRuntime !== 'kubernetes' || !checksQueue.isEnabled()) return none;
  const runId = crypto.randomUUID();
  const place = await checksQueue.enqueue(pool, {
    runId, kind: 'main', appId: app.id, commitSha: mergeSha, manifest: { kind: 'main' },
  });
  if (!place) return none;
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
    return { superseded: true, release: async () => {} };
  }
  if (slot.waitedMs >= checksQueue.POLL_MS) {
    log.info('main-watch', 'Checks slot granted', { appId: app.id, sha: mergeSha, waitedMs: slot.waitedMs });
  }
  return { superseded: false, release };
}

// One run of the suite on the merge commit, as a verdict. Never throws: a
// runner that could not be reached is an 'error' verdict. 'superseded' is a
// run that never started because a newer merge took the row while it
// waited for its slot; afterMerge stores nothing for it.
async function runSuite(config, pool, app, parsed, mergeSha) {
  let slot = null;
  try {
    slot = await takeSlot(config, pool, app, mergeSha);
    if (slot.superseded) return { state: 'superseded', detail: {} };
    const outcome = await unitSuite.maybeRunUnitSuite({
      config, pool, appId: app.id,
      // Not a proposal's run: named for the app so a session's own cleanup
      // (kubernetes.cancelPreviewChecks matches on `s<sessionId>-`) cannot
      // take it down, and so the container name is stable per app.
      sessionId: `main-${app.id}`,
      repoOwner: parsed.owner, repoName: parsed.repo, ref: mergeSha, prNumber: null,
    });
    return classify(outcome);
  } catch (err) {
    return { state: 'error', detail: { failureReason: String(err && err.message || err).slice(0, 600) } };
  } finally {
    if (slot) await slot.release().catch(() => {});
  }
}

// The compare-and-swap write of a state for the merge commit this run is
// about. The pause column moves with the state: green clears it, red sets
// it (unless an admin already resumed this very sha), anything else — a run
// that could not happen — leaves it as it was. A red whose failures are all
// known flakes (`flakesOnly`) is green for the pause: every other test
// passed, so it clears a pause rather than setting one. Returns true when
// the row was still ours, false when a newer merge re-claimed it, null on a
// failed write.
async function writeState(pool, app, mergeSha, state, detail) {
  const quiet = !!detail && Array.isArray(detail.flakesOnly) && detail.flakesOnly.length > 0;
  try {
    const write = await pool.query(
      `UPDATE apps
          SET main_check_state = $3, main_check_at = NOW(), main_check_detail = $4::jsonb,
              main_check_paused_sha = CASE
                WHEN $5::boolean THEN NULL
                WHEN $6::boolean AND lower(coalesce(main_check_resumed_sha, '')) <> lower($2::text) THEN $2::text
                ELSE main_check_paused_sha
              END
        WHERE id = $1 AND main_check_sha = $2::text`,
      [app.id, mergeSha, state, JSON.stringify(detail),
        state === 'passing' || quiet, (state === 'failing' || state === 'confirming') && !quiet]
    );
    return write.rowCount !== 0;
  } catch (err) {
    log.warn('main-watch', 'state write failed', { appId: app.id, sha: mergeSha, state, err: err.message });
    return null;
  }
}

/**
 * Run the suite on a merge commit and record what it said. Fire-and-forget
 * from finalizeMerge; never throws.
 *
 * `confirmationOf` is the re-drive of an INTERRUPTED confirmation
 * (resumeInterrupted below): the first red's detail, already recorded, so
 * this run starts at the re-run instead of asking the suite twice more.
 */
// `strict` (the merge-followups machine's durable work) throws when the claim
// itself could not be written, so the work is retried rather than read as done.
async function afterMerge(config, pool, { app, session = null, mergeSha, confirmationOf = null, resume = false, strict = false } = {}) {
  if (!isEnabled() || !pool || !app || !mergeSha) return null;
  const parsed = parseRepo(app.repo_url);
  if (!parsed) return null;
  const prNumber = session && session.pr_number ? Number(session.pr_number) : null;
  const startedDetail = { prNumber, sessionId: session ? session.id : null };

  // Claim the sha. The CTE reads the state this run supersedes, which is
  // how a red→green transition is noticed below. The pause column is not
  // touched: a new merge is a new question about the code, not an answer
  // to the old one.
  let previous = null;
  try {
    const { rows } = await pool.query(
      `WITH prev AS (
         SELECT main_check_state AS was_state, main_check_sha AS was_sha,
                main_check_paused_sha AS was_paused_sha
           FROM apps WHERE id = $1
       )
       UPDATE apps
          SET main_check_state = 'running', main_check_sha = $2,
              main_check_at = NOW(), main_check_detail = $3::jsonb
        WHERE id = $1
          AND ($4::boolean OR main_check_sha IS DISTINCT FROM $2
               OR main_check_state IS NULL OR main_check_state = 'error')
    RETURNING (SELECT was_state FROM prev) AS was_state, (SELECT was_sha FROM prev) AS was_sha,
              (SELECT was_paused_sha FROM prev) AS was_paused_sha`,
      [app.id, mergeSha, JSON.stringify(startedDetail), resume]
    );
    previous = rows[0] || null;
  } catch (err) {
    if (strict) throw err;
    log.warn('main-watch', 'claim failed; not running', { appId: app.id, err: err.message });
    return null;
  }
  if (!previous) return null; // Already claimed or completed for this SHA.
  const wasPaused = !!previous && (!!previous.was_paused_sha
    || previous.was_state === 'failing' || previous.was_state === 'confirming');

  let verdict;
  if (confirmationOf) {
    // The first run already happened and was red; the process that was
    // re-running it is gone. Pick up where it stopped.
    verdict = { state: 'failing', detail: redOf(confirmationOf) };
  } else {
    log.info('main-watch', 'Running the unit suite on main', {
      appId: app.id, slug: app.slug, sha: mergeSha, prNumber,
    });
    verdict = await runSuite(config, pool, app, parsed, mergeSha);
  }
  if (verdict.state === 'superseded') return null;

  // The first red's tests, for a flake record if the re-run is green.
  const firstRun = verdict.state === 'failing' ? verdict.detail : null;
  const firstExcerpts = verdict.excerpts || [];
  if (verdict.state === 'failing' && confirmEnabled()) {
    // Provisional: hold the pause, say so, and ask the suite again. A red
    // of known flakes alone holds nothing while it is asked again.
    const quietFirst = await knownFlakeNames(pool, app.id, firstRun);
    const held = await writeState(pool, app, mergeSha, 'confirming', {
      ...startedDetail, ...firstRun, confirming: true, ...(quietFirst ? { flakesOnly: quietFirst } : {}),
    });
    if (held === null) return null;
    if (!held) {
      log.info('main-watch', 'Discarded a first red for a superseded merge', { appId: app.id, sha: mergeSha });
      return null;
    }
    // Held, the board's banner says so (main-pause-store: "re-running to
    // confirm"); nothing is posted anywhere else.
    log.info('main-watch', confirmationOf
      ? 'Resuming an interrupted confirming run'
      : 'main failed once; re-running to confirm', {
      appId: app.id, slug: app.slug, sha: mergeSha, prNumber, test: firstFailingTest(firstRun.failureReason),
    });
    const again = await runSuite(config, pool, app, parsed, mergeSha);
    if (again.state === 'superseded') return null;
    if (again.state === 'passing') {
      verdict = { state: 'passing', detail: { ...again.detail, flake: firstRun } };
    } else if (again.state === 'failing') {
      verdict = { state: 'failing', detail: { ...again.detail, confirmed: true, firstRun } };
    } else {
      // The re-run could not happen: it neither confirms nor clears the
      // first red, which stands, and says so. recheckPaused asks again in
      // a few minutes.
      verdict = { state: 'failing', detail: { ...firstRun, confirmed: false, confirmation: again.detail } };
    }
  }
  const detail = { ...startedDetail, ...verdict.detail };
  if (verdict.state === 'failing') {
    const quiet = await knownFlakeNames(pool, app.id, redOf(verdict.detail));
    if (quiet) detail.flakesOnly = quiet;
  }

  const stored = await writeState(pool, app, mergeSha, verdict.state, detail);
  if (stored === null) return null;
  if (!stored) {
    log.info('main-watch', 'Discarded a verdict for a superseded merge', { appId: app.id, sha: mergeSha });
    return null;
  }
  log.info('main-watch', `main is ${verdict.state}`, {
    appId: app.id, slug: app.slug, sha: mergeSha, prNumber, state: verdict.state,
    confirmed: detail.confirmed, flake: !!detail.flake,
    ...(detail.flakesOnly ? { flakesOnly: detail.flakesOnly.length } : {}),
  });

  // A red pauses merges and a green lifts the pause: the stored state is
  // the whole of it, and the board's banner is how it is seen
  // (main-pause-store). A channel carries no activity.
  if (verdict.state === 'passing' && detail.flake) {
    kickQueue(config, app.id, 'post-flake');
  } else if ((verdict.state === 'passing' || detail.flakesOnly) && wasPaused) {
    // The pause lifted; whatever was approved meanwhile can go.
    kickQueue(config, app.id, 'post-green');
  }
  // Red then green on one commit: the tests that failed are flaky.
  if (verdict.state === 'passing' && detail.flake && firstRun) {
    await noteFlakes(config, pool, app, mergeSha, [firstRun], firstExcerpts);
  } else if (detail.flakesOnly) {
    await fileFlakeRequests(config, pool, app, redOf(detail).failingTests || [], { mergeSha });
  }
  return { state: verdict.state, sha: mergeSha, detail };
}

function kickQueue(config, appId, why) {
  try {
    require('./merge-queue').enqueue(config, appId);
  } catch (err) {
    log.warn('main-watch', `${why} enqueue failed`, { appId, err: err.message });
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

// The failing tests' names when EVERY one of them is a known flake: named
// in full (the suite's recap counted no failure the list lacks) and each
// seen flaking within FLAKE_MEMORY_DAYS. Null otherwise, and on any doubt:
// a read that fails pauses as before.
async function knownFlakeNames(pool, appId, red) {
  const tests = red && Array.isArray(red.failingTests) ? red.failingTests : [];
  if (!tests.length || red.failingTestsComplete !== true) return null;
  try {
    const { rows } = await pool.query(
      `SELECT file, test FROM main_test_flakes
        WHERE app_id = $1 AND last_seen_at > NOW() - ($2::int * interval '1 day')`,
      [appId, FLAKE_MEMORY_DAYS]
    );
    const known = new Set((rows || []).map((r) => testKey({ file: r.file, test: r.test })));
    return tests.every((t) => known.has(testKey(t))) ? tests.map((t) => t.test) : null;
  } catch (err) {
    log.warn('main-watch', 'flake read failed; pausing as usual', { appId, err: err.message });
    return null;
  }
}

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
    const bot = require('./homeroom-bot');
    const botUser = await bot.ensureBotUser(pool, config);
    const { title, body } = flakeRequestText(t, {
      mergeSha, seenCount: Number(claimed[0].seen_count) || 1, firstSeenAt: claimed[0].first_seen_at, excerpt,
    });
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
    await pool.query(
      'UPDATE main_test_flakes SET request_issue_number = $4 WHERE app_id = $1 AND file = $2 AND test = $3',
      [...key, issueNumber]
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

// ── Rechecks ─────────────────────────────────────────────────────────────
//
// A paused main asks the suite again by itself. The state stays 'failing'
// throughout, so the banner and an admin's Resume read as before; the
// detail's `rechecks` counter is the claim (two sweeps that read the same
// count cannot both move it on), and `recheckingAt` marks the run in
// flight until its verdict replaces the detail.

/**
 * Re-run the suite on each paused main that is due: a red whose confirming
 * re-run could not happen after confirmRetryMs, a confirmed red after
 * recheckMs, each at most maxRechecks times. Green lifts the pause and
 * records the flakes; red stands. Leader-only, on start()'s timer. The runs
 * are not awaited: returns the rows taken, and `done` for tests.
 */
async function recheckPaused(config, { pool = null, max = maxRechecks() } = {}) {
  const none = { rechecked: [], done: Promise.resolve([]) };
  if (!isEnabled() || !(max > 0)) return none;
  const db = pool || require('../db/pool').getPool(config);
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id, slug, repo_url, main_check_sha, main_check_detail
         FROM apps
        WHERE main_check_state = 'failing'
          AND main_check_sha IS NOT NULL
          AND lower(coalesce(main_check_paused_sha, '')) = lower(main_check_sha)
          AND coalesce((main_check_detail->>'rechecks')::int, 0) < $1::int
          AND (main_check_detail->>'recheckingAt' IS NULL
               OR (main_check_detail->>'recheckingAt')::timestamptz < NOW() - ($4::int * interval '1 millisecond'))
          AND main_check_at < NOW() - (CASE WHEN main_check_detail->>'confirmed' = 'false'
                                            THEN $2::int ELSE $3::int END * interval '1 millisecond')
        ORDER BY main_check_at`,
      [max, confirmRetryMs(), recheckMs(), staleMs()]
    ));
  } catch (err) {
    log.warn('main-watch', 'Could not list paused mains (non-fatal)', { err: err.message });
    return none;
  }
  if (!rows || !rows.length) return none;
  const rechecked = [];
  const runs = [];
  for (const row of rows) {
    rechecked.push({ appId: row.id, sha: row.main_check_sha });
    runs.push(recheckOne(config, db, row, max).catch((err) => {
      log.warn('main-watch', 'Recheck failed (non-fatal)', { appId: row.id, err: err.message });
      return null;
    }));
  }
  return { rechecked, done: Promise.all(runs) };
}

async function recheckOne(config, pool, row, max) {
  const app = { id: row.id, slug: row.slug, repo_url: row.repo_url };
  const parsed = parseRepo(app.repo_url);
  if (!parsed) return null;
  const mergeSha = row.main_check_sha;
  const before = row.main_check_detail && typeof row.main_check_detail === 'object' ? row.main_check_detail : {};
  const n = (Number.isInteger(before.rechecks) ? before.rechecks : 0) + 1;
  const claim = await pool.query(
    `UPDATE apps
        SET main_check_detail = coalesce(main_check_detail, '{}'::jsonb)
              || jsonb_build_object('rechecks', $3::int, 'recheckingAt', NOW())
      WHERE id = $1 AND main_check_sha = $2 AND main_check_state = 'failing'
        AND main_check_paused_sha IS NOT NULL
        AND coalesce((main_check_detail->>'rechecks')::int, 0) = $3::int - 1`,
    [app.id, mergeSha, n]
  );
  if (!claim.rowCount) return null;
  const red = redOf(before);
  log.info('main-watch', before.confirmed === false
    ? 'Retrying a confirmation that could not run'
    : 'Re-checking a paused main', {
    appId: app.id, slug: app.slug, sha: mergeSha, recheck: n, of: max, test: firstFailingTest(red.failureReason),
  });
  const again = await runSuite(config, pool, app, parsed, mergeSha);
  if (again.state === 'superseded') return null;
  const keep = {
    ...(before.prNumber !== undefined ? { prNumber: before.prNumber } : {}),
    ...(before.sessionId !== undefined ? { sessionId: before.sessionId } : {}),
    rechecks: n,
  };
  let state;
  let detail;
  if (again.state === 'passing') {
    state = 'passing';
    detail = { ...keep, ...again.detail, flake: red };
  } else if (again.state === 'failing') {
    state = 'failing';
    detail = { ...keep, ...again.detail, confirmed: true, firstRun: red };
    const quiet = await knownFlakeNames(pool, app.id, again.detail);
    if (quiet) detail.flakesOnly = quiet;
  } else {
    // It could not run this time either: the red stands as it was, with
    // one recheck spent.
    const { recheckingAt, ...rest } = before;
    state = 'failing';
    detail = { ...rest, rechecks: n, recheckError: again.detail };
  }
  const stored = await writeState(pool, app, mergeSha, state, detail);
  if (!stored) return null;
  log.info('main-watch', `main is ${state}`, {
    appId: app.id, slug: app.slug, sha: mergeSha, state, recheck: n, flake: !!detail.flake,
    ...(detail.flakesOnly ? { flakesOnly: detail.flakesOnly.length } : {}),
  });
  if (state === 'passing' || detail.flakesOnly) kickQueue(config, app.id, 'post-recheck');
  if (state === 'passing') {
    await noteFlakes(config, pool, app, mergeSha, [red, before.firstRun].filter(Boolean));
  } else if (detail.flakesOnly) {
    await fileFlakeRequests(config, pool, app, again.detail.failingTests || [], { mergeSha, excerpts: again.excerpts || [] });
  }
  return { state, sha: mergeSha, detail };
}

/**
 * An admin's "resume merges" for the current pause. Lifts it and remembers
 * the sha it was about, so a red verdict still in flight for that same sha
 * cannot re-pause. Returns the block the API serializes, or null when there
 * was nothing to resume.
 */
async function resume(config, pool, appId, { by = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE apps
        SET main_check_resumed_sha = main_check_paused_sha, main_check_paused_sha = NULL
      WHERE id = $1 AND main_check_paused_sha IS NOT NULL
    RETURNING main_check_state, main_check_sha, main_check_at, main_check_detail,
              main_check_resumed_sha, main_check_paused_sha`,
    [appId]
  );
  if (!rows[0]) return null;
  log.info('main-watch', 'Merges resumed by an admin', {
    appId, sha: rows[0].main_check_resumed_sha, by: by && by.username,
  });
  kickQueue(config, appId, 'post-resume');
  return describe(rows[0]);
}

// How long a 'running' / 'confirming' row may sit before it is taken for
// interrupted. One suite run is bounded by UNIT_SUITE_TIMEOUT_MS, and each
// phase re-stamps main_check_at when it begins, so a row older than a run
// plus a margin has no process behind it.
function staleMs() {
  const v = parseInt(process.env.MAIN_WATCH_STALE_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : unitSuite.UNIT_SUITE_TIMEOUT_MS + 2 * 60 * 1000;
}

/**
 * Re-drive runs a restart interrupted. afterMerge is fire-and-forget from the
 * process that merged, and for the platform's own app that process is
 * replaced by the deploy of the very merge it is testing — so a rollout
 * mid-run leaves the row at 'running' ("checking the last merge", forever)
 * or, worse, at 'confirming': paused, no verdict coming, and no Resume verb
 * because a provisional red hides it. This turns each such row back into a
 * run: 'running' asks the suite again for that sha; 'confirming' resumes at
 * the re-run, with the recorded first red carried over.
 *
 * The checks queue (services/checks-queue.js) moves both edges. A run of the
 * row's sha whose process is alive, waiting for its slot or running, is
 * never re-driven, however long ago the row was stamped. A run that was
 * still waiting when its process died is re-driven at once rather than when
 * the row goes stale, and the new run takes over its place in line.
 *
 * Leader-only (server.js becomeLeader): once at boot, then on a timer. Rows
 * younger than `olderThanMs` are left alone — a live run somewhere else in
 * the cluster is stamped within the window. The runs themselves are not
 * awaited: returns the rows taken, and `done` for tests.
 */
async function resumeInterrupted(config, { pool = null, olderThanMs = staleMs() } = {}) {
  if (!isEnabled()) return { resumed: [], done: Promise.resolve([]) };
  const db = pool || require('../db/pool').getPool(config);
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id, slug, repo_url, main_check_state, main_check_sha, main_check_detail
         FROM apps
        WHERE main_check_state IN ('running', 'confirming')
          AND main_check_sha IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM check_runs cr
             WHERE cr.kind = 'main' AND cr.app_id = apps.id
               AND lower(cr.commit_sha) = lower(apps.main_check_sha)
               AND cr.heartbeat_at >= NOW() - ($2::int * interval '1 millisecond'))
          AND (main_check_at < NOW() - ($1::int * interval '1 millisecond')
               OR EXISTS (
                 SELECT 1 FROM check_runs cr
                  WHERE cr.kind = 'main' AND cr.app_id = apps.id
                    AND lower(cr.commit_sha) = lower(apps.main_check_sha)
                    AND cr.admitted_at IS NULL))
        ORDER BY main_check_at`,
      [olderThanMs, Math.round(checkRuns.ORPHAN_MS)]
    ));
  } catch (err) {
    log.warn('main-watch', 'Could not list interrupted runs (non-fatal)', { err: err.message });
    return { resumed: [], done: Promise.resolve([]) };
  }
  if (!rows.length) return { resumed: [], done: Promise.resolve([]) };
  const resumed = [];
  const runs = [];
  for (const row of rows) {
    const app = { id: row.id, slug: row.slug, repo_url: row.repo_url };
    const detail = row.main_check_detail && typeof row.main_check_detail === 'object' ? row.main_check_detail : {};
    const session = detail.sessionId ? { id: detail.sessionId, pr_number: detail.prNumber || null } : null;
    // A confirming row's detail is the first red (writeState above): the
    // suite's own account of it, minus the bookkeeping this run re-adds.
    const firstRun = redOf(detail);
    const confirmationOf = row.main_check_state === 'confirming' && firstRun.failureReason ? firstRun : null;
    log.info('main-watch', 'Re-driving an interrupted run', {
      appId: row.id, slug: row.slug, sha: row.main_check_sha, was: row.main_check_state,
      resumingConfirmation: !!confirmationOf,
    });
    resumed.push({ appId: row.id, sha: row.main_check_sha, was: row.main_check_state });
    runs.push(afterMerge(config, db, { app, session, mergeSha: row.main_check_sha, confirmationOf, resume: true })
      .catch((err) => {
        log.warn('main-watch', 'Re-drive failed (non-fatal)', { appId: row.id, err: err.message });
        return null;
      }));
  }
  return { resumed, done: Promise.all(runs) };
}

/** The leader's timer for resumeInterrupted and recheckPaused. Returns a stop function. */
function start(config, { intervalMs = 2 * 60 * 1000 } = {}) {
  if (!isEnabled()) return () => {};
  const timer = setInterval(() => {
    resumeInterrupted(config).catch((err) => {
      log.warn('main-watch', 'Interrupted-run sweep failed (non-fatal)', { err: err.message });
    });
    recheckPaused(config).catch((err) => {
      log.warn('main-watch', 'Paused-main sweep failed (non-fatal)', { err: err.message });
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  isEnabled,
  confirmEnabled,
  afterMerge,
  mergePause,
  resume,
  resumeInterrupted,
  recheckPaused,
  start,
  staleMs,
  describe,
  classify,
  firstFailingTest,
  // Exported for tests.
  knownFlakeNames,
  noteFlakes,
  fileFlakeRequest,
  flakeRequestText,
  maxRechecks,
  recheckMs,
  confirmRetryMs,
};
