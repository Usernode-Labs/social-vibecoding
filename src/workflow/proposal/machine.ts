// proposal: a proposal's lifecycle, from the moment somebody starts it until
// it is merged or closed. One instance per proposal (`session:<id>`), every
// chat_sessions row included (the Homeroom bot's triage and build sessions,
// the App bench's), adopted from its row by its first event.
//
//   underway  ── Promote ─▶ proposing ── review.open ─▶ in_review ── MergeClaim ─▶ merging
//      ▲  ▲ (slot held / released / none)        │ failed                ▲   │ released │
//      │  └────────────────────────────────────────┘                       │   └──────────┘
//      │◀── Unpromote, MergeAbandoned ─────────────────────────────────────┘
//      │◀── Reopen ── closed ◀── Close (any reason) ── underway, proposing, in_review
//                                       merged ◀── Merged (merge-followups' message)
//
// `chat_sessions.status` is the projection, with the values it always had:
// underway reads 'active' while it holds one of its owner's slots (and the
// platform's), 'paused' once it gave it back (an imported proposal holds
// none and reads 'active'); proposing still reads what it read before;
// in_review 'promoted'; merging 'merging'; merged 'merged' (written by
// merge-followups, with the merge); closed 'archived'.
//
// Every move is an event decided under the proposal's row lock, carrying what
// its caller read (`from`), so an event a newer move overtook is refused
// rather than undoing it. What must happen around a move is a write in its
// transaction (the database only) or durable work (GitHub, the worker, the
// CC volume, the Homeroom bot's tray). A proposal's GitHub moves (opening its
// pull request for review, closing it, reopening it) run one at a time, each
// waiting for the one before it to report: a reopen during a close is never
// undone by the close finishing after it.
//
// workflow-foundation's design-proposal-lifecycle.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type {
  Check, DomainWrite, Event, Json, Machine, MessageRequest, Outcome, Push, TimerRequest, TransitionContext, Tx,
  WorkRequest, WorkResultPayload, WriteContext,
} from '../kernel/index.ts';
import { chatLine, issueUpdate, sessionUpdate, toUser, voteUpdate } from '../pushes.ts';
import { changeClosed } from '../rules/agent-notes.ts';
import { settleDecidedChange } from '../rules/change-notifications.ts';
import { createConnectorSubmittedNotification, createPrProposedNotifications, createStalePrNotification } from '../rules/proposal-notifications.ts';
import { invalidateHeadMoveSql } from '../rules/summary-freshness.ts';
import { readFacts, NO_FACTS } from './facts.ts';
import type { Facts, Row } from './facts.ts';

export const MACHINE = 'proposal';
export const sessionKey = (sessionId: number) => `session:${sessionId}`;

export const WORK = Object.freeze({
  open: 'review.open',
  close: 'pr.close',
  reopen: 'pr.reopen',
  destroy: 'worker.destroy',
  purge: 'cc.purge',
  bot: 'bot.proposalChanged',
});
// The proposal's GitHub moves, run one at a time.
const PR_MOVES: ReadonlySet<string> = new Set([WORK.open, WORK.close, WORK.reopen]);

// ── State ───────────────────────────────────────────────────────────────

export type Slot = 'held' | 'released' | 'none';

// Going up for a vote: who asked, what they read, and the n of its
// review.open.
export interface Promoting {
  n: number;
  by: number | null;
  byName: string | null;
  prior: 'active' | 'paused';
  expectedHead: string | null;
  viaAgent: boolean;
  // The head the row named when it was asked: one a push moved meanwhile
  // (a reconcile while it went up) is the head it goes up on.
  headAt: string | null;
}
// What the last promote came to, for the route that waits on it.
export interface Answer {
  n: number;
  ok: boolean;
  code?: string | null;
  message?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  prTitle?: string | null;
}
export interface Data {
  sessionId: number;
  appId: number;
  imported: boolean;
  slot: Slot;
  promoting: Promoting | null;
  answer: Answer | null;
  reason: string | null;                       // closed: why
  claim: { n: number; at: string } | null;     // merging: the merge attempt that holds it
  // The GitHub move under way (its work key), and the ones to run after it,
  // in order.
  pr: { running: string | null; next: WorkRequest[] };
  // Work that tears the session down (its worker, its CC volume) not yet
  // reported: a resume or a reopen cancels it, so it never hits a session
  // that came back.
  doomed: { kind: string; key: string }[];
  n: number;
}

const STATES = ['underway', 'proposing', 'in_review', 'merging', 'merged', 'closed'] as const;
type Name = typeof STATES[number];
export type PState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<PState, { data: Data }>;

// What chat_sessions.status reads in each state.
export function statusOf(s: Live): string {
  switch (s.name) {
    case 'underway': return s.data.slot === 'released' ? 'paused' : 'active';
    case 'proposing': return s.data.promoting?.prior ?? 'active';
    case 'in_review': return 'promoted';
    case 'merging': return 'merging';
    case 'merged': return 'merged';
    default: return 'archived';
  }
}

// ── Configuration ───────────────────────────────────────────────────────

export interface Deps {
  // An underway proposal holding a slot gives it back after this long with
  // nothing happening on it (config.sessionAutopauseIdleMs; 0: never).
  idleMs: number;
  // The staging deployment's fixtures (migrate.js) stay active.
  exemptFixtures: boolean;
  // How often a proposal in review is looked at again: voted down, gone
  // quiet (config.staleSweepIntervalMs; 0: never).
  reviewCheckMs: number;
  // Gone quiet: warned after notifyMs with no interest, closed graceMs after
  // the warning (config.prStaleNotifyMs, prStaleGraceMs; 0: never).
  staleNotifyMs: number;
  staleGraceMs: number;
}

// A held session somebody works on is looked at again this soon.
export const IDLE_RECHECK_MS = 60 * 1000;
// A merge attempt that holds a proposal this long has lost its process.
export const CLAIM_STALE_MS = 5 * 60 * 1000;

// The pauses the platform makes on its own: never under somebody working
// on the session, nor under a durable build that holds it.
const SYSTEM_PAUSES: ReadonlySet<string> = new Set(['auto-idle', 'lru', 'pressure']);
// A session put back at rest by its own flow (the bot's triage session, a
// bench trial's runner): never under a turn record.
const REST_PAUSES: ReadonlySet<string> = new Set(['rest']);
const PAUSE_REASONS: ReadonlySet<string> = new Set([...SYSTEM_PAUSES, ...REST_PAUSES, 'manual', 'park', 'account-deletion', 'build-ended']);

// ── Events ──────────────────────────────────────────────────────────────

