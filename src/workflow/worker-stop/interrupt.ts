// Separate from force-stop so an older conductor never interprets an
// ordinary Stop as a hard kill. One instance per actor and job coalesces
// duplicate clicks; a completed confirmation can be requested again.
import { randomUUID } from 'node:crypto';
import { NONE, appendEvent, canonicalHash, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Json, Outcome, Queryable, Runtime, TransitionContext } from '../kernel/index.ts';
import { STOP_CONFIRM_TIMEOUT_MS, STOP_PROBE_INTERVAL_MS, classifyStopProbe } from '../rules/worker-interrupt.ts';
import { requested } from './machine.ts';
import type { Request } from './machine.ts';
import { sameScope, sameTurn, snapshot, stopTarget } from './target.ts';
import { prepareStop, requireAcceptedStop } from './request.ts';
import type { StopRequest } from './request.ts';

export const MACHINE = 'worker-interrupt';
export const WORK = 'worker.interrupt';
export const DISPATCH = 'worker.dispatch';
export type Strategy = 'turn';
export type Interrupt = Omit<Request, 'userId'> & { userId: number | null; strategy: Strategy; by?: string | null };
export type Input = Interrupt & { expiresAt: number };
// Keep the retired fingerprint's null slot so keys match across rolling deploys.
export const interruptKey = (p: Interrupt) => `session:${p.sessionId}:interrupt:${canonicalHash([
  p.userId, p.appId, p.ownerId, p.configVersion, p.active, p.turnId, p.journal, null, p.active ? null : p.usedAt, p.strategy,
])}`;
type Data = { target: Input; attempts: number; result?: Json };
type State = { name: typeof NONE | 'signalling' | 'waiting' | 'probing' | 'done'; data: Data | null };
type Facts = { target: Input | null; reason: string | null };
const ended = (s: State, result: Json): Outcome<State> => ({ next: { name: 'done', data: { ...s.data!, result } }, timer: null });
function work(data: Data, action: 'signal' | 'probe'): Outcome<State> {
  return { next: { name: action === 'signal' ? 'signalling' : 'probing', data },
    timer: null, work: [{ kind: WORK, key: `${data.target.requestId}:${action}:${data.attempts}`,
      input: { target: data.target, action } as unknown as Json }] };
}
function wait(s: State, ctx: TransitionContext): Outcome<State> {
  if (ctx.now.getTime() >= s.data!.target.expiresAt) return ended(s, { confirmed: false, reason: 'giveup' });
  return { next: { name: 'waiting', data: s.data }, timer: {
    at: new Date(Math.min(ctx.now.getTime() + STOP_PROBE_INTERVAL_MS, s.data!.target.expiresAt)),
    event: { type: 'Tick', payload: { requestId: s.data!.target.requestId } },
  } };
}
function probed(s: State, out: any, ctx: TransitionContext): Outcome<State> {
  if (out?.done) return ended(s, out);
  const verdict = classifyStopProbe({ executing: out?.executing ?? null, attempts: s.data!.attempts,
    elapsedMs: ctx.now.getTime() - (s.data!.target.expiresAt - STOP_CONFIRM_TIMEOUT_MS) });
  return verdict === 'retry' ? work({ ...s.data!, attempts: s.data!.attempts + 1 }, 'signal')
    : ended(s, { confirmed: verdict === 'confirmed', reason: verdict });
}
export function workerInterrupt() {
  const start = { to: (_s: State, _e: any, f: Facts) => work({ target: f.target!, attempts: 1 }, 'signal') };
  const pending = { ignore: 'already_stopping' };
  return defineMachine<State, Facts>({
    name: MACHINE, version: 1, retainDays: 1, create: ['Requested'], terminal: ['done'],
    decode: row => ({ name: row.state, data: row.data }) as State,
    events: {
      Requested: (p: any) => {
        const r = requested(p, { allowSystem: true });
        if (r.active && !r.journal) throw new Error('An active ordinary stop must name its journal');
        if (p.strategy !== 'turn') throw new Error('A stop must name its strategy');
        if (p.by != null && (typeof p.by !== 'string' || p.by.length > 100)) throw new Error('A stopper must name a person');
        return { ...r, strategy: p.strategy, by: p.by ?? null };
      },
      Tick: (p: any) => ({ requestId: String(p?.requestId || '') }),
    },
    async facts(tx, _s, e, ctx) {
      if (e.type !== 'Requested') return { target: null, reason: null };
      const p = e.payload;
      if (ctx.key !== interruptKey(p) || ctx.appId !== p.appId) return { target: null, reason: 'scope_mismatch' };
      const current = await stopTarget(tx, p.sessionId, p.userId);
      if (!sameScope(current, p)) return { target: null, reason: 'not_authorized' };
      if (!sameTurn(current, p) && !(p.userId !== null && p.active && !current.active)) return { target: null, reason: 'turn_changed' };
      return { target: { ...p, expiresAt: ctx.now.getTime() + STOP_CONFIRM_TIMEOUT_MS }, reason: null };
    },
    authorize: {
      Requested: (e, f) => {
        const p = e.payload;
        if (e.source.kind === 'system' && e.source.name === DISPATCH) {
          // Internal cleanup is limited to this exact active, journalled turn.
          if (e.actor !== null || p.userId !== null || p.strategy !== 'turn'
              || !p.active || !p.turnId || !p.journal) return reject('not_a_producer');
        } else if (e.source.kind !== 'route' || e.source.name !== WORK || p.userId === null || e.actor !== `user:${p.userId}`) {
          return reject('not_a_producer');
        }
        return f.reason ? reject(f.reason) : ok();
      },
      Tick: e => e.source.kind === 'timer' ? ok() : reject('not_a_timer'),
    },
    transitions: {
      [NONE]: { Requested: start },
      signalling: { Requested: pending, Tick: { ignore: 'not_waiting' },
        WorkSucceeded: { to: (s, e, _f, ctx) => e.payload.result?.done ? ended(s, e.payload.result) : wait(s, ctx) },
        WorkFailed: { to: (s, _e, _f, ctx) => wait(s, ctx) }, WorkExhausted: { to: (s, _e, _f, ctx) => wait(s, ctx) } },
      waiting: { Requested: pending, Tick: {
        guard: (s, e) => s.data!.target.requestId === e.payload.requestId ? ok() : reject('old_timer'),
        to: s => work(s.data!, 'probe'),
      } },
      probing: { Requested: pending, Tick: { ignore: 'not_waiting' },
        WorkSucceeded: { to: (s, e, _f, ctx) => probed(s, e.payload.result, ctx) },
        WorkFailed: { to: (s, _e, _f, ctx) => probed(s, null, ctx) },
        WorkExhausted: { to: (s, _e, _f, ctx) => probed(s, null, ctx) },
      },
      done: { Requested: start, '*': { ignore: 'done' } },
    },
  });
}

