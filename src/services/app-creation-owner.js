'use strict';

/**
 * Who is setting a project up, kept in the database so a restart cannot lose
 * it.
 *
 * POST /api/apps (and an import through it), a remix and Retry all answer at
 * once and set the project up afterwards (app-creator.createApp,
 * app-forker.forkApp): minutes of work started from a request handler, in
 * whichever process served it. The platform restarts 60 to 80 times a day on
 * releases, and that work dies with its process. Before this, the only thing
 * that noticed was the leader's boot sweep, which flipped a row still
 * 'creating' ten minutes after it was MADE to 'error'. Until then the project
 * said "Spinning up..." and Retry refused it (the route takes only 'error');
 * after it, the creator spent one of their MAX_RETRY_COUNT retries on the
 * platform's restart. And since a Retry keeps the row's created_at, the same
 * sweep could flip a retry that its own process was still running, which a
 * second Retry then ran beside it.
 *
 * OWNERSHIP. Every attempt is driven under a token written on its row
 * (apps.creating_owner) with a heartbeat (creating_heartbeat_at) the driver
 * renews every HEARTBEAT_MS while it runs. Taking a row is a compare-and-set:
 * a new row while nobody holds it (takeNew), a failed one together with its
 * error -> creating flip (takeForRetry), and a stranded one only from an
 * owner whose heartbeat lapsed (the sweep). So two processes never drive one
 * row, a row whose owner is alive is never swept, and Retry is refused while
 * an attempt is still running somewhere.
 *
 * RESUMING. Every step of creation adopts what an earlier attempt left:
 * createDatabase adopts the database and resets its role's password,
 * createRepo adopts the repository (adoptExisting), a repository whose
 * repo_url was saved is cloned rather than seeded again, kpack Builds are
 * adopted by name, and a remix already copied into its own repository resumes
 * from it (forkApp). So an interrupted attempt is resumed by running the same
 * path again. The leader does that every SWEEP_INTERVAL_MS for a 'creating'
 * row whose owner has been quiet for OWNER_LAPSE_SECONDS, at most
 * MAX_PLATFORM_REDRIVES times an attempt (creating_redrives, back to 0 when a
 * person starts a new attempt), and only then flips it to 'error', with a
 * record that says the platform interrupted it (`interrupted: true`). A Retry
 * of that failure is not counted against the creator's retries, and not
 * refused by their limit: the restarts were the platform's.
 *
 * Rows nobody owns (made before this, or by a caller that drives creation
 * without it, like the App bench studio's host) keep the boot sweep's old
 * rule: still 'creating' ten minutes after they were made, when the leader
 * starts. They are resumed the same way rather than failed.
 *
 * NOT IN A STAGING PREVIEW. A preview of the platform runs the leader's
 * sweeps against a CLONE of production's database, whose 'creating' rows are
 * production's, mid-flight; resuming one there would set up a production
 * project from a preview. There (USERNODE_ENV=staging) the sweep only fails
 * stranded rows, as the boot sweep always did.
 */

const crypto = require('crypto');
const log = require('./logger');
const lifecycle = require('./lifecycle');
const deployFailure = require('./deploy-failure');

// How often a driver says it is still there, and how long a row's owner may
// be quiet before the leader takes the row over. Four missed renewals: a
// process stalled for a moment is not mistaken for a dead one.
const HEARTBEAT_MS = 20 * 1000;
const OWNER_LAPSE_SECONDS = 90;
// The leader's pass. A release's new Pod becomes leader once the old one has
// exited, so a creation it was running is resumed within about
// OWNER_LAPSE_SECONDS + SWEEP_INTERVAL_MS of that.
const SWEEP_INTERVAL_MS = 60 * 1000;
// Resumes the platform owes one attempt before it is reported as failed: a
// creation that dies with its process this often is not being interrupted,
// it is what is killing the process.
const MAX_PLATFORM_REDRIVES = 3;
// Rows taken a pass. Each resume runs on in the background.
const SWEEP_BATCH = 5;
// If an attempt has not finished within this window, its row is flipped to
// 'error' so the home screen stops showing "Spinning up..." and the creator
// can retry. Per attempt, in the process running it.
const CREATION_TIMEOUT_MS = 5 * 60 * 1000;
// How long a driver holds its row at most. A creation past the timeout above
// that is still running keeps the row until it settles (its late success
// still lands as 'running', as it always has) so a Retry cannot start a
// second one beside it; one wedged for this long is let go, and its owner
// lapses like a dead one's.
const HOLD_LIMIT_MS = 15 * 60 * 1000;
// The boot sweep's rule for a row nobody owns, unchanged.
const OWNERLESS_AFTER_MINUTES = 10;

