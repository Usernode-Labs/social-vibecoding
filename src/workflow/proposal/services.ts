// The proposal machine's I/O: work handlers, each reported back as an event.
// Each is safe to run again after a crash, which is what a retried work item
// does. What browsers hear is a push the transition publishes.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { parseGithubUrl } from '../rules/github-url.ts';
import { permanent } from '../work-errors.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

const SHA = /^[0-9a-f]{40}$/i;
const gone = (err: any) => err?.status === 404 || err?.status === 410;
// A refusal the promote route answers with, by its code (platform.ts).
const refused = (code: string, message: string) => Object.assign(permanent(message), { code });
// GitHub's answer comes in seconds; a promote waits about twenty.
const quick = (attempt: number) => Math.min(20 * 1000, 2000 * 2 ** (attempt - 1));

export function proposalServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const github = () => legacy('services/github');
  // The proposal machine's instance of the session: what it decided last.
  const lifecycle = async (id: number) => (await pool.query(
    `SELECT state, data FROM wf_instances WHERE machine = 'proposal' AND key = $1`, [`session:${id}`])).rows[0] || null;
  const session = async (id: number) => (await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [id])).rows[0] || null;

  return {
    // Up for a vote, on GitHub: the pull request created if it has none
    // (titled as the promote route always titled it), the requests it was
    // started from linked, a closed one of ours reopened, a draft of ours
    // marked ready for review, and the head read. The proposal is in review
    // once this reports. Nothing here runs unless the proposal was claimed
    // for review first (R4).
    [WORK.open]: {
      maxAttempts: 3,
      backoffMs: quick,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        const row = await session(Number(input.sessionId));
        if (!row) throw refused('not_found', 'The proposal is gone');
        const imported = row.source === 'imported';
        const repo = parseGithubUrl(row.repo_url || '');
        const gh = github();

        // #2500 / #2537: the originating request of a session older than the
        // creation-time seed, linked before the group reads it (the row's
        // seeded mark is the transition's to write). Best effort.
        let issueLinkSeeded = false;
        if (!row.issue_link_seeded && Number.isInteger(row.created_from_issue_number) && row.created_from_issue_number > 0
            && !(Array.isArray(row.linked_issues) ? row.linked_issues : []).length) {
          try {
            await legacy('services/proposal-update').updateLinkedIssues({
              pool, gh, session: row, owner: repo?.owner, repo: repo?.repo,
              addIssues: [row.created_from_issue_number], removeIssues: [],
            });
            issueLinkSeeded = true;
          } catch { /* a proposal never fails to go up for a vote over its linkage */ }
        }

        // The pull request: created when there is none (a failure refuses
        // the promote), its title backfilled, or rewritten from the change
        // as it stands for one an agent session started (#2779). Imported
        // proposals always have theirs.
        if (!imported && (!row.pr_number || !row.pr_title || row.agent_session_id != null)) {
          const creating = !row.pr_number;
          let result = null;
          let error: any = null;
          try {
            const { rows: [msg] } = await pool.query(
              `SELECT content FROM chat_session_messages WHERE session_id = $1 AND role = 'user' ORDER BY id DESC LIMIT 1`, [row.id]);
            const { rows: [owner] } = await pool.query('SELECT username FROM users WHERE id = $1', [row.user_id]);
            let apiKey = null;
            let allowModelGeneration = false;
            try {
              const billing = await legacy('services/limits').resolveBillingPath(pool, config.dataEncryptionKey, Number(input.userId));
              if (!billing.error) { apiKey = billing.apiKey; allowModelGeneration = true; }
            } catch { /* the deterministic draft below */ }
            result = await legacy('services/pr-metadata').applyPrMetadata({
              pool, session: row, repoOwner: repo?.owner, repoName: repo?.repo,
              userMessage: msg?.content || '', ccSummary: '', username: owner?.username || 'someone',
              apiKey, userId: Number(input.userId), allowModelGeneration, preferredTitle: row.proposed_pr_title || null,
            });
          } catch (err) {
            error = err;
          }
          if (creating && (!result || !row.pr_number)) {
            if (error?.code === 'no_commits') {
              throw refused('no_commits', 'This change has no committed code on its branch yet, so there is nothing to open a pull request for. Re-run your request in the session so it produces and pushes a commit, then propose again.');
            }
            if (error?.code === 'github_unavailable') {
              const detail = [
                error.status ? `HTTP ${error.status} from GitHub` : 'network error reaching GitHub',
                error.requestId ? `request id ${error.requestId}` : null,
              ].filter(Boolean).join(', ');
              throw refused('github_unavailable', `GitHub is currently failing to create pull requests (${detail}). This is a GitHub-side problem, not this change: the work is safe on its branch. Try proposing again in a few minutes; do not re-run the request or push extra commits.`);
            }
            throw refused('pr_create_failed', 'Could not create the pull request for this change. Please retry; if it keeps failing, re-run your request in the session.');
          }
        }

        let head: string | null = null;
        if (gh.isEnabled() && row.repo_url && row.pr_number) {
          if (!repo) throw refused('no_repo', 'This proposal has no valid GitHub repository to verify.');
          let pr: any;
          try {
            pr = await gh.getPR(repo.owner, repo.repo, row.pr_number);
          } catch (err) {
            if (gone(err)) throw refused('pr_create_failed', 'The pull request for this change is gone from GitHub.');
            throw Object.assign(new Error('GitHub could not verify the pull request revision. Try promoting again shortly.'), { code: 'github_unavailable' });
          }
          if (pr?.merged) throw refused('pr_merged', `PR #${row.pr_number} was already merged on GitHub. This change has landed, so there is nothing to vote on.`);
          if (pr?.state === 'closed') {
            if (imported) throw refused('pr_closed', 'This change was closed on GitHub, so it can\'t ask for approval.');
            try {
              await gh.reopenPR(repo.owner, repo.repo, row.pr_number);
            } catch {
              throw refused('reopen_failed', `This proposal's pull request (#${row.pr_number}) was closed on GitHub and couldn't be reopened. Re-propose it as a fresh proposal.`);
            }
          }
          if (imported && pr?.draft) throw refused('pr_draft', 'This pull request is a draft on GitHub. Its author marks it ready for review before it can go up for a vote.');
          head = String(pr?.head?.sha || '').toLowerCase();
          if (!SHA.test(head)) throw refused('bad_head', 'GitHub did not return a valid pull-request head commit.');
          if (input.expectedHead && head !== String(input.expectedHead).toLowerCase()) {
            throw refused('branch_head_changed', 'The proposal branch changed after checks. Rebuild the new head locally or from the web Dev session before promoting.');
          }
          // Ours, ready for review before the vote opens (bug 9). An
          // imported one is as its author keeps it (a draft was refused).
          if (!imported) {
            try {
              await gh.markPrReadyForReview(repo.owner, repo.repo, row.pr_number, pr);
            } catch (err) {
              throw Object.assign(new Error('GitHub could not mark the draft pull request ready for review. The change is still underway; try promoting it again shortly.'), { code: 'ready_failed' });
            }
          }
        } else if (!imported && row.reviewed_head_sha) {
          head = String(row.reviewed_head_sha).toLowerCase();
        }

        // #788: whether its diff changes a protected dapp.json block, stamped
        // now so the first vote panel already says so (checkAndMerge checks
        // again before it merges).
        await legacy('services/app-admins').refreshExplicitApproval(pool, row, { ...row, reviewed_head_sha: head || row.reviewed_head_sha });
        return { head, prNumber: row.pr_number ?? null, prUrl: row.pr_url ?? null, prTitle: row.pr_title ?? null, issueLinkSeeded };
      },
    },

    // A closed proposal's pull request is closed on GitHub, an imported one's
    // too. One already closed or gone counts as closed.
    [WORK.close]: {
      maxAttempts: 8,
      backoffMs: (n) => Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** (n - 1)),
      async run({ input }): Promise<Json> {
        const gh = github();
        if (!gh.isEnabled()) return { skipped: 'github_disabled' };
        // Closed while GitHub was opening its pull request: the number it has now.
        let number = input.number;
        if (number == null) number = (await session(Number(input.sessionId)))?.pr_number ?? null;
        if (number == null) return { none: true };
        try {
          await gh.closePR(input.owner, input.repo, number);
        } catch (err) {
          if (gone(err)) return { gone: true };
          throw err;
        }
        return { closed: true };
      },
    },

    // A reopened proposal's pull request is reopened. One GitHub says is
    // closed for good (its branch gone, a newer pull request on it) is
    // reported `cleared`: the proposal forgets it, and its next promote
    // opens a fresh one. A failed read is retried, never read as "closed".
    [WORK.reopen]: {
      maxAttempts: 6,
      backoffMs: (n) => Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** (n - 1)),
      async run({ input }): Promise<Json> {
        const gh = github();
        if (!gh.isEnabled()) return { skipped: 'github_disabled' };
        try {
          await gh.reopenPR(input.owner, input.repo, input.number);
          return { reopened: true };
        } catch (err) {
          const pr = await gh.getPR(input.owner, input.repo, input.number);
          if (pr?.merged) return { merged: true };
          if (pr?.state === 'closed') return { cleared: true, prNumber: input.number };
          if (pr?.state === 'open') return { reopened: true };
          throw err;
        }
      },
    },

    // Its worker goes (a pause, an unpromote, a close). One already gone is
    // gone. Fenced and finished (worker.removeWorker): the resources are read
    // by identity, then removed only while this claim is still ours (a
    // checkpoint is refused once it is not) and the session has not taken
    // its slot back; it reports once they are gone. A resume waits for it
    // meanwhile (facts.ts readTeardown).
    [WORK.destroy]: {
      maxAttempts: 8,
      backoffMs: (n) => Math.min(10 * 60 * 1000, 15 * 1000 * 2 ** (n - 1)),
      async run(ctx): Promise<Json> {
        const id = Number(ctx.input.sessionId);
        const back = async () => {
          const i = await lifecycle(id);
          return i?.state === 'underway' && i.data?.slot === 'held';
        };
        if (await back()) return { skipped: 'held' };
        const out = await legacy('services/worker').removeWorker(id, {
          proceed: async () => { await ctx.checkpoint({ removing: true }); return !(await back()); },
          renew: () => ctx.checkpoint({ removing: true }),
        });
        return out.skipped ? { skipped: 'held' } : { destroyed: true };
      },
    },

    // Its Claude Code volume goes at once (with its worker), for a close that
    // asked: fenced and finished the same way, only while it is closed.
    [WORK.purge]: {
      maxAttempts: 8,
      backoffMs: (n) => Math.min(10 * 60 * 1000, 15 * 1000 * 2 ** (n - 1)),
      async run(ctx): Promise<Json> {
        const id = Number(ctx.input.sessionId);
        const closed = async () => (await lifecycle(id))?.state === 'closed';
        // Reopened since: its memory stays.
        if (!(await closed())) return { skipped: 'reopened' };
        const out = await legacy('services/worker').removeCcVolume(id, {
          proceed: async () => { await ctx.checkpoint({ removing: true }); return closed(); },
          renew: () => ctx.checkpoint({ removing: true }),
        });
        return out.skipped ? { skipped: 'reopened' } : { purged: true };
      },
    },

    // The merge gate, measured (routes/votes.js evaluateMergeGate): the live
    // revision, the protected-settings check, the votes, the lock, the
    // mirror's merge, the checks, the shots, the platform variables, main's
    // health. It writes what it found for the card and says in the thread
    // what somebody has to do; the claim is the transition's, under the
    // proposal's lock.
    [WORK.gate]: {
      maxAttempts: 3,
      backoffMs: quick,
      leaseMs: 180000,
      async run({ input }): Promise<Json> {
        const { rows: [row] } = await pool.query(
          `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.self_hosted AS app_self_hosted, a.created_by AS app_created_by
             FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [Number(input.sessionId)]);
        if (!row || row.status !== 'promoted') return { ready: false, blockReason: 'not_in_review' };
        const out = await legacy('routes/votes').evaluateMergeGate(config, pool, row, {
          force: !!input.force, forceBy: input.forcedBy ? { username: input.forcedBy } : null,
        });
        if (out?.ready) {
          return { ready: true, head: out.head, epoch: out.epoch, explicitApproval: !!out.explicitApproval,
            explicitReason: out.explicitReason ?? null, mainPassThrough: !!out.mainPassThrough, tally: out.tally ?? null };
        }
        const reason = out?.blockReason || (out?.revisionBlocked ? 'revision_unverified' : out?.reviewReset ? 'review_reset'
          : out?.waitingForWindow ? 'window' : out?.awaitingOtherMember ? 'awaiting_member' : out?.awaitingAdmin ? 'awaiting_admin'
            : 'votes');
        return { ready: false, blockReason: reason, ...(out?.checkState ? { checkState: out.checkState } : {}) };
      },
    },

    // GitHub is asked to merge it, at exactly the head the claim was for
    // (routes/votes.js attemptMerge). A retry after it asked reads the pull
    // request first: a lost answer is observed, never asked twice. Spent
    // with GitHub never answering, the proposal waits `unconfirmed`.
    [WORK.attempt]: {
      maxAttempts: 6,
      backoffMs: (n) => Math.min(60 * 1000, 5000 * 2 ** (n - 1)),
      leaseMs: 120000,
      async run(ctx): Promise<Json> {
        const out = await legacy('routes/votes').attemptMerge(config, pool, Number(ctx.input.sessionId), {
          head: ctx.input.head ?? null, resumeFrom: ctx.resumeFrom, checkpoint: ctx.checkpoint,
        });
        return JSON.parse(JSON.stringify(out)) as Json;
      },
    },

    // Did GitHub merge it? (An attempt it never answered, or a claim an
    // older release made and lost.) A failed read reports nothing to act on
    // and the clock asks again.
    [WORK.observe]: {
      maxAttempts: 2,
      backoffMs: () => 10000,
      async run({ input }): Promise<Json> {
        const row = await session(Number(input.sessionId));
        const repo = row?.repo_url ? parseGithubUrl(row.repo_url) : null;
        if (!row || !repo || !row.pr_number) return { merged: false, gone: true };
        const mock = row.source === 'imported' && legacy('config').usesMockGithubForImports();
        const gh = mock ? legacy('services/github-mock') : github();
        if (!mock && !gh.isEnabled()) throw new Error('GitHub is not configured');
        try {
          const pr = await gh.getPR(repo.owner, repo.repo, row.pr_number);
          if (pr?.merged) return { merged: true, sha: pr.merge_commit_sha || null, mergedAt: pr.merged_at || null };
          return { merged: false, state: pr?.state || null };
        } catch (err) {
          if (gone(err)) return { merged: false, gone: true };
          throw err;
        }
      },
    },

    // A sync with main (services/sync-main.js runSyncWork): the worker turn
    // as a durable step over this item's checkpoint, so a restart follows
    // the turn the worker still runs and then does what comes after it.
    [WORK.sync]: {
      resumable: true,
      maxAttempts: 2,
      maxLostAttempts: 20,
      leaseMs: 120000,
      concurrency: 4,
      async run(ctx): Promise<Json> {
        const { input, signal } = ctx;
        const durableSteps = legacy('services/durable-steps');
        const steps = durableSteps.durable({
          resumeFrom: ctx.resumeFrom, checkpoint: ctx.checkpoint, signal, attempt: ctx.attempt,
          lostAttempts: ctx.lostAttempts || 0, owner: `proposal/sync:${input.sessionId}:${input.n}`,
        });
        const out = await legacy('services/sync-main').runSyncWork(config, pool, {
          sessionId: Number(input.sessionId), reason: String(input.reason), measureFirst: !!input.measureFirst, steps,
        });
        await steps.flush();
        steps.fence();
        return JSON.parse(JSON.stringify(out)) as Json;
      },
    },

    // One of the Homeroom bot's proposals moved (up for a vote, closed): the
    // activity tray of whoever asked for it reads again.
    [WORK.bot]: {
      maxAttempts: 3,
      backoffMs: (n) => 30 * 1000 * n,
      async run({ input }): Promise<Json> {
        await legacy('services/homeroom-bot-dm').noteProposalChanged(pool, Number(input.sessionId));
        return { noted: true };
      },
    },
  };
}
