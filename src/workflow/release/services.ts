// The release machine's work: the adoptions a new build owes what an older
// one left (platform.ts hands them in, in order), each a step, so an attempt
// that a restart cut carries on after the ones it finished, and one that
// failed is tried again without the ones done. Each appends
// under keys of its own (`adopt:`, `rearm:<build>:`, `boot:<build>:`, …), so
// an older release's leader running its own copy during the rollout only
// replays.

import { isStopped } from '../kernel/index.ts';
import type { Json, WorkHandler } from '../kernel/index.ts';
import { WORK } from './machine.ts';

export type Adoption = readonly [name: string, run: (release: string) => Promise<number | void>];

// Tries of the release's work: an adoption's own failure is retried this
// often before it is kept as its error.
const TRIES = 5;

export function releaseServices({ adoptions }: { adoptions: readonly Adoption[] }): Record<string, WorkHandler> {
  return {
    [WORK.adopt]: {
      maxAttempts: TRIES,
      backoffMs: (a) => Math.min(10 * 60 * 1000, 30 * 1000 * 2 ** (a - 1)),
      leaseMs: 120000,
      resumable: true,
      concurrency: 1,
      async run(ctx): Promise<Json> {
        // An adoption that fails is tried again with the work; on its last
        // try its error is kept and the others still run, so one that keeps
        // failing costs only itself for this release.
        const lastTry = ctx.attempt - (ctx.lostAttempts ?? 0) >= TRIES;
        const steps = ctx.steps({ owner: `release:${ctx.input.release}`, triesLeft: Math.max(0, TRIES - (ctx.attempt - (ctx.lostAttempts ?? 0))) });
        const out: Record<string, Json> = {};
        for (const [name, run] of adoptions) {
          out[name] = await steps.once(name, async () => {
            try {
              return (await run(String(ctx.input.release))) ?? null;
            } catch (err) {
              if (!lastTry || isStopped(err)) throw err;
              return { error: String((err as Error)?.message ?? err).slice(0, 500) };
            }
          }) as Json;
        }
        return out;
      },
    },
  };
}
