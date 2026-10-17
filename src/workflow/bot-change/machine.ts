// bot-change: one of the Homeroom bot's changes, from the moment it goes up
// for a vote until it is live or closed. One instance per change
// (`session:<id>`), created by the first thing a machine tells it: the
// proposal machine's promote (Proposed), the preview's verdict, the shots
// settling, the merge (each a message the sender's own transition writes:
// rules/bot-notes.ts), or the leader's adoption of a change an older
// release proposed.
//
//   checking ──verdict passes, shots still to come──▶ waiting_on_shots ──settled / held long enough──▶ ready
//      │   └──part of it fails (checks, or its shots)──▶ with_the_bot ──the bot's round looked──▶ ready
//      └──its preview will not start──▶ stopped          merged ──live──▶ live        (any) ──closed──▶ closed
//
// Under its lock it decides what its requester and its approvers hear and
// when the change goes back to the bot to fix: ready to try, once per
// approval epoch (and its approvers asked once, when nothing is broken);
// back to the bot when its checks fail or its shots show part of it failing
// or could not reach part of it for want of seed data, once per head; and,
// once merged and live, that it is live. Every decision is made from the
// session's row (facts.ts) with the transaction's clock, so a message is
// only "look now": a late or repeated one decides the same thing again.
// Its work only sends (services.ts), each item keyed so it is said once.
// workflow-foundation's design-bot-notes.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, Machine, Outcome, Push, TransitionContext, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { toUser } from '../pushes.ts';
import { BOT_CHANGE, botChangeKey } from '../rules/bot-notes.ts';
import { checksDue, readiness } from '../rules/bot-readiness.ts';
import type { Claim } from '../rules/bot-readiness.ts';
import { NO_FACTS, readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = BOT_CHANGE;
export const sessionKey = botChangeKey;
export const WORK = Object.freeze({
  ready: 'bot.tellReady',
  stopped: 'bot.tellStopped',
  fix: 'bot.queueFix',
  needsLook: 'bot.needsLook',
  merged: 'bot.stopRequestWork',
  liveDm: 'bot.tellLive',
  livePost: 'bot.commentLive',
});
// How often a change handed back to the bot is looked at while the bot has
// not said its round looked at the head (FixRoundEnded, a speed-up): its
// queue row still there means the round is waiting or under way; gone with
// nothing recorded, the round was lost (a follow-up that ended without it,
// a release), and it is asked once more (Q3), then the change is ready with
// what does not work.
export const FIX_LOOK_MS = 10 * 60 * 1000;
export const FIX_ROUNDS = 2;

// ── State ───────────────────────────────────────────────────────────────

type Name = 'checking' | 'waiting_on_shots' | 'with_the_bot' | 'ready' | 'stopped' | 'merged' | 'live' | 'closed';
// A work item and what came of it, for Admin → Workflows' retry.
interface Note { kind: string; input: Json; status: 'pending' | 'done' | 'failed' | 'exhausted' | 'retried'; error?: string }
export interface Data {
  sessionId: number;
  appId: number;
  // The epoch whose ready card was asked for, and the one whose "needs a
  // look" was (failing checks the bot does not fix).
  told: number | null;
  toldLook: number | null;
  stoppedEpoch: number | null;
  // Handed back to the bot for this head: how many rounds were asked, and
  // why the bot would not take it (`refused`: off, not on this app, the
  // platform's failure), or that it gave up waiting (`gaveUp`).
  fix: { head: string; n: number; refused: string | null; gaveUp: boolean } | null;
  notes: Record<string, Note>;
}
export type BState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<BState, { data: Data }>;

const FINAL: ReadonlySet<string> = new Set(['live', 'closed']);
const UP: ReadonlySet<string> = new Set(['promoted', 'merging', 'merged']);

// ── Events ──────────────────────────────────────────────────────────────

const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optSha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const session = (p: any) => ({ sessionId: int(p?.sessionId, 'sessionId') });

const EVENTS = {
  Proposed: session,
  Verdict: (p: any) => ({ ...session(p), head: optSha(p?.head), state: text(p?.state, 32) }),
  ShotsSettled: session,
  PreviewStopped: (p: any) => ({ ...session(p), head: optSha(p?.head) }),
  FixRoundEnded: (p: any) => ({ ...session(p), head: optSha(p?.head) }),
  Merged: (p: any) => ({ ...session(p), before: text(p?.before, 40) }),
  Live: session,
  Closed: (p: any) => ({ ...session(p), reason: text(p?.reason, 64) }),
  Look: () => ({}),
  RetryFollowup: (p: any) => {
    if (typeof p?.workKey !== 'string' || !p.workKey) throw new Error('workKey is required');
    return { workKey: p.workKey as string };
  },
};
// Whatever tells it about a change first creates it (a verdict can be
// heard before the promote's own message, a merge of a change an older
// release proposed before its adoption).
const CREATE = ['Proposed', 'Verdict', 'ShotsSettled', 'PreviewStopped', 'FixRoundEnded', 'Merged', 'Live'];

// ── Moves ───────────────────────────────────────────────────────────────

const step = (name: Name, data: Data, more: Omit<Outcome<BState>, 'next'> = {}): Outcome<BState> =>
  ({ next: { name, data }, ...more });

// Work, recorded as a note so an admin can ask for it again.
function asked(d: Data, work: WorkRequest[]): Data {
  if (!work.length) return d;
  const notes = { ...d.notes };
  for (const w of work) notes[w.key] = { kind: w.kind, input: w.input, status: 'pending' };
  return { ...d, notes };
}

// The tray of whoever asked for it reads again (homeroom-bot-tray.js: the
// strip in their chat with the bot; it reads its records on the event).
const tray = (f: Facts): Push[] => (f.requesterId ? [toUser(f.requesterId, { type: 'homeroom_bot_work_changed' })] : []);

const words = (claims: Claim[]) => claims.map((c) => c.claim).filter(Boolean).slice(0, 3);
const shortSha = (sha: string) => sha.slice(0, 12);

// What the change's row says now, decided once: the one rule every look
// runs (a verdict, the shots settling, the bot's round, the clock, the
// promote). A change not up for a vote waits for its promote; one merged
// waits for its live.
function decide(s: Live | null, f: Facts, ctx: TransitionContext, base: Data, extra: { push?: Push[] } = {}): Outcome<BState> {
  const row = f.row!;
  let d = base;
  const now = ctx.now.getTime();
  const at = (name: Name, more: Omit<Outcome<BState>, 'next'> = {}) => step(name, d, { push: extra.push, ...more });
  if (row.status === 'merging' || row.status === 'merged') return at(row.status === 'merged' ? 'merged' : (s?.name as Name) || 'checking', { timer: null });
  if (row.status !== 'promoted') return at('checking', { timer: null });
  const r = readiness(row, now);
  const due = checksDue({ ...row, looked: f.looked, fix_revised: f.fixRevised });
  const fixHere = d.fix && due && d.fix.head === due.head ? d.fix : null;
  // Its shots on the head still to come: it waits, at most READY_HOLD_MS
  // after the later of the verdict and the slot's last move.
  if (r.checked && r.heldUntil != null) {
    return at('waiting_on_shots', { timer: { at: new Date(r.heldUntil + 1000), event: { type: 'Look' } } });
  }
  // Part of it fails, and no round looked at this head yet: it goes back to
  // the bot, once per head (its round revises it, a new head, or records it
  // looked), unless the bot would not take it or gave up waiting.
  // (With its checks passed, what is due is what its shots show.)
  const wantsFix = !!due;
  if (wantsFix && !(fixHere && (fixHere.refused || fixHere.gaveUp))) {
    if (fixHere && fixHere.n > 0) {
      // Asked already: waiting for the round.
      return at('with_the_bot', { timer: { at: new Date(now + FIX_LOOK_MS), event: { type: 'Look' } } });
    }
    return askFix(d, due!.head, 1, ctx, extra);
  }
  if (!r.checked) {
    // Failing checks the bot will not fix, or gave up waiting on: its
    // requester hears it needs a look, once per epoch.
    if (wantsFix && fixHere && d.toldLook !== r.epoch) {
      const work: WorkRequest[] = [{ kind: WORK.needsLook, key: `needs-look:${r.epoch}`, input: { sessionId: d.sessionId, epoch: r.epoch } }];
      d = asked({ ...d, toldLook: r.epoch }, work);
      return at('ready', { work, timer: null });
    }
    return at('checking', { timer: null });
  }
  // Ready to try: said once per epoch, saying what does not work.
  if (d.told === r.epoch) return at('ready', { timer: null });
  const broken = words(r.broken);
  const work: WorkRequest[] = [{ kind: WORK.ready, key: `ready:${r.epoch}`,
    input: { sessionId: d.sessionId, epoch: r.epoch, broken } }];
  d = asked({ ...d, told: r.epoch }, work);
  return at('ready', { work, timer: null });
}

function askFix(base: Data, head: string, n: number, ctx: TransitionContext, extra: { push?: Push[] } = {}): Outcome<BState> {
  const work: WorkRequest[] = [{ kind: WORK.fix, key: `fix:${shortSha(head)}:${n}`, input: { sessionId: base.sessionId, head } }];
  const d = asked({ ...base, fix: { head, n, refused: null, gaveUp: false } }, work);
  return step('with_the_bot', d, { work, push: extra.push, timer: { at: new Date(ctx.now.getTime() + FIX_LOOK_MS), event: { type: 'Look' } } });
}

// The clock while the bot has its change: its round looked (decide), is
// waiting or under way (its queue row is there), or was lost: asked once
// more, then given up on.
function looked(s: Live, f: Facts, ctx: TransitionContext): Outcome<BState> {
  const fix = s.data.fix;
  if (s.name !== 'with_the_bot' || !fix || f.looked || !f.row || f.row.status !== 'promoted') return decide(s, f, ctx, s.data);
  const due = checksDue({ ...f.row, looked: f.looked, fix_revised: f.fixRevised });
  if (!due || due.head !== fix.head) return decide(s, f, ctx, s.data);
  if (f.queued) return step('with_the_bot', s.data, { timer: { at: new Date(ctx.now.getTime() + FIX_LOOK_MS), event: { type: 'Look' } } });
  if (fix.n < FIX_ROUNDS) return askFix(s.data, fix.head, fix.n + 1, ctx);
  return decide(s, f, ctx, { ...s.data, fix: { ...fix, gaveUp: true } });
}

function created(e: Event<any>, f: Facts): Data {
  return { sessionId: e.payload.sessionId, appId: f.row!.app_id, told: null, toldLook: null, stoppedEpoch: null, fix: null, notes: {} };
}

// A look from anything that tells it: a verdict, a settle, a round that
// ended, the promote, the clock.
function look(s: BState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<BState> {
  const live = s.name === NONE ? null : (s as Live);
  const d = live ? live.data : created(e, f);
  const push = e.type === 'Proposed' ? tray(f) : undefined;
  if (live && live.name === 'with_the_bot' && (e.type === 'Look' || e.type === 'FixRoundEnded')) return looked(live, f, ctx);
  return decide(live, f, ctx, d, { push });
}

function stopped(s: BState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<BState> {
  const live = s.name === NONE ? null : (s as Live);
  const d = live ? live.data : created(e, f);
  const epoch = Number(f.row!.approval_epoch) || 0;
  if (f.row!.status !== 'promoted' || d.stoppedEpoch === epoch) return step((live?.name as Name) || 'checking', d);
  const work: WorkRequest[] = [{ kind: WORK.stopped, key: `stopped:${epoch}`, input: { sessionId: d.sessionId, epoch } }];
  return step('stopped', asked({ ...d, stoppedEpoch: epoch }, work), { work, timer: null });
}

// Merged: the bot's other work on the same request stops, bounded to what
// started before the merge. Then it waits to be live.
function merged(s: BState, e: Event<any>, f: Facts): Outcome<BState> {
  const live = s.name === NONE ? null : (s as Live);
  const d = live ? live.data : created(e, f);
  const work: WorkRequest[] = [{ kind: WORK.merged, key: 'merged', input: { sessionId: d.sessionId, before: e.payload.before } }];
  return step('merged', asked(d, work), { work, timer: null });
}

// Live: whoever asked hears it (their DM, the chip, a first version's line),
// and the request says it (GitHub and its thread). A change that went live
// with no Merged first (an included change, a change adopted late) stops the
// bot's other work on its request too.
function wentLive(s: BState, e: Event<any>, f: Facts): Outcome<BState> {
  const live = s.name === NONE ? null : (s as Live);
  const d = live ? live.data : created(e, f);
  const work: WorkRequest[] = [
    { kind: WORK.liveDm, key: 'live-dm', input: { sessionId: d.sessionId } },
    { kind: WORK.livePost, key: 'live-post', input: { sessionId: d.sessionId } },
  ];
  if (!d.notes.merged) work.push({ kind: WORK.merged, key: 'merged', input: { sessionId: d.sessionId, before: null } });
  return step('live', asked(d, work), { work, timer: null });
}

function closed(s: Live, e: Event<any>, f: Facts): Outcome<BState> {
  return step('closed', s.data, { push: tray(f), timer: null });
}

// A work result: recorded on its note. The fix the bot would not take, or
// the clock's answer that it gave up, is decided again.
function workResult(status: Note['status']) {
  return {
    guard: (s: BState, e: Event<WorkResultPayload>): Check =>
      ((s as Live).data.notes[e.payload.workKey]?.status === 'pending' ? ok() : reject('stale_result')),
    to: (s: BState, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<BState> => {
      const live = s as Live;
      const prev = live.data.notes[e.payload.workKey]!;
      const notes = { ...live.data.notes, [e.payload.workKey]: { ...prev, status, ...(e.payload.error ? { error: e.payload.error.message.slice(0, 500) } : {}) } };
      let d: Data = { ...live.data, notes };
      if (e.payload.kind === WORK.fix && live.data.fix) {
        const r = (e.payload.result || {}) as { queued?: boolean; why?: string };
        // Taken: the round is the bot's (the clock watches its row). Not
        // taken (the bot is off, not on this app, the failure looks like the
        // platform's, which it says itself), or failing for good: decided
        // again without a round.
        if (status !== 'done' || !r.queued) {
          d = { ...d, fix: { ...live.data.fix, refused: status === 'done' ? String(r.why || 'refused') : 'failed' } };
          if (!FINAL.has(live.name) && live.name !== 'merged' && f.row) return decide(live, f, ctx, d);
        }
      }
      return step(live.name as Name, d);
    },
  };
}

const retryFollowup = {
  guard: (s: BState, e: Event<any>): Check => {
    const n = (s as Live).data.notes[e.payload.workKey];
    return n && ['failed', 'exhausted'].includes(n.status) ? ok() : reject('not_retryable');
  },
  to: (s: BState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<BState> => {
    const live = s as Live;
    const prev = live.data.notes[e.payload.workKey]!;
    const key = `${e.payload.workKey.replace(/~\d+$/, '')}~${ctx.version + 1}`;
    const notes = { ...live.data.notes, [e.payload.workKey]: { ...prev, status: 'retried' as const }, [key]: { ...prev, status: 'pending' as const } };
    return step(live.name as Name, { ...live.data, notes }, { work: [{ kind: prev.kind, key, input: prev.input, continues: e.payload.workKey }] });
  },
};

// ── The machine ─────────────────────────────────────────────────────────

const fromMachine = (...names: string[]) => (e: Event<any>): Check =>
  ((e.source.kind === 'message' && names.includes(e.source.from.machine)) || e.source.kind === 'system' ? ok() : reject('internal_only'));
const anyProducer = (e: Event<any>): Check =>
  (e.source.kind === 'message' || e.source.kind === 'system' || e.source.kind === 'service' ? ok() : reject('not_a_producer'));
const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));
const admin = (e: Event<any>): Check => (e.source.kind === 'admin' || e.source.kind === 'system' ? ok() : reject('not_a_producer'));

export function botChange(): Machine<BState, Facts> {
  const works = { WorkSucceeded: workResult('done'), WorkFailed: workResult('failed'), WorkExhausted: workResult('exhausted') };
  const looks = {
    Proposed: { to: look }, Verdict: { to: look }, ShotsSettled: { to: look }, FixRoundEnded: { to: look }, Look: { to: look },
    PreviewStopped: { to: stopped },
    Merged: { to: merged },
    Live: { to: wentLive },
    Closed: { to: closed as any },
    RetryFollowup: retryFollowup,
    ...works,
  };
  const ended = {
    Proposed: { ignore: 'ended' }, Verdict: { ignore: 'ended' }, ShotsSettled: { ignore: 'ended' }, FixRoundEnded: { ignore: 'ended' },
    Look: { ignore: 'ended' }, PreviewStopped: { ignore: 'ended' }, Merged: { ignore: 'ended' }, Live: { ignore: 'ended' },
    Closed: { ignore: 'ended' }, RetryFollowup: retryFollowup, ...works,
  };
  // Once merged only going live (or a close, an unmerge's) moves it on.
  const mergedState = {
    ...looks,
    Proposed: { ignore: 'merged' }, Verdict: { ignore: 'merged' }, ShotsSettled: { ignore: 'merged' },
    FixRoundEnded: { ignore: 'merged' }, Look: { ignore: 'merged' }, PreviewStopped: { ignore: 'merged' },
    Merged: { ignore: 'already_merged' },
  };
  // Whatever creates it must be about a change of the bot's that a run of
  // its proposed, up for a vote or past it.
  const creating = (to: (s: BState, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<BState>) => ({
    guard: (_s: BState, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
      if (!f.row || !f.runId) return reject('not_a_bot_change');
      return UP.has(f.row.status) ? ok() : reject('not_up_for_vote');
    },
    to,
  });
  return defineMachine<BState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: CREATE,
    terminal: [...FINAL],
    decode: (row) => ({ name: row.state, data: row.data } as BState),
    facts: (tx: Tx, state: BState, event: Event<any>) => {
      const id = state.name === NONE ? Number((event.payload as any)?.sessionId) : (state.data as Data).sessionId;
      if (!Number.isInteger(id) || id <= 0) return Promise.resolve(NO_FACTS);
      return readFacts(tx, id);
    },
    authorize: {
      Proposed: fromMachine('proposal'),
      Verdict: fromMachine('preview'),
      ShotsSettled: fromMachine('shots'),
      PreviewStopped: fromMachine('preview'),
      // The bot's loop, when its round on the change's head ends
      // (homeroom-bot.js runChecksFix), or a shim's.
      FixRoundEnded: anyProducer,
      Merged: fromMachine('merge-followups'),
      Live: fromMachine('merge-followups'),
      Closed: fromMachine('proposal'),
      Look: timer,
      RetryFollowup: admin,
    },
    transitions: {
      [NONE]: {
        Proposed: creating(look), Verdict: creating(look), ShotsSettled: creating(look), FixRoundEnded: creating(look),
        PreviewStopped: creating(stopped), Merged: creating(merged), Live: creating(wentLive),
      },
      checking: looks,
      waiting_on_shots: looks,
      with_the_bot: looks,
      ready: looks,
      stopped: looks,
      merged: mergedState,
      live: ended,
      closed: ended,
    } as any,
  });
}
