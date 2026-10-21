// bot-dm: one person's DM with the Homeroom bot, from the first thing the
// bot owes them there. One instance per person (`person:<userId>`):
//
//   idle ──they write──▶ answering ──answered──▶ idle (or the next message they wrote)
//                            │
//                            └──the model could not answer──▶ trying_later ──60 s, 3 min, 10 min──▶ answering
//
// What they write is an event in the transaction that stores it
// (routes/conversations.js, through conversations.sendMessage), so an answer
// owed outlives the web process that took the message. Their messages are
// answered one at a time, in the order written, wherever the work runs (the
// in-process promise chain and the deferred-try timers are gone). The
// answer (services/homeroom-bot-dm.js answerUserMessage: every code path and
// the model's turn) is work, keyed by the message; a retry after a restart
// finds the reply by its idempotency key and says nothing twice.
//
// The person's taps under the bot's offers (Tapped → dm.act) and their
// hellos (Greet → dm.hello) are work of the same instance, each said once.
// So is the email that stands in for a push they cannot get, owed by the
// message that rang (MailOwed → dm.mail, appended in that message's own
// transaction: homeroom-bot-dm.js sendDm), one per message.
// workflow-foundation's design-bot-replies.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, Machine, Outcome, TransitionContext, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { DEFER_DELAYS_MS, DM, HELLO_KINDS, dmKey } from '../rules/bot-replies.ts';

export const MACHINE = DM;
export { dmKey };
export const WORK = Object.freeze({
  answer: 'dm.answer',
  sorry: 'dm.sorry',
  act: 'dm.act',
  hello: 'dm.hello',
  mail: 'dm.mail',
});

// ── State ───────────────────────────────────────────────────────────────

type Name = 'idle' | 'answering' | 'trying_later';
interface Note { kind: string; status: 'pending' | 'done' | 'failed' | 'exhausted' }
interface Owed { messageId: number; conversationId: number; attempt: number }
export interface Data {
  userId: number;
  // Messages written and not answered yet, oldest first.
  queue: Owed[];
  // The one being answered (its work `msg:<id>[:d<n>]`).
  current: Owed | null;
  // The one whose answer is asked again when the timer fires.
  later: Owed | null;
  // The newest message whose answer ended (any try): one heard again is
  // answered already (its work key would make no second item).
  done: number;
  // Taps decided (action id → choice): a second is refused.
  taps: Record<string, string>;
  notes: Record<string, Note>;
}
export type DState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<DState, { data: Data }>;

export interface Facts {
  action: { id: number; user_id: number; status: string; kind: string } | null;
}
const NO_FACTS: Facts = { action: null };

// ── Events ──────────────────────────────────────────────────────────────

const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);

const EVENTS = {
  // They wrote in their DM with the bot. `attempt`: a later try an older
  // release owed (its adoption), else 0.
  Wrote: (p: any) => ({
    userId: int(p?.userId, 'userId'), messageId: int(p?.messageId, 'messageId'),
    conversationId: int(p?.conversationId, 'conversationId'),
    attempt: Math.min(DEFER_DELAYS_MS.length, Math.max(0, Number(p?.attempt) || 0)),
  }),
  TryAgain: () => ({}),
  // A tap under one of the bot's offers (or Build it under a plan).
  Tapped: (p: any) => {
    const choice = ['yes', 'no', 'build'].includes(p?.choice) ? p.choice as string : null;
    if (!choice) throw new Error('choice must be yes, no or build');
    const answers = Array.isArray(p?.answers)
      ? p.answers.slice(0, 2).map((a: unknown) => (typeof a === 'string' ? a.slice(0, 200) : null)) : [];
    return { userId: int(p?.userId, 'userId'), actionId: int(p?.actionId, 'actionId'), choice, answers };
  },
  // Their one hello, of this kind, is owed (joining by an invite, the tour's
  // end, the first session's answer, a ready-made app made).
  Greet: (p: any) => {
    if (!HELLO_KINDS.has(p?.kind)) throw new Error('kind is not a hello');
    return { userId: int(p?.userId, 'userId'), kind: p.kind as string, appId: optInt(p?.appId) };
  },
  // A message of the bot's rang them about something ready (or a first
  // version live): its email, sent when no phone could take the push
  // (services/activity-mail.js emailIfNoPush, which `mail` is the input of).
  MailOwed: (p: any) => {
    if (!p?.mail || typeof p.mail !== 'object' || Array.isArray(p.mail)) throw new Error('mail must be an object');
    return { userId: int(p?.userId, 'userId'), messageId: int(p?.messageId, 'messageId'), mail: p.mail as Record<string, Json> };
  },
};
const CREATE = ['Wrote', 'Tapped', 'Greet', 'MailOwed'];

// ── Moves ───────────────────────────────────────────────────────────────

const step = (name: Name, data: Data, more: Omit<Outcome<DState>, 'next'> = {}): Outcome<DState> => ({ next: { name, data }, ...more });
const created = (e: Event<any>): Data => ({ userId: e.payload.userId, queue: [], current: null, later: null, done: 0, taps: {}, notes: {} });
const live = (s: DState, e: Event<any>): Data => (s.name === NONE ? created(e) : (s as Live).data);
const answerKey = (o: Owed) => `msg:${o.messageId}${o.attempt ? `:d${o.attempt}` : ''}`;

