// Privileged operations a web process asks a conductor to run
// (docs/plans/web-and-conductor.md, "Privileged operations"). One machine for
// every typed operation, so a code-host or provider write never needs its
// own: the route keeps the checks and refusals it always had and appends the
// request; the conductor's work rechecks the requester's current authority
// and target before any outside write and keeps each write as a step, so a
// retry or a restart finishes the same request instead of repeating it.
import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Json, Outcome } from '../kernel/index.ts';

export const MACHINE = 'platform-operation';
export const WORK = 'operation.run';
// The operations services/platform-operations.js runs, by name.
export const OPERATIONS: ReadonlySet<string> = new Set([
  'manifest.propose', 'branch.ensure', 'revert.open', 'domain.check', 'domain.teardown', 'app.remove',
  'openrouter.provision', 'openrouter.sync', 'openrouter.disable', 'openrouter.remove',
  'previewProject.create', 'previewProject.build', 'previewProject.deploy', 'previewProject.restart', 'previewProject.remove',
]);
// What an operation's input may weigh: what a route captured, never a file.
export const MAX_INPUT_BYTES = 64 * 1024;
// One instance per request; an operation that must not run twice at once on
// the same target (an Undo of one change) has one instance per target, so a
// second request while one is under way is the same request, and a new one
// starts once it has finished. Such an operation is only appended, never
// waited for by key (platform.ts appendOperation).
const SINGLE_FLIGHT: ReadonlyMap<string, (input: any) => string> = new Map([
  ['revert.open', (input: any) => `session:${input.sessionId}`],
]);
export const operationKey = (p: { op: string; requestId: string; input: any }) => {
  const target = SINGLE_FLIGHT.get(p.op);
  return target ? `op:${p.op}:${target(p.input)}` : `op:${p.requestId}`;
};
export const singleFlight = (op: string) => SINGLE_FLIGHT.has(op);
// Each operation is its own work kind, so a conductor claims only the ones
// its build knows: during a rollout an older conductor leaves a newer one's
// operation for a newer conductor instead of failing it.
export const workKind = (op: string) => `operation.${op}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Request { op: string; requestId: string; appId: number | null; userId: number; input: Json }
interface Facts { refusal: string | null }
type State = { name: typeof NONE | 'queued'; data: null } | { name: 'done' | 'failed'; data: Json };
const ended = (name: 'done' | 'failed', data: Json): Outcome<State> => ({ next: { name, data } });
const id = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 2147483647;

// An operation's name: `area.verb`. One this build does not know is still a
// request: its work is a kind of its own (workKind), which only a conductor
// that knows it claims, so during a rollout an older conductor leaves a newer
// operation queued instead of refusing it.
const OP_NAME = /^[a-z][A-Za-z]{0,31}\.[a-z][A-Za-z]{0,31}$/;

export function requested(p: any): Request {
  if (typeof p?.op !== 'string' || !OP_NAME.test(p.op)) throw new Error('An operation must name its kind');
  if (typeof p.requestId !== 'string' || !UUID.test(p.requestId)) throw new Error('An operation must name its request');
  if (!id(p.userId) || (p.appId !== null && !id(p.appId))) throw new Error('An operation must name its requester and project');
  if (!p.input || typeof p.input !== 'object' || Array.isArray(p.input)
      || JSON.stringify(p.input).length > MAX_INPUT_BYTES) throw new Error('An operation must carry its input');
  if (p.op === 'revert.open' && !id(p.input.sessionId)) throw new Error('An Undo must name its change');
  if (p.op.startsWith('previewProject.') && (!id(p.input.sessionId) || !Number.isSafeInteger(p.input.projectId) || p.input.projectId < 1)) {
    throw new Error('A preview project\'s operation must name its preview and project');
  }
  return { op: p.op, requestId: p.requestId, appId: p.appId, userId: p.userId, input: p.input };
}

export function platformOperation() {
  const failed = { to: (_s: State, e: any) => ended('failed', { error: e.payload?.error ?? null }) };
  // The work item is the request's own, so a target's next request is a new one.
  const start = { to: (_s: State, e: any) => ({ next: { name: 'queued' as const, data: null },
    work: [{ kind: workKind(e.payload.op), key: `run:${e.payload.requestId}`, input: e.payload as unknown as Json }] }) };
  return defineMachine<State, Facts>({
    name: MACHINE, version: 1, retainDays: 2,
    events: { Requested: requested }, create: ['Requested'], terminal: ['done', 'failed'],
    decode: row => ({ name: row.state, data: row.data }) as State,
    // Admission only proves the request is this instance's and its requester
    // and project still exist. Each operation's own authority is read again
    // by its work, immediately before the first outside write.
    async facts(tx, _state, e, ctx) {
      if (e.type !== 'Requested') return { refusal: null };
      const p = e.payload;
      if (ctx.key !== operationKey(p) || ctx.appId !== p.appId) return { refusal: 'scope_mismatch' };
      const { rows: [u] } = await tx.query('SELECT anonymised_at FROM users WHERE id = $1 FOR SHARE', [p.userId]);
      if (!u || u.anonymised_at) return { refusal: 'not_authorized' };
      if (p.appId !== null) {
        const { rows: [a] } = await tx.query('SELECT 1 FROM apps WHERE id = $1 FOR SHARE', [p.appId]);
        if (!a) return { refusal: 'not_found' };
      }
      return { refusal: null };
    },
    authorize: { Requested: (e, f) =>
      (e.source.kind !== 'route' || e.source.name !== WORK || e.actor !== `user:${e.payload.userId}`)
        ? reject('not_a_producer') : f.refusal ? reject(f.refusal) : ok() },
    transitions: {
      [NONE]: { Requested: start },
      queued: {
        Requested: { ignore: 'already_requested' },
        WorkSucceeded: { to: (_s, e) => ended('done', e.payload.result ?? null) },
        WorkFailed: failed, WorkExhausted: failed,
      },
      done: { Requested: start, '*': { ignore: 'done' } }, failed: { Requested: start, '*': { ignore: 'failed' } },
    },
  });
}
