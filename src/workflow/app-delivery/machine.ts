// app-delivery: an app's production deploys. One instance per app, created
// by the first request for a deploy. Whoever wants production to run the
// newest main with the current settings and keys asks it (a merge, a secret
// change, the drift poller, an admin's Redeploy, heal, rollover, a demo
// reset), and it runs one deploy at a time, so a request never races
// another's deploy.
//
// The rule for every request is the same: it is satisfied by the first
// successful deploy that started after it was recorded. A deploy takes
// main's tip as it starts, so that deploy contains every merge confirmed
// and every setting or key stored before the request. Requests that arrive
// during a deploy are served by one more deploy after it, however many there
// are. Whoever asked from another machine is answered (Delivered or
// DeliveryFailed); a failure keeps such a request open, so the next deploy
// that succeeds still answers it.
//
// workflow-foundation's design-app-delivery.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, Machine, MessageRequest, Outcome, Push, TransitionContext, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { appVersion, redeployStatus } from '../pushes.ts';
import { readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'app-delivery';
export const appKey = (appId: number) => `app:${appId}`;

export const WORK = Object.freeze({ deploy: 'app.deploy' });

// The machines that may ask by message, and are answered.
const ASKERS: ReadonlySet<string> = new Set(['merge-followups', 'governance-proposal']);

// ── State ───────────────────────────────────────────────────────────────

interface Asker { machine: string; key: string }
export interface Request {
  id: number;
  reason: string;
  from: Asker | null;          // answered when it is satisfied or its deploy fails
  at: string;
  prNumber: number | null;     // a merge's pull request: main_pr_number when its commit is what deployed
  revision: string | null;     // a merge's commit: a deploy may reuse it when it already runs
  reuse: Json;                 // demo mode: the preview's build, offered to the deploy
  told: boolean;               // told its deploy failed (and still open)
}
interface Attempt { n: number; covers: number[]; startedAt: string; fromSha: string | null }
export interface Data {
  appId: number;
  appSlug: string;
  requests: Request[];
  nextId: number;
  attempts: number;
  attempt: Attempt | null;
  last: { sha: string | null; at: string } | null;
  failure: { message: string; missingSecrets: string[] | null; at: string } | null;
}
export type DeliveryState = { name: 'idle' | 'deploying'; data: Data } | { name: typeof NONE; data: null };
type Going = Extract<DeliveryState, { data: Data }>;

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

const EVENTS = {
  // An admin ends a deploy that never answers (a build or a lock that hangs,
  // a result skipped in Admin → Workflows): read as a failure, so whoever
  // asked is told and the app no longer reads deploying. A late result of
  // that deploy is stale.
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
};

// ── Outcomes ────────────────────────────────────────────────────────────

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

// What one deploy may skip: the running revision (after a crash that had
// already deployed it) or the build (demo mode's preview image). Only when
// every request it serves offers the same: a secret change beside a merge
// needs a real deploy.
function options(covered: Request[]) {
  const first = covered[0];
  const all = <K extends keyof Request>(k: K) => (covered.every((r) => same(r[k] as Json, first[k] as Json)) ? first[k] : null);
  return { revision: all('revision') as string | null, reuse: all('reuse') as Json, prNumber: all('prNumber') as number | null };
}

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
  return { next: { name: 'deploying', data: { ...d, attempts: n, attempt } }, work, messages: x.messages, push };
}

// What no deploy here can serve: the platform's own app is released by its
// pipeline (merge-followups hears its release boot), and an app without a
// repository has nothing to build.
const UNSERVABLE = new Map([
  ['no_app', 'the app no longer exists'],
  ['self_hosted', 'the platform is released by its own pipeline'],
  ['no_repo', 'the app has no repository to deploy from'],
]);
function unservable(f: Facts): string | null {
  if (!f.app) return 'no_app';
  if (f.app.selfHosted) return 'self_hosted';
  if (!f.app.repoUrl) return 'no_repo';
  return null;
}
const asker = (e: Event<any>): Asker | null =>
  (e.source.kind === 'message' ? { machine: e.source.from.machine, key: e.source.from.key } : null);

