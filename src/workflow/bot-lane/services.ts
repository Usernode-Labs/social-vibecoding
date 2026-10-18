// The bot-lane machine's I/O: the refresh against GitHub (services/
// homeroom-bot.js refresh: what each project's requests are owed, appended
// to their bot-request instances, keyed by the refresh so a retry appends
// nothing twice) and the loop's five-minute sweeps (sweep: worker volumes,
// stale and unsent plans, built changes not proposed, waiting first
// versions).

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

export function botLaneServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const bot = () => legacy('services/homeroom-bot');
  return {
    [WORK.refresh]: {
      maxAttempts: 3,
      backoffMs: (a) => Math.min(60 * 1000, 10 * 1000 * 2 ** (a - 1)),
      leaseMs: 120000,
      concurrency: 1,
      async run({ input }): Promise<Json> {
        const out = await bot().refresh(config, pool, { n: Number(input.n), apps: Array.isArray(input.apps) ? input.apps.map(Number) : null });
        return JSON.parse(JSON.stringify(out ?? {})) as Json;
      },
    },
    [WORK.sweep]: {
      maxAttempts: 2,
      leaseMs: 120000,
      concurrency: 1,
      async run(): Promise<Json> {
        const out = await bot().sweep(config, pool);
        return JSON.parse(JSON.stringify(out ?? {})) as Json;
      },
    },
  };
}
