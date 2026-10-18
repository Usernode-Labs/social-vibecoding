// The bot-request machine's I/O: the bot's look at a request (a read, or a
// reply or fix on its change: services/homeroom-bot.js lookAt), the start of
// a ready verdict's build (startBuild: the build's own checks, then the
// bot-build instance asked for, which tells this instance its end).
// The look's turn is a durable step over the item's checkpoint (its record
// names this item), and every effect it has is a step of its own, so a
// restart follows the turn instead of losing it and says and spends nothing
// twice.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { turnOwner } from '../rules/turn-stop.ts';
import { turnStopServices } from '../turn-stop.ts';
import { MACHINE, WORK, requestKey } from './machine.ts';

interface Deps { config: any; pool: Pool }

export function botRequestServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const bot = () => legacy('services/homeroom-bot');
  return {
    // The one turn.stop handler every machine that starts turns queues
    // (src/workflow/turn-stop.ts), registered here once.
    ...turnStopServices({ pool }),
    [WORK.look]: {
      resumable: true,
      maxAttempts: 2,
      maxLostAttempts: 20,
      leaseMs: 120000,
      // How many run at once is the lane's to decide.
      concurrency: 32,
      async run(ctx): Promise<Json> {
        const { input } = ctx;
        const key = requestKey(Number(input.appId), Number(input.issueNumber));
        const steps = ctx.steps({ owner: `${MACHINE}/${key}/look:${input.n}` });
        const out = await bot().lookAt(config, pool, {
          input, steps, signal: ctx.signal, owner: turnOwner(ctx, MACHINE, key), last: ctx.attempt >= 2,
        });
        await steps.flush();
        steps.fence();
        return JSON.parse(JSON.stringify(out ?? { outcome: 'done' })) as Json;
      },
    },
    [WORK.build]: {
      maxAttempts: 5,
      backoffMs: (a) => Math.min(5 * 60 * 1000, 15 * 1000 * 2 ** (a - 1)),
      concurrency: 8,
      async run(ctx): Promise<Json> {
        const { input } = ctx;
        const key = requestKey(Number(input.appId), Number(input.issueNumber));
        const out = await bot().startBuild(config, pool, {
          appId: Number(input.appId), issueNumber: Number(input.issueNumber), runId: Number(input.runId),
          replyTo: { machine: MACHINE, key },
        });
        return JSON.parse(JSON.stringify(out ?? { outcome: 'skipped' })) as Json;
      },
    },
  };
}
