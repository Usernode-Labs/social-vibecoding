// The merge-followups machine's I/O: work handlers (durable, reported back
// as events) and notifiers (post-commit pushes and kicks, allowed to be
// lost). The handlers reuse [main]'s functions; each is safe to run again
// after a crash, which is what a retried work item does.

import { setTimeout as delay } from 'node:timers/promises';
import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { backoff, closeAndComment, gone, permanent } from '../github-work.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool; shotsPollMs?: number }

// The states of a before/after shots run that holds, or will hold, the
// proposal's worker: every state but the terminal ones. Planned too: a run
// takes its hold when it starts, and stays planned while it waits (up to two
// minutes) for the session to go idle before it provisions. A planned run
// that has not started yet is waited for as well, rather than left to start
// a new worker after the retirement.
const shotsWorking = (): string[] => {
  const { STATES, TERMINAL_STATES } = legacy('services/shots-state');
  return STATES.filter((state: string) => !TERMINAL_STATES.has(state));
};

export function mergeFollowupsServices({ config, pool, shotsPollMs = 15000 }: Deps): Record<string, WorkHandler> {
  const github = () => legacy('services/github');
  const session = async (id: number) => (await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
    [id])).rows[0] || null;
  const app = async (id: number) => (await pool.query('SELECT * FROM apps WHERE id = $1', [id])).rows[0] || null;

  return {
    // Put the merge on production. A retry after a crash that had already
    // deployed finds the merge commit running and healthy, and deploys
    // nothing (reuseRunningRevision).
    [WORK.deliver]: {
      maxAttempts: 3,
      backoffMs: (attempt) => 60 * 1000 * 2 ** (attempt - 1),
      leaseMs: 120000,
      concurrency: 2,
      async run({ input }): Promise<Json> {
        const row = await app(input.appId);
        if (!row) throw permanent('the app no longer exists');
        if (row.self_hosted) throw permanent('the platform is released by its own pipeline');
        let reuseImage = null;
        if (input.reuse) {
          // Demo mode: the preview image, when its tree is the merged tree.
          const treeSha = await github().getCommitTree(input.reuse.owner, input.reuse.repo, input.reuse.commitSha).catch(() => null);
          if (treeSha) reuseImage = { imageRef: input.reuse.imageRef, buildRef: input.reuse.buildRef, treeSha, fromSha: input.reuse.commitSha };
        }
        const staging = legacy('services/staging');
        let result;
        try {
          result = await staging.rebuildProduction(config, row, {
            ...(input.mergeSha ? { reuseRunningRevision: input.mergeSha } : {}),
            ...(reuseImage ? { reuseImage } : {}),
          });
        } catch (err) {
          // A required secret without a value fails the same way every time.
          if (err instanceof staging.MissingSecretsError) throw permanent((err as Error).message);
          throw err;
        }
        await pool.query(
          `UPDATE apps SET container_id = $1, main_sha = $2, main_pr_number = $3, last_deploy_at = NOW() WHERE id = $4`,
          [result.containerId ?? null, result.sha || null, input.prNumber || null, row.id]);
        return { sha: result.sha || null, imageReused: !!result.imageReused };
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

    // Its preview goes, read as the merged row it now is, so a running
    // preview operation is aborted rather than left to the stale sweeper.
    [WORK.teardown]: {
      maxAttempts: 5,
      backoffMs: backoff,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        const row = await session(input.sessionId);
        if (!row) return { gone: true };
        const result = await legacy('services/staging').teardownStaging(row, await app(row.app_id) || { slug: row.app_slug });
        if (result?.leaked) throw new Error(result.busy ? 'a preview operation is still running' : 'the preview could not be removed');
        return { removed: !!result?.removed };
      },
    },

    // Its worker and Claude Code volume go. A shots run working in the
    // worker keeps it until the run ends. In the process running the shots
    // that is the run's hold, which worker.retireWorker defers to; any other
    // process (the workflow worker) cannot see the hold, so it reads the run
    // from the database and waits for it, at most the run's own budget.
    [WORK.retire]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input, signal }): Promise<Json> {
        const until = Date.now() + (config.shots?.maxRunMs || 1_440_000) + 300_000;
        let waited = false;
        while (Date.now() < until) {
          const { rows } = await pool.query(
            'SELECT 1 FROM shot_runs WHERE session_id = $1 AND state = ANY($2::text[]) LIMIT 1', [input.sessionId, shotsWorking()]);
          if (!rows.length) break;
          waited = true;
          await delay(shotsPollMs, undefined, { signal });
        }
        const result = await legacy('services/worker').retireWorker(input.sessionId);
        return { deferred: !!result?.deferred, ...(waited ? { waitedForShots: true } : {}) };
      },
    },

    // The app's other changes up for a vote whose head is one of this pull
    // request's commits went live with it (services/included-changes.js).
    [WORK.find]: {
      maxAttempts: 6,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const gh = github();
        if (!gh.isEnabled()) return { found: [], ids: [] };
        // Each change goes with the head that was found merged, which the
        // Included guard compares under the change's lock: an operation on
        // the change in some other process (an upload, a sync with main) that
        // moved it since is caught there, where no process's memory is read.
        const changes = legacy('services/included-changes');
        const { rows } = await pool.query(changes.CANDIDATES_SQL, [input.appId, input.sessionId]);
        if (!rows.length) return { found: [], ids: [] };
        const listed = await gh.listPullRequestCommitShas(input.owner, input.repo, input.prNumber);
        const head = legacy('services/pr-vote-revision').reviewedHeadForSession;
        const found = changes.containedIn(rows, listed?.shas)
          .map((c: any) => ({ id: Number(c.id), head: String(head(c)).toLowerCase() }));
        // `ids` too, for one release: a web Pod still on the previous version
        // reads only `ids`, and would otherwise settle this find as finding
        // nothing (during a rollout, or after a rollback).
        return { found, ids: found.map((c: { id: number }) => c.id) };
      },
    },

    // The requests it closes read closed everywhere. For a merge: what
    // [main]'s merge did at once, then the watcher (GitHub closes `Closes #N`
    // late, or not at all). For an included change: its requests closed by
    // hand, since its own pull request never merged.
    [WORK.issues]: {
      maxAttempts: 6,
      backoffMs: backoff,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        const gh = github();
        if (!gh.isEnabled()) return { skipped: 'github_off' };
        const numbers: number[] = legacy('services/pr-metadata').sanitizeIssueNumbers(input.linkedIssues);
        if (input.closeOnly) {
          const changes = legacy('services/included-changes');
          const row = { id: input.sessionId, app_id: input.appId, app_slug: input.appSlug, linked_issues: numbers };
          const { closed, failed } = await changes.closeRequests({
            pool, row, carrier: { pr_number: input.carrierPrNumber || null }, github: gh,
            repo: { owner: input.owner, repo: input.repo }, d: changes.depsOf(), bounties: false, report: true, strict: true,
          });
          // A request that is gone (404, 410) is closed enough; any other
          // failure is retried (closing a closed request again is harmless).
          const unclosed = failed.filter((f: { status: number | null }) => f.status !== 404 && f.status !== 410);
          if (unclosed.length) {
            throw new Error(`Could not close request${unclosed.length === 1 ? '' : 's'} ${unclosed.map((f: { number: number }) => `#${f.number}`).join(', ')} on GitHub`);
          }
          return { closed };
        }
        if (numbers.length) {
          gh.noteIssuesClosed(input.owner, input.repo, numbers);
          await legacy('routes/issues').resolveSupersededCloseProposals(pool, {
            appId: input.appId, appSlug: input.appSlug, numbers, cause: { kind: 'pr-merge', prNumber: input.prNumber },
            strict: true,
          });
        }
        gh.invalidateIssuesCache(input.owner, input.repo);
        legacy('services/ws').pushIssueUpdate({ action: 'github_synced', appSlug: input.appSlug, appId: input.appId, source: 'pr_merged' });
        const out = await legacy('services/issue-close-watcher').watchIssuesClosedAfterMerge({
          owner: input.owner, repo: input.repo, prNumber: input.prNumber, linkedIssues: numbers,
          appSlug: input.appSlug, appId: input.appId, pool, strict: true,
        });
        // A linked request the watcher could neither see closed nor close is
        // retried: the next attempt watches and closes again. A number only
        // the PR's body names is never closed here, so it is not waited for.
        const open = (out.stillOpen || []).filter((n: number) => numbers.includes(n));
        if (open.length) throw new Error(`Linked request${open.length === 1 ? '' : 's'} ${open.map((n: number) => `#${n}`).join(', ')} still open on GitHub`);
        return out as Json;
      },
    },

    // An included change's own pull request: "Included in #N", then closed.
    [WORK.closePr]: {
      maxAttempts: 6,
      backoffMs: backoff,
      run: (ctx) => closeAndComment(ctx, (gh, owner, repo, number) => gh.closePR(owner, repo, number)),
    },

    // The repository's unit suite on the merge commit (services/main-watch.js).
    // Its claim is per commit, so a retry after a crash finds it claimed and
    // returns; main-watch's own recovery re-drives a run that died.
    [WORK.mainCheck]: {
      maxAttempts: 3,
      backoffMs: backoff,
      leaseMs: 5 * 60 * 1000,
      async run({ input }): Promise<Json> {
        const row = await app(input.appId);
        if (!row) return { skipped: 'no_app' };
        const verdict = await legacy('services/main-watch').afterMerge(config, pool, {
          app: row, session: { id: input.sessionId, pr_number: input.prNumber }, mergeSha: input.mergeSha,
        });
        return { state: verdict?.state ?? null };
      },
    },

    // The bot's other work on the same request stops (homeroom-bot.js),
    // bounded to what had started before the merge.
    [WORK.bot]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const out = await legacy('services/homeroom-bot').noteRequestMerged(pool, { id: input.sessionId }, { before: input.before });
        return (out || null) as Json;
      },
    },

    // Whoever the bot built it for hears it is live, in their DM.
    [WORK.dm]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const sent = await legacy('services/homeroom-bot-dm').noteProposalMerged(pool, { id: input.sessionId },
          { config, sha: input.sha, live: true });
        return { sent: !!sent };
      },
    },

    // The admin Journey's change_live record, at the merge's time.
    [WORK.journey]: {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const row = await session(input.sessionId);
        if (!row) return { gone: true };
        await legacy('services/journey-events').recordChangeLive(pool, {
          config, session: row, sha: input.sha, at: new Date(input.at), deps: { live: () => true },
        });
        return { recorded: true };
      },
    },
  };
}

