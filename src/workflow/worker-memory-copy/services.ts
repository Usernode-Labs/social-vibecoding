import type { Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

export function workerMemoryCopyServices({ pool }: { pool: Pool }): Record<string, WorkHandler> {
  return { [WORK]: { maxAttempts: 1, leaseMs: 120000, concurrency: 4,
    run: ctx => legacy('services/worker-memory-copy').perform(pool, ctx.input, {
      renew: () => ctx.checkpoint(null), signal: ctx.signal,
    }),
  } };
}
