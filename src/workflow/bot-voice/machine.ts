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
import { BOT_LANE } from '../rules/bot-loop.ts';

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
// #6920: messages whose answer met OpenRouter's credit, and the people who
// asked, waiting for credit's return. One per burst that was held.
export interface Held { ids: number[]; speakers: number[]; sorry?: true }
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
  // Version 2 (20 Nov 2026): asks whose answer met OpenRouter's credit,
  // oldest first, answered here once credit is back (CreditBack).
  credit?: Held[];
  // Those asks, owed since credit came back: answered before any newer turn.
  resume?: Held[];
  // The ask the answering turn resumed, while it runs.
  resuming?: Held;
}
export type VState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<VState, { data: Data }>;

export interface Facts {
  // OfferTapped: the offer and where its message is, locked.
  offer: { id: number; app_id: number; kind: string; for_user_id: number | null; status: string; thread_type: string | null; thread_ref: number | null; message_app_id: number | null } | null;
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
    // #6211: `first` is an overlap note's third choice (build this one first).
    const choice = p?.choice === 'yes' ? 'yes' : p?.choice === 'no' ? 'no' : p?.choice === 'first' ? 'first' : null;
    if (!choice) throw new Error('choice must be yes or no');
    const rows = Array.isArray(p?.rows) ? p.rows.filter((r: unknown) => typeof r === 'string').slice(0, 12) : undefined;
    return { ...where(p), offerId: int(p?.offerId, 'offerId'), userId: int(p?.userId, 'userId'), choice, ...(rows ? { rows } : {}) };
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
  // #6920: OpenRouter's credit is back (the bot's lane, told by the credit
  // sweep): each ask kept for it is answered here, once.
  CreditBack: (p: any) => ({ ...where(p) }),
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

/**
 * Start a turn. `hold` resumes a kept ask: its own messages are answered and
 * `through` does not move; `again` stays, so a normal turn follows it.
 */
function turn(d: Data, ctx: TransitionContext, hold: Held | null = null): Outcome<VState> {
  const n = d.turns + 1;
  const work: WorkRequest[] = [{
    kind: WORK.turn, key: `turn:${n}`,
    input: {
      appId: d.appId, place: d.place as unknown as Json, through: d.through,
      sorry: hold ? !!hold.sorry : d.sorry,
      ...(hold ? { resume: { ids: hold.ids } } : {}),
    },
  }];
  const next: Data = hold
    ? { ...d, turns: n, first: null, resuming: hold }
    : { ...d, turns: n, first: null, again: false, resuming: undefined };
  return step('answering', next, { work, timer: null });
}

// The first ask credit's return owed, before any normal turn.
function nextTurn(d: Data, ctx: TransitionContext): Outcome<VState> {
  const [first, ...rest] = d.resume || [];
  if (first) return turn({ ...d, resume: rest }, ctx, first);
  return turn(d, ctx);
}

const settled = (s: VState, _e: Event<any>, _f: Facts, ctx: TransitionContext) => nextTurn((s as Live).data, ctx);

const ids = (v: unknown): number[] =>
  (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

// An ask answered since: the people it was for are dropped from what waits,
// so they are never answered twice. An entry with nobody left goes.
function dropSpeakers(list: Held[] | undefined, speakers: number[]): Held[] | undefined {
  if (!list?.length || !speakers.length) return list;
  const gone = new Set(speakers);
  return list.map((h) => ({ ...h, speakers: h.speakers.filter((s) => !gone.has(s)) }))
    .filter((h) => h.speakers.length > 0);
}

// After a turn: a kept ask credit's return owes goes first (keeping `again`,
// so the burst written to meanwhile gets its normal turn after it), then a
// turn that has to say sorry, then the burst settles, then quiet.
function after(d: Data, ctx: TransitionContext): Outcome<VState> {
  if ((d.resume || []).length) return nextTurn(d, ctx);
  if (d.sorry) return turn(d, ctx);
  if (d.again) {
    const first = ctx.now;
    return step('settling', { ...d, again: false, first: first.toISOString() },
      { timer: { at: settleAt(first, ctx.now), event: { type: 'Settled' } } });
  }
  return step('quiet', d, { timer: null });
}

// A turn's end: what it read through is the place's; anything written while
// it ran gets a turn of its own. A turn that met credit keeps its ask for the
// next return; a later turn by the same person drops their older one.
function turnEnded(status: 'done' | 'failed') {
  return (s: VState, e: Event<WorkResultPayload>, _f: Facts, ctx: TransitionContext): Outcome<VState> => {
    const d = (s as Live).data;
    const r = (e.payload.result || {}) as { throughId?: number; held?: any; speakerIds?: number[] };
    const held: Held | null = status === 'done' && r.held && ids(r.held.ids).length
      ? { ids: ids(r.held.ids), speakers: ids(r.held.speakers) } : null;
    const speakers = ids(r.speakerIds);
    const wasResume = !!d.resuming;
    const through = status === 'done' && !wasResume ? Math.max(d.through, Number(r.throughId) || 0) : d.through;
    const base: Data = { ...d, through, resuming: undefined };
    if (wasResume) {
      if (held) {
        // Still out of credit: the thread already says it, so nothing is
        // said again; it waits at the front of the next return's list.
        return after({ ...base, credit: [held, ...(base.credit || []), ...(base.resume || [])], resume: [] }, ctx);
      }
      if (status !== 'done' && d.resuming && !d.resuming.sorry) {
        // Failed for good: one more turn says sorry on the same messages.
        return turn(base, ctx, { ...d.resuming, sorry: true });
      }
      return after(base, ctx);
    }
    if (status === 'done') {
      let data: Data = {
        ...base, sorry: false,
        credit: dropSpeakers(base.credit, speakers),
        resume: dropSpeakers(base.resume, speakers),
      };
      if (held) data = { ...data, credit: [...(data.credit || []), held] };
      return after(data, ctx);
    }
    // Failed for good: whoever spoke to it hears sorry, once, in the next
    // turn (which runs now, or after a kept ask credit owes).
    return after({ ...base, sorry: !d.sorry }, ctx);
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
  // #6321: Propose to close under an "already works" note is offered to no one
  // person: any member may tap it. The route's membership gate and the act's
  // closeGate decide who that is. Every other offer is its one person's.
  const anyMember = o.for_user_id == null && o.kind === 'close_request';
  // #6211: the third choice belongs to an overlap note's buttons alone.
  if (e.payload.choice === 'first' && o.kind !== 'overlap') return reject('no_such_choice');
  if (!anyMember && Number(o.for_user_id) !== e.payload.userId) return reject('not_for_you');
  const d = s.name === NONE ? null : (s as Live).data;
  if (o.status !== 'open' || d?.taps[String(o.id)]) return reject('already_decided');
  return ok();
};
const tapped = (s: VState, e: Event<any>): Outcome<VState> => {
  const d = live(s, e);
  const key = `offer:${e.payload.offerId}`;
  return owe(s, e, { kind: WORK.act, key, input: { offerId: e.payload.offerId, userId: e.payload.userId, choice: e.payload.choice, key, ...(e.payload.rows ? { rows: e.payload.rows } : {}) } },
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
  // T1.8: an answer whose post ran out of tries was settled as failed (its
  // pending row removed: heldPostFailed), so the refresh decides it again;
  // it is owed once more, under a key of its own. Once: a second failure
  // keeps its row, which reads as said.
  const first = `held:${e.payload.mentionId}:${e.payload.kind}`;
  const before = live(s, e).notes[first];
  const key = before && (before.status === 'exhausted' || before.status === 'failed') ? `${first}:again` : first;
  const out = owe(s, e, {
    kind: WORK.post, key,
    input: { appId: e.payload.appId, issueNumber: e.payload.place.ref, kind: e.payload.kind, text: e.payload.text,
      mention: e.payload.mention, mentions: e.payload.mentions, mentionId: e.payload.mentionId, key },
  });
  if (!out.work?.length) return out;
  return { ...out, writes: [{ type: 'heldPost', appId: e.payload.appId, issueNumber: e.payload.place.ref, kind: e.payload.kind, mentionId: e.payload.mentionId, at: ctx.now.toISOString() }] };
};

// A held answer's work key: `held:<mention>:<kind>`, or its second try's.
const HELD_KEY = /^held:(\d+):(going_ahead|held_by_person)(:again)?$/;

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
      // T1.8: a held answer whose post failed for good is not left pending:
      // a pending row reads as said (homeroom-bot-holds.js answers), and the
      // mention would never be answered. Its row goes (when nothing of it
      // went out), so the next refresh decides it again; once.
      const h = HELD_KEY.exec(e.payload.workKey);
      if (status !== 'done' && e.payload.kind === WORK.post && h && !h[3] && d.place.type === 'issue') {
        return step(s.name as Name, { ...d, notes }, {
          writes: [{ type: 'heldPostFailed', appId: d.appId, issueNumber: d.place.ref, kind: h[2], mentionId: Number(h[1]) }],
        });
      }
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
// CreditBack: the bot's lane's message (bot-lane CreditBack), or the system.
const fromLane = (e: Event<any>): Check => ((e.source.kind === 'message' && e.source.from?.machine === BOT_LANE)
  || e.source.kind === 'system' ? ok() : reject('not_the_lane'));

// #6920: credit is back. Every ask kept for it is owed an answer, once, after
// the ones already owed. Answering or settling: it waits for the turn to end.
function creditBack(s: VState, _e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<VState> {
  const d = (s as Live).data;
  const owed = d.credit || [];
  if (!owed.length) return step(s.name as Name, d);
  const moved: Data = { ...d, credit: [], resume: [...(d.resume || []), ...owed] };
  if (s.name === 'quiet') return nextTurn(moved, ctx);
  return step(s.name as Name, moved);
}

async function readFacts(tx: Tx, event: Event<any>): Promise<Facts> {
  if (event.type !== 'OfferTapped') return NO_FACTS;
  const id = Number(event.payload?.offerId);
  // 5 Nov 2026: a thread's offers are Homeroom bot's cards (bot_cards). One
  // made before had its own table, read here until the last was 14 days old
  // (19 Nov 2026, homeroom-bot-voice.js OFFERS_SQL): it has no card now,
  // and the guard answers no_such_offer.
  const { rows: [card] } = await tx.query(
    `SELECT o.id, o.app_id, o.kind, o.user_id AS for_user_id, o.status, m.thread_type, m.thread_ref, m.app_id AS message_app_id
       FROM bot_cards o JOIN chat_messages m ON m.id = o.chat_message_id
      WHERE o.id = $1 AND o.place = 'thread' FOR UPDATE OF o`, [id]);
  return { offer: card || null };
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
    // 2 (20 Nov 2026): the asks kept for OpenRouter's credit (`credit`,
    // `resume`, `resuming`) and CreditBack. An older release leaves the
    // instances this one wrote alone.
    version: 2,
    events: EVENTS,
    create: CREATE,
    // What web appends: a message heard where the bot listens, and its offer tapped.
    web: ['Heard', 'OfferTapped'],
    decode: (row) => ({ name: row.state, data: row.data } as VState),
    facts: (tx: Tx, _state: VState, event: Event<any>) => readFacts(tx, event),
    authorize: {
      Heard: route,
      Settled: timer,
      OfferTapped: route,
      Report: system,
      HeldAnswer: system,
      CreditBack: fromLane,
    },
    writes: {
      // The held answer's post, claimed pending until voice.post has said it
      // (services/bot-post.js: its key, `<kind>:request:<app>-<n>:mention-<id>`,
      // which homeroom-bot-live.js post takes up).
      heldPost: async (tx, w) => {
        const subject = `request:${Number(w.appId)}-${Number(w.issueNumber)}`;
        const version = `mention-${Number(w.mentionId)}`;
        await tx.query(
          `INSERT INTO bot_posts (said_key, kind, subject, version, place_type, app_id, place_ref, issue_number, created_at)
           VALUES ($1, $2, $3, $4, 'issue', $5, $6::int, $6::int, $7)
           ON CONFLICT (said_key) DO NOTHING`,
          [`${w.kind}:${subject}:${version}`, w.kind, subject, version, w.appId, w.issueNumber, w.at]);
      },
      // T1.8: its post failed for good: the pending row goes, unless part of
      // it went out (a message, a GitHub comment), which reads as said.
      heldPostFailed: async (tx, w) => {
        const subject = `request:${Number(w.appId)}-${Number(w.issueNumber)}`;
        const version = `mention-${Number(w.mentionId)}`;
        await tx.query(
          `DELETE FROM bot_posts
            WHERE said_key = $1 AND outcome = 'pending' AND chat_message_id IS NULL AND github_comment_id IS NULL`,
          [`${w.kind}:${subject}:${version}`]);
      },
    },
    transitions: {
      [NONE]: {
        Heard: keyed(heard), OfferTapped: owed.OfferTapped, Report: owed.Report, HeldAnswer: owed.HeldAnswer,
        CreditBack: { ignore: 'nothing_owed' },
      },
      quiet: { Heard: { to: heard }, Settled: { ignore: 'not_settling' }, CreditBack: keyed(creditBack), ...owed },
      settling: { Heard: { to: heard }, Settled: { to: settled }, CreditBack: keyed(creditBack), ...owed },
      answering: { Heard: { to: heard }, Settled: { ignore: 'answering' }, CreditBack: keyed(creditBack), ...owed },
    } as any,
  });
}
