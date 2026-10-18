// bot-request: one request the Homeroom bot may look at, from the moment
// something owes it a look (the refresh found it new or changed, a person
// asked in a DM, a thread or on its page, its change's checks failed, main
// went red) to the look's end, and the build a ready look asks for. One
// instance per request (`request:<appId>:<issue>`), created by the first
// thing that owes it a look:
//
//   idle ──owed──▶ queued ──the lane grants a slot──▶ reading / following_up ──its look ends──▶ idle (or queued, owed again)
//                    ▲                                     │
//                    └──refused for now (backed off), a fault, the budget, a person writing during a read──┘
//   a ready verdict, or Build it ──▶ building ──the lane grants a build slot──▶ bot-build ──BuildEnded──▶ idle
//
// The queue row (homeroom_bot_queue) is its projection: there while
// something is owed or a look runs, `started_at` while it runs. Who may
// run how much at once is the lane's (bot-lane), which grants slots; the
// look itself is a resumable work item (bot.look: services/homeroom-bot.js
// lookAt) whose turn is followed through a restart and whose effects
// (the run, the spend, what it says and does) each happen once. A Stop of
// its turn, a person writing during a read, its request merged: each is
// an event here, and its turn is stopped by turn.stop (from any process).
// workflow-foundation's design-bot-loop.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, MessageRequest, Outcome, TransitionContext, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import {
  BOT_LANE, BOT_REQUEST, CHECKS_REASON, KEPT_WHILE_QUIET_REASONS, LANE_KEY, READ_AGAIN_REASON, RESTART_REASON,
  backoffMs, lookCardKey, parseRequestKey, requestKey,
} from '../rules/bot-loop.ts';
import { BOT_CHANGE, botChangeKey } from '../rules/bot-notes.ts';
import { turnStop } from '../rules/turn-stop.ts';
import { NO_FACTS, readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = BOT_REQUEST;
export { requestKey };
export const WORK = Object.freeze({
  look: 'bot.look',
  build: 'bot.build',
});
// The work kinds that run turns (a Stop's turn.stop ends one of these).
const TURN_KINDS = [WORK.look];
// How often a look an older release left is looked at again.
export const OLDER_LOOK_MS = 60 * 1000;

// ── State ───────────────────────────────────────────────────────────────

type Name = 'idle' | 'queued' | 'reading' | 'following_up' | 'building' | 'older_turn';
// What a look is owed for (the queue row's columns).
export interface Owed {
  reason: string;
  priority: number;
  payer: number | null;
  requestedBy: number | null;
  changedBy: string | null;
  threadSeenAt: string | null;
  enqueuedAt: string;
  heldUntil: string | null;
}
// A look under way: its work `look:<n>`, the slot the lane granted it, the
// session it runs on (its project's triage session, or its change's).
export interface Look {
  n: number;
  kind: 'read' | 'followUp';
  sessionId: number | null;
  owed: Owed;
  startedAt: string;
  // A person wrote on the request during a read: it is stopped and read
  // again, once (a read started over is never started over again).
  interrupted: boolean;
}
// `heldUntil`: its payer's week is spent; it waits for its slot from then.
export interface Build { runId: number; phase: 'waiting' | 'starting' | 'running'; since: string; key: string | null; heldUntil?: string | null }
export interface Slot { grant: number; kind: string; person: string; appId: number }
export interface Data {
  appId: number;
  issueNumber: number;
  owed: Owed | null;
  look: Look | null;
  build: Build | null;
  slot: Slot | null;
  // Looks so far (their work `look:<n>`), and builds started (`build:<b>`).
  n: number;
  b?: number;
  // A look refused for now (its change's session busy): waits, doubling.
  backoff: { failures: number; until: string; reason: string } | null;
  // A fix of its change's failing checks, asked by bot-change, unanswered.
  fix: { sessionId: number; head: string | null } | null;
  // A failed run whose retry found nothing to answer: not retried again.
  spentRetry: number | null;
  // The conversation the last read was in, continued by the next read.
  lastRead: Json | null;
  // What a read stopped for a person's message spent, carried to the next.
  carried: Json | null;
  // A look an older release claimed and may still run.
  older: { claimedAt: string } | null;
}
export type RState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<RState, { data: Data }>;

const LOOKING: ReadonlySet<string> = new Set(['reading', 'following_up']);

// ── Events ──────────────────────────────────────────────────────────────

const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
const optText = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const optTime = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const optSha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null);
const request = (p: any) => ({ appId: int(p?.appId, 'appId'), issueNumber: int(p?.issueNumber, 'issueNumber') });

