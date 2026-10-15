// preview: a proposal's preview and its required checks, from the first
// revision announced under the flag until the preview is retired. One
// instance per session.
//
// Each build is an attempt, numbered within the instance: the runtime
// (Deployment, Service, Ingress) is the session's and is updated in place,
// while the database and the env Secret are the attempt's, so a failed
// candidate never touches what serves. A checks run belongs to the attempt
// that serves. What is being built, what is served and which revision the
// verdict is for are separate facts here; the legacy columns are written
// from them, so every reader keeps working.
//
// The instance is also the session's durable record of who is working on
// it: its own build or run while it is preparing or checking (alive while
// its work's lease is), and the operations of old flows that keep no record
// of their own (a sync with main, a dispatch, an upload), recorded by
// services/active-workers.js and counted while the process holding each is
// alive (rules/presence.ts, session-work.ts).
//
// workflow-foundation's design-previews-and-checks.md is the design.

import { createHash } from 'node:crypto';
import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type {
  Check, DomainWrite, Event, Json, Machine, MessageRequest, Outcome, Push, TimerRequest, TransitionContext, Tx, WorkRef,
  WorkRequest, WorkResultPayload,
} from '../kernel/index.ts';
import { chatLine, sessionEvent, sessionUpdate, toUser } from '../pushes.ts';
import type { SessionRoute } from '../pushes.ts';
import * as store from '../rules/check-store.ts';
import { createCheckFailedNotification } from '../rules/change-notifications.ts';
import { OPEN, readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'preview';
export const sessionKey = (sessionId: number) => `session:${sessionId}`;

export const WORK = Object.freeze({
  prepare: 'preview.prepare',
  // The repo's unit suite, started with the build of an attempt and read by
  // the checks run against it (services.ts).
  unitEarly: 'checks.unitEarly',
  run: 'checks.run',
  cancel: 'checks.cancel',
  publish: 'checks.publish',
  retireAttempt: 'preview.retireAttempt',
  dropClaims: 'preview.dropClaims',
  retire: 'preview.retire',
  // Hand-offs to flows later steps migrate (the boundary list's "hand-off"
  // entries): a verdict's merge kick and bot note, and the bot's note that a
  // change's preview will not start. `preview.ready` is left only for the
  // items an older release queued (it hands their head to the shots machine).
  ready: 'preview.ready',
  followUps: 'verdict.followUps',
  stopped: 'preview.stopped',
});

// ── States ──────────────────────────────────────────────────────────────

export type Verdict = 'passing' | 'failing' | 'skipped' | 'error';

// An attempt: its number, the head it builds, and its database. Attempt 0
// is a preview [main] built before the flag, adopted with [main]'s names.
// `previewOnly`: a preview with no checks (the App bench's studio previews):
// it serves, and nothing runs against it.
// `dbs`: the database each claim of its build clones into, the first being
// `db` (a claim that runs again never re-clones the database a claim before
// it may have deployed: its pods would lose it). The one that serves is the
// receipt's.
export interface Attempt { n: number; head: string; db: string; dbs?: string[]; previewOnly?: boolean }
// An attempt that serves, as its prepare reported it.
export interface Served extends Attempt {
  url: string;
  runtimeKind: string;
  runtimeName: string;
  containerId: string | null;
  imageRef: string | null;
  buildRef: string | null;
}
export interface Run { key: string; n: number; head: string }
// An attempt waiting for its preview.retireAttempt: the item's key, and
// whether it came from a prepare that was cancelled (one that may still be
// creating things until its handler stops).
export interface Retiring extends Attempt { key: string; cancelled?: boolean }
// What an old flow is doing on the session, and which process does it.
export interface Operation { id: string; kind: string; holder: string; since: string }

export interface Data {
  sessionId: number;
  appId: number;
  appSlug: string;
  userId: number | null;
  seed: number;                  // the creating event's id: attempt names are unique per instance
  head: string | null;           // the head this instance is about
  trigger: string | null;        // why the current preparation or run started
  last: number;                  // the last attempt number given out
  preparing: Attempt | null;
  serving: Served | null;
  run: Run | null;
  verdict: Verdict | null;
  failure: string | null;        // the detail of the current error
  platformFault: boolean;        // that error is the platform's (its own retry allowance)
  streak: number;                // consecutive errors on this head
  firstFailureAt: string | null;
  episode: number;               // deferred episodes, for ConflictResolved's key
  retiring: Retiring[];          // attempts whose preview.retireAttempt is outstanding
  exit: { reason: string; terminal: boolean; key: string; attempts: Attempt[]; failed?: string } | null;
  pending: { head: string; trigger: string | null } | null;  // a revision that arrived during an idle retirement
  closedAt: string | null;
  operations: Operation[];
  previewOnly?: boolean;         // a session previewed with no checks (the App bench): every attempt is
}

const STATES = ['idle', 'preparing', 'checking', 'deferred', 'settled', 'failed', 'retiring', 'retired', 'detached'] as const;
type Name = typeof STATES[number];
export type PState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<PState, { data: Data }>;

// ── Events ──────────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{40}$/;
const sha = (v: unknown, what: string) => {
  const s = String(v ?? '').toLowerCase();
  if (!SHA.test(s)) throw new Error(`${what} must be a 40-character commit sha`);
  return s;
};
const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const word = (v: unknown, what: string, allowed?: ReadonlySet<string>) => {
  if (typeof v !== 'string' || !v || v.length > 64 || (allowed && !allowed.has(v))) throw new Error(`${what} is not valid`);
  return v;
};
const optWord = (v: unknown) => (typeof v === 'string' && v && v.length <= 64 ? v : null);
const text = (v: unknown, what: string, max: number) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} is required`);
  return v.trim().slice(0, max);
};

// ensure: the Preview click; deploy: a new attempt; preview: a preview with
// no checks run against it (a studio build of the App bench).
const REQUEST_REASONS: ReadonlySet<string> = new Set(['ensure', 'deploy', 'preview']);
const optInt = (v: unknown, what: string) => (v == null ? null : int(v, what));

const EVENTS = {
  // A head announced by any source (a turn, an upload, an update, a sync,
  // an imported pull request, the merge gate, fleet, recovery).
  // `carryFrom`: a mechanical merge of main into a tested head (votes.js
  // reconcileNativeReviewedHead); a green verdict for that head carries.
  RevisionSubmitted: (p: any) => ({
    sessionId: int(p?.sessionId, 'sessionId'), head: sha(p?.head, 'head'),
    source: word(p?.source, 'source'), trigger: optWord(p?.trigger),
    carryFrom: p?.carryFrom == null ? null : sha(p.carryFrom, 'carryFrom'),
  }),
  // A person asks for the preview itself: ensure (the Preview click: built
  // if nothing serves the head) or deploy (a new attempt, whatever serves).
  PreviewRequested: (p: any) => ({
    sessionId: int(p?.sessionId, 'sessionId'), head: sha(p?.head, 'head'),
    reason: word(p?.reason, 'reason', REQUEST_REASONS),
  }),
  RecheckRequested: (p: any) => ({ reason: word(p?.reason, 'reason'), trigger: optWord(p?.trigger) }),
  // Nothing to test: the head carries no commits beyond main (`head` is
  // the commit the verdict describes). Settles 'skipped' without a build.
  // `expected`: the checks commit the caller read, the stale fence of the
  // store (a caller that read an older row writes nothing).
  ChecksSkipped: (p: any) => ({
    sessionId: int(p?.sessionId, 'sessionId'), head: sha(p?.head, 'head'), reason: text(p?.reason, 'reason', 300),
    expected: p?.expected == null ? null : sha(p.expected, 'expected'),
  }),
  ConflictResolved: (p: any) => ({ head: sha(p?.head, 'head') }),
  // The branch moved on to code nothing checks yet (a CLI upload before it
  // is submitted, an update to a paused proposal): the verdict no longer
  // describes it, and whatever ran for the old head is obsolete.
  ChecksCleared: (p: any) => ({ reason: word(p?.reason, 'reason'), sessionId: optInt(p?.sessionId, 'sessionId') }),
  // An observer found the serving runtime gone or broken.
  PreviewLost: (p: any) => {
    if (!Number.isInteger(p?.attempt) || p.attempt < 0) throw new Error('attempt must be an attempt number');
    return { attempt: p.attempt as number, detail: optWord(p?.detail) };
  },
  // `sessionId` names a session the machine does not hold yet: the retire
  // (or the clear above) adopts it from its row first, so the machine is the
  // only thing that tears down a preview or clears a verdict.
  RetireRequested: (p: any) => ({ reason: word(p?.reason, 'reason'), terminal: p?.terminal === true,
    sessionId: optInt(p?.sessionId, 'sessionId') }),
  // An old flow starts or ends work on the session that keeps no record of
  // its own (services/active-workers.js): recorded, never refused.
  OperationStarted: (p: any) => ({
    sessionId: int(p?.sessionId, 'sessionId'), id: text(p?.id, 'id', 80), kind: word(p?.kind, 'kind'),
    holder: text(p?.holder, 'holder', 200),
  }),
  OperationEnded: (p: any) => ({ id: text(p?.id, 'id', 80) }),
  AdminRetry: () => ({}),
  AdminRetire: () => ({}),
  // An admin ends a build or a run that never answers (a hung build, a lock
  // that is never released): read as a failure, its late result stale.
  AdminEnd: () => ({}),
  RetryDue: () => ({}),
};

// ── Names ───────────────────────────────────────────────────────────────

// The attempt's database: [main]'s pattern (app_<slug>_staging_s<sid>_<6
// hex>), so [main]'s orphan sweep can still collect it after a rollback,
// with a tag only this instance gives out.
export function attemptDb(slug: string, sessionId: number, seed: number, n: number, claim = 1): string {
  const tag = createHash('sha256').update(`preview:${sessionId}:${seed}:${n}${claim > 1 ? `:c${claim}` : ''}`).digest('hex').slice(0, 6);
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_s${sessionId}_${tag}`;
}
// As many as a build's work item has claims (services.ts PREPARE_ATTEMPTS).
export const PREPARE_CLAIMS = 3;
const attemptDbs = (slug: string, sessionId: number, seed: number, n: number) =>
  Array.from({ length: PREPARE_CLAIMS }, (_, i) => attemptDb(slug, sessionId, seed, n, i + 1));
