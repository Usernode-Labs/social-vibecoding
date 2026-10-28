// The merge-followups machine's I/O: work handlers (durable, reported back
// as events). What browsers hear is a push the transition publishes
// (../pushes.ts); nothing runs after a transition commits. The handlers
// reuse [main]'s functions; each is safe to run again after a crash, which
// is what a retried work item does.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { backoff, closeAndComment, gone, permanent } from '../github-work.ts';
import { CARRIER_CANDIDATES_SQL, INCLUDED_CANDIDATES_SQL, includedIn, liveShotsRun, lists } from './facts.ts';
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
          return { sha: input.sha, contains: status === 'identical' || status === 'ahead', status };
        } catch (err) {
          if (gone(err)) return { sha: input.sha, contains: false };
          throw err;
        }
      },
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
        if (!gh.isEnabled()) return { found: [] };
        const { rows } = await pool.query(INCLUDED_CANDIDATES_SQL, [input.appId, input.sessionId]);
        if (!rows.length) return { found: [] };
        const listed = await gh.listPullRequestCommitShas(input.owner, input.repo, input.prNumber);
        const found = includedIn(rows, listed?.shas);
        return { found };
      },
    },

    // A merge whose commit is off main looks for the later merge that carried
    // it there (facts.ts CARRIER_CANDIDATES_SQL): one whose pull request
    // lists the commit, and whose recorded merge commit the build contains.
    // A merged pull request's commits never change, so one that does not
    // list it is ruled out for good: `scanned` is the last of an unbroken run
    // of those, where the next look starts. None found: it waits, and the
    // next build looks again. A pull request or commit GitHub no longer has
    // is not the carrier.
    [WORK.carrier]: {
      maxAttempts: 6,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const gh = github();
        if (!gh.isEnabled()) return { carrier: null };
        const after = input.after as { mergedAt?: string; id?: number } | null;
        let scanned = after?.mergedAt && Number.isInteger(after.id) ? { mergedAt: after.mergedAt, id: after.id! } : null;
        const { rows } = await pool.query(CARRIER_CANDIDATES_SQL,
          [input.appId, input.sessionId, scanned?.mergedAt ?? input.mergedAt, scanned?.id ?? 0]);
        let unbroken = true;
        for (const c of rows) {
          const here = { mergedAt: new Date(c.merged_at).toISOString(), id: Number(c.id) };
          let listed: { shas?: string[]; complete?: boolean } | null;
          try {
            listed = await gh.listPullRequestCommitShas(input.owner, input.repo, Number(c.pr_number));
          } catch (err) {
            if (!gone(err)) throw err;
            if (unbroken) scanned = here;
            continue;
          }
          if (!lists(listed?.shas, input.mergeSha)) {
            // A list cut short rules nothing out.
            if (listed?.complete === false) unbroken = false;
            else if (unbroken) scanned = here;
            continue;
          }
          unbroken = false;
          const mergeSha = String(c.merge_commit_sha).toLowerCase();
          try {
            const { status } = await gh.compareCommitAncestry(input.owner, input.repo, mergeSha, input.release);
            if (status !== 'identical' && status !== 'ahead') continue;
          } catch (err) {
            if (gone(err)) continue;
            throw err;
          }
          return { carrier: { sessionId: Number(c.carrier_id),
            prNumber: c.carrier_pr_number == null ? null : Number(c.carrier_pr_number), prTitle: c.carrier_pr_title ?? null, mergeSha } };
        }
        return { carrier: null, scanned };
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