const EVENTS = {
  // Something owes the request a look. `priority` 0 is a person's ask (it
  // goes first, and clears a hold); the refresh's are 1 (new), 2 (changed),
  // 3 (a failed read tried once more), 4 (an older request).
  Owed: (p: any) => {
    const reason = optText(p?.reason, 40);
    if (!reason) throw new Error('reason is required');
    const priority = Number.isInteger(p?.priority) && p.priority >= 0 && p.priority <= 9 ? p.priority as number : 2;
    return {
      ...request(p), reason, priority, payer: optInt(p?.payer), requestedBy: optInt(p?.requestedBy),
      changedBy: optText(p?.changedBy, 40), threadSeenAt: optTime(p?.threadSeenAt),
    };
  },
  // The refresh: the request is no longer owed a look (closed, held by a
  // person, unchanged). `quiet`: unchanged and nobody else's, so a debt the
  // bot owes itself (KEPT_WHILE_QUIET_REASONS) stays.
  NotOwed: (p: any) => ({ ...request(p), quiet: !!p?.quiet }),
  // A person wrote on the request's thread (stored in the same statement).
  Activity: (p: any) => ({ ...request(p), at: optTime(p?.at) }),
  // The lane's slot: a read or follow-up (its session), or a build.
  Granted: (p: any) => {
    const kind = ['read', 'followUp', 'build'].includes(p?.kind) ? p.kind as string : null;
    if (!kind) throw new Error('kind must be read, followUp or build');
    return { ...request(p), grant: int(p?.grant, 'grant'), kind, sessionId: optInt(p?.sessionId), person: optText(p?.person, 40) || 'a0' };
  },
  // A ready verdict's build is owed (the look's own act, or Build it).
  BuildOwed: (p: any) => ({ ...request(p), runId: int(p?.runId, 'runId') }),
  // bot-build: the build it asked for ended.
  BuildEnded: (p: any) => ({ id: int(p?.id, 'id'), outcome: optText(p?.outcome, 20) || 'done' }),
  // bot-change: its change's checks fail on `head`; a fix round is asked.
  FixAsked: (p: any) => ({ ...request(p), sessionId: int(p?.sessionId, 'sessionId'), head: optSha(p?.head) }),
  // bot-change, once its change merged: work it had started stops, and
  // what was owed before the merge is dropped.
  RequestMerged: (p: any) => ({ ...request(p), before: optTime(p?.before) }),
  // A person's Stop of the bot's turn on a session (the session's routes).
  StopRequested: (p: any) => ({ sessionId: optInt(p?.sessionId), by: optText(p?.by, 100) }),
  // The leader's boot: a queue row no instance holds (an older release's).
  Adopted: (p: any) => ({
    ...request(p), reason: optText(p?.reason, 40) || 'refresh', priority: Number.isInteger(p?.priority) ? p.priority as number : 2,
    payer: optInt(p?.payer), requestedBy: optInt(p?.requestedBy), changedBy: optText(p?.changedBy, 40),
    threadSeenAt: optTime(p?.threadSeenAt), enqueuedAt: optTime(p?.enqueuedAt), heldUntil: optTime(p?.heldUntil),
    startedAt: optTime(p?.startedAt),
  }),
  // Its clock: a hold, a backoff or an older release's look to look at again.
  Due: () => ({}),
};
const CREATE = ['Owed', 'Activity', 'BuildOwed', 'FixAsked', 'Adopted'];

// ── Helpers ─────────────────────────────────────────────────────────────

const step = (name: Name, data: Data, more: Omit<Outcome<RState>, 'next'> = {}): Outcome<RState> =>
  ({ next: { name, data }, ...more });
const later = (ctx: TransitionContext, ms: number) => new Date(ctx.now.getTime() + ms);
const iso = (ctx: TransitionContext) => ctx.now.toISOString();
const keyOf = (d: Data) => requestKey(d.appId, d.issueNumber);

const created = (e: Event<any>): Data => ({
  appId: e.payload.appId, issueNumber: e.payload.issueNumber, owed: null, look: null, build: null, slot: null, n: 0,
  backoff: null, fix: null, spentRetry: null, lastRead: null, carried: null, older: null,
});
const live = (s: RState, e: Event<any>): Data => (s.name === NONE ? created(e) : (s as Live).data);

// The lane, told to look again (a debt it may grant, a slot freed, a
// fault seen or ended, the budget reached).
const toLane = (type: string, payload: Record<string, Json> = {}, appId: number | null = null): MessageRequest =>
  ({ to: { machine: BOT_LANE, key: LANE_KEY }, event: { type, payload: payload as Json }, appId });
