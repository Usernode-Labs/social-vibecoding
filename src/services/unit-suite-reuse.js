'use strict';

// Reuse a passed unit suite for the same commit.
//
// Many checks runs judge a commit that has not changed since its last run:
// a re-drive after a platform restart, a preview the idle sweep collected and
// the heal rebuilt, a stuck-run reconciliation, a promotion kick. The image is
// reused and the browser checks finish early, so the repo unit suite is what
// the verdict waits for (on Homeroom from 13 to 14 Oct 2026: last in 22 of 26
// such runs, by 53.5 s at the median), and in most of them the same commit had
// already passed it. The suite clones the commit ALONE (never merged with
// main) and runs it in the worker image, so its verdict depends on:
//
//   * the commit: its tree holds the tests, package.json (the `test` script,
//     its Node flags, the shell preflight `pretest`) and the lockfile;
//   * the worker image, by digest: Node, PostgreSQL and the OS;
//   * the Job the platform builds around it: RUN_SCRIPT, the shard count, the
//     env, the CPU and memory it is given and its deadline
//     (unit-suite.jobDefinition);
//   * the clock and the network (npm's registry), which nothing can pin.
//
// A pass is therefore recorded with the first three, and a later run whose
// three are equal copies it instead of starting the suite's Jobs, for at most
// MAX_AGE_MS. Only a pass: a failing suite, one that could not run, a setup
// failure, a cancelled or partial one is never recorded, so never reused. And
// only a pass the suite's own process saw end, whose every shard said it had
// checked out exactly this commit (unit-suite.js HEAD_SENTINEL): an outcome a
// harvest read after a restart is not recorded, because the harvesting
// process cannot know which image the Job ran on.
//
// Never when a person asked for the run. "Run checks again" (the button, the
// connector's recheck_change, the CLI's proposal_recheck, submit_work with
// `recheck: true`) all reach the trigger 'manual-recheck', and that run
// always starts the suite. Reuse is for the triggers in AUTOMATIC_TRIGGERS
// alone; a run with no trigger, or one this list does not know, runs it.
//
// The pass is read from the database (unit_suite_passes), so it is found the
// same after a restart. UNIT_SUITE_REUSE=0 turns all of this off: nothing is
// reused and nothing is recorded.

const crypto = require('crypto');
const log = require('./logger');

// Why a run started (visuals.CHECK_TRIGGERS) when nobody asked for it.
// 'manual-recheck' is deliberately absent, and so is anything new: a trigger
// added later runs the suite until it is listed here on purpose.
const AUTOMATIC_TRIGGERS = Object.freeze(new Set([
  'proposal-open',
  'commit-push',
  'sync-main',
  'pr-import',
  'promote-kick',
  'boot-reconcile',
  'stuck-sweep',
  'fleet-maintenance',
  'conflict-resolved',
]));

// How old a pass may be: the one place the limit is set, by the owner's
// decision. 3 hours keeps almost all of what this is for (on 13 to 14 Oct
// 2026 every earlier pass of a re-checked commit was under 1.4 h old but
// one, at 7.9 h) and bounds how long a test that reads the date can carry a
// pass. Nothing else bounds it: the worker image is not rebuilt on a fixed
// schedule (a scheduled build releases only when its inputs changed), so its
// digest can stay the same for days. Rows are kept for twice the limit (see
// recordPass), then deleted with the app's next pass.
const MAX_AGE_HOURS = 3;
const MAX_AGE_MS = MAX_AGE_HOURS * 60 * 60 * 1000;

function isEnabled() {
  const v = String(process.env.UNIT_SUITE_REUSE ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function isAutomaticTrigger(trigger) {
  return AUTOMATIC_TRIGGERS.has(trigger);
}

// The worker image the unit suite runs on, by digest, or null when it is not
// known by one: only Kubernetes pins it (KUBERNETES_WORKER_IMAGE must be
// `…@sha256:…`); Docker runs a tag, which says nothing about its content.
function imageOf(config) {
  if (!config || config.workerRuntime !== 'kubernetes') return null;
  const image = String(config.kubernetes?.workerImage || '').trim();
  return /@sha256:[0-9a-f]{64}$/i.test(image) ? image : null;
}

function repoKey(repoOwner, repoName) {
  if (!repoOwner || !repoName) return null;
  return `${repoOwner}/${repoName}`.toLowerCase();
}

function isSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || ''));
}