const STATUSES: ReadonlySet<string> = new Set(['active', 'paused', 'promoted', 'merging', 'merged', 'archived']);
const SHA = /^[0-9a-f]{40}$/;
const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown, what: string) => (v == null ? null : int(v, what));
const count = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${what} must be a whole number`);
  return v as number;
};
// When its caller stops waiting for it: an event applied after that is
// refused (`expired`), so a caller that gave up never has it applied behind
// its back (a merge claim left 'merging', a head move it read as refused).
const deadline = (p: any) => {
  if (p?.deadline == null) return {};
  const at = Date.parse(String(p.deadline));
  if (!Number.isFinite(at)) throw new Error('deadline must be a time');
  return { deadline: new Date(at).toISOString() };
};
const optSha = (v: unknown, what: string) => {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (!SHA.test(s)) throw new Error(`${what} must be a 40-character commit sha`);
  return s;
};
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const word = (v: unknown, what: string) => {
  const s = text(v, 64);
  if (!s || !/^[a-z][a-z0-9_-]*$/.test(s)) throw new Error(`${what} is required`);
  return s;
};
// What the caller read: every status-moving event carries the status its
// caller decided on, and is refused once a newer move has changed it.
const from = (p: any) => {
  if (!STATUSES.has(p?.from)) throw new Error('from (the status the caller read) is required');
  return p.from as string;
};
const session = (p: any) => ({ sessionId: int(p?.sessionId, 'sessionId') });
const ownOperation = (p: any) => ({ ownOperation: text(p?.ownOperation, 120) });

const EVENTS = {
  // The leader's boot backfill and its sweep, and an insert of a row born in
  // review (in its own transaction): the row's state, its timer armed.
  Adopted: (p: any) => ({ ...session(p) }),
  // Up for a vote: the promote route (the button, the connector's tools, the
  // local CLI, the Homeroom bot) and an import going straight to a vote.
  // `pr`: the pull request as GitHub showed the route (null: none yet);
  // `cap`: the owner's ceiling on proposals in review.
  Promote: (p: any) => {
    const pr = p?.pr == null ? null : {
      state: p.pr.state === 'closed' ? 'closed' : 'open', draft: !!p.pr.draft, merged: !!p.pr.merged,
      head: optSha(p.pr.head, 'pr.head'),
    };
    return { ...session(p), from: from(p), userId: int(p?.userId, 'userId'), username: text(p?.username, 100),
      cap: count(p?.cap, 'cap'), pr, expectedHead: optSha(p?.expectedHead, 'expectedHead'), viaAgent: !!p?.viaAgent,
      ...ownOperation(p) };
  },
  Unpromote: (p: any) => ({ ...session(p), from: from(p), userId: int(p?.userId, 'userId'), username: text(p?.username, 100), ...deadline(p) }),
  Pause: (p: any) => {
    const reason = word(p?.reason, 'reason');
    if (!PAUSE_REASONS.has(reason)) throw new Error(`reason ${reason} is not a pause`);
    return { ...session(p), from: from(p), reason, userId: optInt(p?.userId, 'userId'), ...deadline(p) };
  },
  // `caps`: the owner's slot ceiling and the platform's; null for a flow
  // that keeps its own (the Homeroom bot's triage, a bench trial).
  Resume: (p: any) => ({ ...session(p), from: from(p), userId: optInt(p?.userId, 'userId'),
    caps: p?.caps == null ? null : { user: count(p.caps.user, 'caps.user'), global: count(p.caps.global, 'caps.global') },
    ...deadline(p) }),
  IdleCheck: () => ({}),
  ReviewCheck: () => ({}),
  Close: (p: any) => ({ ...session(p), from: from(p), reason: word(p?.reason, 'reason'),
    userId: optInt(p?.userId, 'userId'), username: text(p?.username, 100), purgeCc: !!p?.purgeCc }),
  Reopen: (p: any) => ({ ...session(p), from: from(p), userId: int(p?.userId, 'userId') }),
  // The merge (routes/votes.js checkAndMerge, step 6's) asks for the
  // proposal at the head and epoch it gated on; the vote gate is read again
  // here unless an admin forces it.
  MergeClaim: (p: any) => {
    if (!Number.isInteger(p?.epoch) || p.epoch < 0) throw new Error('epoch must be the approval epoch the merge gated on');
    return { ...session(p), head: optSha(p?.head, 'head'), epoch: p.epoch as number, force: !!p?.force,
      explicitApproval: !!p?.explicitApproval, explicitReason: text(p?.explicitReason, 64), ...deadline(p) };
  },
  // The attempt ended without merging (`claim`: its claim; null: recovery's,
  // for a claim whose process is gone).
  MergeReleased: (p: any) => ({ ...session(p), claim: p?.claim == null ? null : int(p.claim, 'claim'),
    reason: text(p?.reason, 200) }),
  // The pull request is closed on GitHub for good: off the vote.
  MergeAbandoned: (p: any) => ({ ...session(p), from: from(p), reason: text(p?.reason, 200) }),
  // merge-followups moved it into 'merged' (a merge, or a change carried by
  // another's).
  Merged: (p: any) => ({ ...session(p) }),
  // The revision the group votes on moved (Q3): the reviewed head (native)
  // or the pull request's head (imported), from `from` (what the caller read
  // there; null: bound for the first time) to `to`. `keepVotes`: a mechanical
  // move that keeps the approvals; `fixOnly`: a fix round of the bot's that
  // leaves the description as it is.
  ReviewHeadMoved: (p: any) => {
    if (!p || !Object.prototype.hasOwnProperty.call(p, 'from')) throw new Error('from (the head the caller read) is required');
    if (p.column !== 'reviewed' && p.column !== 'imported') throw new Error('column must be reviewed or imported');
    const to = optSha(p.to, 'to');
    if (!to) throw new Error('to is required');
    return { ...session(p), column: p.column as 'reviewed' | 'imported', from: optSha(p.from, 'from'), to,
      keepVotes: !!p.keepVotes, fixOnly: !!p.fixOnly, reason: text(p.reason, 200), ...deadline(p) };
  },
  ApprovalsCleared: (p: any) => ({ ...session(p), reason: text(p?.reason, 200), ...deadline(p) }),
};

// ── Helpers ─────────────────────────────────────────────────────────────

type Handler = (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps) => Outcome<PState>;
const step = (next: Live, more: Omit<Outcome<PState>, 'next'> = {}): Outcome<PState> => ({ next, ...more });
const later = (ctx: TransitionContext, ms: number) => new Date(ctx.now.getTime() + ms);

// The timer a state keeps: an underway proposal holding a slot is looked at
// once it may have gone idle; one in review every review interval.
function timerFor(s: Live, f: Facts, ctx: TransitionContext, deps: Deps): TimerRequest | null {
  if (s.name === 'underway' && s.data.slot === 'held' && deps.idleMs > 0) {
    const last = f.row?.lastActivityAt ? Date.parse(f.row.lastActivityAt) : ctx.now.getTime();
    return { at: new Date(Math.max(last + deps.idleMs, ctx.now.getTime() + 30 * 1000)), event: { type: 'IdleCheck' } };
  }
  if (s.name === 'in_review' && deps.reviewCheckMs > 0) {
    return { at: later(ctx, deps.reviewCheckMs), event: { type: 'ReviewCheck' } };
  }
  return null;
}

// The state a row it does not hold yet stands for.
function adopt(sessionId: number, row: Row): Live {
  const data: Data = {
    sessionId, appId: row.appId, imported: row.imported, slot: row.imported ? 'none' : 'held',
    promoting: null, answer: null, reason: null, claim: null, pr: { running: null, next: [] }, doomed: [], n: 0,
  };
  switch (row.status) {
    case 'paused': return { name: 'underway', data: { ...data, slot: 'released' } };
    case 'promoted': return { name: 'in_review', data };
    case 'merging': return { name: 'merging', data: { ...data, claim: { n: 0, at: row.mergeAttemptAt || row.createdAt } } };
    case 'merged': return { name: 'merged', data };
    case 'archived': return { name: 'closed', data: { ...data, reason: 'unknown' } };
    default: return { name: 'underway', data };
  }
}

// A GitHub move: run now, or after the ones before it report. A close or a
// reopen says where the pull request should end up, so it replaces a close
// or a reopen still waiting (an open waiting keeps its place).
function prMove(d: Data, w: WorkRequest): { data: Data; work: WorkRequest[] } {
  if (!d.pr.running) return { data: { ...d, pr: { running: w.key, next: [] } }, work: [w] };
  const settles = w.kind === WORK.close || w.kind === WORK.reopen;
  const kept = settles ? d.pr.next.filter((x) => x.kind === WORK.open) : d.pr.next;
  return { data: { ...d, pr: { running: d.pr.running, next: [...kept, w] } }, work: [] };
}
// The move under way reported: the next one starts.
function prDone(d: Data, key: string): { data: Data; work: WorkRequest[] } {
  if (d.pr.running !== key) return { data: d, work: [] };
  const [next, ...rest] = d.pr.next;
  return { data: { ...d, pr: { running: next ? next.key : null, next: rest } }, work: next ? [next] : [] };
}

// Teardown work (the worker, the CC volume), remembered until it reports.
function doom(d: Data, w: WorkRequest): Data {
  return { ...d, doomed: [...(d.doomed || []), { kind: w.kind, key: w.key }] };
}
// ... and cancelled by a move that brings the session back.
function spare(d: Data, kinds: ReadonlySet<string>): { data: Data; cancel: { kind: string; key: string }[] } {
  const cancel = (d.doomed || []).filter((x) => kinds.has(x.kind));
  return { data: { ...d, doomed: (d.doomed || []).filter((x) => !kinds.has(x.kind)) }, cancel };
}

const repoInput = (f: Facts) => (f.row?.repo && f.row.prNumber
  ? { owner: f.row.repo.owner, repo: f.row.repo.repo, number: f.row.prNumber } : null);

// The slot an underway proposal goes back to.
const slotFor = (d: Data, prior: string | null = null): Slot =>
  (d.imported ? 'none' : prior === 'active' ? 'held' : 'released');

const busy = (r: Row) => r.activeTurn || r.workedOn;
// 'active' and 'paused' are one reading of an underway proposal for a move
// that does not depend on its slot (a close, a promote): a slot given back
// meanwhile (the idle check) does not overtake it.
const UNDERWAY: ReadonlySet<string> = new Set(['active', 'paused']);
const sameReading = (now: string, read: string) => now === read || (UNDERWAY.has(now) && UNDERWAY.has(read));
// What may still move its branch under a promote or an unpromote (facts.ts).
const moving = (r: Row) => r.moving;
const label = (r: Row) => (r.prTitle ? `“${r.prTitle}”` : 'This change');
const prLabel = (r: Row, prNumber = r.prNumber, prTitle = r.prTitle) =>
  (prTitle ? `PR #${prNumber || r.id}: ${prTitle}` : `PR #${prNumber || r.id}`);

