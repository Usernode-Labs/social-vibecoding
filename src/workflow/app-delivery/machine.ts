// app-delivery: an app's production runtime. One instance per app, created
// by the first thing it hears. Whoever wants production to run the newest
// main with the current settings and keys asks it (a merge, a secret
// change, a new main the drift clock saw, an admin's Redeploy or Check for
// updates, rollover, a demo reset, the project's first deploy), and it runs
// one thing at a time on the runtime: a deploy, or a heal. A request never
// races another's deploy, and a restart never races a deploy.
//
// The rule for every request is the same: it is satisfied by the first
// successful deploy that started after it was recorded. A deploy takes
// main's tip as it starts, so that deploy contains every merge confirmed
// and every setting or key stored before the request. Requests that arrive
// during a deploy or a heal are served by one more deploy after it, however
// many there are. Whoever asked from another machine is answered (Delivered
// or DeliveryFailed); a failure keeps such a request open, so the next
// deploy that succeeds still answers it.
//
// Its health: the app-health clock reports an app whose runtime is not
// running (Unhealthy), and the error page one a person could not reach
// (Unreachable). The machine decides whether to heal now (a backoff it
// keeps, so a crash-looping app is not restarted every minute for ever) and
// heals as its own work: the cheapest cure first (a restart, a start, the
// image run again), a deploy when only that helps.
//
// Main moving: the main-drift clock reports a new commit (MainMoved, keyed
// by it, so a second look adds nothing). A drift deploy that fails is
// tried again by its own deadline, backing off, unless no retry can help
// (the commit's image runs as root, keys are missing): the next commit or
// the keys' change asks again.
//
// workflow-foundation's design-app-delivery.md and design-step3-app-fleet.md
// are the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, Machine, MessageRequest, Outcome, Push, TransitionContext, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { appVersion, redeployStatus } from '../pushes.ts';
import { readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'app-delivery';
export const appKey = (appId: number) => `app:${appId}`;

export const WORK = Object.freeze({ deploy: 'app.deploy', heal: 'app.heal' });

// The machines that may ask by message, and are answered.
const ASKERS: ReadonlySet<string> = new Set(['merge-followups', 'governance-proposal', 'app-creation']);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// The longest a heal or a drift retry waits, however often it failed.
export const MAX_BACKOFF_MS = 6 * HOUR;
// A drift deploy that failed is tried again this long after, doubling.
export const DRIFT_RETRY_MS = 30 * MIN;
// Heals whose app stayed up this long past their backoff start a new count.
const QUIET_MS = HOUR;
// A Docker container seen restarting is given this long to come back by
// itself (its restart policy is mid-backoff) before it is healed.
const RESTART_GRACE_MS = MIN;

// ── State ───────────────────────────────────────────────────────────────

interface Asker { machine: string; key: string }
export interface Request {
  id: number;
  reason: string;
  from: Asker | null;          // answered when it is satisfied or its deploy fails
  at: string;
  prNumber: number | null;     // a merge's pull request: main_pr_number when its commit is what deployed
  revision: string | null;     // a merge's commit: a deploy may reuse it when it already runs
  reuse: Json;                 // an image offered to the deploy (demo mode's preview, a ready-made app's)
  told: boolean;               // told its deploy failed (and still open)
  sha?: string | null;         // the commit main moved to (drift)
}
interface Attempt { n: number; covers: number[]; startedAt: string; fromSha: string | null }
// The last heal: when it started, its number (its work's key), how many
// came one after another without the app staying up between them, and
// where the report came from. `seenRestarting`: a container first seen
// restarting (Docker), given its grace.
export interface Heal { n: number; at: string; streak: number; via: string; seenRestarting?: string | null }
// A drift deploy's retry: how many failed in a row, when the next is due,
// and the requests it holds (any other request is served at once).
export interface Retry { failures: number; at: string; held: number[] }
export interface Data {
  appId: number;
  appSlug: string;
  requests: Request[];
  nextId: number;
  attempts: number;
  attempt: Attempt | null;
  last: { sha: string | null; at: string } | null;
  failure: { message: string; missingSecrets: string[] | null; at: string; kind?: string | null } | null;
  heal?: Heal | null;
  healing?: { n: number; via: string } | null;
  retry?: Retry | null;
}
export type DeliveryState = { name: 'idle' | 'deploying' | 'healing'; data: Data } | { name: typeof NONE; data: null };
type Going = Extract<DeliveryState, { data: Data }>;

export interface Deps {
  // How long after a heal the next may start, doubling while heals follow
  // one another (APP_HEAL_COOLDOWN_MS, 10 minutes).
  healCooldownMs?: number;
  // Whether GitHub is configured, and where apps run by default.
  githubOn?: () => boolean;
  runtimeMode?: string | null;
}

// ── Events ──────────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{40}$/;
const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown, what: string) => (v == null ? null : int(v, what));
const optSha = (v: unknown, what: string) => {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (!SHA.test(s)) throw new Error(`${what} must be a 40-character commit sha`);
  return s;
};
// What the runtime said: Kubernetes (stopped, restarting, created,
// not_found) or Docker (exited, created, paused, dead, restarting,
// not_found).
const RUNTIME_STATE = /^[a-z_]{1,32}$/;

