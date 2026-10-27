// The copy is best-effort; using a partial copy is not. Both sessions remain
// reserved until a successful publication or confirmed cleanup. Publication
// and the machine's completion commit together, including after a restart.
import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Json, Outcome, TransitionContext } from '../kernel/index.ts';
import { eligible } from './target.ts';
import type { Request, Target } from './target.ts';

export const MACHINE = 'worker-memory-copy';
export const WORK = 'worker.memory-copy';
export const WAIT_MS = 300_000;
export const copyKey = (id: number) => `session:${id}`;
type Data = { target: Target; cleanup: number; result?: Json };
type State = { name: typeof NONE | 'copying' | 'cleaning' | 'waiting_cleanup' | 'done'; data: Data | null };
type Facts = { allowed: boolean };
const requested = (p: any): Request => {
  for (const k of ['sourceId', 'sessionId', 'appId', 'userId']) {
    if (!Number.isSafeInteger(p?.[k]) || p[k] < 1 || p[k] > 2147483647) throw new Error('A memory copy must name its sessions and actor');
  }
  if (p.sourceId === p.sessionId || (p.sourceOwnerId !== null && (!Number.isSafeInteger(p.sourceOwnerId) || p.sourceOwnerId < 1 || p.sourceOwnerId > 2147483647))
      || [p.sourceVersion, p.configVersion].some(v => !Number.isSafeInteger(v) || v < 0)
      || typeof p.ccSessionId !== 'string' || !p.ccSessionId || p.ccSessionId.length > 200
      || typeof p.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.requestId)) throw new Error('Invalid memory copy identity');
  return { sourceId: p.sourceId, sessionId: p.sessionId, appId: p.appId, userId: p.userId, sourceOwnerId: p.sourceOwnerId,
    sourceVersion: p.sourceVersion, configVersion: p.configVersion, ccSessionId: p.ccSessionId, requestId: p.requestId };
};
const work = (data: Data, action: 'copy' | 'cleanup'): Outcome<State> => ({
  next: { name: action === 'copy' ? 'copying' : 'cleaning', data }, timer: null,
  work: [{ kind: WORK, key: `${action}:${data.cleanup}`, input: { target: data.target, action } as unknown as Json }],
});
const cleanup = (s: State) => work({ ...s.data!, cleanup: s.data!.cleanup + 1 }, 'cleanup');
const retryCleanup = (s: State, ctx: TransitionContext): Outcome<State> => ({
  next: { name: 'waiting_cleanup', data: s.data }, timer: { at: new Date(ctx.now.getTime() + 15000), event: { type: 'Clean', payload: {} } },
});
const done = (s: State, copied: boolean): Outcome<State> => ({ next: { name: 'done', data: { ...s.data!, result: { copied } } }, timer: null });

export function workerMemoryCopy() {
  return defineMachine<State, Facts>({ name: MACHINE, version: 1, retainDays: 1, create: ['Requested'], terminal: ['done'],
    events: { Requested: requested, Clean: () => ({}) }, decode: row => ({ name: row.state, data: row.data }) as State,
    async facts(tx, s, e, ctx) {
      if (e.type === 'Requested') return { allowed: ctx.key === copyKey(e.payload.sessionId)
        && ctx.appId === e.payload.appId && await eligible(tx, e.payload, true) };
      return { allowed: s.name === 'copying' && e.type === 'WorkSucceeded' && e.payload.result?.copied === true
        && ctx.now.getTime() < s.data!.target.expiresAt && await eligible(tx, s.data!.target, true) };
    },
    authorize: {
      Requested: (e, f) => e.source.kind !== 'route' || e.source.name !== WORK || e.actor !== `user:${e.payload.userId}`
        ? reject('not_a_producer') : f.allowed ? ok() : reject('copy_not_allowed'),
      Clean: e => e.source.kind === 'timer' ? ok() : reject('not_a_timer'),
    },
    transitions: {
      [NONE]: { Requested: { to: (_s, e, _f, ctx) => work({ target: { ...e.payload, expiresAt: ctx.now.getTime() + WAIT_MS }, cleanup: 0 }, 'copy') } },
      copying: { Requested: { ignore: 'already_requested' }, Clean: { ignore: 'not_waiting' },
        WorkSucceeded: { to: (s, _e, f) => f.allowed
          ? { ...done(s, true), writes: [{ type: 'publish', target: s.data!.target as unknown as Json }] } : cleanup(s) },
        WorkFailed: { to: cleanup }, WorkExhausted: { to: cleanup },
      },
      cleaning: { Requested: { ignore: 'already_requested' }, Clean: { ignore: 'not_waiting' },
        WorkSucceeded: { to: (s, e, _f, ctx) => e.payload.result?.cleaned === true ? done(s, false) : retryCleanup(s, ctx) },
        WorkFailed: { to: (s, _e, _f, ctx) => retryCleanup(s, ctx) }, WorkExhausted: { to: (s, _e, _f, ctx) => retryCleanup(s, ctx) },
      },
      waiting_cleanup: { Requested: { ignore: 'already_requested' }, Clean: { to: cleanup } },
      done: { '*': { ignore: 'done' } },
    },
    writes: { publish: async (tx, w) => {
      // eligible() locked both session rows in this transition. The
      // conversation id is never published by the route or the I/O handler.
      await tx.query('UPDATE chat_sessions SET cc_session_id = $2 WHERE id = $1', [w.target.sessionId, w.target.ccSessionId]);
    } },
  });
}