const line = (e: Event<any>, d: Data, content: string, extra: { msgType?: string; metadata?: Json } = {}): DomainWrite =>
  ({ type: 'line', eventId: e.id, appId: d.appId, sessionId: d.sessionId, content, msgType: extra.msgType || 'system',
    metadata: extra.metadata ?? null });
// A card moved on the boards: browsers hear it, and so does the Workshop's
// placement stage in every web process (services/ws.js, `boardChange`).
const board = (f: Facts, action: string, extra: Record<string, Json> = {}): Push => {
  const p = sessionUpdate({ action, sessionId: f.row!.id, appId: f.row!.appId, appSlug: f.row!.appSlug, ...extra });
  return { ...p, routing: { ...(p.routing || {}), boardChange: true } };
};
const votes = (f: Facts, extra: Record<string, Json> = {}): Push =>
  voteUpdate({ sessionId: f.row!.id, appId: f.row!.appId, appSlug: f.row!.appSlug, merged: false, ...extra });

const toPreview = (d: Data, type: string, payload: Record<string, Json>): MessageRequest =>
  ({ to: { machine: 'preview', key: sessionKey(d.sessionId) }, event: { type, payload: { sessionId: d.sessionId, ...payload } }, appId: d.appId });
const toShots = (d: Data, type: string, payload: Record<string, Json>): MessageRequest =>
  ({ to: { machine: 'shots', key: sessionKey(d.sessionId) }, event: { type, payload: { sessionId: d.sessionId, ...payload } }, appId: d.appId });

// What the bot's tray and the worker need when a proposal ends its turn at
// a slot or closes.
const destroyWorker = (d: Data, n: number): WorkRequest => ({ kind: WORK.destroy, key: `destroy:${n}`, input: { sessionId: d.sessionId } });
const botNote = (d: Data, n: number): WorkRequest => ({ kind: WORK.bot, key: `bot:${n}`, input: { sessionId: d.sessionId } });

// The thread line of a close, in Homeroom's words (a change, never "PR #n").
function closedLine(r: Row, reason: string, byOwner: boolean): string {
  const l = label(r);
  switch (reason) {
    case 'auto-rejected': return `${l} was set aside for now (more No than Yes, and not enough support to carry it).`;
    case 'proposal-replaced':
      return byOwner && r.ownerName ? `${r.ownerName} replaced ${r.prTitle ? l : 'this change'} with a new one.` : `${l} was replaced by a new one.`;
    case 'superseded': return `${l} was withdrawn: another change for the same request covers it.`;
    case 'request-closed': return `${l} was withdrawn: the request it was built for is closed.`;
    case 'red-checks': return `${l} was withdrawn: its checks failed and nobody changed it for a few days.`;
    case 'stale-pr': return `${l} went quiet and was set aside. It can always come back as a new change.`;
    case 'manual':
      return byOwner && r.ownerName ? `${r.ownerName} withdrew ${r.prTitle ? l : 'this change'}.` : `${l} was withdrawn.`;
    default: return `${l} was withdrawn.`;
  }
}

// How a conversation that started the change words its close
// (rules/agent-notes.ts closedSentence).
const OUTCOMES: ReadonlyMap<string, string> = new Map([
  ['auto-rejected', 'rejected'], ['proposal-replaced', 'replaced'], ['manual', 'withdrawn'],
]);

// ── Moves ───────────────────────────────────────────────────────────────

