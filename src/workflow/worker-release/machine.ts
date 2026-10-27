// Worker removal requested by a promoted proposal's Pause. Each request is durable, including during a rollout:
// conductors from before this machine leave its events for the new build.
import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Json, Outcome } from '../kernel/index.ts';

export const MACHINE = 'worker-release';
export const WORK = 'worker.release';
export const releaseKey = (sessionId: number, requestId: string) => `session:${sessionId}:release:${requestId}`;
export interface Request {
  sessionId: number; appId: number; userId: number; configVersion: number;
  reason: 'promoted-pause'; turnId?: string | null;
}
export interface Target extends Request { requestedAt: string }
interface Facts { target: Target | null; refusal: string | null }
type State = { name: typeof NONE | 'queued'; data: null } | { name: 'done' | 'failed'; data: Json };
const ended = (name: 'done' | 'failed', data: Json): Outcome<State> => ({ next: { name, data } });
function requested(p: any) {
  for (const k of ['sessionId', 'appId', 'userId']) {
    if (!Number.isSafeInteger(p?.[k]) || p[k] < 1 || p[k] > 2147483647) throw new Error(`${k} must name a record`);
  }
  if (!Number.isSafeInteger(p.configVersion) || p.configVersion < 0
      || p.reason !== 'promoted-pause'
      || typeof p.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.requestId)
      || (p.turnId != null && (typeof p.turnId !== 'string' || !p.turnId || p.turnId.length > 200))) {
    throw new Error('A worker release must name its reason, configuration and request');
  }
  return { sessionId: p.sessionId, appId: p.appId, userId: p.userId, configVersion: p.configVersion,
    reason: p.reason, turnId: p.turnId ?? null, requestId: p.requestId };
}
export function workerRelease() {
  const failed = { to: () => ended('failed', { failed: true }) };
  return defineMachine<State, Facts>({
    name: MACHINE, version: 1, retainDays: 1,
    events: { Requested: requested }, create: ['Requested'], terminal: ['done', 'failed'],
    decode: row => ({ name: row.state, data: row.data }) as State,
    async facts(tx, _state, e, ctx) {
      if (e.type !== 'Requested') return { target: null, refusal: null };
      const p = e.payload;
      if (ctx.key !== releaseKey(p.sessionId, p.requestId) || ctx.appId !== p.appId) return { target: null, refusal: 'scope_mismatch' };
      const { rows: [s] } = await tx.query(
        `SELECT cs.app_id, cs.user_id, cs.status, cs.agent_config_version, u.anonymised_at,
                cs.active_turn->>'turnId' AS turn_id,
                e.created_at::text AS requested_at
           FROM chat_sessions cs JOIN users u ON u.id = cs.user_id JOIN wf_events e ON e.id = $2
          WHERE cs.id = $1`, [p.sessionId, e.id]);
      if (!s || s.app_id !== p.appId || s.user_id !== p.userId || s.anonymised_at) return { target: null, refusal: 'not_owner' };
      if (s.agent_config_version !== p.configVersion) return { target: null, refusal: 'configuration_changed' };
      if (s.status !== 'promoted' || (s.turn_id != null && s.turn_id !== p.turnId)) return { target: null, refusal: 'session_changed' };
      return { target: { sessionId: p.sessionId, appId: p.appId, userId: p.userId, reason: p.reason,
        configVersion: p.configVersion, turnId: p.turnId, requestedAt: s.requested_at }, refusal: null };
    },
    authorize: { Requested: (e, f) =>
      (e.source.kind !== 'route' || e.source.name !== WORK || e.actor !== `user:${e.payload.userId}`)
        ? reject('not_a_producer') : f.refusal ? reject(f.refusal) : ok() },
    transitions: {
      [NONE]: { Requested: { to: (_s, _e, f) => ({ next: { name: 'queued', data: null },
        work: [{ kind: WORK, key: 'release', input: f.target! as unknown as Json }] }) } },
      queued: {
        Requested: { ignore: 'already_requested' },
        WorkSucceeded: { to: (_s, e) => ended('done', e.payload.result ?? null) },
        WorkFailed: failed, WorkExhausted: failed,
      },
      done: { '*': { ignore: 'done' } }, failed: { '*': { ignore: 'failed' } },
    },
  });
}