/**
 * Everything a pass is matched on, or null when this run cannot be matched
 * (reuse off, no digest, no full SHA). `jobHash` comes from the caller's
 * unit-suite module so tests can vary it.
 */
function keyFor(config, { appId, repoOwner, repoName, commitSha, jobHash }) {
  if (!isEnabled()) return null;
  const image = imageOf(config);
  const repo = repoKey(repoOwner, repoName);
  if (!image || !repo || !isSha(commitSha) || !Number(appId) || !jobHash) return null;
  return { appId: Number(appId), repo, commitSha: String(commitSha).toLowerCase(), image, jobHash };
}

/** Record a pass. Never throws; returns true when a row was written. */
async function recordPass(pool, key, { sessionId = null, runId = null, summary = null } = {}) {
  if (!pool || !key) return false;
  try {
    await pool.query(
      `INSERT INTO unit_suite_passes (app_id, repo, commit_sha, image, job_definition, session_id, run_id, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [key.appId, key.repo, key.commitSha, key.image, key.jobHash,
        Number(sessionId) || null, runId ? String(runId) : null, summary ? JSON.stringify(summary) : null]
    );
    // What can no longer be reused goes with the next pass of the same app.
    await pool.query(
      `DELETE FROM unit_suite_passes
        WHERE app_id = $1 AND passed_at < NOW() - make_interval(secs => $2::double precision)`,
      [key.appId, (MAX_AGE_MS / 1000) * 2]
    );
    log.info('unit-suite-reuse', 'Recorded a unit-suite pass', {
      appId: key.appId, commitSha: key.commitSha, sessionId, runId,
    });
    return true;
  } catch (err) {
    log.warn('unit-suite-reuse', 'Could not record a unit-suite pass (non-fatal)', {
      appId: key.appId, commitSha: key.commitSha, err: err.message,
    });
    return false;
  }
}

/**
 * The newest pass this run may copy, or null. `trigger` is the run's own
 * (visuals.CHECK_TRIGGERS): a person's request never reuses. Never throws:
 * a lookup that fails runs the suite.
 */
//
// Two more conditions, both read from the database so a restart keeps them:
//   * the pass was observed: the run that passed stored its verdict and
//     recorded the pass in app_check_history (markObserved). A pass whose
//     run errored or was discarded has no history row, and the gate a copy
//     earns its proposal (check-history.recordEarned) would then have none
//     to become app-wide on merge;
//   * the proposal reusing it (`sessionId`) is not owed a fresh run of this
//     head: a person asked for one (chat_sessions.unit_suite_fresh_sha).
async function findPass(pool, key, { trigger = null, sessionId = null } = {}) {
  if (!pool || !key || !isAutomaticTrigger(trigger)) return null;
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.session_id, p.run_id, p.summary, p.passed_at
         FROM unit_suite_passes p
        WHERE p.app_id = $1 AND p.repo = $2 AND p.commit_sha = $3 AND p.image = $4 AND p.job_definition = $5
          AND p.passed_at > NOW() - make_interval(secs => $6::double precision)
          AND p.observed_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM chat_sessions cs
             WHERE cs.id = $7::int AND lower(cs.unit_suite_fresh_sha) = $3)
        ORDER BY p.passed_at DESC
        LIMIT 1`,
      [key.appId, key.repo, key.commitSha, key.image, key.jobHash, MAX_AGE_MS / 1000, Number(sessionId) || null]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      sessionId: row.session_id == null ? null : Number(row.session_id),
      runId: row.run_id || null,
      summary: row.summary && typeof row.summary === 'object' ? row.summary : null,
      passedAt: new Date(row.passed_at).toISOString(),
    };
  } catch (err) {
    log.warn('unit-suite-reuse', 'Pass lookup failed — running the suite', {
      appId: key.appId, commitSha: key.commitSha, err: err.message,
    });
    return null;
  }
}