const look = (d: Data): MessageRequest => toLane('Look', {}, d.appId);

// A debt merged into the one owed already, as the queue's upsert did: a
// person's ask goes first (its reason, its payer, a hold cleared, its age
// now); the refresh's raise the priority and keep the reason of a person's
// ask or of a debt the bot owes itself.
function merged(old: Owed | null, p: any, ctx: TransitionContext): Owed {
  const fresh: Owed = {
    reason: p.reason, priority: p.priority, payer: p.payer ?? null, requestedBy: p.requestedBy ?? null,
    changedBy: p.changedBy ?? null, threadSeenAt: p.threadSeenAt ?? null, enqueuedAt: iso(ctx), heldUntil: null,
  };
  if (!old) return fresh;
  if (p.priority === 0) return { ...fresh, threadSeenAt: latest(old.threadSeenAt, fresh.threadSeenAt) };
  const keep = old.priority === 0 || KEPT_WHILE_QUIET_REASONS.has(old.reason);
  return {
    ...old,
    priority: Math.min(old.priority, p.priority),
    reason: keep ? old.reason : p.reason,
    changedBy: keep ? old.changedBy : (p.changedBy ?? old.changedBy),
    threadSeenAt: latest(old.threadSeenAt, fresh.threadSeenAt),
  };
}
function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// The deadline a queued debt waits for (a hold, a backoff), if any.
function waitUntil(d: Data): Date | null {
  const t = [d.owed?.heldUntil, d.backoff?.until].filter(Boolean).map((v) => Date.parse(v as string)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)) : null;
}

// Owed and waiting for a slot: the lane hears, and the instance's clock is
// set for a hold or a backoff ending.
function queue(d: Data, ctx: TransitionContext, more: Omit<Outcome<RState>, 'next'> = {}): Outcome<RState> {
  const until = waitUntil(d);
  const due = until && until.getTime() > ctx.now.getTime() ? { at: until, event: { type: 'Due' } } : null;
  return step('queued', d, { ...more, timer: due, messages: [...(more.messages || []), look(d)] });
}

// Where it goes when nothing runs: a build owed, a debt owed, or nothing.
function rest(d: Data, ctx: TransitionContext, more: Omit<Outcome<RState>, 'next'> = {}): Outcome<RState> {
  const base: Data = { ...d, look: null, slot: d.build?.phase === 'waiting' ? null : d.slot };
  if (base.build) return step('building', base, { ...more, timer: null, messages: [...(more.messages || []), look(base)] });
  if (base.owed) return queue(base, ctx, more);
  return step('idle', { ...base, backoff: null }, { ...more, timer: null });
}

// The fix bot-change asked, answered (once): how the round it asked for
// ended, or why it was not taken.
function answerFix(d: Data, outcome: string, more: { why?: string | null } = {}): { data: Data; messages: MessageRequest[] } {
  if (!d.fix) return { data: d, messages: [] };
  const payload: Record<string, Json> = { sessionId: d.fix.sessionId, head: d.fix.head, outcome };
  const type = outcome === 'refused' ? 'FixRefused' : 'FixRoundEnded';
  if (more.why) payload.why = more.why;
  return {
    data: { ...d, fix: null },
    messages: [{ to: { machine: BOT_CHANGE, key: botChangeKey(d.fix.sessionId) }, event: { type, payload: payload as Json }, appId: d.appId }],
  };
}

// The turn of the look under way stopped (only that one, by its record).
const stopLook = (d: Data, by: string | null, release: boolean, tag: string): WorkRequest | null =>
  (d.look?.sessionId
    ? turnStop({ sessionId: d.look.sessionId, machine: MACHINE, key: keyOf(d), kinds: TURN_KINDS, by, release }, tag)
    : null);

// ── Moves ───────────────────────────────────────────────────────────────

function owed(s: RState, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = live(s, e);
  const p = e.payload;
  // A fix asked by bot-change is a debt like the rest, at its priority.
  if (s.name === 'reading' || s.name === 'following_up' || s.name === 'older_turn' || s.name === 'building') {
    // While a look runs or a build is owed, only a person's ask, an ask for
    // its change, or a fix waits for after it: the refresh's own finds are
    // read again by the next refresh, from what the look recorded.
    if (p.priority !== 0 && p.reason !== CHECKS_REASON && p.reason !== 'voice_update') return step(s.name as Name, d);
    return step(s.name as Name, { ...d, owed: merged(d.owed, p, ctx) });
  }
  return queue({ ...d, owed: merged(d.owed, p, ctx) }, ctx);
}

