// The clock machine's work: one handler per job for its runs (`clock.<job>`,
// one at a time across every process), and one for its targets when it has
// any (`clock.<job>.item`), and the jobs themselves (JOBS, below): each job's
// I/O is its own module's function, which keeps nothing in the process.

import type { Json, WorkContext, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { itemKind, runKind } from './machine.ts';

// What a job's I/O reads: the platform's configuration and its pool.
export interface JobDeps { config: any; pool: any }

export interface Job {
  name: string;
  // How long after a run ends the next is due; 0 runs it again at once.
  everyMs: number;
  // The leader timer's name in leader_sweeps, whose last run sets the first
  // due time once (a six-hourly job is not run at every first boot).
  leaderSweep?: string;
  leaseMs?: number;
  // One run: what it found is its result (its status, and `items`: the
  // targets owed an effect of their own). `ctx.input.previous` is the last
  // successful run's result.
  run(ctx: WorkContext, deps: JobDeps): Promise<Json | void>;
  item?: {
    run(ctx: WorkContext, deps: JobDeps): Promise<Json | void>;
    concurrency?: number;
    leaseMs?: number;
    maxAttempts?: number;
  };
}

// A result is stored as instance data: JSON, and nothing a Date or an
// undefined would turn into something else.
const json = (v: unknown): Json => (v === undefined ? null : JSON.parse(JSON.stringify(v)) as Json);

export function clockServices(jobs: readonly Job[], deps: JobDeps): Record<string, WorkHandler> {
  const out: Record<string, WorkHandler> = {};
  for (const job of jobs) {
    out[runKind(job.name)] = {
      // A failed run is not tried again here: the clock runs the job again
      // later (sooner after a failure), with what is current then. A run
      // whose process went away is claimed again once its lease lapses, and
      // runs from the start: every job is safe to run twice.
      maxAttempts: 1,
      resumable: true,
      maxLostAttempts: 3,
      leaseMs: job.leaseMs ?? 120000,
      concurrency: 1,
      async run(ctx) { return json(await job.run(ctx, deps)); },
    };
    if (job.item) {
      const item = job.item;
      out[itemKind(job.name)] = {
        maxAttempts: item.maxAttempts ?? 3,
        // Its checkpoint is what it has done (a target's effect is made once).
        resumable: true,
        maxLostAttempts: 3,
        backoffMs: (a) => Math.min(10 * 60 * 1000, 60 * 1000 * 2 ** (a - 1)),
        leaseMs: item.leaseMs ?? 120000,
        concurrency: item.concurrency ?? 2,
        async run(ctx) { return json(await item.run(ctx, deps)); },
      };
    }
  }
  return out;
}

// The platform's scheduled jobs, each a clock (machine.ts): its interval,
// the leader timer it replaces (whose last run sets its first due time), and
// its run, which is its own module's function. Every run here is safe to run
// twice: an age DELETE, a delete preconditioned on what it read, or a state
// change written as a compare-and-set with the notice it causes. An effect
// that must happen once per target (a model call, a GitHub write) is a
// target (`item`), never made by the sweep itself.
// workflow-foundation's design-leader-duties.md is the design.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Whether the run has been asked to stop (its lease is lost, or the process
// is shutting down): a sweep over many rows stops at the next one.
const stopped = (ctx: WorkContext) => () => ctx.signal.aborted;

// Wait `ms`, or until the run is stopped.
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

// WORKSHOP_THEMES_SWEEP_INTERVAL_MS (config.js workshopSweepIntervalMs): 0
// switches the sweep off.
const workshopEveryMs = () => {
  const v = parseInt(process.env.WORKSHOP_THEMES_SWEEP_INTERVAL_MS || String(HOUR), 10);
  return v > 0 ? v : 0;
};

export const JOBS: readonly Job[] = Object.freeze([
  // ── Retention ───────────────────────────────────────────────────────
  {
    // CLI device codes and sessions past their audit window.
    name: 'cli-auth-cleanup', everyMs: 6 * HOUR, leaderSweep: 'cli-auth-cleanup',
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/cli-auth').cleanupCliAuth(pool),
  },
  {
    // An agent session's delegated connector grants, a week after their turn.
    name: 'delegation-prune', everyMs: HOUR, leaderSweep: 'delegation-prune',
    run: async (_ctx: WorkContext, { pool }: JobDeps) => ({ pruned: await legacy('services/mcp-oauth').pruneDelegations(pool) }),
  },
  {
    // /debug merge traces past their window.
    name: 'merge-debug-prune', everyMs: 6 * HOUR, leaderSweep: 'merge-debug-prune',
    run: async (_ctx: WorkContext, { pool }: JobDeps) => ({
      pruned: await legacy('services/merge-debug').pruneOldRuns(pool, parseInt(process.env.MERGE_DEBUG_RETENTION_DAYS || '30', 10)),
    }),
  },
  {
    // Uploads nothing took, staging app files, closed moderation records.
    name: 'upload-gc', everyMs: HOUR, leaderSweep: 'conversation-attachment-gc',
    run: (_ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/upload-retention').sweep(pool, config),
  },
  {
    // Before & after shots: media and audit windows, and runtimes no run owns.
    name: 'shots-gc', everyMs: 6 * HOUR, leaderSweep: 'shots-gc', leaseMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/shots-gc').sweep(config, pool),
  },
  {
    // Processes that stopped beating (services/processes.js).
    name: 'process-reap', everyMs: 5 * MIN,
    run: async (_ctx: WorkContext, { pool }: JobDeps) => ({ reaped: await legacy('services/processes').reap(pool) }),
  },
  {
    // Successful kpack Builds past their window that nothing references, and
    // failed ones a restart left behind.
    name: 'build-retention', everyMs: HOUR, leaseMs: 5 * MIN,
    run: async (ctx: WorkContext, { pool, config }: JobDeps) => {
      const failed = await legacy('services/application-runtime').cleanupFailedBuilds(config);
      const r = await legacy('services/build-retention').sweep(config, { dryRun: false, pool, shouldStop: stopped(ctx) });
      return { failedDeleted: failed?.deleted ?? 0, examined: r.examined, deleted: r.deleted.length, busy: !!r.busy };
    },
  },
  {
    // Check input Secrets and finished check Pods whose Job is gone.
    name: 'check-retention', everyMs: 15 * MIN, leaseMs: 5 * MIN,
    run: async (ctx: WorkContext, { config }: JobDeps) => {
      const r = await legacy('services/check-retention').sweep(config, { shouldStop: stopped(ctx) });
      return { examined: r.examined, eligible: r.eligible, deleted: r.deleted.length };
    },
  },
  {
    // Account deletions' provider and worker cleanups (each task its own
    // SKIP LOCKED row lease, its finish fenced on its attempt).
    name: 'account-deletion', everyMs: MIN,
    run: async (_ctx: WorkContext, { pool, config }: JobDeps) => {
      await legacy('services/account-deletion-cleanup').sweep(pool, config);
      return null;
    },
  },

  // ── Phone pushes ────────────────────────────────────────────────────
  {
    // The sender: a run drains the queue for a few minutes, then the clock
    // runs it again at once. One at a time across every process; each row
    // it claims carries this run's attempt, so a run beside another (a
    // release, a stall) never sends one push twice.
    name: 'push-drain', everyMs: 0, leaseMs: MIN,
    run: async (ctx: WorkContext) => {
      const r = await legacy('services/mobile-push').drain({
        token: { workId: ctx.workId, attempt: ctx.attempt }, forMs: 4 * MIN, signal: ctx.signal,
      });
      // A process that sends no pushes waits the run out rather than spin.
      if (r?.off) await pause(4 * MIN, ctx.signal);
      return r;
    },
  },
  {
    // The sender's tables past their windows.
    name: 'push-retention', everyMs: 6 * HOUR,
    run: () => legacy('services/mobile-push').retention(),
  },

  // ── Probes and reports ──────────────────────────────────────────────
  {
    // Whether each public app's shell opens without signing in. The first
    // run of a new build re-probes every app that read public.
    name: 'shell-probe', everyMs: 5 * MIN,
    run: async (ctx: WorkContext, { config }: JobDeps) => {
      const build = String(process.env.GIT_SHA || 'dev');
      const r = await legacy('services/shell-probe').sweep(config, {
        refreshPublic: (ctx.input.previous as any)?.build !== build, shouldStop: stopped(ctx),
      });
      return { ...r, build };
    },
  },
  {
    // Custom domains: DNS for a claim, the certificate, the live host's
    // health. Each step a compare-and-set on the status it read.
    name: 'app-domains', everyMs: MIN,
    run: (ctx: WorkContext, { config }: JobDeps) => legacy('services/app-domains').sweep(config, { shouldStop: stopped(ctx) }),
  },
  {
    // Every app's database against its storage cap (its admins warned, the
    // database frozen read-only at the top). Also run by an admin's
    // "Measure now" (routes/admin.js).
    name: 'app-storage-cap',
    get everyMs() { return legacy('services/app-storage-cap').config().sweepIntervalMs; },
    leaseMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/app-storage-cap').sweep(pool),
  },
  {
    // The server-wide caps and GitHub's hourly budget, told to the full
    // admins once a level is crossed (each level a row-locked compare).
    name: 'platform-limits', everyMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/platform-limit-alerts').sweep(pool, config),
  },
  {
    // The unexpected-events digest and the hourly pile-up alert.
    name: 'incident-alerts', everyMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/platform-incident-alerts').sweep(pool),
  },

  // ── What people are told ────────────────────────────────────────────
  {
    // The once-a-day "what needs your vote" digest.
    name: 'vote-digest', everyMs: HOUR,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/vote-digest').sweep(pool),
  },
  {
    // The Friday "this week on <app>" card.
    name: 'weekly-digest', everyMs: HOUR,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/weekly-digest').sweep(pool),
  },
  {
    // A person let in gets the welcome group an admin set up.
    name: 'welcome-dm', everyMs: 30 * 1000,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/welcome-dm').sweep(pool),
  },
  {
    // "Your agent is waiting on you", once its delay has passed.
    name: 'connector-input-waits', everyMs: MIN,
    run: async (_ctx: WorkContext, { pool }: JobDeps) => ({ sent: await legacy('services/connector-input-waits').sweepDue(pool) }),
  },
  {
    // Season challenges scored from the points ledger: a beat a minute runs
    // the rules that are due. Its own advisory lock (the one the scoring at
    // people's doors plans its counted measures under) keeps two passes from
    // paying one unit twice or grading one entry twice.
    name: 'challenge-scorer', everyMs: MIN,
    run: async (ctx: WorkContext, { pool, config }: JobDeps) => {
      const scorer = legacy('services/topochain/challenge-scorer');
      if (!(scorer.intervalMinutes(config) > 0)) return { off: true };
      const r = await scorer.tick(pool, config, { lastAggregateCheckAt: (ctx.input.previous as any)?.aggregateCheckedAt ?? 0 });
      if (r?.credits) legacy('services/logger').info('challenge-scorer', 'Credits written', { credits: r.credits, graded: r.graded });
      // The run's whole summary is its challenge_scoring_runs row.
      return { runId: r?.runId ?? null, credits: r?.credits ?? 0, graded: r?.graded ?? 0, idle: !!r?.idle, busy: !!r?.busy,
        aggregateCheckedAt: r?.aggregateCheckedAt ?? (ctx.input.previous as any)?.aggregateCheckedAt ?? 0 };
    },
  },

  // ── Paid per target: each target an item of its own ─────────────────
  {
    // PR and feedback-issue titles filed with a fallback while the model
    // was unavailable, generated again: each title a target, so it is
    // generated and billed once however many runs find it.
    name: 'title-heal',
    get everyMs() { return Math.max(parseInt(process.env.TITLE_HEAL_SWEEP_MS || '', 10) || 10 * MIN, MIN); },
    run: (_ctx: WorkContext, { config }: JobDeps) => legacy('services/title-heal').targets(config),
    item: {
      concurrency: 2,
      run: (ctx: WorkContext, { config }: JobDeps) => legacy('services/title-heal').healTarget(config, ctx.input.input),
    },
  },
  {
    // The Workshop's themes: every app opened in the last week re-checked,
    // re-drafted once a day when anything changed. Each app a target.
    name: 'workshop-themes', leaderSweep: 'workshop-theme-sweep',
    get everyMs() { return workshopEveryMs() || 24 * HOUR; },
    run: async (_ctx: WorkContext, { pool }: JobDeps) => (workshopEveryMs()
      ? legacy('services/workshop-themes').sweepTargets({ pool })
      : { disabled: true }),
    item: {
      concurrency: 2,
      leaseMs: 5 * MIN,
      run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/workshop-themes').sweepApp({ pool, appId: Number(ctx.input.input?.appId) }),
    },
  },
] as Job[]);

export const JOB_NAMES: ReadonlySet<string> = new Set(JOBS.map((j) => j.name));

