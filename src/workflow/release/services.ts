// The release machine's work: the adoptions a new build owes what an older
// one left (platform.ts hands them in, in order), each a step, so an attempt
// that a restart cut carries on after the ones it finished. Each appends
// under keys of its own (`adopt:`, `rearm:<build>:`, `boot:<build>:`, …), so
// an older release's leader running its own copy during the rollout only
// replays.

import type { Json, WorkHandler } from '../kernel/index.ts';
import { WORK } from './machine.ts';

export type Adoption = readonly [name: string, run: (release: string) => Promise<number | void>];

export function releaseServices({ adoptions }: { adoptions: readonly Adoption[] }): Record<string, WorkHandler> {
  return {
    [WORK.adopt]: {
      maxAttempts: 5,
      backoffMs: (a) => Math.min(10 * 60 * 1000, 30 * 1000 * 2 ** (a - 1)),
      leaseMs: 120000,
      resumable: true,
      concurrency: 1,
      async run(ctx): Promise<Json> {
        const steps = ctx.steps({ owner: `release:${ctx.input.release}` });
        const out: Record<string, Json> = {};
        for (const [name, run] of adoptions) {
          out[name] = await steps.once(name, async () => (await run(String(ctx.input.release))) ?? null) as Json;
        }
        return out;
      },
    },
  };
}
