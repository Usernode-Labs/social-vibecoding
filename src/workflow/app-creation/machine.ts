// app-creation: a new project being made. One instance per project, enrolled
// when its row is inserted (the apps_wf_enrol_creation trigger), whichever
// door it came through: Make it, an import, a ready-made app, a remix, the
// bench studio's host.
//
// Its setup is one resumable work item (app.setup): the database, the card,
// the repository and its first commit, each a step a restart carries on
// from, never done twice. Then its first deploy is asked of app delivery
// (src/workflow/app-delivery/), which runs every production deploy, one at a
// time per app: there is one deploy path. Its first request, when it was made
// with a description, is filed beside that deploy (app.firstRequest), once.
//
// Every status a person sees while it is made is written here, under the
// instance: creating (a Retry), running, awaiting_secrets, error. A late
// answer of a setup that was given up is refused as stale.
//
// One deadline: its time limit. Past it, a setup still running is cancelled
// and the project reads failed as interrupted (Retry is free); a deploy still
// to come makes it run when it does.
//
// workflow-foundation's design-step3-app-fleet.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, Machine, MessageRequest, Outcome, Push, TransitionContext, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { MACHINE as DELIVERY, appKey as deliveryKey } from '../app-delivery/machine.ts';
import { appStatus, creationPhase } from '../pushes.ts';
import { readFacts } from './facts.ts';
import { combine } from './timing.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'app-creation';
export const creationKey = (appId: number) => `app:${appId}`;
export const WORK = Object.freeze({ setup: 'app.setup', firstRequest: 'app.firstRequest' });

const SEC = 1000;
const MIN = 60 * SEC;
// How long a project may take from its setup's start to its first deploy's
// answer before it reads failed (Retry is free).
export const TIME_LIMIT_MS = 15 * MIN;
// A row an older build is still making: looked at again this often, until
// its owner's heartbeat has lapsed.
export const RECHECK_MS = 30 * SEC;
// A first deploy app delivery does not hold (an older build's app delivery
// refused the ask during a rollout) is asked again this often, within the
// time limit.
export const REASK_MS = 2 * MIN;
// The owner column's value that says the workflow makes it: an older build's
// sweep never takes such a row.
export const WORKFLOW_OWNER = 'workflow';

type Name = 'waiting' | 'setting_up' | 'deploying' | 'running' | 'awaiting_secrets' | 'failed';
export interface Data {
  appId: number;
  appSlug: string;
  attempt: number;                // its setup's number (app.setup's key)
  startedAt: string | null;       // this attempt's start
  deadline: string | null;        // its time limit
  sha: string | null;             // the first commit, once set up
  timing: Json;                   // what the setup measured
  timedOut?: boolean;
  ask?: Json;                     // its first deploy's request (asked again if app delivery lost it)
  askedAt?: string | null;
}
export type CState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<CState, { data: Data }>;

// ── Events ──────────────────────────────────────────────────────────────

const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const appOnly = (p: any) => ({ appId: int(p?.appId, 'appId') });

const EVENTS = {
  // The row was inserted (the trigger).
  Started: appOnly,
  // A row an older build was making when this release started (the
  // release's adoption): made here once its owner has let it go.
  Adopted: appOnly,
  // A person asks again for a project whose making failed (the route,
  // after its permission and count checks). `counted`: it counts toward
  // the retry limit (an interrupted one does not).
  Retry: (p: any) => ({ appId: int(p?.appId, 'appId'), counted: p?.counted !== false }),
  // A first request the project is owed that nothing files (an older
  // build left it open: the release's adoption).
  FirstRequestOwed: appOnly,
  // Its time limit, and the recheck of a row an older build makes.
  TimedOut: () => ({}),
  Recheck: () => ({}),
  // app delivery's answer to its first deploy.
  Delivered: (p: any) => ({ sha: typeof p?.sha === 'string' ? p.sha : null, url: typeof p?.url === 'string' ? p.url : null,
    timing: (p?.timing && typeof p.timing === 'object' ? p.timing : null) as Json }),
  DeliveryFailed: (p: any) => ({ message: typeof p?.message === 'string' ? p.message : 'the deploy failed',
    missingSecrets: Array.isArray(p?.missingSecrets) ? p.missingSecrets.map(String) : null }),
};

// ── Outcomes ────────────────────────────────────────────────────────────

const timer = (at: Date, type: string) => ({ at, event: { type } });

