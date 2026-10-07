// The preview machine's I/O: work handlers (durable, reported back as
// events) and notifiers (post-commit pushes, allowed to be lost). The
// handlers reuse [main]'s build and checks code in its attempt and workflow
// modes. Nothing here keeps state in process memory, and every browser
// update goes through the WebSocket bus (ws-bus.js relays it across Pods),
// so the handlers can move to another process unchanged.

import type { Json, Pool, WorkContext, WorkHandler } from '../kernel/index.ts';
import { LeaseLost } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

// How long a prepare may hold its lease between renewals, and so how long a
// cancelled one can keep going before its signal aborts (the machine waits
// this long before it retires a cancelled attempt's database).
export const PREPARE_LEASE_MS = 60000;
// Retries after a lost lease, never after a failure: a build that fails is
// the error lane's, as on [main].
const PREPARE_ATTEMPTS = 3;
const RUN_ATTEMPTS = 2;
// The per-process limits [main] has for builds and check runs.
const CONCURRENCY = 10;

const repoOf = (url: unknown) => {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
};
const cancelled = (ctx: WorkContext, err: unknown) => ctx.signal.aborted || err instanceof LeaseLost;

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

  return {
    // Build attempt n of the head into its own database and Secret, then
    // update the session's runtime to it (fenced by attempt, restored on a
    // failed rollout). A build or boot failure is a result; only a lost
    // lease is retried here.
    [WORK.prepare]: {
      maxAttempts: PREPARE_ATTEMPTS,
      leaseMs: PREPARE_LEASE_MS,
      concurrency: CONCURRENCY,
      async run(ctx): Promise<Json> {
        const { input } = ctx;
        const [row, a] = await Promise.all([session(input.sessionId), app(input.appId)]);
        if (!row || !a) return { ok: false, detail: 'The proposal or its app no longer exists' };
        const attempt = { n: input.n, dbName: input.db, servingN: input.serving?.n ?? null,
          checkpoint: (v: Json) => ctx.checkpoint(v) };
        try {
          const built = await staging().prepareAttempt(config, row, a, input.head, attempt);
          await staging().verifyStagingEdge(row, built.hostname, built.stagingUrl).catch(() => null);
          return {
            ok: true, url: built.stagingUrl, runtimeKind: built.runtimeKind, runtimeName: built.runtimeName,
            containerId: built.containerId ?? null, imageRef: built.imageRef ?? null, buildRef: built.buildRef ?? null,
          };
        } catch (err) {
          if (cancelled(ctx, err) || (err as { code?: string }).code === 'attempt_superseded') {
            // Only a cancelled attempt undoes what it created after the
            // cancel (the machine's retirement covers everything before). A
            // lost lease authorizes nothing: a retry of this same attempt
            // may be using the database right now.
            if (await cancelledByMachine(ctx.workId)) await dbManager().dropDatabase(input.db).catch(() => {});
            throw err;
          }
          // A failure seen by a claim that is no longer the live one (its
          // lease ran out, or the machine cancelled it) reports nothing and
          // sets nothing off: checkpoint throws for it.
          await ctx.checkpoint({ step: 'failed', db: input.db });
          const detail = visuals().summarizeBootFailure(err);
          const infrastructure = !!legacy('services/deploy-failure').bootFailureIsInfrastructure(err);
          const sync = legacy('services/boot-failure-sync');
          const catchUp = infrastructure ? null
            : await sync.afterBootFailure({ config, pool, session: row, commitHash: input.head, err }).catch(() => null);
          return {
            ok: false, detail, infrastructure, aboutMain: sync.explain(catchUp) || null, sync: !!catchUp?.sync,
            servingRemoved: !!(err as { servingRemoved?: boolean }).servingRemoved,
          };
        }
      },
    },

    // The checks for the attempt that serves, from admission to the parsed
    // settlement; the machine stores it. Each claim runs its Jobs under its
    // own run id; a retry after a lost lease cancels the earlier claim's.
    [WORK.run]: {
      maxAttempts: RUN_ATTEMPTS,
      leaseMs: PREPARE_LEASE_MS,
      concurrency: CONCURRENCY,
      async run(ctx): Promise<Json> {
        const { input, attempt } = ctx;
        const [row, a] = await Promise.all([session(input.sessionId), app(input.appId)]);
        if (!row || !a) return { outcome: 'blocked', reason: 'The proposal or its app no longer exists' };
        if (config.captureRuntime === 'kubernetes') {
          for (let k = 1; k < attempt; k++) {
            await kubernetes().cancelPreviewChecks(config, input.sessionId, `${input.runId}-a${k}`);
          }
        }
        const stagingResult = { runtimeName: input.runtimeName, runtimeKind: input.runtimeKind, stagingUrl: input.url, timings: null };
        const result = await visuals().captureForSession(config, row, a, input.head, stagingResult, {
          trigger: input.trigger, force: true,
          workflow: { runId: `${input.runId}-a${attempt}`, signal: ctx.signal, checkpoint: ctx.checkpoint },
        });
        return (result ?? { outcome: 'blocked', reason: 'The checks run produced no result' }) as Json;
      },
    },

    // A cancelled run's Jobs, by its run id: never the session's others.
    [WORK.cancel]: {
      maxAttempts: 5,
      async run({ input }): Promise<Json> {
        if (config.captureRuntime !== 'kubernetes') return { skipped: 'docker' };
        for (let k = 1; k <= RUN_ATTEMPTS; k++) {
          await kubernetes().cancelPreviewChecks(config, input.sessionId, `${input.runId}-a${k}`);
        }
        return { cancelled: true };
      },
    },

    // GitHub's view of the run: the PR body's visuals block (patched or
    // cleared), and for the platform's own app the platform-variables check.
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
            const verdict = await legacy('services/platform-env-check').refreshPlatformEnvCheck({
              pool, app: a, session: row.source === 'cli_handoff' ? { ...row, checks_commit_sha: input.head } : row,
            });
            if (verdict) v.notifyChecks(input.sessionId, { state: input.state, results: [] }, input.head, null);
          }
        }
        return { published: true };
      },
    },

    // A superseded, failed or cancelled attempt: its database, its Secret
    // and its checkout. Never the serving attempt (the machine emits it
    // only for one that does not serve).
    [WORK.retireAttempt]: {
      maxAttempts: 5,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        await dbManager().dropDatabase(input.db, { strict: true });
        if (runtimeMode() === 'kubernetes') {
          const k = kubernetes();
          await k.deleteSecret(config, k.attemptSecretName(runtimeName(input.appId, input.sessionId), input.n));
        }
        await legacy('services/docker').execFileAsync('rm', ['-rf', `/tmp/usernode-preview-${input.sessionId}-a${input.n}`]).catch(() => {});
        return { dropped: input.db };
      },
    },

    // The whole preview: runtime and Secrets by identity, every attempt's
    // database, the session's check Jobs. Closed only once a second look,
    // made after any cancelled prepare has stopped, finds nothing (P-E5).
    [WORK.retire]: {
      maxAttempts: 5,
      leaseMs: 120000,
      async run({ input, signal }): Promise<Json> {
        const attempts = (input.attempts || []) as { n: number; db: string }[];
        const kube = runtimeMode() === 'kubernetes';
        const k = kubernetes();
        const name = input.runtimeKind === 'docker' || !kube ? null : (input.runtimeName || runtimeName(input.appId, input.sessionId));
        const secrets = name ? [...new Set([0, ...attempts.map((a) => a.n)])].map((n) => k.attemptSecretName(name, n)) : [];
        const sweep = async () => {
          if (name) {
            await k.deleteApplication(config, name, { identity: true, secrets });
            if (config.captureRuntime === 'kubernetes') await k.cancelPreviewChecks(config, input.sessionId);
          } else {
            await legacy('services/application-runtime').remove(config,
              { runtimeKind: 'docker', runtimeName: input.runtimeName || `usernode-staging-${input.appSlug}--${input.sessionId}` });
          }
          for (const a of attempts) await dbManager().dropDatabase(a.db, { strict: true });
        };
        await sweep();
        const wait = Date.parse(input.closeAfter) - Date.now();
        if (wait > 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, wait);
            signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
          if (signal.aborted) throw new LeaseLost();
          await sweep();
        }
        const left = name ? await k.previewResourcesPresent(config, name, secrets) : [];
        for (const a of attempts) if (await dbManager().databaseExists(a.db, { strict: true })) left.push(a.db);
        if (left.length) throw new Error(`Still present after retirement: ${left.join(', ')}`);
        return { closed: true };
      },
    },

    // A checks verdict tells the Homeroom bot (ready to try, or failing).
    [WORK.botNote]: {
      maxAttempts: 3,
      async run({ input }): Promise<Json> {
        visuals().noteBotChecksAfterChecks(pool, { id: input.sessionId }, input.state);
        return { noted: input.state };
      },
    },

    // A bot's change whose preview will not start, once per failure streak.
    [WORK.botStopped]: {
      maxAttempts: 3,
      async run({ input }): Promise<Json> {
        await legacy('services/homeroom-bot-dm').noteChangeStopped(pool, input.sessionId, { why: 'preview' });
        return { noted: true };
      },
    },

    // Before & after shots: started beside the checks once the preview is
    // up, and scheduled again when the run settles (a no-op if started).
    [WORK.startShots]: {
      maxAttempts: 3,
      async run({ input }): Promise<Json> {
        await visuals().startShotsIfIdle(config, pool, input.sessionId, input.head);
        return { started: true };
      },
    },
    [WORK.scheduleShots]: {
      maxAttempts: 3,
      async run({ input }): Promise<Json> {
        visuals().scheduleShots(config, pool, input.sessionId, input.head, 'preview-ready');
        return { scheduled: true };
      },
    },
  };
}

