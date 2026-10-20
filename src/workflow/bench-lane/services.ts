// bench-lane's I/O: the bench user's allowance, looked at for the lane's
// grants, and a run's side builds' results finished when a cap or a cancel
// leaves their trials unrun (services/bench/lane.js).

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

export function benchLaneServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const lane = () => legacy('services/bench/lane');
  return {
    // Whether the bench user's allowance lets a trial start (and the user
    // made, with its included key, before the first one runs).
    [WORK.gate]: {
      maxAttempts: 2,
      concurrency: 1,
      async run(): Promise<Json> {
        return lane().allowanceGate(pool, config);
      },
    },
    [WORK.sides]: {
      maxAttempts: 3,
      backoffMs: (attempt) => 30000 * attempt,
      concurrency: 2,
      async run({ input }): Promise<Json> {
        return { settled: await lane().settleSideResults(pool, { runId: Number(input.runId) }) };
      },
    },
  };
}
