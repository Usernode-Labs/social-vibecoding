// preview: a proposal's preview and its required checks, from the first
// revision announced under the flag until the preview is retired. One
// instance per session. Each build is an attempt, numbered within the
// instance: the runtime (Deployment, Service, Ingress) is the session's and
// is updated in place, while the database and the env Secret are the
// attempt's, so a failed candidate never touches what serves. Check runs
// belong to the attempt that serves. workflow-foundation's
// machine-preview.md is the design.

import { createHash } from 'node:crypto';
import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type {
  Check, DomainWrite, Event, Json, Machine, Notification, Outcome, TransitionContext, TimerRequest, WorkRef, WorkRequest,
  WorkResultPayload,
} from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import type { Tx } from '../kernel/index.ts';
import { OPEN, readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'preview';
export const sessionKey = (sessionId: number) => `session:${sessionId}`;

export const WORK = Object.freeze({
  prepare: 'preview.prepare',
  run: 'checks.run',
  cancel: 'checks.cancel',
  publish: 'checks.publish',
  retireAttempt: 'preview.retireAttempt',
  retire: 'preview.retire',
  botNote: 'legacy.botNote',
  botStopped: 'legacy.botStopped',
  startShots: 'legacy.startShots',
  scheduleShots: 'legacy.scheduleShots',
});

export const NOTIFIERS = ['chat', 'checksPending', 'checksReady', 'stagingReady', 'visualsReady', 'mergeKick'] as const;

// ── States ──────────────────────────────────────────────────────────────

export type Verdict = 'passing' | 'failing' | 'skipped' | 'error';

// An attempt: its number, the head it builds, and its database. Attempt 0
// is a preview [main] built before the flag, adopted with [main]'s names.
export interface Attempt { n: number; head: string; db: string }
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

export interface Data {
  sessionId: number;
  appId: number;
  appSlug: string;
  seed: number;                  // the creating event's id: attempt names are unique per instance
  head: string | null;           // the head this instance is about
  trigger: string | null;        // why the current preparation or run started
  last: number;                  // the last attempt number given out
  preparing: Attempt | null;
  serving: Served | null;
  run: Run | null;
  verdict: Verdict | null;
  failure: string | null;        // the detail of the current error
  streak: number;                // consecutive errors on this head
  episode: number;               // deferred episodes, for ConflictResolved's key
  retiring: Attempt[];           // attempts whose preview.retireAttempt is outstanding
  exit: { reason: string; terminal: boolean; key: string; failed?: string } | null;
  pending: { head: string; trigger: string | null } | null;  // a revision that arrived during an idle retirement
  closedAt: string | null;
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

const REQUEST_REASONS = new Set(['ensure', 'deploy', 'env_stale']);

const EVENTS = {
  // A head announced by any source (a turn, an upload, an update, a sync,
  // an imported pull request, the merge gate, fleet, recovery).
  RevisionSubmitted: (p: any) => ({
    sessionId: int(p?.sessionId, 'sessionId'), head: sha(p?.head, 'head'),
    source: word(p?.source, 'source'), trigger: optWord(p?.trigger),
  }),
  // A person or the platform asks for the preview itself.
  PreviewRequested: (p: any) => ({
    sessionId: int(p?.sessionId, 'sessionId'), head: sha(p?.head, 'head'),
    reason: word(p?.reason, 'reason', REQUEST_REASONS),
  }),
  RecheckRequested: (p: any) => ({ reason: word(p?.reason, 'reason'), trigger: optWord(p?.trigger) }),
  ConflictResolved: (p: any) => ({ head: sha(p?.head, 'head') }),
  // An observer found the serving runtime gone or broken.
  PreviewLost: (p: any) => {
    if (!Number.isInteger(p?.attempt) || p.attempt < 0) throw new Error('attempt must be an attempt number');
    return { attempt: p.attempt as number, detail: optWord(p?.detail) };
  },
  RetireRequested: (p: any) => ({ reason: word(p?.reason, 'reason'), terminal: p?.terminal === true }),
  Detach: () => ({}),
  AdminRetry: () => ({}),
  AdminRetire: () => ({}),
  RetryDue: () => ({}),
};

// ── Names ───────────────────────────────────────────────────────────────

// The attempt's database: [main]'s pattern (app_<slug>_staging_s<sid>_<6
// hex>), so [main]'s orphan sweep can still collect it after a rollback,
// with a tag only this instance gives out.
export function attemptDb(slug: string, sessionId: number, seed: number, n: number): string {
  const tag = createHash('sha256').update(`preview:${sessionId}:${seed}:${n}`).digest('hex').slice(0, 6);
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_s${sessionId}_${tag}`;
}
// db-manager.stagingDbName, for a preview [main] built.
const legacyDb = (slug: string, sessionId: number, head: string) =>
  `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_s${sessionId}_${head.slice(0, 6)}`;

// ── Copy ────────────────────────────────────────────────────────────────

const TRIGGERS = new Map([
  ['manual', 'manual-recheck'], ['testing-update', 'manual-recheck'], ['shots-update', 'manual-recheck'],
  ['promote', 'promote-kick'], ['stale-vote', 'promote-kick'],
]);
const recheckTrigger = (reason: string, trigger: string | null) => trigger || TRIGGERS.get(reason) || 'manual-recheck';

// ── Outcomes ────────────────────────────────────────────────────────────

export interface Deps {
  maxRetries: number;        // staging-recovery.checkMaxAutoRetries()
  retireAfterMs: number;     // a cancelled prepare has stopped by then (its lease)
  notifiers: Record<string, (n: any) => void | Promise<void>>;
}

interface Step {
  name: Name;
  data: Data;
  writes?: DomainWrite[];
  work?: WorkRequest[];
  cancel?: WorkRef[];
  notify?: Notification[];
  timer?: TimerRequest | null;
}
const step = (s: Step): Outcome<PState> =>
  ({ next: { name: s.name, data: s.data }, writes: s.writes, work: s.work, cancel: s.cancel, notify: s.notify, timer: s.timer });

const prepareKey = (n: number) => `prepare:${n}`;
const retireAttemptKey = (n: number) => `retire-attempt:${n}`;

// The backoff of the error lane: 2 min doubling to 30 (storeChecks' own).
const retryDelayMs = (streakBefore: number) => Math.min(120 * 2 ** streakBefore, 1800) * 1000;

// What a newer step makes obsolete: the attempt being prepared (retired
// once its handler has stopped) and the check run.
function obsolete(d: Data, ctx: TransitionContext, deps: Deps): { cancel: WorkRef[]; work: WorkRequest[]; retiring: Attempt[] } {
  const cancel: WorkRef[] = [];
  const work: WorkRequest[] = [];
  const retiring = [...d.retiring];
  if (d.preparing) {
    cancel.push({ kind: WORK.prepare, key: prepareKey(d.preparing.n) });
    retiring.push(d.preparing);
    work.push(retireWork(d, d.preparing, new Date(ctx.now.getTime() + deps.retireAfterMs)));
  }
  if (d.run) {
    cancel.push({ kind: WORK.run, key: d.run.key });
    work.push({ kind: WORK.cancel, key: `cancel:${d.run.key}`, input: { sessionId: d.sessionId, runId: d.run.key } });
  }
  return { cancel, work, retiring };
}

const retireWork = (d: Data, a: Attempt, notBefore?: Date): WorkRequest => ({
  kind: WORK.retireAttempt, key: retireAttemptKey(a.n),
  input: { sessionId: d.sessionId, appId: d.appId, appSlug: d.appSlug, n: a.n, db: a.db },
  ...(notBefore ? { notBefore } : {}),
});

const pendingWrite = (d: Data, head: string, phase: 'building' | 'testing', trigger: string | null): DomainWrite =>
  ({ type: 'pending', sessionId: d.sessionId, head, phase, trigger });
const pendingNote = (d: Data, head: string, phase: string, trigger: string | null): Notification =>
  ({ type: 'checksPending', sessionId: d.sessionId, head, phase, trigger });

// Prepare attempt n+1 of `head`. What serves keeps serving until it is ready.
function begin(e: Event<any>, s: Live, head: string, trigger: string | null, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const d0 = s.data;
  const old = obsolete(d0, ctx, deps);
  const n = d0.last + 1;
  const attempt: Attempt = { n, head, db: attemptDb(d0.appSlug, d0.sessionId, d0.seed, n) };
  const sameHead = d0.head === head;
  const d: Data = {
    ...d0, head, trigger, last: n, preparing: attempt, run: null, verdict: null,
    failure: sameHead ? d0.failure : null, streak: sameHead ? d0.streak : 0, retiring: old.retiring, exit: null, pending: null,
  };
  return step({
    name: 'preparing', data: d,
    cancel: old.cancel,
    writes: [pendingWrite(d, head, 'building', trigger)],
    work: [...old.work, { kind: WORK.prepare, key: prepareKey(n), input: {
      sessionId: d.sessionId, appId: d.appId, n, head, db: attempt.db, trigger,
      serving: d.serving ? { n: d.serving.n, head: d.serving.head, runtimeName: d.serving.runtimeName } : null,
    } }],
    notify: [pendingNote(d, head, 'building', trigger)],
    timer: null,
  });
}

// Start a check run against the serving attempt.
function startRun(s: Live, trigger: string | null, ctx: TransitionContext, extra: { work?: WorkRequest[]; data?: Partial<Data> } = {}): Outcome<PState> {
  const d0 = { ...s.data, ...(extra.data || {}) };
  const served = d0.serving!;
  const key = `run-${served.n}-${ctx.version + 1}`;   // a Kubernetes label value (the Jobs carry it)
  const d: Data = { ...d0, trigger, run: { key, n: served.n, head: served.head }, verdict: null };
  return step({
    name: 'checking', data: d,
    writes: [pendingWrite(d, served.head, 'testing', trigger)],
    work: [...(extra.work || []), { kind: WORK.run, key, input: {
      sessionId: d.sessionId, appId: d.appId, n: served.n, head: served.head, runId: key, trigger,
      runtimeName: served.runtimeName, runtimeKind: served.runtimeKind, url: served.url,
    } }],
    notify: [pendingNote(d, served.head, 'testing', trigger)],
    timer: null,
  });
}

// The error lane: an 'error' on this head runs again on its own, from a
// row in its scope, while the streak is under the cap.
function errorTimer(d: Data, f: Facts, deps: Deps, ctx: TransitionContext, streakBefore: number): TimerRequest | null {
  if (!f.session?.retryScope || d.streak >= deps.maxRetries) return null;
  return { at: new Date(ctx.now.getTime() + retryDelayMs(streakBefore)), event: { type: 'RetryDue' } };
}

// ── Adoption ────────────────────────────────────────────────────────────

// A session's first event under the flag: the instance starts from what its
// row says, so a preview [main] built is known (and retired by identity
// once a newer attempt serves) and its verdict is kept.
function adopt(e: Event<any>, f: Facts, prior: Data | null): Data {
  const s = f.session!;
  const st = s.staging;
  const serving: Served | null = st.url && st.runtimeName && st.commitSha ? {
    n: 0, head: st.commitSha, db: legacyDb(f.app!.slug, s.id, st.commitSha), url: st.url,
    runtimeKind: st.runtimeKind || 'docker', runtimeName: st.runtimeName, containerId: st.containerId,
    imageRef: st.imageRef, buildRef: st.buildRef,
  } : null;
  return {
    sessionId: s.id, appId: s.appId, appSlug: f.app!.slug, seed: prior?.seed ?? e.id,
    head: serving?.head ?? s.checks.commitSha, trigger: null, last: prior?.last ?? 0,
    preparing: null, serving, run: null, verdict: null, failure: null, streak: 0,
    episode: prior?.episode ?? 0, retiring: [], exit: null, pending: null, closedAt: null,
  };
}

// Where an adopted row stands for `head`: its verdict if the preview serves
// that head, else a new attempt.
function fromRow(e: Event<any>, d: Data, f: Facts, head: string, trigger: string | null, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const live: Live = { name: 'idle', data: d };
  if (!d.serving || d.serving.head !== head) return begin(e, live, head, trigger, ctx, deps);
  const checks = f.session!.checks;
  const verdict = checks.commitSha === head ? checks.state : null;
  if (verdict === 'passing' || verdict === 'failing' || verdict === 'skipped') {
    return step({ name: 'settled', data: { ...d, head, verdict }, timer: null });
  }
  return startRun({ name: 'settled', data: { ...d, head } }, trigger, ctx);
}

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
  if (s.name === 'checking' || s.name === 'settled' || s.name === 'deferred') return d.head === head && d.serving?.head === head;
  return false;
}

// ── Transitions ─────────────────────────────────────────────────────────

type Entry = { guard?: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => Check;
  to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<PState> } | { ignore: string };

function transitions(deps: Deps): Record<string, Record<string, Entry>> {
  const revision: Entry = {
    guard: (s, e, f, ctx) => {
      const c = admissible(f, e.payload.head, ctx, e.payload.sessionId);
      if (c !== true) return c;
      return s.name !== NONE && s.name !== 'detached' && sameHead(s, e.payload.head) ? reject('same_head') : ok();
    },
    to: (s, e, f, ctx) => {
      if (s.name === NONE || s.name === 'detached') {
        return fromRow(e, adopt(e, f, s.name === 'detached' ? s.data : null), f, e.payload.head, e.payload.trigger, ctx, deps);
      }
      return begin(e, s, e.payload.head, e.payload.trigger, ctx, deps);
    },
  };

  // Ensure: a preview of the head, built if nothing serves it. Deploy and a
  // stale environment: a new attempt of the head, whatever serves.
  const request: Entry = {
    guard: (s, e, f, ctx) => {
      const c = admissible(f, e.payload.head, ctx, e.payload.sessionId);
      if (c !== true) return c;
      if (s.name === 'preparing' || s.name === 'checking') return reject('in_progress');
      if (e.payload.reason === 'deploy' && (f.session!.isHeadless || !['active', 'promoted'].includes(f.session!.status))) {
        return reject('not_deployable');
      }
      if (e.payload.reason === 'ensure' && s.name !== NONE && s.name !== 'detached'
          && s.data.serving?.head === e.payload.head && s.data.head === e.payload.head) return reject('already_serving');
      return ok();
    },
    to: (s, e, f, ctx) => {
      const trigger = e.payload.reason === 'env_stale' ? 'stuck-sweep' : null;
      if (s.name === NONE || s.name === 'detached') {
        const d = adopt(e, f, s.name === 'detached' ? s.data : null);
        if (e.payload.reason === 'ensure') return fromRow(e, d, f, e.payload.head, trigger, ctx, deps);
        return begin(e, { name: 'idle', data: d }, e.payload.head, trigger, ctx, deps);
      }
      return begin(e, s, e.payload.head, trigger, ctx, deps);
    },
  };

  const recheck: Entry = {
    guard: (s) => (s.data.head ? ok() : reject('no_head')),
    to: (s, e, f, ctx) => {
      const trigger = recheckTrigger(e.payload.reason, e.payload.trigger);
      const d: Data = s.data;
      // Nothing serves the head: build it.
      if (!d.serving || d.serving.head !== d.head) return begin(e, s, d.head!, trigger, ctx, deps);
      return startRun(s, trigger, ctx);
    },
  };

  const lost: Entry = {
    guard: (s, e) => (s.data.serving?.n === e.payload.attempt ? ok() : reject('not_serving')),
    to: (s, e, f, ctx) => begin(e, s, s.data.head || s.data.serving.head, 'stuck-sweep', ctx, deps),
  };

  // Exit (archive, merge, included, app deletion) is terminal; idle,
  // pressure and a stale environment free the preview and the instance
  // waits for the next revision.
  const retire: Entry = {
    guard: (s, e, f) => {
      if (e.payload.terminal) return ok();
      if (s.name === 'preparing' || s.name === 'checking') return reject('busy');
      if (f.session && ['promoted', 'merging'].includes(f.session.status)) return reject('under_review');
      return ok();
    },
    to: (s, e, f, ctx) => toRetiring(s, e.payload.reason, e.payload.terminal, ctx, deps),
  };
  const adminRetire: Entry = { to: (s, e, f, ctx) => toRetiring(s, 'admin', true, ctx, deps) };

  const detach: Entry = {
    to: (s: Live) => {
      const d = s.data;
      const cancel: WorkRef[] = [
        ...(d.preparing ? [{ kind: WORK.prepare, key: prepareKey(d.preparing.n) }] : []),
        ...(d.run ? [{ kind: WORK.run, key: d.run.key }] : []),
        ...d.retiring.map((a) => ({ kind: WORK.retireAttempt, key: retireAttemptKey(a.n) })),
        ...(d.exit ? [{ kind: WORK.retire, key: d.exit.key }] : []),
      ];
      return step({ name: 'detached', data: { ...d, preparing: null, run: null, retiring: [], exit: null, pending: null }, cancel, timer: null });
    },
  };

  const retryDue: Entry = {
    guard: (s, e, f) => (f.session?.retryScope ? ok() : reject('out_of_scope')),
    to: (s, e, f, ctx) => (s.name === 'failed' || !s.data.serving || s.data.serving.head !== s.data.head
      ? begin(e, s, s.data.head, 'stuck-sweep', ctx, deps)
      : startRun(s, 'stuck-sweep', ctx)),
  };
  const adminRetry: Entry = {
    to: (s, e, f, ctx) => {
      if (s.name === 'retiring') return toRetiring(s, s.data.exit.reason, s.data.exit.terminal, ctx, deps);
      if (!s.data.head) return step({ name: s.name, data: s.data });
      return s.name === 'failed' || !s.data.serving || s.data.serving.head !== s.data.head
        ? begin(e, s, s.data.head, 'manual-recheck', ctx, deps)
        : startRun(s, 'manual-recheck', ctx);
    },
  };

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
    },
    idle: {
      ...created,
      RecheckRequested: recheck,
      ConflictResolved: notHere('not_deferred'),
      PreviewLost: notHere('not_serving'),
      RetireRequested: { guard: (s, e) => (e.payload.terminal ? ok() : reject('already_idle')), to: retire.to },
      Detach: detach, AdminRetry: adminRetry, AdminRetire: adminRetire,
      RetryDue: notHere('not_waiting'),
      ...works('idle'),
    },
    preparing: {
      ...created,
      RecheckRequested: notHere('run_outstanding'),
      ConflictResolved: notHere('not_deferred'),
      PreviewLost: notHere('preparing'),
      RetireRequested: retire,
      Detach: detach, AdminRetry: notHere('in_progress'), AdminRetire: adminRetire,
      RetryDue: notHere('not_waiting'),
      ...works('preparing'),
    },
    checking: {
      ...created,
      RecheckRequested: notHere('run_outstanding'),
      ConflictResolved: notHere('not_deferred'),
      PreviewLost: lost,
      RetireRequested: retire,
      Detach: detach, AdminRetry: notHere('in_progress'), AdminRetire: adminRetire,
      RetryDue: notHere('not_waiting'),
      ...works('checking'),
    },
    deferred: {
      ...created,
      RecheckRequested: recheck,
      ConflictResolved: {
        guard: (s, e) => (e.payload.head === s.data.head ? ok() : reject('not_deferred_head')),
        to: (s, e, f, ctx) => startRun(s, 'conflict-resolved', ctx),
      },
      PreviewLost: lost,
      RetireRequested: retire,
      Detach: detach, AdminRetry: adminRetry, AdminRetire: adminRetire,
      RetryDue: notHere('not_waiting'),
      ...works('deferred'),
    },
    settled: {
      ...created,
      RecheckRequested: recheck,
      ConflictResolved: notHere('not_deferred'),
      PreviewLost: lost,
      RetireRequested: retire,
      Detach: detach, AdminRetry: adminRetry, AdminRetire: adminRetire,
      RetryDue: { guard: (s, e, f) => (s.data.verdict !== 'error' ? reject('not_error') : (retryDue.guard as any)(s, e, f)), to: retryDue.to },
      ...works('settled'),
    },
    failed: {
      ...created,
      RecheckRequested: recheck,
      ConflictResolved: notHere('not_deferred'),
      PreviewLost: lost,
      RetireRequested: retire,
      Detach: detach, AdminRetry: adminRetry, AdminRetire: adminRetire,
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
      PreviewRequested: notHere('retiring'),
      RecheckRequested: notHere('retiring'),
      ConflictResolved: notHere('retiring'),
      PreviewLost: notHere('retiring'),
      RetireRequested: {
        guard: (s, e) => (e.payload.terminal && !s.data.exit.terminal ? ok() : reject('already_retiring')),
        to: (s, e) => step({ name: 'retiring', data: { ...s.data, exit: { ...s.data.exit, reason: e.payload.reason, terminal: true }, pending: null } }),
      },
      Detach: detach,
      AdminRetry: { guard: (s) => (s.data.exit.failed ? ok() : reject('in_progress')), to: adminRetry.to },
      AdminRetire: notHere('already_retiring'),
      RetryDue: notHere('not_waiting'),
      ...works('retiring'),
    },
    retired: {
      '*': notHere('retired'),
      ...works('retired'),
    },
    detached: {
      ...created,
      RecheckRequested: notHere('detached'),
      ConflictResolved: notHere('detached'),
      PreviewLost: notHere('detached'),
      RetireRequested: notHere('detached'),
      Detach: notHere('detached'),
      AdminRetry: notHere('detached'),
      AdminRetire: notHere('detached'),
      RetryDue: notHere('detached'),
      ...works('detached'),
    },
  };
}

// Retire everything this instance created: the serving attempt, the one
// being prepared, and those still waiting for their own retirement (whose
// items are cancelled: this one covers them).
function toRetiring(s: Live, reason: string, terminal: boolean, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const d0 = s.data;
  const old = obsolete(d0, ctx, deps);
  const attempts = new Map<number, Attempt>();
  for (const a of [...(d0.serving ? [d0.serving] : []), ...old.retiring]) attempts.set(a.n, { n: a.n, head: a.head, db: a.db });
  const key = `retire:${ctx.version + 1}`;
  const d: Data = { ...d0, preparing: null, run: null, retiring: [], exit: { reason, terminal, key }, pending: null };
  return step({
    name: 'retiring', data: d,
    cancel: [...old.cancel, ...d0.retiring.map((a) => ({ kind: WORK.retireAttempt, key: retireAttemptKey(a.n) }))],
    writes: [{ type: 'unpublished', sessionId: d.sessionId }],
    work: [...old.work.filter((w) => w.kind !== WORK.retireAttempt), { kind: WORK.retire, key, input: {
      sessionId: d.sessionId, appId: d.appId, appSlug: d.appSlug, attempts: [...attempts.values()] as unknown as Json,
      runtimeName: d0.serving?.runtimeName ?? null, runtimeKind: d0.serving?.runtimeKind ?? null,
      // A prepare cancelled just now may still create something until its
      // handler stops: the close checks again after that.
      closeAfter: new Date(ctx.now.getTime() + deps.retireAfterMs).toISOString(),
    } }],
    timer: null,
  });
}

// ── Work results ────────────────────────────────────────────────────────

interface PrepareResult {
  ok: boolean;
  url?: string; runtimeKind?: string; runtimeName?: string; containerId?: string | null;
  imageRef?: string | null; buildRef?: string | null;
  // A failure: the reason for the card, and what to tell the author.
  detail?: string; infrastructure?: boolean; aboutMain?: string | null; sync?: boolean;
  servingRemoved?: boolean;     // Docker removes the old container before it runs the new one
}

export interface RunResult {
  outcome: 'verdict' | 'deferred' | 'blocked';
  state?: Verdict;
  results?: Json;              // test_results rows
  errorDetail?: string | null;
  console?: Json;               // { state, errors }
  history?: Json;               // app_check_history rows (verdicts other than error)
  capture?: { state: string; detail: Json } | null;
  visuals?: boolean;            // artifacts were stored for this head
  reason?: string;              // blocked
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
      const retiring = p.kind === WORK.retireAttempt ? d.retiring.filter((a) => retireAttemptKey(a.n) !== p.workKey) : d.retiring;
      return step({ name, data: { ...d, retiring } });
    },
  };
}

function prepared(s: Live, e: Event<WorkResultPayload>, outcome: string, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const d0 = s.data;
  const attempt = d0.preparing!;
  const r = (outcome === 'succeeded' ? e.payload.result : null) as PrepareResult | null;
  if (r?.ok) {
    const served: Served = {
      ...attempt, url: String(r.url), runtimeKind: String(r.runtimeKind), runtimeName: String(r.runtimeName),
      containerId: r.containerId ?? null, imageRef: r.imageRef ?? null, buildRef: r.buildRef ?? null,
    };
    const previous = d0.serving && d0.serving.n !== served.n ? d0.serving : null;
    const d: Data = { ...d0, preparing: null, serving: served, retiring: previous ? [...d0.retiring, previous] : d0.retiring };
    return withPublication(startRun({ name: 'preparing', data: d }, d0.trigger, ctx, { work: [
      ...(previous ? [retireWork(d, previous)] : []),
      { kind: WORK.startShots, key: `start-shots:${served.n}`, input: { sessionId: d.sessionId, head: served.head } },
    ] }), d, served);
  }
  // The attempt failed: what serves keeps serving (on Docker it was
  // removed first). The attempt's own resources are retired.
  const detail = r?.detail || e.payload.error?.message || 'The preview could not be prepared';
  const infrastructure = !!r?.infrastructure;
  const servingRemoved = !!r?.servingRemoved;
  const streakBefore = d0.streak;
  const d: Data = {
    ...d0, preparing: null, verdict: 'error', failure: detail, streak: streakBefore + 1,
    serving: servingRemoved ? null : d0.serving, retiring: [...d0.retiring, attempt],
  };
  const writes: DomainWrite[] = [{
    type: 'prepareFailed', eventId: e.id, sessionId: d.sessionId, appId: d.appId, head: attempt.head, detail,
    infrastructure, aboutMain: r?.aboutMain ?? null, sync: !!r?.sync, source: f.session?.source ?? null,
    prNumber: f.session?.prNumber ?? null,
  }];
  if (servingRemoved && d0.serving) writes.push({ type: 'unpublished', sessionId: d.sessionId });
  const work: WorkRequest[] = [retireWork(d, attempt)];
  if (streakBefore === 0 && !infrastructure) {
    work.push({ kind: WORK.botStopped, key: `bot-stopped:${attempt.n}`, input: { sessionId: d.sessionId } });
  }
  if (servingRemoved && d0.serving) work.push(retireWork(d, d0.serving));
  return step({
    name: 'failed', data: servingRemoved && d0.serving ? { ...d, retiring: [...d.retiring, d0.serving] } : d,
    writes, work,
    notify: [{ type: 'chat', appId: d.appId, eventId: e.id }, { type: 'checksReady', sessionId: d.sessionId, head: attempt.head, state: 'error' }],
    timer: errorTimer(d, f, deps, ctx, streakBefore),
  });
}

// The publication and its announcement ride the transition into checking.
function withPublication(o: Outcome<PState>, d: Data, served: Served): Outcome<PState> {
  return {
    ...o,
    writes: [{ type: 'published', sessionId: d.sessionId, served: served as unknown as Json }, ...(o.writes || [])],
    notify: [{ type: 'stagingReady', sessionId: d.sessionId, url: served.url, head: served.head }, ...(o.notify || [])],
  };
}

function ran(s: Live, e: Event<WorkResultPayload>, outcome: string, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const d0 = s.data;
  const run = d0.run!;
  const r = (outcome === 'succeeded' ? e.payload.result : null) as RunResult | null;
  const base = { sessionId: d0.sessionId, appId: d0.appId, head: run.head, runId: run.key };
  if (r?.outcome === 'deferred') {
    const d: Data = { ...d0, run: null, episode: d0.episode + 1 };
    return step({
      name: 'deferred', data: d,
      writes: [{ type: 'deferred', ...base, capture: (r.capture ?? null) as Json }],
      work: [
        { kind: WORK.publish, key: `publish:${run.key}`, input: { ...base, visuals: !!r.visuals } },
        { kind: WORK.scheduleShots, key: `schedule-shots:${run.key}`, input: { ...base, trigger: d0.trigger } },
      ],
      notify: [pendingNote(d, run.head, 'deferred', d0.trigger), ...(r.visuals ? [{ type: 'visualsReady', ...base }] : [])],
      timer: null,
    });
  }
  // A verdict, or what stands for one when the run could not say (P-D7).
  const blocked = !r || r.outcome !== 'verdict';
  const state: Verdict = blocked ? 'error' : r!.state!;
  const detail = blocked
    ? (r?.reason || (outcome === 'succeeded' ? 'The checks run produced no result' : 'The checks run was lost before it finished'))
    : (r!.errorDetail ?? null);
  const streakBefore = d0.streak;
  const d: Data = {
    ...d0, run: null, verdict: state, failure: state === 'error' ? detail : null,
    streak: state === 'error' ? streakBefore + 1 : 0,
  };
  const settle = {
    type: 'settled', ...base, state, detail,
    results: blocked ? [] : (r!.results ?? []), console: blocked ? null : (r!.console ?? null),
    history: state === 'error' || blocked ? [] : (r!.history ?? []), capture: blocked ? null : (r!.capture ?? null),
  };
  const notify: Notification[] = [{ type: 'checksReady', ...base, state }];
  if (r?.visuals) notify.push({ type: 'visualsReady', ...base });
  if (state === 'passing' || state === 'skipped') notify.push({ type: 'mergeKick', ...base, state });
  return step({
    name: 'settled', data: d,
    writes: [settle],
    work: [
      { kind: WORK.publish, key: `publish:${run.key}`, input: { ...base, visuals: !!r?.visuals } },
      { kind: WORK.botNote, key: `bot-note:${run.key}`, input: { ...base, state } },
      { kind: WORK.scheduleShots, key: `schedule-shots:${run.key}`, input: { ...base, trigger: d0.trigger } },
    ],
    notify,
    timer: state === 'error' ? errorTimer(d, f, deps, ctx, streakBefore) : null,
  });
}

function retired(s: Live, e: Event<WorkResultPayload>, outcome: string, ctx: TransitionContext, deps: Deps): Outcome<PState> {
  const d0 = s.data;
  const closed = outcome === 'succeeded' && (e.payload.result as any)?.closed === true;
  if (!closed) {
    // Exhausted or not closed: an admin retries it (Admin → Workflows).
    return step({ name: 'retiring', data: { ...d0, exit: { ...d0.exit!, failed: e.payload.error?.message || 'not closed' } } });
  }
  const d: Data = { ...d0, serving: null, preparing: null, run: null, exit: null };
  if (d0.exit!.terminal) return step({ name: 'retired', data: { ...d, pending: null, closedAt: ctx.now.toISOString() } });
  if (d0.pending) return begin(e, { name: 'idle', data: { ...d, pending: null } }, d0.pending.head, d0.pending.trigger, ctx, deps);
  return step({ name: 'idle', data: { ...d, pending: null } });
}

// ── The machine ─────────────────────────────────────────────────────────

const PRODUCERS = new Set(['route', 'system']);

export function preview(deps: Deps): Machine<PState, Facts> {
  for (const n of NOTIFIERS) if (typeof deps.notifiers[n] !== 'function') throw new Error(`preview: notifier ${n} missing`);
  const produced = (e: Event<any>): Check => (PRODUCERS.has(e.source.kind) ? ok() : reject('not_a_producer'));
  const system = (e: Event<any>): Check => (e.source.kind === 'system' || e.source.kind === 'message' ? ok() : reject('internal_only'));
  const admin = (e: Event<any>): Check => (e.source.kind === 'admin' ? ok() : reject('admin_only'));
  const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));

  return defineMachine<PState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['RevisionSubmitted', 'PreviewRequested'],
    terminal: ['retired'],
    decode: (row) => ({ name: row.state, data: row.data } as PState),
    facts: (tx, state, event) => {
      const id = state.name === NONE ? Number((event.payload as any)?.sessionId) : (state.data as Data).sessionId;
      return Number.isInteger(id) && id > 0 ? readFacts(tx, id) : Promise.resolve({ session: null, app: null });
    },
    authorize: {
      RevisionSubmitted: produced,
      PreviewRequested: produced,
      RecheckRequested: (e) => (PRODUCERS.has(e.source.kind) || e.source.kind === 'admin' ? ok() : reject('not_a_producer')),
      ConflictResolved: system,
      PreviewLost: system,
      RetireRequested: system,
      Detach: system,
      AdminRetry: admin,
      AdminRetire: admin,
      RetryDue: timer,
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
    notifiers: deps.notifiers,
  });
}

// ── Domain writes ───────────────────────────────────────────────────────

// The thread line of a failure, marked with its event for the chat notifier.
async function failureLine(tx: Tx, w: any, body: string, detail: string) {
  if (w.source === 'imported') {
    await tx.query(
      `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
       VALUES ($1, $2, 'system', $3, 'session', $4)`,
      [w.appId, body, JSON.stringify({ checkError: true, detail, prNumber: w.prNumber, wfEvent: w.eventId }), w.sessionId]);
  } else {
    await tx.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'system', $2, $3)`,
      [w.sessionId, body, JSON.stringify({ checkError: true, detail })]);
  }
}