function notOwed(s: Live, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = s.data;
  const o = d.owed;
  if (!o || o.priority === 0 || (e.payload.quiet && KEPT_WHILE_QUIET_REASONS.has(o.reason))) return step(s.name, d);
  // A debt it keeps (a fix bot-change is waiting on) is never pruned here.
  if (o.reason === CHECKS_REASON && d.fix) return step(s.name, d);
  if (s.name !== 'queued') return step(s.name, { ...d, owed: null });
  return rest({ ...d, owed: null, backoff: null }, ctx);
}

function activity(s: RState, e: Event<any>): Outcome<RState> {
  const d = live(s, e);
  if (s.name === 'reading' && d.look && d.look.kind === 'read' && !d.look.interrupted && d.look.owed.reason !== READ_AGAIN_REASON) {
    // The read answers the request as it was: stopped, and read again from
    // the start with what was just said (the look's work learns it from
    // its record, and from this instance, after its turn).
    const stop = stopLook(d, 'activity', false, `interrupt:${d.look.n}`);
    return step('reading', { ...d, look: { ...d.look, interrupted: true } }, { work: stop ? [stop] : [] });
  }
  if (s.name === NONE || s.name === 'idle') {
    // Nothing owed yet: the request's project is refreshed soon, which reads
    // whether what they wrote makes it owed (held by a person, closed, the
    // bot's own words are not a change).
    return step('idle', d, { messages: [toLane('RefreshAsked', { appId: d.appId }, d.appId)] });
  }
  // Queued: its burst settles on its own (the lane reads the thread);
  // anything else is a look the refresh brings back after.
  return step(s.name as Name, d);
}

function granted(s: Live, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = s.data;
  const p = e.payload;
  const slot: Slot = { grant: p.grant, kind: p.kind, person: p.person, appId: d.appId };
  if (p.kind === 'build') {
    if (s.name !== 'building' || !d.build || d.build.phase !== 'waiting') return step(s.name, d, { messages: [look(d)] });
    const b = (d.b || 0) + 1;
    const build: Build = { ...d.build, phase: 'starting' };
    return step('building', { ...d, b, slot, build }, {
      work: [{ kind: WORK.build, key: `build:${b}`, input: { appId: d.appId, issueNumber: d.issueNumber, runId: build.runId, n: b } }],
    });
  }
  if (s.name !== 'queued' || !d.owed) return step(s.name, d, { messages: [look(d)] });
  const n = d.n + 1;
  const kind = p.kind as 'read' | 'followUp';
  const lk: Look = { n, kind, sessionId: p.sessionId ?? null, owed: d.owed, startedAt: iso(ctx), interrupted: false };
  return step(kind === 'read' ? 'reading' : 'following_up', { ...d, n, slot, look: lk, owed: null }, {
    timer: null,
    work: [lookWork(d, lk)],
  });
}

function lookWork(d: Data, lk: Look): WorkRequest {
  return {
    kind: WORK.look,
    key: `look:${lk.n}`,
    input: {
      appId: d.appId, issueNumber: d.issueNumber, n: lk.n, kind: lk.kind, sessionId: lk.sessionId,
      owed: lk.owed as unknown as Json, carried: d.carried, lastRead: d.lastRead, spentRetry: d.spentRetry,
      fix: d.fix as unknown as Json,
    },
  };
}

