'use strict';

const fs = require('node:fs');

const imageJobs = ['platform', 'worker', 'capture'];
const components = [...imageJobs, 'postgres'];
const runnerStartup = 2;

// Replay just the checks. Publication still requires chooseRelease, the
// serialized publisher, and Argo's confirmation of the previous rollout.
function replayChecks(runs, { slots = 2, shared = false, bypassLiveImages = false } = {}) {
  const available = new Map(components.map(component => [component, Array(slots).fill(0)]));
  const arrivals = [...runs].sort((a, b) => a.plannedAt - b.plannedAt || a.number - b.number);

  return arrivals.map(run => {
    const jobs = {};
    for (const component of components) {
      const job = run.jobs[component];
      if (!job) continue;

      const pool = available.get(component);
      const slot = shared ? pool.indexOf(Math.min(...pool)) : (run.buildLane ?? run.number % slots);
      // Only a digest confirmed live can take this route. Reuse of a build
      // input key alone still requires an available slot and verification.
      const bypass = bypassLiveImages && job.live === true && !job.failed
        && (component === 'worker' || component === 'capture');
      const start = Math.max(run.plannedAt, bypass ? 0 : pool[slot]) + runnerStartup;
      const finish = start + job.seconds;
      if (!bypass) pool[slot] = finish;
      jobs[component] = { start, finish, failed: job.failed === true };
    }

    const completedAt = Math.max(...Object.values(jobs).map(job => job.finish));
    const verified = imageJobs.every(component => jobs[component])
      && (jobs.postgres || run.postgresVerified === true)
      && Object.values(jobs).every(job => !job.failed);
    return { number: run.number, completedAt, verifiedAt: verified ? completedAt : null, jobs };
  });
}

function compareChecks(runs) {
  const fixed = replayChecks(runs);
  const sharedTwo = replayChecks(runs, { shared: true, bypassLiveImages: true });
  const sharedThree = replayChecks(runs, { slots: 3, shared: true, bypassLiveImages: true });
  const fixedThree = replayChecks(runs, { slots: 3 });
  const saved = (first, second) => first.verifiedAt === null || second.verifiedAt === null
    ? null : first.verifiedAt - second.verifiedAt;
  const byNumber = new Map(runs.map(run => [run.number, run]));
  return fixed.map((result, index) => {
    const run = byNumber.get(result.number);
    return {
      run: result.number,
      pr: run.pr,
      modelErrorSeconds: result.verifiedAt === null || run.actualVerifiedAt == null
        ? null : result.verifiedAt - run.actualVerifiedAt,
      sharedTwoSecondsSaved: saved(result, sharedTwo[index]),
      sharedThreeSecondsSaved: saved(result, sharedThree[index]),
      fixedThreeSecondsSaved: saved(result, fixedThree[index]),
    };
  });
}

if (require.main === module) {
  if (!process.argv[2]) {
    console.error('Usage: node scripts/replay-kubernetes-build-queue.js <run-sample.json>');
    process.exitCode = 1;
  } else {
    const runs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    console.table(compareChecks(runs));
  }
}

module.exports = { replayChecks, compareChecks };
