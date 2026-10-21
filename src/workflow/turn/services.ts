// The turn machine's work: a person's turn, run whole (services/turns.js):
// the Mayor, the coding run it dispatches and its tail, the wrap-up, or a
// headless run's steps. It drives the coding worker (services/worker.js) and
// the Mayor's model, so it is listed in tests/baselines/workflow-process-
// state.json for that call, as bot-build is for its builds.

import type { Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';
import { lateNotice } from '../rules/late-notice.ts';

interface Deps { config: any; pool: Pool }

export function turnServices({ config, pool }: Deps): Record<string, WorkHandler> {
  return {
    [WORK.run]: {
      // Carried on through a restart from its turn's record and its saved
      // steps: a lost lease is never one of its tries. A turn that throws
      // ended badly (its own catch says so to the person first).
      resumable: true,
      maxAttempts: 1,
      maxLostAttempts: 20,
      leaseMs: 120000,
      // People's turns: as many at once as there are.
      concurrency: 256,
      run: (ctx) => legacy('services/turns').run(ctx, { config, pool }),
    },
    // A conversation opened on a request, named after it (#3752). A request
    // that cannot be read leaves the first message's name.
    [WORK.name]: {
      maxAttempts: 3,
      backoffMs: (n) => 15 * 1000 * n,
      run: async ({ input }) => ({
        title: await legacy('services/agent-sessions').nameFromRequest(pool, {
          agentSessionId: Number(input.agentSessionId), userId: Number(input.userId),
        }),
      }),
    },
    // A failed turn's "Session stopped before finishing", once per turn,
    // unless somebody watches the conversation when it runs.
    [WORK.stalled]: {
      maxAttempts: 5,
      backoffMs: (n) => Math.min(5 * 60 * 1000, 15 * 1000 * 2 ** (n - 1)),
      run: async ({ input }) => (lateNotice(input.owedAt) ? { skipped: 'late' } : legacy('services/turns').tellStalled({ pool }, input)),
    },
  };
}