// The look's work reported (services/homeroom-bot.js lookAt). `outcome`:
//   done        answered, or nothing to do; `build`: a ready verdict's run
//   failed      the model gave nothing usable (its run says so: a try spent)
//   busy        its change's session was taken (backed off; tries untouched)
//   fault       the platform failed under it (the lane pauses; untouched)
//   budget      the bot's weekly cap (the lane pauses; untouched)
//   held        its payer's week is spent: held until `until`
//   interrupted a person wrote during the read: read again, `carried` spent
//   requeue     to be looked at again later as `reason` / `priority`
// and with it: `owe` (debts the look leaves: a fix still due, asks to take
// again), `fix` (how the fix bot-change asked for came out: `outcome`,
// `why`), `lastRead` (the conversation to continue), `spentRetry`.
function lookEnded(s: Live, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = s.data;
  const lk = d.look!;
  const failed = e.type !== 'WorkSucceeded';
  const r = ((failed ? { outcome: 'fault', error: (e.payload as WorkResultPayload).error?.message ?? null }
    : (e.payload as WorkResultPayload).result) || {}) as any;
  const outcome = String(r.outcome || 'done');
  if (outcome === 'interrupted') {
    // Read again at once, from the start, what the read spent carried.
    const n = d.n + 1;
    const again: Look = { n, kind: 'read', sessionId: lk.sessionId, owed: { ...lk.owed, reason: READ_AGAIN_REASON }, startedAt: iso(ctx), interrupted: false };
    const next: Data = { ...d, n, look: again, carried: (r.carried as Json) ?? null };
    return step('reading', next, { work: [lookWork(next, again)] });
  }
  let back: Owed | null = null;
  let lane: Record<string, Json> = { ran: true };
  let backoff = null as Data['backoff'];
  switch (outcome) {
    case 'busy': {
      const failures = (d.backoff?.failures || 0) + 1;
      back = lk.owed;
      backoff = { failures, until: later(ctx, backoffMs(failures)).toISOString(), reason: String(r.error || 'session_busy').slice(0, 64) };
      lane = {};
      break;
    }
    case 'fault': back = lk.owed; lane = { fault: true }; break;
    case 'budget': back = lk.owed; lane = { budget: true }; break;
    case 'held': {
      back = { ...lk.owed, heldUntil: optTime(r.until) || later(ctx, 7 * 24 * 3600 * 1000).toISOString() };
      lane = {};
      break;
    }
    case 'requeue':
      back = { ...lk.owed, reason: optText(r.reason, 40) || lk.owed.reason,
        priority: Number.isInteger(r.priority) ? r.priority : lk.owed.priority, enqueuedAt: iso(ctx) };
      break;
    default: break;
  }
  let owedNext = combine(back, d.owed);
  for (const debt of Array.isArray(r.owe) ? r.owe : []) {
    if (debt && typeof debt.reason === 'string') owedNext = merged(owedNext, { priority: 2, ...debt }, ctx);
  }
  const runId = Number.isInteger(r.build) ? r.build as number : null;
  let next: Data = {
    ...d, look: null, slot: null, carried: null, owed: owedNext,
    backoff: backoff ?? (outcome === 'fault' || outcome === 'budget' || outcome === 'held' ? d.backoff : null),
    lastRead: r.lastRead !== undefined ? (r.lastRead as Json) : d.lastRead,
    spentRetry: Number.isInteger(r.spentRetry) ? r.spentRetry : d.spentRetry,
    build: runId && (!d.build || d.build.phase === 'waiting') ? { runId, phase: 'waiting', since: iso(ctx), key: null } : d.build,
  };
  // The fix bot-change asked for: answered with how the look took it, or,
  // once nothing owes the request a fix any more, as lost (bot-change asks
  // once more, then gives up: step 8's rule).
  let messages: MessageRequest[] = [toLane('Released', lane, d.appId)];
  if (d.fix) {
    if (r.fix && typeof r.fix.outcome === 'string') {
      const fx = answerFix(next, String(r.fix.outcome), { why: r.fix.why ? String(r.fix.why) : null });
      next = fx.data;
      messages = [...messages, ...fx.messages];
    } else if (!['busy', 'fault', 'budget', 'held'].includes(outcome) && next.owed?.reason !== CHECKS_REASON) {
      const fx = answerFix(next, 'lost');
      next = fx.data;
      messages = [...messages, ...fx.messages];
    }
  }
  return rest(next, ctx, { messages });
}

// A debt put back, with one owed meanwhile: a person's ask goes first; else
// the one put back keeps its place in line.
function combine(a: Owed | null, b: Owed | null): Owed | null {
  if (!a) return b;
  if (!b) return a;
  if (b.priority === 0) return { ...b, threadSeenAt: latest(a.threadSeenAt, b.threadSeenAt) };
  return { ...a, priority: Math.min(a.priority, b.priority), threadSeenAt: latest(a.threadSeenAt, b.threadSeenAt) };
}

function buildOwed(s: RState, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = live(s, e);
  const runId = e.payload.runId as number;
  if (d.build && d.build.runId === runId) return step(s.name === NONE ? 'building' : (s.name as Name), d);
  if (d.build && d.build.phase !== 'waiting') return step(s.name as Name, d);
  const build: Build = { runId, phase: 'waiting', since: iso(ctx), key: null };
  if (LOOKING.has(s.name as string) || s.name === 'older_turn') return step(s.name as Name, { ...d, build });
  return step('building', { ...d, build }, { timer: null, messages: [look(d)] });
}

function buildEnded(s: Live, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = s.data;
  if (!d.build || d.build.runId !== e.payload.id) return step(s.name, d);
  return rest({ ...d, build: null, slot: null }, ctx, { messages: [toLane('Released', { ran: true }, d.appId)] });
}