function answer(d: Data, o: Owed, more: Omit<Outcome<DState>, 'next'> = {}): Outcome<DState> {
  const key = answerKey(o);
  const work: WorkRequest[] = [...(more.work || []),
    { kind: WORK.answer, key, input: { userId: d.userId, conversationId: o.conversationId, messageId: o.messageId, attempt: o.attempt, key } }];
  return step('answering', { ...d, current: o, later: null }, { ...more, work, timer: null });
}

// The next message waiting, or nothing to do.
function next(d: Data, more: Omit<Outcome<DState>, 'next'> = {}): Outcome<DState> {
  const [first, ...rest] = d.queue;
  const base = { ...d, current: null, later: null };
  if (first) return answer({ ...base, queue: rest }, first, more);
  return step('idle', base, { ...more, timer: null });
}

function wrote(s: DState, e: Event<any>): Outcome<DState> {
  const d = live(s, e);
  const o: Owed = { messageId: e.payload.messageId, conversationId: e.payload.conversationId, attempt: e.payload.attempt };
  const seen = o.messageId <= (d.done || 0)
    || [d.current, d.later, ...d.queue].some((q) => q && q.messageId === o.messageId && q.attempt >= o.attempt);
  if (seen) return step(s.name === NONE ? 'idle' : (s.name as Name), d);
  if (s.name === 'answering') return step('answering', { ...d, queue: [...d.queue, o] });
  // Written to since an answer it would try again: that try is dropped (the
  // new message's answer reads the old one too), as [main]'s deferredTurn
  // skipped it.
  return answer({ ...d, later: null }, o);
}

const tryAgain = (s: DState): Outcome<DState> => {
  const d = (s as Live).data;
  return d.later ? answer(d, d.later) : next(d);
};

// An answer's end: asked again later when the model could not answer and
// nothing newer waits; else the next message, if any.
function answered(status: 'done' | 'failed' | 'exhausted') {
  return (s: DState, e: Event<WorkResultPayload>, _f: Facts, ctx: TransitionContext): Outcome<DState> => {
    const cur = (s as Live).data.current!;
    const d: Data = { ...(s as Live).data, done: Math.max((s as Live).data.done || 0, cur.messageId) };
    if (status !== 'done') {
      // Failed for good: they hear the bot could not answer, once.
      const key = `sorry:${cur.messageId}`;
      const sorry: WorkRequest = { kind: WORK.sorry, key, input: { userId: d.userId, messageId: cur.messageId, conversationId: cur.conversationId, attempt: cur.attempt } };
      const withNote = d.notes[key] ? d : { ...d, notes: { ...d.notes, [key]: { kind: WORK.sorry, status: 'pending' as const } } };
      return next(withNote, d.notes[key] ? {} : { work: [sorry] });
    }
    const later = Number((e.payload.result as any)?.later) || 0;
    if (later > 0 && later <= DEFER_DELAYS_MS.length && !d.queue.length) {
      const o: Owed = { ...cur, attempt: later };
      return step('trying_later', { ...d, current: null, later: o },
        { timer: { at: new Date(ctx.now.getTime() + DEFER_DELAYS_MS[later - 1]!), event: { type: 'TryAgain' } } });
    }
    return next(d);
  };
}

function owe(s: DState, e: Event<any>, work: WorkRequest, more: Partial<Data> = {}): Outcome<DState> {
  const d = live(s, e);
  const name = s.name === NONE ? 'idle' : (s.name as Name);
  if (d.notes[work.key]) return step(name, d);
  return step(name, { ...d, ...more, notes: { ...d.notes, [work.key]: { kind: work.kind, status: 'pending' as const } } }, { work: [work] });
}

const tapGuard = (s: DState, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
  if (ctx.key !== dmKey(e.payload.userId)) return reject('key_mismatch');
  const a = f.action;
  if (!a || Number(a.user_id) !== e.payload.userId) return reject('no_such_choice');
  const d = s.name === NONE ? null : (s as Live).data;
  if (a.status !== 'open' || d?.taps[String(a.id)]) return reject('already_decided');
  if (a.kind === 'build_plan' ? e.payload.choice !== 'build' : e.payload.choice === 'build') return reject('wrong_choice');
  return ok();
};
const tapped = (s: DState, e: Event<any>): Outcome<DState> => {
  const d = live(s, e);
  const key = `action:${e.payload.actionId}`;
  return owe(s, e, {
    kind: WORK.act, key,
    input: { userId: e.payload.userId, actionId: e.payload.actionId, choice: e.payload.choice, answers: e.payload.answers, key },
  }, { taps: { ...d.taps, [String(e.payload.actionId)]: e.payload.choice } });
};

