// bot-voice: one place in a project where people speak to the Homeroom bot
// (a change's or a request's discussion, the project's chat, a topic, a
// reply thread), from the first message there that might be to it. One
// instance per place (`place:<appId>:<type>:<ref>`, the voice's own place
// key), created by the first thing that happens there:
//
//   quiet ──a person writes──▶ settling ──quiet for 8 s (25 s at most)──▶ answering ──turn done──▶ quiet
//                                  ▲                                          │
//                                  └──────── written to while it answered ───┘
//
// What a person writes is an event in the transaction that stores it
// (services/ws.js handleMessage), so a reply owed outlives the process that
// heard it. The turn (services/homeroom-bot-voice.js runTurn) is work: it
// reads what was said since the place's `through`, decides with the voice's
// gate whether it was spoken to, and answers or stays quiet; a retry after a
// restart finds its own reply by its mark and says nothing twice.
//
// The place also owes what others hand it to say there, each said once as
// work: a tap under one of its offers (OfferTapped → voice.act), what came
// of a change people asked for (Report → voice.report, from the bot's
// follow-up), and the answer to a mention on a request a person holds
// (HeldAnswer → voice.post, from the bot's refresh). workflow-foundation's
// design-bot-replies.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, Machine, Outcome, TransitionContext, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { SETTLE_CAP_MS, SETTLE_MS, VOICE, placeOf, voiceKey } from '../rules/bot-replies.ts';
import type { Place } from '../rules/bot-replies.ts';

export const MACHINE = VOICE;
export { voiceKey };
export const WORK = Object.freeze({
  turn: 'voice.turn',
  act: 'voice.act',
  report: 'voice.report',
  post: 'voice.post',
});

// ── State ───────────────────────────────────────────────────────────────

type Name = 'quiet' | 'settling' | 'answering';
interface Note { kind: string; status: 'pending' | 'done' | 'failed' | 'exhausted' }
export interface Data {
  appId: number;
  place: Place;
  // The newest message a turn here has read: the next one reads after it.
  through: number;
  // When the burst being settled began (ISO), for the 25-second cap.
  first: string | null;
  // Written to while a turn ran: another turn once it ends.
  again: boolean;
  // Turns asked for so far (each one's work key).
  turns: number;
  // A turn ended for good without reading anything (its work exhausted):
  // the next one says sorry if somebody spoke to it (Q3).
  sorry: boolean;
  // Taps decided here (offer id → choice): a second tap is refused.
  taps: Record<string, string>;
  // The work this place owes others (offers, reports, held answers).
  notes: Record<string, Note>;
}
export type VState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<VState, { data: Data }>;

export interface Facts {
  // OfferTapped: the offer and where its message is, locked.
  offer: { id: number; app_id: number; for_user_id: number | null; status: string; thread_type: string | null; thread_ref: number | null; message_app_id: number | null } | null;
}
const NO_FACTS: Facts = { offer: null };

// ── Events ──────────────────────────────────────────────────────────────

const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const place = (p: any): Place => {
  if (!p?.place || typeof p.place !== 'object') throw new Error('place is required');
  const found = placeOf(p.place.type === 'chat' ? null : p.place);
  if (!found) throw new Error('place is not one the voice speaks in');
  return found;
};
const where = (p: any) => ({ appId: int(p?.appId, 'appId'), place: place(p) });