// Up for a vote: GitHub opens or readies the pull request first, and the
// proposal is in review once it has (R4: nothing on GitHub moves before
// the proposal is claimed for review, and it never reads 'promoted' while
// its pull request is still a draft).
const promote: Handler = (s, e, f) => {
  const p = e.payload;
  const n = s.data.n + 1;
  const promoting: Promoting = { n, by: p.userId, byName: p.username, prior: statusOf(s) === 'paused' ? 'paused' : 'active',
    expectedHead: p.expectedHead, viaAgent: p.viaAgent, headAt: f.row!.head };
  const moved = prMove({ ...s.data, n, promoting, answer: null },
    { kind: WORK.open, key: `open:${n}`, input: { sessionId: s.data.sessionId, n, userId: p.userId, expectedHead: p.expectedHead,
      imported: s.data.imported } });
  return step({ name: 'proposing', data: moved.data }, { work: moved.work, timer: null });
};

// review.open reported for the promote under way.
function opened(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const p = e.payload as WorkResultPayload;
  const done = prDone(s.data, p.workKey);
  const promoting = s.data.promoting!;
  if (e.type !== 'WorkSucceeded') {
    const code = p.error?.code || 'github_unavailable';
    const back: Live = { name: 'underway', data: { ...done.data, slot: slotFor(s.data, promoting.prior), promoting: null,
      answer: { n: promoting.n, ok: false, code, message: p.error?.message?.slice(0, 500) ?? null } } };
    // A page that stopped waiting (the route answered 202) reads it again.
    return step(back, { work: done.work, timer: timerFor(back, f, ctx, deps), push: [board(f, 'promote_failed', { error: code })] });
  }
  const r = (p.result || {}) as any;
  const row = f.row!;
  const prNumber = r.prNumber ?? row.prNumber;
  const prTitle = r.prTitle ?? row.prTitle;
  const d: Data = { ...done.data, slot: 'none', promoting: null,
    answer: { n: promoting.n, ok: true, prNumber, prUrl: r.prUrl ?? null, prTitle } };
  const next: Live = { name: 'in_review', data: d };
  // A push a reconcile installed while it went up stands: the head GitHub
  // read before it is not written over it.
  const read = typeof r.head === 'string' ? r.head.toLowerCase() : null;
  const head = row.head && row.head !== promoting.headAt ? row.head : read;
  const work = [...done.work];
  if (row.ownerSynthetic) work.push(botNote(d, promoting.n));
  return step(next, {
    writes: [
      { type: 'promoted', sessionId: d.sessionId, imported: d.imported, head, electorate: f.electorate, issueLinkSeeded: !!r.issueLinkSeeded },
      line(e, d, `${promoting.byName || row.ownerName || 'Somebody'} promoted ${prLabel(row, prNumber, prTitle)} for voting`,
        { msgType: 'vote', metadata: { vote: { sessionId: d.sessionId, prNumber: prNumber || null } } }),
      { type: 'event', userId: promoting.by, appId: d.appId, sessionId: d.sessionId, eventType: 'pr_promoted',
        metadata: { prNumber: prNumber || null } },
      { type: 'proposed', sessionId: d.sessionId, appId: d.appId, proposerId: promoting.by, viaAgent: promoting.viaAgent },
    ],
    work,
    push: [board(f, 'promoted')],
    // The preview machine builds and checks the reviewed head (it joins a
    // build or a verdict it already has for it).
    messages: head ? [toPreview(d, 'RevisionSubmitted', { head, source: d.imported ? 'imported' : 'promote', trigger: 'promote-kick' })] : [],
    timer: timerFor(next, f, ctx, deps),
  });
}

const unpromote: Handler = (s, e, f, ctx, deps) => {
  const n = s.data.n + 1;
  const destroy = destroyWorker(s.data, n);
  const next: Live = { name: 'underway', data: { ...(s.data.imported ? s.data : doom(s.data, destroy)), n, slot: slotFor(s.data) } };
  const who = e.payload.username || 'The author';
  return step(next, {
    writes: [
      { type: 'unpromoted', sessionId: s.data.sessionId },
      line(e, s.data, `${who} moved ${prLabel(f.row!)} back to Underway. Its votes were cleared, and it goes up for a fresh vote when it is proposed again`),
    ],
    work: s.data.imported ? [] : [destroy],
    push: [board(f, 'unpromoted'), votes(f)],
    timer: timerFor(next, f, ctx, deps),
  });
};

const pause: Handler = (s, e, f) => {
  const n = s.data.n + 1;
  const destroy = destroyWorker(s.data, n);
  return step({ name: 'underway', data: { ...doom(s.data, destroy), n, slot: 'released' } }, {
    work: [destroy], push: [board(f, 'paused')], timer: null,
  });
};

const SPARE_WORKER: ReadonlySet<string> = new Set([WORK.destroy]);
const SPARE_ALL: ReadonlySet<string> = new Set([WORK.destroy, WORK.purge]);

const resume: Handler = (s, e, f, ctx, deps) => {
  // An imported proposal holds no slot (one left 'paused' by [main] reads
  // 'active' again, as imports always do).
  // A worker destroy still owed from the pause it comes back from goes.
  const spared = spare(s.data, SPARE_WORKER);
  const next: Live = { name: 'underway', data: { ...spared.data, slot: s.data.imported ? 'none' : 'held' } };
  // last_activity_at moves with it: the idle timer runs from now.
  const timer = deps.idleMs > 0 && !s.data.imported ? { at: later(ctx, deps.idleMs), event: { type: 'IdleCheck' } } : null;
  return step(next, { writes: [{ type: 'resumed', sessionId: s.data.sessionId }], push: [board(f, 'resumed')], timer,
    cancel: spared.cancel });
};

// Closed, for any reason, by one path (R3): the database's part commits with
// the move, the rest is durable work, and the preview is retired for good
// (the preview machine tells the shots machine).
function close(s: Live, e: Event<any>, f: Facts, reason: string, more: { byOwner?: boolean; purgeCc?: boolean } = {}): Outcome<PState> {
  const row = f.row!;
  const n = s.data.n + 1;
  let d: Data = { ...s.data, n, reason, promoting: null, claim: null,
    answer: s.name === 'proposing' && s.data.promoting
      ? { n: s.data.promoting.n, ok: false, code: 'session_state_changed' } : s.data.answer };
  const destroy = destroyWorker(d, n);
  d = doom(d, destroy);
  const work: WorkRequest[] = [destroy, botNote(d, n)];
  // Its pull request is closed; one GitHub is still opening for it (a
  // promote under way) is closed once it has, by the number it then has.
  const pr = repoInput(f) || (s.name === 'proposing' && row.repo ? { owner: row.repo.owner, repo: row.repo.repo, number: null } : null);
  if (pr) {
    const moved = prMove(d, { kind: WORK.close, key: `close:${n}`, input: { sessionId: d.sessionId, ...pr } });
    d = moved.data;
    work.push(...moved.work);
  }
  if (more.purgeCc) {
    const purge = { kind: WORK.purge, key: `purge:${n}`, input: { sessionId: d.sessionId } };
    d = doom(d, purge);
    work.push(purge);
  }
  const writes: DomainWrite[] = [{ type: 'closed', eventId: e.id, sessionId: d.sessionId, appId: d.appId,
    outcome: OUTCOMES.get(reason) || 'closed', agentSessionId: row.agentSessionId, prNumber: row.prNumber }];
  if (row.prNumber) writes.push(line(e, d, closedLine(row, reason, !!more.byOwner)));
  const push = [board(f, 'archived'), votes(f)];
  if (row.linkedIssues.length) push.push(issueUpdate({ action: 'updated', source: 'session_archived', appSlug: row.appSlug, appId: row.appId }));
  return step({ name: 'closed', data: d }, {
    writes, work, push, timer: null,
    messages: [toPreview(d, 'RetireRequested', { reason: 'archived', terminal: true })],
  });
}