// Each trigger owes its own (a join of each project): whether the person
// has had a hello is the send's to decide, in its transaction.
const greet = (s: DState, e: Event<any>): Outcome<DState> => owe(s, e, {
  kind: WORK.hello, key: `hello:${e.payload.kind}${e.payload.appId ? `:${e.payload.appId}` : ''}`,
  input: { userId: e.payload.userId, kind: e.payload.kind, appId: e.payload.appId },
});

// One email per message that rang; the work's key makes a second ask none.
// Nothing waits on it, so its result is not kept. `owedAt`: an email run
// long after (work left over a rollback) is not sent.
const mailOwed = (s: DState, e: Event<any>, _f?: Facts, ctx?: TransitionContext): Outcome<DState> => step(s.name === NONE ? 'idle' : (s.name as Name), live(s, e), {
  work: [{ kind: WORK.mail, key: `mail:${e.payload.messageId}`, input: {
    ...e.payload.mail, userId: e.payload.userId, messageId: e.payload.messageId, owedAt: (ctx?.now ?? new Date()).toISOString(),
  } }],
});

// A note's result, kept (so the same work owed again is owed once). An act
// that failed for good is settled as failed and said (`action:<id>:failed`),
// never left claimed and undone.
function noteResult(status: Note['status']) {
  return (s: DState, e: Event<WorkResultPayload>): Outcome<DState> => {
    const d = (s as Live).data;
    const notes = { ...d.notes, [e.payload.workKey]: { ...d.notes[e.payload.workKey]!, status } };
    const m = /^action:(\d+)$/.exec(e.payload.workKey);
    if (status === 'done' || e.payload.kind !== WORK.act || !m) return step(s.name as Name, { ...d, notes });
    const key = `${e.payload.workKey}:failed`;
    const work: WorkRequest = { kind: WORK.act, key, input: { userId: d.userId, actionId: Number(m[1]), choice: 'no', answers: [], key: e.payload.workKey, gaveUp: true } };
    return step(s.name as Name, { ...d, notes: { ...notes, [key]: { kind: WORK.act, status: 'pending' } } }, { work: [work] });
  };
}

function result(status: 'done' | 'failed' | 'exhausted') {
  const ended = answered(status);
  const note = noteResult(status);
  return {
    guard: (s: DState, e: Event<WorkResultPayload>): Check => {
      const d = (s as Live).data;
      if (e.payload.kind === WORK.mail) return ok();
      if (e.payload.kind === WORK.answer) {
        return s.name === 'answering' && d.current && e.payload.workKey === answerKey(d.current) ? ok() : reject('stale_result');
      }
      return d.notes[e.payload.workKey]?.status === 'pending' ? ok() : reject('stale_result');
    },
    to: (s: DState, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<DState> => {
      if (e.payload.kind === WORK.mail) return step(s.name as Name, (s as Live).data);
      return e.payload.kind === WORK.answer ? ended(s, e, f, ctx) : note(s, e);
    },
  };
}

// ── The machine ─────────────────────────────────────────────────────────

const route = (e: Event<any>): Check => (e.source.kind === 'route' || e.source.kind === 'system' ? ok() : reject('not_a_producer'));
const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));

async function readFacts(tx: Tx, event: Event<any>): Promise<Facts> {
  if (event.type !== 'Tapped') return NO_FACTS;
  const { rows: [action] } = await tx.query(
    'SELECT id, user_id, status, kind FROM homeroom_bot_dm_actions WHERE id = $1 FOR UPDATE', [Number(event.payload?.actionId)]);
  return { action: action || null };
}

export function botDm(): Machine<DState, Facts> {
  const works = { WorkSucceeded: result('done'), WorkFailed: result('failed'), WorkExhausted: result('exhausted') };
  const keyed = (to: (s: DState, e: Event<any>, f?: Facts, ctx?: TransitionContext) => Outcome<DState>) => ({
    guard: (_s: DState, e: Event<any>, _f: Facts, ctx: TransitionContext): Check =>
      (ctx.key === dmKey(e.payload.userId) ? ok() : reject('key_mismatch')),
    to,
  });
  const always = { Tapped: { guard: tapGuard, to: tapped }, Greet: keyed(greet), MailOwed: keyed(mailOwed), ...works };
  return defineMachine<DState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: CREATE,
    decode: (row) => ({ name: row.state, data: row.data } as DState),
    facts: (tx: Tx, _state: DState, event: Event<any>) => readFacts(tx, event),
    authorize: { Wrote: route, TryAgain: timer, Tapped: route, Greet: route, MailOwed: route },
    reply: async (_tx, event) => (event.type === 'Tapped' ? { ok: true, choice: (event.payload as any).choice } as Json : undefined),
    transitions: {
      [NONE]: { Wrote: keyed(wrote), Tapped: always.Tapped, Greet: always.Greet, MailOwed: always.MailOwed },
      idle: { Wrote: keyed(wrote), TryAgain: { ignore: 'not_waiting' }, ...always },
      answering: { Wrote: keyed(wrote), TryAgain: { ignore: 'answering' }, ...always },
      trying_later: { Wrote: keyed(wrote), TryAgain: { to: tryAgain }, ...always },
    } as any,
  });
}