const EVENTS = {
  // A person wrote in the place (the message is stored; the turn reads it).
  Heard: (p: any) => ({ ...where(p), messageId: int(p?.messageId, 'messageId') }),
  Settled: () => ({}),
  OfferTapped: (p: any) => {
    const choice = p?.choice === 'yes' ? 'yes' : p?.choice === 'no' ? 'no' : null;
    if (!choice) throw new Error('choice must be yes or no');
    return { ...where(p), offerId: int(p?.offerId, 'offerId'), userId: int(p?.userId, 'userId'), choice };
  },
  // What came of a change people asked for here: the asks it made, by id.
  Report: (p: any) => {
    const asks = Array.isArray(p?.asks) ? p.asks.map((a: unknown) => int(a, 'ask')) : [];
    if (!asks.length) throw new Error('asks is required');
    const tag = text(p?.runTag, 120);
    if (!tag) throw new Error('runTag is required');
    return { ...where(p), sessionId: int(p?.sessionId, 'sessionId'), runTag: tag, asks, outcome: (p?.outcome ?? {}) as Json };
  },
  // The answer to a mention of the bot on a request a person holds.
  HeldAnswer: (p: any) => {
    const kind = p?.kind === 'going_ahead' || p?.kind === 'held_by_person' ? p.kind : null;
    if (!kind) throw new Error('kind must be going_ahead or held_by_person');
    const body = text(p?.text, 4000);
    if (!body) throw new Error('text is required');
    const names = (v: unknown) => (Array.isArray(v) ? v.filter((n) => typeof n === 'string' && n).slice(0, 20) as string[] : []);
    return {
      ...where(p), kind, text: body, mentionId: int(p?.mentionId, 'mentionId'),
      mention: text(p?.mention, 80), mentions: names(p?.mentions),
    };
  },
};
const CREATE = ['Heard', 'OfferTapped', 'Report', 'HeldAnswer'];

// ── Moves ───────────────────────────────────────────────────────────────

const step = (name: Name, data: Data, more: Omit<Outcome<VState>, 'next'> = {}): Outcome<VState> => ({ next: { name, data }, ...more });

function created(e: Event<any>): Data {
  return { appId: e.payload.appId, place: e.payload.place, through: 0, first: null, again: false, turns: 0, sorry: false, taps: {}, notes: {} };
}
const live = (s: VState, e: Event<any>): Data => (s.name === NONE ? created(e) : (s as Live).data);

// The burst's deadline: quiet SETTLE_MS after its last message, never past
// SETTLE_CAP_MS after its first.
function settleAt(first: Date, now: Date): Date {
  return new Date(Math.min(now.getTime() + SETTLE_MS, first.getTime() + SETTLE_CAP_MS));
}