// Every database an attempt may have made.
const dbsOf = (a: Attempt) => a.dbs ?? [a.db];
// db-manager.stagingDbName, for a preview [main] built.
const legacyDb = (slug: string, sessionId: number, head: string) =>
  `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_s${sessionId}_${head.slice(0, 6)}`;

// ── Copy ────────────────────────────────────────────────────────────────

// Why a recheck runs, as the card names it: each reason by what it is
// (bug 21: the gate's kicks and a same-commit resubmission all read as the
// recovery sweep on [main]).
const TRIGGERS = new Map([
  ['manual', 'manual-recheck'], ['manual-recheck', 'manual-recheck'], ['testing-update', 'manual-recheck'],
  ['shots-update', 'manual-recheck'], ['preview-click', 'manual-recheck'],
  ['promote', 'promote-kick'], ['promote-kick', 'promote-kick'], ['stale-vote', 'promote-kick'],
  ['stale-pending-vote-kick', 'promote-kick'],
  ['conflict-resolved', 'conflict-resolved'],
]);
// The recheck reasons whose run replaces one going (its inputs changed).
const REPLACING_REASONS: ReadonlySet<string> = new Set(['testing-update', 'shots-update']);
const recheckTrigger = (reason: string, trigger: string | null) =>
  store.normalizeCheckTrigger(trigger) || TRIGGERS.get(reason) || 'stuck-sweep';

// ── Outcomes ────────────────────────────────────────────────────────────

export interface Deps {
  maxRetries: number;        // staging-recovery.checkMaxAutoRetries(), read at boot
  retireAfterMs: number;     // a cancelled prepare has stopped by then (its lease)
}

interface Step {
  name: Name;
  data: Data;
  writes?: DomainWrite[];
  work?: WorkRequest[];
  cancel?: WorkRef[];
  push?: Push[];
  messages?: MessageRequest[];
  timer?: TimerRequest | null;
}
const step = (s: Step): Outcome<PState> =>
  ({ next: { name: s.name, data: s.data }, writes: s.writes, work: s.work, cancel: s.cancel, push: s.push, messages: s.messages, timer: s.timer });

// To the shots machine (src/workflow/shots/): a head is ready to be shot
// (its preview serves, or its checks settled), an imported proposal's
// preview will not start, a UI change has no declaration, the proposal left
// review.
const toShots = (d: Data, type: string, payload: Record<string, Json> = {}): MessageRequest =>
  ({ to: { machine: 'shots', key: `session:${d.sessionId}` }, event: { type, payload: { sessionId: d.sessionId, ...payload } }, appId: d.appId });
const told = (o: Outcome<PState>, ...messages: MessageRequest[]): Outcome<PState> =>
  ({ ...o, messages: [...(o.messages || []), ...messages] });

const prepareKey = (n: number) => `prepare:${n}`;
// Unique per decision: attempt 0 (a preview [main] built) can be adopted
// again after a detach, and must be retirable again.
const retireAttemptKey = (n: number, version: number) => `retire-attempt:${n}:v${version}`;

const route = (d: Data): SessionRoute => ({ sessionId: d.sessionId, userId: d.userId, appId: d.appId, appSlug: d.appSlug || null });
const seq = (ctx: TransitionContext, i = 0) => `wf-${ctx.key}-${ctx.version + 1}-${i}`;

// What browsers hear, as services/visuals.js and ws.js shape it.
function checksPending(d: Data, ctx: TransitionContext, head: string, phase: string, trigger: string | null): Push {
  return sessionEvent(route(d), 'checks_ready', seq(ctx, 1), {
    checkState: 'pending', failingCount: 0, commitSha: head,
    checkPhase: store.normalizeCheckPhase(phase), checkTrigger: store.normalizeCheckTrigger(trigger),
  });
}
function checksReady(d: Data, ctx: TransitionContext, head: string, state: string, results: unknown[] = []): Push {
  const rows = (Array.isArray(results) ? results : []) as { status?: string; advisory?: boolean }[];
  const blocking = rows.filter((r) => r && r.status !== 'pass' && !r.advisory).length;
  const advisory = rows.filter((r) => r && r.status !== 'pass' && r.advisory).length;
  return sessionEvent(route(d), 'checks_ready', seq(ctx, 2), {
    checkState: state, failingCount: blocking, blockingCount: blocking, advisoryCount: advisory, commitSha: head,
  });
}

// The backoff of the error lane: 2 min doubling to 30 (storeChecks' own).
const retryDelayMs = (streakBefore: number) => Math.min(120 * 2 ** Math.min(streakBefore, 10), 1800) * 1000;
// A platform fault keeps retrying for a day past the cap
// (staging-recovery.PLATFORM_FAULT_RETRY_MS).
const PLATFORM_FAULT_RETRY_MS = 24 * 60 * 60 * 1000;

// What a newer step makes obsolete: the attempt being prepared (retired
// once its handler has stopped) and the checks run.
function obsolete(d: Data, ctx: TransitionContext, deps: Deps): { cancel: WorkRef[]; work: WorkRequest[]; retiring: Retiring[] } {
  const cancel: WorkRef[] = [];
  const work: WorkRequest[] = [];
  const retiring = [...d.retiring];
  if (d.preparing) {
    cancel.push({ kind: WORK.prepare, key: prepareKey(d.preparing.n) }, { kind: WORK.unitEarly, key: unitEarlyKey(d.preparing.n) });
    const r = retire(d, d.preparing, ctx, deps, true);
    retiring.push(r.entry);
    work.push(r.work);
  }
  if (d.run) {
    cancel.push({ kind: WORK.run, key: d.run.key });
    // After the run's claim has stopped (it learns of the cancel at its next
    // renewal), so nothing it starts meanwhile outlives the cleanup.
    work.push({ kind: WORK.cancel, key: `cancel:${d.run.key}`, input: { sessionId: d.sessionId, runId: d.run.key },
      notBefore: new Date(ctx.now.getTime() + deps.retireAfterMs) });
  }
  return { cancel, work, retiring };
}

// Retire an attempt that does not serve: its item, and its entry in
// `retiring`. One from a cancelled prepare waits until that handler has
// stopped (a lease and more).
function retire(d: Data, a: Attempt, ctx: TransitionContext, deps: Deps, cancelled = false): { entry: Retiring; work: WorkRequest } {
  const key = retireAttemptKey(a.n, ctx.version + 1);
  return {
    entry: { n: a.n, head: a.head, db: a.db, dbs: dbsOf(a), key, ...(cancelled ? { cancelled: true } : {}) },
    work: {
      kind: WORK.retireAttempt, key,
      input: { sessionId: d.sessionId, appId: d.appId, appSlug: d.appSlug, n: a.n, db: a.db, dbs: dbsOf(a) },
      ...(cancelled ? { notBefore: new Date(ctx.now.getTime() + deps.retireAfterMs) } : {}),
    },
  };
}

const unitEarlyKey = (n: number) => `unit-early:${n}`;
const earlyOf = (a: Attempt): WorkRef => ({ kind: WORK.unitEarly, key: unitEarlyKey(a.n) });

const pendingWrite = (d: Data, head: string, phase: 'building' | 'testing', trigger: string | null): DomainWrite =>
  ({ type: 'pending', sessionId: d.sessionId, head, phase, trigger });

