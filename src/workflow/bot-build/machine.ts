// bot-build: a Homeroom bot build, or an App bench trial, from the moment it
// is started to its end (docs/plans/bot-build-workflow.md). One instance per
// build: `run:<runId>` for a live or a shadow build of the bot's,
// `trial:<trialId>` for a bench trial. The build itself is one resumable work
// item, `build.run`: its handler runs the build's pipeline on a durable
// context over the item's checkpoint, so a restart that takes the process
// leaves the item to the next leader, which carries the build on from the
// last step it saved. A run can be built more than once (its plan, then the
// build its requester said Build it to; a shadow build the lane takes again
// after a platform fault), so the key carries what tells those apart:
// `run:<runId>@<nonce>`. Where the build is inside its pipeline is that
// checkpoint, not more states here (the kernel's rule 5).
//
// A build whose handler fails for good (it kept throwing, or kept taking its
// process down) ends `failed`, and `build.lost` records why where the build
// is read: the run's outcome and its note on the request, or the trial's row.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, MessageRequest, Outcome, State, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { turnStop } from '../rules/turn-stop.ts';

export const MACHINE = 'bot-build';

export const TARGETS = ['live', 'shadow', 'trial'] as const;
export type Target = typeof TARGETS[number];

const NONCE = /^[A-Za-z0-9_.-]{1,40}$/;

export function buildKey(target: Target, id: number, nonce?: string | null): string {
  const base = target === 'trial' ? `trial:${id}` : `run:${id}`;
  return nonce && NONCE.test(nonce) ? `${base}@${nonce}` : base;
}

export const WORK = Object.freeze({ run: 'build.run', lost: 'build.lost' });

// Who asked for the build and hears its end (the Homeroom bot's request
// instance, for a live build): BuildEnded, with the run and how it ended.
interface ReplyTo { machine: string; key: string }

export interface Data {
  target: Target;
  id: number;
  nonce?: string | null;
  replyTo?: ReplyTo | null;
  // A person's or the platform's Stop: who, and that it ended the build.
  stoppedBy?: string | null;
  requestedAt: string;
  endedAt?: string;
  result?: Json;
  error?: { message: string; code: string | null } | null;
  lost?: boolean;
}
type S = State<Data>;

interface Requested { target: Target; id: number; nonce: string | null; input: Json; replyTo: ReplyTo | null }

const PART = /^[A-Za-z0-9:._@-]{1,200}$/;
function decodeReplyTo(v: unknown): ReplyTo | null {
  const r = v as Partial<ReplyTo> | null;
  return r && typeof r.machine === 'string' && PART.test(r.machine) && typeof r.key === 'string' && PART.test(r.key)
    ? { machine: r.machine, key: r.key } : null;
}

function decodeRequested(payload: unknown): Requested {
  const p = payload as Partial<Requested> | null;
  if (!p || !TARGETS.includes(p.target as Target) || !Number.isInteger(p.id) || (p.id as number) <= 0) {
    throw new Error('Requested needs a target (live, shadow, trial) and a positive id');
  }
  if (p.nonce != null && (typeof p.nonce !== 'string' || !NONCE.test(p.nonce))) throw new Error('Requested has a malformed nonce');
  const input = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input : {};
  return { target: p.target as Target, id: p.id as number, nonce: p.nonce ?? null, input: input as Json, replyTo: decodeReplyTo(p.replyTo) };
}

// A Stop of the build's turn (the session's Stop routes, the bench's
// cancel, the request it builds merged): `sessionId` when the caller knows
// it, else the build's own session (facts).
const decodeStop = (payload: unknown) => {
  const p = payload as { sessionId?: unknown; by?: unknown } | null;
  return {
    sessionId: Number.isInteger(p?.sessionId) && (p!.sessionId as number) > 0 ? p!.sessionId as number : null,
    by: typeof p?.by === 'string' && p.by.trim() ? p.by.trim().slice(0, 100) : null,
  };
};

// The build's own session: the one whose workflow_owner names this instance.
interface Facts { sessionId: number | null }
async function readFacts(tx: Tx, e: Event<any>, key: string): Promise<Facts> {
  if (e.type !== 'StopRequested' || e.payload?.sessionId) return { sessionId: e.payload?.sessionId ?? null };
  const { rows: [r] } = await tx.query(`SELECT id FROM chat_sessions WHERE workflow_owner = $1 ORDER BY id DESC LIMIT 1`, [`${MACHINE}/${key}`]);
  return { sessionId: r ? Number(r.id) : null };
}

// Its end, told to whoever asked (a live build's request instance).
function told(d: Data, outcome: string): MessageRequest[] {
  if (!d.replyTo) return [];
  return [{ to: d.replyTo, event: { type: 'BuildEnded', payload: { target: d.target, id: d.id, nonce: d.nonce ?? null, outcome, stoppedBy: d.stoppedBy ?? null } as Json } }];
}

