'use strict';

const checkRuns = require('../check-runs');
const harvest = require('../check-harvest');
const { checksSettled } = require('./reducer');

// Called inside preview-lifecycle's resource lock, before admitting fresh Jobs.
// This service performs inspection/recovery; the CLI reducer owns completion.
async function recoverCaptureRun(config, { pool, session, previous, force = false }) {
  const { rows } = await pool.query(`SELECT * FROM check_runs
    WHERE session_id = $1 AND run_id = $2`, [session.id, previous.run_id]);
  const recorded = rows[0];
  if (!recorded) {
    const unfinishedRun = previous.state === 'running' && previous.run_id;
    if (checksSettled(session) && unfinishedRun) {
      // The live run removes its manifest before closing the lifecycle.
      // Recover loss in that gap without admitting another capture.
      await require('../kubernetes').cancelPreviewChecks(config, session.id, previous.run_id, { releaseInputs: true });
      await require('../preview-lifecycle').settleAdopted(config, {
        sessionId: session.id,
        runId: previous.run_id,
      }, { result: { state: session.check_state } });
    }
    if (!checksSettled(session) && previous.run_id && previous.state === 'running') {
      const blocked = await require('./checks-outcome').blockOutcome(pool, {
        sessionId: session.id, runId: previous.run_id, headSha: session.checks_commit_sha,
        reason: 'manifest_missing', observedOwner: null,
      });
      return { handled: true, result: blocked.accepted ? { checksBlocked: blocked.recovery } : null };
    }
    return checksSettled(session) && (unfinishedRun || !force)
      ? { handled: true, result: { state: session.check_state } }
      : { handled: false };
  }

  // A live heartbeat remains its owner's responsibility. Harvesting reads
  // the existing Jobs; it never treats heartbeat expiry as creator closure.
  const orphans = await checkRuns.listOrphans(pool, {
    sessionId: session.id,
    runId: recorded.run_id,
    isInFlight: id => require('../visuals').hasInFlightCapture(id) || harvest.isHarvesting(id),
  });
  if (orphans.some(row => row.run_id === recorded.run_id)) {
    const outcome = await harvest.adopt(config, pool, recorded, { reason: 'cli-continuation', retireJobs: true });
    if (outcome.outcome === 'blocked') return { handled: true, result: { checksBlocked: outcome.recovery } };
  }
  // Re-read on the next bounded execution poll. An unconfirmed submission
  // keeps its locator; no recursive capture starts here.
  return { handled: true, result: null };
}

module.exports = { recoverCaptureRun };