// The build's start reported: requested from bot-build (it tells this
// instance its end), or skipped (nothing to build any more), or held back
// (the budget, a fault: waits for its slot again).
function buildStarted(s: Live, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = s.data;
  if (!d.build) return step(s.name, d);
  const r = (e.type === 'WorkSucceeded' ? (e.payload as WorkResultPayload).result : { outcome: 'fault' }) as any || {};
  if (r.outcome === 'requested' && typeof r.key === 'string') {
    return step('building', { ...d, build: { ...d.build, phase: 'running', key: r.key } });
  }
  if (r.outcome === 'held') {
    const until = optTime(r.until) || later(ctx, 7 * 24 * 3600 * 1000).toISOString();
    return step('building', { ...d, slot: null, build: { ...d.build, phase: 'waiting', heldUntil: until } },
      { timer: { at: new Date(until), event: { type: 'Due' } }, messages: [toLane('Released', {}, d.appId)] });
  }
  if (r.outcome === 'fault' || r.outcome === 'budget' || r.outcome === 'not_started') {
    return step('building', { ...d, slot: null, build: { ...d.build, phase: 'waiting' } },
      { messages: [toLane('Released', r.outcome === 'budget' ? { budget: true } : r.outcome === 'fault' ? { fault: true } : {}, d.appId)] });
  }
  return rest({ ...d, build: null, slot: null }, ctx, { messages: [toLane('Released', {}, d.appId)] });
}

function fixAsked(s: RState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d0 = live(s, e);
  const p = e.payload;
  // The bot is off, or not working on this project: bot-change hears it
  // at once, and asks again on its next verdict.
  if (!f.acting) {
    const fx = answerFix({ ...d0, fix: { sessionId: p.sessionId, head: p.head } }, 'refused', { why: 'off' });
    return step(s.name === NONE ? 'idle' : (s.name as Name), fx.data, { messages: fx.messages });
  }
  const d: Data = { ...d0, fix: { sessionId: p.sessionId, head: p.head } };
  const debt = { reason: CHECKS_REASON, priority: 1, payer: null, requestedBy: null, changedBy: null, threadSeenAt: null };
  if (s.name === 'queued') {
    // A hold for its payer's week does not hold an uncharged fix (trace L7).
    const o = merged(d.owed, debt, ctx);
    return queue({ ...d, owed: { ...o, heldUntil: null } }, ctx);
  }
  if (LOOKING.has(s.name as string) || s.name === 'building' || s.name === 'older_turn') {
    return step(s.name as Name, { ...d, owed: merged(d.owed, debt, ctx) });
  }
  return queue({ ...d, owed: merged(null, debt, ctx) }, ctx);
}

function requestMerged(s: Live, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = s.data;
  const before = e.payload.before ? Date.parse(e.payload.before) : ctx.now.getTime();
  const dropped = d.owed && d.owed.priority > 0 && Date.parse(d.owed.enqueuedAt) <= before ? null : d.owed;
  const messages: MessageRequest[] = [];
  const work: WorkRequest[] = [];
  const cancel: { kind: string; key: string }[] = [];
  let next: Data = { ...d, owed: dropped };
  // Its build under way stops (bot-build ends it and tells this instance).
  if (d.build?.phase === 'running' && d.build.key) {
    messages.push({ to: { machine: 'bot-build', key: d.build.key }, event: { type: 'StopRequested', payload: { by: null } }, appId: d.appId });
  } else if (d.build && d.build.phase !== 'running') {
    if (d.build.phase === 'starting') cancel.push({ kind: WORK.build, key: `build:${d.b || 0}` });
    next = { ...next, build: null };
    if (d.slot?.kind === 'build') { next = { ...next, slot: null }; messages.push(toLane('Released', {}, d.appId)); }
  }
  // A look that started before the merge stops with it.
  if (LOOKING.has(s.name) && d.look && Date.parse(d.look.startedAt) <= before) {
    cancel.push({ kind: WORK.look, key: `look:${d.look.n}` });
    const stop = stopLook(d, null, true, `merged:${d.look.n}`);
    if (stop) work.push(stop);
    const fx = answerFix({ ...next, slot: null }, 'stopped');
    messages.push(toLane('Released', {}, d.appId), ...fx.messages);
    return rest(fx.data, ctx, { messages, work, cancel });
  }
  if (s.name === 'queued' && !next.owed) return rest(next, ctx, { messages, work, cancel });
  if (s.name === 'building' && !next.build) return rest(next, ctx, { messages, work, cancel });
  return step(s.name, next, { messages, work, cancel });
}

