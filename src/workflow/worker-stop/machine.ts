import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Json, Outcome } from '../kernel/index.ts';
import { sameScope, sameTurn, stopTarget } from './target.ts';
import type { Target } from './target.ts';

export const MACHINE = 'worker-stop';
export const WORK = 'worker.force-stop';
export const WAIT_MS = 30_000;
export const stopKey = (sessionId: number, requestId: string) => `session:${sessionId}:stop:${requestId}`;
export interface Request extends Target { userId: number; requestId: string }
export interface Input extends Request { expiresAt: number }
export type Result = { ok: true; stopped: true; retained?: boolean } | { ok: false; code: string; message: string; status: number };
export const failure = (code = 'stop_unconfirmed', message = 'Could not confirm that the agent stopped. Retry Stop.', status = 503): Result =>
  ({ ok: false, code, message, status });
interface Facts { target: Input | null; reason: string | null }
type State = { name: typeof NONE | 'stopping'; data: null } | { name: 'done'; data: { result: Result } };
const done = (result: Result): Outcome<State> => ({ next: { name: 'done', data: { result } } });

type RequestOptions = { allowIdentityless?: boolean };
type SystemRequest = Omit<Request, 'userId'> & { userId: number | null };
export function requested(p: any, options: RequestOptions & { allowSystem: true }): SystemRequest;
export function requested(p: any, options?: RequestOptions): Request;
export function requested(p: any, { allowIdentityless = false, allowSystem = false }: RequestOptions & { allowSystem?: boolean } = {}): SystemRequest {
  for (const k of ['sessionId', 'userId']) {
    if (k === 'userId' && allowSystem && p?.userId === null) continue;
    if (!Number.isSafeInteger(p?.[k]) || p[k] < 1 || p[k] > 2147483647) throw new Error(`${k} must name a record`);
  }
  if ([p.appId, p.ownerId].some(v => v !== null && (!Number.isSafeInteger(v) || v < 1 || v > 2147483647))
      || !Number.isSafeInteger(p.configVersion) || p.configVersion < 0
      || typeof p.active !== 'boolean'
      || typeof p.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.requestId)
      || [p.turnId, p.journal, p.usedAt].some(v => v !== null && (typeof v !== 'string' || !v || v.length > 512))
      || (!allowIdentityless && p.active && !p.turnId && !p.journal)) throw new Error('A stop must identify the captured job and request');
  return { sessionId: p.sessionId, userId: p.userId, ownerId: p.ownerId, appId: p.appId,
    configVersion: p.configVersion, active: p.active, turnId: p.turnId, journal: p.journal, usedAt: p.usedAt,
    requestId: p.requestId };
}

export function workerStop() {
  const failed = { to: () => done(failure()) };
  return defineMachine<State, Facts>({
    name: MACHINE, version: 1, retainDays: 1, events: { Requested: requested }, create: ['Requested'], terminal: ['done'],
    decode: row => ({ name: row.state, data: row.data }) as State,
    async facts(tx, _s, e, ctx) {
      if (e.type !== 'Requested') return { target: null, reason: null };
      const p = e.payload;
      if (ctx.key !== stopKey(p.sessionId, p.requestId) || ctx.appId !== p.appId) return { target: null, reason: 'scope_mismatch' };
      const current = await stopTarget(tx, p.sessionId, p.userId);
      if (!sameScope(current, p)) return { target: null, reason: 'not_authorized' };
      // The captured job ending is harmless; it never retargets the worker
      // of a later job. The handler returns success without runtime I/O.
      if (!sameTurn(current, p) && !(p.active && !current.active)) return { target: null, reason: 'turn_changed' };
      return { target: { ...p, expiresAt: ctx.now.getTime() + WAIT_MS }, reason: null };
    },
    authorize: { Requested: (e, f) => e.source.kind !== 'route' || e.source.name !== WORK || e.actor !== `user:${e.payload.userId}`
      ? reject('not_a_producer') : f.reason ? reject(f.reason) : ok() },
    transitions: {
      [NONE]: { Requested: { to: (_s, _e, f) => ({ next: { name: 'stopping', data: null },
        work: [{ kind: WORK, key: 'stop', input: f.target! as unknown as Json }] }) } },
      stopping: { Requested: { ignore: 'already_requested' },
        WorkSucceeded: { to: (_s, e) => done(e.payload.result as Result) }, WorkFailed: failed, WorkExhausted: failed },
      done: { '*': { ignore: 'done' } },
    },
  });
}