// A setup, from where the row is: a new attempt of the work, under the time
// limit. The row is the workflow's from here (its owner column says so).
function setUp(d: Data, ctx: TransitionContext, writes: any[] = []): Outcome<CState> {
  const attempt = d.attempt + 1;
  const deadline = new Date(ctx.now.getTime() + TIME_LIMIT_MS);
  const work: WorkRequest[] = [{ kind: WORK.setup, key: `setup:${attempt}`, input: { appId: d.appId, attempt } }];
  return {
    next: { name: 'setting_up', data: { ...d, attempt, startedAt: ctx.now.toISOString(), deadline: deadline.toISOString(), sha: null, timing: null, timedOut: false } },
    work, writes: [{ type: 'claim', appId: d.appId }, ...writes], timer: timer(deadline, 'TimedOut'),
    push: [creationPhase({ appId: d.appId, appSlug: d.appSlug, phase: 'database' })],
  };
}

const fresh = (f: Facts): Data => ({
  appId: f.app!.id, appSlug: f.app!.slug, attempt: 0, startedAt: null, deadline: null, sha: null, timing: null,
});

// The project failed to be made: the row says so, with what failed.
function failedWith(d: Data, failure: Json, errorReason: string | null, ctx: TransitionContext, x: { cancel?: boolean } = {}): Outcome<CState> {
  return {
    next: { name: 'failed', data: d },
    writes: [{ type: 'failed', appId: d.appId, failure, timing: timingOf(d, null, 'error', ctx) }],
    push: [appStatus({ appId: d.appId, appSlug: d.appSlug, status: 'error', errorReason })],
    timer: null,
    ...(x.cancel ? { cancel: [{ kind: WORK.setup, key: `setup:${d.attempt}` }] } : {}),
  };
}

// What this attempt measured, for creation's timing (services/
// app-creation-timing.js): the setup's stages and the first deploy's.
const timingOf = (d: Data, deploy: Json, outcome: string, ctx: TransitionContext): Json =>
  (d.startedAt ? { setup: d.timing ?? null, deploy: deploy ?? null, outcome,
    totalMs: Math.max(0, ctx.now.getTime() - Date.parse(d.startedAt)) } : null);

// The setup ended. Set up: the first deploy is asked of app delivery, and
// the first request (one was described) filed beside it. Its own failure
// is the row's.
function setUpEnded(s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  const d = s.data;
  const result = (e.payload.result ?? {}) as { failed?: Json; reason?: string; sha?: string | null; offer?: Json; timing?: Json };
  if (e.type !== 'WorkSucceeded' || result.failed) {
    // Its processes kept going away under it: the platform's doing, not the
    // project's (a free Retry).
    const interrupted = e.payload.error?.code === 'lease_lost';
    const failure = result.failed ?? (interrupted
      ? { synthetic: 'timeout', reason: INTERRUPTED, interrupted: true }
      : { synthetic: 'other', reason: e.payload.error?.message ?? 'Setting it up failed' });
    return failedWith({ ...d, timing: result.timing ?? d.timing }, failure, String((failure as any).reason ?? '') || null, ctx);
  }
  const ask: Json = { appId: d.appId, reason: 'create', ...(result.offer ? { reuse: result.offer } : {}) };
  const next: Data = { ...d, sha: result.sha ?? null, timing: result.timing ?? null, ask, askedAt: ctx.now.toISOString() };
  const work: WorkRequest[] = f.firstRequestOwed ? [{ kind: WORK.firstRequest, key: 'first-request', input: { appId: d.appId } }] : [];
  return { next: { name: 'deploying', data: next }, messages: [askDelivery(next)], work, timer: reaskTimer(next, ctx),
    push: [creationPhase({ appId: d.appId, appSlug: d.appSlug, phase: 'build' })] };
}
const askDelivery = (d: Data): MessageRequest =>
  ({ to: { machine: DELIVERY, key: deliveryKey(d.appId) }, event: { type: 'DeployRequested', payload: d.ask ?? { appId: d.appId, reason: 'create' } } });
// While its first deploy is to come: a look at whether app delivery holds
// it, every REASK_MS, up to the time limit.
const reaskTimer = (d: Data, ctx: TransitionContext) => {
  const limit = d.deadline ? Date.parse(d.deadline) : ctx.now.getTime() + TIME_LIMIT_MS;
  return timer(new Date(Math.min(limit, ctx.now.getTime() + REASK_MS)), 'TimedOut');
};
// App delivery holds its first deploy: the request is open there, or it has
// deployed the app since it was asked.
const deliveryHolds = (d: Data, f: Facts) => !!f.delivery && (f.delivery.asked
  || (!!f.delivery.lastDeployAt && !!d.askedAt && Date.parse(f.delivery.lastDeployAt) >= Date.parse(d.askedAt)));