const INTERRUPTED_REASON = 'App creation was interrupted by a platform restart';
const TIMEOUT_REASON = `App creation timed out after ${Math.round(CREATION_TIMEOUT_MS / 60000)} minutes`;

function newOwner() {
  return crypto.randomUUID();
}

// The rows an attempt in THIS process is driving, whatever their heartbeat
// says. A process whose renewals failed for a while (its database connection
// dropped, say) still has its attempt running: the sweep never takes a row
// over from its own process, so the two can never build one project side by
// side in one working directory.
const driving = new Map(); // appId -> how many
const startDriving = (id) => driving.set(id, (driving.get(id) || 0) + 1);
const stopDriving = (id) => {
  const left = (driving.get(id) || 1) - 1;
  if (left > 0) driving.set(id, left); else driving.delete(id);
};

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

/** The last_failure a creation the platform's restarts ended carries. */
function interruptedRecord() {
  return { ...deployFailure.syntheticRecord('timeout', INTERRUPTED_REASON), interrupted: true };
}

/** Whether a last_failure is the platform's restarts rather than the project's. */
function isInterrupted(failure) {
  return !!failure && typeof failure === 'object' && failure.interrupted === true;
}

/**
 * Take a row this request just made. It is this request's whether or not the
 * write lands: nobody else can be driving a row made a moment ago, so a
 * failed write only leaves it to the boot sweep's old ownerless rule.
 * Resolves the owner token to drive it under.
 */
async function takeNew(pool, appId) {
  const owner = newOwner();
  try {
    const { rowCount } = await pool.query(
      `UPDATE apps SET creating_owner = $2, creating_heartbeat_at = NOW()
        WHERE id = $1 AND status = 'creating' AND creating_owner IS NULL`,
      [appId, owner]
    );
    if (!rowCount) log.warn('app-creation-owner', 'New project not taken; left to the boot sweep', { appId });
  } catch (err) {
    log.warn('app-creation-owner', 'New project not taken; left to the boot sweep', { appId, err: err.message });
  }
  return owner;
}

/**
 * A Retry: the error -> creating flip and the row's ownership in one write,
 * so it starts only when no attempt is still running anywhere (nobody holds
 * the row, or its owner went quiet). `counted`: whether this attempt is one
 * of the creator's retries; false after a failure the platform's restarts
 * caused (isInterrupted). Resolves the owner token, or null when it did not
 * start.
 */
async function takeForRetry(pool, appId, { counted = true } = {}) {
  const owner = newOwner();
  const params = [appId, owner, OWNER_LAPSE_SECONDS];
  let taken;
  if (counted) {
    taken = await pool.query(
      `UPDATE apps
          SET status = 'creating', retry_count = retry_count + 1,
              last_failure = NULL,
              creating_owner = $2, creating_heartbeat_at = NOW(), creating_redrives = 0
        WHERE id = $1 AND status = 'error'
          AND (creating_owner IS NULL OR creating_heartbeat_at IS NULL
               OR creating_heartbeat_at < NOW() - make_interval(secs => $3))`,
      params
    );
  } else {
    taken = await pool.query(
      `UPDATE apps
          SET status = 'creating',
              last_failure = NULL,
              creating_owner = $2, creating_heartbeat_at = NOW(), creating_redrives = 0
        WHERE id = $1 AND status = 'error'
          AND (creating_owner IS NULL OR creating_heartbeat_at IS NULL
               OR creating_heartbeat_at < NOW() - make_interval(secs => $3))`,
      params
    );
  }
  return taken.rowCount ? owner : null;
}

// Let the row go: only this owner's, so a takeover is never undone.
async function release(pool, appId, owner) {
  await pool.query(
    `UPDATE apps SET creating_owner = NULL, creating_heartbeat_at = NULL
      WHERE id = $1 AND creating_owner = $2`,
    [appId, owner]
  ).catch((err) => log.warn('app-creation-owner', 'Release failed; the owner lapses instead', { appId, err: err.message }));
}

/**
 * Drive one attempt under `owner`: `provision` (createApp or forkApp) runs,
 * the heartbeat is renewed while it does, and the row is let go when it
 * settles. A rejection flips the row to 'error' with what it threw (they
 * catch their own failures; this is the backstop the routes used to carry);
 * CREATION_TIMEOUT_MS flips one still running, which keeps the row until it
 * settles or HOLD_LIMIT_MS. Both writes are this owner's, or a row nobody
 * holds (a take that did not land): never a row another attempt has taken.
 * Returns the attempt's promise, which never rejects; nobody needs to await it.
 */