const EVENTS = {
  // An admin ends a deploy or a heal that never answers (a build or a lock
  // that hangs, a result skipped in Admin → Workflows): read as a failure,
  // so whoever asked is told and the app no longer reads deploying. A late
  // result of it is stale.
  EndDeploy: () => ({}),
  DeployRequested: (p: any) => {
    if (typeof p?.reason !== 'string' || !p.reason.trim()) throw new Error('reason is required');
    return {
      appId: int(p?.appId, 'appId'),
      reason: p.reason.trim().slice(0, 64),
      prNumber: optInt(p?.prNumber, 'prNumber'),
      revision: optSha(p?.revision, 'revision'),
      reuse: (p?.reuse && typeof p.reuse === 'object' ? p.reuse : null) as Json,
    };
  },
  // Main is at a commit production does not run (the main-drift clock), or
  // an admin's Check for updates found one (`byHand`).
  MainMoved: (p: any) => ({ appId: int(p?.appId, 'appId'), sha: optSha(p?.sha, 'sha') ?? (() => { throw new Error('sha is required'); })(), byHand: p?.byHand === true }),
  // The app-health clock saw the runtime not running.
  Unhealthy: (p: any) => {
    const state = String(p?.state ?? '');
    if (!RUNTIME_STATE.test(state)) throw new Error('state must name the runtime state');
    return { appId: int(p?.appId, 'appId'), state };
  },
  // A person reached the error page instead of the app: it may be down, or
  // up and not answering (a probe tells).
  Unreachable: (p: any) => ({ appId: int(p?.appId, 'appId') }),
  // The drift retry's deadline.
  RetryDue: () => ({}),
};

// ── Outcomes ────────────────────────────────────────────────────────────

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

// The requests a person made by hand: their deploy tries even a commit the
// automatic paths have stopped trying (its image runs as root:
// deploy-failure.js waitsForNewCommit).
const BY_HAND: ReadonlySet<string> = new Set(['redeploy', 'check_updates', 'demo_reset']);
// Requests nobody waits on that a failed deploy keeps, for its retry: main
// moved, and production should run it.
const RETRIED: ReadonlySet<string> = new Set(['drift']);
// Failures no retry of the same commit changes: the next commit, or the
// keys' change, asks again.
const FINAL: ReadonlySet<string> = new Set(['root_image', 'missing_secrets']);

// What one deploy may skip: the running revision (after a crash that had
// already deployed it) or the build (an offered image). Only when every
// request it serves offers the same: a secret change beside a merge needs a
// real deploy. It retries a refused commit when any of them was asked for
// by hand.
function options(covered: Request[]) {
  const first = covered[0];
  const all = <K extends keyof Request>(k: K) => (covered.every((r) => same(r[k] as Json, first[k] as Json)) ? first[k] : null);
  return { revision: all('revision') as string | null, reuse: all('reuse') as Json, prNumber: all('prNumber') as number | null,
    ...(covered.some((r) => BY_HAND.has(r.reason)) ? { retrySameCommit: true } : {}) };
}

