// proposal: a proposal's lifecycle, from the moment somebody starts it until
// it is merged or closed. One instance per proposal (`session:<id>`), every
// chat_sessions row included (the Homeroom bot's triage and build sessions,
// the App bench's), adopted from its row by its first event.
//
//   underway  ── Promote ─▶ proposing ── review.open ─▶ in_review ── MergeRequested ─▶ (merge.gate)
//      ▲  ▲ (slot held / released / none)        │ failed       ▲   │ ready, claimed under the lock
//      │  └────────────────────────────────────────┘              │   ▼
//      │                                    refused, moved ◀── merging ── merge.attempt lost ─▶ unconfirmed
//      │◀── Unpromote ────────────────────────────────────────────┘ │ merged                  │ observed
//      │◀── Reopen ── closed ◀── Close (any reason) ── underway, proposing, in_review           │
//                                       merged ◀── Merged (merge-followups' message) ◀─────────┘
//
// The merge (step 6): the app's merge queue (src/workflow/merge-queue/)
// asks for a proposal (MergeRequested); the gate is measured as work
// (merge.gate: routes/votes.js evaluateMergeGate), every deciding input is
// read again under the lock (rules/merge-claim.ts, rules/pr-gate.ts), and
// GitHub is asked once (merge.attempt, observe-first on a retry). A lost
// answer is `unconfirmed` until GitHub says. A sync with main (branch.sync,
// for a person, a resume, the queue's conflict lane, a preview that will not
// start, a check main has fixed, the Homeroom bot) is data of underway or
// in_review: never while it is being merged, and no merge while it syncs.
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
import { boardMoved, chatLine, issueUpdate, sessionUpdate, toUser, voteUpdate } from '../pushes.ts';
import { changeClosed } from '../rules/agent-notes.ts';
import { settleDecidedChange } from '../rules/change-notifications.ts';
import { createConnectorSubmittedNotification, createPrProposedNotifications, createStalePrNotification } from '../rules/proposal-notifications.ts';
import { invalidateHeadMoveSql } from '../rules/summary-freshness.ts';
import { claimRefusal } from '../rules/merge-claim.ts';
import { APPROVER_NO_WINDOW_WORDS } from '../rules/governance-gate.ts';
import { toBotChange, withdrawnNote, writeBotChange } from '../rules/bot-notes.ts';
import { turnStop } from '../rules/turn-stop.ts';
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
  gate: 'merge.gate',
  attempt: 'merge.attempt',
  observe: 'merge.observe',
  sync: 'branch.sync',
  diagram: 'pr.diagram',
});
export const QUEUE = 'merge-queue';
export const appKey = (appId: number) => `app:${appId}`;
// The proposal's GitHub moves, run one at a time.
const PR_MOVES: ReadonlySet<string> = new Set([WORK.open, WORK.close, WORK.reopen, WORK.diagram]);

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
  // A maintenance campaign asked (src/workflow/campaign/): it hears whether
  // the proposal went up for a vote.
  campaign?: { key: string; appId: number } | null;
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
// A merge under way: the queue's ask, what the gate found, and where it is.
export interface Attempt {
  n: number;
  queueN: number;                    // the merge queue's ask: AttemptEnded names it
  force: boolean;
  forcedBy: string | null;
  stage: 'gate' | 'merge' | 'unconfirmed' | 'merged';
  head: string | null;
  epoch: number;
  tally: Json;                       // the gate's count, for the merged line
  observeTries: number;
  baseRetried?: boolean;             // GitHub said main moved: asked once more
  // merged: what merge-followups was told, said again until the row reads
  // merged (an older release's pod may refuse the message during a rollout).
  report?: Json | null;
  resends?: number;
}
// A sync with main under way, and the last one's outcome (for whoever waits).
export interface Sync {
  n: number;
  reason: string;
  head: string | null;
  queueN: number | null;
  approved: boolean;
  at: string;
  // A platform sync's once-record (boot failure, failing check): the head it
  // was written for, and what the row held before, put back when the sync
  // did nothing (it may then be asked again for that head).
  claimHead?: string | null;
  prev?: { bootHead?: string | null; fixedHead?: string | null; fixedKeys?: string[] } | null;
  // GitHub refused the head as a conflict the mirror measures clean: the
  // turn runs anyway.
  githubConflict?: boolean;
}
export interface SyncOutcome {
  n: number; reason: string; outcome: string; sha: string | null; message: string | null;
  behind?: number; pushOk?: boolean; conflictFiles?: string[];
}

export interface Data {
  sessionId: number;
  appId: number;
  imported: boolean;
  // A maintenance campaign's proposal (the platform's): like an imported
  // one, it holds no worker slot.
  platform?: boolean;
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
  attempt?: Attempt | null;
  // An admin's force (M4): it lasts until it merges, closes, leaves review
  // or its author pushes new code.
  force?: { by: string | null; userId: number | null; at: string } | null;
  sync?: Sync | null;
  lastSync?: SyncOutcome | null;
  // GitHub's last refusal (named once per head), what the AI could not
  // resolve (never paid for twice against the same main), and the back-off
  // after a sync the machinery under it broke.
  refused?: { head: string | null; main: string | null; kind: string } | null;
  gaveUp?: { head: string | null; main: string | null } | null;
  backoff?: { until: string; failures: number } | null;
}

const STATES = ['underway', 'proposing', 'in_review', 'merging', 'unconfirmed', 'merged', 'closed'] as const;
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
    case 'unconfirmed': return 'merging';
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
  // config.shots.enforce: a declared shots run must have verified the head.
  shotsEnforced?: boolean;
  // A closed proposal's CC volume is purged this long after it closed
  // (config.archivedRetentionMs; 0 or absent: kept).
  retentionMs?: number;
}

// A held session somebody works on is looked at again this soon.
export const IDLE_RECHECK_MS = 60 * 1000;
// A merge attempt that holds a proposal this long has lost its process.
export const CLAIM_STALE_MS = 5 * 60 * 1000;
// GitHub is asked again whether a merge it never answered happened: after a
// minute, doubling to every ten.
export const OBSERVE_MIN_MS = 60 * 1000;
export const OBSERVE_MAX_MS = 10 * 60 * 1000;
// A sync whose machinery broke is not asked again for two minutes, doubling
// to half an hour.
export const SYNC_BACKOFF_MS = 2 * 60 * 1000;
// A pull request closed on GitHub closes its proposal once the close has
// stood this long: an author closes and reopens one to run its CI again, and
// the webhook's `closed` comes first. The next look settles it.
export const PR_CLOSE_SETTLES_MS = 5 * 60 * 1000;
// A close reading is acted on only while it is this fresh: one asked again
// long after it was read (refused during a rollout, re-asked once the older
// release is gone) may predate a reopen. The next look reads GitHub anew. A
// merge is final, whenever it was read.
export const PR_LOOK_STALE_MS = 10 * 60 * 1000;
// A merge merge-followups has not recorded yet is told again after this,
// doubling to the max (MERGED_RESEND_MAX_MS).
export const MERGED_RESEND_MS = 5 * 60 * 1000;
export const MERGED_RESEND_MAX_MS = 30 * 60 * 1000;
// The outcomes of a sync that did nothing to the branch: a platform sync's
// once-record is put back, so it may be asked again for that head.
// 'code_missing': the branch did not come across from GitHub
// (services/code-missing.js), so there was nothing to sync.
const NOTHING_RAN: ReadonlySet<string> = new Set(['unmeasured', 'over_budget', 'gone', 'error', 'busy', 'not_pushed', 'stopped', 'code_missing']);
export const SYNC_BACKOFF_MAX_MS = 30 * 60 * 1000;
// Why a sync with main is asked for.
export const SYNC_REASONS: ReadonlySet<string> = new Set([
  'person', 'resume', 'conflict', 'boot_failure', 'fixed_check', 'bot_fix', 'bot_handoff',
]);
// The platform's syncs for a failing check: once per head, the keys recorded
// beside it (services/fixed-check-sync.js).
const CHECK_SYNCS: ReadonlySet<string> = new Set(['fixed_check', 'bot_fix', 'bot_handoff']);
const BOT_HANDOFF_KEY = 'homeroom_bot:handoff';

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
// The campaign that asked for a promote, and its app.
const campaignRef = (c: any) => {
  if (c == null) return null;
  const key = String(c?.key || '');
  if (!/^campaign:[1-9][0-9]*$/.test(key)) throw new Error('campaign.key must name a campaign');
  return { key, appId: int(c?.appId, 'campaign.appId') };
};
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
      ...ownOperation(p), campaign: campaignRef(p?.campaign) };
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
  Reopen: (p: any) => ({ ...session(p), from: from(p), userId: int(p?.userId, 'userId'), ...deadline(p) }),
  // merge-followups moved it into 'merged' (a merge, or a change carried by
  // another's).
  Merged: (p: any) => ({ ...session(p) }),
  // GitHub's word on its pull request, as a look read it (an import's,
  // services/pr-import-sync.js, or a native one's merged by hand,
  // proposal-scans.js): merged, or closed and when. `tally`: the votes it
  // stood at, for a merge's record.
  PrLooked: (p: any) => ({ ...session(p), from: from(p), merged: !!p?.merged, closed: !!p?.closed,
    mergeSha: text(p?.mergeSha, 64), mergedAt: text(p?.mergedAt, 40), closedAt: text(p?.closedAt, 40), readAt: text(p?.readAt, 40),
    tally: p?.tally == null ? null : {
      yes: Math.max(0, Number(p.tally.yes) | 0),
      required: p.tally.required == null ? null : Math.max(0, Number(p.tally.required) | 0),
      active: p.tally.active == null ? null : Math.max(0, Number(p.tally.active) | 0),
    } }),
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
  // The app's merge queue asks for the proposal (its ask's n), forced when
  // the proposal holds an admin's force.
  MergeRequested: (p: any) => ({ ...session(p), queueN: int(p?.queueN, 'queueN'), force: !!p?.force }),
  // An admin forces the merge (the admin-merge route, a fleet campaign).
  ForceMerge: (p: any) => ({ ...session(p), from: from(p), userId: optInt(p?.userId, 'userId'), username: text(p?.username, 100) }),
  // A sync with main, and why. `head`: the commit the asker read (a boot
  // failure's, a failing check's); `keys`: the checks a check sync is for;
  // `queueN`: the merge queue's ask (answered with ResolutionEnded);
  // `approved`: the group has said yes (rule C).
  SyncRequested: (p: any) => {
    const reason = word(p?.reason, 'reason');
    if (!SYNC_REASONS.has(reason)) throw new Error(`reason ${reason} is not a sync`);
    const keys = p?.keys == null ? null : (Array.isArray(p.keys) ? p.keys : [])
      .map((k: unknown) => text(k, 300)).filter(Boolean) as string[];
    return { ...session(p), reason, head: optSha(p?.head, 'head'), keys, queueN: optInt(p?.queueN, 'queueN'),
      approved: !!p?.approved, userId: optInt(p?.userId, 'userId'), githubConflict: !!p?.githubConflict };
  },
  // A person's Stop of the turn the proposal's sync runs (the session's
  // Stop routes, through platform.stopWorkflowTurn).
  StopRequested: (p: any) => ({ ...session(p), by: text(p?.by, 100) }),
  // The timer: ask GitHub again whether an unanswered merge happened.
  ObserveDue: () => ({}),
  // The boot's look at an instance waiting with no deadline (one an older
  // release wrote): its clock is armed again.
  Rearm: (p: any) => ({ ...session(p) }),
  // A hosted build declared its change's diagram (#4490), stored with this
  // event (services/proposal-diagram.js storeDeclared): the pull request's
  // body is owed its block.
  DiagramStored: (p: any) => ({ ...session(p) }),
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
  // A row adopted as `merging` with no attempt of this machine's: GitHub is
  // asked about it once it is old enough that whoever merged it is gone.
  if (s.name === 'merging' && !s.data.attempt) {
    const at = s.data.claim?.at ? Date.parse(s.data.claim.at) : ctx.now.getTime();
    return { at: new Date(Math.max(at + CLAIM_STALE_MS, ctx.now.getTime() + 1000)), event: { type: 'ObserveDue' } };
  }
  if (s.name === 'merging' && s.data.attempt?.stage === 'merged') {
    const tries = s.data.attempt.resends || 0;
    return { at: later(ctx, Math.min(MERGED_RESEND_MAX_MS, MERGED_RESEND_MS * 2 ** tries)), event: { type: 'ObserveDue' } };
  }
  if (s.name === 'unconfirmed') {
    const tries = s.data.attempt?.observeTries || 0;
    return { at: later(ctx, Math.min(OBSERVE_MAX_MS, OBSERVE_MIN_MS * 2 ** tries)), event: { type: 'ObserveDue' } };
  }
  return null;
}