// Prepare attempt n+1 of `head`. What serves keeps serving until it is ready.
function begin(s: Live, head: string, trigger: string | null, ctx: TransitionContext, deps: Deps,
  only = false): Outcome<PState> {
  const d0 = s.data;
  const previewOnly = only || !!d0.previewOnly;
  const old = obsolete(d0, ctx, deps);
  const n = d0.last + 1;
  const dbs = attemptDbs(d0.appSlug, d0.sessionId, d0.seed, n);
  const attempt: Attempt = { n, head, db: dbs[0]!, dbs, ...(previewOnly ? { previewOnly: true } : {}) };
  const sameHead = d0.head === head;
  const d: Data = {
    ...d0, head, trigger, last: n, preparing: attempt, run: null, verdict: null, ...(previewOnly ? { previewOnly: true } : {}),
    failure: sameHead ? d0.failure : null, platformFault: sameHead ? d0.platformFault : false,
    streak: sameHead ? d0.streak : 0, firstFailureAt: sameHead ? d0.firstFailureAt : null,
    retiring: old.retiring, exit: null, pending: null,
  };
  // The unit suite starts with the build rather than after it (its own Jobs,
  // under the attempt's early run id): not for a preview with no checks, and
  // not for a head whose last checks errored, mostly a preview that does not
  // boot, where nothing would ever read it.
  const early: WorkRequest[] = previewOnly || d.streak > 0 ? []
    : [{ kind: WORK.unitEarly, key: unitEarlyKey(n), input: { sessionId: d.sessionId, appId: d.appId, n, head } }];
  return step({
    name: 'preparing', data: d,
    cancel: old.cancel,
    // A preview with no checks has no checks state to write, and nobody to
    // tell it is being built.
    writes: previewOnly ? [] : [pendingWrite(d, head, 'building', trigger),
      { type: 'buildStarted', sessionId: d.sessionId, appId: d.appId, head }],
    work: [...old.work, { kind: WORK.prepare, key: prepareKey(n), input: {
      sessionId: d.sessionId, appId: d.appId, n, head, db: attempt.db, dbs, trigger,
      serving: d.serving ? { n: d.serving.n, head: d.serving.head, runtimeName: d.serving.runtimeName } : null,
    } }, ...early],
    push: previewOnly ? [] : [checksPending(d, ctx, head, 'building', trigger)],
    timer: null,
  });
}

// Start a checks run against the serving attempt.
function startRun(s: Live, trigger: string | null, ctx: TransitionContext,
  extra: { work?: WorkRequest[]; data?: Partial<Data>; writes?: DomainWrite[]; push?: Push[] } = {}): Outcome<PState> {
  const d0 = { ...s.data, ...(extra.data || {}) };
  const served = d0.serving!;
  const key = `run-${served.n}-${ctx.version + 1}`;   // a Kubernetes label value (the Jobs carry it)
  const d: Data = { ...d0, trigger, run: { key, n: served.n, head: served.head }, verdict: null };
  return step({
    name: 'checking', data: d,
    writes: [...(extra.writes || []), pendingWrite(d, served.head, 'testing', trigger)],
    work: [...(extra.work || []), { kind: WORK.run, key, input: {
      sessionId: d.sessionId, appId: d.appId, n: served.n, head: served.head, runId: key, trigger,
      runtimeName: served.runtimeName, runtimeKind: served.runtimeKind, url: served.url,
    } }],
    push: [...(extra.push || []), checksPending(d, ctx, served.head, 'testing', trigger)],
    timer: null,
  });
}

// The error lane: an 'error' on this head runs again on its own, from a
// row in its scope, while the streak is under the cap (or, for the
// platform's own fault, for a day).
function errorTimer(d: Data, f: Facts, deps: Deps, ctx: TransitionContext, streakBefore: number): TimerRequest | null {
  if (!f.session?.retryScope) return null;
  const underCap = d.streak < deps.maxRetries;
  const platformDay = d.platformFault && d.firstFailureAt
    && ctx.now.getTime() - Date.parse(d.firstFailureAt) < PLATFORM_FAULT_RETRY_MS;
  if (!underCap && !platformDay) return null;
  return { at: new Date(ctx.now.getTime() + retryDelayMs(streakBefore)), event: { type: 'RetryDue' } };
}

// The work that follows a settled run: the bot's note, the merge kick, and
// shots. One item per run.
const followUps = (d: Data, run: Run, state: string, deferred = false): WorkRequest => ({
  kind: WORK.followUps, key: `follow-ups:${run.key}`,
  input: { sessionId: d.sessionId, appId: d.appId, head: run.head, state, deferred, trigger: d.trigger, shotsTold: true },
});

// ── Adoption ────────────────────────────────────────────────────────────

// A session's first event under the flag: the instance starts from what its
// row says, so a preview [main] built is known (and retired by identity
// once a newer attempt serves) and its verdict is kept.
function adopt(e: Event<any>, f: Facts, prior: Data | null): Data {
  const s = f.session!;
  const st = s.staging;
  // A detached instance whose own attempt still serves (nothing rebuilt it
  // meanwhile) keeps that attempt's record: its database has this
  // instance's name, not [main]'s.
  const own = prior?.serving && prior.serving.url === st.url && prior.serving.head === st.commitSha
    && prior.serving.runtimeName === st.runtimeName ? prior.serving : null;
  const serving: Served | null = own ?? (st.url && st.runtimeName && st.commitSha ? {
    n: 0, head: st.commitSha, db: legacyDb(f.app!.slug, s.id, st.commitSha), url: st.url,
    runtimeKind: st.runtimeKind || 'docker', runtimeName: st.runtimeName, containerId: st.containerId,
    imageRef: st.imageRef, buildRef: st.buildRef,
  } : null);
  return {
    sessionId: s.id, appId: s.appId, appSlug: f.app!.slug, userId: s.userId, seed: prior?.seed ?? e.id,
    head: serving?.head ?? s.checks.commitSha, trigger: null, last: prior?.last ?? 0,
    preparing: null, serving, run: null, verdict: null, failure: null, platformFault: false, streak: 0,
    firstFailureAt: null, episode: prior?.episode ?? 0, retiring: [], exit: null, pending: null, closedAt: null,
    operations: prior?.operations ?? [],
  };
}

const verdictOf = (v: string | null): Verdict | null =>
  (v === 'passing' || v === 'failing' || v === 'skipped' ? v : null);

// Where an adopted row stands for `head`: its verdict if the preview serves
// that head, else a new attempt.
function fromRow(d: Data, f: Facts, head: string, trigger: string | null, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const live: Live = { name: 'idle', data: d };
  if (!d.serving || d.serving.head !== head) return begin(live, head, trigger, ctx, deps);
  const checks = f.session!.checks;
  const verdict = checks.commitSha === head ? verdictOf(checks.state) : null;
  if (verdict) return step({ name: 'settled', data: { ...d, head, verdict }, timer: null });
  return startRun({ name: 'settled', data: { ...d, head } }, trigger, ctx);
}

// Where an adopted row stands, without starting anything (an operation's
// record): a preview that serves is `settled`, with the row's verdict when
// it is about that head; else `idle`, about the row's checks commit.
function standing(d: Data, f: Facts): Live {
  if (!d.serving) return { name: 'idle', data: d };
  const checks = f.session!.checks;
  const verdict = checks.commitSha === d.serving.head ? verdictOf(checks.state) : null;
  return { name: 'settled', data: { ...d, head: d.serving.head, verdict } };
}

// An adopted row's verdict, as a state, for the carry below.
function fromRowVerdict(d: Data, f: Facts): Live {
  const v = f.session!.checks.state;
  const settled = (v === 'passing' || v === 'skipped') && f.session!.checks.commitSha === d.head;
  return { name: settled ? 'settled' : 'idle', data: { ...d, verdict: settled ? v as Verdict : null } };
}

// A mechanical merge of main into a head whose verdict is green keeps that
// verdict for the merged head (#2693: only green carries); what serves is
// the tested head's preview until something asks for a new one.
function carry(s: Live, p: { head: string; carryFrom: string | null }): Outcome<PState> | null {
  if (!p.carryFrom || s.name !== 'settled' || s.data.head !== p.carryFrom) return null;
  if (s.data.verdict !== 'passing' && s.data.verdict !== 'skipped') return null;
  const d: Data = { ...s.data, head: p.head };
  return step({ name: 'settled', data: d, writes: [{ type: 'carried', sessionId: d.sessionId, head: p.head }], timer: null });
}

// An instance that holds nothing starts again from its row: one that does
// not exist yet, one handed back (detached), and one retired (an archived
// proposal can be unarchived). Attempt numbering continues.
const restarts = (s: { name: string }) => s.name === NONE || s.name === 'detached' || s.name === 'retired';
const priorOf = (s: any): Data | null => (s.name === NONE ? null : s.data);

// ── Guards ──────────────────────────────────────────────────────────────

function admissible(f: Facts, head: string, ctx: TransitionContext, sessionId: number): Check {
  if (ctx.key !== sessionKey(sessionId)) return reject('key_mismatch');
  if (!f.session || !f.app) return reject('no_session');
  if (!OPEN.has(f.session.status)) return reject('not_open');
  if (f.session.pin && f.session.pin !== head) return reject('head_superseded');
  return ok();
}

// The head being prepared, or served with nothing pending, is joined.
function sameHead(s: Live, head: string): boolean {
  const d = s.data;
  if (s.name === 'preparing') return d.preparing?.head === head;
  if (s.name === 'failed') return d.head === head;
  if (s.name === 'settled' && d.verdict === null) return false;   // cleared: a submission of it is checked again
  if (s.name === 'checking' || s.name === 'settled' || s.name === 'deferred') return d.head === head && d.serving?.head === head;
  return false;
}

// Someone is working on the session (an old flow's own durable record, or
// an operation a live process holds): idle and pressure retirement wait.
function worked(s: Live, f: Facts): boolean {
  const x = f.session;
  if (x && (x.turnRunning || x.localTurnRunning || x.shotsRunning)) return true;
  return s.data.operations.some((o) => f.alive.has(o.holder));
}

// ── Transitions ─────────────────────────────────────────────────────────

type Entry = { guard?: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => Check;
  to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<PState> } | { ignore: string };