const closeEvent: Handler = (s, e, f) =>
  close(s, e, f, e.payload.reason, { byOwner: e.payload.userId != null && e.payload.userId === f.row!.userId, purgeCc: e.payload.purgeCc });

const reopen: Handler = (s, e, f, ctx, deps) => {
  const n = s.data.n + 1;
  // Its worker's destroy and its CC volume's purge, if still owed, go: the
  // session is back.
  const spared = spare(s.data, SPARE_ALL);
  let d: Data = { ...spared.data, n, reason: null, slot: slotFor(s.data) };
  const pr = repoInput(f);
  let work: WorkRequest[] = [];
  if (pr) ({ data: d, work } = prMove(d, { kind: WORK.reopen, key: `reopen:${n}`, input: { sessionId: d.sessionId, ...pr } }));
  const next: Live = { name: 'underway', data: d };
  const row = f.row!;
  const push = [board(f, 'unarchived')];
  if (row.linkedIssues.length) push.push(issueUpdate({ action: 'updated', source: 'session_unarchived', appSlug: row.appSlug, appId: row.appId }));
  return step(next, { work, push, timer: timerFor(next, f, ctx, deps), cancel: spared.cancel });
};

const claim: Handler = (s, e, f, ctx) => {
  const n = s.data.n + 1;
  return step({ name: 'merging', data: { ...s.data, n, claim: { n, at: ctx.now.toISOString() } } }, {
    writes: [{ type: 'claimed', sessionId: s.data.sessionId }],
    push: [votes(f, { merging: true, selfHosted: f.row!.selfHosted })],
    timer: null,
  });
};

// Back to review: a merge attempt's release keeps the votes (Q4).
const released: Handler = (s, e, f, ctx, deps) => {
  const next: Live = { name: 'in_review', data: { ...s.data, claim: null } };
  return step(next, { timer: timerFor(next, f, ctx, deps) });
};

// Off the vote for good: its pull request is closed on GitHub and could not
// be reopened. Every exit from review voids the votes (Q4, bug 19).
const abandoned: Handler = (s, e, f, ctx, deps) => {
  const next: Live = { name: 'underway', data: { ...s.data, claim: null, slot: slotFor(s.data) } };
  return step(next, {
    writes: [
      { type: 'abandoned', sessionId: s.data.sessionId },
      line(e, s.data, `${prLabel(f.row!)} is closed on GitHub and couldn't be reopened, so it has been taken off the vote panel. Re-propose it from the session's dev-chat.`),
    ],
    push: [votes(f, { merging: false, mergeFailed: true, resolving: false, selfHosted: f.row!.selfHosted }), board(f, 'paused')],
    timer: timerFor(next, f, ctx, deps),
  });
};

const merged: Handler = (s) => {
  const out: Live = { name: 'merged', data: { ...s.data, claim: null, promoting: null } };
  return step(out, { timer: null });
};

const headMoved: Handler = (s, e, f) => {
  const p = e.payload;
  return step(s, {
    writes: [{ type: 'headMoved', sessionId: s.data.sessionId, column: p.column, to: p.to, keepVotes: p.keepVotes, fixOnly: p.fixOnly }],
    messages: f.row!.shots ? [toShots(s.data, 'HeadMoved', { head: p.to, reason: p.reason, pin: p.column, from: null })] : [],
  });
};

const approvalsCleared: Handler = (s) => step(s, { writes: [{ type: 'approvalsCleared', sessionId: s.data.sessionId }] });

// The idle check: a held slot nobody has used for a while is given back.
const idleCheck: Handler = (s, e, f, ctx, deps) => {
  const row = f.row!;
  if (deps.idleMs <= 0 || s.data.imported) return step(s, { timer: null });
  const last = row.lastActivityAt ? Date.parse(row.lastActivityAt) : 0;
  if (ctx.now.getTime() - last < deps.idleMs) return step(s, { timer: { at: new Date(last + deps.idleMs), event: { type: 'IdleCheck' } } });
  if (busy(row) || row.shotsRunning || row.buildHold || (deps.exemptFixtures && row.fixture)) {
    return step(s, { timer: { at: later(ctx, IDLE_RECHECK_MS), event: { type: 'IdleCheck' } } });
  }
  return pause(s, e, f, ctx, deps);
};

// The hourly look at a proposal in review, every input read under the lock:
// voted down (R1's twin: the gate as it is now), gone quiet (R2: a vote
// since the warning cancels the close).
const reviewCheck: Handler = (s, e, f, ctx, deps) => {
  const row = f.row!;
  const again: TimerRequest | null = deps.reviewCheckMs > 0 ? { at: later(ctx, deps.reviewCheckMs), event: { type: 'ReviewCheck' } } : null;
  if (busy(row)) return step(s, { timer: again });
  if (f.gate?.rejectable) return close(s, e, f, 'auto-rejected');
  if (deps.staleNotifyMs <= 0) return step(s, { timer: again });
  const interest = f.interestAt ? Date.parse(f.interestAt) : 0;
  const warned = row.staleNotifiedAt ? Date.parse(row.staleNotifiedAt) : null;
  if (warned != null && interest > warned) {
    // Somebody showed interest after the warning: it stands again.
    return step(s, { writes: [{ type: 'staleCleared', sessionId: s.data.sessionId }], timer: again });
  }
  if (warned != null) {
    if (ctx.now.getTime() - warned >= deps.staleGraceMs) return close(s, e, f, 'stale-pr');
    return step(s, { timer: again });
  }
  if (ctx.now.getTime() - interest >= deps.staleNotifyMs) {
    return step(s, { writes: [{ type: 'staleWarned', sessionId: s.data.sessionId, appId: s.data.appId, userId: row.userId }], timer: again });
  }
  return step(s, { timer: again });
};