function drive(pool, appRow, { owner, provision, label = 'App creation', timing = {} }) {
  const appId = appRow.id;
  const heartbeatMs = timing.heartbeatMs ?? HEARTBEAT_MS;
  const timeoutMs = timing.timeoutMs ?? CREATION_TIMEOUT_MS;
  const holdMs = timing.holdMs ?? HOLD_LIMIT_MS;
  const startedAt = Date.now();
  let held = true;
  startDriving(appId);

  const letGo = () => {
    held = false;
    clearInterval(heartbeat);
  };
  const renew = async () => {
    if (!held) return;
    if (Date.now() - startedAt >= holdMs) {
      log.warn('app-creation-owner', `${label} still running after the hold limit; letting the row go`, { appId });
      letGo();
      return;
    }
    try {
      const { rowCount } = await pool.query(
        `UPDATE apps SET creating_heartbeat_at = NOW() WHERE id = $1 AND creating_owner = $2`,
        [appId, owner]
      );
      if (!rowCount && held) {
        log.warn('app-creation-owner', `${label} no longer owns its row`, { appId });
        letGo();
      }
    } catch (err) {
      // Not proof it is gone: the next renewal decides, and four may fail
      // before the owner lapses.
      log.warn('app-creation-owner', 'Heartbeat failed', { appId, err: err.message });
    }
  };
  const heartbeat = setInterval(() => { void renew(); }, heartbeatMs);
  heartbeat.unref?.();

  const failRow = async (record) => pool.query(
    `UPDATE apps SET status = 'error',
                     last_failure = COALESCE(last_failure, $2::jsonb)
      WHERE id = $1 AND status = 'creating'
        AND (creating_owner = $3 OR creating_owner IS NULL)`,
    [appId, JSON.stringify(record), owner]
  );

  // The watchdog (#416's COALESCE guard: the synthetic timeout record is
  // written only when no real captured failure landed first).
  const watchdog = setTimeout(async () => {
    try {
      const { rowCount } = await failRow(deployFailure.syntheticRecord('timeout', TIMEOUT_REASON));
      if (rowCount > 0) log.warn('apps', 'App creation timed out, marked as error', { appId });
    } catch (err) {
      log.warn('apps', 'Creation watchdog query failed', { appId, err: err.message });
    }
  }, timeoutMs);
  watchdog.unref?.();

  // Started synchronously, as the routes always started it.
  let work;
  try {
    work = Promise.resolve(provision());
  } catch (err) {
    work = Promise.reject(err);
  }
  return work
    .catch(async (err) => {
      log.error('apps', `${label} failed`, { appId, err: err && err.message });
      await failRow(deployFailure.record(err)).catch(() => {});
    })
    .finally(async () => {
      letGo();
      clearTimeout(watchdog);
      stopDriving(appId);
      await release(pool, appId, owner);
    });
}

// The row a sweep may take: still 'creating', not the platform's own, and
// either owned by somebody gone quiet or, at boot only, owned by nobody and
// made more than OWNERLESS_AFTER_MINUTES ago. $1 lapse seconds, $2 ownerless.
// Written out in each statement below so each one re-checks it on the row it
// is about to write.
const STALE = `status = 'creating' AND self_hosted IS NOT TRUE
   AND ((creating_owner IS NOT NULL
         AND (creating_heartbeat_at IS NULL
              OR creating_heartbeat_at < NOW() - make_interval(secs => $1)))
        OR ($2::boolean AND creating_owner IS NULL
            AND created_at < NOW() - make_interval(mins => ${OWNERLESS_AFTER_MINUTES})))`;

// Resume one taken row through the path that made it: a remix through
// app-forker (which resumes from its copied repository once it has one),
// anything else through app-creator.
function resume(config, pool, row, owner, deps) {
  const provision = async () => {
    if (row.forked_from) {
      const forker = deps.forker || require('./app-forker');
      const source = row.repo_url ? null : await forker.findForkSource(pool, row);
      return forker.forkApp(config, row, source);
    }
    const createApp = deps.createApp || require('./app-creator').createApp;
    return createApp(config, row);
  };
  return drive(pool, row, { owner, provision, label: 'Resumed app creation', timing: deps.timing });
}

function pushFailed(rows, deps) {
  for (const row of rows) {
    try {
      const push = deps.pushAppStatusUpdate || require('./ws').pushAppStatusUpdate;
      push({ id: row.id, slug: row.slug, status: 'error', errorReason: INTERRUPTED_REASON });
    } catch (err) {
      log.warn('app-creation-owner', 'Failure broadcast failed', { appId: row.id, err: err.message });
    }
  }
}