function transitions(deps: Deps): Record<string, Record<string, Entry>> {
  const revision: Entry = {
    guard: (s, e, f, ctx) => {
      const c = admissible(f, e.payload.head, ctx, e.payload.sessionId);
      if (c !== true) return c;
      return !restarts(s) && sameHead(s, e.payload.head) ? reject('same_head') : ok();
    },
    to: (s, e, f, ctx) => {
      const live: Live = restarts(s) ? { name: 'idle', data: adopt(e, f, priorOf(s)) } : s;
      const carried = carry(restarts(s) ? fromRowVerdict(live.data, f) : s, e.payload);
      if (carried) return carried;
      if (restarts(s)) return fromRow(live.data, f, e.payload.head, e.payload.trigger, ctx, deps);
      return begin(s, e.payload.head, e.payload.trigger, ctx, deps);
    },
  };

  // Ensure: a preview of the head, built if nothing serves it. Deploy: a new
  // attempt of the head, whatever serves.
  const request: Entry = {
    guard: (s, e, f, ctx) => {
      const c = admissible(f, e.payload.head, ctx, e.payload.sessionId);
      if (c !== true) return c;
      if (s.name === 'preparing' || s.name === 'checking') return reject('in_progress');
      if (e.payload.reason === 'deploy' && (f.session!.isHeadless || !['active', 'promoted'].includes(f.session!.status))) {
        return reject('not_deployable');
      }
      if (e.payload.reason !== 'deploy' && !restarts(s)
          && s.data.serving?.head === e.payload.head && s.data.head === e.payload.head) return reject('already_serving');
      return ok();
    },
    to: (s, e, f, ctx) => {
      const trigger = 'manual-recheck';
      const only = e.payload.reason === 'preview';
      if (restarts(s)) {
        const d = adopt(e, f, priorOf(s));
        if (e.payload.reason === 'ensure') return fromRow(d, f, e.payload.head, trigger, ctx, deps);
        return begin({ name: 'idle', data: d }, e.payload.head, trigger, ctx, deps, only);
      }
      return begin(s, e.payload.head, trigger, ctx, deps, only);
    },
  };

  // A head with nothing to test settles 'skipped' (gate-passing), whatever
  // serves; a build or run in progress decides instead.
  const skipped: Entry = {
    guard: (s, e, f, ctx) => {
      if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
      if (!f.session || !f.app) return reject('no_session');
      if (!OPEN.has(f.session.status)) return reject('not_open');
      // The caller read an older row: a newer run has moved the checks on.
      if (e.payload.expected && e.payload.expected !== f.session.checks.commitSha) return reject('checks_moved');
      return ok();
    },
    to: (s, e, f, ctx) => {
      const d0: Data = restarts(s) ? adopt(e, f, priorOf(s)) : s.data;
      const d: Data = { ...d0, head: e.payload.head, verdict: 'skipped', failure: null, platformFault: false, streak: 0,
        firstFailureAt: null };
      const base = { sessionId: d.sessionId, appId: d.appId, head: e.payload.head };
      const run: Run = { key: `skipped-${ctx.version + 1}`, n: d.serving?.n ?? 0, head: e.payload.head };
      return step({
        name: 'settled', data: d,
        writes: [{ type: 'skipped', ...base, reason: e.payload.reason, expected: f.session!.checks.commitSha }],
        work: [followUps(d, run, 'skipped')],
        push: [checksReady(d, ctx, e.payload.head, 'skipped')],
        messages: [toShots(d, 'HeadReady', { head: e.payload.head })],
        timer: null,
      });
    },
  };

  const cleared: Entry = {
    to: (s, e, f, ctx) => {
      const d0: Data = s.data;
      const old = obsolete(d0, ctx, deps);
      const d: Data = { ...d0, preparing: null, run: null, verdict: null, failure: null, platformFault: false, streak: 0,
        firstFailureAt: null, retiring: old.retiring };
      return step({
        name: d.serving ? 'settled' : 'idle', data: d, cancel: old.cancel, work: old.work,
        writes: [{ type: 'cleared', sessionId: d.sessionId }], timer: null,
      });
    },
  };

  const recheck: Entry = {
    guard: (s) => (s.data.previewOnly ? reject('preview_only') : s.data.head ? ok() : reject('no_head')),
    to: (s, e, f, ctx) => {
      const trigger = recheckTrigger(e.payload.reason, e.payload.trigger);
      const d: Data = s.data;
      // Nothing serves the head: build it.
      if (!d.serving || d.serving.head !== d.head) return begin(s, d.head!, trigger, ctx, deps);
      return startRun(s, trigger, ctx);
    },
  };

  // During a run, a recheck whose inputs changed (the proposal's capture
  // routes or its shots: staging-recovery's REPLACING_RECHECK_REASONS)
  // replaces it, since the run going answers the old question; any other
  // recheck joins it. (A build in progress runs its checks with what the row
  // says once it is up, so it needs nothing.)
  const replacing: Entry = {
    guard: (s, e) => (REPLACING_REASONS.has(e.payload.reason) ? ok() : reject('run_outstanding')),
    to: (s, e, f, ctx) => {
      const old = obsolete(s.data, ctx, deps);
      const o = startRun({ name: s.name, data: { ...s.data, run: null } }, recheckTrigger(e.payload.reason, e.payload.trigger), ctx,
        { work: old.work });
      return { ...o, cancel: old.cancel };
    },
  };

  const lost: Entry = {
    guard: (s, e) => (s.data.serving?.n === e.payload.attempt ? ok() : reject('not_serving')),
    to: (s, e, f, ctx) => begin(s, s.data.head || s.data.serving.head, 'stuck-sweep', ctx, deps),
  };

  // Exit (archive, merge, included, app deletion) is terminal; idle and
  // pressure free the preview and the instance waits for the next revision.
  // Those two never retire a preview someone is working on.
  const retire: Entry = {
    guard: (s, e, f) => {
      if (e.payload.terminal) return ok();
      if (s.name === 'preparing' || s.name === 'checking') return reject('busy');
      if (f.session && ['promoted', 'merging'].includes(f.session.status)) return reject('under_review');
      if (worked(s, f)) return reject('worked_on');
      return ok();
    },
    to: (s, e, f, ctx) => toRetiring(s, e.payload.reason, e.payload.terminal, ctx, deps),
  };
  const adminRetire: Entry = { to: (s, e, f, ctx) => toRetiring(s, 'admin', true, ctx, deps) };

  // A session the machine does not hold yet (or no longer: retired, or
  // handed back before its old paths were deleted), asked to retire its
  // preview or clear its verdict: adopted from its row, then the same as for
  // one it holds. Nothing else tears a preview down or clears a verdict.
  const adopting = (e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
    if (e.payload.sessionId == null) return reject('no_instance');
    if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
    return f.session && f.app ? ok() : reject('no_session');
  };
  const retireAdopting: Entry = {
    guard: (s, e, f, ctx) => {
      const c = adopting(e, f, ctx);
      if (c !== true || e.payload.terminal) return c;
      if (['promoted', 'merging'].includes(f.session!.status)) return reject('under_review');
      const x = f.session!;
      return x.turnRunning || x.localTurnRunning || x.shotsRunning ? reject('worked_on') : ok();
    },
    to: (s, e, f, ctx) => {
      const d = adopt(e, f, priorOf(s));
      if (d.serving) return toRetiring({ name: 'idle', data: d }, e.payload.reason, e.payload.terminal, ctx, deps);
      // Nothing it can name serves: whatever the row still points at goes.
      return step({ name: e.payload.terminal ? 'retired' : 'idle',
        data: { ...d, ...(e.payload.terminal ? { closedAt: ctx.now.toISOString() } : {}) },
        writes: [{ type: 'unpublished', sessionId: d.sessionId }], timer: null,
        messages: e.payload.terminal ? [toShots(d, 'Closed', { reason: e.payload.reason })] : [] });
    },
  };
  const clearAdopting: Entry = {
    guard: (s, e, f, ctx) => adopting(e, f, ctx),
    to: (s, e, f, ctx) => (cleared.to as any)(standing(adopt(e, f, priorOf(s)), f), e, f, ctx),
  };

  const retryDue: Entry = {
    guard: (s, e, f) => (f.session?.retryScope ? ok() : reject('out_of_scope')),
    to: (s, e, f, ctx) => (s.name === 'failed' || !s.data.serving || s.data.serving.head !== s.data.head
      ? begin(s, s.data.head, 'stuck-sweep', ctx, deps)
      : startRun(s, 'stuck-sweep', ctx)),
  };
  const adminRetry: Entry = {
    to: (s, e, f, ctx) => {
      if (s.name === 'retiring') return toRetiring(s, s.data.exit.reason, s.data.exit.terminal, ctx, deps, s.data.exit.attempts || []);
      if (!s.data.head) return step({ name: s.name, data: s.data });
      return s.name === 'failed' || !s.data.serving || s.data.serving.head !== s.data.head
        ? begin(s, s.data.head, 'manual-recheck', ctx, deps)
        : startRun(s, 'manual-recheck', ctx);
    },
  };
  // A build or run that never answers ends as if it had failed.
  const adminEnd: Entry = {
    to: (s, e, f, ctx) => (s.name === 'preparing'
      ? prepared(s, e, 'ended', f, ctx, deps)
      : ran(s, e, 'ended', f, ctx, deps)),
  };

  // An old flow's operation: recorded on any instance (one that does not
  // exist yet starts from its row), and a record whose process has died is
  // dropped whenever one is.
  const opStarted: Entry = {
    guard: (s, e, f, ctx) => {
      if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
      return (s.name === NONE || s.name === 'detached') && (!f.session || !f.app) ? reject('no_session') : ok();
    },
    to: (s, e, f, ctx) => {
      // An operation is recorded only while the flag is on: a session handed
      // back while it was off starts again from its row, as a revision would.
      const live: Live = s.name === NONE || s.name === 'detached' ? standing(adopt(e, f, priorOf(s)), f) : s;
      const p = e.payload;
      const operations = [
        ...live.data.operations.filter((o) => o.id !== p.id && f.alive.has(o.holder)),
        { id: p.id, kind: p.kind, holder: p.holder, since: ctx.now.toISOString() },
      ];
      return step({ name: live.name, data: { ...live.data, operations } });
    },
  };
  const opEnded: Entry = {
    guard: (s, e) => (s.data.operations.some((o: Operation) => o.id === e.payload.id) ? ok() : reject('no_such_operation')),
    to: (s, e, f) => step({ name: s.name, data: { ...s.data,
      operations: s.data.operations.filter((o: Operation) => o.id !== e.payload.id && f.alive.has(o.holder)) } }),
  };
  const ops = { OperationStarted: opStarted, OperationEnded: opEnded };

  const works = (name: Name): Record<string, Entry> => ({
    WorkSucceeded: workResult(name, 'succeeded', deps),
    WorkFailed: workResult(name, 'failed', deps),
    WorkExhausted: workResult(name, 'exhausted', deps),
  });

  const created = { RevisionSubmitted: revision, PreviewRequested: request };
  const notHere = (why: string) => ({ ignore: why });

  return {
    [NONE]: {
      RevisionSubmitted: revision,
      PreviewRequested: request,
      ChecksSkipped: skipped,
      OperationStarted: opStarted,
      RetireRequested: retireAdopting,
      ChecksCleared: clearAdopting,
    },
    idle: {
      ...created, ...ops,
      ChecksSkipped: skipped,
      RecheckRequested: recheck,
      ConflictResolved: notHere('not_deferred'),
      ChecksCleared: cleared,
      PreviewLost: notHere('not_serving'),
      RetireRequested: { guard: (s, e) => (e.payload.terminal ? ok() : reject('already_idle')), to: retire.to },
      AdminRetry: adminRetry, AdminRetire: adminRetire, AdminEnd: notHere('nothing_running'),
      RetryDue: notHere('not_waiting'),
      ...works('idle'),
    },
    preparing: {
      ...created, ...ops,
      ChecksSkipped: notHere('in_progress'),
      RecheckRequested: notHere('run_outstanding'),
      ConflictResolved: notHere('not_deferred'),
      ChecksCleared: cleared,
      PreviewLost: notHere('preparing'),
      RetireRequested: retire,
      AdminRetry: notHere('in_progress'), AdminRetire: adminRetire, AdminEnd: adminEnd,
      RetryDue: notHere('not_waiting'),
      ...works('preparing'),
    },
    checking: {
      ...created, ...ops,
      ChecksSkipped: notHere('in_progress'),
      RecheckRequested: replacing,
      ConflictResolved: notHere('not_deferred'),
      ChecksCleared: cleared,
      PreviewLost: lost,
      RetireRequested: retire,
      AdminRetry: notHere('in_progress'), AdminRetire: adminRetire, AdminEnd: adminEnd,
      RetryDue: notHere('not_waiting'),
      ...works('checking'),
    },
    deferred: {
      ...created, ...ops,
      ChecksSkipped: skipped,
      RecheckRequested: recheck,
      ConflictResolved: {
        guard: (s, e) => (e.payload.head === s.data.head ? ok() : reject('not_deferred_head')),
        to: (s, e, f, ctx) => startRun(s, 'conflict-resolved', ctx),
      },
      ChecksCleared: cleared,
      PreviewLost: lost,
      RetireRequested: retire,
      AdminRetry: adminRetry, AdminRetire: adminRetire, AdminEnd: notHere('nothing_running'),
      RetryDue: notHere('not_waiting'),
      ...works('deferred'),
    },
    settled: {
      ...created, ...ops,
      ChecksSkipped: skipped,
      RecheckRequested: recheck,
      ConflictResolved: notHere('not_deferred'),
      ChecksCleared: cleared,
      PreviewLost: lost,
      RetireRequested: retire,
      AdminRetry: adminRetry, AdminRetire: adminRetire, AdminEnd: notHere('nothing_running'),
      RetryDue: { guard: (s, e, f) => (s.data.verdict !== 'error' ? reject('not_error') : (retryDue.guard as any)(s, e, f)), to: retryDue.to },
      ...works('settled'),
    },
    failed: {
      ...created, ...ops,
      ChecksSkipped: skipped,
      RecheckRequested: recheck,
      ConflictResolved: notHere('not_deferred'),
      ChecksCleared: cleared,
      PreviewLost: lost,
      RetireRequested: retire,
      AdminRetry: adminRetry, AdminRetire: adminRetire, AdminEnd: notHere('nothing_running'),
      RetryDue: retryDue,
      ...works('failed'),
    },
    retiring: {
      // An idle retirement finishes first; the newest revision that arrives
      // meanwhile is prepared when it closes. An exit takes none.
      RevisionSubmitted: {
        guard: (s, e, f, ctx) => {
          if (s.data.exit.terminal) return reject('retiring');
          return admissible(f, e.payload.head, ctx, e.payload.sessionId);
        },
        to: (s, e) => step({ name: 'retiring', data: { ...s.data, pending: { head: e.payload.head, trigger: e.payload.trigger } } }),
      },
      ...ops,
      PreviewRequested: notHere('retiring'),
      ChecksSkipped: notHere('retiring'),
      RecheckRequested: notHere('retiring'),
      ConflictResolved: notHere('retiring'),
      ChecksCleared: notHere('retiring'),
      PreviewLost: notHere('retiring'),
      RetireRequested: {
        guard: (s, e) => (e.payload.terminal && !s.data.exit.terminal ? ok() : reject('already_retiring')),
        to: (s, e) => step({ name: 'retiring', data: { ...s.data, exit: { ...s.data.exit, reason: e.payload.reason, terminal: true }, pending: null },
          messages: [toShots(s.data, 'Closed', { reason: e.payload.reason })] }),
      },
      AdminRetry: { guard: (s) => (s.data.exit.failed ? ok() : reject('in_progress')), to: adminRetry.to },
      AdminRetire: notHere('already_retiring'),
      AdminEnd: notHere('retiring'),
      RetryDue: notHere('not_waiting'),
      ...works('retiring'),
    },
    retired: {
      '*': notHere('retired'),
      ...created, ...ops,
      ChecksSkipped: skipped,
      ChecksCleared: clearAdopting,
      ...works('retired'),
    },
    // Handed back before the old paths were deleted (no Detach any more): an
    // instance in it starts again from its row, like a retired one.
    detached: {
      '*': notHere('detached'),
      ...created,
      ChecksSkipped: skipped,
      OperationStarted: opStarted,
      RetireRequested: retireAdopting,
      ChecksCleared: clearAdopting,
      ...works('detached'),
    },
  };
}