export function previewNotifiers({ config, pool }: Deps): Record<string, (n: any) => Promise<void> | void> {
  const ws = () => legacy('services/ws');
  const visuals = () => legacy('services/visuals');
  return {
    // The failure lines the transition wrote on an imported proposal's
    // thread, broadcast as sendSystemMessage would.
    async chat(n) {
      const { rows } = await pool.query(
        `SELECT id, content, msg_type, metadata, thread_type, thread_ref, created_at
           FROM chat_messages WHERE app_id = $1 AND metadata->>'wfEvent' = $2 ORDER BY id`,
        [n.appId, String(n.eventId)]);
      for (const r of rows) {
        const { wfEvent, ...metadata } = r.metadata || {};
        ws().broadcast(n.appId, {
          type: 'chat', id: r.id, userId: null, username: null, content: r.content, msgType: r.msg_type,
          ...(Object.keys(metadata).length ? { metadata } : {}),
          thread: { type: r.thread_type, ref: r.thread_ref }, createdAt: r.created_at,
        });
      }
    },
    checksPending: (n) => visuals().notifyChecksPending(n.sessionId, n.head, n.phase, n.trigger),
    // The verdict, with the blocking count the badge shows, read from what
    // the settlement stored.
    async checksReady(n) {
      const { rows: [r] } = await pool.query('SELECT test_results FROM chat_sessions WHERE id = $1', [n.sessionId]);
      const results = Array.isArray(r?.test_results) ? r.test_results : [];
      visuals().notifyChecks(n.sessionId, { state: n.state, results }, n.head, null);
    },
    async stagingReady(n) {
      const { rows: [r] } = await pool.query(
        `SELECT cs.testing_md, cs.testing_path, a.slug FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
        [n.sessionId]);
      ws().broadcastGlobal({
        type: 'session_event', sessionId: n.sessionId, event: 'staging_ready', url: n.url ?? null,
        testingMd: r?.testing_md || null, testingPath: r?.testing_path || null,
      });
      ws().pushSessionUpdate({ action: 'staging_ready', sessionId: n.sessionId, appSlug: r?.slug });
    },
    // A Preview click's loader waits for this or staging_ready.
    stagingFailed: (n) => ws().broadcastGlobal({
      type: 'session_event', sessionId: n.sessionId, event: 'staging_failed', error: n.detail, errorName: 'PreviewFailed', missingKeys: [],
    }),
    async visualsReady(n) {
      const stored = await visuals().getForSession(pool, n.sessionId, n.head);
      if (stored) visuals().notifyVisualsReady(n.sessionId, stored, null);
    },
    // A passing or skipped verdict re-drives the app's merge queue, here in
    // the process that applied it, as [main] does (the 4-minute
    // eligible-merge sweeper backs a lost kick).
    mergeKick: (n) => visuals().maybeAutoMergeAfterChecks(config, pool, { id: n.sessionId }, n.state),
  };
}
