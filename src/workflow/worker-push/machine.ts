// A worker asks for its session's branch to be pushed. Only the conductor
// performs worker exec and authenticated Git; the web process waits for its
// result. This is a migration seam, not authenticated producer provenance:
// source metadata still comes from trusted platform processes.
import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Json, Outcome, Queryable } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';

export const MACHINE = 'worker-push';
export const WORK = 'worker.push';
export const WAIT_MS = 80_000; // worker/usernode-push gives each HTTP call 90s
export const pushKey = (sessionId: number, requestId: string) => `session:${sessionId}:push:${requestId}`;
export interface Target { sessionId: number; appId: number; branchName: string; repoUrl: string; expiresAt: number }
export type Failure = {
  ok: false; code: string; message: string; detail: string | null; permanent: boolean; status: number;
  sessionStatus?: string;
};
export type Result = { ok: true; sha: string } | Failure;
export const failure = (code: string, message: string, status = 502, permanent = false): Failure =>
  ({ ok: false, code, message, detail: null, permanent, status });

export async function sessionTarget(db: Queryable, sessionId: number) {
  const { rows: [row] } = await db.query<{
    app_id: number; branch_name: string | null; repo_url: string; status: string; anonymised_at: Date | null;
  }>(`SELECT cs.app_id, cs.branch_name, cs.status, a.repo_url, u.anonymised_at
        FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id JOIN users u ON u.id = cs.user_id
       WHERE cs.id = $1`, [sessionId]);
  return row;
}
export const inactive = (status: string) => ['closed', 'archived', 'merged', 'failed'].includes(status);

function requested(p: any) {
  if (!Number.isSafeInteger(p?.sessionId) || p.sessionId < 1 || p.sessionId > 2147483647
      || typeof p.branchName !== 'string' || p.branchName.length > 512
      || !legacy('services/branch-names').isValidBranchName(p.branchName)
      || typeof p.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.requestId)) {
    throw new Error('A push must name a session, its branch and a request');
  }
  return { sessionId: p.sessionId as number, branchName: p.branchName as string, requestId: p.requestId as string };
}
type State = { name: typeof NONE | 'pushing'; data: null } | { name: 'done'; data: { result: Result } };
interface Facts { target: Target | null; reason: string | null }
const done = (result: Result): Outcome<State> => ({ next: { name: 'done', data: { result } } });

export function workerPush() {
  const failed = { to: () => done(failure('push_failed', 'The conductor could not complete this push. Retry the push.')) };
  return defineMachine<State, Facts>({
    name: MACHINE, version: 1, retainDays: 1,
    events: { Requested: requested }, create: ['Requested'], terminal: ['done'],
    decode: row => row.state === 'done' ? { name: 'done', data: row.data as { result: Result } }
      : { name: row.state as typeof NONE | 'pushing', data: null },
    async facts(tx, _state, event, ctx) {
      if (event.type !== 'Requested') return { target: null, reason: null };
      const p = event.payload;
      if (ctx.key !== pushKey(p.sessionId, p.requestId)) return { target: null, reason: 'push_scope_mismatch' };
      const row = await sessionTarget(tx, p.sessionId);
      if (!row || row.app_id !== ctx.appId) return { target: null, reason: 'session_not_found' };
      if (row.anonymised_at || inactive(row.status)) return { target: null, reason: 'session_inactive' };
      if (row.branch_name !== p.branchName) return { target: null, reason: 'session_changed' };
      return { target: { sessionId: p.sessionId, appId: row.app_id, branchName: p.branchName, repoUrl: row.repo_url,
        expiresAt: ctx.now.getTime() + WAIT_MS }, reason: null };
    },
    authorize: {
      Requested: (e, f) => e.source.kind !== 'route' || e.source.name !== WORK
        ? reject('push_source_required') : f.reason ? reject(f.reason) : ok(),
    },
    transitions: {
      [NONE]: { Requested: { to: (_s, _e, f) => ({
        next: { name: 'pushing', data: null },
        work: [{ kind: WORK, key: 'push', input: f.target! as unknown as Json }],
      }) } },
      pushing: {
        Requested: { ignore: 'already_requested' },
        WorkSucceeded: { to: (_s, e) => done(e.payload.result as Result) },
        WorkFailed: failed,
        WorkExhausted: failed,
      },
      done: { '*': { ignore: 'done' } },
    },
  });
}