// Retire everything this instance created: the serving attempt, the one
// being prepared, and those still waiting for their own retirement (whose
// items are cancelled: this one covers them).
function toRetiring(s: Live, reason: string, terminal: boolean, ctx: TransitionContext, deps: Deps,
  again: Attempt[] = []): Outcome<PState> {
  const d0 = s.data;
  const old = obsolete(d0, ctx, deps);
  const attempts = new Map<number, Attempt>();
  for (const a of [...again, ...(d0.serving ? [d0.serving] : []), ...old.retiring]) {
    attempts.set(a.n, { n: a.n, head: a.head, db: a.db, dbs: dbsOf(a) });
  }
  const key = `retire:${ctx.version + 1}`;
  // A prepare cancelled just now, or lately, may still create something
  // until its handler stops: the retirement runs after that.
  const waits = !!d0.preparing || d0.retiring.some((a) => a.cancelled);
  const d: Data = { ...d0, preparing: null, run: null, retiring: [],
    exit: { reason, terminal, key, attempts: [...attempts.values()] }, pending: null };
  return step({
    name: 'retiring', data: d,
    messages: terminal ? [toShots(d, 'Closed', { reason })] : [],
    cancel: [...old.cancel, ...d0.retiring.map((a) => ({ kind: WORK.retireAttempt, key: a.key }))],
    writes: [{ type: 'unpublished', sessionId: d.sessionId }],
    work: [...old.work.filter((w) => w.kind !== WORK.retireAttempt), { kind: WORK.retire, key, input: {
      sessionId: d.sessionId, appId: d.appId, appSlug: d.appSlug, attempts: [...attempts.values()] as unknown as Json,
      runtimeName: d0.serving?.runtimeName ?? null, runtimeKind: d0.serving?.runtimeKind ?? null,
    },
    ...(waits ? { notBefore: new Date(ctx.now.getTime() + deps.retireAfterMs) } : {}) }],
    timer: null,
  });
}

