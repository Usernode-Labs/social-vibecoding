// The campaign machine's work: one app's change. The AI's tool loop
// (services/fleet-maintenance.js runAppChange, its I/O core), the campaign's
// own branch for the app set to main and the staged files pushed as one
// commit, then its pull request, found before it is created. Each step is
// checkpointed once done, so a retry never pushes or opens twice, and a
// retry before the push runs the AI again (D5).

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { permanent } from '../work-errors.ts';
import { WORK } from './machine.ts';

export interface CampaignServiceDeps { config: any; pool: Pool }

// GitHub's and the model's temporary errors: 30 s doubling to half an hour,
// eight attempts (about an hour in all) before the app is failed with the
// error (D6).
const backoff = (attempt: number) => Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** (attempt - 1));

export function campaignServices({ pool }: CampaignServiceDeps): Record<string, WorkHandler> {
  return {
    [WORK.change]: {
      maxAttempts: 8,
      backoffMs: backoff,
      leaseMs: 120000,
      // A change interrupted by a release carries on from its checkpoint.
      resumable: true,
      async run({ input, resumeFrom, checkpoint, signal }): Promise<Json> {
        const fm = legacy('services/fleet-maintenance');
        const github = legacy('services/github');
        const llm = legacy('services/llm');
        const { rows: [c] } = await pool.query(
          'SELECT id, title, instructions FROM maintenance_campaigns WHERE id = $1', [input.campaignId]);
        if (!c) throw permanent('The campaign is gone');
        // A stop is read before the AI's every call, before the push and
        // before the pull request: what it had done by then stands.
        const stopped = async () => (await pool.query(
          'SELECT status FROM maintenance_campaigns WHERE id = $1', [input.campaignId])).rows[0]?.status === 'cancelled';
        const halted = { stopped: true };
        const { rows: [app] } = await pool.query('SELECT id, slug, name, repo_url FROM apps WHERE id = $1', [input.appId]);
        if (!app) throw permanent('The app is gone');
        const repo = fm.parseRepo(app.repo_url);
        if (!repo) throw permanent(`Unparseable repo_url: ${app.repo_url}`);
        if (!github.isEnabled()) throw permanent('GitHub is not configured on this platform');
        const userId = await fm.ensurePlatformUser(pool);

        let done = (resumeFrom && typeof resumeFrom === 'object' ? resumeFrom : {}) as any;
        if (!done.head) {
          if (!llm.isEnabled()) throw permanent('The model is not configured on this platform');
          let out: any;
          try {
            out = await fm.runAppChange({
              campaign: c, app, exemplarSummary: input.exemplar || null,
              stopped: async () => signal.aborted || await stopped(),
              onUsage: (usage: any, servedModel: any) => {
                legacy('services/limits').recordSpend(pool, userId, llm.estimateCostCents(usage, servedModel)).catch(() => {});
              },
            });
          } catch (err: any) {
            if (err?.code === 'campaign_stopped' && !signal.aborted) return halted;
            throw err;
          }
          if (out.skipped) return { skipped: true, reason: String(out.reason || 'not applicable') };
          if (await stopped()) return halted;
          // Still this item's: checked before anything reaches the repository.
          await checkpoint({});
          const head = await fm.pushChange({ repo, branch: input.branch, files: out.files, message: `Maintenance: ${c.title}` });
          done = { head, summary: out.summary || '' };
          await checkpoint(done);
        }
        if (!done.pr) {
          // The push's checkpoint just proved the claim, or this one does on
          // a resumed attempt: no pull request for a change a stop cancelled.
          if (resumeFrom) await checkpoint(done);
          if (await stopped()) return halted;
          const pr = await fm.openChangePr({ repo, branch: input.branch, campaign: c, summary: done.summary });
          done = { ...done, pr };
          await checkpoint(done);
        }
        return {
          changed: true, head: done.head, summary: done.summary, branch: input.branch, userId,
          prNumber: done.pr.number, prUrl: done.pr.url, prTitle: done.pr.title,
        };
      },
    },
  };
}