/**
 * A person asked for the checks of this head again ("Run checks again", and
 * every path that reaches 'manual-recheck'): the proposal is owed a unit
 * suite that really runs on it. Stored on the proposal
 * (chat_sessions.unit_suite_fresh_sha), so it holds whichever run ends up
 * answering, after a restart too: no run copies a pass for it (findPass),
 * and no verdict carrying a copied pass is stored for it
 * (visuals.storeChecks), so the head stays pending and merge-blocked until
 * a verdict whose suite ran is stored, which clears it. The 'manual-recheck'
 * pending stamp sets it too (visuals.setChecksPending); this is for the
 * paths that answer before stamping. Never throws.
 */
async function markFreshOwed(pool, { sessionId, commitSha } = {}) {
  if (!pool || !Number(sessionId) || !isSha(commitSha)) return false;
  try {
    const { rowCount } = await pool.query(
      'UPDATE chat_sessions SET unit_suite_fresh_sha = $2 WHERE id = $1',
      [Number(sessionId), String(commitSha).toLowerCase()]
    );
    return rowCount > 0;
  } catch (err) {
    log.warn('unit-suite-reuse', 'Could not mark a fresh unit-suite run owed', {
      sessionId, commitSha, err: err.message,
    });
    return false;
  }
}

/**
 * A person's request was folded into what the session is already doing (an
 * agent turn, a build, a run whose suite is not copied): the route answers
 * "running" without a run of its own. The head is owed a fresh suite
 * (markFreshOwed, already set), so:
 *   * a verdict already stored for it no longer stands: the row is stamped
 *     pending, as the request's own run would, so the merge gate waits and
 *     the stale sweep re-drives the head if this process goes away;
 *   * once the session is idle, if nothing has answered the request yet
 *     (still owed on that head), the owed run starts.
 * `busy()` is the route's own test of "something is running". Never throws.
 */
async function owePendingRun({
  pool, visuals, stagingRecovery, config, session, busy, pollMs = 5000, maxWaitMs = 15 * 60 * 1000,
}) {
  const sha = session && session.checks_commit_sha;
  if (!pool || !isSha(sha)) return false;
  const same = (a) => !!a && String(a).toLowerCase() === String(sha).toLowerCase();
  try {
    const { rows: [row] } = await pool.query(
      'SELECT check_state, checks_commit_sha FROM chat_sessions WHERE id = $1', [Number(session.id)]
    );
    if (row && same(row.checks_commit_sha) && row.check_state !== 'pending') {
      await visuals.setChecksPending(pool, session.id, sha, null, 'manual-recheck');
      visuals.notifyChecksPending(session.id, sha, null, 'manual-recheck');
    }
  } catch (err) {
    log.warn('unit-suite-reuse', 'Could not stamp a folded request pending', { sessionId: session.id, err: err.message });
  }
  const started = Date.now();
  const later = (fn) => { const t = setTimeout(fn, pollMs); if (typeof t.unref === 'function') t.unref(); };
  const tick = async () => {
    try {
      if (busy()) {
        if (Date.now() - started < maxWaitMs) later(tick);
        return;
      }
      const { rows: [r] } = await pool.query(
        'SELECT checks_commit_sha, unit_suite_fresh_sha FROM chat_sessions WHERE id = $1', [Number(session.id)]
      );
      if (!r || !same(r.unit_suite_fresh_sha) || !same(r.checks_commit_sha)) return;
      log.info('unit-suite-reuse', 'The session is idle and its owed unit suite has not run: starting it', {
        sessionId: session.id, commitSha: sha,
      });
      await stagingRecovery.recheckSessionChecks({ config, pool, session, reason: 'manual-recheck' });
    } catch (err) {
      log.warn('unit-suite-reuse', 'Owed run after a folded request failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    }
  };
  later(tick);
  return true;
}

/**
 * Has a unit-suite pass of this commit ever been recorded for the app (any
 * age, observed or not)? Then the commit has a suite. Unreadable reads as
 * yes: the caller then does not take the suite for absent. Never throws.
 */
async function hasAnyPass(pool, { appId, commitSha } = {}) {
  if (!pool || !Number(appId) || !isSha(commitSha)) return true;
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM unit_suite_passes WHERE app_id = $1 AND commit_sha = $2 LIMIT 1',
      [Number(appId), String(commitSha).toLowerCase()]
    );
    return rows.length > 0;
  } catch {
    return true;
  }
}