// ── Work results ────────────────────────────────────────────────────────

export interface PrepareResult {
  ok: boolean;
  url?: string; runtimeKind?: string; runtimeName?: string; containerId?: string | null;
  imageRef?: string | null; buildRef?: string | null;
  db?: string;                  // the database the claim that deployed cloned into
  // A failure: the reason for the card, and what to tell the author.
  detail?: string; infrastructure?: boolean; platformFault?: boolean; aboutMain?: string | null; sync?: boolean;
  servingRemoved?: boolean;     // Docker removes the old container before it runs the new one
}

export interface RunResult {
  outcome: 'verdict' | 'deferred' | 'blocked';
  state?: Verdict;
  results?: Json;               // test_results rows
  errorDetail?: string | null;
  platformFault?: boolean;
  console?: Json;               // { state, errors }
  history?: Json;               // app_check_history rows (verdicts other than error)
  capture?: { state: string; detail: Json } | null;
  visuals?: Json;               // the run's media, grouped as getForSession groups it (null: none)
  reason?: string;              // blocked
  uiUndeclared?: string | null; // a head whose change touches the UI and declares no visible changes
}

function workResult(name: Name, outcome: 'succeeded' | 'failed' | 'exhausted', deps: Deps): Entry {
  return {
    guard: (s, e: Event<WorkResultPayload>) => {
      const p = e.payload;
      if (p.kind === WORK.prepare) return s.data.preparing && p.workKey === prepareKey(s.data.preparing.n) ? ok() : reject('stale_result');
      if (p.kind === WORK.run) return s.data.run?.key === p.workKey ? ok() : reject('stale_result');
      if (p.kind === WORK.retire) return s.data.exit?.key === p.workKey ? ok() : reject('stale_result');
      return ok();
    },
    to: (s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext) => {
      const p = e.payload;
      if (p.kind === WORK.prepare) return prepared(s, e, outcome, f, ctx, deps);
      if (p.kind === WORK.run) return ran(s, e, outcome, f, ctx, deps);
      if (p.kind === WORK.retire) return retired(s, e, outcome, ctx, deps);
      // Everything else only has to happen; a retired attempt leaves the list.
      const d = s.data;
      const retiring = p.kind === WORK.retireAttempt ? d.retiring.filter((a) => a.key !== p.workKey) : d.retiring;
      // An item an older release queued, before the shots machine was told
      // by message: its handler hands its head over (services.ts).
      const r = (outcome === 'succeeded' ? p.result : null) as { handOff?: string; stopped?: string | null } | null;
      const messages = r?.handOff ? [toShots(d, 'HeadReady', { head: r.handOff })]
        : r && 'stopped' in r ? [toShots(d, 'PreviewStopped', { head: r.stopped ?? null })] : [];
      return step({ name, data: { ...d, retiring }, messages });
    },
  };
}

function prepared(s: Live, e: Event<any>, outcome: string, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const d0 = s.data;
  const attempt = d0.preparing!;
  const r = (outcome === 'succeeded' ? e.payload.result : null) as PrepareResult | null;
  if (r?.ok) {
    // The database of the claim that deployed is the one that serves; the
    // other claims' (a claim that died, after a clone or after a deploy whose
    // pods this rollout replaced) go.
    const servedDb = r.db || attempt.db;
    const claims = dbsOf(attempt);
    const leftovers = claims.slice(0, Math.max(0, claims.indexOf(servedDb)));   // only claims before it ran
    const served: Served = {
      ...attempt, db: servedDb, dbs: [servedDb], url: String(r.url), runtimeKind: String(r.runtimeKind),
      runtimeName: String(r.runtimeName), containerId: r.containerId ?? null, imageRef: r.imageRef ?? null, buildRef: r.buildRef ?? null,
    };
    const previous = d0.serving && d0.serving.n !== served.n ? d0.serving : null;
    const gone = previous ? retire(d0, previous, ctx, deps) : null;
    const d: Data = { ...d0, preparing: null, serving: served, retiring: gone ? [...d0.retiring, gone.entry] : d0.retiring };
    const dropped = leftovers.length ? [{ kind: WORK.dropClaims, key: `drop-claims:${served.n}`,
      input: { sessionId: d.sessionId, dbs: leftovers } }] : [];
    const up = [
      sessionEvent(route(d), 'staging_ready', seq(ctx, 3),
        { url: served.url, testingMd: f.session?.testing?.md ?? null, testingPath: f.session?.testing?.path ?? null }),
      sessionUpdate({ action: 'staging_ready', sessionId: d.sessionId, appId: d.appId, appSlug: d.appSlug }),
    ];
    // A preview with no checks serves, and that is all.
    if (attempt.previewOnly) {
      return step({
        name: 'settled', data: { ...d, verdict: null },
        writes: [{ type: 'published', sessionId: d.sessionId, served: served as unknown as Json }],
        work: [...(gone ? [gone.work] : []), ...dropped],
        push: up,
        timer: null,
      });
    }
    return told(startRun({ name: 'preparing', data: d }, d0.trigger, ctx, {
      writes: [{ type: 'published', sessionId: d.sessionId, appId: d.appId, served: served as unknown as Json, note: true }],
      work: [...(gone ? [gone.work] : []), ...dropped],
      push: up,
    }), toShots(d, 'HeadReady', { head: served.head }));
  }
  // The attempt failed: what serves keeps serving (on Docker it was
  // removed first). The attempt's own resources are retired, and its early
  // unit suite stops (nothing will read it).
  const ended = outcome === 'ended';
  const detail = ended ? 'An admin ended the build'
    : r?.detail || e.payload.error?.message || 'The preview could not be prepared';
  const infrastructure = !!r?.infrastructure;
  const servingRemoved = !!r?.servingRemoved;
  const streakBefore = d0.streak;
  const d: Data = {
    ...d0, preparing: null, verdict: 'error', failure: detail, platformFault: !!r?.platformFault, streak: streakBefore + 1,
    firstFailureAt: d0.firstFailureAt ?? ctx.now.toISOString(),
    serving: servingRemoved ? null : d0.serving,
  };
  const failedAttempt = retire(d0, attempt, ctx, deps, ended);
  const removed = servingRemoved && d0.serving ? retire(d0, d0.serving, ctx, deps) : null;
  d.retiring = [...d0.retiring, failedAttempt.entry, ...(removed ? [removed.entry] : [])];
  // A preview with no checks: no verdict to store, no author to tell, no
  // retry of its own (whoever asked for it reads the failure).
  if (attempt.previewOnly) {
    return step({
      name: 'failed', data: { ...d, verdict: null, platformFault: false, streak: 0, firstFailureAt: null },
      cancel: [...(ended ? [{ kind: WORK.prepare, key: prepareKey(attempt.n) }] : []), earlyOf(attempt)],
      writes: servingRemoved && d0.serving ? [{ type: 'unpublished', sessionId: d.sessionId }] : [],
      work: [failedAttempt.work, ...(removed ? [removed.work] : [])],
      push: [sessionEvent(route(d), 'staging_failed', seq(ctx, 3), { error: detail, errorName: 'PreviewFailed', missingKeys: [] })],
      timer: null,
    });
  }
  const writes: DomainWrite[] = [{
    type: 'prepareFailed', eventId: e.id, sessionId: d.sessionId, appId: d.appId, userId: d.userId, head: attempt.head,
    detail, infrastructure, platformFault: !!r?.platformFault, aboutMain: r?.aboutMain ?? null, sync: !!r?.sync,
    source: f.session?.source ?? null, prNumber: f.session?.prNumber ?? null,
  }];
  if (servingRemoved && d0.serving) writes.push({ type: 'unpublished', sessionId: d.sessionId });
  const work: WorkRequest[] = [failedAttempt.work, ...(removed ? [removed.work] : [])];
  const messages: MessageRequest[] = [];
  if (streakBefore === 0) {
    work.push({ kind: WORK.stopped, key: `stopped:${attempt.n}`,
      input: { sessionId: d.sessionId, imported: f.session?.source === 'imported', shotsTold: true } });
    if (f.session?.source === 'imported') messages.push(toShots(d, 'PreviewStopped', { head: attempt.head }));
  }
  return step({
    name: 'failed', data: d,
    cancel: [...(ended ? [{ kind: WORK.prepare, key: prepareKey(attempt.n) }] : []), earlyOf(attempt)],
    writes, work, messages,
    push: [
      checksReady(d, ctx, attempt.head, 'error'),
      sessionEvent(route(d), 'staging_failed', seq(ctx, 3),
        { error: detail, errorName: 'PreviewFailed', missingKeys: [] }),
    ],
    timer: errorTimer(d, f, deps, ctx, streakBefore),
  });
}