// The state a row it does not hold yet stands for.
function adopt(sessionId: number, row: Row): Live {
  const data: Data = {
    sessionId, appId: row.appId, imported: row.imported, ...(row.platform ? { platform: true } : {}),
    slot: row.imported || row.platform ? 'none' : 'held',
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
  // A diagram's block written from what is stored when it runs: one still
  // waiting writes what a newer one would.
  const kept = (settles ? d.pr.next.filter((x) => x.kind === WORK.open) : d.pr.next)
    .filter((x) => !(w.kind === WORK.diagram && x.kind === WORK.diagram));
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
// An imported proposal and a campaign's hold no worker slot.
const noSlot = (d: Data) => d.imported || !!d.platform;
const slotFor = (d: Data, prior: string | null = null): Slot =>
  (noSlot(d) ? 'none' : prior === 'active' ? 'held' : 'released');

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
// placement stage in every web process (pushes.ts boardMoved).
const board = (f: Facts, action: string, extra: Record<string, Json> = {}): Push =>
  boardMoved(sessionUpdate({ action, sessionId: f.row!.id, appId: f.row!.appId, appSlug: f.row!.appSlug, ...extra }));
const votes = (f: Facts, extra: Record<string, Json> = {}): Push =>
  voteUpdate({ sessionId: f.row!.id, appId: f.row!.appId, appSlug: f.row!.appSlug, merged: false, ...extra });

const toPreview = (d: Data, type: string, payload: Record<string, Json>): MessageRequest =>
  ({ to: { machine: 'preview', key: sessionKey(d.sessionId) }, event: { type, payload: { sessionId: d.sessionId, ...payload } }, appId: d.appId });
const toShots = (d: Data, type: string, payload: Record<string, Json>): MessageRequest =>
  ({ to: { machine: 'shots', key: sessionKey(d.sessionId) }, event: { type, payload: { sessionId: d.sessionId, ...payload } }, appId: d.appId });
// The app's merge queue (src/workflow/merge-queue/).
const toQueue = (d: Data, type: string, payload: Record<string, Json>): MessageRequest =>
  ({ to: { machine: QUEUE, key: appKey(d.appId) }, event: { type, payload: { appId: d.appId, sessionId: d.sessionId, ...payload } }, appId: d.appId });
// The maintenance campaign that asked for its promote (src/workflow/campaign/).
const toCampaign = (d: Data, c: { key: string; appId: number }, type: string, payload: Record<string, Json>): MessageRequest =>
  ({ to: { machine: 'campaign', key: c.key }, event: { type, payload: { appId: c.appId, sessionId: d.sessionId, ...payload } }, appId: d.appId });
// merge-followups: GitHub merged it. Its instance is created by this, and it
// moves the proposal into 'merged' with everything that goes with it.
const toFollowups = (d: Data, payload: Record<string, Json>): MessageRequest =>
  ({ to: { machine: 'merge-followups', key: sessionKey(d.sessionId) }, event: { type: 'Merged', payload: { sessionId: d.sessionId, ...payload } }, appId: d.appId });

// What the worker needs when a proposal ends its turn at a slot or closes.
const destroyWorker = (d: Data, n: number): WorkRequest => ({ kind: WORK.destroy, key: `destroy:${n}`, input: { sessionId: d.sessionId } });


// The thread line of a close, in Homeroom's words (a change, never "PR #n").
function closedLine(r: Row, reason: string, byOwner: boolean): string {
  const l = label(r);
  switch (reason) {
    case 'auto-rejected': return `${l} was set aside for now (more No than Yes, and not enough support to carry it).`;
    case 'admin-no': return `${l} was set aside: an admin voted No and nobody voted Yes within a week. It can always come back as a new change.`;
    case 'approver-no': return `${l} was set aside: an approver voted No and nobody voted Yes within ${APPROVER_NO_WINDOW_WORDS}. It can always come back as a new change.`;
    case 'proposal-replaced':
      return byOwner && r.ownerName ? `${r.ownerName} replaced ${r.prTitle ? l : 'this change'} with a new one.` : `${l} was replaced by a new one.`;
    case 'superseded': return `${l} was withdrawn: another change for the same request covers it.`;
    case 'request-closed': return `${l} was withdrawn: the request it was built for is closed.`;
    case 'red-checks': return `${l} was withdrawn: its checks failed and nobody changed it for a few days.`;
    case 'stale-pr': return `${l} went quiet and was set aside. It can always come back as a new change.`;
    case 'campaign-refused': return `${l} could not be put up for a vote and was closed. The maintenance campaign can make it again.`;
    case 'pr-closed': return `${l} was closed on GitHub, so it is closed here too.`;
    case 'pr-merged': return `${l} was merged on GitHub before it went up for a vote, so it is closed here.`;
    case 'manual':
      return byOwner && r.ownerName ? `${r.ownerName} withdrew ${r.prTitle ? l : 'this change'}.` : `${l} was withdrawn.`;
    default: return `${l} was withdrawn.`;
  }
}

// The closes that follow GitHub's own (services/pr-import-sync.js).
const GITHUB_SETTLED: ReadonlySet<string> = new Set(['pr-closed', 'pr-merged']);

// How a conversation that started the change words its close
// (rules/agent-notes.ts closedSentence).
const OUTCOMES: ReadonlyMap<string, string> = new Map([
  ['auto-rejected', 'rejected'], ['admin-no', 'admin-no'], ['approver-no', 'approver-no'], ['proposal-replaced', 'replaced'], ['manual', 'withdrawn'],
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
    expectedHead: p.expectedHead, viaAgent: p.viaAgent, headAt: f.row!.head, campaign: p.campaign ?? null };
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
    // A page that stopped waiting (the route answered 202) reads it again;
    // a campaign that asked hears it.
    return step(back, { work: done.work, timer: timerFor(back, f, ctx, deps), push: [board(f, 'promote_failed', { error: code })],
      messages: promoting.campaign ? [toCampaign(back.data, promoting.campaign, 'ProposalRefused',
        { code, message: p.error?.message?.slice(0, 500) ?? null })] : undefined });
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
  return step(next, {
    writes: [
      // A change of the Homeroom bot's: its change machine follows it from here.
      toBotChange(d.sessionId, 'Proposed'),
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
    // The app's merge queue hears it is in line (it sweeps its line from
    // then on, so a conflict before any vote is looked at too).
    messages: [...(head ? [toPreview(d, 'RevisionSubmitted', { head, source: d.imported ? 'imported' : 'promote', trigger: 'promote-kick' })] : []),
      toQueue(d, 'MergeWanted', { reason: 'promoted' }),
      ...(promoting.campaign ? [toCampaign(d, promoting.campaign, 'ProposalOpened', { prNumber: prNumber || null })] : [])],
    timer: timerFor(next, f, ctx, deps),
  });
}

const unpromote: Handler = (s, e, f, ctx, deps) => {
  const n = s.data.n + 1;
  const destroy = destroyWorker(s.data, n);
  const next: Live = { name: 'underway', data: { ...(noSlot(s.data) ? s.data : doom(s.data, destroy)), n, slot: slotFor(s.data), force: null } };
  const who = e.payload.username || 'The author';
  return step(next, {
    writes: [
      { type: 'unpromoted', sessionId: s.data.sessionId },
      line(e, s.data, `${who} moved ${prLabel(f.row!)} back to Underway. Its votes were cleared, and it goes up for a fresh vote when it is proposed again`),
    ],
    work: noSlot(s.data) ? [] : [destroy],
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
  const next: Live = { name: 'underway', data: { ...spared.data, slot: noSlot(s.data) ? 'none' : 'held' } };
  // last_activity_at moves with it: the idle timer runs from now.
  const timer = deps.idleMs > 0 && !noSlot(s.data) ? { at: later(ctx, deps.idleMs), event: { type: 'IdleCheck' } } : null;
  return step(next, { writes: [{ type: 'resumed', sessionId: s.data.sessionId }], push: [board(f, 'resumed')], timer,
    cancel: spared.cancel });
};

// Closed, for any reason, by one path (R3): the database's part commits with
// the move, the rest is durable work, and the preview is retired for good
// (the preview machine tells the shots machine).
function close(s: Live, e: Event<any>, f: Facts, reason: string, more: { byOwner?: boolean; purgeCc?: boolean } = {}): Outcome<PState> {
  const row = f.row!;
  const n = s.data.n + 1;
  let d: Data = { ...s.data, n, reason, promoting: null, claim: null, force: null, attempt: null, sync: null,
    answer: s.name === 'proposing' && s.data.promoting
      ? { n: s.data.promoting.n, ok: false, code: 'session_state_changed' } : s.data.answer };
  // A gate or a sync under way is ended with it (the worker's removal below
  // stops a sync's turn); the queue that asked for it hears.
  const { told, cancel, work: stops } = endSlots(s.data, 'declined', { reason: 'closed' });
  const destroy = destroyWorker(d, n);
  d = doom(d, destroy);
  const work: WorkRequest[] = [...stops, destroy];
  // Its pull request is closed; one GitHub is still opening for it (a
  // promote under way) is closed once it has, by the number it then has.
  // One GitHub closed or merged itself is left as it is: closing it again
  // would close an author's reopen.
  const pr = GITHUB_SETTLED.has(reason) ? null
    : repoInput(f) || (s.name === 'proposing' && row.repo ? { owner: row.repo.owner, repo: row.repo.repo, number: null } : null);
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
  if (reason === 'request-closed') {
    // A change of the Homeroom bot's withdrawn because every request it is
    // for was closed (homeroom-bot-closed-requests.js): each request's
    // thread says so, with the close.
    for (const n of row.linkedIssues) writes.push({ type: 'withdrawnLine', eventId: e.id, appId: d.appId, sessionId: d.sessionId, issueNumber: n });
  }
  // A change of the Homeroom bot's: its change machine ends with it.
  writes.push(toBotChange(d.sessionId, 'Closed', { reason }));
  const push = [board(f, 'archived'), votes(f)];
  if (row.linkedIssues.length) push.push(issueUpdate({ action: 'updated', source: 'session_archived', appSlug: row.appSlug, appId: row.appId }));
  return step({ name: 'closed', data: d }, {
    writes, work, push, timer: null, cancel,
    messages: [toPreview(d, 'RetireRequested', { reason: 'archived', terminal: true }), ...told],
  });
}

const closeEvent: Handler = (s, e, f) =>
  close(s, e, f, e.payload.reason, { byOwner: e.payload.userId != null && e.payload.userId === f.row!.userId, purgeCc: e.payload.purgeCc });

// GitHub merged or closed its pull request (the guard left the rest): merged
// while up for its vote is a merge, which merge-followups records; merged
// before it, or closed, closes the proposal.
const prLooked: Handler = (s, e, f, ctx) => (e.payload.merged && s.name === 'in_review'
  ? mergedOnGithub(s, f, ctx, { sha: e.payload.mergeSha, mergedAt: e.payload.mergedAt, tally: e.payload.tally }, 'recovery')
  : close(s, e, f, e.payload.merged ? 'pr-merged' : 'pr-closed'));

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

// Off the vote for good: its pull request is closed on GitHub and could not
// be reopened (a merge attempt's answer). Every exit from review voids the
// votes (Q4, bug 19).
const abandoned: Handler = (s, e, f, ctx, deps) => {
  // Its force, its gate or attempt and its sync end with it (a force never
  // outlives the proposal it was given to).
  const { told, cancel, work } = endSlots(s.data, 'declined', { reason: 'closed' });
  const next: Live = { name: 'underway', data: { ...s.data, claim: null, slot: slotFor(s.data), force: null, attempt: null, sync: null } };
  return step(next, {
    messages: told, cancel, work,
    writes: [
      { type: 'abandoned', sessionId: s.data.sessionId },
      line(e, s.data, `${prLabel(f.row!)} is closed on GitHub and couldn't be reopened, so it has been taken off the vote panel. Re-propose it from the session's dev-chat.`),
    ],
    push: [votes(f, { merging: false, mergeFailed: true, resolving: false, selfHosted: f.row!.selfHosted }), board(f, 'paused')],
    timer: timerFor(next, f, ctx, deps),
  });
};

// The merge queue's slots this proposal holds, ended: its gate or attempt
// and its sync are cancelled, and the queue that asked for them hears (a
// stage already reported, unconfirmed or merged, has told it).
function endSlots(d: Data, outcome: string, extra: Record<string, Json> = {}, by: string | null = null): { told: MessageRequest[]; cancel: { kind: string; key: string }[]; work: WorkRequest[] } {
  const told: MessageRequest[] = [];
  const cancel: { kind: string; key: string }[] = [];
  const work: WorkRequest[] = [];
  const a = d.attempt;
  if (a?.stage === 'gate') cancel.push({ kind: WORK.gate, key: `gate:${a.n}` });
  if (a?.stage === 'merge') cancel.push({ kind: WORK.attempt, key: `attempt:${a.n}` });
  if (a && (a.stage === 'gate' || a.stage === 'merge')) told.push(ended(d, a, outcome, extra));
  if (d.sync) {
    cancel.push({ kind: WORK.sync, key: `sync:${d.sync.n}` });
    told.push(...resolved(d, d.sync, outcome));
    // The cancel ends the sync's handler, not its turn: the turn is stopped
    // (only that one, by its record) and its record released.
    work.push(syncStop(d, d.sync.n, by));
  }
  return { told, cancel, work };
}

// The turn of the sync `n` stopped, from any process (src/workflow/turn-stop.ts).
const syncStop = (d: Data, n: number, by: string | null): WorkRequest =>
  turnStop({ sessionId: d.sessionId, machine: MACHINE, key: sessionKey(d.sessionId), kinds: [WORK.sync], workKey: `sync:${n}`, by, release: true }, `sync:${n}`);

// A person's Stop of the sync under way (POST /api/sessions/:id/stop, the
// agent conversation's Stop): it ends as stopped by them, never as a
// conflict it could not resolve, and gives its once-record back, so the
// platform asks again when it next needs it.
const stopRequested: Handler = (s, e, f) => {
  const sync = s.data.sync;
  if (!sync) return step(s);
  const by = e.payload.by ?? e.actor ?? null;
  const message = by ? `Sync with main stopped by ${by}. The branch is unchanged.` : 'Sync with main stopped. The branch is unchanged.';
  let d: Data = { ...s.data, sync: null,
    lastSync: { n: sync.n, reason: sync.reason, outcome: 'stopped', sha: null, message, behind: 0, pushOk: false, conflictFiles: [] } };
  const writes: DomainWrite[] = [];
  if (sync.claimHead && sync.prev) {
    if (sync.reason === 'boot_failure') writes.push({ type: 'bootFailureRelease', sessionId: d.sessionId, head: sync.claimHead, prev: sync.prev.bootHead ?? null });
    else if (CHECK_SYNCS.has(sync.reason)) {
      writes.push({ type: 'fixedCheckRelease', sessionId: d.sessionId, head: sync.claimHead, prevHead: sync.prev.fixedHead ?? null, prevKeys: sync.prev.fixedKeys || [] });
    }
  }
  if (sync.reason === 'conflict') writes.push({ type: 'blockReasons', sessionId: d.sessionId, reasons: [] });
  d = { ...d, backoff: null };
  // The person's change page clears its sync banner at once (as the sync's
  // own end does, services/sync-main.js broadcastSyncStatus).
  const status = f.row ? [sessionUpdate({ action: 'sync_status', sessionId: f.row.id, appId: f.row.appId, appSlug: f.row.appSlug,
    state: 'done', syncResult: 'stopped', message })] : [];
  return step({ name: s.name, data: d } as Live, {
    writes,
    push: [...(sync.reason === 'conflict' ? [votes(f, { integrating: false })] : []), ...status],
    messages: resolved(d, sync, 'stopped'),
    cancel: [{ kind: WORK.sync, key: `sync:${sync.n}` }],
    work: [syncStop(s.data, sync.n, by)],
  });
};

// merge-followups moved it into merged (its own merge, a merge by hand, a
// change carried by another's): whatever the queue asked of it ends.
const merged: Handler = (s) => {
  const { told, cancel, work } = endSlots(s.data, 'merged');
  const out: Live = { name: 'merged', data: { ...s.data, claim: null, promoting: null, force: null, sync: null,
    attempt: s.data.attempt ? { ...s.data.attempt, stage: 'merged' } : null } };
  return step(out, { timer: null, messages: told, cancel, work });
};

// ── The merge (step 6) ──────────────────────────────────────────────────

const ended = (d: Data, a: Attempt, outcome: string, extra: Record<string, Json> = {}): MessageRequest =>
  toQueue(d, 'AttemptEnded', { n: a.queueN, outcome, ...extra });
const resolved = (d: Data, sync: Sync, outcome: string): MessageRequest[] =>
  (sync.queueN ? [toQueue(d, 'ResolutionEnded', { n: sync.queueN, outcome })] : []);

// The queue asked for a proposal that cannot be merged now: it is told why,
// and asks for the next.
function declineAsk(s: Live, e: Event<any>, reason: string): Outcome<PState> {
  return step(s, { messages: [toQueue(s.data, 'AttemptEnded', { n: e.payload.queueN, outcome: 'declined', reason })] });
}

// Why the queue's ask is declined, or null: only a proposal in review that
// nothing else is merging, syncing or moving is measured.
function askRefusal(s: Live, f: Facts): string | null {
  if (f.row?.status === 'merged' || s.name === 'merged') return 'merged';
  if (s.name === 'merging' || s.name === 'unconfirmed') return 'in_progress';
  if (s.name !== 'in_review') return 'not_in_review';
  if (s.data.attempt) return 'in_progress';
  if (s.data.sync) return 'syncing';
  // A merge does not wait for the shots agent's turn (facts.ts mergeMoving).
  if (f.row!.mergeMoving) return 'busy';
  return null;
}

// The queue asks: the gate is measured (merge.gate), the proposal still in
// review while it is.
const mergeRequested: Handler = (s, e, f) => {
  const why = askRefusal(s, f);
  if (why) return declineAsk(s, e, why);
  const n = s.data.n + 1;
  const force = !!e.payload.force && !!s.data.force;
  const attempt: Attempt = { n, queueN: e.payload.queueN, force, forcedBy: force ? s.data.force!.by : null,
    stage: 'gate', head: f.row!.head, epoch: f.row!.epoch, tally: null, observeTries: 0 };
  return step({ name: s.name, data: { ...s.data, n, attempt } } as Live, {
    work: [{ kind: WORK.gate, key: `gate:${n}`, input: { sessionId: s.data.sessionId, n, force, forcedBy: attempt.forcedBy } }],
  });
};

// The gate reported. Ready: every deciding input is read again under the
// lock (facts.claim) and the proposal is claimed, or the queue is told why
// not.
function gated(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const a = s.data.attempt!;
  const r = (e.type === 'WorkSucceeded' ? e.payload.result : null) as any;
  const back = (reason: string, extra: Record<string, Json> = {}): Outcome<PState> =>
    step({ name: s.name, data: { ...s.data, attempt: null } } as Live, { messages: [ended(s.data, a, 'declined', { reason, ...extra })] });
  if (!r) return back('gate_failed');
  if (!r.ready) return back(String(r.blockReason || r.reason || 'blocked'));
  const row = f.row!;
  if (r.head !== row.head || a.head !== row.head) return back('head_moved');
  if (r.epoch !== row.epoch || a.epoch !== row.epoch) return back('epoch_moved');
  const refusal = f.claim ? claimRefusal(f.claim, {
    head: row.head, force: a.force, shotsEnforced: !!deps.shotsEnforced, mainPassThrough: !!r.mainPassThrough,
    votesMergeable: !!f.gate?.mergeable,
  }) : 'session_not_found';
  if (refusal) return back(refusal);
  const attempt: Attempt = { ...a, stage: 'merge', tally: (r.tally ?? null) as Json };
  const next: Live = { name: 'merging', data: { ...s.data, attempt, claim: { n: a.n, at: ctx.now.toISOString() } } };
  return step(next, {
    writes: [{ type: 'claimed', sessionId: s.data.sessionId }],
    push: [votes(f, { merging: true, selfHosted: row.selfHosted })],
    work: [{ kind: WORK.attempt, key: `attempt:${a.n}`, input: { sessionId: s.data.sessionId, n: a.n, head: row.head } }],
    timer: null,
  });
}

// GitHub merged it: merge-followups is told (it moves the proposal into
// 'merged' and runs every follow-up), and so is the queue. The proposal
// reads merging until merge-followups' Merged arrives.
function mergedOnGithub(s: Live, f: Facts, ctx: TransitionContext, r: any, observedBy: string): Outcome<PState> {
  const a = s.data.attempt;
  const report: Record<string, Json> = {
    mergeSha: r?.sha ?? null, mergedAt: r?.mergedAt || ctx.now.toISOString(), force: !!a?.force,
    forcedBy: a?.forcedBy ?? null, observedBy, tally: (a?.tally ?? r?.tally ?? null) as Json,
  };
  const merging: Attempt = a ? { ...a, stage: 'merged', report, resends: 0 }
    : { n: s.data.n, queueN: 0, force: false, forcedBy: null, stage: 'merged', head: f.row?.head ?? null, epoch: f.row?.epoch ?? 0,
      tally: null, observeTries: 0, report, resends: 0 };
  const d = { ...s.data, attempt: merging };
  const messages: MessageRequest[] = [toFollowups(d, report)];
  if (a && a.stage !== 'unconfirmed') messages.push(ended(d, a, 'merged'));
  const next: Live = { name: 'merging', data: d };
  // Told again until the row reads merged (an older release's pod may
  // refuse the message during a rollout; a second Merged is ignored).
  return step(next, { messages, timer: { at: later(ctx, MERGED_RESEND_MS), event: { type: 'ObserveDue' } } });
}

// Back to review after an attempt that did not merge (its votes kept).
function backToReview(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps, more: {
  outcome: string; line?: string | null; writes?: DomainWrite[]; extra?: Record<string, Json>; push?: Record<string, Json>;
  refused?: Data['refused'];
}): Outcome<PState> {
  const a = s.data.attempt;
  const d: Data = { ...s.data, attempt: null, claim: null, ...(more.refused !== undefined ? { refused: more.refused } : {}) };
  const next: Live = { name: 'in_review', data: d };
  const writes = [...(more.writes || [])];
  if (more.line) writes.push({ ...line(e, d, more.line), dedupe: true });
  return step(next, {
    writes,
    push: [votes(f, { merging: false, ...(more.push || {}), selfHosted: f.row!.selfHosted })],
    messages: a ? [ended(d, a, more.outcome, more.extra || {})] : [],
    timer: timerFor(next, f, ctx, deps),
  });
}

// merge.attempt reported: one named outcome (routes/votes.js attemptMerge).
function attempted(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const a = s.data.attempt!;
  if (e.type === 'WorkExhausted') {
    // GitHub never answered: it may have merged. Nothing moves the proposal
    // until GitHub says (merge trace bug 1).
    const next: Live = { name: 'unconfirmed', data: { ...s.data, attempt: { ...a, stage: 'unconfirmed', observeTries: 0 } } };
    return step(next, {
      writes: [line(e, s.data, `${prLabel(f.row!)}: GitHub was asked to merge it and has not answered. Homeroom keeps asking GitHub whether it merged; until then it stays as it is.`)],
      messages: [ended(s.data, a, 'unconfirmed')],
      timer: timerFor(next, f, ctx, deps),
    });
  }
  const r = (e.type === 'WorkSucceeded' ? e.payload.result : { outcome: 'refused', kind: 'blocked', message: null }) as any;
  switch (r?.outcome) {
    case 'merged': return mergedOnGithub(s, f, ctx, r, r.observed ? 'recovery' : 'merge');
    case 'head_moved':
      return backToReview(s, e, f, ctx, deps, { outcome: 'head_moved', line: r.message, extra: { votesKept: !!r.votesKept }, push: { headMoved: true } });
    case 'unverified': return backToReview(s, e, f, ctx, deps, { outcome: 'unverified', line: r.message });
    case 'reopened': return backToReview(s, e, f, ctx, deps, { outcome: 'reopened', extra: { votesKept: true } });
    case 'closed': {
      const out = abandoned({ ...s, data: { ...s.data, attempt: null } }, e, f, ctx, deps);
      return { ...out, messages: [...(out.messages || []), ended(s.data, a, 'closed')] };
    }
    case 'gone': return backToReview(s, e, f, ctx, deps, { outcome: 'gone' });
    // GitHub's limit: not merged, nothing said against this head, and an
    // earlier refusal this ask was retrying is forgotten too: the queue's
    // next look (its sweep) asks again.
    case 'rate_limited': return backToReview(s, e, f, ctx, deps, { outcome: 'rate_limited', refused: null });
    default: {
      const kind = String(r?.kind || 'blocked');
      // Main moved between the gate and GitHub's merge: asked once more at
      // once (Q4), still claimed.
      if (kind === 'base_moved' && !a.baseRetried) {
        const n = s.data.n + 1;
        const again: Attempt = { ...a, n, baseRetried: true };
        return step({ name: 'merging', data: { ...s.data, n, attempt: again } }, {
          work: [{ kind: WORK.attempt, key: `attempt:${n}`, input: { sessionId: s.data.sessionId, n, head: f.row!.head } }],
        });
      }
      // Refused: named once per head, so a refusal the queue meets again
      // says nothing new (merge trace bug 2). Main moving twice is not a
      // refusal of this head (an earlier one is forgotten): the next ask tries it again.
      const said = s.data.refused && s.data.refused.head === f.row!.head && s.data.refused.kind === kind;
      const writes: DomainWrite[] = kind === 'conflict' ? [{ type: 'conflictMarked', sessionId: s.data.sessionId }] : [];
      return backToReview(s, e, f, ctx, deps, {
        outcome: 'refused', extra: { kind }, line: said ? null : (r?.message || null), writes,
        push: { mergeFailed: true, resolving: kind === 'conflict' },
        refused: kind === 'base_moved' ? null : { head: f.row!.head, main: f.row!.integrationMain, kind },
      });
    }
  }
}

// The clock: GitHub is asked whether an unanswered merge happened (an
// attempt of this machine's, or a row adopted as merging with none).
const observeDue: Handler = (s, e, f, ctx, deps) => {
  const a = s.data.attempt;
  if (a?.stage === 'merged') {
    const next: Live = { name: 'merging', data: { ...s.data, attempt: { ...a, resends: (a.resends || 0) + 1 } } };
    return step(next, { messages: [toFollowups(s.data, (a.report || {}) as Record<string, Json>)], timer: timerFor(next, f, ctx, deps) });
  }
  const n = s.data.n + 1;
  return step({ name: s.name, data: { ...s.data, n } } as Live, {
    work: [{ kind: WORK.observe, key: `observe:${n}`, input: { sessionId: s.data.sessionId } }],
    timer: null,
  });
};

function observed(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const r = (e.type === 'WorkSucceeded' ? e.payload.result : null) as any;
  if (!r) {
    // GitHub could not be read: asked again later.
    const a = s.data.attempt;
    const next = { name: s.name, data: { ...s.data, ...(a ? { attempt: { ...a, observeTries: a.observeTries + 1 } } : {}) } } as Live;
    return step(next, { timer: s.name === 'unconfirmed' ? timerFor(next, f, ctx, deps)
      : { at: later(ctx, OBSERVE_MIN_MS), event: { type: 'ObserveDue' } } });
  }
  if (r.merged) return mergedOnGithub(s, f, ctx, r, 'recovery');
  // Not merged (or the pull request is gone): back to review.
  return backToReview(s, e, f, ctx, deps, {
    outcome: 'not_merged',
    line: s.name === 'unconfirmed' ? `${prLabel(f.row!)}: GitHub says it did not merge it. It is back up for its vote.` : null,
  });
}

// An admin forces the merge (M4): it lasts until it merges, closes, leaves
// review or its author pushes new code.
const forceMerge: Handler = (s, e, f, ctx) => step(
  { name: s.name, data: { ...s.data, force: { by: e.payload.username ?? null, userId: e.payload.userId ?? null, at: ctx.now.toISOString() } } } as Live,
  { messages: [toQueue(s.data, 'MergeWanted', { reason: 'force', force: true })] },
);

// Why a sync is refused now, or null (rules each reason keeps).
function syncRefusal(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): string | null {
  const p = e.payload;
  const row = f.row!;
  if (row.status === 'merged' || s.name === 'merged') return 'merged';
  if (s.name === 'merging' || s.name === 'unconfirmed') return 'merging';
  if (s.name !== 'underway' && s.name !== 'in_review') return s.name === 'closed' ? 'closed' : 'not_underway';
  if (s.data.sync) return 'in_progress';
  if (s.data.attempt) return 'merging';
  // A platform sync for a head (a boot failure, a failing check) waits in its
  // work for whoever is working on the session (sync-main.waitForIdle), as
  // the old one did; a person's and the queue's are refused.
  const waits = p.reason === 'boot_failure' || CHECK_SYNCS.has(p.reason);
  if (!waits && (row.activeTurn || moving(row))) return 'busy';
  if (!row.branch || !row.repo) return 'no_branch';
  if (p.reason === 'boot_failure' || CHECK_SYNCS.has(p.reason)) {
    if (s.name !== 'in_review') return 'not_promoted';
    if (s.data.imported) return 'imported';
    if (!p.head || row.checksCommitSha !== p.head) return 'head_moved';
    if (p.reason === 'boot_failure') {
      if (row.bootFailureSyncHead === p.head) return 'already_tried';
    } else {
      if (row.checkState !== 'failing') return 'not_failing';
      if (row.fixedCheckSyncHead === p.head) return 'already_tried';
      if (p.reason === 'bot_handoff' && row.fixedCheckSyncKeys.includes(BOT_HANDOFF_KEY)) return 'already_tried';
    }
  }
  if (p.reason === 'conflict') {
    if (s.name !== 'in_review') return 'not_promoted';
    if (row.forkHead) return 'fork_head';
    const g = s.data.gaveUp;
    if (g && g.head === row.integrationHead && (g.main == null || row.integrationMain == null || g.main === row.integrationMain)) return 'unresolvable';
    if (s.data.backoff && Date.parse(s.data.backoff.until) > ctx.now.getTime()) return 'sync_backoff';
    if (!p.approved && row.integrationResolvedEpoch === row.epoch) return 'awaiting_approval';
  }
  return null;
}

const syncRequested: Handler = (s, e, f, ctx) => {
  const p = e.payload;
  const why = syncRefusal(s, e, f, ctx);
  if (why) {
    return step(s, { messages: p.queueN ? [toQueue(s.data, 'ResolutionEnded', { n: p.queueN, outcome: 'declined', reason: why })] : [] });
  }
  const n = s.data.n + 1;
  const row = f.row!;
  const sync: Sync = { n, reason: p.reason, head: row.integrationHead || row.head || null, queueN: p.queueN ?? null, approved: !!p.approved, at: ctx.now.toISOString(),
    claimHead: p.head ?? null, githubConflict: !!p.githubConflict,
    prev: p.reason === 'boot_failure' ? { bootHead: row.bootFailureSyncHead }
      : CHECK_SYNCS.has(p.reason) ? { fixedHead: row.fixedCheckSyncHead, fixedKeys: row.fixedCheckSyncKeys } : null };
  // What makes it once: written with the sync's own work, so a restart in
  // between resumes the sync instead of reading it as tried (merge trace
  // bug 9).
  const writes: DomainWrite[] = [];
  if (p.reason === 'boot_failure') writes.push({ type: 'bootFailureClaim', sessionId: s.data.sessionId, head: p.head });
  if (CHECK_SYNCS.has(p.reason)) {
    const keys = [...(p.keys || []), ...(p.reason === 'bot_handoff' ? [BOT_HANDOFF_KEY] : [])];
    writes.push({ type: 'fixedCheckClaim', sessionId: s.data.sessionId, head: p.head, keys });
  }
  if (p.reason === 'conflict') {
    if (!p.approved) writes.push({ type: 'resolutionSpent', sessionId: s.data.sessionId });
    writes.push({ type: 'blockReasons', sessionId: s.data.sessionId, reasons: ['integrating'] });
  }
  return step({ name: s.name, data: { ...s.data, n, sync } } as Live, {
    writes,
    push: p.reason === 'conflict' ? [votes(f, { integrating: true })] : [],
    work: [{ kind: WORK.sync, key: `sync:${n}`, input: { sessionId: s.data.sessionId, n, reason: p.reason,
      measureFirst: p.reason === 'boot_failure' || CHECK_SYNCS.has(p.reason), waitForIdle: p.reason === 'boot_failure' || CHECK_SYNCS.has(p.reason),
      githubConflict: !!p.githubConflict } }],
  });
};

// branch.sync reported.
function synced(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<PState> {
  const sync = s.data.sync!;
  const r = (e.type === 'WorkSucceeded' ? e.payload.result : null) as any;
  const outcome = r ? String(r.outcome || 'done') : 'error';
  let d: Data = { ...s.data, sync: null,
    lastSync: { n: sync.n, reason: sync.reason, outcome, sha: r?.sha ?? null, message: r?.message ?? (e.payload as any)?.error?.message ?? null,
      behind: Number(r?.behind) || 0, pushOk: !!r?.pushOk, conflictFiles: Array.isArray(r?.conflictFiles) ? r.conflictFiles.slice(0, 200) : [] } };
  const writes: DomainWrite[] = [];
  if (!r) {
    const failures = (s.data.backoff?.failures || 0) + 1;
    d = { ...d, backoff: { until: later(ctx, Math.min(SYNC_BACKOFF_MAX_MS, SYNC_BACKOFF_MS * 2 ** (failures - 1))).toISOString(), failures } };
  } else {
    d = { ...d, backoff: null };
  }
  if (outcome === 'unresolvable') d = { ...d, gaveUp: { head: r.headBefore ?? sync.head, main: r.mainSha ?? null } };
  // GitHub said conflict, and the branch already holds main: nothing a sync
  // does changes that, so the lane leaves this head alone against this main.
  if (sync.githubConflict && (outcome === 'level' || outcome === 'clean_now')) d = { ...d, gaveUp: { head: sync.head, main: f.row!.integrationMain } };
  // A platform sync that did nothing to the branch gives its once-record
  // back: it may be asked again for this head.
  if (NOTHING_RAN.has(outcome) && sync.claimHead && sync.prev) {
    if (sync.reason === 'boot_failure') writes.push({ type: 'bootFailureRelease', sessionId: d.sessionId, head: sync.claimHead, prev: sync.prev.bootHead ?? null });
    else if (CHECK_SYNCS.has(sync.reason)) {
      writes.push({ type: 'fixedCheckRelease', sessionId: d.sessionId, head: sync.claimHead, prevHead: sync.prev.fixedHead ?? null, prevKeys: sync.prev.fixedKeys || [] });
    }
  }
  if (sync.reason === 'conflict') {
    const reasons = outcome === 'unresolvable' ? ['unresolvable'] : outcome === 'over_budget' ? ['budget'] : [];
    writes.push({ type: 'blockReasons', sessionId: d.sessionId, reasons });
    if (outcome === 'unresolvable') {
      const owner = f.row!.userId ? `<@${f.row!.userId}>` : 'the session owner';
      writes.push({ type: 'line', eventId: e.id, appId: d.appId, sessionId: d.sessionId, msgType: 'conflict', metadata: null,
        content: `PR #${f.row!.prNumber} conflicts with main and could not be resolved automatically. ${owner}: open the session's dev-chat to resolve it.` });
    }
  }
  return step({ name: s.name, data: d } as Live, {
    writes,
    push: sync.reason === 'conflict' ? [votes(f, { integrating: false })] : [],
    messages: resolved(d, sync, outcome),
  });
}


const headMoved: Handler = (s, e, f) => {
  const p = e.payload;
  // New code nobody forced: an admin's force ends with an authored push.
  const next = p.keepVotes || !s.data.force ? s : ({ name: s.name, data: { ...s.data, force: null } } as Live);
  return step(next, {
    writes: [{ type: 'headMoved', sessionId: s.data.sessionId, column: p.column, to: p.to, keepVotes: p.keepVotes, fixOnly: p.fixOnly }],
    messages: f.row!.shots ? [toShots(s.data, 'HeadMoved', { head: p.to, reason: p.reason, pin: p.column, from: null })] : [],
  });
};

const approvalsCleared: Handler = (s) => step(s, { writes: [{ type: 'approvalsCleared', sessionId: s.data.sessionId }] });

// The idle check: a held slot nobody has used for a while is given back.
const idleCheck: Handler = (s, e, f, ctx, deps) => {
  const row = f.row!;
  if (deps.idleMs <= 0 || noSlot(s.data)) return step(s, { timer: null });
  const last = row.lastActivityAt ? Date.parse(row.lastActivityAt) : 0;
  if (ctx.now.getTime() - last < deps.idleMs) return step(s, { timer: { at: new Date(last + deps.idleMs), event: { type: 'IdleCheck' } } });
  if (busy(row) || s.data.sync || row.shotsRunning || row.buildHold || (deps.exemptFixtures && row.fixture)) {
    return step(s, { timer: { at: later(ctx, IDLE_RECHECK_MS), event: { type: 'IdleCheck' } } });
  }
  return pause(s, e, f, ctx, deps);
};

// The hourly look at a proposal in review, every input read under the lock:
// voted down (R1's twin: the gate as it is now), gone quiet (R2: a vote
// since the warning cancels the close).
const reviewCheck: Handler = (s, e, f, ctx, deps) => {
  const row = f.row!;
  // Hourly, or sooner when the gate's window ends before that: a proposal
  // that becomes mergeable with time is asked for then (D5).
  const hourly = deps.reviewCheckMs > 0 ? later(ctx, deps.reviewCheckMs).getTime() : null;
  const windowEnds = f.gate && !f.gate.mergeable && f.gate.windowEndsAt ? Date.parse(f.gate.windowEndsAt) + 1000 : null;
  const at = windowEnds && windowEnds > ctx.now.getTime() && (hourly == null || windowEnds < hourly) ? windowEnds : hourly;
  const again: TimerRequest | null = at != null ? { at: new Date(at), event: { type: 'ReviewCheck' } } : null;
  if (busy(row)) return step(s, { timer: again });
  if (f.gate?.rejectable) return close(s, e, f, f.gate.adminNo ? 'admin-no' : f.gate.approverNo ? 'approver-no' : 'auto-rejected');
  // Its gate is met (a window elapsed, the electorate shrank, a vote whose
  // own ask was lost): the app's merge queue is asked.
  const met = !!f.gate?.mergeable;
  const messages = met && !s.data.attempt && !s.data.sync
    ? [toQueue(s.data, 'MergeWanted', { reason: 'review-check' })] : [];
  // A met gate is no shield from going quiet. One whose merge is refused
  // every hour (a conflict nobody resolves, checks nobody fixes) used to be
  // asked again and never looked at: 5796 was warned on 13 Oct, its last
  // vote a week before that, and stayed up, one of 25 such proposals holding
  // review slots on 19 Oct. Its clock runs from when it became mergeable, so
  // the queue has its week first. A red main pauses every merge on the app,
  // which nothing about the proposal clears: while it lasts, none goes quiet.
  if (deps.staleNotifyMs <= 0 || (met && f.mergesPaused)) return step(s, { messages, timer: again });
  const metAt = met && f.gate!.windowEndsAt ? Math.min(Date.parse(f.gate!.windowEndsAt), ctx.now.getTime()) : 0;
  const interest = Math.max(f.interestAt ? Date.parse(f.interestAt) : 0, metAt || 0);
  const warned = row.staleNotifiedAt ? Date.parse(row.staleNotifiedAt) : null;
  if (warned != null && interest > warned) {
    // Somebody showed interest after the warning: it stands again.
    return step(s, { writes: [{ type: 'staleCleared', sessionId: s.data.sessionId }], messages, timer: again });
  }
  if (warned != null) {
    if (ctx.now.getTime() - warned >= deps.staleGraceMs) return close(s, e, f, 'stale-pr');
    return step(s, { messages, timer: again });
  }
  if (ctx.now.getTime() - interest >= deps.staleNotifyMs) {
    return step(s, {
      writes: [{ type: 'staleWarned', sessionId: s.data.sessionId, appId: s.data.appId, userId: row.userId, blocked: met }],
      messages, timer: again,
    });
  }
  return step(s, { messages, timer: again });
};

// A work result: the GitHub move under way reports (and the next starts);
// the open review decides the promote; the rest are bookkeeping.
// The diagram's block, written into the pull request body Homeroom wrote (an
// imported one's body is its author's); none yet, the open writes it.
function diagramStored(s: Live, _e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<PState> {
  if (s.data.imported || !f.row?.prNumber) return step(s);
  const moved = prMove(s.data, { kind: WORK.diagram, key: `diagram:v${ctx.version}`, input: { sessionId: s.data.sessionId } });
  return step({ name: s.name, data: moved.data } as Live, { work: moved.work });
}

function workDone(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const p = e.payload as WorkResultPayload;
  if (p.kind === WORK.open && s.name === 'proposing' && s.data.promoting && p.workKey === `open:${s.data.promoting.n}`) {
    return opened(s, e, f, ctx, deps);
  }
  const a = s.data.attempt;
  if (p.kind === WORK.gate && a?.stage === 'gate' && s.name === 'in_review' && p.workKey === `gate:${a.n}`) return gated(s, e, f, ctx, deps);
  if (p.kind === WORK.attempt && a?.stage === 'merge' && s.name === 'merging' && p.workKey === `attempt:${a.n}`) return attempted(s, e, f, ctx, deps);
  if (p.kind === WORK.observe && (s.name === 'unconfirmed' || (s.name === 'merging' && !a))) return observed(s, e, f, ctx, deps);
  if (p.kind === WORK.sync && s.data.sync && p.workKey === `sync:${s.data.sync.n}`) return synced(s, e, f, ctx);
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
    () => (moving(f.row!) || s.data.sync ? reject('busy') : ok()),
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
    () => (s.name === 'in_review' ? ok() : reject(s.name === 'merging' || s.name === 'unconfirmed' || s.name === 'merged' ? 'merging'
      : s.name === 'underway' || s.name === 'proposing' ? 'already_underway' : 'closed')),
    // The merge gate or a sync with main is under way: it waits for them.
    () => (s.data.attempt || s.data.sync ? reject('busy') : ok()),
    () => read(s, e),
    () => owner(e, f),
    () => (f.row!.headless ? reject('headless') : ok()),
    () => (moving(f.row!) ? reject('busy') : ok()),
    () => (f.row!.pendingSecret ? reject('pending_secret') : ok()),
  )],
  ['Pause', (s, e, f) => all(
    () => (s.name === 'underway' ? ok() : reject('not_underway')),
    () => (s.data.imported ? reject('imported') : s.data.platform ? reject('no_worker') : ok()),
    () => (s.data.slot === 'held' ? ok() : reject('already_paused')),
    () => read(s, e),
    () => owner(e, f),
    () => (SYSTEM_PAUSES.has(e.payload.reason) && (busy(f.row!) || f.row!.shotsRunning || f.row!.buildHold || s.data.sync) ? reject('worked_on') : ok()),
    () => (REST_PAUSES.has(e.payload.reason) && (f.row!.activeTurn || s.data.sync) ? reject('worked_on') : ok()),
  )],
  ['Resume', (s, e, f) => all(
    // A closed proposal is reopened, never resumed (bug 21).
    () => (s.name === 'closed' ? reject('closed') : s.name === 'underway' ? ok() : reject('not_underway')),
    () => (s.data.slot === 'released' ? ok() : reject('already_active')),
    () => read(s, e),
    () => owner(e, f),
    // The worker of the pause it comes back from is being destroyed: it
    // waits for that, never races it.
    () => (f.tearingDown ? reject('tearing_down') : ok()),
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
      : reject(s.name === 'closed' ? 'already_closed' : s.name === 'merging' || s.name === 'unconfirmed' ? 'merging' : 'merged')),
    () => (sameReading(statusOf(s), e.payload.from) ? ok() : reject('overtaken')),
    () => owner(e, f),
  )],
  ['PrLooked', (s, e, f, ctx) => all(
    // One being merged is its merge attempt's to settle.
    () => (['underway', 'proposing', 'in_review'].includes(s.name) ? ok()
      : reject(s.name === 'closed' ? 'already_closed' : s.name === 'merging' || s.name === 'unconfirmed' ? 'merging' : 'merged')),
    () => (sameReading(statusOf(s), e.payload.from) ? ok() : reject('overtaken')),
    () => (e.payload.merged ? ok() : !e.payload.closed ? reject('open')
      : !(ctx.now.getTime() - Date.parse(e.payload.readAt || '') <= PR_LOOK_STALE_MS) ? reject('stale')
        : ctx.now.getTime() - Date.parse(e.payload.closedAt || '') < PR_CLOSE_SETTLES_MS ? reject('settling') : ok()),
  )],
  ['Reopen', (s, e, f) => all(
    () => (s.name === 'closed' ? ok() : reject('not_closed')),
    () => read(s, e),
    () => owner(e, f),
    // Its worker or its CC volume is being removed: it waits for that (a
    // purge reports `cc_purged` once done), never races it.
    () => (f.tearingDown ? reject('tearing_down') : ok()),
  )],
  ['ReviewHeadMoved', (s, e, f) => all(
    () => (s.name === 'closed' || s.name === 'merged' ? reject('closed') : ok()),
    () => {
      const now = e.payload.column === 'imported' ? f.row!.importedHead : f.row!.reviewedHead;
      return now === e.payload.from ? ok() : reject('head_moved');
    },
  )],
  ['ApprovalsCleared', (s) => (s.name === 'closed' || s.name === 'merged' ? reject('closed') : ok())],
  ['DiagramStored', (s) => (s.name === 'closed' ? reject('closed') : ok())],
  ['ForceMerge', (s, e) => all(
    () => (s.name === 'in_review' ? ok() : reject(s.name === 'merging' || s.name === 'unconfirmed' ? 'in_progress' : 'not_in_review')),
    () => read(s, e),
  )],
  // A sync nobody waits for an answer to by message is refused outright; the
  // queue's is answered (ResolutionEnded) whatever happens.
  ['SyncRequested', (s, e, f, ctx) => {
    if (e.payload.queueN) return ok();
    const why = syncRefusal(s, e, f, ctx);
    return why ? reject(why) : ok();
  }],
  ['ObserveDue', (s, e, f, ctx) => {
    if (s.name === 'unconfirmed') return ok();
    if (s.name === 'merging' && s.data.attempt?.stage === 'merged') return ok();
    if (s.name === 'merging' && !s.data.attempt
      && ctx.now.getTime() - (s.data.claim?.at ? Date.parse(s.data.claim.at) : 0) >= CLAIM_STALE_MS) return ok();
    return reject('not_waiting');
  }],
]);

const HANDLERS = new Map<string, Handler>([
  ['Promote', promote], ['Unpromote', unpromote], ['Pause', pause], ['Resume', resume],
  ['IdleCheck', idleCheck], ['ReviewCheck', reviewCheck], ['Close', closeEvent], ['PrLooked', prLooked], ['Reopen', reopen],
  ['Merged', merged],
  ['ReviewHeadMoved', headMoved], ['ApprovalsCleared', approvalsCleared],
  ['MergeRequested', mergeRequested], ['ForceMerge', forceMerge], ['SyncRequested', syncRequested], ['ObserveDue', observeDue],
  ['StopRequested', stopRequested],
  ['DiagramStored', diagramStored],
  ['Rearm', (s, e, f, ctx, deps) => step(s, { timer: timerFor(s, f, ctx, deps) })],
  ['WorkSucceeded', workDone], ['WorkFailed', workDone], ['WorkExhausted', workDone],
]);
// The events that may create the instance (every one but the clock's): the
// first adopts the proposal from its row, then is handled as for one held.
const CREATE = ['Adopted', 'Promote', 'Unpromote', 'Pause', 'Resume', 'Close', 'PrLooked', 'Reopen',
  'Merged', 'ReviewHeadMoved', 'ApprovalsCleared', 'MergeRequested', 'ForceMerge', 'SyncRequested', 'DiagramStored'];
// The queue's asks are answered whatever the proposal's state: a rejection
// would leave the queue waiting for an answer that never comes.
const ANSWERED: ReadonlySet<string> = new Set(['MergeRequested', 'SyncRequested']);

// A row merge-followups has moved into 'merged' is merged, whatever this
// instance last decided: the move is that machine's, and its Merged message
// may still be on its way.
const expired = (e: Event<any>, ctx: TransitionContext) =>
  typeof e.payload?.deadline === 'string' && ctx.now.getTime() > Date.parse(e.payload.deadline);

const mergedAway = (s: Live, e: Event<any>, f: Facts) =>
  f.row?.status === 'merged' && s.name !== 'merged' && e.type !== 'Merged';

// A closed proposal's CC volume, purged once the retention window since it
// closed has passed: the purge is queued with the close (or with the
// adoption of a row closed before this rule), not before then, and doomed,
// so a Reopen cancels it while it waits (spare). The leader's hourly GC
// purged with no lock and could race a Reopen. A purge's own report queues
// none (one that gave up waits for the next release's adoption).
// A row that was closed with no time recorded (the leader's GC skipped
// those too) keeps its volume.
function retained(o: Outcome<PState>, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps, before: string): Outcome<PState> {
  const next = o.next as Live;
  const ms = deps.retentionMs ?? 0;
  if (ms <= 0 || next.name !== 'closed' || !f.row || f.row.ccPurged) return o;
  if (e.type.startsWith('Work') && (e.payload as WorkResultPayload)?.kind === WORK.purge) return o;
  if ((next.data.doomed || []).some((x) => x.kind === WORK.purge)) return o;
  if ((o.work || []).some((w) => w.kind === WORK.purge)) return o;
  // Closed by this move: its time is the move's (the projection writes it).
  const since = before !== 'closed' ? ctx.now.getTime() : f.row.archivedAt ? Date.parse(f.row.archivedAt) : null;
  if (since == null) return o;
  const purge: WorkRequest = { kind: WORK.purge, key: `retain:${next.data.n}:v${ctx.version}`, input: { sessionId: next.data.sessionId },
    notBefore: new Date(Math.max(since + ms, ctx.now.getTime())) };
  return { ...o, next: { name: 'closed', data: doom(next.data, purge) }, work: [...(o.work || []), purge] };
}

function transitions(deps: Deps) {
  // A campaign's proposal adopted before the flag existed learns it from its
  // row on its next event (it holds no worker slot either).
  const platformOf = (s: Live, f: Facts): Live => (f.row?.platform && !s.data.platform
    ? { ...s, data: { ...s.data, platform: true } } as Live : s);
  const entry = (type: string) => ({
    guard: (s0: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      const s = platformOf(s0, f);
      if (!f.row) return reject('session_not_found');
      if (expired(e, ctx)) return reject('expired');
      if (mergedAway(s, e, f) && !type.startsWith('Work') && !ANSWERED.has(type)) return reject('merged');
      const g = GUARDS.get(type);
      return g ? g(s, e, f, ctx) : ok();
    },
    to: (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext) =>
      retained(HANDLERS.get(type)!(platformOf(s, f), e, f, ctx, deps), e, f, ctx, deps, s.name),
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
    MergeRequested: entry('MergeRequested'), SyncRequested: entry('SyncRequested'),
  };
  const adopting = (type: string) => ({
    guard: (_s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      if (!f.row) return reject('session_not_found');
      if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
      if (expired(e, ctx)) return reject('expired');
      if (type === 'Adopted') return ok();
      const a = adopt(e.payload.sessionId, f.row);
      if (a.name === 'merged' && !ANSWERED.has(type)) return type === 'Merged' ? ok() : reject('merged');
      const g = GUARDS.get(type);
      return g ? g(a, e, f, ctx) : ok();
    },
    to: (_s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<PState> => {
      const a = adopt(e.payload.sessionId, f.row!);
      if (type === 'Adopted' || (type === 'Merged' && a.name === 'merged')) return retained(step(a, { timer: timerFor(a, f, ctx, deps) }), e, f, ctx, deps, a.name);
      const out = HANDLERS.get(type)!(a, e, f, ctx, deps);
      return retained(out.timer === undefined ? { ...out, timer: timerFor(out.next as Live, f, ctx, deps) } : out, e, f, ctx, deps, a.name);
    },
  });
  table[NONE] = Object.fromEntries(CREATE.map((t) => [t, adopting(t)]));
  return table;
}

// ── The machine ─────────────────────────────────────────────────────────

const ROUTE_OR_SYSTEM: ReadonlySet<string> = new Set(['route', 'system']);

// What waits on GitHub alone, listed under Admin → Workflows' "Needs a
// person" (Q3: there is no override; a person can look on GitHub).
export const ATTENTION: Readonly<Record<string, string>> = Object.freeze({
  unconfirmed: 'GitHub was asked to merge it and has not answered; Homeroom keeps asking',
});

export function proposal(deps: Deps): Machine<PState, Facts> {
  const routeOrSystem = (e: Event<any>): Check => (ROUTE_OR_SYSTEM.has(e.source.kind) ? ok() : reject('not_a_producer'));
  const person = (e: Event<any>): Check => (e.source.kind === 'route' || e.source.kind === 'system' ? ok() : reject('not_a_producer'));
  const closer = (e: Event<any>): Check => (ROUTE_OR_SYSTEM.has(e.source.kind) || e.source.kind === 'admin' ? ok() : reject('not_a_producer'));
  const system = (e: Event<any>): Check => (e.source.kind === 'system' ? ok() : reject('internal_only'));
  const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));
  const fromMerge = (e: Event<any>): Check =>
    ((e.source.kind === 'message' && e.source.from.machine === 'merge-followups') || e.source.kind === 'system' ? ok() : reject('internal_only'));
  // A maintenance campaign puts its changes up for a vote and forces its
  // green ones (src/workflow/campaign/).
  const fromCampaign = (e: Event<any>) => e.source.kind === 'message' && e.source.from.machine === 'campaign';
  const fromQueue = (e: Event<any>): Check =>
    ((e.source.kind === 'message' && e.source.from.machine === QUEUE) || e.source.kind === 'system' ? ok() : reject('internal_only'));
  return defineMachine<PState, Facts>({
    name: MACHINE,
    // 2: the merge (step 6): attempts, unconfirmed, syncs, forces. 3: a
    // maintenance campaign's promote (the campaign hears its outcome) and its
    // proposals, which hold no worker slot (`platform`). 4: a closed
    // proposal's CC volume purged once its retention window passes (the
    // leader's archived GC is gone, so an older Pod must not decide one). 5:
    // the pull request's diagram block, a GitHub move of its own (an older
    // Pod would not move the queue on past it).
    version: 5,
    events: EVENTS,
    create: CREATE,
    terminal: ['merged'],
    attention: { ...ATTENTION },
    decode: (row) => ({ name: row.state, data: row.data } as PState),
    facts: (tx, state, event, ctx) => {
      const id = state.name === NONE ? Number((event.payload as any)?.sessionId) : (state.data as Data).sessionId;
      if (!Number.isInteger(id) || id <= 0) return Promise.resolve(NO_FACTS);
      const p = event.payload as any;
      const reviewOpened = event.type === 'WorkSucceeded' && p?.kind === WORK.open && state.name === 'proposing';
      const gateReady = event.type === 'WorkSucceeded' && p?.kind === WORK.gate && state.name === 'in_review' && !!(p?.result as any)?.ready;
      const teardownKinds = event.type === 'Resume' ? [...SPARE_WORKER] : event.type === 'Reopen' ? [...SPARE_ALL] : undefined;
      return readFacts(tx, id, event, { now: ctx.now, reviewOpened, teardownKinds,
        claim: gateReady ? { force: !!(state.data as Data).attempt?.force, result: (p.result as any) } : undefined });
    },
    authorize: {
      Adopted: system,
      Promote: (e: Event<any>): Check => (ROUTE_OR_SYSTEM.has(e.source.kind) || fromCampaign(e) ? ok() : reject('not_a_producer')),
      Unpromote: person,
      Pause: routeOrSystem,
      Resume: routeOrSystem,
      IdleCheck: timer,
      ReviewCheck: timer,
      Close: (e: Event<any>): Check => (closer(e) === true || fromCampaign(e) ? ok() : reject('not_a_producer')),
      PrLooked: system,
      Reopen: person,
      Merged: fromMerge,
      ReviewHeadMoved: routeOrSystem,
      ApprovalsCleared: routeOrSystem,
      MergeRequested: fromQueue,
      ForceMerge: (e: Event<any>): Check => (ROUTE_OR_SYSTEM.has(e.source.kind) || fromCampaign(e) ? ok() : reject('not_a_producer')),
      SyncRequested: (e: Event<any>): Check => (ROUTE_OR_SYSTEM.has(e.source.kind)
        || (e.source.kind === 'message' && (e.source.from.machine === QUEUE || e.source.from.machine === 'preview')) ? ok() : reject('not_a_producer')),
      ObserveDue: timer,
      Rearm: system,
      StopRequested: routeOrSystem,
      DiagramStored: system,
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
      if (event.type === 'SyncRequested' && d.sync) out.sync = d.sync.n;
      if (d.lastSync) out.lastSync = d.lastSync as unknown as Json;
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
  if (w.dedupe) {
    // Said once: the latest system line of the thread already says it.
    const { rows: [last] } = await tx.query(
      `SELECT content FROM chat_messages WHERE app_id = $1 AND msg_type = 'system' AND thread_type = 'session' AND thread_ref = $2
        ORDER BY id DESC LIMIT 1`, [w.appId, w.sessionId]);
    if (last && last.content === w.content) return;
  }
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
  botChange: writeBotChange,
  // A withdrawal's line in one of its requests' own threads, the change
  // named by its title (its pull request's, else its session's).
  withdrawnLine: async (tx: Tx, w: any, ctx: WriteContext) => {
    const { rows: [t] } = await tx.query(
      `SELECT COALESCE(NULLIF(pr_title, ''), NULLIF(session_title, '')) AS title FROM chat_sessions WHERE id = $1`, [w.sessionId]);
    const { rows: [row] } = await tx.query(
      `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
       VALUES ($1, $2, 'system', $3, 'issue', $4) RETURNING id, app_id, content, msg_type, metadata, thread_type, thread_ref, created_at`,
      [w.appId, withdrawnNote(t?.title ?? null), JSON.stringify({ wfEvent: w.eventId }), w.issueNumber]);
    ctx.push(chatLine(row));
  },
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
  // Gone quiet: its author is warned once (its votes met and its merge
  // stuck, in those words).
  staleWarned: async (tx: Tx, w: any, ctx: WriteContext) => {
    await tx.query('UPDATE chat_sessions SET stale_notified_at = NOW() WHERE id = $1', [w.sessionId]);
    named(ctx, await createStalePrNotification(tx, {
      userId: w.userId ?? null, appId: w.appId, sessionId: w.sessionId, detail: w.blocked ? 'blocked' : null,
    }));
  },
  staleCleared: async (tx: Tx, w: any) => tx.query('UPDATE chat_sessions SET stale_notified_at = NULL WHERE id = $1', [w.sessionId]),
  prCleared: async (tx: Tx, w: any) => tx.query(
    'UPDATE chat_sessions SET pr_number = NULL, pr_url = NULL WHERE id = $1 AND pr_number IS NOT DISTINCT FROM $2', [w.sessionId, w.prNumber ?? null]),
  ccPurged: async (tx: Tx, w: any) => tx.query('UPDATE chat_sessions SET cc_purged = TRUE WHERE id = $1', [w.sessionId]),
  // GitHub refused the merge as a conflict: the card says so at once (the
  // files fill in with the next sync). Not a "behind" count: that is the
  // measurement's (merge trace bug 2).
  conflictMarked: async (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions SET merge_conflict_state = 'conflict', conflict_checked_at = NOW() WHERE id = $1`, [w.sessionId]),
  blockReasons: async (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions SET integration_block_reasons = $2::jsonb
      WHERE id = $1 AND integration_block_reasons IS DISTINCT FROM $2::jsonb`, [w.sessionId, JSON.stringify(w.reasons || [])]),
  // The once-records of the platform's own syncs, written with the sync.
  bootFailureClaim: async (tx: Tx, w: any) => tx.query(
    'UPDATE chat_sessions SET boot_failure_sync_head = $2 WHERE id = $1', [w.sessionId, w.head]),
  fixedCheckClaim: async (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions
        SET fixed_check_sync_head = $2,
            fixed_check_sync_keys = ARRAY(
              SELECT DISTINCT k FROM unnest(COALESCE(fixed_check_sync_keys, '{}'::text[]) || $3::text[]) AS k ORDER BY k)
      WHERE id = $1`, [w.sessionId, w.head, w.keys || []]),
  resolutionSpent: async (tx: Tx, w: any) => tx.query(
    'UPDATE chat_sessions SET integration_resolved_epoch = approval_epoch WHERE id = $1', [w.sessionId]),
  // A once-record given back (P6): only while it still names the head its
  // sync was for, so a later claim stands.
  bootFailureRelease: async (tx: Tx, w: any) => tx.query(
    'UPDATE chat_sessions SET boot_failure_sync_head = $3 WHERE id = $1 AND boot_failure_sync_head = $2',
    [w.sessionId, w.head, w.prev]),
  fixedCheckRelease: async (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions SET fixed_check_sync_head = $3, fixed_check_sync_keys = $4::text[]
      WHERE id = $1 AND fixed_check_sync_head = $2`, [w.sessionId, w.head, w.prevHead, w.prevKeys || []]),
};