/**
 * One pass of the leader's sweep. `ownerless`: also take rows nobody owns
 * that are older than the boot sweep's ten minutes (at boot only; a running
 * process may be driving such a row itself). Rows resumed MAX_PLATFORM_REDRIVES
 * times are flipped to 'error' as interrupted; the rest are taken, each by its
 * own compare-and-set, and resumed in the background. In a staging preview
 * every stranded row is flipped instead (see the header). Resolves
 * { resumed: [appId], failed: [appId] }.
 */
async function sweep(config, pool, { ownerless = false, deps = {} } = {}) {
  const lapse = deps.lapseSeconds ?? OWNER_LAPSE_SECONDS;
  const staging = isStaging() && !deps.allowStaging;
  const limit = staging ? 0 : MAX_PLATFORM_REDRIVES;
  const { rows: failed } = await pool.query(
    `UPDATE apps SET status = 'error',
                     last_failure = COALESCE(last_failure, $3::jsonb),
                     creating_owner = NULL, creating_heartbeat_at = NULL
      WHERE ${STALE} AND creating_redrives >= $4
      RETURNING id, slug`,
    [lapse, ownerless, JSON.stringify(interruptedRecord()), limit]
  );
  if (failed.length) {
    const what = staging
      ? 'Stranded creations marked as error (a staging preview resumes none)'
      : 'Creations the platform kept interrupting, marked as error';
    log.warn('app-creation-owner', what, { appIds: failed.map((r) => r.id), redrives: limit });
    pushFailed(failed, deps);
  }
  const resumed = [];
  if (staging) return { resumed, failed: failed.map((r) => r.id) };

  const { rows: candidates } = await pool.query(
    `SELECT id FROM apps WHERE ${STALE} AND creating_redrives < $3 ORDER BY id LIMIT $4`,
    [lapse, ownerless, limit, SWEEP_BATCH]
  );
  for (const { id } of candidates) {
    if (driving.has(id)) continue;
    const owner = newOwner();
    const { rows: [row] } = await pool.query(
      `UPDATE apps SET creating_owner = $5, creating_heartbeat_at = NOW(),
                       creating_redrives = creating_redrives + 1
        WHERE id = $3 AND ${STALE} AND creating_redrives < $4
        RETURNING *`,
      [lapse, ownerless, id, limit, owner]
    );
    // Taken by another pass, or its owner spoke up: theirs.
    if (!row) continue;
    log.info('app-creation-owner', 'Resuming an interrupted creation', {
      appId: row.id, slug: row.slug, redrive: row.creating_redrives, fork: !!row.forked_from,
    });
    resumed.push(row.id);
    void resume(config, pool, row, owner, deps);
  }
  return { resumed, failed: failed.map((r) => r.id) };
}

let intervalHandle = null;
let sweeping = false;

// Not from a process on its way out: a creation it resumed would die with it
// at once, and be counted against the platform's resumes for nothing.
async function runSweep(config, pool, options) {
  if (sweeping || lifecycle.isShuttingDown?.()) return null;
  sweeping = true;
  try {
    return await sweep(config, pool, options);
  } catch (err) {
    log.warn('app-creation-owner', 'Creation sweep failed', { err: err.message });
    return null;
  } finally {
    sweeping = false;
  }
}

/**
 * The leader's half (server.js becomeLeader): the boot pass, which also takes
 * the rows nobody owns, then a pass every SWEEP_INTERVAL_MS. Resolves once
 * the boot pass has taken what it takes; the resumes it starts run on.
 */
async function start(config, deps = {}) {
  const pool = deps.pool || require('../db/pool').getPool(config);
  const result = await runSweep(config, pool, { ownerless: true, deps });
  if (!intervalHandle) {
    intervalHandle = setInterval(() => { void runSweep(config, pool, { deps }); }, SWEEP_INTERVAL_MS);
    intervalHandle.unref?.();
  }
  return result;
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

module.exports = {
  HEARTBEAT_MS,
  OWNER_LAPSE_SECONDS,
  SWEEP_INTERVAL_MS,
  MAX_PLATFORM_REDRIVES,
  CREATION_TIMEOUT_MS,
  HOLD_LIMIT_MS,
  INTERRUPTED_REASON,
  interruptedRecord,
  isInterrupted,
  takeNew,
  takeForRetry,
  drive,
  sweep,
  start,
  stop,
};
