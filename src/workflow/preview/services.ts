// The preview machine's I/O: durable work items, each reported back as an
// event. What they call outside src/workflow/ is of two sorts, each named
// in the boundary list (tests/baselines/workflow-process-state.json):
//
//   I/O cores    the build, the database clone and the deploy
//                (staging.prepareAttempt: buildAndDeployStagingInner without
//                the per-process queue or the coordinator), the checks run
//                (visuals.captureForSession in its workflow mode, without
//                its in-process seat), the Jobs and the runtime by identity;
//   hand-offs    to flows later steps migrate: the merge queue, the
//                Homeroom bot's notes and before & after shots.
//
// The handlers keep no state of their own in process memory: what one needs
// is in its input, in Postgres, or on the cluster. The hand-offs call into
// flows that still do (the merge queue, the bot, a sync with main); they go
// with the steps that migrate those. What browsers hear about a decision is
// the transitions' (src/workflow/pushes.ts); the build and the run still
// stream their own progress (checks_progress and its events) as they go.

import { createHash } from 'node:crypto';
import type { Json, Pool, WorkContext, WorkHandler } from '../kernel/index.ts';
import { LeaseLost } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { PREPARE_CLAIMS, WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

// How long a prepare or a checks run holds its lease between renewals. A
// cancelled one learns it at its next checkpoint or renewal; the machine
// waits longer than a lease before it retires a cancelled attempt or runs a
// retirement, and nothing is dropped while it still serves (below).
export const PREPARE_LEASE_MS = 60000;
// Retries after a lost lease, never after a failure: a build that fails is
// the error lane's, as on [main]. One database per claim (machine.ts).
const PREPARE_ATTEMPTS = PREPARE_CLAIMS;
// A lost checks run is collected from the cluster by its retry; a second
// loss reruns it once more.
const RUN_ATTEMPTS = 3;
// The per-process limits [main] has for builds and check runs.
const CONCURRENCY = 10;

const repoOf = (url: unknown) => {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
};
const cancelled = (ctx: WorkContext, err: unknown) => ctx.signal.aborted || err instanceof LeaseLost;

// The id one claim of a checks run gives its Jobs and its check_runs row (a
// UUID, as that table's key is): one per claim, so a claim that runs again
// never meets the Jobs of the one before under the same names. The run
// itself is known by the work item's key (`runKey`), which its manifest
// carries and its media are held under.
export function claimRunId(sessionId: number, runKey: string, claim: number): string {
  const h = createHash('sha256').update(`preview-run:${sessionId}:${runKey}:${claim}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function previewServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const staging = () => legacy('services/staging');
  const visuals = () => legacy('services/visuals');
  const kubernetes = () => legacy('services/kubernetes');
  const dbManager = () => legacy('services/db-manager');
  const runtimeMode = () => legacy('services/application-runtime').mode(config);
  const session = async (id: number) => (await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`, [id])).rows[0] || null;
  const app = async (id: number) => (await pool.query('SELECT * FROM apps WHERE id = $1', [id])).rows[0] || null;
  // The machine cancelled this work item (the kernel's `cancel`), as opposed
  // to its claim having expired; an error reading it is not a cancel.
  const cancelledByMachine = async (workId: string) => (await pool.query(
    `SELECT COALESCE((result->>'cancelled')::boolean, FALSE) AS cancelled FROM wf_work WHERE id = $1`, [workId])
    .catch(() => ({ rows: [] }))).rows[0]?.cancelled === true;
  // The session's runtime on Kubernetes: one name per session, every attempt.
  const runtimeName = (appId: number, sessionId: number) =>
    kubernetes().appResourceName({ id: appId }, 'staging', sessionId);
  // Whether attempt n still serves the session's preview: its env Secret in
  // the live pod template (Kubernetes), its number on the container (Docker).
  const serves = async (input: { sessionId: number; appId: number; appSlug?: string; n: number }) => {
    if (runtimeMode() === 'kubernetes') {
      return kubernetes().previewServesAttempt(config, runtimeName(input.appId, input.sessionId), input.n);
    }
    if (!input.appSlug) return false;
    const c = await legacy('services/docker').inspectContainer(`usernode-staging-${input.appSlug}--${input.sessionId}`).catch(() => null);
    return Number(c?.labels?.[kubernetes().PREVIEW_ATTEMPT_ANNOTATION]) === input.n;
  };
  // Every claim of a run (its check_runs rows, by the run's key): their Jobs
  // cancelled, finished or not, and their rows gone.
  const clearRun = async (sessionId: number, runKey: string) => {
    const { rows } = await pool.query(
      `SELECT run_id FROM check_runs WHERE session_id = $1 AND manifest->>'runKey' = $2`, [sessionId, runKey]);
    for (const r of rows) {
      if (config.captureRuntime === 'kubernetes') {
        await kubernetes().cancelPreviewChecks(config, sessionId, r.run_id);
        await kubernetes().deleteRunCheckJobs(config, { sessionId, previewRunId: r.run_id });
      }
      await legacy('services/check-runs').finish(pool, r.run_id);
    }
  };
  // An attempt the machine cancelled after it had written the session's
  // Deployment gives it back to the attempt that serves; its database goes
  // only once it serves nothing.
  const undo = async (input: any) => {
    if (runtimeMode() === 'kubernetes') {
      await kubernetes().restorePreviewAttempt(config, runtimeName(input.appId, input.sessionId), input.n,
        input.serving?.n ?? null).catch(() => null);
    }
    if (!await serves(input).catch(() => true)) await dbManager().dropDatabase(input.db).catch(() => {});
  };

  return {
    // Build attempt n of the head into its own checkout, database and env
    // Secret, then update the session's runtime to it (fenced by attempt,
    // the serving template restored on a failed rollout). A build or boot
    // failure is a result; only a lost lease is retried here.
    [WORK.prepare]: {
      maxAttempts: PREPARE_ATTEMPTS,
      leaseMs: PREPARE_LEASE_MS,
      concurrency: CONCURRENCY,
      async run(ctx): Promise<Json> {
        const { input } = ctx;
        const [row, a] = await Promise.all([session(input.sessionId), app(input.appId)]);
        if (!row || !a) return { ok: false, detail: 'The proposal or its app no longer exists' };
        // Each claim clones into its own database: one before it may have
        // deployed, and its pods still use that one.
        const db: string = (Array.isArray(input.dbs) && input.dbs[ctx.attempt - 1]) || input.db;
        const attempt = { n: input.n, dbName: db, servingN: input.serving?.n ?? null,
          checkpoint: (v: Json) => ctx.checkpoint(v) };
        try {
          const built = await staging().prepareAttempt(config, row, a, input.head, attempt);
          // Deployed: still this machine's attempt? A cancel that came during
          // the rollout is seen here, and the deploy undone.
          await ctx.checkpoint({ step: 'deployed', db });
          await staging().verifyStagingEdge(row, built.hostname, built.stagingUrl).catch(() => null);
          return {
            ok: true, db, url: built.stagingUrl, runtimeKind: built.runtimeKind, runtimeName: built.runtimeName,
            containerId: built.containerId ?? null, imageRef: built.imageRef ?? null, buildRef: built.buildRef ?? null,
          };
        } catch (err) {
          if (cancelled(ctx, err) || (err as { code?: string }).code === 'attempt_superseded') {
            // Only a cancelled attempt undoes what it created after the
            // cancel (the machine's retirement covers everything before). A
            // lost lease authorizes nothing: a retry of this same attempt
            // may be using the database right now.
            if (await cancelledByMachine(ctx.workId)) await undo({ ...input, db, appSlug: a.slug });
            throw err;
          }
          // A failure seen by a claim that is no longer the live one (its
          // lease ran out, or the machine cancelled it) reports nothing and
          // sets nothing off: checkpoint throws for it.
          await ctx.checkpoint({ step: 'failed', db });
          const detail = visuals().summarizeBootFailure(err);
          const infrastructure = !!legacy('services/deploy-failure').bootFailureIsInfrastructure(err);
          const sync = legacy('services/boot-failure-sync');
          const catchUp = infrastructure ? null
            : await sync.afterBootFailure({ config, pool, session: row, commitHash: input.head, err }).catch(() => null);
          return {
            ok: false, detail, infrastructure, aboutMain: sync.explain(catchUp) || null, sync: !!catchUp?.sync,
            platformFault: (err as { previewDatabaseServerFault?: boolean }).previewDatabaseServerFault === true,
            servingRemoved: !!(err as { servingRemoved?: boolean }).servingRemoved,
          };
        }
      },
    },

    // The checks for the attempt that serves, from admission to the parsed
    // settlement; the machine stores it. The run's Jobs carry the work
    // item's key as their run id, so a retry after a lost claim collects
    // them from the cluster instead of running them again, and runs them
    // again only when there is nothing to read.
    [WORK.run]: {
      maxAttempts: RUN_ATTEMPTS,
      leaseMs: PREPARE_LEASE_MS,
      concurrency: CONCURRENCY,
      async run(ctx): Promise<Json> {
        const { input, attempt, signal } = ctx;
        const [row, a] = await Promise.all([session(input.sessionId), app(input.appId)]);
        if (!row || !a) return { outcome: 'blocked', reason: 'The proposal or its app no longer exists' };
        if (attempt > 1) {
          const collected = await legacy('services/check-harvest')
            .collectForWorkflow(config, pool, { runKey: input.runId, session: row, app: a, signal });
          if (collected) return collected as Json;
          // Nothing to read: what the earlier claims left goes, and the run
          // starts over under this claim's own id.
          await clearRun(input.sessionId, input.runId);
        }
        const stagingResult = { runtimeName: input.runtimeName, runtimeKind: input.runtimeKind, stagingUrl: input.url, timings: null };
        const result = await visuals().captureForSession(config, row, a, input.head, stagingResult, {
          trigger: input.trigger, force: true,
          workflow: { runId: claimRunId(input.sessionId, input.runId, attempt), runKey: input.runId, signal },
        });
        return (result ?? { outcome: 'blocked', reason: 'The checks run produced no result' }) as Json;
      },
    },

    // A cancelled run's Jobs and its place in the checks queue, by its own
    // ids (every claim's): never the session's others.
    [WORK.cancel]: {
      maxAttempts: 5,
      async run({ input }): Promise<Json> {
        await clearRun(input.sessionId, input.runId);
        return { cancelled: true };
      },
    },

    // GitHub's view of a settled run: the PR body's visuals block, from the
    // media the settlement published (patched or cleared), and for the
    // platform's own app the platform-variables check.
    [WORK.publish]: {
      maxAttempts: 5,
      async run({ input }): Promise<Json> {
        const row = await session(input.sessionId);
        if (!row) return { gone: true };
        const v = visuals();
        const repo = repoOf(row.repo_url);
        const github = legacy('services/github');
        if (row.pr_number && repo && github.isEnabled()) {
          const stored = input.visuals ? await v.getForSession(pool, input.sessionId, input.head) : null;
          if (stored) {
            const block = legacy('services/pr-metadata').buildVisualsBlock(stored, legacy('services/caddy').USERNODE_DOMAIN);
            await v.patchPrBody(pool, row, repo.owner, repo.repo, block);
          } else {
            await v.clearPrVisuals(pool, row, repo.owner, repo.repo);
          }
        }
        if (input.state) {
          const a = await app(row.app_id);
          if (a?.self_hosted) {
            await legacy('services/platform-env-check').refreshPlatformEnvCheck({
              pool, app: a, session: row.source === 'cli_handoff' ? { ...row, checks_commit_sha: input.head } : row,
            });
          }
        }
        return { published: true };
      },
    },

    // A superseded, failed or cancelled attempt: its database, its Secret
    // and its checkout. Never the serving attempt (the machine asks for it
    // only for one that does not serve).
    [WORK.retireAttempt]: {
      maxAttempts: 5,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        // Never what serves: a cancelled attempt whose deploy could not be
        // given back still has the live pods on its database and Secret.
        if (await serves(input)) throw new Error(`Attempt ${input.n} still serves the preview; not retired`);
        for (const db of (Array.isArray(input.dbs) ? input.dbs : [input.db])) await dbManager().dropDatabase(db, { strict: true });
        if (runtimeMode() === 'kubernetes') {
          const k = kubernetes();
          await k.deleteSecret(config, k.attemptSecretName(runtimeName(input.appId, input.sessionId), input.n));
        }
        await legacy('services/docker').execFileAsync('rm', ['-rf', `/tmp/usernode-preview-${input.sessionId}-a${input.n}`]).catch(() => {});
        return { dropped: input.db };
      },
    },

    // The whole preview: the runtime and its Secrets by identity, every
    // attempt's database, the session's checks Jobs. It runs once a prepare
    // the machine cancelled has stopped (`notBefore`), and closes only when
    // a look after the deletes finds nothing.
    [WORK.retire]: {
      maxAttempts: 5,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        const attempts = (input.attempts || []) as { n: number; db: string }[];
        const kube = runtimeMode() === 'kubernetes';
        const k = kubernetes();
        const name = input.runtimeKind === 'docker' || !kube ? null : (input.runtimeName || runtimeName(input.appId, input.sessionId));
        const secrets = name ? [...new Set([0, ...attempts.map((a) => a.n)])].map((n) => k.attemptSecretName(name, n)) : [];
        if (name) {
          await k.deleteApplication(config, name, { identity: true, secrets });
          if (config.captureRuntime === 'kubernetes') await k.cancelPreviewChecks(config, input.sessionId);
        } else {
          await legacy('services/application-runtime').remove(config,
            { runtimeKind: 'docker', runtimeName: input.runtimeName || `usernode-staging-${input.appSlug}--${input.sessionId}` });
        }
        const dbs = attempts.flatMap((a: { db: string; dbs?: string[] }) => a.dbs ?? [a.db]);
        for (const db of dbs) await dbManager().dropDatabase(db, { strict: true });
        const left = name ? await k.previewResourcesPresent(config, name, secrets) : [];
        for (const db of dbs) if (await dbManager().databaseExists(db, { strict: true })) left.push(db);
        if (left.length) throw new Error(`Still present after retirement: ${left.join(', ')}`);
        return { closed: true };
      },
    },

    // The databases of a serving attempt's other claims (one that died after
    // its clone, or after a deploy this attempt's rollout has since
    // replaced): never the one that serves, which the machine leaves out.
    [WORK.dropClaims]: {
      maxAttempts: 5,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        for (const db of input.dbs || []) await dbManager().dropDatabase(db, { strict: true });
        return { dropped: input.dbs || [] };
      },
    },

    // Hand-off: before & after shots, started beside the checks once the
    // preview serves (visuals.startShotsIfIdle: only while no turn holds
    // the session; the verdict's follow-ups start them otherwise).
    [WORK.ready]: {
      maxAttempts: 3,
      async run({ input }): Promise<Json> {
        await visuals().startShotsIfIdle(config, pool, input.sessionId, input.head);
        return { started: true };
      },
    },

    // Hand-off: what a settled verdict sets off, each awaited so the item
    // reports only once it is done. The Homeroom bot's note (a change of its
    // that is ready to try, or one whose checks fail), the app's merge queue
    // for a passing or skipped proposal still up for review, and before &
    // after shots for the head.
    [WORK.followUps]: {
      maxAttempts: 3,
      async run({ input }): Promise<Json> {
        const { sessionId, appId, head, state, deferred } = input;
        if (!deferred) {
          if (state === 'passing' || state === 'skipped') {
            await legacy('services/homeroom-bot-dm').noteChangeReady(pool, sessionId);
            const github = legacy('services/github');
            const { rows: [fresh] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [sessionId]);
            if (github.isEnabled() && fresh?.status === 'promoted') {
              await legacy('services/conflict-resolver').checkAndResolveConflicts(config, { app_id: appId });
            }
          } else if (state === 'failing') {
            await legacy('services/homeroom-bot').noteProposalChecks(pool, { sessionId });
          }
        }
        if (/^[0-9a-f]{40}$/.test(String(head || ''))) {
          await legacy('services/shots-orchestrator').scheduleForSession(config, {
            pool, sessionId: Number(sessionId), headSha: String(head).toLowerCase(), trigger: 'preview-ready',
          });
        }
        return { done: true };
      },
    },

    // Hand-off: a Homeroom bot's change whose preview will not start, once
    // per failure streak.
    [WORK.stopped]: {
      maxAttempts: 3,
      async run({ input }): Promise<Json> {
        await legacy('services/homeroom-bot-dm').noteChangeStopped(pool, input.sessionId, { why: 'preview' });
        return { noted: true };
      },
    },
  };
}