function ran(s: Live, e: Event<any>, outcome: string, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const d0 = s.data;
  const run = d0.run!;
  const r = (outcome === 'succeeded' ? e.payload.result : null) as RunResult | null;
  const base = { sessionId: d0.sessionId, appId: d0.appId, head: run.head, runId: run.key };
  const visuals = r?.visuals ?? null;
  const visualsReady = visuals
    ? [sessionEvent(route(d0), 'visuals_ready', seq(ctx, 4), { visuals: visuals as Json })] : [];
  if (r?.outcome === 'deferred') {
    const d: Data = { ...d0, run: null, episode: d0.episode + 1 };
    return step({
      name: 'deferred', data: d,
      writes: [{ type: 'deferred', ...base, capture: (r.capture ?? null) as Json, media: !!visuals }],
      work: [
        { kind: WORK.publish, key: `publish:${run.key}`, input: { ...base, visuals: !!visuals } },
        followUps(d, run, 'pending', true),
      ],
      push: [checksPending(d, ctx, run.head, 'deferred', d0.trigger), ...visualsReady],
      messages: [toShots(d, 'HeadReady', { head: run.head }), ...undeclared(d, r)],
      timer: null,
    });
  }
  // A verdict, or what stands for one when the run could not say: missing
  // or unreadable output is never a verdict.
  const ended = outcome === 'ended';
  const blocked = !r || r.outcome !== 'verdict';
  const state: Verdict = blocked ? 'error' : r!.state!;
  const detail = ended ? 'An admin ended the checks run'
    : blocked
      ? (r?.reason || (outcome === 'succeeded' ? 'The checks run produced no result' : 'The checks run was lost before it finished'))
      : (r!.errorDetail ?? null);
  const streakBefore = d0.streak;
  // The platform's fault, never the proposal's: what the run itself says is
  // (a Pod that never started, a capture Job that wrote nothing), and a run
  // that never answered at all (its handler kept failing, or its claims kept
  // being lost). An admin ending a hung run is not counted as either.
  const platformFault = state === 'error' && (!!r?.platformFault || (!ended && outcome !== 'succeeded'));
  const d: Data = {
    ...d0, run: null, verdict: state, failure: state === 'error' ? detail : null, platformFault,
    streak: state === 'error' ? streakBefore + 1 : 0,
    firstFailureAt: state === 'error' ? (d0.firstFailureAt ?? ctx.now.toISOString()) : null,
  };
  const results = blocked ? [] : ((r!.results ?? []) as unknown[]);
  // The settlement is stored only while the row is open and its checks are
  // about this run's head (check-store's fence); a verdict nobody stores sets
  // nothing off.
  const stores = !!f.session && OPEN.has(f.session.status) && f.session.checks.commitSha === run.head;
  const settle = {
    type: 'settled', ...base, state, detail, platformFault,
    results: results as Json, console: blocked ? null : (r!.console ?? null),
    history: state === 'error' || blocked ? [] : (r!.history ?? []), capture: blocked ? null : (r!.capture ?? null),
    media: !blocked && !!visuals,
  };
  return step({
    name: 'settled', data: d,
    cancel: ended ? [{ kind: WORK.run, key: run.key }] : undefined,
    writes: [settle],
    work: [
      ...(ended ? [{ kind: WORK.cancel, key: `cancel:${run.key}`, input: { sessionId: d.sessionId, runId: run.key } }] : []),
      ...(stores ? [
        { kind: WORK.publish, key: `publish:${run.key}`, input: { ...base, state, visuals: !!visuals } },
        followUps(d, run, state),
      ] : []),
    ],
    push: stores ? [checksReady(d, ctx, run.head, state, results), ...visualsReady] : [],
    messages: [...(stores ? [toShots(d, 'HeadReady', { head: run.head })] : []), ...undeclared(d, r)],
    timer: state === 'error' ? errorTimer(d, f, deps, ctx, streakBefore) : null,
  });
}

// A run that found a UI change with no declaration of visible changes
// (visuals.captureForSession) tells the shots machine, whose slot says so.
const undeclared = (d: Data, r: RunResult | null): MessageRequest[] =>
  (r?.uiUndeclared ? [toShots(d, 'UiUndeclared', { head: r.uiUndeclared })] : []);

function retired(s: Live, e: Event<WorkResultPayload>, outcome: string, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const d0 = s.data;
  const closed = outcome === 'succeeded' && (e.payload.result as any)?.closed === true;
  if (!closed) {
    // Exhausted or not closed: an admin retries it (Admin → Workflows).
    return step({ name: 'retiring', data: { ...d0, exit: { ...d0.exit!, failed: e.payload.error?.message || 'not closed' } } });
  }
  const d: Data = { ...d0, serving: null, preparing: null, run: null, exit: null };
  if (d0.exit!.terminal) return step({ name: 'retired', data: { ...d, pending: null, closedAt: ctx.now.toISOString() } });
  if (d0.pending) return begin({ name: 'idle', data: { ...d, pending: null } }, d0.pending.head, d0.pending.trigger, ctx, deps);
  return step({ name: 'idle', data: { ...d, pending: null } });
}

// ── The machine ─────────────────────────────────────────────────────────

const PRODUCERS: ReadonlySet<string> = new Set(['route', 'system']);

export function preview(deps: Deps): Machine<PState, Facts> {
  const produced = (e: Event<any>): Check => (PRODUCERS.has(e.source.kind) ? ok() : reject('not_a_producer'));
  const system = (e: Event<any>): Check => (e.source.kind === 'system' || e.source.kind === 'message' ? ok() : reject('internal_only'));
  const admin = (e: Event<any>): Check => (e.source.kind === 'admin' ? ok() : reject('admin_only'));
  // RetryDue: the error lane's own timer, or a release (platform.ts
  // retryPlatformFaults): a boot is when a fix to the platform's own fault
  // most often arrives, so it does not wait for the scheduled retry.
  const retry = (e: Event<any>): Check => (e.source.kind === 'timer' || e.source.kind === 'system' ? ok() : reject('timer_only'));

  return defineMachine<PState, Facts>({
    name: MACHINE,
    // 2: the old preview paths are deleted. A retire or a clear adopts a
    // session from its row (create events), a preview-only request (the App
    // bench), a release retries the platform's faults (RetryDue from the
    // system), no Detach. 3: the shots machine is told by message (a head
    // ready, a preview that will not start, a UI change undeclared, the
    // proposal closed) instead of starting shots itself. An older Pod leaves
    // the instances this version wrote alone during the rollout.
    version: 3,
    events: EVENTS,
    create: ['RevisionSubmitted', 'PreviewRequested', 'ChecksSkipped', 'OperationStarted', 'RetireRequested', 'ChecksCleared'],
    terminal: ['retired'],
    decode: (row) => ({ name: row.state, data: row.data } as PState),
    facts: (tx, state, event) => {
      const id = state.name === NONE ? Number((event.payload as any)?.sessionId) : (state.data as Data).sessionId;
      if (!Number.isInteger(id) || id <= 0) return Promise.resolve({ session: null, app: null, alive: new Set<string>() });
      const operation = event.type === 'OperationStarted' || event.type === 'OperationEnded';
      const holders = state.name === NONE ? [] : (state.data as Data).operations.map((o) => o.holder);
      // An operation's own record locks nothing: it only notes who works here.
      return readFacts(tx, id, { lock: !operation, holders: [...new Set(holders)] });
    },
    authorize: {
      RevisionSubmitted: produced,
      PreviewRequested: produced,
      ChecksSkipped: produced,
      RecheckRequested: (e) => (PRODUCERS.has(e.source.kind) || e.source.kind === 'admin' ? ok() : reject('not_a_producer')),
      ConflictResolved: system,
      ChecksCleared: produced,
      PreviewLost: system,
      RetireRequested: system,
      OperationStarted: system,
      OperationEnded: system,
      AdminRetry: admin,
      AdminRetire: admin,
      AdminEnd: admin,
      RetryDue: retry,
    },
    transitions: transitions(deps) as any,
    writes: WRITES,
    reply: async (tx, event, after) => {
      if (after.name === NONE) return null;
      const d = (after as Live).data;
      return {
        state: after.name, head: d.head,
        url: d.serving && d.serving.head === d.head ? d.serving.url : null,
        verdict: d.verdict,
      };
    },
  });
}

// ── Domain writes ───────────────────────────────────────────────────────

// What a note about a proposal names it by.
async function proposalOf(tx: Tx, sessionId: number) {
  const { rows: [row] } = await tx.query('SELECT source, pr_number, pr_title FROM chat_sessions WHERE id = $1', [sessionId]);
  return row || null;
}
const prLabel = (row: { pr_number: number | null; pr_title: string | null }) =>
  (row.pr_title ? `PR #${row.pr_number}: ${row.pr_title}` : `PR #${row.pr_number}`);

// A system line in a proposal's discussion thread, pushed to the app's room.
async function threadNote(tx: Tx, ctx: any, appId: number, sessionId: number, body: string, metadata: Json) {
  const { rows: [row] } = await tx.query(
    `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, 'system', $3, 'session', $4)
     RETURNING id, app_id, content, msg_type, metadata, thread_type, thread_ref, created_at`,
    [appId, body, JSON.stringify(metadata), sessionId]);
  ctx.push(chatLine(row));
}

// Whether the dev chat's last line about the preview is a build still
// running (the card a turn posts), with nothing after it that ended it.
async function buildCardOpen(tx: Tx, sessionId: number): Promise<boolean> {
  const { rows: [last] } = await tx.query(
    `SELECT metadata->>'stagingBuild' AS build FROM chat_session_messages
      WHERE session_id = $1 AND role = 'system'
        AND (metadata ? 'stagingBuild' OR metadata ? 'stagingUrl' OR metadata ? 'stagingFailed')
      ORDER BY id DESC LIMIT 1`, [sessionId]);
  return last?.build === 'running';
}

