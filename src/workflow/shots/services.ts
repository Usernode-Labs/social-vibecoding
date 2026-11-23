// The shots machine's I/O. Each step is durable work, reported back as an
// event, and safe to run again after a crash (which is what a retried or
// resumed item does): everything it makes is named by the run, and what it
// needs is in Postgres (the run's row and its agent's workspace) or in the
// outside world (the copies, the worker). The decisions are the machine's.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { HandedBack } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { MACHINE, WORK, sessionKey } from './machine.ts';
import { turnOwner } from '../rules/turn-stop.ts';

interface Deps { config: any; pool: Pool }

// Building copies is the cost (two images, two databases, two runtimes):
// at most four runs build at once (Bruno, 2026-10-15). An agent runs in its
// own proposal's worker and costs the platform almost nothing.
export const COPIES_CONCURRENCY = 4;
export const AGENT_CONCURRENCY = 32;
// How often, and how far apart, a published run's comparison is made again
// after its first one failed (shots.recompare): four tries in about an hour.
export const RECOMPARE_ATTEMPTS = 4;
export const RECOMPARE_BACKOFF_MS: readonly number[] = Object.freeze([5 * 60_000, 15 * 60_000, 45 * 60_000]);

const orchestrator = () => legacy('services/shots-orchestrator');

// A step's own failure, as the machine decides on it: its code, its words,
// and the platform's fault kind when it is one (taken again once). A stop
// (the item cancelled, its lease lost, the process stopping) is not a
// failure: it is thrown, so nothing is reported and the next claim goes on.
// The words are the error's own; a connection the database would not give
// has its own code (orchestrator errorCode), which every reader says in
// plain words instead.
function failureOf(error: any): Json {
  const o = orchestrator();
  const fault = o.platformFault(error);
  return {
    code: o.errorCode(error),
    message: o.visibleError(error),
    fault: fault?.kind ?? null,
    retryAt: fault?.retryAt ? new Date(fault.retryAt).toISOString() : null,
  };
}

// A step that could not get a database connection while its process drains
// (a release replaced it, and it finishes its work on small pools) is not
// failed: it is handed back (the kernel's HandedBack), so the process that
// replaced this one claims it at once and carries it on, as it carries on a
// step a stopping process left: the revision asked again, the copies from
// their checkpoint (the images kept; what the attempt left removed first),
// the agent's turn followed where its worker still runs it. Where the kernel
// cannot hand it back (this process still claims), `otherwise` is reported,
// the failure the step would have reported, a platform fault.
const handBack = (error: unknown, otherwise: Json) => (legacy('services/db-retry').handBackOnDrain(error)
  ? new HandedBack(error, otherwise) : null);

export function shotsServices({ config, pool }: Deps): Record<string, WorkHandler> {
  return {
    // The exact before revision of the head (GitHub's merge base). Nothing
    // is built yet: a head GitHub cannot compare is a run that never starts,
    // and GitHub's limit (or its being down) is the platform's fault, which
    // the machine takes again once, when the limit resets.
    [WORK.revision]: {
      maxAttempts: 3,
      backoffMs: (attempt) => 15000 * attempt,
      async run({ input }): Promise<Json> {
        try {
          return await orchestrator().resolveRevision(pool, { sessionId: input.sessionId, headSha: input.head });
        } catch (error: any) {
          const failed = { failed: failureOf(error) };
          const back = handBack(error, failed);
          if (back) throw back;
          return failed;
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
            // The run may end while its copies are built (a new head, a
            // Stop): they stop at the next phase, and the machine's cleanup,
            // which waits for this result, removes what they made.
            current: () => orchestrator().runCurrent(pool, input.runId, ['provisioning']),
          });
        } catch (error: any) {
          if (signal.aborted) throw error;
          const failed = { failed: failureOf(error) };
          const back = handBack(error, failed);
          if (back) throw back;
          return failed;
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
        const steps = ctx.steps({ owner: `shots/${input.runId}` });
        try {
          const out = await orchestrator().dispatchAgent(config, pool, {
            runId: input.runId, sessionId: input.sessionId, budgetMs: input.budgetMs, steps, signal,
            owner: turnOwner(ctx, MACHINE, sessionKey(Number(input.sessionId))),
            // A run that ended (its item cancelled) never starts its turn:
            // the cancellation reaches this process only at its next lease
            // renewal, and the run's cleanup may already have run.
            current: () => orchestrator().runCurrent(pool, input.runId, ['exploring']),
          });
          await steps.flush();
          steps.fence();
          return JSON.parse(JSON.stringify(out)) as Json;
        } catch (error: any) {
          if (signal.aborted || error?.stopped === true || error?.code === 'steps_stopped') throw error;
          const failed = { agent: { outcome: 'failed', ...(failureOf(error) as object) }, passed: false, skippedAny: false } as Json;
          const back = handBack(error, failed);
          if (back) throw back;
          return failed;
        }
      },
    },

    // Where each ready change's before and after differ (the card's
    // outlines). Never holds the run back: the machine publishes without
    // them when this fails for good.
    [WORK.publish]: {
      maxAttempts: 3,
      leaseMs: 120000,
      async run({ input, signal }): Promise<Json> {
        return { verdict: await orchestrator().compareScreens(pool, { runId: input.runId, verdict: input.verdict, signal }) };
      },
    },

    // A published run's comparison, made again after its first one failed
    // (the machine asks for it as it publishes the stand-in screens). A try
    // that fails again throws, so the kernel tries it later, a bounded number
    // of times, spaced out; one that never succeeds leaves the stand-ins. One
    // at a time across the platform: it is never in anybody's way.
    [WORK.recompare]: {
      maxAttempts: RECOMPARE_ATTEMPTS,
      backoffMs: (attempt) => RECOMPARE_BACKOFF_MS[Math.min(attempt - 1, RECOMPARE_BACKOFF_MS.length - 1)]!,
      leaseMs: 120000,
      concurrency: 1,
      async run({ input, signal }): Promise<Json> {
        return orchestrator().recompareScreens(pool, { runId: input.runId, signal });
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
