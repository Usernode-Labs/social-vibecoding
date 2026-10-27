import type { Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

export function workerReleaseServices({ pool }: { pool: Pool }): Record<string, WorkHandler> {
  return { [WORK]: {
    maxAttempts: 8, leaseMs: 120000,
    backoffMs: n => Math.min(10 * 60 * 1000, 15000 * 2 ** (n - 1)),
    async run(ctx) {
      const { processRole, runsWorkflow } = legacy('services/process-role');
      if (!runsWorkflow(processRole())) throw new Error('Worker release requires a workflow process');
      return legacy('services/worker-eviction').releaseRequested(pool, ctx.input, {
        renew: () => ctx.checkpoint(null),
      });
    },
  } };
}