const WRITES = {
  // checks_commit_sha, 'pending', the phase and the trigger.
  pending: (tx: Tx, w: any) => store.setChecksPending(tx, w.sessionId, w.head, w.phase, w.trigger),

  // An imported proposal's thread hears that its preview is being built
  // (#866: it has no dev chat). Once per head: a rebuild of the same head
  // after a failure says nothing new.
  async buildStarted(tx: Tx, w: any, ctx: any) {
    const row = await proposalOf(tx, w.sessionId);
    if (row?.source !== 'imported') return;
    const { rows: [last] } = await tx.query(
      `SELECT metadata->>'stagingBuild' AS build, metadata->>'headSha' AS head FROM chat_messages
        WHERE thread_type = 'session' AND thread_ref = $1 AND metadata ? 'stagingBuild'
        ORDER BY id DESC LIMIT 1`, [w.sessionId]);
    if (last?.build === 'started' && last.head === w.head) return;
    await threadNote(tx, ctx, w.appId, w.sessionId,
      `A staging preview for ${prLabel(row)} is being built. This usually takes a few minutes. `
        + 'The automated checks run against it, and a Preview button appears on this proposal when it\'s ready.',
      { stagingBuild: 'started', headSha: w.head, prNumber: row.pr_number ?? null });
  },

  // The prepare's receipt, in one statement; then, for a proposal (not a
  // preview with no checks), the line that says it is up: the dev chat's
  // "Staging deployed!" (what a tab that watched it build already shows, and
  // what closes a "Building staging preview..." card on a reload), or an
  // imported proposal's thread note.
  async published(tx: Tx, w: any, ctx: any) {
    await tx.query(
      `UPDATE chat_sessions SET staging_url = $2, staging_container_id = $3, staging_image_ref = $4, staging_build_ref = $5,
              staging_runtime_kind = $6, staging_runtime_name = $7, staging_commit_sha = $8
        WHERE id = $1`,
      [w.sessionId, w.served.url, w.served.containerId, w.served.imageRef, w.served.buildRef,
        w.served.runtimeKind, w.served.runtimeName, w.served.head]);
    if (!w.note) return;
    const row = await proposalOf(tx, w.sessionId);
    if (!row) return;
    if (row.source === 'imported') {
      // The URL rides in metadata: the Preview button is the way in.
      await threadNote(tx, ctx, w.appId, w.sessionId,
        `The staging preview for ${prLabel(row)} is ready. Use the Preview button on this proposal to try the change. `
          + 'Automated checks are running against it now.',
        { stagingBuild: 'ready', headSha: w.served.head, stagingUrl: w.served.url, prNumber: row.pr_number ?? null });
      return;
    }
    await tx.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'system', 'Staging deployed!', $2)`,
      [w.sessionId, JSON.stringify({ stagingUrl: w.served.url, prNumber: row.pr_number ?? null })]);
  },

  async unpublished(tx: Tx, w: any) {
    await tx.query(
      `UPDATE chat_sessions SET staging_url = NULL, staging_container_id = NULL, staging_image_ref = NULL,
              staging_build_ref = NULL, staging_runtime_kind = NULL, staging_runtime_name = NULL, staging_commit_sha = NULL
        WHERE id = $1`, [w.sessionId]);
    await dropMedia(tx, w.sessionId);
  },

  // The head's 'error' and the failure streak; once per streak
  // (check_error_notified_at), unless the cause is infrastructure, the
  // author's thread line and notification.
  async prepareFailed(tx: Tx, w: any, ctx: any) {
    // A "Building staging preview..." card a turn left open in the dev chat
    // is closed by its outcome, every time (the note below is once a streak).
    if (w.source !== 'imported' && await buildCardOpen(tx, w.sessionId)) {
      await tx.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'system', 'Staging build failed', $2)`,
        [w.sessionId, JSON.stringify({ stagingFailed: true, error: w.detail, changesReady: true, prNumber: w.prNumber ?? null })]);
    }
    const stored = await store.storeChecks(tx, w.sessionId, w.head,
      { state: 'error', results: [], ...(w.platformFault ? { platformFault: true } : {}) }, w.detail);
    if (!stored || w.infrastructure) return;
    const { rows: [first] } = await tx.query(
      `UPDATE chat_sessions SET check_error_notified_at = NOW()
        WHERE id = $1 AND check_error_notified_at IS NULL AND checks_commit_sha IS NOT DISTINCT FROM $2::text
        RETURNING id`, [w.sessionId, w.head]);
    if (!first) return;
    const body = w.sync
      ? `⚠️ Staging preview failed to start. ${w.aboutMain} Reason: ${w.detail}`
      : `⚠️ Staging preview failed to start, so automated checks can't run and this proposal can't merge yet.${w.aboutMain ? ` ${w.aboutMain}` : ''} Reason: ${w.detail}`;
    // #866: a native proposal's dev chat shows its own messages; an imported
    // one has none, so its note goes to the discussion thread its card links.
    if (w.source === 'imported') {
      const { rows: [row] } = await tx.query(
        `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, 'system', $3, 'session', $4)
         RETURNING id, app_id, content, msg_type, metadata, thread_type, thread_ref, created_at`,
        [w.appId, body, JSON.stringify({ checkError: true, detail: w.detail, prNumber: w.prNumber }), w.sessionId]);
      ctx.push(chatLine(row));
    } else {
      await tx.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'system', $2, $3)`,
        [w.sessionId, body, JSON.stringify({ checkError: true, detail: w.detail })]);
    }
    for (const n of await createCheckFailedNotification(tx, { userId: w.userId, appId: w.appId, sessionId: w.sessionId })) {
      ctx.push(toUser(Number(n.user_id), { type: 'notification_new', notificationId: Number(n.id) }));
    }
  },

  // A run's settlement, together: verdict and test_results, console,
  // capture outcome, the run's media, and the app's check history (counted
  // once per run). Nothing of it is written for a verdict about a head the
  // row has since left.
  async settled(tx: Tx, w: any) {
    const stored = await store.storeChecks(tx, w.sessionId, w.head,
      { state: w.state, results: w.results, ...(w.platformFault ? { platformFault: true } : {}) }, w.detail);
    if (!stored) { await dropMedia(tx, w.sessionId); return; }
    if (w.console) await store.storeConsoleCheck(tx, w.sessionId, w.console, w.head);
    if (w.capture) await store.storeCaptureOutcome(tx, w.sessionId, w.capture.state, w.capture.detail, w.head);
    if (w.media) await publishMedia(tx, w.sessionId, w.runId); else await dropMedia(tx, w.sessionId);
    if (Array.isArray(w.history) && w.history.length) {
      await store.recordRun(tx, w.appId, w.history, { sessionId: w.sessionId });
    }
  },

  // No verdict for the branch's code: what the CLI upload route cleared.
  cleared: (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions
        SET check_state = NULL, check_phase = NULL, check_error_detail = NULL, test_results = '[]'::jsonb,
            checks_checked_at = NULL, consecutive_check_failures = 0, first_check_failure_at = NULL,
            last_check_failure_at = NULL, check_next_retry_at = NULL, check_error_notified_at = NULL,
            capture_state = NULL, capture_detail = NULL, captured_at = NULL
      WHERE id = $1`, [w.sessionId]),

  // A carried verdict now describes the merged head.
  carried: (tx: Tx, w: any) => tx.query('UPDATE chat_sessions SET checks_commit_sha = $2 WHERE id = $1', [w.sessionId, w.head]),

  // Nothing to test, against the row's pin as the transition read it.
  skipped: (tx: Tx, w: any) => store.storeChecksSkipped(tx, w.sessionId, w.head, w.reason, w.expected ?? null),

  // A promoted head that conflicts with main: previewed, verdict deferred.
  async deferred(tx: Tx, w: any) {
    const stored = await store.storeChecksDeferred(tx, w.sessionId, w.head, 'Checks wait until this proposal merges cleanly with main');
    if (stored && w.capture) await store.storeCaptureOutcome(tx, w.sessionId, w.capture.state, w.capture.detail, w.head);
    if (stored && w.media) await publishMedia(tx, w.sessionId, w.runId); else await dropMedia(tx, w.sessionId);
  },
};

// A run's media, held under its run id while it ran (check_run_media), is
// what the session shows from now on: the previous media goes, as
// services/visuals.js storeArtifacts replaces it. What other runs of the
// session held (cancelled, superseded) goes with it.
async function publishMedia(tx: Tx, sessionId: number, runId: string) {
  await tx.query('DELETE FROM session_visuals WHERE session_id = $1', [sessionId]);
  await tx.query(
    `INSERT INTO session_visuals (id, session_id, commit_hash, kind, media, content_type, data, captured_path,
                                  capture_index, captured_viewport, shot_status, before_fell_back, scenario_id,
                                  scenario_fingerprint)
     SELECT id, session_id, commit_hash, kind, media, content_type, data, captured_path, capture_index,
            captured_viewport, shot_status, before_fell_back, scenario_id, scenario_fingerprint
       FROM check_run_media WHERE run_id = $1 AND session_id = $2`, [runId, sessionId]);
  await dropMedia(tx, sessionId);
}
const dropMedia = (tx: Tx, sessionId: number) => tx.query('DELETE FROM check_run_media WHERE session_id = $1', [sessionId]);

