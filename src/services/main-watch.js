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
// Only the unit suite. The dapp.json assertions need a built preview of
// main, which is production itself; a red production is caught by the
// deploy's own health check and the rollback that follows it.
//
// State lives on the apps row (main_check_*; see schema.sql). Every write is
// compare-and-swap on the merge commit, so a slow run for an older merge
// cannot overwrite the verdict for a newer one.

const log = require('./logger');
const unitSuite = require('./unit-suite');

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

function short(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

function sameSha(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// The first failing test's name out of a unit-suite failureReason —
// `not ok 6972 - shared-sessions returns linked_issues per row | # tests …`
// (services/unit-suite.js failureDetail joins its parts with ` | `). Null
// when the reason names no test (a setup failure, a killed run), so callers
// fall back to the whole reason.
function firstFailingTest(failureReason) {
  for (const part of String(failureReason || '').split(' | ')) {
    const m = part.trim().match(/^not ok\s+\d+\s*-?\s*(.+)$/);
    if (!m) continue;
    const name = m[1].replace(/\s+#\s*(SKIP|TODO).*$/i, '').trim();
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
// that could not happen — the clone or the install failed, or the runner
// was killed at its deadline — and says nothing about main, so it pauses
// nothing. A verdict about the code is 'passing' or 'failing'.
function classify(outcome) {
  if (!outcome || !outcome.row) return { state: 'skipped', detail: { reason: 'no runnable test script' } };
  const row = outcome.row;
  const detail = {
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  };
  if (row.status === 'pass') return { state: 'passing', detail };
  const reason = String(row.failureReason || '');
  if (/^Suite setup failed/.test(reason) || /^Suite run exceeded/.test(reason)) {
    return { state: 'error', detail };
  }
  return { state: 'failing', detail };
}

// One run of the suite on the merge commit, as a verdict. Never throws: a
// runner that could not be reached is an 'error' verdict.
async function runSuite(config, pool, app, parsed, mergeSha) {
  try {
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
  }
}

// The compare-and-swap write of a state for the merge commit this run is
// about. The pause column moves with the state: green clears it, red sets
// it (unless an admin already resumed this very sha), anything else — a run
// that could not happen — leaves it as it was. Returns true when the row
// was still ours, false when a newer merge re-claimed it, null on a failed
// write.
async function writeState(pool, app, mergeSha, state, detail) {
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
        state === 'passing', state === 'failing' || state === 'confirming']
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
async function afterMerge(config, pool, { app, session = null, mergeSha, confirmationOf = null } = {}) {
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
    RETURNING (SELECT was_state FROM prev) AS was_state, (SELECT was_sha FROM prev) AS was_sha,
              (SELECT was_paused_sha FROM prev) AS was_paused_sha`,
      [app.id, mergeSha, JSON.stringify(startedDetail)]
    );
    previous = rows[0] || null;
  } catch (err) {
    log.warn('main-watch', 'claim failed; not running', { appId: app.id, err: err.message });
    return null;
  }
  const wasPaused = !!previous && (!!previous.was_paused_sha
    || previous.was_state === 'failing' || previous.was_state === 'confirming');

  const prRef = prNumber ? `PR #${prNumber}` : 'the last merge';
  let verdict;
  if (confirmationOf) {
    // The first run already happened and was red; the process that was
    // re-running it is gone. Pick up where it stopped.
    verdict = { state: 'failing', detail: confirmationOf };
  } else {
    log.info('main-watch', 'Running the unit suite on main', {
      appId: app.id, slug: app.slug, sha: mergeSha, prNumber,
    });
    verdict = await runSuite(config, pool, app, parsed, mergeSha);
  }

  if (verdict.state === 'failing' && confirmEnabled()) {
    // Provisional: hold the pause, say so, and ask the suite again.
    const firstRun = verdict.detail;
    const held = await writeState(pool, app, mergeSha, 'confirming', { ...startedDetail, ...firstRun, confirming: true });
    if (held === null) return null;
    if (!held) {
      log.info('main-watch', 'Discarded a first red for a superseded merge', { appId: app.id, sha: mergeSha });
      return null;
    }
    if (confirmationOf) {
      // The group already heard about the first red; it does not need to
      // hear that a restart happened in between.
      log.info('main-watch', 'Resuming an interrupted confirming run', {
        appId: app.id, slug: app.slug, sha: mergeSha, prNumber, test: firstFailingTest(firstRun.failureReason),
      });
    } else {
      log.info('main-watch', 'main failed once; re-running to confirm', {
        appId: app.id, slug: app.slug, sha: mergeSha, prNumber, test: firstFailingTest(firstRun.failureReason),
      });
      await postGroup(pool, app.id,
        `⚠️ main's unit suite failed after ${prRef} merged (${short(mergeSha)})${named(firstRun)}. `
        + 'Re-running once to confirm; merges are paused meanwhile, except for proposals already '
        + 'tested level with main.');
    }
    const again = await runSuite(config, pool, app, parsed, mergeSha);
    if (again.state === 'passing') {
      verdict = { state: 'passing', detail: { ...again.detail, flake: firstRun } };
    } else if (again.state === 'failing') {
      verdict = { state: 'failing', detail: { ...again.detail, confirmed: true, firstRun } };
    } else {
      // The re-run could not happen: it neither confirms nor clears the
      // first red, which stands, and says so.
      verdict = { state: 'failing', detail: { ...firstRun, confirmed: false, confirmation: again.detail } };
    }
  }
  const detail = { ...startedDetail, ...verdict.detail };

  const stored = await writeState(pool, app, mergeSha, verdict.state, detail);
  if (stored === null) return null;
  if (!stored) {
    log.info('main-watch', 'Discarded a verdict for a superseded merge', { appId: app.id, sha: mergeSha });
    return null;
  }
  log.info('main-watch', `main is ${verdict.state}`, {
    appId: app.id, slug: app.slug, sha: mergeSha, prNumber, state: verdict.state,
    confirmed: detail.confirmed, flake: !!detail.flake,
  });

  if (verdict.state === 'failing') {
    const tail = 'Merges for this app are paused until a fix lands or an admin resumes them.';
    if (detail.confirmed === true) {
      await postGroup(pool, app.id,
        `⚠️ main's unit suite is failing after ${prRef} merged (${short(mergeSha)}), confirmed on a `
        + `second run${named(detail)}. ${tail}`);
    } else if (detail.confirmed === false) {
      const why = detail.confirmation && detail.confirmation.failureReason
        ? ` (${String(detail.confirmation.failureReason).slice(0, 200)})` : '';
      await postGroup(pool, app.id,
        `⚠️ main's unit suite failed after ${prRef} merged (${short(mergeSha)})${named(detail)}, and the `
        + `confirming run could not complete${why}. Merges for this app stay paused until a fix lands `
        + 'or an admin resumes them.');
    } else {
      const reason = detail.failureReason ? ` ${String(detail.failureReason).slice(0, 400)}` : '';
      await postGroup(pool, app.id,
        `⚠️ main's unit suite is failing after ${prRef} merged (${short(mergeSha)}).${reason} ${tail}`);
    }
  } else if (verdict.state === 'passing' && detail.flake) {
    await postGroup(pool, app.id,
      `main's unit suite passed on the confirming run (${short(mergeSha)}); the first failure was a `
      + `flake${named(detail.flake)}. Merges continue.`);
    kickQueue(config, app.id, 'post-flake');
  } else if (verdict.state === 'passing' && wasPaused) {
    await postGroup(pool, app.id,
      `main's unit suite is green again after ${prRef} merged (${short(mergeSha)}). Merges resume.`);
    // The pause lifted; whatever was approved meanwhile can go.
    kickQueue(config, app.id, 'post-green');
  }
  return { state: verdict.state, sha: mergeSha, detail };
}

// `: <test>` for a message, from a verdict detail; the whole reason when
// no test is named; nothing when there is nothing.
function named(detail) {
  const test = firstFailingTest(detail && detail.failureReason);
  if (test) return `: ${test}`;
  const reason = detail && detail.failureReason ? String(detail.failureReason).slice(0, 300) : '';
  return reason ? `: ${reason}` : '';
}

function kickQueue(config, appId, why) {
  try {
    require('./merge-queue').enqueue(config, appId);
  } catch (err) {
    log.warn('main-watch', `${why} enqueue failed`, { appId, err: err.message });
  }
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
  await postGroup(pool, appId,
    `${by && by.username ? by.username : 'An admin'} resumed merges while main's unit suite is failing (${short(rows[0].main_check_resumed_sha)}).`);
  kickQueue(config, appId, 'post-resume');
  return describe(rows[0]);
}

async function postGroup(pool, appId, content) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, appId, content, 'system');
  } catch (err) {
    log.warn('main-watch', 'group message failed', { appId, err: err.message });
  }
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
          AND main_check_at < NOW() - ($1::int * interval '1 millisecond')
        ORDER BY main_check_at`,
      [olderThanMs]
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
    const { prNumber, sessionId, confirming, ...firstRun } = detail;
    const confirmationOf = row.main_check_state === 'confirming' && firstRun.failureReason ? firstRun : null;
    log.info('main-watch', 'Re-driving an interrupted run', {
      appId: row.id, slug: row.slug, sha: row.main_check_sha, was: row.main_check_state,
      resumingConfirmation: !!confirmationOf,
    });
    resumed.push({ appId: row.id, sha: row.main_check_sha, was: row.main_check_state });
    runs.push(afterMerge(config, db, { app, session, mergeSha: row.main_check_sha, confirmationOf })
      .catch((err) => {
        log.warn('main-watch', 'Re-drive failed (non-fatal)', { appId: row.id, err: err.message });
        return null;
      }));
  }
  return { resumed, done: Promise.all(runs) };
}

/** The leader's timer for resumeInterrupted. Returns a stop function. */
function start(config, { intervalMs = 2 * 60 * 1000 } = {}) {
  if (!isEnabled()) return () => {};
  const timer = setInterval(() => {
    resumeInterrupted(config).catch((err) => {
      log.warn('main-watch', 'Interrupted-run sweep failed (non-fatal)', { err: err.message });
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
  start,
  staleMs,
  describe,
  classify,
  firstFailingTest,
};
