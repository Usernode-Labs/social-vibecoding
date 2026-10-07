// The governance machine's I/O: work handlers (durable, reported back as
// events) and notifiers (post-commit pushes and kicks, allowed to be lost).

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { backoff, closeAndComment, gone, permanent } from '../github-work.ts';

interface Deps { config: any; pool: Pool }

export function governanceServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const github = () => legacy('services/github');
  return {
    // Close a GitHub issue, then comment on it (github-work.ts), then keep
    // the open-issues list from showing it again.
    'github.closeIssue': {
      maxAttempts: 6,
      backoffMs: backoff,
      async run(ctx): Promise<Json> {
        const { input } = ctx;
        const done = await closeAndComment(ctx, (gh, owner, repo, number) => gh.closeIssue(owner, repo, number));
        if ((done as { gone?: boolean }).gone) return done;
        const gh = github();
        if (input.bustCache) {
          // Keep the eventually consistent open-issues list from showing it again.
          gh.noteIssuesClosed(input.owner, input.repo, [input.number]);
          gh.invalidateIssuesCache(input.owner, input.repo);
          legacy('services/ws').pushIssueUpdate({
            action: 'github_synced', appSlug: input.appSlug, appId: input.appId, source: 'close_issue_vote',
          });
        }
        return { closed: true };
      },
    },

    // A secret change reaches the running app by a production rebuild.
    'app.rebuildProduction': {
      maxAttempts: 3,
      backoffMs: backoff,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [input.appId]);
        if (!app) return { skipped: 'no_app' };
        if (app.self_hosted) return { skipped: 'self_hosted' };
        const result = await legacy('services/staging').rebuildProduction(config, app);
        if (result) {
          await pool.query(
            `UPDATE apps SET container_id = $1, main_sha = $2, status = 'running', last_deploy_at = NOW()
              WHERE id = $3`,
            [result.containerId, result.sha || null, input.appId]);
        }
        return { containerId: result?.containerId ?? null };
      },
    },

    // Whether a close proposal's target is still open on GitHub. A target
    // closed by hand there is announced by nothing else.
    'governance.checkTarget': {
      maxAttempts: 3,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const gh = github();
        if (!gh.isEnabled()) throw permanent('GitHub is not configured');
        try {
          const issue = await gh.getIssue(input.owner, input.repo, input.number);
          return { open: issue?.state === 'open' };
        } catch (err) {
          if (gone(err)) return { open: false };
          throw err;
        }
      },
    },
  };
}

export function governanceNotifiers({ config, pool }: Deps): Record<string, (n: any) => Promise<void> | void> {
  const ws = () => legacy('services/ws');
  const strip = ({ type, ...rest }: any) => rest;
  return {
    issueUpdate: (n) => ws().pushIssueUpdate(strip(n)),
    appUpdate: (n) => ws().pushAppUpdate(strip(n)),
    // The thread lines the transition wrote, broadcast as sendSystemMessage would.
    async chat(n) {
      const { rows } = await pool.query(
        `SELECT id, content, msg_type, thread_type, thread_ref, created_at
           FROM chat_messages
          WHERE app_id = $1 AND (thread_type, thread_ref) IN (SELECT * FROM unnest($2::text[], $3::int[]))
            AND metadata->>'wfEvent' = $4
          ORDER BY id`,
        [n.appId, n.threads.map((t: any) => t.type), n.threads.map((t: any) => t.ref), String(n.eventId)]);
      for (const r of rows) {
        ws().broadcast(n.appId, {
          type: 'chat', id: r.id, userId: null, username: null, content: r.content, msgType: r.msg_type,
          thread: { type: r.thread_type, ref: r.thread_ref }, createdAt: r.created_at,
        });
      }
    },
    scoreVote: () => legacy('services/topochain/challenge-scorer').scoreOnVote(pool, config),
    // The campaign row is committed as `running`; the engine resumes running
    // campaigns at boot, so this kick may be lost to a crash and nothing else.
    async startCampaign(n) {
      const { rows: [c] } = await pool.query(
        'SELECT id FROM maintenance_campaigns WHERE issue_id = $1 ORDER BY id DESC LIMIT 1', [n.issueId]);
      if (c) await legacy('services/fleet-maintenance').runCampaign(config, pool, c.id);
    },
  };
}