const WRITES = {
  // checks_commit_sha, 'pending', the phase and the trigger (visuals.setChecksPending).
  pending: (tx: Tx, w: any) => legacy('services/visuals').setChecksPending(tx, w.sessionId, w.head, w.phase, w.trigger),

  // The prepare's receipt, in one statement (P-C3).
  published: (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions SET staging_url = $2, staging_container_id = $3, staging_image_ref = $4, staging_build_ref = $5,
            staging_runtime_kind = $6, staging_runtime_name = $7, staging_commit_sha = $8
      WHERE id = $1`,
    [w.sessionId, w.served.url, w.served.containerId, w.served.imageRef, w.served.buildRef,
      w.served.runtimeKind, w.served.runtimeName, w.served.head]),

  unpublished: (tx: Tx, w: any) => tx.query(
    `UPDATE chat_sessions SET staging_url = NULL, staging_container_id = NULL, staging_image_ref = NULL,
            staging_build_ref = NULL, staging_runtime_kind = NULL, staging_runtime_name = NULL, staging_commit_sha = NULL
      WHERE id = $1`, [w.sessionId]),

  // The head's 'error', the failure streak, and the author's note once per
  // streak (check_error_notified_at), unless the cause is infrastructure.
  async prepareFailed(tx: Tx, w: any) {
    await legacy('services/visuals').storeChecks(tx, w.sessionId, w.head, { state: 'error', results: [] }, w.detail);
    if (w.infrastructure) return;
    const { rows: [first] } = await tx.query(
      `UPDATE chat_sessions SET check_error_notified_at = NOW()
        WHERE id = $1 AND check_error_notified_at IS NULL AND checks_commit_sha IS NOT DISTINCT FROM $2::text
        RETURNING id`, [w.sessionId, w.head]);
    if (!first) return;
    const body = w.sync
      ? `⚠️ Staging preview failed to start. ${w.aboutMain} Reason: ${w.detail}`
      : `⚠️ Staging preview failed to start, so automated checks can't run and this proposal can't merge yet.${w.aboutMain ? ` ${w.aboutMain}` : ''} Reason: ${w.detail}`;
    await failureLine(tx, w, body, w.detail);
  },

  // A run's settlement, together (P-D4): verdict and test_results, console,
  // capture outcome, and the app's check history (counted once per run,
  // rows in check_key order so two settlements of one app lock alike).
  async settled(tx: Tx, w: any) {
    const visuals = legacy('services/visuals');
    const stored = await visuals.storeChecks(tx, w.sessionId, w.head, { state: w.state, results: w.results }, w.detail);
    if (!stored) return;
    if (w.console) await visuals.storeConsoleCheck(tx, w.sessionId, w.console, w.head);
    if (w.capture) await visuals.storeCaptureOutcome(tx, w.sessionId, w.capture.state, w.capture.detail);
    const history = [...(w.history || [])].sort((a: any, b: any) => String(a.checkKey).localeCompare(String(b.checkKey)));
    if (history.length) await legacy('services/check-history').recordRun(tx, w.appId, history);
  },

  // A promoted head that conflicts with main: previewed, verdict deferred.
  async deferred(tx: Tx, w: any) {
    const visuals = legacy('services/visuals');
    await visuals.storeChecksDeferred(tx, w.sessionId, w.head, 'Checks wait until this proposal merges cleanly with main');
    if (w.capture) await visuals.storeCaptureOutcome(tx, w.sessionId, w.capture.state, w.capture.detail);
  },
};
