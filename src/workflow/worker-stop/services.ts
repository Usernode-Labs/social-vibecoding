import type { Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK, failure } from './machine.ts';
import { WORK as INTERRUPT } from './interrupt.ts';

export function workerStopServices({ pool }: { pool: Pool }): Record<string, WorkHandler> {
  return { [WORK]: {
    maxAttempts: 1, leaseMs: 120_000, concurrency: 16,
    async run(ctx) {
      const { processRole, runsWorkflow } = legacy('services/process-role');
      if (!runsWorkflow(processRole())) throw new Error('Worker stops require a workflow process');
      try {
        return await legacy('services/worker-force-stop').run(pool, ctx.input, {
          renew: () => ctx.checkpoint(null), signal: ctx.signal,
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const e = err as Error & { code?: string };
        return e.code === 'turn_changed' || e.code === 'not_authorized'
          ? failure(e.code, e.code === 'not_authorized' ? 'Session not found' : 'The running job changed. Retry Stop.', e.code === 'not_authorized' ? 404 : 409)
          : failure();
      }
    },
  } };
}

export function workerInterruptServices({ pool }: { pool: Pool }): Record<string, WorkHandler> {
  return { [INTERRUPT]: {
    maxAttempts: 1, leaseMs: 120_000, concurrency: 16,
    async run(ctx) {
      try {
        return await legacy('services/worker-interrupt').perform(pool, ctx.input, {
          renew: () => ctx.checkpoint(null), signal: ctx.signal,
        });
      } catch (err) {
        if (ctx.signal?.aborted || (err as { code?: string })?.code === 'workflow_role_required') throw err;
        if (ctx.input.action === 'runtime') return { done: true, confirmed: false, reason: 'unavailable' };
        return { executing: null };
      }
    },
  } };
}