const fresh = (appId: number, f: Facts): Data => ({
  appId, appSlug: f.app?.slug ?? '', requests: [], nextId: 1, attempts: 0, attempt: null, last: null, failure: null,
  heal: null, healing: null, retry: null,
});
const dataOf = (s: DeliveryState, appId: number, f: Facts): Data => (s.name === NONE
  ? fresh(appId, f)
  : { ...(s as Going).data, appSlug: f.app?.slug ?? (s as Going).data.appSlug });

// A deploy of everything recorded so far.
// `fromSha`: what runs as it starts, when the facts read before a deploy
// that just succeeded do not say (one more deploy right after it).
function start(d: Data, f: Facts, ctx: TransitionContext,
  x: { messages?: MessageRequest[]; push?: Push[]; fromSha?: string | null } = {}): Outcome<DeliveryState> {
  const covers = d.requests.map((r) => r.id);
  const n = d.attempts + 1;
  const fromSha = x.fromSha !== undefined ? x.fromSha : f.app?.mainSha ?? null;
  const attempt: Attempt = { n, covers, startedAt: ctx.now.toISOString(), fromSha };
  const work: WorkRequest[] = [{ kind: WORK.deploy, key: `deploy:${n}`, input: { appId: d.appId, ...options(d.requests) } }];
  const push = [...(x.push || []), redeployStatus({ appSlug: d.appSlug, deploying: true, startedAt: attempt.startedAt, fromSha: attempt.fromSha })];
  // The retry's deadline goes: this deploy serves what it held.
  return { next: { name: 'deploying', data: { ...d, attempts: n, attempt, healing: null } }, work, messages: x.messages, push, timer: null };
}

// What resting leaves: a deadline for a drift retry that is owed, or none.
function rest(d: Data, x: { messages?: MessageRequest[]; push?: Push[] } = {}): Outcome<DeliveryState> {
  const owed = d.retry && d.requests.some((r) => d.retry!.held.includes(r.id));
  return { next: { name: 'idle', data: { ...d, attempt: null, healing: null } }, messages: x.messages, push: x.push,
    timer: owed ? { at: new Date(d.retry!.at), event: { type: 'RetryDue' } } : null };
}

// What no deploy here can serve: the platform's own app is released by its
// pipeline (merge-followups hears its release boot), and an app without a
// repository has nothing to build, unless GitHub is off (its starter files
// are its source).
const UNSERVABLE = new Map([
  ['no_app', 'the app no longer exists'],
  ['self_hosted', 'the platform is released by its own pipeline'],
  ['no_repo', 'the app has no repository to deploy from'],
]);
function unservable(f: Facts): string | null {
  if (!f.app) return 'no_app';
  if (f.app.selfHosted) return 'self_hosted';
  if (!f.app.repoUrl && f.githubOn) return 'no_repo';
  return null;
}
const asker = (e: Event<any>): Asker | null =>
  (e.source.kind === 'message' ? { machine: e.source.from.machine, key: e.source.from.key } : null);

function record(d: Data, e: Event<any>, ctx: TransitionContext, r: Partial<Request> & { reason: string }): Data {
  const request: Request = { id: d.nextId, from: asker(e), at: ctx.now.toISOString(), prNumber: null, revision: null,
    reuse: null, told: false, ...r };
  return { ...d, nextId: d.nextId + 1, requests: [...d.requests, request] };
}

