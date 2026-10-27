import type { Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { WORK, failure, inactive, sessionTarget } from './machine.ts';
import type { Result, Target } from './machine.ts';

export function workerPushServices({ pool }: { pool: Pool }): Record<string, WorkHandler> {
  return { [WORK]: {
    // A retry by the worker is explicit. Recovered claims also recheck the
    // deadline and target before touching a worker or fetching a credential.
    maxAttempts: 1, concurrency: 4, leaseMs: 120_000,
    async run(ctx): Promise<Result> {
      const { processRole, runsWorkflow } = legacy('services/process-role');
      if (!runsWorkflow(processRole())) throw new Error('Worker pushes require a workflow process');
      const target = ctx.input as unknown as Target;
      if (Date.now() >= target.expiresAt) return failure('push_expired', 'Push request expired. Retry the push.', 503);
      const current = await sessionTarget(pool, target.sessionId);
      if (!current) return failure('session_not_found', 'Session no longer exists.', 404, true);
      if (current.anonymised_at || inactive(current.status)) return failure('session_inactive', 'Session is inactive.', 409, true);
      if (current.app_id !== target.appId || current.branch_name !== target.branchName || current.repo_url !== target.repoUrl) {
        return failure('session_changed', 'The session push target changed. Retry the push.', 409, true);
      }
      const parsed = legacy('services/repo-ref').ownerRepo(current.repo_url);
      if (!parsed) return failure('bad_repo_url', 'Invalid repository address.', 400, true);
      const privacy = await legacy('services/github').checkRepoPublic(parsed.owner, parsed.repo);
      if (!privacy.ok) return failure(privacy.code, privacy.message);
      if (privacy.private) return failure('private_repo', `${parsed.owner}/${parsed.repo} is private; Homeroom supports public repos only.`, 403, true);
      if (ctx.signal.aborted) throw new Error('Push work was stopped');
      if (Date.now() >= target.expiresAt) return failure('push_expired', 'Push request expired. Retry the push.', 503);
      try {
        const { sha } = await legacy('services/worker').execPushFromWorker(target.sessionId, target.branchName, {
          expectedRepoUrl: target.repoUrl, expectedAppId: target.appId,
        });
        return { ok: true, sha };
      } catch (err) {
        const e = err as Error & { code?: string; userMessage?: string; permanent?: boolean };
        return { ok: false, code: e.code || 'push_failed', message: e.message.slice(0, 2000),
          detail: e.userMessage?.slice(0, 2000) || null, permanent: e.permanent === true, status: 502 };
      }
    },
  } };
}
