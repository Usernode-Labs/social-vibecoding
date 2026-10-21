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
import { BUS_CHANNEL, WORKFLOW_SENDER, sessionState } from '../pushes.ts';
import type { SessionStateRow } from '../pushes.ts';
import { workedOnSql } from '../session-work.ts';

// The stream a turn's events go to (services/session-bus.js): the
// conversation's own key, or a change's id.
const streamKeyOf = (key: string): string => (key.startsWith('agent:') ? key : key.replace(/^session:/, ''));
// A turn's end on its stream, in the transaction that ends it: what the
// request following it waits for (session-bus.js relay, by `turnId`), and
// announced on the bus as session-bus.js announces every event.
export const TURN_END_SQL = `
  WITH e AS (INSERT INTO stream_events (stream_key, seq, event) VALUES ($1, $2, $3::jsonb) RETURNING id)
  SELECT pg_notify($4, json_build_object('i', $5::text, 'k', 'stream',
           'r', json_build_object('key', $1::text, 'id', e.id), 'd', json_build_object())::text) FROM e`;
export function turnEndEvent(key: string, turnId: string): Record<string, unknown> {
  const m = /^agent:(\d+)$/.exec(key);
  return { type: 'done', _seq: `end-${turnId}`, turnId, ...(m ? { agentSessionId: Number(m[1]) } : {}) };
}

export const MACHINE = 'turn';
export const WORK = Object.freeze({ run: 'turn.run', stalled: 'turn.stalled', name: 'turn.name' });
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

// The change whose coding turn this instance's running item owns, for a
// Stop. For a change's own turn (`session:<id>`), as a turn starts or ends:
// its row, for the `session_state` its boards and header read, and whether
// anything else works on it (session-work.ts workedOnSql, this machine's
// turns aside).
interface Facts { ownedSessionId: number | null; change: (SessionStateRow & { other_work: boolean }) | null }
const NO_CHANGE = { change: null };
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
async function readFacts(tx: Tx, e: Event<any>, key: string): Promise<Facts> {
  if (e.type === 'Asked' || e.type.startsWith('Work')) return { ownedSessionId: null, change: await readChange(tx, key) };
  if (e.type !== 'StopRequested' && e.type !== 'Tick') return { ownedSessionId: null, ...NO_CHANGE };
  const { rows: [r] } = await tx.query(
    `SELECT id FROM chat_sessions
      WHERE active_turn->'owner'->>'machine' = $1 AND active_turn->'owner'->>'key' = $2
      ORDER BY id DESC LIMIT 1`, [MACHINE, key]);
  return { ownedSessionId: r ? Number(r.id) : null, change: e.type === 'Tick' ? await readChange(tx, key) : null };
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

// A conversation opened on a request is named after it (#3752), beside the
// turn that asked for it (agent-sessions.js nameFromRequest): never waited on.
function nameWork(key: string, t: Turn): WorkRequest[] {
  const m = /^agent:(\d+)$/.exec(key);
  const input = t.input as any;
  if (!m || input?.nameFromRequest !== true) return [];
  return [{ kind: WORK.name, key: `name:${t.turnId}`, input: { agentSessionId: Number(m[1]), userId: Number(input.userId) } }];
}

function start(key: string, t: Turn, waiting: Turn[], ctx: TransitionContext): Outcome<S> {
  return {
    next: { name: 'running', data: { running: { ...t, startedAt: ctx.now.toISOString() }, waiting } },
    work: [runWork(key, t), ...nameWork(key, t)],
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

// A turn that failed on a change (its result's `stalled`) owes its owner
// "Session stopped before finishing" when nobody watches (#4729):
// services/turns.js tellStalled, once per turn.
function stalledWork(s: S, e: Event<any>, key: string): WorkRequest[] {
  const sessionId = Number(((e.payload as WorkResultPayload).result as any)?.stalled);
  const m = /^agent:(\d+)$/.exec(key);
  if (!m || !Number.isInteger(sessionId) || sessionId <= 0) return [];
  return [{ kind: WORK.stalled, key: `stalled:${cur(s).turnId}`, input: { sessionId, agentSessionId: Number(m[1]) } }];
}

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
    // 2: a failed turn's "stopped before finishing" (turn.stalled), and a
    // conversation named after its request (turn.name): an older Pod would
    // end its turn without them.
    version: 2,
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
            return withState({ ...out, work, cancel: [{ kind: WORK.run, key: `run:${cur(s).turnId}` }] }, f, ctx);
          },
        },
        WorkSucceeded: {
          to: (s: S, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> => {
            if (!runResult(s, e)) return { next: s };
            const out = ended(s, ctx.key, ctx, 'done');
            return withState({ ...out, work: [...(out.work || []), ...stalledWork(s, e, ctx.key)] }, f, ctx);
          },
        },
        WorkFailed: {
          to: (s: S, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> =>
            (runResult(s, e) ? withState(ended(s, ctx.key, ctx, 'failed'), f, ctx) : { next: s }),
        },
        WorkExhausted: {
          to: (s: S, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<S> =>
            (runResult(s, e) ? withState(ended(s, ctx.key, ctx, 'lost'), f, ctx) : { next: s }),
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
        // Its end on its stream, however it ended, in the transaction that
        // ends it: what the request that asked for it waits for.
        const event = turnEndEvent(String(w.key), String(w.turnId));
        await tx.query(TURN_END_SQL, [streamKeyOf(String(w.key)), event._seq, JSON.stringify(event), BUS_CHANNEL, WORKFLOW_SENDER]);
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