function stopRequested(s: Live, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = s.data;
  const by = e.payload.by ?? e.actor ?? null;
  if (LOOKING.has(s.name) && d.look && (!e.payload.sessionId || e.payload.sessionId === d.look.sessionId)) {
    // Stopped by a person: the look ends there, and what it was owed is
    // not taken again until something owes it again.
    const stop = stopLook(d, by, true, `stop:${d.look.n}`);
    const fx = answerFix({ ...d, slot: null, look: null }, 'stopped');
    return rest({ ...fx.data, owed: null, backoff: null }, ctx, {
      cancel: [{ kind: WORK.look, key: `look:${d.look.n}` }],
      work: stop ? [stop] : [],
      messages: [toLane('Released', {}, d.appId), ...fx.messages],
    });
  }
  if (s.name === 'building' && d.build?.phase === 'running' && d.build.key) {
    return step(s.name, d, { messages: [{ to: { machine: 'bot-build', key: d.build.key }, event: { type: 'StopRequested', payload: { sessionId: e.payload.sessionId, by } as Json }, appId: d.appId }] });
  }
  return step(s.name, d);
}

function adopted(s: RState, e: Event<any>, _f: Facts, ctx: TransitionContext): Outcome<RState> {
  if (s.name !== NONE) return step(s.name as Name, (s as Live).data);
  const p = e.payload;
  const d: Data = { ...created(e), owed: {
    reason: p.reason, priority: p.priority, payer: p.payer, requestedBy: p.requestedBy, changedBy: p.changedBy,
    threadSeenAt: p.threadSeenAt, enqueuedAt: p.enqueuedAt || iso(ctx), heldUntil: p.heldUntil,
  } };
  // Claimed by an older release: its look may still run (a draining Pod's),
  // or have ended without its last word. Looked at until it is over.
  if (p.startedAt) {
    return step('older_turn', { ...d, older: { claimedAt: p.startedAt } }, { timer: { at: ctx.now, event: { type: 'Due' } } });
  }
  return queue(d, ctx);
}

