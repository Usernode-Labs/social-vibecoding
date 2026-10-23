// app-creation's I/O: the setup, the first request, and a first version's
// plan and early first look. Durable work,
// reported back as an event; each part a step its work keeps, so a process
// that stops leaves the next one to carry on, never doing a part twice.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

// Tries of the first request: each a GitHub issue asked for, the last one's
// failure told to its maker (homeroom-bot-dm.js fileFirstRequest).
const FIRST_REQUEST_TRIES = 3;

export function appCreationServices({ config, pool }: Deps): Record<string, WorkHandler> {
  return {
    // The database, the card and the repository (services/app-creator.js
    // setUp). Its failure is a result the machine writes to the row, never
    // tried again here: the person sees it and has Retry, as before. A
    // process that stops carries on elsewhere; one that keeps dying is
    // given up after three (the machine reads it as interrupted).
    [WORK.setup]: {
      maxAttempts: 1,
      resumable: true,
      maxLostAttempts: 3,
      leaseMs: 120000,
      concurrency: 8,
      async run(ctx): Promise<Json> {
        return legacy('services/app-creator').setUp(config, pool, Number(ctx.input.appId), ctx);
      },
    },
    // The project's first request, filed once: a GitHub issue under its
    // maker's name (services/homeroom-bot-dm.js fileFirstRequest).
    [WORK.firstRequest]: {
      maxAttempts: FIRST_REQUEST_TRIES,
      backoffMs: (attempt) => 60 * 1000 * 2 ** (attempt - 1),
      resumable: true,
      maxLostAttempts: 5,
      leaseMs: 120000,
      concurrency: 4,
      async run(ctx): Promise<Json> {
        const tries = ctx.attempt - (ctx.lostAttempts ?? 0);
        return legacy('services/homeroom-bot-dm').fileFirstRequest(pool, config, Number(ctx.input.appId), {
          steps: ctx.steps({ owner: `app-creation/first-request:${ctx.input.appId}`, triesLeft: Math.max(0, FIRST_REQUEST_TRIES - tries) }),
          last: tries >= FIRST_REQUEST_TRIES,
        });
      },
    },
    // Its first version's plan at Make it, asked of the model once (the
    // item's step keeps the reply), and saved for its made screen
    // (services/first-version-plan.js runEarlyPlan). `planned` owes its early
    // first look. Too late to save is not tried again: what read it went on.
    [WORK.plan]: {
      maxAttempts: 2,
      backoffMs: () => 5 * 1000,
      resumable: true,
      leaseMs: 120000,
      concurrency: 8,
      run: (ctx) => legacy('services/first-version-plan').runEarlyPlan(pool, { appId: Number(ctx.input.appId), steps: ctx.steps() }),
    },
    // Its early first look, drawn from that plan in the bot's worker
    // (services/first-version-early-look.js runEarlyLook).
    [WORK.earlyLook]: {
      maxAttempts: 2,
      backoffMs: () => 5 * 1000,
      resumable: true,
      leaseMs: 180000,
      concurrency: 4,
      run: (ctx) => legacy('services/first-version-early-look').runEarlyLook(pool, { appId: Number(ctx.input.appId), config, steps: ctx.steps() }),
    },
  };
}