/**
 * The run of `sessionId` that passed `commitSha` stored its verdict and
 * recorded the pass in the app's history: its passes may now be reused.
 * Never throws.
 */
async function markObserved(pool, { appId, sessionId, commitSha } = {}) {
  if (!pool || !Number(appId) || !Number(sessionId) || !isSha(commitSha)) return 0;
  try {
    const { rowCount } = await pool.query(
      `UPDATE unit_suite_passes SET observed_at = NOW()
        WHERE app_id = $1 AND session_id = $2 AND commit_sha = $3 AND observed_at IS NULL`,
      [Number(appId), Number(sessionId), String(commitSha).toLowerCase()]
    );
    return rowCount || 0;
  } catch (err) {
    log.warn('unit-suite-reuse', 'Could not mark a unit-suite pass observed', {
      appId, sessionId, commitSha, err: err.message,
    });
    return 0;
  }
}

// What a reused row says about where it came from.
function reusedFrom(pass) {
  return {
    runId: pass.runId || null,
    sessionId: pass.sessionId || null,
    passedAt: pass.passedAt,
  };
}

/**
 * The outcome a run stores in place of running the suite: the pass row
 * `shapeOutcome` gives any pass, marked `reused`, and no history record — the
 * pass it copies was observed (and counted) when it ran, and copying it is
 * not a second observation. `earned` is the suite's check key: the gate a
 * pass earns its proposal (chat_sessions.checks_earned_keys, so its later
 * heads cannot quietly fail the suite) is granted to the proposal that
 * copies it all the same (check-history.recordEarned), without touching the
 * app's counts. `shapeOutcome` is unit-suite.js's own.
 */
function reusedOutcome(shapeOutcome, pass) {
  const shaped = shapeOutcome({ passed: true, reason: '', graduated: true, summary: pass.summary || null });
  return {
    row: { ...shaped.row, reused: reusedFrom(pass) },
    history: null,
    earned: shaped.history ? shaped.history.checkKey : null,
    reused: reusedFrom(pass),
  };
}

// The live progress snapshot of a reused suite: finished and passed at once,
// with the counts of the run it copies.
function reusedSnapshot(pass) {
  const s = pass.summary || {};
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const passed = int(s.pass);
  const failed = int(s.fail) + int(s.cancelled);
  const skipped = int(s.skipped) + int(s.todo);
  const ran = Number.isInteger(s.tests) ? s.tests : passed + failed + skipped;
  return {
    phase: 'done', ran, passed, failed, skipped,
    expected: ran || null,
    done: true, exitOk: true,
    ...(pass.summary ? { summary: { ...pass.summary } } : {}),
    reused: reusedFrom(pass),
    updatedAt: new Date().toISOString(),
  };
}

// The commit every shard of a run checked out, read from the lines it
// printed (unit-suite.js HEAD_SENTINEL): the SHA when all `expected` shards
// named the same one, else null.
function checkedOutCommit(lines, sentinel, expected = 1) {
  const heads = [];
  for (const line of lines || []) {
    const l = String(line || '').trim();
    if (l.startsWith(`${sentinel}=`)) heads.push(l.slice(sentinel.length + 1).trim().toLowerCase());
  }
  if (heads.length < Math.max(1, expected)) return null;
  return heads.every((h) => h === heads[0] && isSha(h)) ? heads[0] : null;
}

function jobHashOf(definition) {
  return crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

module.exports = {
  AUTOMATIC_TRIGGERS,
  MAX_AGE_HOURS,
  MAX_AGE_MS,
  isEnabled,
  isAutomaticTrigger,
  imageOf,
  keyFor,
  recordPass,
  findPass,
  markFreshOwed,
  markObserved,
  owePendingRun,
  hasAnyPass,
  reusedOutcome,
  reusedSnapshot,
  checkedOutCommit,
  jobHashOf,
};