export const INTERRUPTED = 'App creation was interrupted by a platform restart';
export const TIMED_OUT = `App creation timed out after ${TIME_LIMIT_MS / MIN} minutes`;

// app delivery's answer. Deployed: it runs. Missing keys: it waits for
// them. Anything else: it failed (the row's last_failure is the deploy's).
function delivered(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  const d = s.data;
  const p = e.payload as { sha: string | null; url: string | null; timing: Json };
  return {
    next: { name: 'running', data: { ...d, timedOut: false } },
    // Its timing was recorded when it failed, if it ran late.
    writes: [{ type: 'running', appId: d.appId, timing: s.name === 'failed' ? null : timingOf(d, p.timing, 'running', ctx) }],
    push: [appStatus({ appId: d.appId, appSlug: d.appSlug, status: 'running', url: p.url })],
    timer: null,
  };
}
function deliveryFailed(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  const d = s.data;
  const p = e.payload as { message: string; missingSecrets: string[] | null };
  if (p.missingSecrets?.length) {
    return {
      next: { name: 'awaiting_secrets', data: d },
      writes: [{ type: 'awaiting_secrets', appId: d.appId, sha: d.sha, timing: timingOf(d, null, 'awaiting_secrets', ctx) }],
      push: [appStatus({ appId: d.appId, appSlug: d.appSlug, status: 'awaiting_secrets', missingSecrets: p.missingSecrets })],
      timer: null,
    };
  }
  return failedWith(d, null, f.failureReason ?? p.message, ctx);
}

// Its time limit: a setup still running is given up, and the project reads
// failed as interrupted. A first deploy still to come makes it run when it
// answers.
// Before it, while its first deploy is to come: asked again when app
// delivery does not hold it. A time limit reached with its first deploy
// never taken up is the platform's doing (a free Retry).
function timedOut(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  const d = s.data;
  const held = s.name === 'deploying' && deliveryHolds(d, f);
  if (!d.deadline || Date.parse(d.deadline) > ctx.now.getTime()) {
    if (s.name !== 'deploying') return { next: s, timer: d.deadline ? timer(new Date(d.deadline), 'TimedOut') : null };
    return { next: s, timer: reaskTimer(d, ctx), ...(held ? {} : { messages: [askDelivery(d)] }) };
  }
  const neverTaken = s.name === 'deploying' && !held;
  const reason = neverTaken ? INTERRUPTED : TIMED_OUT;
  const failure: Json = { synthetic: 'timeout', reason, ...(neverTaken ? { interrupted: true } : {}) };
  return failedWith({ ...d, timedOut: true }, failure, reason, ctx, { cancel: s.name === 'setting_up' });
}

// A row an older build makes: waited for until its owner lets it go (its
// heartbeat lapsed), then set up from where it is.
function recheck(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  // The older build finished it (or it is gone): what the row says.
  if (!f.app || f.app.status !== 'creating') {
    const done: Name = f.app?.status === 'running' ? 'running' : f.app?.status === 'awaiting_secrets' ? 'awaiting_secrets' : 'failed';
    return { next: { name: done, data: s.data }, timer: null };
  }
  if (f.ownedElsewhere) return { next: s, timer: timer(new Date(ctx.now.getTime() + RECHECK_MS), 'Recheck') };
  return setUp(s.data, ctx);
}

// ── The machine ─────────────────────────────────────────────────────────