export function mergeFollowupsNotifiers({ config, pool }: Deps): Record<string, (n: any) => Promise<void> | void> {
  const ws = () => legacy('services/ws');
  const strip = ({ type, ...rest }: any) => rest;
  return {
    // The thread lines the transition wrote, broadcast as sendSystemMessage would.
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
    voteUpdate: (n) => ws().pushVoteUpdate(strip(n)),
    // The next merge for the app: the queue's drain (backed by the 4-minute
    // eligible-merge sweeper when this kick is lost).
    kickQueue: (n) => legacy('services/conflict-resolver')
      .checkAndResolveConflicts(config, { app_id: n.appId, excludeSessionId: n.excludeSessionId }),
    // Docker self-hosting: the host deployer fetches at once instead of on its poll.
    nudgeDeployer(n) {
      if (legacy('services/application-runtime').mode(config) === 'kubernetes') return;
      legacy('services/deploy-nudge').nudgeHostDeployer({ sha: n.sha, prNumber: n.prNumber });
    },
    appVersion: (n) => ws().broadcastGlobalScoped(
      { type: 'app_version_changed', appSlug: n.appSlug, sha: n.sha || null, prNumber: n.prNumber || null },
      { appId: n.appId, appSlug: n.appSlug }),
    // Everyone with a bell row about the change re-reads their bell.
    async bell(n) {
      const { rows } = await pool.query('SELECT DISTINCT user_id FROM notifications WHERE session_id = $1', [n.sessionId]);
      for (const r of rows) ws().pushNotificationToUser(r.user_id, { type: 'notifications_changed' });
    },
    // The author's "your change is live", on their open tabs.
    async mergedNotification(n) {
      if (!n.userId) return;
      const { rows } = await pool.query(
        `SELECT id, user_id, app_id, session_id, source_user_id, kind, detail, created_at
           FROM notifications WHERE user_id = $1 AND session_id = $2 AND kind = 'pr_merged' ORDER BY id DESC LIMIT 1`,
        [n.userId, n.sessionId]);
      if (rows[0]) await legacy('services/notifications').hydrateAndPush(pool, rows[0]);
    },
  };
}
