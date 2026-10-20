// shots-eval's I/O: a trial's phases, each the step the shots machine runs
// for a proposal (services/shots-orchestrator.js), on the trial's attempt
// id, with what a trial has instead of a proposal's run: its row (a cancel,
// the machine marking it stopping, or a new attempt stops it at its next
// step), its arm's model, prompts and time, and its files kept in
// shots_eval_artifacts. Each is safe to run again: everything is named by
// the attempt.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { turnOwner } from '../rules/turn-stop.ts';
import { KEY, MACHINE, MAX_CONCURRENCY, WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

const orchestrator = () => legacy('services/shots-orchestrator');
const evals = () => legacy('services/shots-eval');

function failureOf(error: any): Json {
  const o = orchestrator();
  return { code: String(error?.code || 'shots_eval_failed').slice(0, 48), message: o.visibleError(error) };
}

export function shotsEvalServices({ config, pool }: Deps): Record<string, WorkHandler> {
  // Whether the trial's attempt is still in `states` and not stopping (a
  // cancel, a new attempt, a timeout ended it otherwise).
  const current = (trialId: number, attemptId: string, states: string[]) => async () =>
    (await pool.query(
      'SELECT 1 FROM shots_eval_trials WHERE id = $1 AND attempt_id = $2 AND state = ANY($3::text[]) AND stopping_at IS NULL',
      [trialId, attemptId, states])).rows.length > 0;
  return {
    [WORK.copies]: {
      resumable: true,
      maxAttempts: 1,
      maxLostAttempts: 20,
      leaseMs: 120000,
      // Eval trials have their own limit (the machine's grants), apart from
      // the proposals' four copy builds at once.
      concurrency: MAX_CONCURRENCY,
      async run(ctx): Promise<Json> {
        const { input, signal } = ctx;
        const kept = (ctx.resumeFrom as any) || {};
        const fresh = ctx.attempt === 1 && !(ctx.lostAttempts || 0) && !ctx.resumeFrom;
        try {
          // What it runs with, on the trial from its start.
          await evals().trialRecipe(pool, config, Number(input.trialId), String(input.attemptId));
          return await orchestrator().buildCopies(config, pool, {
            runId: input.attemptId, sessionId: input.sessionId, kind: 'trial', intent: input.intent,
            baseSha: input.baseSha, headSha: input.headSha, budgetMs: input.budgetMs,
            images: kept.images || null, fresh,
            onImages: (images: unknown) => ctx.checkpoint({ images: JSON.parse(JSON.stringify(images)) as Json }),
            current: current(Number(input.trialId), String(input.attemptId), ['provisioning']),
          });
        } catch (error: any) {
          if (signal.aborted) throw error;
          return { failed: failureOf(error) };
        }
      },
    },

    // The shots agent with the arm's model, prompts and time, its turn this
    // work's own (the proxy bills a turn so owned to its trial). What Claude
    // Code reports a dispatch cost is kept on the trial's row as it returns,
    // for when the proxy did not see the calls.
    [WORK.agent]: {
      resumable: true,
      maxAttempts: 1,
      maxLostAttempts: 20,
      leaseMs: 120000,
      concurrency: MAX_CONCURRENCY,
      async run(ctx): Promise<Json> {
        const { input, signal } = ctx;
        const steps = ctx.steps({ owner: `shots-eval/${input.attemptId}` });
        const resolved = await evals().trialRecipe(pool, config, Number(input.trialId), String(input.attemptId));
        const trialConfig = { ...config, shots: { ...(config?.shots || {}), agentModel: resolved.model, maxAgentMs: resolved.budgetMs } };
        const agent = legacy('services/shots-agent');
        const prompted = {
          ...agent,
          async dispatch(cfg: any, options: any, agentDeps: any) {
            const out = await agent.dispatch(cfg, { ...options, systemPrompt: resolved.systemPrompt, taskPrompt: resolved.taskPrompt }, agentDeps);
            const usd = Number(out?.result?.costUsd);
            if (Number.isFinite(usd) && usd > 0) await evals().noteReported(pool, Number(input.trialId), String(input.attemptId), usd * 100);
            return out;
          },
        };
        try {
          const out = await orchestrator().dispatchAgent(trialConfig, pool, {
            runId: input.attemptId, sessionId: input.sessionId, budgetMs: input.budgetMs, steps, signal,
            owner: turnOwner(ctx, MACHINE, KEY),
            current: current(Number(input.trialId), String(input.attemptId), ['exploring']),
          }, { shotsAgent: prompted });
          await steps.flush();
          steps.fence();
          return JSON.parse(JSON.stringify(out)) as Json;
        } catch (error: any) {
          if (signal.aborted || error?.stopped === true || error?.code === 'steps_stopped') throw error;
          return { agent: { outcome: 'failed', ...(failureOf(error) as object) }, passed: false, skippedAny: false } as Json;
        }
      },
    },

    // Where each ready change's screens differ, and the trial's files kept
    // (light only), on its row's attempt.
    [WORK.compare]: {
      maxAttempts: 3,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        const verdict = input.verdict && (input.verdict as any).stories?.length
          ? await orchestrator().compareScreens(pool, { runId: input.attemptId, verdict: input.verdict })
          : input.verdict;
        await evals().storeTrialFiles(pool, Number(input.trialId), String(input.attemptId), (input.slots as string[]) || []);
        return { verdict } as Json;
      },
    },

    // Everything a trial left: its turn (by its record) when the agent may
    // still be at it, its copies, its workspace, and the proposal's
    // temporary worker unless the proposal's own shots use it. Tried until
    // it is all gone.
    [WORK.cleanup]: {
      maxAttempts: 8,
      backoffMs: (attempt) => Math.min(30000 * 2 ** (attempt - 1), 600000),
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        if (!input.appSlug) return { cleaned: false, reason: 'no_app' };
        return orchestrator().cleanupRun(config, pool, {
          runId: input.attemptId, sessionId: input.sessionId, appSlug: input.appSlug, worker: true, stopTurn: input.stopTurn === true,
        });
      },
    },

    // The blind pairs an eval's finished trials make (its last trial's are
    // made by nothing else: tried for a good while).
    [WORK.pairs]: {
      maxAttempts: 8,
      backoffMs: (attempt) => Math.min(30000 * 2 ** (attempt - 1), 600000),
      async run({ input }): Promise<Json> {
        await evals().settlePairs(pool, Number(input.evalId));
        return { settled: true };
      },
    },
  };
}