const runResult = (e: Event<any>) => (e.payload as WorkResultPayload).workKey === 'run';

export function botBuild() {
  return defineMachine<S, Facts>({
    name: MACHINE,
    version: 1,
    events: { Requested: decodeRequested, StopRequested: decodeStop },
    create: ['Requested'],
    terminal: ['done', 'failed'],
    decode: (row) => ({ name: row.state, data: row.data as Data }),
    facts: (tx, _s, e, ctx) => readFacts(tx, e, ctx.key),
    authorize: {
      // The bot's request and the bench lane start builds; an admin may
      // start one again from the console.
      Requested: (e) => (['system', 'admin', 'message'].includes(e.source.kind) ? ok() : reject('not_the_platform')),
      // A person's Stop (the session's routes), the bench's cancel, the
      // request it builds merged (a message from its request instance).
      StopRequested: (e) => (['route', 'system', 'admin', 'message'].includes(e.source.kind) ? ok() : reject('not_the_platform')),
    },
    transitions: {
      [NONE]: {
        Requested: {
          to: (_s, e, _f, ctx): Outcome<S> => {
            const p = e.payload as Requested;
            return {
              next: { name: 'building', data: { target: p.target, id: p.id, nonce: p.nonce, replyTo: p.replyTo, requestedAt: ctx.now.toISOString() } },
              work: [{ kind: WORK.run, key: 'run', input: { ...(p.input as object), target: p.target, id: p.id, nonce: p.nonce } as Json }],
            };
          },
        },
        StopRequested: { ignore: 'not_building' },
      },
      building: {
        Requested: { ignore: 'already_building' },
        // Stopped: its run ends (the cancel ends the handler; turn.stop ends
        // the turn and releases its record), recorded where the build is
        // read as stopped, by whom.
        StopRequested: {
          to: (s, e, f, ctx): Outcome<S> => {
            const by = e.payload.by ?? e.actor ?? null;
            const d: Data = { ...s.data, stoppedBy: by || 'the platform', endedAt: ctx.now.toISOString(),
              error: { message: by ? `Stopped by ${by}` : 'Stopped', code: 'stopped' } };
            const work: WorkRequest[] = [{ kind: WORK.lost, key: 'lost', input: { target: d.target, id: d.id, nonce: d.nonce ?? null, error: d.error } as Json }];
            if (f.sessionId) work.push(turnStop({ sessionId: f.sessionId, machine: MACHINE, key: ctx.key, kinds: [WORK.run], workKey: 'run', by, release: true }, 'stop'));
            return { next: { name: 'failed', data: d }, cancel: [{ kind: WORK.run, key: 'run' }], work, messages: told(d, 'stopped') };
          },
        },
        WorkSucceeded: {
          guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_build')),
          to: (s, e, _f, ctx) => {
            const d: Data = { ...s.data, endedAt: ctx.now.toISOString(), result: (e.payload as WorkResultPayload).result ?? null };
            return { next: { name: 'done', data: d }, messages: told(d, 'done') };
          },
        },
        WorkFailed: {
          guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_build')),
          to: (s, e, _f, ctx) => failed(s, e, ctx.now),
        },
        WorkExhausted: {
          guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_build')),
          to: (s, e, _f, ctx) => failed(s, e, ctx.now),
        },
      },
      // Terminal states still take their work's results (the kernel's rule 7).
      done: {
        '*': { ignore: 'ended' },
        StopRequested: { ignore: 'ended' },
        WorkSucceeded: { ignore: 'ended' },
        WorkFailed: { ignore: 'ended' },
        WorkExhausted: { ignore: 'ended' },
      },
      failed: {
        '*': { ignore: 'ended' },
        StopRequested: { ignore: 'ended' },
        // A run that reported after the build failed (its lease lost, then
        // it finished): kept as lost. Its loss record and a Stop's turn.stop
        // report here too, and change nothing.
        WorkSucceeded: { to: (s, e) => (runResult(e) ? { next: { ...s, data: { ...s.data, lost: true } } } : { next: s }) },
        WorkFailed: { to: (s) => ({ next: s }) },
        WorkExhausted: { to: (s) => ({ next: s }) },
      },
    },
  });
}

function failed(s: S, e: Event<any>, now: Date): Outcome<S> {
  const error = (e.payload as WorkResultPayload).error || { message: 'the build failed', code: null };
  const err = { message: String(error.message || 'the build failed').slice(0, 2000), code: error.code ?? null };
  const d: Data = { ...s.data, endedAt: now.toISOString(), error: err };
  return {
    next: { name: 'failed', data: d },
    work: [{ kind: WORK.lost, key: 'lost', input: { target: s.data.target, id: s.data.id, nonce: s.data.nonce ?? null, error: err } as Json }],
    messages: told(d, 'failed'),
  };
}
