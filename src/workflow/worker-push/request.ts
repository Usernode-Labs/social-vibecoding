import { randomUUID } from 'node:crypto';
import type { Queryable, Runtime } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { MACHINE, WORK, WAIT_MS, failure, inactive, pushKey, sessionTarget } from './machine.ts';
import type { Failure, Result } from './machine.ts';

function failed(result: Failure): never {
  throw Object.assign(new Error(result.message), { code: result.code, userMessage: result.detail,
    permanent: result.permanent, httpStatus: result.status, sessionStatus: result.sessionStatus });
}
export async function requestWorkerPush(runtime: Runtime, db: Queryable, p: { sessionId: number; branchName?: string }, waitMs = WAIT_MS) {
  const session = await sessionTarget(db, p.sessionId).catch(() => failed(failure('db_error', 'Session lookup failed.', 500)));
  if (!session) failed(failure('session_not_found', 'Session no longer exists.', 404, true));
  if (!session.branch_name) failed(failure('no_branch', 'This session has no branch yet.', 400, true));
  if (session.anonymised_at || inactive(session.status)) {
    failed({ ...failure('session_inactive', 'Session is inactive.', 409, true), sessionStatus: session.status });
  }
  const branchName = p.branchName ?? session.branch_name;
  if (!legacy('services/branch-names').isValidBranchName(branchName)) {
    failed({ ok: false, code: 'bad_branch', message: `Invalid branch name: ${branchName}`,
      detail: 'Start a new session on this app, or ask an admin to rename this branch.', permanent: true, status: 502 });
  }
  const requestId = randomUUID();
  const key = pushKey(p.sessionId, requestId);
  const out = await runtime.appendAndWait(MACHINE, key, {
    type: 'Requested', payload: { sessionId: p.sessionId, branchName, requestId },
  }, { appId: session.app_id, source: { kind: 'route', name: WORK }, requestKey: requestId });
  const settled = out.status === 'pending'
    ? (await runtime.refuseIfPending(out.eventId, 'push_unavailable')) ?? out : out;
  if (settled.status !== 'accepted' && settled.status !== 'replayed') {
    const permanent = settled.status === 'rejected' && settled.reason !== 'push_unavailable';
    failed(failure(settled.reason || 'push_unavailable', 'The conductor did not accept this push. Retry the push.',
      permanent ? 409 : 503, permanent));
  }
  const done = await runtime.waitFor(MACHINE, key, i => i.state === 'done', waitMs);
  if (done?.state !== 'done' || !done.data?.result) {
    failed(failure('push_pending', 'The conductor has not completed this push. Retry the push.', 503));
  }
  const result = done.data.result as Result;
  if (!result.ok) failed(result);
  return { sha: result.sha, branch: branchName, stderr: '' };
}
