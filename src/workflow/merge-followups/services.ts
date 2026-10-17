// The merge-followups machine's I/O: work handlers (durable, reported back
// as events). What browsers hear is a push the transition publishes
// (../pushes.ts); nothing runs after a transition commits. The handlers
// reuse [main]'s functions; each is safe to run again after a crash, which
// is what a retried work item does.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { backoff, closeAndComment, gone, permanent } from '../github-work.ts';
import { INCLUDED_CANDIDATES_SQL, includedIn, liveShotsRun } from './facts.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

export function mergeFollowupsServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const github = () => legacy('services/github');
  const session = async (id: number) => (await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
    [id])).rows[0] || null;

  return {
    // Docker self-hosting: the host deployer fetches at once instead of on
    // its poll (Kubernetes releases through Argo CD: nothing to tell).
    [WORK.nudge]: {
      maxAttempts: 3,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        if (legacy('services/application-runtime').mode(config) === 'kubernetes') return { skipped: 'kubernetes' };
        return { nudged: !!legacy('services/deploy-nudge').nudgeHostDeployer({ sha: input.sha, prNumber: input.prNumber }) };
      },
    },

    // Whether a build production now runs contains the merge commit.
    [WORK.verify]: {
      maxAttempts: 6,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        if (!github().isEnabled()) throw permanent('GitHub is not configured');
        try {
          const { status } = await github().compareCommitAncestry(input.owner, input.repo, input.mergeSha, input.sha);
          return { sha: input.sha, contains: status === 'identical' || status === 'ahead' };
        } catch (err) {
          if (gone(err)) return { sha: input.sha, contains: false };
          throw err;
        }
      },
    },

    // One release only: an older release queued the preview's teardown as
    // work. It reports, and the transition that applies the result asks the
    // preview machine to retire it (machine.ts); since this release the
    // merge's transition asks it by message.
    [WORK.teardown]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run(): Promise<Json> { return { handedOff: true }; },
    },

    // Its worker and Claude Code volume go, unless a shots run is still
    // under way in them (the shots machine's instance says): then it says
    // which, and the machine asks again later. Strict and fenced
    // (worker.removeCcVolume): the shots run is read again between reading
    // what to remove and removing it, and a removal the runtime refuses is
    // tried again.
    [WORK.retire]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run(ctx): Promise<Json> {
        const id = Number(ctx.input.sessionId);
        const live = await liveShotsRun(pool, id);
        if (live) return { waiting: live };
        let waiting: string | null = null;
        const out = await legacy('services/worker').removeCcVolume(id, {
          proceed: async () => { await ctx.checkpoint({ removing: true }); waiting = await liveShotsRun(pool, id); return !waiting; },
          renew: () => ctx.checkpoint({ removing: true }),
        });
        if (out.skipped) return { waiting: waiting || 'run' };
        return { retired: true };
      },
    },

    // The app's other changes up for a vote whose head is one of this pull
    // request's commits went live with it (workflow/merge-followups/facts.ts).
    // Each is named with the head that matched: the machine marks it only
    // if that is still its head, and nothing is working on it, read under
    // its own lock (machine.ts notIncludable).
    //
    // A change busy with an operation (a sync with main or a dispatch
    // starting its worker, a hand-off's commit upload, a local agent run, a
    // push not yet reconciled into its head) is left out too: the preview
    // machine records those operations, and the guard reads them from its
    // record, in whichever process runs it.
    [WORK.find]: {
      maxAttempts: 6,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const gh = github();
        if (!gh.isEnabled()) return { ids: [], found: [] };
        const { rows } = await pool.query(INCLUDED_CANDIDATES_SQL, [input.appId, input.sessionId]);
        if (!rows.length) return { ids: [], found: [] };
        const listed = await gh.listPullRequestCommitShas(input.owner, input.repo, input.prNumber);
        const found = includedIn(rows, listed?.shas);
        return { ids: found.map((f) => f.id), found };
      },
    },

    // The requests it closes read closed everywhere. For a merge: what
    // [main]'s merge did at once (the superseded close proposals), then the watcher (GitHub closes `Closes #N`
    // late, or not at all). For an included change: its requests closed by
    // hand, since its own pull request never merged.
    [WORK.issues]: {
      maxAttempts: 6,
      backoffMs: backoff,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        const gh = github();
        if (!gh.isEnabled()) return { skipped: 'github_off' };
        const watcher = legacy('services/issue-close-watcher');
        if (input.closeOnly) {
          const { closed, failed, targets } = await watcher.closeIncluded({
            owner: input.owner, repo: input.repo, prNumber: input.carrierPrNumber || null,
            linkedIssues: input.linkedIssues, appId: input.appId, pool,
          });
          // A request that is gone (404, 410) is closed enough; any other
          // failure is retried (closing a closed request again is harmless).
          const unclosed = failed.filter((f: { status: number | null }) => f.status !== 404 && f.status !== 410);
          if (unclosed.length) {
            throw new Error(`Could not close request${unclosed.length === 1 ? '' : 's'} ${unclosed.map((f: { number: number }) => `#${f.number}`).join(', ')} on GitHub`);
          }
          return { closed, targets };
        }
        const out = await watcher.closeAfterMerge({
          owner: input.owner, repo: input.repo, prNumber: input.prNumber, linkedIssues: input.linkedIssues,
          // An item an older release queued has no `look`: a first look.
          appId: input.appId, pool, look: input.look === 2 ? 2 : 1,
        });
        // A linked request it could neither see closed nor close at the
        // second look is retried. A number only the PR's body names is
        // never closed here, so it is not waited for.
        const linked = new Set((Array.isArray(input.linkedIssues) ? input.linkedIssues : []).map(Number));
        const open = (out.stillOpen || []).filter((n: number) => linked.has(n));
        if (!out.waiting && open.length) throw new Error(`Linked request${open.length === 1 ? '' : 's'} ${open.map((n: number) => `#${n}`).join(', ')} still open on GitHub`);
        return out as Json;
      },
    },

    // An included change's own pull request: "Included in #N", then closed.
    [WORK.closePr]: {
      maxAttempts: 6,
      backoffMs: backoff,
      run: (ctx) => closeAndComment(ctx, 'pullRequest'),
    },

    // One release only: an older release queued the merge commit's unit
    // suite as work. It reports, and the transition that applies the result
    // asks the main-check machine (machine.ts); since this release the
    // merge's transition asks it by message.
    [WORK.mainCheck]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run(): Promise<Json> { return { handedOff: true }; },
    },

    // The admin Journey's change_live record, at the merge's time.
    [WORK.journey]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const row = await session(input.sessionId);
        if (!row) return { gone: true };
        await legacy('services/journey-events').recordChangeLive(pool, {
          session: row, sha: input.sha, at: new Date(input.at), strict: true,
        });
        return { recorded: true };
      },
    },
  };
}
