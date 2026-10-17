// The main-check machine's I/O: the suite's run, and the filings that follow
// a verdict. Durable work, reported back as events.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { parseGithubUrl } from '../rules/github-url.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

// The output of the failing tests kept for a flake or a fix request: a few,
// and short, since they ride on the instance until the confirmation reports.
const MAX_EXCERPTS = 10;
const EXCERPT_CHARS = 1500;

export function mainCheckServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const watch = () => legacy('services/main-watch');
  const app = async (id: number) => (await pool.query('SELECT id, slug, repo_url FROM apps WHERE id = $1', [id])).rows[0] || null;
  return {
    // One run of the repo's unit suite on the commit (main-watch.js
    // runMainSuite): its checks-queue slot, its Jobs, its verdict. The
    // queue row's run id is checkpointed before the Jobs exist, so the next
    // attempt after a crash reads the dead run's Jobs rather than run the
    // suite again; attempts lost with their process do not count.
    [WORK.suite]: {
      resumable: true,
      maxAttempts: 3,
      backoffMs: (n) => 60 * 1000 * 2 ** (n - 1),
      // Renewed while it runs (a suite takes minutes): a process that exits
      // mid-suite leaves it to the next one within this much.
      leaseMs: 90 * 1000,
      concurrency: 4,
      async run(ctx): Promise<Json> {
        const row = await app(Number(ctx.input.appId));
        if (!row) return { state: 'skipped', detail: { reason: 'the app no longer exists' } };
        // The run to carry on: this item's own, or (an adopted row) the one
        // an older release left.
        const resumeRunId = (ctx.resumeFrom as { runId?: string } | null)?.runId ?? ctx.input.resumeRunId ?? null;
        const out = await watch().runMainSuite(config, pool, {
          app: row, sha: String(ctx.input.sha), resumeRunId, signal: ctx.signal,
          // A save that fails for another reason than a lost claim costs
          // only the adoption after a crash: the run goes on.
          onRunId: (runId: string) => ctx.checkpoint({ runId }).catch((err: any) => {
            if (err?.constructor?.name === 'LeaseLost' || ctx.signal.aborted) throw err;
          }),
        });
        const excerpts = (Array.isArray(out.excerpts) ? out.excerpts : []).slice(0, MAX_EXCERPTS)
          .map((x: any) => ({ ...x, ...(typeof x?.excerpt === 'string' ? { excerpt: x.excerpt.slice(0, EXCERPT_CHARS) } : {}) }));
        return JSON.parse(JSON.stringify({ state: out.state, detail: out.detail || {}, excerpts })) as Json;
      },
    },

    // The tests a verdict showed to be flaky, recorded, and a request filed
    // for each (`note`); or a request for each test of a red made only of
    // known flakes (`request`). One request per test per fortnight, claimed
    // on its row (main-watch.js fileFlakeRequest). Each is a step: the record
    // is made once, and a claim is kept before its request is filed, so the
    // attempt after a crash files it (or finds it filed) rather than find
    // the test claimed and file nothing.
    [WORK.flakes]: {
      maxAttempts: 3,
      backoffMs: (n) => 60 * 1000 * 2 ** (n - 1),
      async run(ctx): Promise<Json> {
        const { input } = ctx;
        const row = await app(Number(input.appId));
        if (!row) return { gone: true };
        const w = watch();
        const steps = ctx.steps({ owner: `main-check/flakes:${input.appId}` });
        const excerpts: any[] = input.excerpts || [];
        const tests: any[] = input.mode === 'note'
          ? await steps.once('recorded', async () => w.noteFlakes(config, pool, row, input.sha, input.reds || [], excerpts, { file: false }))
          : (input.tests || []);
        const filed: number[] = [];
        for (const t of tests) {
          const key = `${t.file || ''}::${t.test}`;
          const excerpt = (excerpts.find((d) => d && d.test === t.test && (d.file || null) === (t.file || null)) || {}).excerpt;
          const n = await steps.once(`filed/${key}`, () => w.fileFlakeRequest(config, pool, row, t, {
            mergeSha: input.sha, excerpt, strict: true,
            claim: steps.get(`claim/${key}`) ?? null, onClaim: (c: Json) => steps.set(`claim/${key}`, c),
          }));
          if (n) filed.push(Number(n));
        }
        await steps.flush();
        return { recorded: input.mode === 'note' ? tests.length : 0, filed };
      },
    },

    // A confirmed red: one request to fix it, for the Homeroom bot, naming
    // the merges its failing tests point at (main-red-fix.js), unless one is
    // open for the app already. Its claim is kept before the request is
    // filed, as above.
    [WORK.fix]: {
      maxAttempts: 3,
      backoffMs: (n) => 60 * 1000 * 2 ** (n - 1),
      async run(ctx): Promise<Json> {
        const { input } = ctx;
        const row = await app(Number(input.appId));
        if (!row) return { gone: true };
        const parsed = parseGithubUrl(row.repo_url);
        if (!parsed) return { skipped: 'no_repo' };
        const steps = ctx.steps({ owner: `main-check/fix:${input.appId}` });
        const issueNumber = await legacy('services/main-red-fix').fileFixRequest(config, pool, {
          app: row, parsed, redSha: input.sha, prNumber: input.prNumber ?? null, detail: input.detail || {},
          excerpts: input.excerpts || [], fileBotIssue: watch().fileBotIssue, strict: true,
          claim: steps.get('claim') ?? null, onClaim: (id: number) => steps.set('claim', id),
        });
        await steps.flush();
        return { issueNumber: issueNumber ?? null };
      },
    },
  };
}