// A work result: the GitHub move under way reports (and the next starts);
// the open review decides the promote; the rest are bookkeeping.
function workDone(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const p = e.payload as WorkResultPayload;
  if (p.kind === WORK.open && s.name === 'proposing' && s.data.promoting && p.workKey === `open:${s.data.promoting.n}`) {
    return opened(s, e, f, ctx, deps);
  }
  const done = PR_MOVES.has(p.kind) ? prDone(s.data, p.workKey) : { data: s.data, work: [] };
  done.data = { ...done.data, doomed: (done.data.doomed || []).filter((x) => x.key !== p.workKey || x.kind !== p.kind) };
  const writes: DomainWrite[] = [];
  // A reopen GitHub refused for good (the pull request is closed for good):
  // the row forgets it (whatever has happened since: the write is fenced by
  // the number), so the next promote opens a fresh one.
  if (p.kind === WORK.reopen && e.type === 'WorkSucceeded' && (p.result as any)?.cleared) {
    writes.push({ type: 'prCleared', sessionId: s.data.sessionId, prNumber: (p.result as any).prNumber });
  }
  if (p.kind === WORK.purge && e.type === 'WorkSucceeded' && (p.result as any)?.purged && s.name === 'closed') {
    writes.push({ type: 'ccPurged', sessionId: s.data.sessionId });
  }
  return step({ name: s.name, data: done.data } as Live, { writes, work: done.work });
}

// ── Guards ──────────────────────────────────────────────────────────────

const owner = (e: Event<any>, f: Facts): Check =>
  (e.payload.userId == null || e.payload.userId === f.row!.userId ? ok() : reject('not_owner'));
const read = (s: Live, e: Event<any>, why = 'session_state_changed'): Check =>
  (statusOf(s) === e.payload.from ? ok() : reject(why));
const all = (...checks: (() => Check)[]): Check => {
  for (const c of checks) {
    const r = c();
    if (r !== true) return r;
  }
  return ok();
};

const GUARDS = new Map<string, (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext) => Check>([
  ['Promote', (s, e, f) => all(
    () => (s.name === 'underway' ? ok() : reject('session_state_changed')),
    () => (sameReading(statusOf(s), e.payload.from) ? ok() : reject('session_state_changed')),
    () => owner(e, f),
    () => (f.row!.headless ? reject('headless') : ok()),
    () => (moving(f.row!) ? reject('busy') : ok()),
    () => (f.caps && f.caps.promoted >= e.payload.cap ? reject('promoted_cap') : ok()),
    () => {
      const pr = e.payload.pr;
      if (!pr) return ok();
      if (pr.merged) return reject('pr_merged');
      if (s.data.imported && pr.state === 'closed') return reject('pr_closed');
      // An imported pull request its author keeps as a draft is not up for
      // a vote: GitHub would refuse to merge it (bug 10).
      if (s.data.imported && pr.draft) return reject('pr_draft');
      return ok();
    },
  )],
  ['Unpromote', (s, e, f) => all(
    () => (s.name === 'in_review' ? ok() : reject(s.name === 'merging' || s.name === 'merged' ? 'merging'
      : s.name === 'underway' || s.name === 'proposing' ? 'already_underway' : 'closed')),
    () => read(s, e),
    () => owner(e, f),
    () => (f.row!.headless ? reject('headless') : ok()),
    () => (moving(f.row!) ? reject('busy') : ok()),
    () => (f.row!.pendingSecret ? reject('pending_secret') : ok()),
  )],
  ['Pause', (s, e, f) => all(
    () => (s.name === 'underway' ? ok() : reject('not_underway')),
    () => (s.data.imported ? reject('imported') : ok()),
    () => (s.data.slot === 'held' ? ok() : reject('already_paused')),
    () => read(s, e),
    () => owner(e, f),
    () => (SYSTEM_PAUSES.has(e.payload.reason) && (busy(f.row!) || f.row!.shotsRunning || f.row!.buildHold) ? reject('worked_on') : ok()),
    () => (REST_PAUSES.has(e.payload.reason) && f.row!.activeTurn ? reject('worked_on') : ok()),
  )],
  ['Resume', (s, e, f) => all(
    // A closed proposal is reopened, never resumed (bug 21).
    () => (s.name === 'closed' ? reject('closed') : s.name === 'underway' ? ok() : reject('not_underway')),
    () => (s.data.slot === 'released' ? ok() : reject('already_active')),
    () => read(s, e),
    () => owner(e, f),
    () => {
      const caps = e.payload.caps;
      if (!caps || !f.caps) return ok();
      if (f.caps.active >= caps.user) return reject('user_cap');
      if (f.caps.global >= caps.global) return reject('global_cap');
      return ok();
    },
  )],
  ['IdleCheck', (s) => (s.name === 'underway' && s.data.slot === 'held' ? ok() : reject('not_held'))],
  ['ReviewCheck', (s) => (s.name === 'in_review' ? ok() : reject('not_in_review'))],
  ['Close', (s, e, f) => all(
    () => (['underway', 'proposing', 'in_review'].includes(s.name) ? ok()
      : reject(s.name === 'closed' ? 'already_closed' : s.name === 'merging' ? 'merging' : 'merged')),
    () => (sameReading(statusOf(s), e.payload.from) ? ok() : reject('overtaken')),
    () => owner(e, f),
  )],
  ['Reopen', (s, e, f) => all(
    () => (s.name === 'closed' ? ok() : reject('not_closed')),
    () => read(s, e),
    () => owner(e, f),
  )],
  ['MergeClaim', (s, e, f) => all(
    () => (s.name === 'in_review' ? ok() : reject(s.name === 'merging' ? 'in_progress' : 'not_in_review')),
    () => (e.payload.head === f.row!.head ? ok() : reject('head_moved')),
    () => (e.payload.epoch === f.row!.epoch ? ok() : reject('epoch_moved')),
    () => (e.payload.force || f.gate?.mergeable ? ok() : reject('not_mergeable')),
  )],
  ['MergeReleased', (s, e, f, ctx) => all(
    () => (s.name === 'merging' ? ok() : reject('not_merging')),
    () => {
      const c = s.data.claim;
      if (e.payload.claim != null) return c && c.n === e.payload.claim ? ok() : reject('stale_claim');
      // Recovery's: only a claim old enough that its process is gone.
      return !c || ctx.now.getTime() - Date.parse(c.at) >= CLAIM_STALE_MS ? ok() : reject('claim_live');
    },
  )],
  ['MergeAbandoned', (s, e) => all(
    () => (s.name === 'merging' || s.name === 'in_review' ? ok() : reject('not_in_review')),
    () => read(s, e),
  )],
  ['ReviewHeadMoved', (s, e, f) => all(
    () => (s.name === 'closed' || s.name === 'merged' ? reject('closed') : ok()),
    () => {
      const now = e.payload.column === 'imported' ? f.row!.importedHead : f.row!.reviewedHead;
      return now === e.payload.from ? ok() : reject('head_moved');
    },
  )],
  ['ApprovalsCleared', (s) => (s.name === 'closed' || s.name === 'merged' ? reject('closed') : ok())],
]);

