// The governance machine's I/O: work handlers (durable, reported back as
// events) and notifiers (post-commit kicks, allowed to be lost). What
// browsers hear is a push the transition publishes (../pushes.ts).

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { backoff, closeAndComment, gone, permanent } from '../github-work.ts';

interface Deps { config: any; pool: Pool }

export function governanceServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const github = () => legacy('services/github');
  return {
    // Close a GitHub issue, then comment on it (github-work.ts), then keep
    // the open-issues list from showing it again (the transition that
    // applies the result tells browsers to re-read it).
    'github.closeIssue': {
      maxAttempts: 6,
      backoffMs: backoff,
      async run(ctx): Promise<Json> {
        const { input } = ctx;
        const done = await closeAndComment(ctx, (gh, owner, repo, number) => gh.closeIssue(owner, repo, number));
        if ((done as { gone?: boolean }).gone) return done;
        const gh = github();
        if (input.bustCache) {
          gh.noteIssuesClosed(input.owner, input.repo, [input.number]);
          gh.invalidateIssuesCache(input.owner, input.repo);
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
  return {
    boardChange: (n) => legacy('services/ws').noteBoardChange({ appId: n.appId, appSlug: n.appSlug }),
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
