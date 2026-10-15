// The shots machine's I/O. Each step is durable work, reported back as an
// event, and safe to run again after a crash (which is what a retried or
// resumed item does): everything it makes is named by the run, and what it
// needs is in Postgres (the run's row and its agent's workspace) or in the
// outside world (the copies, the worker). The decisions are the machine's.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

// Building copies is the cost (two images, two databases, two runtimes):
// at most four runs build at once (Bruno, 2026-10-15). An agent runs in its
// own proposal's worker and costs the platform almost nothing.
export const COPIES_CONCURRENCY = 4;
export const AGENT_CONCURRENCY = 32;

const orchestrator = () => legacy('services/shots-orchestrator');

// A step's own failure, as the machine decides on it: its code, its words,
// and the platform's fault kind when it is one (taken again once). A stop
// (the item cancelled, its lease lost, the process stopping) is not a
// failure: it is thrown, so nothing is reported and the next claim goes on.
function failureOf(error: any): Json {
  const o = orchestrator();
  const fault = o.platformFault(error);
  return {
    code: String(error?.code || 'shots_failed').slice(0, 48),
    message: o.visibleError(error),
    fault: fault?.kind ?? null,
    retryAt: fault?.retryAt ? new Date(fault.retryAt).toISOString() : null,
  };
}

export function shotsServices({ config, pool }: Deps): Record<string, WorkHandler> {
  return {
    // The exact before revision of the head (GitHub's merge base). Nothing
    // is built yet: a head GitHub cannot compare is a run that never starts.
    [WORK.revision]: {
      maxAttempts: 3,
      backoffMs: (attempt) => 15000 * attempt,
      async run({ input }): Promise<Json> {
        try {
          return await orchestrator().resolveRevision(pool, { sessionId: input.sessionId, headSha: input.head });
        } catch (error: any) {
          if (error?.code === 'github_rate_limited') throw error;
          return { failed: failureOf(error) };
        }
      },
    },

    // The before and after copies, serving and seeded, and the agent's
    // workspace. The images are kept in the checkpoint once built, so a
    // restart does not build them again; what an earlier attempt left of the
    // copies is removed before they are made again.
    [WORK.copies]: {
      resumable: true,
      maxAttempts: 1,
      maxLostAttempts: 20,
      leaseMs: 120000,
      concurrency: COPIES_CONCURRENCY,
      async run(ctx): Promise<Json> {
        const { input, signal } = ctx;
        const kept = (ctx.resumeFrom as any) || {};
        const fresh = ctx.attempt === 1 && !(ctx.lostAttempts || 0) && !ctx.resumeFrom;
        try {
          return await orchestrator().buildCopies(config, pool, {
            runId: input.runId, sessionId: input.sessionId, kind: 'run', intent: input.intent,
            baseSha: input.baseSha, headSha: input.headSha, budgetMs: input.budgetMs,
            images: kept.images || null, fresh,
            onImages: (images: unknown) => ctx.checkpoint({ images: JSON.parse(JSON.stringify(images)) as Json }),
          });
        } catch (error: any) {
          if (signal.aborted) throw error;
          return { failed: failureOf(error) };
        }
      },
    },

    // The shots agent's turn, as a durable step over the item's checkpoint
    // (services/durable-turn.js): a restart follows the turn the worker
    // still runs instead of starting it again, and everything it saved is
    // already in its workspace.
    [WORK.agent]: {
      resumable: true,
      maxAttempts: 1,
      maxLostAttempts: 20,
      leaseMs: 120000,
      concurrency: AGENT_CONCURRENCY,
      async run(ctx): Promise<Json> {
        const { input, signal } = ctx;
        const durableSteps = legacy('services/durable-steps');
        const steps = durableSteps.durable({
          resumeFrom: ctx.resumeFrom, checkpoint: ctx.checkpoint, signal, attempt: ctx.attempt,
          lostAttempts: ctx.lostAttempts || 0, owner: `shots/${input.runId}`,
        });
        try {
          const out = await orchestrator().dispatchAgent(config, pool, {
            runId: input.runId, sessionId: input.sessionId, budgetMs: input.budgetMs, steps,
          });
          await steps.flush();
          steps.fence();
          return JSON.parse(JSON.stringify(out)) as Json;
        } catch (error: any) {
          if (signal.aborted || error?.stopped === true || error?.code === 'steps_stopped') throw error;
          return { agent: { outcome: 'failed', ...(failureOf(error) as object) }, passed: false, skippedAny: false } as Json;
        }
      },
    },

    // Where each ready change's before and after differ (the card's
    // outlines). Never holds the run back: the machine publishes without
    // them when this fails for good.
    [WORK.publish]: {
      maxAttempts: 3,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        return { verdict: await orchestrator().compareScreens(pool, { runId: input.runId, verdict: input.verdict }) };
      },
    },

    // Everything a run left. Tried until it is gone; one that keeps failing
    // waits for an admin in Admin → Workflows.
    [WORK.cleanup]: {
      maxAttempts: 8,
      backoffMs: (attempt) => Math.min(30000 * 2 ** (attempt - 1), 600000),
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        return orchestrator().cleanupRun(config, pool, {
          runId: input.runId, sessionId: input.sessionId, appSlug: input.appSlug,
          worker: input.worker === true, stopTurn: input.stopTurn === true,
        });
      },
    },

    // The slot settled: a change of the Homeroom bot's that was waiting on
    // its shots is ready to try now, or goes back to the bot.
    [WORK.settled]: {
      maxAttempts: 3,
      async run({ input }): Promise<Json> {
        await legacy('services/homeroom-bot-dm').noteShotsSettled(pool, input.sessionId);
        return { told: true };
      },
    },

    // The pull request's description: the authenticated link to the shots,
    // as the slot reads now.
    [WORK.prBlock]: {
      maxAttempts: 3,
      backoffMs: (attempt) => 30000 * attempt,
      async run({ input }): Promise<Json> {
        await legacy('services/pr-metadata').syncShotsPrBlock(pool, input.sessionId);
        return { synced: true };
      },
    },
  };
}