const HANDLERS = new Map<string, Handler>([
  ['Promote', promote], ['Unpromote', unpromote], ['Pause', pause], ['Resume', resume],
  ['IdleCheck', idleCheck], ['ReviewCheck', reviewCheck], ['Close', closeEvent], ['Reopen', reopen],
  ['MergeClaim', claim], ['MergeReleased', released], ['MergeAbandoned', abandoned], ['Merged', merged],
  ['ReviewHeadMoved', headMoved], ['ApprovalsCleared', approvalsCleared],
  ['WorkSucceeded', workDone], ['WorkFailed', workDone], ['WorkExhausted', workDone],
]);
// The events that may create the instance (every one but the clock's): the
// first adopts the proposal from its row, then is handled as for one held.
const CREATE = ['Adopted', 'Promote', 'Unpromote', 'Pause', 'Resume', 'Close', 'Reopen', 'MergeClaim', 'MergeReleased',
  'MergeAbandoned', 'Merged', 'ReviewHeadMoved', 'ApprovalsCleared'];

// A row merge-followups has moved into 'merged' is merged, whatever this
// instance last decided: the move is that machine's, and its Merged message
// may still be on its way.
const expired = (e: Event<any>, ctx: TransitionContext) =>
  typeof e.payload?.deadline === 'string' && ctx.now.getTime() > Date.parse(e.payload.deadline);

const mergedAway = (s: Live, e: Event<any>, f: Facts) =>
  f.row?.status === 'merged' && s.name !== 'merged' && e.type !== 'Merged';

function transitions(deps: Deps) {
  const entry = (type: string) => ({
    guard: (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      if (!f.row) return reject('session_not_found');
      if (expired(e, ctx)) return reject('expired');
      if (mergedAway(s, e, f) && !type.startsWith('Work')) return reject('merged');
      const g = GUARDS.get(type);
      return g ? g(s, e, f, ctx) : ok();
    },
    to: (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext) => HANDLERS.get(type)!(s, e, f, ctx, deps),
  });
  const row = Object.fromEntries([...HANDLERS.keys()].map((t) => [t, entry(t)]));
  const table: Record<string, Record<string, any>> = {};
  for (const name of STATES) {
    table[name] = { ...row, Adopted: { ignore: 'already_held' } };
  }
  // merged is the end: every request is told so; work still reports.
  table.merged = {
    '*': { ignore: 'merged' },
    WorkSucceeded: entry('WorkSucceeded'), WorkFailed: entry('WorkFailed'), WorkExhausted: entry('WorkExhausted'),
  };
  const adopting = (type: string) => ({
    guard: (_s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      if (!f.row) return reject('session_not_found');
      if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
      if (expired(e, ctx)) return reject('expired');
      if (type === 'Adopted') return ok();
      const a = adopt(e.payload.sessionId, f.row);
      if (a.name === 'merged') return type === 'Merged' ? ok() : reject('merged');
      const g = GUARDS.get(type);
      return g ? g(a, e, f, ctx) : ok();
    },
    to: (_s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<PState> => {
      const a = adopt(e.payload.sessionId, f.row!);
      if (type === 'Adopted' || (type === 'Merged' && a.name === 'merged')) return step(a, { timer: timerFor(a, f, ctx, deps) });
      const out = HANDLERS.get(type)!(a, e, f, ctx, deps);
      return out.timer === undefined ? { ...out, timer: timerFor(out.next as Live, f, ctx, deps) } : out;
    },
  });
  table[NONE] = Object.fromEntries(CREATE.map((t) => [t, adopting(t)]));
  return table;
}

// ── The machine ─────────────────────────────────────────────────────────

const ROUTE_OR_SYSTEM: ReadonlySet<string> = new Set(['route', 'system']);

export function proposal(deps: Deps): Machine<PState, Facts> {
  const routeOrSystem = (e: Event<any>): Check => (ROUTE_OR_SYSTEM.has(e.source.kind) ? ok() : reject('not_a_producer'));
  const person = (e: Event<any>): Check => (e.source.kind === 'route' || e.source.kind === 'system' ? ok() : reject('not_a_producer'));
  const closer = (e: Event<any>): Check => (ROUTE_OR_SYSTEM.has(e.source.kind) || e.source.kind === 'admin' ? ok() : reject('not_a_producer'));
  const system = (e: Event<any>): Check => (e.source.kind === 'system' ? ok() : reject('internal_only'));
  const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));
  const fromMerge = (e: Event<any>): Check =>
    ((e.source.kind === 'message' && e.source.from.machine === 'merge-followups') || e.source.kind === 'system' ? ok() : reject('internal_only'));
  return defineMachine<PState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: CREATE,
    terminal: ['merged'],
    decode: (row) => ({ name: row.state, data: row.data } as PState),
    facts: (tx, state, event, ctx) => {
      const id = state.name === NONE ? Number((event.payload as any)?.sessionId) : (state.data as Data).sessionId;
      if (!Number.isInteger(id) || id <= 0) return Promise.resolve(NO_FACTS);
      const p = event.payload as any;
      const reviewOpened = event.type === 'WorkSucceeded' && p?.kind === WORK.open && state.name === 'proposing';
      return readFacts(tx, id, event, { now: ctx.now, reviewOpened });
    },
    authorize: {
      Adopted: system,
      Promote: routeOrSystem,
      Unpromote: person,
      Pause: routeOrSystem,
      Resume: routeOrSystem,
      IdleCheck: timer,
      ReviewCheck: timer,
      Close: closer,
      Reopen: person,
      MergeClaim: system,
      MergeReleased: system,
      MergeAbandoned: system,
      Merged: fromMerge,
      ReviewHeadMoved: routeOrSystem,
      ApprovalsCleared: routeOrSystem,
    },
    transitions: transitions(deps) as any,
    writes: WRITES,
    project: async (tx, before, after) => {
      if (after.name === NONE || after.name === 'merged') return;
      const status = statusOf(after as Live);
      // Never over a row merge-followups has merged.
      await tx.query(
        `UPDATE chat_sessions
            SET status = $2,
                archived_at = CASE WHEN $2 = 'archived' THEN COALESCE(archived_at, NOW()) ELSE NULL END
          WHERE id = $1 AND status IS DISTINCT FROM $2 AND status <> 'merged'`,
        [(after as Live).data.sessionId, status]);
    },
    reply: async (tx, event, after, ctx, facts) => {
      if (after.name === NONE) return null;
      const d = (after as Live).data;
      const out: Record<string, Json> = { state: after.name, status: statusOf(after as Live) };
      if (event.type === 'MergeClaim' && d.claim) out.claim = d.claim.n;
      if (event.type === 'ReviewHeadMoved' || event.type === 'ApprovalsCleared') {
        const { rows: [r] } = await tx.query('SELECT approval_epoch, pr_summary_stale FROM chat_sessions WHERE id = $1', [d.sessionId]);
        out.epoch = r ? Number(r.approval_epoch) : null;
        out.prSummaryStale = r ? !!r.pr_summary_stale : null;
      }
      if (d.promoting) out.promoting = d.promoting.n;
      if (d.answer) out.answer = d.answer as unknown as Json;
      void facts;
      return out;
    },
  });
}

// ── Domain writes ───────────────────────────────────────────────────────

