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
    // Missing keys, and an image that runs as root, are answers, not errors
    // to retry: the same commit fails the same way every time, and the
    // machine tells whoever asked why. A deploy asked for by hand
    // (`retrySameCommit`) still tries a commit refused for running as root.
    // An app deleted while it deployed keeps no runtime.
    // At most four deploys at a time, of four different apps (the machine
    // runs one per app).
    [WORK.deploy]: {
      maxAttempts: 3,
      backoffMs: (attempt) => 60 * 1000 * 2 ** (attempt - 1),
      leaseMs: 120000,
      concurrency: 4,
      async run({ input }): Promise<Json> {
        const { rows: [row] } = await pool.query('SELECT * FROM apps WHERE id = $1', [input.appId]);
        if (!row) throw permanent('the app no longer exists');
        if (row.self_hosted) throw permanent('the platform is released by its own pipeline');
        let reuseImage = null;
        // A project's first deploy: the starter commit its setup made
        // (staging.deployProduction `starter`).
        const starter = input.reuse?.starter ?? null;
        if (input.reuse && !starter) {
          // Demo mode: the preview image, when its tree is the merged tree.
          const github = legacy('services/github');
          const treeSha = await github.getCommitTree(input.reuse.owner, input.reuse.repo, input.reuse.commitSha).catch(() => null);
          if (treeSha) reuseImage = { imageRef: input.reuse.imageRef, buildRef: input.reuse.buildRef, treeSha, fromSha: input.reuse.commitSha };
        }
        const deployFailure = legacy('services/deploy-failure');
        try {
          const result = await legacy('services/staging').deployProduction(config, row, {
            ...(input.revision ? { reuseRunningRevision: input.revision } : {}),
            ...(reuseImage ? { reuseImage } : {}),
            ...(input.retrySameCommit ? { retrySameCommit: true } : {}),
            ...(starter ? { starter } : {}),
          });
          return { sha: result.sha || null, imageReused: !!result.imageReused, recovered: !!result.recovered,
            url: result.url || null, ...(result.timing ? { timing: result.timing } : {}) };
        } catch (err) {
          if (missingSecrets(err)) {
            return { failed: 'missing_secrets', message: (err as Error).message,
              missingSecrets: Array.isArray((err as any).missingSecrets) ? (err as any).missingSecrets.map(String) : [] };
          }
          if ((err as Error)?.name === 'WaitsForNewCommitError' || deployFailure.isRootImageRefusal(err)) {
            return { failed: 'root_image', message: deployFailure.ROOT_IMAGE_FIX };
          }
          throw err;
        } finally {
          await legacy('services/app-teardown').removeRuntimeIfDeleted(config, pool, row, { who: 'deploy' });
        }
      },
    },
    // A heal (services/app-heal.js heal): the cheapest cure, or
    // `needs_deploy`, which the machine answers with a deploy. Not tried
    // again here: a heal that throws did not cure, and the machine's backoff
    // decides when the next report heals. A restart waits up to five minutes
    // for its rollout; a process that stops gives it up (the next report
    // heals it again).
    [WORK.heal]: {
      maxAttempts: 1,
      leaseMs: 120000,
      concurrency: 4,
      async run({ input, signal }): Promise<Json> {
        return legacy('services/app-heal').heal(config, pool, Number(input.appId), {
          probe: input.probe === true, via: String(input.via || 'sweep'), signal,
        });
      },
    },
  };
}
