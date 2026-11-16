// The turn machine's work: a `recover` turn, run whole (services/turns.js):
// a coding record nothing carries, taken through the adoption. It drives the
// coding worker (services/worker.js), so it is listed in tests/baselines/
// workflow-process-state.json for that call, as bot-build is for its builds.

import type { Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

export function turnServices({ config, pool }: Deps): Record<string, WorkHandler> {
  return {
    [WORK.run]: {
      // Run again after a restart, from the change's record: a lost lease
      // is never one of its tries.
      resumable: true,
      maxAttempts: 1,
      maxLostAttempts: 20,
      leaseMs: 120000,
      concurrency: 256,
      run: (ctx) => legacy('services/turns').run(ctx, { config, pool }),
    },
  };
}