type InterruptRequest = StopRequest & { strategy: Strategy };
async function prepareInterrupt(db: Queryable, p: InterruptRequest) {
  const current = await prepareStop(db, p);
  if (!current) return;
  if (current.active && !current.journal) {
    throw Object.assign(new Error('The running job has no safe stop identity.'), { code: 'turn_changed', httpStatus: 409 });
  }
  const payload: Interrupt = { ...snapshot(current), userId: p.userId, requestId: randomUUID(), strategy: p.strategy };
  return { payload, options: { appId: current.appId, actor: `user:${p.userId}`, source: { kind: 'route' as const, name: WORK }, requestKey: payload.requestId } };
}
export async function requestWorkerInterrupt(runtime: Runtime, db: Queryable, p: InterruptRequest) {
  const prepared = await prepareInterrupt(db, p);
  if (!prepared) return;
  const { payload, options } = prepared;
  const out = await runtime.appendAndWait(MACHINE, interruptKey(payload), { type: 'Requested', payload }, options);
  await requireAcceptedStop(runtime, out, { allowCoalesced: true });
}
// The dispatcher's spin-up backstop is a system command, independent of human
// click coalescing (userId:null gives it a separate key). Append only: its own
// turn must never wait for another work item's result.
export async function appendWorkerInterrupt(db: Queryable, p: { sessionId: number; turnId: string; journal: string; by?: string | null }) {
  if (!p.turnId || !p.journal) throw new Error('Dispatch confirmation requires a turn id and journal');
  const current = await prepareStop(db, { sessionId: p.sessionId, userId: null,
    expectedJob: { active: true, turnId: p.turnId, journal: p.journal } });
  if (!current) return null;
  const payload: Interrupt = { ...snapshot(current), requestId: randomUUID(), strategy: 'turn', by: p.by ?? null };
  return appendEvent(db, MACHINE, interruptKey(payload), { type: 'Requested', payload }, {
    appId: current.appId, actor: null, source: { kind: 'system', name: DISPATCH }, requestKey: payload.requestId,
  });
}
