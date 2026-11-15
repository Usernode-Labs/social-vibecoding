// turn: a coding record nothing carries, taken to an end as workflow work.
// One instance per change, `session:<id>`.
//
// Every coding run belongs to the work that dispatched it, which carries it
// on when its process goes. A record whose work settled without letting it
// go is asked a `recover` turn (services/turn-leftovers.js): one work item,
// `turn.run`, that takes the record through the adoption in whichever
// workflow process claims it (services/turns.js, services/turn-recovery.js).
// A process that goes takes only the item's lease: the next one claims the
// item and runs the recovery again.
//
// A turn asked for while one runs waits its turn.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, State, TransitionContext, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { sessionState } from '../pushes.ts';
import type { SessionStateRow } from '../pushes.ts';
import { workedOnSql } from '../session-work.ts';

export const MACHINE = 'turn';
export const WORK = Object.freeze({ run: 'turn.run' });
export const KINDS = Object.freeze(['recover'] as const);
export type Kind = typeof KINDS[number];

// The longest a turn may run, whatever it waits on: past it, its run is
// cancelled.
export const MAX_TURN_MS = 6 * 60 * 60 * 1000;

const KEY = /^session:[1-9][0-9]{0,12}$/;
const TURN_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

export function sessionKey(sessionId: number): string { return `session:${Number(sessionId)}`; }

interface Turn { turnId: string; kind: Kind; input: Json }
export interface Data {
  running: (Turn & { startedAt: string }) | null;
  // Turns asked for while one ran, in order.
  waiting: Turn[];
}
type S = State<Data>;

function decodeAsked(payload: unknown): Turn {
  const p = payload as Partial<Turn> | null;
  if (!p || typeof p.turnId !== 'string' || !TURN_ID.test(p.turnId)) throw new Error('Asked needs a turnId');
  if (!KINDS.includes(p.kind as Kind)) throw new Error(`Asked needs a kind (${KINDS.join(', ')})`);
  const input = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input : {};
  return { turnId: p.turnId, kind: p.kind as Kind, input: input as Json };
}

// The timer's Tick carries nothing; the turn-leftovers clock's names the turn
// it means to end, so a sweep that races the real result never ends the turn
// that follows.
const decodeTick = (payload: unknown) => {
  const p = payload as { turnId?: unknown } | null;
  if (p?.turnId === undefined || p.turnId === null) return {};
  if (typeof p.turnId !== 'string' || !TURN_ID.test(p.turnId)) throw new Error('Tick needs a turnId');
  return { turnId: p.turnId };
};