// Recorded, and served now if nothing is under way.
function requested(s: DeliveryState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> {
  const p = e.payload;
  const d = dataOf(s, p.appId, f);
  const from = asker(e);
  // Another machine waits for an answer: it hears it cannot be served (a
  // refusal would leave it waiting). A route or a sweep is refused instead.
  const cannot = unservable(f);
  if (cannot) {
    return { next: { name: s.name === NONE ? 'idle' : s.name, data: d } as DeliveryState,
      messages: [{ to: from!, event: { type: 'DeliveryFailed', payload: { message: UNSERVABLE.get(cannot)!, missingSecrets: null } } }] };
  }
  const next = record(d, e, ctx, { reason: p.reason, prNumber: p.prNumber, revision: p.revision, reuse: p.reuse });
  if (s.name === 'deploying' || s.name === 'healing') return { next: { name: s.name, data: next } };
  return start(next, f, ctx);
}

// Main moved: production should run the new commit, unless it already does
// (or a request for that commit is already open), or the commit is one
// whose image runs as root and nobody asked by hand.
function moved(s: DeliveryState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> {
  const { appId, sha, byHand } = e.payload as { appId: number; sha: string; byHand: boolean };
  const d = dataOf(s, appId, f);
  const reason = byHand ? 'check_updates' : 'drift';
  const next = record(d, e, ctx, { reason, sha });
  if (s.name === 'deploying' || s.name === 'healing') return { next: { name: s.name, data: next } };
  // A retry owed for a drift that just came in again starts now (its
  // deadline goes): a new commit is a new chance.
  return start(next, f, ctx);
}
const movedGuard = (s: DeliveryState, e: Event<any>, f: Facts): Check => {
  const { sha, byHand } = e.payload as { sha: string; byHand: boolean };
  const cannot = unservable(f);
  if (cannot) return reject(cannot);
  if (f.app!.mainSha === sha) return reject('no_drift');
  if (byHand) return ok();
  if (f.lastFailure && FINAL.has(f.lastFailure.kind ?? '') && f.lastFailure.sha === sha) return reject('waits_for_new_commit');
  const d = s.name === NONE ? null : (s as Going).data;
  if (d?.requests.some((r) => r.reason === 'drift' && r.sha === sha)) return reject('already_asked');
  return ok();
};

// The deploy succeeded: what it served is answered, and what came in since
// is served by one more.
function deployed(s: Going, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> {
  const d = s.data;
  const result = (e.payload.result || {}) as { sha?: string | null; url?: string | null; timing?: Json };
  const sha = result.sha ? String(result.sha).toLowerCase() : null;
  const covered = new Set(d.attempt!.covers);
  const served = d.requests.filter((r) => covered.has(r.id));
  // A drift that came in during the deploy for the commit it deployed is
  // served too (main was already there as it started).
  const left = d.requests.filter((r) => !covered.has(r.id) && !(r.reason === 'drift' && sha && r.sha === sha));
  // Its pull request, when the commit that deployed is a merge's own.
  const prNumber = served.find((r) => r.revision && r.revision === sha)?.prNumber ?? null;
  // Where it runs, and (a project's first deploy) where its time went.
  const delivered: Json = { sha, ...(result.url ? { url: result.url } : {}), ...(result.timing ? { timing: result.timing } : {}) };
  const messages: MessageRequest[] = served.flatMap((r) => answer(r, 'Delivered', delivered));
  // Every other merge of the app still waiting to go live hears it: one
  // whose own answer did not make it live (GitHub did not say yet that the
  // build contains it), and one recorded before every merge asked here. Not
  // one with a request open here: this deploy answered it, or started
  // before it was recorded (before the merge applied its declared keys), so
  // it waits for its own deploy's answer.
  const asking = new Set(d.requests.filter((r) => r.from?.machine === 'merge-followups').map((r) => r.from!.key));
  if (sha) {
    for (const key of f.waitingMerges) {
      if (!asking.has(key)) messages.push({ to: { machine: 'merge-followups', key }, event: { type: 'Deployed', payload: { sha } } });
    }
  }
  // The version pill's new build is pushed by the write, with the pull
  // request the row keeps.
  const push: Push[] = [
    redeployStatus({ appSlug: d.appSlug, deploying: false, startedAt: d.attempt!.startedAt, fromSha: d.attempt!.fromSha, toSha: sha }),
  ];
  const next: Data = { ...d, requests: left, attempt: null, last: { sha, at: ctx.now.toISOString() }, failure: null, retry: null };
  const writes = [{ type: 'deployed', appId: d.appId, appSlug: d.appSlug, sha, prNumber }];
  if (left.length) return { ...start(next, f, ctx, { messages, push, fromSha: sha ?? f.app?.mainSha ?? null }), writes };
  return { ...rest(next, { messages, push }), writes };
}

const answer = (r: Request, type: string, payload: Json): MessageRequest[] =>
  (r.from ? [{ to: r.from, event: { type, payload } }] : []);

// The deploy failed (missing keys, a broken build, retries spent). Whoever
// asked is told once; what they asked for stays open, for the next deploy
// that succeeds. A drift request stays open too, tried again by the
// retry's deadline, unless no retry can help. Any other request with nobody
// to tell goes: heal's backoff, an admin or the next commit asks again.
function failed(s: Going, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> {
  const d = s.data;
  const result = (e.type === 'EndDeploy' ? { message: 'an admin ended the deploy' } : e.payload.result || {}) as
    { message?: string; missingSecrets?: string[]; failed?: string };
  const message = result.message || e.payload.error?.message || 'the deploy failed';
  const missingSecrets = Array.isArray(result.missingSecrets) ? result.missingSecrets.map(String) : null;
  const kind = result.failed ?? null;
  const covered = new Set(d.attempt!.covers);
  const messages: MessageRequest[] = [];
  const requests: Request[] = [];
  const held: number[] = [];
  for (const r of d.requests) {
    if (!covered.has(r.id)) { requests.push(r); continue; }
    if (!r.from) {
      if (RETRIED.has(r.reason) && !FINAL.has(kind ?? '') && e.type !== 'EndDeploy') { requests.push(r); held.push(r.id); }
      continue;
    }
    if (!r.told) messages.push(...answer(r, 'DeliveryFailed', { message, missingSecrets }));
    requests.push({ ...r, told: true });
  }
  const push: Push[] = [redeployStatus({ appSlug: d.appSlug, deploying: false, startedAt: d.attempt!.startedAt,
    fromSha: d.attempt!.fromSha, toSha: null, failed: true, missingSecrets })];
  const failures = held.length ? (d.retry?.failures ?? 0) + 1 : 0;
  const retry: Retry | null = held.length
    ? { failures, held, at: new Date(ctx.now.getTime() + Math.min(MAX_BACKOFF_MS, DRIFT_RETRY_MS * 2 ** (failures - 1))).toISOString() }
    : null;
  const next: Data = { ...d, requests, attempt: null, retry,
    failure: { message, missingSecrets, at: ctx.now.toISOString(), kind } };
  // Only a request that came in during this deploy starts another (with
  // every open one): a failure alone does not loop.
  if (requests.some((r) => !covered.has(r.id))) return start(next, f, ctx, { messages, push });
  return rest(next, { messages, push });
}

const ofAttempt = (s: any, e: Event<WorkResultPayload>): Check =>
  (e.payload.kind === WORK.deploy && s.data.attempt && e.payload.workKey === `deploy:${s.data.attempt.n}` ? ok() : reject('stale_result'));
const ofHeal = (s: any, e: Event<WorkResultPayload>): Check =>
  (e.payload.kind === WORK.heal && s.data.healing && e.payload.workKey === `heal:${s.data.healing.n}` ? ok() : reject('stale_result'));

// The retry's deadline: the open drift requests are deployed again.
function retryDue(s: Going, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> {
  const d = s.data;
  if (!d.retry || !d.requests.some((r) => d.retry!.held.includes(r.id))) return { next: s, timer: null };
  // An older deadline a newer failure moved: the newer one stays.
  if (Date.parse(d.retry.at) > ctx.now.getTime()) return { next: s, timer: { at: new Date(d.retry.at), event: { type: 'RetryDue' } } };
  if (unservable(f)) return { next: { name: 'idle', data: { ...d, requests: [], retry: null } }, timer: null };
  return start(d, f, ctx);
}

// ── Health ──────────────────────────────────────────────────────────────

// When the next heal may start: right away after none, else a backoff that
// doubles while heals follow one another.
function backoffMs(heal: Heal, deps: Deps): number {
  const base = deps.healCooldownMs ?? 10 * MIN;
  return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, heal.streak - 1));
}
function mayHeal(d: Data, ctx: TransitionContext, deps: Deps): boolean {
  const h = d.heal;
  if (!h || !h.streak) return true;
  return ctx.now.getTime() - Date.parse(h.at) >= backoffMs(h, deps);
}

// A report that the app is not up: healed now, unless its backoff runs.
function reported(deps: Deps) {
  return (s: DeliveryState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> => {
    const p = e.payload as { appId: number; state?: string };
    const d = dataOf(s, p.appId, f);
    const via = e.type === 'Unreachable' ? 'visit' : 'sweep';
    // Docker's own restart policy is usually mid-backoff: a container seen
    // restarting is given its grace, and healed only if it still is.
    if (p.state === 'restarting' && f.runtimeKind === 'docker') {
      const seen = d.heal?.seenRestarting ? Date.parse(d.heal.seenRestarting) : null;
      if (seen === null || ctx.now.getTime() - seen > RESTART_GRACE_MS * 3) {
        const heal: Heal = { ...(d.heal ?? { n: 0, at: ctx.now.toISOString(), streak: 0, via }), seenRestarting: ctx.now.toISOString() };
        return { next: { name: 'idle', data: { ...d, heal } } };
      }
      if (ctx.now.getTime() - seen < RESTART_GRACE_MS) return { next: { name: 'idle', data: d } };
    }
    if (!mayHeal(d, ctx, deps)) return { next: { name: 'idle', data: d } };
    const prev = d.heal;
    const quiet = prev?.streak ? ctx.now.getTime() - Date.parse(prev.at) - backoffMs(prev, deps) : Infinity;
    const streak = prev?.streak && quiet < QUIET_MS ? prev.streak + 1 : 1;
    const n = (prev?.n ?? 0) + 1;
    const heal: Heal = { n, at: ctx.now.toISOString(), streak, via, seenRestarting: null };
    const work: WorkRequest[] = [{ kind: WORK.heal, key: `heal:${n}`,
      input: { appId: d.appId, via, probe: e.type === 'Unreachable', state: p.state ?? null } }];
    return { next: { name: 'healing', data: { ...d, heal, healing: { n, via } } }, work, timer: null };
  };
}
const reportGuard = (f: Facts): Check => {
  if (!f.app) return reject('no_app');
  if (f.app.selfHosted) return reject('self_hosted');
  if (f.app.status !== 'running') return reject('not_running');
  return ok();
};

// The heal ended. A cure (or nothing to cure) rests; an app only a deploy
// can bring back gets one, with whatever was asked meanwhile.
function healed(s: Going, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> {
  const d = { ...s.data, healing: null };
  const status = e.type === 'WorkSucceeded' ? String((e.payload.result as any)?.status ?? '') : 'heal_failed';
  if (status === 'needs_deploy' && !unservable(f)) {
    const next = record(d, { ...e, source: { kind: 'system', name: 'heal' } } as Event<any>, ctx, { reason: 'heal' });
    return start(next, f, ctx);
  }
  // What was asked meanwhile is deployed now; requests a drift retry holds
  // wait for its deadline.
  if (d.requests.some((r) => !d.retry?.held.includes(r.id))) return start(d, f, ctx);
  return rest(d);
}

// ── The machine ─────────────────────────────────────────────────────────

export function appDelivery(deps: Deps = {}): Machine<DeliveryState, Facts> {
  const mayAsk = (e: Event<any>): Check => {
    if (e.source.kind === 'system' || e.source.kind === 'admin') return ok();
    if (e.source.kind === 'message' && ASKERS.has(e.source.from.machine)) return ok();
    return reject('internal_only');
  };
  const keyed = (ctx: TransitionContext, e: Event<any>): Check => (ctx.key !== appKey(e.payload.appId) ? reject('key_mismatch') : ok());
  const request = {
    guard: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      const k = keyed(ctx, e);
      if (k !== true) return k;
      const cannot = unservable(f);
      return cannot && !asker(e) ? reject(cannot) : ok();
    },
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => requested(s, e, f, ctx),
  };
  const main = {
    guard: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      const k = keyed(ctx, e);
      return k !== true ? k : movedGuard(s, e, f);
    },
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => moved(s, e, f, ctx),
  };
  const report = {
    guard: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      const k = keyed(ctx, e);
      return k !== true ? k : reportGuard(f);
    },
    to: reported(deps),
  };
  const result = (decide: typeof deployed) => ({
    guard: ofAttempt,
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => decide(s, e, f, ctx),
  });
  // A deploy that answered "missing keys" did not fail as work: it is a
  // result the transition reads as a failure, keys and all.
  const succeeded = {
    guard: ofAttempt,
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) =>
      ((e.payload.result as { failed?: string } | null)?.failed ? failed(s, e, f, ctx) : deployed(s, e, f, ctx)),
  };
  const heal = { guard: ofHeal, to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => healed(s, e, f, ctx) };
  const noAttempt = { ignore: 'no_attempt' };

  return defineMachine<DeliveryState, Facts>({
    name: MACHINE,
    version: 2,
    events: EVENTS,
    create: ['DeployRequested', 'MainMoved', 'Unhealthy', 'Unreachable'],
    decode: (row) => ({ name: row.state, data: row.data } as DeliveryState),
    facts: (tx, state, event) => readFacts(tx, state.name === NONE ? event.payload.appId : (state as Going).data.appId,
      { githubOn: deps.githubOn ? deps.githubOn() : true, runtimeMode: deps.runtimeMode ?? null },
      { waitingMerges: event.type === 'WorkSucceeded' }),
    authorize: {
      DeployRequested: mayAsk,
      MainMoved: (e) => (e.source.kind === 'system' || e.source.kind === 'admin' ? ok() : reject('system_only')),
      Unhealthy: (e) => (e.source.kind === 'system' ? ok() : reject('system_only')),
      Unreachable: (e) => (e.source.kind === 'system' ? ok() : reject('system_only')),
      RetryDue: (e) => (e.source.kind === 'timer' ? ok() : reject('timer_only')),
      EndDeploy: (e) => (e.source.kind === 'admin' ? ok() : reject('admin_only')),
    },
    transitions: {
      [NONE]: { DeployRequested: request, MainMoved: main, Unhealthy: report, Unreachable: report },
      idle: {
        DeployRequested: request,
        MainMoved: main,
        Unhealthy: report,
        Unreachable: report,
        RetryDue: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => retryDue(s, e, f, ctx) },
        EndDeploy: { ignore: 'not_deploying' },
        WorkSucceeded: noAttempt,
        WorkFailed: noAttempt,
        WorkExhausted: noAttempt,
      },
      deploying: {
        DeployRequested: request,
        MainMoved: main,
        // The deploy replaces the runtime.
        Unhealthy: { ignore: 'deploying' },
        Unreachable: { ignore: 'deploying' },
        RetryDue: { ignore: 'deploying' },
        EndDeploy: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => failed(s, e, f, ctx) },
        WorkSucceeded: succeeded,
        WorkFailed: result(failed),
        WorkExhausted: result(failed),
      },
      healing: {
        DeployRequested: request,
        MainMoved: main,
        Unhealthy: { ignore: 'healing' },
        Unreachable: { ignore: 'healing' },
        RetryDue: { ignore: 'healing' },
        // An admin ends a heal that never answers: the cure did not happen.
        EndDeploy: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => healed(s, { ...e, type: 'WorkFailed' }, f, ctx) },
        WorkSucceeded: heal,
        WorkFailed: heal,
        WorkExhausted: heal,
      },
    },
    writes: {
      // One writer and one shape for what a deploy leaves on the row
      // (staging's deploy code writes the runtime's own columns). The pull
      // request is the merge's whose commit deployed, kept when the same
      // commit was deployed again (a Redeploy, a secret change), and gone
      // with a commit no merge here named. Then the version pill's new build.
      deployed: async (tx, w, ctx) => {
        const { rows: [r] } = await tx.query(
          `UPDATE apps SET main_sha = COALESCE($2, main_sha),
                  main_pr_number = CASE WHEN $3::int IS NOT NULL THEN $3::int
                                        WHEN main_sha IS NOT DISTINCT FROM $2 THEN main_pr_number END,
                  last_deploy_at = NOW(),
                  status = CASE WHEN status IN ('awaiting_secrets', 'error') THEN 'running' ELSE status END
            WHERE id = $1 RETURNING main_sha, main_pr_number`,
          [w.appId, w.sha, w.prNumber]);
        if (r) ctx.push(appVersion({ appId: w.appId, appSlug: w.appSlug, sha: r.main_sha || null, prNumber: r.main_pr_number ?? null }));
      },
    },
    async project(tx, before, after) {
      if (after.name === NONE) return;
      const a = (after as Going).data.attempt;
      const b = before.name === NONE ? null : (before as Going).data.attempt;
      if (a?.n === b?.n) return;
      await tx.query(
        'UPDATE apps SET deploy_state = $2, deploy_started_at = $3, deploy_from_sha = $4 WHERE id = $1',
        [(after as Going).data.appId, a ? 'deploying' : null, a?.startedAt ?? null, a?.fromSha ?? null]);
    },
  });
}