// Recorded, and served now if nothing is deploying.
function requested(s: DeliveryState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> {
  const p = e.payload;
  const d: Data = s.name === NONE
    ? { appId: p.appId, appSlug: f.app?.slug ?? '', requests: [], nextId: 1, attempts: 0, attempt: null, last: null, failure: null }
    : { ...(s as Going).data, appSlug: f.app?.slug ?? (s as Going).data.appSlug };
  const from = asker(e);
  // Another machine waits for an answer: it hears it cannot be served (a
  // refusal would leave it waiting). A route or a sweep is refused instead.
  const cannot = unservable(f);
  if (cannot) {
    return { next: { name: s.name === 'deploying' ? 'deploying' : 'idle', data: d },
      messages: [{ to: from!, event: { type: 'DeliveryFailed', payload: { message: UNSERVABLE.get(cannot)!, missingSecrets: null } } }] };
  }
  const request: Request = { id: d.nextId, reason: p.reason, from, at: ctx.now.toISOString(), prNumber: p.prNumber,
    revision: p.revision, reuse: p.reuse, told: false };
  const next = { ...d, nextId: d.nextId + 1, requests: [...d.requests, request] };
  if (s.name === 'deploying') return { next: { name: 'deploying', data: next } };
  return start(next, f, ctx);
}

const answer = (r: Request, type: string, payload: Json): MessageRequest[] =>
  (r.from ? [{ to: r.from, event: { type, payload } }] : []);

// The deploy succeeded: what it served is answered, and what came in since
// is served by one more.
function deployed(s: Going, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> {
  const d = s.data;
  const result = (e.payload.result || {}) as { sha?: string | null };
  const sha = result.sha ? String(result.sha).toLowerCase() : null;
  const covered = new Set(d.attempt!.covers);
  const served = d.requests.filter((r) => covered.has(r.id));
  const left = d.requests.filter((r) => !covered.has(r.id));
  // Its pull request, when the commit that deployed is a merge's own.
  const prNumber = served.find((r) => r.revision && r.revision === sha)?.prNumber ?? null;
  const messages: MessageRequest[] = served.flatMap((r) => answer(r, 'Delivered', { sha }));
  // Every other merge of the app still waiting to go live hears it, as any
  // deploy was heard before (staging.rebuildProduction's productionDeployed):
  // one that decided on the work path, and one whose own answer did not
  // make it live (GitHub did not say yet that the build contains it).
  const answered = new Set(served.filter((r) => r.from?.machine === 'merge-followups').map((r) => r.from!.key));
  if (sha) {
    for (const key of f.waitingMerges) {
      if (!answered.has(key)) messages.push({ to: { machine: 'merge-followups', key }, event: { type: 'Deployed', payload: { sha } } });
    }
  }
  // The version pill's new build is pushed by the write, with the pull
  // request the row keeps.
  const push: Push[] = [
    redeployStatus({ appSlug: d.appSlug, deploying: false, startedAt: d.attempt!.startedAt, fromSha: d.attempt!.fromSha, toSha: sha }),
  ];
  const next: Data = { ...d, requests: left, attempt: null, last: { sha, at: ctx.now.toISOString() }, failure: null };
  const writes = [{ type: 'deployed', appId: d.appId, appSlug: d.appSlug, sha, prNumber }];
  if (left.length) return { ...start(next, f, ctx, { messages, push, fromSha: sha ?? f.app?.mainSha ?? null }), writes };
  return { next: { name: 'idle', data: next }, writes, messages, push };
}

// The deploy failed (missing keys, a broken build, retries spent). Whoever
// asked is told once; what they asked for stays open, for the next deploy
// that succeeds. A request with nobody to tell goes: the drift poller, an
// admin or heal asks again.
function failed(s: Going, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<DeliveryState> {
  const d = s.data;
  const result = (e.type === 'EndDeploy' ? { message: 'an admin ended the deploy' } : e.payload.result || {}) as
    { message?: string; missingSecrets?: string[] };
  const message = result.message || e.payload.error?.message || 'the deploy failed';
  const missingSecrets = Array.isArray(result.missingSecrets) ? result.missingSecrets.map(String) : null;
  const covered = new Set(d.attempt!.covers);
  const messages: MessageRequest[] = [];
  const requests: Request[] = [];
  for (const r of d.requests) {
    if (!covered.has(r.id)) { requests.push(r); continue; }
    if (!r.from) continue;
    if (!r.told) messages.push(...answer(r, 'DeliveryFailed', { message, missingSecrets }));
    requests.push({ ...r, told: true });
  }
  const push: Push[] = [redeployStatus({ appSlug: d.appSlug, deploying: false, startedAt: d.attempt!.startedAt,
    fromSha: d.attempt!.fromSha, toSha: null, failed: true, missingSecrets })];
  const next: Data = { ...d, requests, attempt: null, failure: { message, missingSecrets, at: ctx.now.toISOString() } };
  // Only a request that came in during this deploy starts another (with
  // every open one): a failure alone does not loop.
  if (requests.some((r) => !covered.has(r.id))) return start(next, f, ctx, { messages, push });
  return { next: { name: 'idle', data: next }, messages, push };
}

const ofAttempt = (s: any, e: Event<WorkResultPayload>): Check =>
  (e.payload.kind === WORK.deploy && s.data.attempt && e.payload.workKey === `deploy:${s.data.attempt.n}` ? ok() : reject('stale_result'));

// ── The machine ─────────────────────────────────────────────────────────

export function appDelivery(): Machine<DeliveryState, Facts> {
  const mayAsk = (e: Event<any>): Check => {
    if (e.source.kind === 'system' || e.source.kind === 'admin') return ok();
    if (e.source.kind === 'message' && ASKERS.has(e.source.from.machine)) return ok();
    return reject('internal_only');
  };
  const request = {
    guard: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      if (ctx.key !== appKey(e.payload.appId)) return reject('key_mismatch');
      const cannot = unservable(f);
      return cannot && !asker(e) ? reject(cannot) : ok();
    },
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => requested(s, e, f, ctx),
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
  const noAttempt = { ignore: 'no_attempt' };

  return defineMachine<DeliveryState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['DeployRequested'],
    decode: (row) => ({ name: row.state, data: row.data } as DeliveryState),
    facts: (tx, state, event) => readFacts(tx, state.name === NONE ? event.payload.appId : (state as Going).data.appId,
      { waitingMerges: event.type === 'WorkSucceeded' }),
    authorize: {
      DeployRequested: mayAsk,
      EndDeploy: (e) => (e.source.kind === 'admin' ? ok() : reject('admin_only')),
    },
    transitions: {
      [NONE]: { DeployRequested: request },
      idle: {
        DeployRequested: request,
        EndDeploy: { ignore: 'not_deploying' },
        WorkSucceeded: noAttempt,
        WorkFailed: noAttempt,
        WorkExhausted: noAttempt,
      },
      deploying: {
        DeployRequested: request,
        EndDeploy: { to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => failed(s, e, f, ctx) },
        WorkSucceeded: succeeded,
        WorkFailed: result(failed),
        WorkExhausted: result(failed),
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
