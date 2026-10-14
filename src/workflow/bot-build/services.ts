// bot-build's work: the build itself, and recording one that was lost. Both
// are the legacy build pipeline's (services/build-runs.js): the handler hands
// it a durable context over the item's checkpoint. It drives the coding
// worker (services/worker.js), which keeps process memory, so this machine
// is listed in tests/baselines/workflow-process-state.json for these two
// calls until the worker client moves (docs/plans/bot-build-workflow.md).

import { legacy } from '../legacy.ts';
import type { WorkHandler } from '../kernel/index.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: any }

// A build carries itself on from its checkpoint: a restart is not one of its
// tries. A handler that throws is (a bug, or the platform failing under it):
// it is tried once more from its checkpoint, then recorded as lost. The
// handler is told it, so a step refused for now (a proposal the platform
// could not take) throws only while a try is left (build-runs.js triesLeftOf).
export const RUN_MAX_ATTEMPTS = 2;

export function botBuildServices(deps: Deps): Record<string, WorkHandler> {
  const runs = () => legacy('services/build-runs');
  return {
    [WORK.run]: {
      resumable: true,
      maxAttempts: RUN_MAX_ATTEMPTS,
      maxLostAttempts: 60,
      // How many run at once is the bot's and the lane's to decide.
      concurrency: 64,
      run: (ctx) => runs().run(ctx, { ...deps, maxAttempts: RUN_MAX_ATTEMPTS }),
    },
    [WORK.lost]: {
      maxAttempts: 5,
      concurrency: 8,
      run: (ctx) => runs().lost(ctx, deps),
    },
  };
}