function heard(s: VState, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<VState> {
  const d = live(s, e);
  if (s.name === 'answering') return step('answering', { ...d, again: true });
  const first = s.name === 'settling' && d.first ? new Date(d.first) : ctx.now;
  return step('settling', { ...d, first: first.toISOString() },
    { timer: { at: settleAt(first, ctx.now), event: { type: 'Settled' } } });
}

function turn(d: Data, ctx: TransitionContext): Outcome<VState> {
  const n = d.turns + 1;
  const work: WorkRequest[] = [{
    kind: WORK.turn, key: `turn:${n}`,
    input: { appId: d.appId, place: d.place as unknown as Json, through: d.through, sorry: d.sorry },
  }];
  return step('answering', { ...d, turns: n, first: null, again: false }, { work, timer: null });
}

const settled = (s: VState, _e: Event<any>, _f: Facts, ctx: TransitionContext) => turn((s as Live).data, ctx);

// A turn's end: what it read through is the place's; anything written while
// it ran gets a turn of its own.
function turnEnded(status: 'done' | 'failed') {
  return (s: VState, e: Event<WorkResultPayload>, _f: Facts, ctx: TransitionContext): Outcome<VState> => {
    const d = (s as Live).data;
    const r = (e.payload.result || {}) as { throughId?: number };
    const through = status === 'done' ? Math.max(d.through, Number(r.throughId) || 0) : d.through;
    // Failed for good: whoever spoke to it hears sorry, once, in the next
    // turn (which runs now).
    const next: Data = { ...d, through, sorry: status === 'failed' && !d.sorry };
    if (next.sorry) return turn(next, ctx);
    const quiet: Data = { ...next, sorry: false };
    if (d.again) {
      const first = ctx.now;
      return step('settling', { ...quiet, again: false, first: first.toISOString() },
        { timer: { at: settleAt(first, ctx.now), event: { type: 'Settled' } } });
    }
    return step('quiet', quiet, { timer: null });
  };
}

// Owed work, recorded as a note (its result is a note's, not a turn's).
function owe(s: VState, e: Event<any>, work: WorkRequest, more: Partial<Data> = {}): Outcome<VState> {
  const d = live(s, e);
  if (d.notes[work.key]) return step(s.name === NONE ? 'quiet' : (s.name as Name), d);
  const notes = { ...d.notes, [work.key]: { kind: work.kind, status: 'pending' as const } };
  return step(s.name === NONE ? 'quiet' : (s.name as Name), { ...d, ...more, notes }, { work: [work] });
}

const tapGuard = (s: VState, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
  if (ctx.key !== voiceKey(e.payload.appId, e.payload.place)) return reject('key_mismatch');
  const o = f.offer;
  if (!o || Number(o.app_id) !== e.payload.appId || Number(o.message_app_id) !== e.payload.appId) return reject('no_such_offer');
  const at = placeOf(o.thread_type ? { type: o.thread_type, ref: o.thread_ref } : null);
  if (!at || voiceKey(e.payload.appId, at) !== ctx.key) return reject('no_such_offer');
  if (Number(o.for_user_id) !== e.payload.userId) return reject('not_for_you');
  const d = s.name === NONE ? null : (s as Live).data;
  if (o.status !== 'open' || d?.taps[String(o.id)]) return reject('already_decided');
  return ok();
};
const tapped = (s: VState, e: Event<any>): Outcome<VState> => {
  const d = live(s, e);
  const key = `offer:${e.payload.offerId}`;
  return owe(s, e, { kind: WORK.act, key, input: { offerId: e.payload.offerId, userId: e.payload.userId, choice: e.payload.choice, key } },
    { taps: { ...d.taps, [String(e.payload.offerId)]: e.payload.choice } });
};

const reported = (s: VState, e: Event<any>): Outcome<VState> => owe(s, e, {
  kind: WORK.report, key: `report:${e.payload.runTag}`,
  input: { appId: e.payload.appId, place: e.payload.place, sessionId: e.payload.sessionId, runTag: e.payload.runTag, asks: e.payload.asks, outcome: e.payload.outcome },
});

// The answer is owed from now, and said by work: its row (pending) is
// written with the decision to say it, so the refresh that reads the bot's
// answers there (homeroom-bot-holds.js decide) counts it as said only once
// it is certain to be.
const held = (s: VState, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<VState> => {
  const key = `held:${e.payload.mentionId}:${e.payload.kind}`;
  const out = owe(s, e, {
    kind: WORK.post, key,
    input: { appId: e.payload.appId, issueNumber: e.payload.place.ref, kind: e.payload.kind, text: e.payload.text,
      mention: e.payload.mention, mentions: e.payload.mentions, key },
  });
  if (!out.work?.length) return out;
  return { ...out, writes: [{ type: 'heldPost', appId: e.payload.appId, issueNumber: e.payload.place.ref, kind: e.payload.kind, at: ctx.now.toISOString() }] };
};

// A note's result, kept (so the same work owed again is owed once). An act
// that failed for good is settled as failed and said (`offer:<id>:failed`),
// never left deciding with its buttons up.
function noteResult(status: Note['status']) {
  return {
    guard: (s: VState, e: Event<WorkResultPayload>): Check =>
      ((s as Live).data.notes[e.payload.workKey]?.status === 'pending' ? ok() : reject('stale_result')),
    to: (s: VState, e: Event<WorkResultPayload>): Outcome<VState> => {
      const d = (s as Live).data;
      const notes = { ...d.notes, [e.payload.workKey]: { ...d.notes[e.payload.workKey]!, status } };
      const m = /^offer:(\d+)$/.exec(e.payload.workKey);
      if (status === 'done' || e.payload.kind !== WORK.act || !m) return step(s.name as Name, { ...d, notes });
      const key = `${e.payload.workKey}:failed`;
      const work: WorkRequest = { kind: WORK.act, key, input: { offerId: Number(m[1]), userId: 0, choice: 'no', key: e.payload.workKey, gaveUp: true } };
      return step(s.name as Name, { ...d, notes: { ...notes, [key]: { kind: WORK.act, status: 'pending' } } }, { work: [work] });
    },
  };
}

// A work result: a turn's moves the place on; any other settles its note.
function result(status: 'done' | 'failed' | 'exhausted') {
  const turnTo = turnEnded(status === 'done' ? 'done' : 'failed');
  const note = noteResult(status);
  return {
    guard: (s: VState, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Check => {
      if (e.payload.kind === WORK.turn) {
        return s.name === 'answering' && e.payload.workKey === `turn:${(s as Live).data.turns}` ? ok() : reject('stale_result');
      }
      return note.guard(s, e);
    },
    to: (s: VState, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<VState> =>
      (e.payload.kind === WORK.turn ? turnTo(s, e, f, ctx) : note.to(s, e)),
  };
}

// ── The machine ─────────────────────────────────────────────────────────

const route = (e: Event<any>): Check => (e.source.kind === 'route' || e.source.kind === 'system' ? ok() : reject('not_a_producer'));
const system = (e: Event<any>): Check => (e.source.kind === 'system' || e.source.kind === 'service' ? ok() : reject('not_a_producer'));
const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));

async function readFacts(tx: Tx, event: Event<any>): Promise<Facts> {
  if (event.type !== 'OfferTapped') return NO_FACTS;
  const { rows: [offer] } = await tx.query(
    `SELECT o.id, o.app_id, o.for_user_id, o.status, m.thread_type, m.thread_ref, m.app_id AS message_app_id
       FROM homeroom_bot_voice_offers o JOIN chat_messages m ON m.id = o.message_id
      WHERE o.id = $1 FOR UPDATE OF o`, [Number(event.payload?.offerId)]);
  return { offer: offer || null };
}

export function botVoice(): Machine<VState, Facts> {
  const works = { WorkSucceeded: result('done'), WorkFailed: result('failed'), WorkExhausted: result('exhausted') };
  const keyed = (to: (s: VState, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<VState>) => ({
    guard: (_s: VState, e: Event<any>, _f: Facts, ctx: TransitionContext): Check =>
      (ctx.key === voiceKey(e.payload.appId, e.payload.place) ? ok() : reject('key_mismatch')),
    to,
  });
  const owed = {
    OfferTapped: { guard: tapGuard, to: tapped },
    Report: keyed(reported),
    HeldAnswer: keyed(held),
    ...works,
  };
  return defineMachine<VState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: CREATE,
    decode: (row) => ({ name: row.state, data: row.data } as VState),
    facts: (tx: Tx, _state: VState, event: Event<any>) => readFacts(tx, event),
    authorize: {
      Heard: route,
      Settled: timer,
      OfferTapped: route,
      Report: system,
      HeldAnswer: system,
    },
    writes: {
      // The held answer's post row, pending until voice.post has said it
      // (homeroom-bot-live.js post, which takes it up by its kind).
      heldPost: async (tx, w) => {
        await tx.query(
          `INSERT INTO homeroom_bot_posts (app_id, issue_number, kind, pending, created_at) VALUES ($1, $2, $3, TRUE, $4)`,
          [w.appId, w.issueNumber, w.kind, w.at]);
      },
    },
    transitions: {
      [NONE]: { Heard: keyed(heard), OfferTapped: owed.OfferTapped, Report: owed.Report, HeldAnswer: owed.HeldAnswer },
      quiet: { Heard: { to: heard }, Settled: { ignore: 'not_settling' }, ...owed },
      settling: { Heard: { to: heard }, Settled: { to: settled }, ...owed },
      answering: { Heard: { to: heard }, Settled: { ignore: 'answering' }, ...owed },
    } as any,
  });
}
