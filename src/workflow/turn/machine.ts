// turn: a person's turn with an agent, as workflow work. One instance per
// stream a turn runs on: `agent:<id>` for a conversation (an agent session's
// Mayor, and the coding run it dispatches), `session:<id>` for a change (a
// headless run, the classic Mayor's two paths, a turn an older release left).
//
// A turn is one work item, `turn.run`, that runs all of it in whichever
// workflow process claims it: the Mayor's rounds, the dispatch, the coding
// run in the change's worker and its tail, the wrap-up (services/turns.js).
// Its coding run's turn record names the item as its owner, so the item's
// lease is the turn's presence in every process, a person's Stop finds it,
// and `turn.stop` stops it by its journal. A process that goes takes only
// the lease: the next one claims the item and carries the turn on from its
// record (services/turn-recovery.js), as the leader's adoption once did.
//
// The person's message and the turn's claim on its conversation are written
// with the `Asked` that starts it, in one transaction (the route's); the
// claim is released here when the turn's item ends, whatever way it ends, and
// only the claim that turn made. A turn asked for while one runs waits its
// turn (a claim released by the turn itself a moment before its item reports
// lets the next one in early).

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, State, TransitionContext, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { isTurnStop, turnStop } from '../rules/turn-stop.ts';

export const MACHINE = 'turn';
export const WORK = Object.freeze({ run: 'turn.run' });
export const KINDS = Object.freeze(['agent', 'classic', 'headless', 'recover'] as const);
export type Kind = typeof KINDS[number];

// The longest a turn may run, whatever it waits on: past it, its run is
// cancelled, its coding agent stopped and its claim released.
export const MAX_TURN_MS = 6 * 60 * 60 * 1000;

const KEY = /^(agent|session):[1-9][0-9]{0,12}$/;
const TURN_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

// What a conversation says of a turn that could not finish its own way.
export const INTERRUPTED_TEXT = 'The agent was interrupted by a platform update before it finished. Retry to pick it up again.';

export function agentKey(agentSessionId: number): string { return `agent:${Number(agentSessionId)}`; }
export function sessionKey(sessionId: number): string { return `session:${Number(sessionId)}`; }