// As a turn starts or ends: the change's row, for the `session_state` its
// boards and header read, and whether anything else works on it
// (session-work.ts workedOnSql, this machine's turns aside).
interface Facts { change: (SessionStateRow & { other_work: boolean }) | null }
async function readChange(tx: Tx, key: string): Promise<Facts['change']> {
  const m = /^session:(\d+)$/.exec(key);
  if (!m) return null;
  const { rows: [change] } = await tx.query(
    `SELECT cs.id, cs.app_id, cs.user_id, cs.status, (cs.shared_at IS NOT NULL) AS shared, cs.is_headless,
            cs.headless_status, cs.headless_outcome, cs.headless_issue_number, a.slug AS app_slug,
            ${workedOnSql({ turns: false })} AS other_work
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [Number(m[1])]);
  return change || null;
}

// A change's turn starting or ending is a change of its working state,
// told by the transition that decides it: from whichever process ran it,
// and never left to a process's memory of what it last published
// (services/session-state.js).
function withState(out: Outcome<S>, f: Facts, ctx: TransitionContext): Outcome<S> {
  if (!f.change) return out;
  const was = out.next as S;
  const busy = was.name === 'running' || !!f.change.other_work;
  return { ...out, push: [...(out.push || []), sessionState(f.change, busy, ctx.now)] };
}

const runWork = (key: string, t: Turn): WorkRequest =>
  ({ kind: WORK.run, key: `run:${t.turnId}`, input: { ...(t.input as object), turnId: t.turnId, kind: t.kind, instanceKey: key } as Json });

function start(key: string, t: Turn, waiting: Turn[], ctx: TransitionContext): Outcome<S> {
  return {
    next: { name: 'running', data: { running: { ...t, startedAt: ctx.now.toISOString() }, waiting } },
    work: [runWork(key, t)],
    timer: { at: new Date(ctx.now.getTime() + MAX_TURN_MS), event: { type: 'Tick' } },
  };
}

// The turn a running instance runs.
const cur = (s: S) => s.data.running!;

// The turn ended: the next one started.
function ended(s: S, key: string, ctx: TransitionContext): Outcome<S> {
  const [next, ...rest] = s.data.waiting;
  if (next) return start(key, next, rest, ctx);
  return { next: { name: 'idle', data: { running: null, waiting: [] } }, timer: null };
}

const runResult = (s: S, e: Event<any>) => {
  const p = e.payload as WorkResultPayload;
  return p.kind === WORK.run && p.workKey === `run:${cur(s).turnId}`;
};

export function turnMachine() {
  const asked = {
    guard: (_s: S, _e: Event<any>, _f: Facts, ctx: TransitionContext) => (KEY.test(ctx.key) ? ok() : reject('bad_key')),
    to: (s: S, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> => {
      const t = e.payload as Turn;
      if (s.name === 'running') {
        if (cur(s).turnId === t.turnId || s.data.waiting.some((w) => w.turnId === t.turnId)) return { next: s };
        return { next: { ...s, data: { ...s.data, waiting: [...s.data.waiting, t] } } };
      }
      return withState(start(ctx.key, t, [], ctx), f, ctx);
    },
  };
  return defineMachine<S, Facts>({
    name: MACHINE,
    // 4: a Tick may name the turn it ends (turn-leftovers), which an older
    // Pod would read as one for whichever turn runs then. 5: `recover` is
    // the only kind, and a turn's end writes nothing: an older Pod would
    // still run a person's turn here.
    version: 5,
    events: { Asked: decodeAsked, Tick: decodeTick },
    create: ['Asked'],
    // Asked by the turn-leftovers clock, in a workflow process: web appends
    // nothing here.
    web: [],
    decode: (row) => ({ name: row.state, data: row.data as Data }),
    facts: async (tx, _s, _e, ctx) => ({ change: await readChange(tx, ctx.key) }),
    authorize: {
      // The turn-leftovers clock.
      Asked: (e) => (['route', 'system', 'admin'].includes(e.source.kind) ? ok() : reject('not_the_platform')),
      Tick: (e) => (e.source.kind === 'timer' || e.source.kind === 'system' ? ok() : reject('not_the_clock')),
    },
    transitions: {
      [NONE]: {
        Asked: asked,
        Tick: { ignore: 'not_running' },
      },
      idle: {
        Asked: asked,
        Tick: { ignore: 'not_running' },
        WorkSucceeded: { ignore: 'ended' },
        WorkFailed: { ignore: 'ended' },
        WorkExhausted: { ignore: 'ended' },
      },
      running: {
        Asked: asked,
        // Past its time: its run cancelled. The record it was asked for is
        // asked for again by the turn-leftovers clock.
        Tick: {
          to: (s: S, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> => {
            // A clock that named another turn than the one running here (a
            // sweep that raced this turn's real result) ends nothing.
            if (e.payload?.turnId && e.payload.turnId !== cur(s).turnId) return { next: s };
            return withState({ ...ended(s, ctx.key, ctx), cancel: [{ kind: WORK.run, key: `run:${cur(s).turnId}` }] }, f, ctx);
          },
        },
        WorkSucceeded: {
          to: (s: S, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> =>
            (runResult(s, e) ? withState(ended(s, ctx.key, ctx), f, ctx) : { next: s }),
        },
        WorkFailed: {
          to: (s: S, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> =>
            (runResult(s, e) ? withState(ended(s, ctx.key, ctx), f, ctx) : { next: s }),
        },
        WorkExhausted: {
          to: (s: S, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> =>
            (runResult(s, e) ? withState(ended(s, ctx.key, ctx), f, ctx) : { next: s }),
        },
      },
    } as any,
  });
}