// A line in the proposal's own thread, marked with its event, pushed to the
// app's room.
async function writeLine(tx: Tx, w: any, ctx: WriteContext) {
  const { rows: [row] } = await tx.query(
    `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, $3, $4, 'session', $5) RETURNING id, app_id, content, msg_type, metadata, thread_type, thread_ref, created_at`,
    [w.appId, w.content, w.msgType || 'system', JSON.stringify({ ...(w.metadata || {}), wfEvent: w.eventId }), w.sessionId]);
  ctx.push(chatLine(row));
}

// Notification rows, named for the relaying process (it reads each one for
// the recipient's open tabs; the row's own trigger rings the phone).
function named(ctx: WriteContext, rows: { id: number; user_id: number }[]) {
  for (const r of rows || []) ctx.push(toUser(Number(r.user_id), { type: 'notification_new', notificationId: Number(r.id) }));
}

const WRITES = {
  line: writeLine,
  event: async (tx: Tx, w: any) => tx.query(
    `INSERT INTO events (user_id, app_id, session_id, event_type, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [w.userId ?? null, w.appId, w.sessionId, w.eventType, JSON.stringify(w.metadata || {})]),
  // In review: the head the group votes on, the clock its windows run from,
  // the electorate it opened with, and no stale warning. A vote cast on
  // another head goes (the tally shows only what can count).
  promoted: async (tx: Tx, w: any, ctx: WriteContext) => {
    await tx.query(
      `UPDATE chat_sessions
          SET promoted_at = NOW(), active_users_at_promote = $3, stale_notified_at = NULL,
              reviewed_head_sha = CASE WHEN $4::boolean THEN reviewed_head_sha ELSE COALESCE($2, reviewed_head_sha) END,
              imported_pr_head_sha = CASE WHEN $4::boolean THEN COALESCE($2, imported_pr_head_sha) ELSE imported_pr_head_sha END,
              issue_link_seeded = issue_link_seeded OR $5::boolean
        WHERE id = $1`, [w.sessionId, w.head, w.electorate ?? null, !!w.imported, !!w.issueLinkSeeded]);
    if (!w.head) return;
    const { rowCount } = await tx.query('DELETE FROM pr_votes WHERE session_id = $1 AND head_sha IS DISTINCT FROM $2', [w.sessionId, w.head]);
    if (rowCount) {
      const { rows: [a] } = await tx.query('SELECT a.id, a.slug FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1', [w.sessionId]);
      if (a) ctx.push(voteUpdate({ sessionId: w.sessionId, appId: a.id, appSlug: a.slug, merged: false, headMoved: true }));
    }
  },
  // The vote requests, and the owner's "your agent put it up" when their
  // agent did.
  proposed: async (tx: Tx, w: any, ctx: WriteContext) => {
    named(ctx, await createPrProposedNotifications(tx, { appId: w.appId, sessionId: w.sessionId, proposerId: w.proposerId ?? null }));
    if (w.viaAgent) {
      named(ctx, await createConnectorSubmittedNotification(tx, { userId: w.proposerId, appId: w.appId, sessionId: w.sessionId, detail: 'submitted' }));
    }
  },
  // Back to Underway: its votes stop counting, nothing blocks it any more.
  unpromoted: async (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions SET approval_epoch = approval_epoch + 1, stale_notified_at = NULL,
            integration_block_reasons = '[]'::jsonb
      WHERE id = $1`, [w.sessionId]),
  resumed: async (tx: Tx, w: any) => tx.query('UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1', [w.sessionId]),
  // Closed: its votes stop counting (Q4); the work orders it held are
  // abandoned; a value it declared is discarded with it; the conversation
  // that started it hears; the bell stops asking about it.
  closed: async (tx: Tx, w: any, ctx: WriteContext) => {
    await tx.query('UPDATE chat_sessions SET approval_epoch = approval_epoch + 1 WHERE id = $1', [w.sessionId]);
    await tx.query(
      `UPDATE external_agent_tasks SET status = 'abandoned'
        WHERE origin_session_id = $1 AND status = 'open' AND session_id IS NULL`, [w.sessionId]);
    await tx.query(
      `UPDATE pending_secret_declarations SET status = 'discarded', value_enc = NULL
        WHERE session_id = $1 AND status = 'pending'`, [w.sessionId]);
    if (w.agentSessionId) {
      await changeClosed(tx, { change: { id: w.sessionId, agent_session_id: w.agentSessionId, pr_number: w.prNumber ?? null }, outcome: w.outcome });
    }
    for (const userId of await settleDecidedChange(tx, w.sessionId, { status: 'archived' })) {
      ctx.push(toUser(userId, { type: 'notifications_changed' }));
    }
  },
  claimed: async (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions SET merge_attempt_at = NOW(), integration_block_reasons = '[]'::jsonb WHERE id = $1`, [w.sessionId]),
  abandoned: async (tx: Tx, w: any) => tx.query(
    'UPDATE chat_sessions SET approval_epoch = approval_epoch + 1, stale_notified_at = NULL WHERE id = $1', [w.sessionId]),
  // The revision the group votes on moved: one statement, so the approvals
  // never describe neither the old code nor the new.
  headMoved: async (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions
        SET reviewed_head_sha = CASE WHEN $3 = 'reviewed' THEN $1 ELSE reviewed_head_sha END,
            imported_pr_head_sha = CASE WHEN $3 = 'imported' THEN $1 ELSE imported_pr_head_sha END,
            ${invalidateHeadMoveSql('$1', { fixParam: '$5' })},
            stale_notified_at = NULL,
            approval_epoch = approval_epoch + CASE WHEN $4::boolean THEN 0 ELSE 1 END
      WHERE id = $2`, [w.to, w.sessionId, w.column, !!w.keepVotes, !!w.fixOnly]),
  approvalsCleared: async (tx: Tx, w: any) => tx.query(
    'UPDATE chat_sessions SET approval_epoch = approval_epoch + 1 WHERE id = $1', [w.sessionId]),
  // Gone quiet: its author is warned once.
  staleWarned: async (tx: Tx, w: any, ctx: WriteContext) => {
    await tx.query('UPDATE chat_sessions SET stale_notified_at = NOW() WHERE id = $1', [w.sessionId]);
    named(ctx, await createStalePrNotification(tx, { userId: w.userId ?? null, appId: w.appId, sessionId: w.sessionId }));
  },
  staleCleared: async (tx: Tx, w: any) => tx.query('UPDATE chat_sessions SET stale_notified_at = NULL WHERE id = $1', [w.sessionId]),
  prCleared: async (tx: Tx, w: any) => tx.query(
    'UPDATE chat_sessions SET pr_number = NULL, pr_url = NULL WHERE id = $1 AND pr_number IS NOT DISTINCT FROM $2', [w.sessionId, w.prNumber ?? null]),
  ccPurged: async (tx: Tx, w: any) => tx.query('UPDATE chat_sessions SET cc_purged = TRUE WHERE id = $1', [w.sessionId]),
};
