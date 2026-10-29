import type { Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { OPERATIONS, workKind } from './machine.ts';

const MAX_ATTEMPTS = 4;

// A code host or provider that fails now is usually back within seconds: a
// person is waiting on the answer (the route waits for it), so the tries are
// close together, and a refusal is an answer, never a retry. One handler per
// operation kind (machine.ts workKind).
export function platformOperationServices({ pool, config }: { pool: Pool; config: any }): Record<string, WorkHandler> {
  const handler: WorkHandler = {
    maxAttempts: MAX_ATTEMPTS, leaseMs: 120000, resumable: true, concurrency: 8,
    backoffMs: n => [2000, 5000, 15000][n - 1] ?? 30000,
    async run(ctx) {
      const { processRole, runsWorkflow } = legacy('services/process-role');
      if (!runsWorkflow(processRole())) throw new Error('Platform operations require a workflow process');
      const steps = ctx.steps({
        owner: `operation:${ctx.input.requestId}`,
        triesLeft: Math.max(0, MAX_ATTEMPTS - (ctx.attempt - (ctx.lostAttempts ?? 0))),
      });
      return legacy('services/platform-operations').run({ config, pool }, ctx.input, steps);
    },
  };
  return Object.fromEntries([...OPERATIONS].map(op => [workKind(op), handler]));
}