interface Turn { turnId: string; kind: Kind; input: Json }
export interface Data {
  running: (Turn & { startedAt: string; stoppedBy?: string | null }) | null;
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

const decodeStop = (payload: unknown) => {
  const p = payload as { by?: unknown } | null;
  return { by: typeof p?.by === 'string' && p.by.trim() ? p.by.trim().slice(0, 100) : null };
};

// The change whose coding turn this instance's running item owns, for a Stop.
interface Facts { ownedSessionId: number | null }
async function readFacts(tx: Tx, e: Event<any>, key: string): Promise<Facts> {
  if (e.type !== 'StopRequested' && e.type !== 'Tick') return { ownedSessionId: null };
  const { rows: [r] } = await tx.query(
    `SELECT id FROM chat_sessions
      WHERE active_turn->'owner'->>'machine' = $1 AND active_turn->'owner'->>'key' = $2
      ORDER BY id DESC LIMIT 1`, [MACHINE, key]);
  return { ownedSessionId: r ? Number(r.id) : null };
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

// The turn ended: its claim released, the next one started.
// The turn a running instance runs.
const cur = (s: S) => s.data.running!;

function ended(s: S, key: string, ctx: TransitionContext, how: 'done' | 'failed' | 'lost'): Outcome<S> {
  const d = s.data;
  const writes = [{ type: 'released', key, turnId: cur(s).turnId, kind: cur(s).kind, how }];
  const [next, ...rest] = d.waiting;
  if (next) return { ...start(key, next, rest, ctx), writes };
  return { next: { name: 'idle', data: { running: null, waiting: [] } }, writes, timer: null };
}

const runResult = (s: S, e: Event<any>) => {
  const p = e.payload as WorkResultPayload;
  return p.kind === WORK.run && p.workKey === `run:${cur(s).turnId}`;
};

export function turnMachine() {
  const asked = {
    guard: (_s: S, _e: Event<any>, _f: Facts, ctx: TransitionContext) => (KEY.test(ctx.key) ? ok() : reject('bad_key')),
    to: (s: S, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<S> => {
      const t = e.payload as Turn;
      if (s.name === 'running') {
        if (cur(s).turnId === t.turnId || s.data.waiting.some((w) => w.turnId === t.turnId)) return { next: s };
        return { next: { ...s, data: { ...s.data, waiting: [...s.data.waiting, t] } } };
      }
      return start(ctx.key, t, [], ctx);
    },
  };
  return defineMachine<S, Facts>({
    name: MACHINE,
    version: 1,
    events: { Asked: decodeAsked, StopRequested: decodeStop, Tick: () => ({}) },
    create: ['Asked'],
    decode: (row) => ({ name: row.state, data: row.data as Data }),
    facts: (tx, _s, e, ctx) => readFacts(tx, e, ctx.key),
    authorize: {
      // The routes a person sends a turn from, and the release's adoption.
      Asked: (e) => (['route', 'system', 'admin'].includes(e.source.kind) ? ok() : reject('not_the_platform')),
      StopRequested: (e) => (['route', 'system', 'admin', 'message'].includes(e.source.kind) ? ok() : reject('not_the_platform')),
      Tick: (e) => (e.source.kind === 'timer' || e.source.kind === 'system' ? ok() : reject('not_the_clock')),
    },
    transitions: {
      [NONE]: {
        Asked: asked,
        StopRequested: { ignore: 'not_running' },
        Tick: { ignore: 'not_running' },
      },
      idle: {
        Asked: asked,
        StopRequested: { ignore: 'not_running' },
        Tick: { ignore: 'not_running' },
        WorkSucceeded: { ignore: 'ended' },
        WorkFailed: { ignore: 'ended' },
        WorkExhausted: { ignore: 'ended' },
      },
      running: {
        Asked: asked,
        // A person's Stop: the run hears it from the claim (the route stamps
        // it) between its steps; a coding turn under way is stopped by its
        // journal, and its record kept for the run to end it as stopped.
        StopRequested: {
          to: (s: S, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> => {
            const by = e.payload.by ?? e.actor ?? null;
            const next: S = { ...s, data: { ...s.data, running: { ...cur(s), stoppedBy: by || 'the platform' } } };
            const work: WorkRequest[] = [];
            if (f.ownedSessionId) {
              work.push(turnStop({ sessionId: f.ownedSessionId, machine: MACHINE, key: ctx.key, kinds: [WORK.run],
                workKey: `run:${cur(s).turnId}`, by, release: false }, `stop-${cur(s).turnId}`));
            }
            return { next, work };
          },
        },
        // Past its time: the run cancelled, its coding agent stopped and its
        // record released, its claim released.
        Tick: {
          to: (s: S, _e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> => {
            const out = ended(s, ctx.key, ctx, 'lost');
            const work: WorkRequest[] = [...(out.work || [])];
            if (f.ownedSessionId) {
              work.push(turnStop({ sessionId: f.ownedSessionId, machine: MACHINE, key: ctx.key, kinds: [WORK.run],
                workKey: `run:${cur(s).turnId}`, by: null, release: true }, `timeout-${cur(s).turnId}`));
            }
            return { ...out, work, cancel: [{ kind: WORK.run, key: `run:${cur(s).turnId}` }] };
          },
        },
        WorkSucceeded: {
          to: (s: S, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<S> =>
            (runResult(s, e) ? ended(s, ctx.key, ctx, 'done') : { next: s }),
        },
        WorkFailed: {
          to: (s: S, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<S> =>
            (runResult(s, e) ? ended(s, ctx.key, ctx, 'failed') : { next: s }),
        },
        WorkExhausted: {
          to: (s: S, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<S> =>
            (runResult(s, e) ? ended(s, ctx.key, ctx, 'lost') : { next: s }),
        },
      },
    } as any,
    writes: {
      // The conversation's claim this turn made (agent_sessions.active_turn),
      // released and its screens told; a turn that did not finish its own
      // way (its run failed for good) is ended as interrupted, with Retry.
      // A change's turn has no claim of its own here: its record is its
      // run's to release.
      released: async (tx, w) => {
        const m = /^agent:(\d+)$/.exec(String(w.key));
        if (!m) return;
        const { rows: [was] } = await tx.query(
          `UPDATE agent_sessions SET active_turn = NULL, last_done_at = NOW()
            WHERE id = $1 AND active_turn->>'id' = $2 RETURNING user_id`, [Number(m[1]), String(w.turnId)]);
        if (!was || w.how === 'done') return;
        await tx.query(
          `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata)
           VALUES (NULL, $1, 'system', $2, $3::jsonb)`,
          [Number(m[1]), INTERRUPTED_TEXT, JSON.stringify({ agentSessionEvent: 'turn_interrupted', agentTurnId: w.turnId, retryable: true })]);
      },
    },
  });
}

// What every machine that queues turn.stop does with its results: nothing.
export const settlesTurnStop = isTurnStop;
