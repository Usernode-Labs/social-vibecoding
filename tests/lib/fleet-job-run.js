'use strict';

// An admin fleet job's clock run (services/fleet-job.js), in memory: its
// work context, with the kernel's own steps over a checkpoint kept here, and
// the run as platform.clockRunOf reads it. A run started from another's
// checkpoint is that run carried on after a restart.

const { steps } = require('../../src/workflow/kernel/steps.ts');

function fleetJobRun({ n = 1, by = 'admin-user', userId = 7, resumeFrom = null } = {}) {
  const run = {
    n, running: true, startedAt: new Date().toISOString(), endedAt: null,
    input: { n, asked: { by, userId } }, checkpoint: resumeFrom, result: null, error: null,
  };
  const abort = new AbortController();
  // Once the run has ended its claim is gone: a step saved after that is
  // refused, as the kernel refuses a checkpoint from a lost lease.
  let open = true;
  const ctx = {
    input: run.input,
    signal: abort.signal,
    steps: (o = {}) => steps({ ...o, signal: abort.signal, resumeFrom: run.checkpoint, checkpoint: async (v) => {
      if (!open) throw new Error('the claim is gone');
      run.checkpoint = v;
    } }),
  };
  return {
    run,
    ctx,
    // The process goes away: the step under way is kept, the next refused.
    stop: () => abort.abort(),
    // The job's run to its end; resolves its result.
    async go(job, deps) {
      try {
        run.result = await job(ctx, deps);
        return run.result;
      } catch (err) {
        run.error = err.message;
        throw err;
      } finally {
        open = false;
        run.running = false;
        run.endedAt = new Date().toISOString();
      }
    },
  };
}

module.exports = { fleetJobRun };
