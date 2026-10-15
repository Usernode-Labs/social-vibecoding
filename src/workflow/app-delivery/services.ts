// app-delivery's I/O: the deploy. Durable work, reported back as an event;
// safe to run again after a crash, which is what a retried work item does.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { missingSecrets, permanent } from '../work-errors.ts';
import { WORK } from './machine.ts';

interface Deps { config: any; pool: Pool }

export function appDeliveryServices({ config, pool }: Deps): Record<string, WorkHandler> {
  return {
    // Production of the app, from main's tip as it is now
    // (staging.deployProduction, under the cross-process build lock). A
    // retry after a crash that had already deployed a merge's own commit
    // finds it running and healthy, and deploys nothing (`revision`).
    // Missing keys are an answer, not an error to retry: the machine tells
    // whoever asked which keys.
    [WORK.deploy]: {
      maxAttempts: 3,
      backoffMs: (attempt) => 60 * 1000 * 2 ** (attempt - 1),
      leaseMs: 120000,
      concurrency: 2,
      async run({ input }): Promise<Json> {
        const { rows: [row] } = await pool.query('SELECT * FROM apps WHERE id = $1', [input.appId]);
        if (!row) throw permanent('the app no longer exists');
        if (row.self_hosted) throw permanent('the platform is released by its own pipeline');
        let reuseImage = null;
        if (input.reuse) {
          // Demo mode: the preview image, when its tree is the merged tree.
          const github = legacy('services/github');
          const treeSha = await github.getCommitTree(input.reuse.owner, input.reuse.repo, input.reuse.commitSha).catch(() => null);
          if (treeSha) reuseImage = { imageRef: input.reuse.imageRef, buildRef: input.reuse.buildRef, treeSha, fromSha: input.reuse.commitSha };
        }
        try {
          const result = await legacy('services/staging').deployProduction(config, row, {
            ...(input.revision ? { reuseRunningRevision: input.revision } : {}),
            ...(reuseImage ? { reuseImage } : {}),
          });
          return { sha: result.sha || null, imageReused: !!result.imageReused, recovered: !!result.recovered };
        } catch (err) {
          if (missingSecrets(err)) {
            return { failed: 'missing_secrets', message: (err as Error).message,
              missingSecrets: Array.isArray((err as any).missingSecrets) ? (err as any).missingSecrets.map(String) : [] };
          }
          throw err;
        }
      },
    },
  };
}