function due(s: Live, _e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<RState> {
  const d = s.data;
  if (s.name === 'queued') return queue(d, ctx);
  // A build's hold ended: the lane looks again.
  if (s.name === 'building') return step('building', d, { timer: null, messages: [look(d)] });
  if (s.name !== 'older_turn' || !d.older) return step(s.name, d, { timer: null });
  if (f.olderBusy) return step('older_turn', d, { timer: { at: later(ctx, OLDER_LOOK_MS), event: { type: 'Due' } } });
  // Over: the request is read again (quietly: a restart's reason says no
  // "looking" twice). What that older look said, it said; what it did not
  // say (its last write refused by this machine's guard), this read says.
  return queue({ ...d, older: null, owed: d.owed ? { ...d.owed, reason: RESTART_REASON } : null }, ctx);
}

function workDone(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<RState> {
  const p = e.payload as WorkResultPayload;
  const d = s.data;
  if (p.kind === WORK.look && d.look && p.workKey === `look:${d.look.n}` && LOOKING.has(s.name)) {
    return lookEnded(s, e, f, ctx);
  }
  if (p.kind === WORK.build && s.name === 'building' && p.workKey === `build:${d.b || 0}`) return buildStarted(s, e, f, ctx);
  // A turn.stop, or a result the instance no longer waits for.
  return step(s.name, d);
}

// ── The machine ─────────────────────────────────────────────────────────

const fromLane = (e: Event<any>): Check => (e.source.kind === 'message' && e.source.from.machine === BOT_LANE ? ok() : reject('not_the_lane'));
const fromBuild = (e: Event<any>): Check => (e.source.kind === 'message' && e.source.from.machine === 'bot-build' ? ok() : reject('not_the_build'));
const fromChange = (e: Event<any>): Check => ((e.source.kind === 'message' && e.source.from.machine === BOT_CHANGE)
  || e.source.kind === 'system' || e.source.kind === 'service' ? ok() : reject('not_the_change'));
const anyProducer = (e: Event<any>): Check => (['route', 'system', 'service', 'admin', 'message'].includes(e.source.kind) ? ok() : reject('not_a_producer'));

export interface Deps { staging: boolean }

const keyMatches = (e: Event<any>, ctx: TransitionContext): Check => {
  if (!('appId' in (e.payload || {}))) return ok();
  return ctx.key === requestKey(e.payload.appId, e.payload.issueNumber) ? ok() : reject('key_mismatch');
};

export function botRequest(deps: Deps = { staging: false }) {
  const live = (to: (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<RState>) =>
    ({ guard: (_s: Live, e: Event<any>, _f: Facts, ctx: TransitionContext) => keyMatches(e, ctx), to });
  const any = (to: (s: RState, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<RState>) =>
    ({ guard: (_s: RState, e: Event<any>, _f: Facts, ctx: TransitionContext) => keyMatches(e, ctx), to });
  const row = {
    Owed: any(owed), NotOwed: live(notOwed), Activity: any(activity), Granted: live(granted), BuildOwed: any(buildOwed),
    BuildEnded: live(buildEnded), FixAsked: any(fixAsked), RequestMerged: live(requestMerged), StopRequested: live(stopRequested),
    Adopted: any(adopted), Due: live(due),
    WorkSucceeded: live(workDone), WorkFailed: live(workDone), WorkExhausted: live(workDone),
  };
  const states: Name[] = ['idle', 'queued', 'reading', 'following_up', 'building', 'older_turn'];
  const transitions: Record<string, Record<string, any>> = Object.fromEntries(states.map((n) => [n, row]));
  transitions[NONE] = {
    Owed: any(owed), Activity: any(activity), BuildOwed: any(buildOwed), FixAsked: any(fixAsked), Adopted: any(adopted),
    NotOwed: { ignore: 'not_owed' }, Granted: { ignore: 'not_owed' }, BuildEnded: { ignore: 'not_building' },
    RequestMerged: { ignore: 'nothing_owed' }, StopRequested: { ignore: 'not_looking' }, Due: { ignore: 'gone' },
    '*': { ignore: 'not_owed' },
  };
  return defineMachine<RState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: CREATE,
    decode: (r) => ({ name: r.state as Name, data: r.data as Data }),
    facts: async (tx, s, e, ctx) => {
      const key = parseRequestKey(ctx.key);
      if (!key) return NO_FACTS;
      const data = s.name === NONE ? null : (s as Live).data;
      if (e.type !== 'FixAsked' && !(e.type === 'Due' && s.name === 'older_turn')) return NO_FACTS;
      return readFacts(tx, { ...key, staging: deps.staging, older: data?.older ?? null, wantActing: e.type === 'FixAsked' });
    },
    authorize: {
      Owed: anyProducer, NotOwed: anyProducer, Activity: anyProducer, Granted: fromLane, BuildOwed: anyProducer,
      BuildEnded: fromBuild, FixAsked: fromChange, RequestMerged: anyProducer, Adopted: anyProducer,
      StopRequested: (e) => (['route', 'system', 'admin'].includes(e.source.kind) ? ok() : reject('not_a_producer')),
      Due: (e) => (e.source.kind === 'timer' ? ok() : reject('not_the_clock')),
    },
    transitions: transitions as any,
    // A debt's answer (enqueueFront's callers): whether it waits its turn
    // (and the key its look's card will have), or a look already runs and
    // takes it after.
    reply: async (_tx, e, after) => {
      if (e.type !== 'Owed' || after.name === NONE) return undefined;
      const d = (after as Live).data;
      const queued = after.name === 'queued';
      return { queued, looking: LOOKING.has(after.name) || after.name === 'older_turn',
        jobKey: queued ? lookCardKey(d.appId, d.issueNumber, d.n + 1) : null };
    },
    project: async (tx, before, after) => {
      if (after.name === NONE) return;
      const d = (after as Live).data;
      const looking = LOOKING.has(after.name) || after.name === 'older_turn';
      const o = looking ? (d.look?.owed ?? d.owed) : d.owed;
      if (!o) {
        await tx.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [d.appId, d.issueNumber]);
        return;
      }
      const started = after.name === 'older_turn' ? d.older?.claimedAt ?? null : looking ? d.look?.startedAt ?? null : null;
      await tx.query(
        `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, thread_seen_at, requested_by, enqueued_at,
                                         started_at, held_until, payer_user_id, changed_by, wait_reason, wait_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (app_id, issue_number) DO UPDATE SET
           priority = EXCLUDED.priority, reason = EXCLUDED.reason, thread_seen_at = EXCLUDED.thread_seen_at,
           requested_by = EXCLUDED.requested_by, enqueued_at = EXCLUDED.enqueued_at, started_at = EXCLUDED.started_at,
           held_until = EXCLUDED.held_until, payer_user_id = EXCLUDED.payer_user_id, changed_by = EXCLUDED.changed_by,
           wait_reason = EXCLUDED.wait_reason, wait_until = EXCLUDED.wait_until`,
        [d.appId, d.issueNumber, o.priority, o.reason, o.threadSeenAt, o.requestedBy, o.enqueuedAt, started, o.heldUntil,
          o.payer, o.changedBy, looking ? null : d.backoff?.reason ?? null, looking ? null : d.backoff?.until ?? null]);
      void before;
    },
  });
}