export function appCreation(): Machine<CState, Facts> {
  const keyed = (e: Event<any>, ctx: TransitionContext): Check => (ctx.key !== creationKey(e.payload.appId) ? reject('key_mismatch') : ok());
  const making = (f: Facts): Check => {
    if (!f.app) return reject('no_app');
    if (f.app.selfHosted) return reject('self_hosted');
    return f.app.status === 'creating' ? ok() : reject('not_creating');
  };
  const started = {
    guard: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      const k = keyed(e, ctx);
      return k !== true ? k : making(f);
    },
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => setUp(fresh(f), ctx),
  };
  const adopted = {
    guard: started.guard,
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => recheck({ name: 'waiting', data: fresh(f) }, e, f, ctx),
  };
  // Again, from failed (or a row an older build failed, no instance yet).
  const retry = {
    guard: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      const k = keyed(e, ctx);
      if (k !== true) return k;
      if (!f.app) return reject('no_app');
      if (f.app.selfHosted) return reject('self_hosted');
      if (f.app.status !== 'error') return reject('not_failed');
      // Its first deploy is still to come (it timed out waiting its turn):
      // a new setup would make its database again under that deploy.
      return f.delivery?.asked ? reject('still_deploying') : ok();
    },
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => {
      const d = s.name === NONE ? fresh(f) : { ...(s as Live).data, appSlug: f.app!.slug };
      return setUp(d, ctx, [{ type: 'retrying', appId: d.appId, counted: e.payload.counted }]);
    },
  };
  const ofSetup = (s: any, e: Event<WorkResultPayload>): Check =>
    (e.payload.kind === WORK.setup && e.payload.workKey === `setup:${s.data.attempt}` ? ok() : reject('stale_result'));
  const setupResult = { guard: ofSetup, to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => setUpEnded(s, e, f, ctx) };
  // The first request's work reports here; what it did is its own (the
  // first-version row).
  const filed = { ignore: 'first_request' };
  const workResult = (setup: any) => ({
    guard: (s: any, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Check =>
      (e.payload.kind === WORK.firstRequest ? ok() : setup.guard ? setup.guard(s, e, f, ctx) : ok()),
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) =>
      (e.payload.kind === WORK.firstRequest ? { next: s } : setup.to(s, e, f, ctx)),
  });
  const late = { to: (s: any) => ({ next: s }) };
  // A first request an older build left open: filed by this machine's work
  // (once: its key), whatever state the project is in once it has a
  // repository. A project with no instance yet gets one in the state its
  // row is in.
  const owed = {
    guard: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      const k = keyed(e, ctx);
      if (k !== true) return k;
      if (!f.app) return reject('no_app');
      if (s.name === NONE && !['running', 'awaiting_secrets'].includes(f.app.status)) return reject('not_made');
      return f.firstRequestOwed ? ok() : reject('not_owed');
    },
    to: (s: any, e: Event<any>, f: Facts): Outcome<CState> => ({
      next: s.name === NONE ? { name: f.app!.status as Name, data: fresh(f) } : s,
      work: [{ kind: WORK.firstRequest, key: 'first-request', input: { appId: f.app!.id } }],
    }),
  };
  const fromDelivery = (e: Event<any>): Check =>
    (e.source.kind === 'message' && e.source.from.machine === DELIVERY ? ok() : reject('delivery_only'));

  return defineMachine<CState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['Started', 'Adopted', 'Retry', 'FirstRequestOwed'],
    decode: (row) => (row.state === NONE ? { name: NONE, data: null } : { name: row.state as Name, data: row.data as Data }),
    facts: (tx, state, event) => readFacts(tx, state.name === NONE ? event.payload.appId : (state as Live).data.appId,
      { firstRequest: event.type === 'WorkSucceeded' || event.type === 'FirstRequestOwed',
        delivery: event.type === 'TimedOut' || event.type === 'Retry' }),
    authorize: {
      Started: (e) => (e.source.kind === 'system' ? ok() : reject('system_only')),
      Adopted: (e) => (e.source.kind === 'system' ? ok() : reject('system_only')),
      Retry: (e) => (e.source.kind === 'system' || e.source.kind === 'admin' ? ok() : reject('system_only')),
      FirstRequestOwed: (e) => (e.source.kind === 'system' ? ok() : reject('system_only')),
      TimedOut: (e) => (e.source.kind === 'timer' ? ok() : reject('timer_only')),
      Recheck: (e) => (e.source.kind === 'timer' ? ok() : reject('timer_only')),
      Delivered: fromDelivery,
      DeliveryFailed: fromDelivery,
    },
    transitions: {
      [NONE]: { Started: started, Adopted: adopted, Retry: retry, FirstRequestOwed: owed },
      waiting: {
        Recheck: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => recheck(s, e, f, ctx) },
        '*': { ignore: 'waiting' },
      },
      setting_up: {
        WorkSucceeded: workResult(setupResult),
        WorkFailed: workResult(setupResult),
        WorkExhausted: workResult(setupResult),
        TimedOut: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => timedOut(s, e, f, ctx) },
        '*': { ignore: 'setting_up' },
      },
      deploying: {
        Delivered: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => delivered(s, e, f, ctx) },
        DeliveryFailed: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => deliveryFailed(s, e, f, ctx) },
        TimedOut: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => timedOut(s, e, f, ctx) },
        FirstRequestOwed: owed,
        WorkSucceeded: workResult(late),
        WorkFailed: workResult(late),
        WorkExhausted: workResult(late),
        '*': { ignore: 'deploying' },
      },
      failed: {
        Retry: retry,
        // The first deploy of one that timed out came after all: it runs.
        Delivered: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => delivered(s, e, f, ctx) },
        WorkSucceeded: workResult(late),
        WorkFailed: workResult(late),
        WorkExhausted: workResult(late),
        '*': { ignore: 'failed' },
      },
      running: { FirstRequestOwed: owed, WorkSucceeded: filed, WorkFailed: filed, WorkExhausted: filed, '*': { ignore: 'running' } },
      awaiting_secrets: { FirstRequestOwed: owed, WorkSucceeded: filed, WorkFailed: filed, WorkExhausted: filed, '*': { ignore: 'awaiting_secrets' } },
    },
    writes: {
      // The row is the workflow's. Its heartbeat never lapses, so an older
      // build's sweep and Retry, still running during a rollout, never take
      // it (they take an owned row whose heartbeat is missing or old).
      claim: async (tx, w) => {
        await tx.query(
          `UPDATE apps SET creating_owner = $2, creating_heartbeat_at = 'infinity' WHERE id = $1`, [w.appId, WORKFLOW_OWNER]);
      },
      retrying: async (tx, w) => {
        await tx.query(
          `UPDATE apps SET status = 'creating', last_failure = NULL,
                  retry_count = retry_count + CASE WHEN $2::boolean THEN 1 ELSE 0 END
            WHERE id = $1 AND status = 'error'`, [w.appId, w.counted]);
      },
      // What failed is the setup's record, or one made here (interrupted,
      // timed out: services/deploy-failure.js syntheticRecord's shape), or
      // the first deploy's, which it wrote already.
      failed: async (tx, w, ctx) => {
        const f = w.failure as any;
        const record = f?.synthetic
          ? { stage: f.synthetic, reason: String(f.reason).slice(0, 280), log: '', at: ctx.now.toISOString(), sha: null,
            ...(f.interrupted ? { interrupted: true } : {}) }
          : f;
        await tx.query(
          `UPDATE apps SET status = 'error', last_failure = COALESCE($2::jsonb, last_failure)
            WHERE id = $1 AND status = 'creating'`, [w.appId, record == null ? null : JSON.stringify(record)]);
        await timed(tx, w);
      },
      awaiting_secrets: async (tx, w) => {
        await tx.query(
          `UPDATE apps SET status = 'awaiting_secrets', main_sha = COALESCE(main_sha, $2)
            WHERE id = $1 AND status = 'creating'`, [w.appId, w.sha]);
        await timed(tx, w);
      },
      // It runs (app delivery wrote what deployed). Late, after its time
      // limit: from error too. The first time it runs, for the admin
      // Journey's creation path.
      running: async (tx, w) => {
        await tx.query(
          `UPDATE apps SET status = 'running' WHERE id = $1 AND status IN ('creating', 'error')`, [w.appId]);
        await tx.query(FIRST_RUNNING_SQL, [w.appId, 'app_running']);
        await timed(tx, w);
      },
    },
  });
}

// services/journey-events.js markFirstRunning's statement, in the
// transition's transaction.
const FIRST_RUNNING_SQL = `WITH marked AS (
    UPDATE apps SET first_running_at = NOW()
     WHERE id = $1::int AND first_running_at IS NULL
     RETURNING id, created_by, created_at, first_running_at
  )
  INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
  SELECT m.created_by, m.id, $2::text,
         jsonb_build_object('secondsFromCreation',
           GREATEST(0, ROUND(EXTRACT(EPOCH FROM (m.first_running_at - m.created_at))))::int),
         m.first_running_at
    FROM marked m`;

// Where this attempt's time went (services/app-creation-timing.js): one
// `app_creation_timed` event when it ends, whatever its outcome, from what
// the setup and the first deploy measured.
async function timed(tx: any, w: any) {
  if (!w.timing) return;
  const metadata = combine(w.timing);
  if (!metadata) return;
  await tx.query(
    `INSERT INTO events (user_id, app_id, event_type, metadata)
     SELECT created_by, id, 'app_creation_timed', $2::jsonb FROM apps WHERE id = $1`,
    [w.appId, JSON.stringify(metadata)]);
}
