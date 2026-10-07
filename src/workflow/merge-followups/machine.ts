// merge-followups: what a merged pull request still has to do once GitHub
// has merged it. One instance per merged proposal, created by the merge
// (or by recovery, which observes the same merge on GitHub), and one per
// change that went live inside it (an included change). The status move to
// 'merged', the declared secret values, PR_MERGED and the bounties commit
// with the instance; everything that talks to the outside is durable work.
// The change is `live` once production runs a build that contains it.
// workflow-foundation's machine-merge-followups.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type {
  Check, DomainWrite, Event, Json, Machine, Notification, Outcome, TransitionContext, Tx, WorkRequest, WorkResultPayload,
} from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'merge-followups';
export const sessionKey = (sessionId: number) => `session:${sessionId}`;

// Work kinds. app.deliver and delivery.verify decide `live`; the rest only
// have to happen.
export const WORK = Object.freeze({
  deliver: 'app.deliver',
  verify: 'delivery.verify',
  teardown: 'preview.teardown',
  retire: 'worker.retire',
  find: 'included.find',
  issues: 'issues.closeAfterMerge',
  closePr: 'github.closePullRequest',
  mainCheck: 'main.check',
  bot: 'bot.requestMerged',
  dm: 'bot.dmMerged',
  journey: 'journey.changeLive',
});

export const NOTIFIERS = ['chat', 'voteUpdate', 'kickQueue', 'nudgeDeployer', 'appVersion', 'bell', 'mergedNotification'] as const;

// ── States ──────────────────────────────────────────────────────────────

type Role = 'merge' | 'included';
interface Followup { kind: string; input: Json; status: 'pending' | 'done' | 'failed' | 'exhausted' | 'retried'; error?: string }
interface Tally { yes: number; required: number | null; active: number | null }
interface CarrierRef { sessionId: number; prNumber: number | null; prTitle: string | null }

export interface Data {
  sessionId: number;
  appId: number;
  appSlug: string;
  role: Role;
  prNumber: number | null;
  prTitle: string | null;
  authorId: number | null;
  repo: { owner: string; repo: string } | null;
  mergeSha: string | null;
  mergedAt: string;
  force: boolean;
  forcedBy: string | null;
  tally: Tally | null;
  selfHosted: boolean;
  includedIn: CarrierRef | null;   // role 'included': the change that carried it
  included: number[];              // role 'merge': the changes it carried, as found
  deliveries: number;              // app.deliver items so far (retries get new keys)
  deliveredSha: string | null;
  liveAt: string | null;
  failure: string | null;
  followups: Record<string, Followup>;
}
export type MFState =
  | { name: 'delivering' | 'live' | 'deploy_failed'; data: Data }
  | { name: typeof NONE; data: null };
type Going = Extract<MFState, { data: Data }>;

// ── Events ──────────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{40}$/;
const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown, what: string) => (v == null ? null : int(v, what));
const count = (v: unknown, what: string) => {
  if (v == null) return null;
  if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${what} must be a count`);
  return v as number;
};
const sha = (v: unknown, what: string, required = false): string | null => {
  if (v == null && !required) return null;
  const s = String(v ?? '').toLowerCase();
  if (!SHA.test(s)) throw new Error(`${what} must be a 40-character commit sha`);
  return s;
};
const iso = (v: unknown, what: string) => {
  const d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) throw new Error(`${what} must be a time`);
  return d.toISOString();
};
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const EVENTS = {
  // GitHub merged the pull request: observed by the merge itself, or by
  // recovery reading GitHub after a crash lost the merge's own append.
  Merged: (p: any) => ({
    sessionId: int(p?.sessionId, 'sessionId'),
    mergeSha: sha(p?.mergeSha, 'mergeSha'),
    mergedAt: iso(p?.mergedAt, 'mergedAt'),
    force: p?.force === true,
    forcedBy: text(p?.forcedBy),
    tally: p?.tally == null ? null
      : { yes: count(p.tally.yes, 'tally.yes') ?? 0, required: count(p.tally.required, 'tally.required'), active: count(p.tally.active, 'tally.active') },
    observedBy: p?.observedBy === 'recovery' ? 'recovery' as const : 'merge' as const,
  }),
  // A carrier found this change among its pull request's commits.
  Included: (p: any) => {
    if (!['delivering', 'live', 'deploy_failed'].includes(p?.carrierState)) throw new Error('carrierState is unknown');
    return {
      sessionId: int(p?.sessionId, 'sessionId'),
      carrier: {
        sessionId: int(p?.carrier?.sessionId, 'carrier.sessionId'),
        prNumber: optInt(p?.carrier?.prNumber, 'carrier.prNumber'),
        prTitle: text(p?.carrier?.prTitle),
        mergeSha: sha(p?.carrier?.mergeSha, 'carrier.mergeSha'),
        mergedAt: iso(p?.carrier?.mergedAt, 'carrier.mergedAt'),
        force: p?.carrier?.force === true,
      },
      carrierState: p.carrierState as 'delivering' | 'live' | 'deploy_failed',
      deliveredSha: sha(p?.deliveredSha, 'deliveredSha'),
    };
  },
  // Production of this app now runs `sha` (a rebuild that succeeded, or the
  // platform's own release booting). Whether it contains the merge is the
  // machine's to check.
  Deployed: (p: any) => ({ sha: sha(p?.sha, 'sha', true)! }),
  CarrierDelivered: (p: any) => ({ sha: sha(p?.sha, 'sha') }),
  CarrierDeployFailed: (p: any) => ({ message: text(p?.message) || 'the deploy failed' }),
  RetryDelivery: () => ({}),
  RetryFollowup: (p: any) => {
    if (typeof p?.workKey !== 'string' || !p.workKey) throw new Error('workKey is required');
    return { workKey: p.workKey as string };
  },
};

// ── Copy ────────────────────────────────────────────────────────────────

const prRef = (d: { prNumber: number | null; sessionId: number }) => `PR #${d.prNumber || d.sessionId}`;
const label = (d: { prNumber: number | null; sessionId: number; prTitle: string | null }) =>
  (d.prTitle ? `${prRef(d)}: ${d.prTitle}` : prRef(d));
const legacyRow = (r: { sessionId: number; prNumber: number | null; prTitle: string | null }) =>
  ({ id: r.sessionId, pr_number: r.prNumber, pr_title: r.prTitle });

function failureLine(d: Data, message: string): string {
  return `${label(d)} merged on GitHub, but the production deploy failed: ${message}. `
    + 'The change is on main; it goes live with the next deploy that succeeds.';
}

// ── Outcomes ────────────────────────────────────────────────────────────

const chat = (e: Event<any>, appId: number, sessionId: number, content: string, metadata: Json = null): DomainWrite =>
  ({ type: 'chat', eventId: e.id, appId, thread: { type: 'session', ref: sessionId }, content, metadata });
const voteUpdate = (d: Data, extra: object): Notification =>
  ({ type: 'voteUpdate', sessionId: d.sessionId, appSlug: d.appSlug, appId: d.appId, merged: true, merging: false, selfHosted: d.selfHosted, ...extra });

// Every work item is a follow-up the admin view can read.
function track(data: Data, work: WorkRequest[]): Data {
  const followups = { ...data.followups };
  for (const w of work) followups[w.key] = { kind: w.kind, input: w.input, status: 'pending' };
  return { ...data, followups };
}

interface Extra { writes?: DomainWrite[]; work?: WorkRequest[]; messages?: Outcome['messages']; notify?: Notification[] }

// Writes that can add thread lines; their lines are broadcast after commit.
const LINES = new Set(['chat', 'secrets', 'bounties', 'mergedLine']);

function outcome(name: Going['name'], data: Data, x: Extra = {}): Outcome<MFState> {
  const work = x.work || [];
  const notify = [...(x.notify || [])];
  const lined = (x.writes || []).find((w) => LINES.has(w.type));
  if (lined) notify.push({ type: 'chat', appId: data.appId, eventId: lined.eventId });
  return { next: { name, data: track(data, work) }, writes: x.writes, work, messages: x.messages, notify };
}

const carrierRef = (d: Data): CarrierRef => ({ sessionId: d.sessionId, prNumber: d.prNumber, prTitle: d.prTitle });

// Production runs a build containing the change: it is live, and now it is said.
function toLive(e: Event<any>, data: Data, deliveredSha: string | null, ctx: TransitionContext, x: Extra = {}): Outcome<MFState> {
  const d = { ...data, deliveredSha, liveAt: ctx.now.toISOString(), failure: null };
  const writes = [...(x.writes || [])];
  if (d.role === 'merge') writes.push({ type: 'mergedLine', eventId: e.id, ...lineInput(d) });
  writes.push({ type: 'mergedNotification', sessionId: d.sessionId, appId: d.appId, userId: d.authorId, force: d.force,
    mergedAt: d.mergedAt, includedIn: d.includedIn });
  const work: WorkRequest[] = [...(x.work || []),
    { kind: WORK.dm, key: 'dm', input: { sessionId: d.sessionId, sha: deliveredSha } },
    { kind: WORK.journey, key: 'journey', input: { sessionId: d.sessionId, sha: deliveredSha, at: d.mergedAt } }];
  const messages = [...(x.messages || []), ...d.included.map((id) => ({
    to: { machine: MACHINE, key: sessionKey(id) }, event: { type: 'CarrierDelivered', payload: { sha: deliveredSha } },
  }))];
  const notify = [...(x.notify || []), voteUpdate(d, { live: true }),
    { type: 'mergedNotification', sessionId: d.sessionId, userId: d.authorId }];
  if (d.role === 'merge') notify.push({ type: 'appVersion', appId: d.appId, appSlug: d.appSlug, sha: deliveredSha, prNumber: d.prNumber });
  return outcome('live', d, { writes, work, messages, notify });
}

function lineInput(d: Data) {
  return { sessionId: d.sessionId, appId: d.appId, userId: d.authorId, prNumber: d.prNumber, prTitle: d.prTitle,
    mergedAt: d.mergedAt, force: d.force, forcedBy: d.forcedBy, tally: d.tally as Json };
}

function toFailed(e: Event<any>, data: Data, message: string, x: Extra = {}): Outcome<MFState> {
  const d = { ...data, failure: message };
  const writes = [...(x.writes || [])];
  if (d.role === 'merge') writes.push(chat(e, d.appId, d.sessionId, failureLine(d, message)));
  const messages = [...(x.messages || []), ...d.included.map((id) => ({
    to: { machine: MACHINE, key: sessionKey(id) }, event: { type: 'CarrierDeployFailed', payload: { message } },
  }))];
  return outcome('deploy_failed', d, { ...x, writes, messages, notify: [...(x.notify || []), voteUpdate(d, { deployFailed: true })] });
}

function deliverWork(d: Data, f: Facts | null): WorkRequest {
  const key = d.deliveries > 1 ? `deliver~${d.deliveries}` : 'deliver';
  // Demo mode deploys the image the checks ran against when its tree is
  // the merged tree (staging.rebuildProduction verifies it).
  const s = f?.session?.staging;
  const reuse = f?.app?.demoMode && s && f.app.repo ? { ...s, ...f.app.repo } : null;
  return { kind: WORK.deliver, key, input: { appId: d.appId, sessionId: d.sessionId, mergeSha: d.mergeSha, prNumber: d.prNumber, reuse } };
}

// What every merged change has to have done: its preview and worker go, the
// bot stops its other work on the request, and the requests close.
function settleWork(d: Data, linkedIssues: number[], closeOnly: boolean): WorkRequest[] {
  const work: WorkRequest[] = [
    { kind: WORK.teardown, key: 'teardown', input: { sessionId: d.sessionId } },
    { kind: WORK.retire, key: 'worker', input: { sessionId: d.sessionId } },
    { kind: WORK.bot, key: 'bot', input: { sessionId: d.sessionId, before: d.mergedAt } },
  ];
  if (d.repo && d.prNumber && (!closeOnly || linkedIssues.length)) {
    work.push({ kind: WORK.issues, key: 'issues', input: {
      sessionId: d.sessionId, appId: d.appId, appSlug: d.appSlug, prNumber: d.prNumber, ...d.repo, linkedIssues, closeOnly,
      ...(d.includedIn ? { carrierPrNumber: d.includedIn.prNumber } : {}),
    } });
  }
  return work;
}

// The writes every merged change makes in the transition that marks it.
function settleWrites(e: Event<any>, d: Data, s: NonNullable<Facts['session']>): DomainWrite[] {
  return [
    { type: 'event', eventType: 'pr_merged', userId: d.authorId, appId: d.appId, sessionId: d.sessionId, metadata: {
      prNumber: d.prNumber, forced: d.force, ...(d.forcedBy ? { forcedBy: d.forcedBy } : {}),
      ...(d.includedIn ? { includedIn: d.includedIn.sessionId } : {}),
    } },
    { type: 'bounties', eventId: e.id, sessionId: d.sessionId, appId: d.appId, userId: d.authorId, prNumber: d.prNumber, numbers: s.linkedIssues },
    { type: 'agentNote', sessionId: d.sessionId, agentSessionId: s.agentSessionId, prNumber: d.prNumber },
    { type: 'bell', sessionId: d.sessionId },
  ];
}

function merged(e: Event<any>, f: Facts): Outcome<MFState> {
  const s = f.session!;
  const app = f.app!;
  const p = e.payload;
  const d: Data = {
    sessionId: s.id, appId: s.appId, appSlug: app.slug, role: 'merge', prNumber: s.prNumber, prTitle: s.prTitle,
    authorId: s.userId, repo: app.repo, mergeSha: p.mergeSha, mergedAt: p.mergedAt, force: p.force, forcedBy: p.forcedBy,
    tally: p.tally, selfHosted: app.selfHosted, includedIn: null, included: [], deliveries: 1,
    deliveredSha: null, liveAt: null, failure: null, followups: {},
  };
  // The platform's own app is released by its pipeline, not by this
  // process: its release booting appends Deployed.
  const work: WorkRequest[] = app.selfHosted ? [] : [deliverWork(d, f)];
  work.push(...settleWork(d, s.linkedIssues, false));
  if (d.repo && d.prNumber) {
    work.push({ kind: WORK.find, key: 'included', input: { sessionId: d.sessionId, appId: d.appId, prNumber: d.prNumber, ...d.repo } });
  }
  if (d.mergeSha) work.push({ kind: WORK.mainCheck, key: 'main-check', input: { appId: d.appId, sessionId: d.sessionId, prNumber: d.prNumber, mergeSha: d.mergeSha } });
  const notify: Notification[] = [voteUpdate(d, {}), { type: 'kickQueue', appId: d.appId, excludeSessionId: d.sessionId },
    { type: 'bell', sessionId: d.sessionId }];
  if (app.selfHosted) notify.push({ type: 'nudgeDeployer', sha: d.mergeSha, prNumber: d.prNumber });
  return outcome('delivering', d, {
    writes: [{ type: 'secrets', eventId: e.id, sessionId: d.sessionId, appId: d.appId }, ...settleWrites(e, d, s)],
    work, notify,
  });
}

// Why a carried change can no longer be included: [main]'s CANDIDATES_SQL
// and MARK_SQL conditions, now read under the change's own lock. The
// message is then refused and no instance is made, so the change can still
// merge on its own, or be included by a later merge.
function notIncludable(f: Facts, carrierAppId: number | null): string | null {
  const s = f.session;
  if (!s) return 'no_session';
  if (carrierAppId != null && s.appId !== carrierAppId) return 'other_app';
  if (s.status !== 'promoted') return 'moved_on';
  if (s.activeTurn) return 'turn_running';
  if (s.isHeadless) return 'headless';
  if (!s.prNumber) return 'no_pull_request';
  if (s.pendingSecrets) return 'holds_secret_values';
  return null;
}

function included(e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<MFState> {
  const p = e.payload;
  const c = p.carrier;
  const ref: CarrierRef = { sessionId: c.sessionId, prNumber: c.prNumber, prTitle: c.prTitle };
  const s = f.session!;
  const app = f.app!;
  const d: Data = {
    sessionId: s.id, appId: s.appId, appSlug: app.slug, role: 'included', prNumber: s.prNumber, prTitle: s.prTitle,
    authorId: s.userId, repo: app.repo, mergeSha: c.mergeSha, mergedAt: c.mergedAt, force: c.force, forcedBy: null,
    tally: null, selfHosted: app.selfHosted, includedIn: ref, included: [], deliveries: 0,
    deliveredSha: null, liveAt: null, failure: null, followups: {},
  };
  const changes = legacy('services/included-changes');
  const work = settleWork(d, s.linkedIssues, true);
  if (d.repo && d.prNumber) {
    work.unshift({ kind: WORK.closePr, key: 'close-pr', input: {
      ...d.repo, number: d.prNumber, comment: changes.closingComment(legacyRow(ref)), marker: `homeroom-included-${d.sessionId}`,
    } });
  }
  const x: Extra = {
    writes: [...settleWrites(e, d, s), chat(e, d.appId, d.sessionId, changes.threadLine(legacyRow(d), legacyRow(ref)),
      { included: { sessionId: d.sessionId, inSessionId: ref.sessionId, inPrNumber: ref.prNumber } })],
    work,
    notify: [voteUpdate(d, { includedIn: ref.sessionId }), { type: 'bell', sessionId: d.sessionId }],
  };
  if (p.carrierState === 'live') return toLive(e, d, p.deliveredSha, ctx, x);
  if (p.carrierState === 'deploy_failed') return toFailed(e, d, 'the change that carried it did not deploy', { ...x });
  return outcome('delivering', d, x);
}

// A work result updates its follow-up; app.deliver and delivery.verify can
// also make the change live, and included.find hands the carried changes on.
function workResult(status: Followup['status']) {
  return {
    guard: (s: any, e: Event<WorkResultPayload>): Check =>
      (s.data.followups[e.payload.workKey]?.status === 'pending' ? ok() : reject('stale_result')),
    to: (s: any, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<MFState> => {
      const p = e.payload;
      const prev = s.data.followups[p.workKey]!;
      const d: Data = { ...s.data, followups: { ...s.data.followups,
        [p.workKey]: { ...prev, status, ...(p.error ? { error: p.error.message } : {}) } } };
      const result = (p.result || {}) as { sha?: string; contains?: boolean; ids?: number[] };
      if (p.kind === WORK.deliver && s.name !== 'live') {
        if (status === 'done') return toLive(e, d, result.sha || d.mergeSha, ctx);
        if (s.name === 'delivering') return toFailed(e, d, p.error?.message || 'the deploy failed');
      }
      if (p.kind === WORK.verify && status === 'done' && result.contains && s.name !== 'live') {
        return toLive(e, d, result.sha || null, ctx);
      }
      if (p.kind === WORK.find && status === 'done') {
        const found = (Array.isArray(result.ids) ? result.ids : []).filter((id) => Number.isInteger(id) && !d.included.includes(id));
        const next = { ...d, included: [...d.included, ...found] };
        return { next: { name: s.name, data: next }, messages: found.map((id) => ({
          to: { machine: MACHINE, key: sessionKey(id) },
          event: { type: 'Included', payload: {
            sessionId: id, carrier: { ...carrierRef(d), mergeSha: d.mergeSha, mergedAt: d.mergedAt, force: d.force },
            carrierState: s.name, deliveredSha: d.deliveredSha,
          } },
        })) };
      }
      return { next: { name: s.name, data: d } };
    },
  };
}

const fromCarrier = (s: any, e: Event<any>): Check =>
  (s.data.role === 'included' && e.source.kind === 'message' && e.source.from.key === sessionKey(s.data.includedIn!.sessionId)
    ? ok() : reject('not_the_carrier'));

// A production deploy of `sha`: the merge commit itself is live at once;
// any other build is checked against GitHub (delivery.verify).
const deployed = {
  guard: (s: any, e: Event<any>): Check => {
    if (s.data.role !== 'merge') return reject('carrier_delivers');
    if (!s.data.mergeSha) return reject('no_merge_commit');
    if (s.data.followups[`verify:${e.payload.sha}`]) return reject('already_checking');
    return ok();
  },
  to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<MFState> => {
    if (e.payload.sha === s.data.mergeSha) return toLive(e, s.data, e.payload.sha, ctx);
    if (!s.data.repo) return { next: s };
    return outcome(s.name, s.data, { work: [{ kind: WORK.verify, key: `verify:${e.payload.sha}`,
      input: { ...s.data.repo, mergeSha: s.data.mergeSha, sha: e.payload.sha } }] });
  },
};

const retryFollowup = {
  guard: (s: any, e: Event<any>): Check => {
    const f = s.data.followups[e.payload.workKey];
    if (f?.kind === WORK.deliver) return reject('use_retry_delivery');
    return f && ['failed', 'exhausted'].includes(f.status) ? ok() : reject('not_retryable');
  },
  to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<MFState> => {
    const prev = s.data.followups[e.payload.workKey]!;
    const key = `${e.payload.workKey.replace(/~\d+$/, '')}~${ctx.version + 1}`;
    const d = { ...s.data, followups: { ...s.data.followups, [e.payload.workKey]: { ...prev, status: 'retried' as const } } };
    return outcome(s.name, d, { work: [{ kind: prev.kind, key, input: prev.input, continues: e.payload.workKey }] });
  },
};

// ── The machine ─────────────────────────────────────────────────────────

export interface MachineDeps {
  dataKey: string;   // config.dataEncryptionKey, for the declared secret values
  notifiers: Record<string, (n: any) => void | Promise<void>>;
}

export function mergeFollowups(deps: MachineDeps): Machine<MFState, Facts> {
  for (const n of NOTIFIERS) if (typeof deps.notifiers[n] !== 'function') throw new Error(`merge-followups: notifier ${n} missing`);
  const system = (e: Event<any>): Check => (e.source.kind === 'system' ? ok() : reject('internal_only'));
  const ownMessage = (e: Event<any>): Check =>
    (e.source.kind === 'message' && e.source.from.machine === MACHINE ? ok() : reject('internal_only'));
  const admin = (e: Event<any>): Check => (e.source.kind === 'admin' ? ok() : reject('admin_only'));
  const works = { WorkSucceeded: workResult('done'), WorkFailed: workResult('failed'), WorkExhausted: workResult('exhausted') };
  const created = { Merged: { ignore: 'already_merged' }, Included: { ignore: 'already_merged' } };

  return defineMachine<MFState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['Merged', 'Included'],
    terminal: ['live'],
    decode: (row) => ({ name: row.state, data: row.data } as MFState),
    // Only the creating events read anything: the row they move into 'merged'.
    facts: (tx, state, event) => (state.name === NONE && (event.type === 'Merged' || event.type === 'Included')
      ? readFacts(tx, event.payload.sessionId, { lock: true })
      : Promise.resolve({ session: null, app: null })),
    authorize: {
      Merged: system,
      Included: ownMessage,
      Deployed: system,
      CarrierDelivered: ownMessage,
      CarrierDeployFailed: ownMessage,
      RetryDelivery: admin,
      RetryFollowup: admin,
    },
    transitions: {
      [NONE]: {
        Merged: {
          guard: (s, e, f, ctx) => (ctx.key !== sessionKey(e.payload.sessionId) ? reject('key_mismatch')
            : !f.session || !f.app ? reject('no_session')
              : f.session.status === 'merged' ? reject('already_merged')
                : !['promoted', 'merging'].includes(f.session.status) ? reject('not_merging') : ok()),
          to: (s, e, f) => merged(e, f),
        },
        Included: {
          guard: (s, e, f, ctx) => {
            if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
            const reason = notIncludable(f, e.appId);
            return reason ? reject(reason) : ok();
          },
          to: (s, e, f, ctx) => included(e, f, ctx),
        },
      },
      delivering: {
        ...created,
        ...works,
        Deployed: deployed,
        CarrierDelivered: { guard: fromCarrier, to: (s, e, f, ctx) => toLive(e, (s as Going).data, e.payload.sha, ctx) },
        CarrierDeployFailed: { guard: fromCarrier, to: (s, e) => toFailed(e, (s as Going).data, e.payload.message) },
        RetryDelivery: { ignore: 'not_failed' },
        RetryFollowup: retryFollowup,
      },
      deploy_failed: {
        ...created,
        ...works,
        Deployed: deployed,
        CarrierDelivered: { guard: fromCarrier, to: (s, e, f, ctx) => toLive(e, (s as Going).data, e.payload.sha, ctx) },
        CarrierDeployFailed: { ignore: 'already_failed' },
        RetryDelivery: {
          guard: (s) => ((s as Going).data.role === 'merge' && !(s as Going).data.selfHosted ? ok() : reject('carrier_delivers')),
          to: (s) => {
            const d = { ...(s as Going).data, deliveries: (s as Going).data.deliveries + 1, failure: null };
            return outcome('delivering', d, { work: [deliverWork(d, null)] });
          },
        },
        RetryFollowup: retryFollowup,
      },
      live: {
        ...created,
        ...works,
        Deployed: { ignore: 'already_live' },
        CarrierDelivered: { ignore: 'already_live' },
        CarrierDeployFailed: { ignore: 'already_live' },
        RetryDelivery: { ignore: 'already_live' },
        RetryFollowup: retryFollowup,
      },
    },
    writes: {
      chat: writeChat,
      event: async (tx, w) => tx.query(
        `INSERT INTO events (user_id, app_id, session_id, event_type, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [w.userId ?? null, w.appId, w.sessionId, w.eventType, JSON.stringify(w.metadata || {})]),
      secrets: (tx, w) => writeSecrets(tx, w, deps.dataKey),
      bounties: writeBounties,
      agentNote: async (tx, w) => {
        if (!w.agentSessionId) return;
        await legacy('services/agent-sessions').noteChangeClosed(tx,
          { change: { id: w.sessionId, agent_session_id: w.agentSessionId, pr_number: w.prNumber }, outcome: 'merged' });
      },
      bell: (tx, w) => legacy('services/notifications').settleDecidedChange(tx, w.sessionId, { status: 'merged', push: false }),
      mergedLine: writeMergedLine,
      mergedNotification: writeMergedNotification,
    },
    async project(tx, before, after) {
      if (after.name === NONE) return;
      const d = (after as Going).data;
      const live = after.name === 'live' ? d.liveAt : null;
      if (before.name === NONE) {
        await tx.query(
          `UPDATE chat_sessions
              SET status = 'merged', merged_at = $2, live_at = $3,
                  merge_commit_sha = COALESCE($4, merge_commit_sha),
                  included_in_session_id = $5,
                  votes_required = COALESCE(votes_required, $6), active_users_at_merge = COALESCE(active_users_at_merge, $7)
            WHERE id = $1`,
          [d.sessionId, d.mergedAt, live, d.mergeSha, d.includedIn?.sessionId ?? null,
            d.tally?.required ?? null, d.tally?.active ?? null]);
      } else if (live && before.name !== 'live') {
        await tx.query('UPDATE chat_sessions SET live_at = $2 WHERE id = $1', [d.sessionId, live]);
      }
    },
    notifiers: deps.notifiers,
  });
}

// ── Domain writes ───────────────────────────────────────────────────────

// A thread line, marked with its event so the chat notifier broadcasts it.
async function writeChat(tx: Tx, w: any) {
  await tx.query(
    `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, 'system', $3, $4, $5)`,
    [w.appId, w.content, JSON.stringify({ ...(w.metadata || {}), wfEvent: w.eventId }), w.thread.type, w.thread.ref]);
}
const line = (tx: Tx, eventId: number, appId: number, sessionId: number, content: string, metadata: Json = null) =>
  writeChat(tx, { eventId, appId, content, metadata, thread: { type: 'session', ref: sessionId } });

// The values this proposal declared, written with the merge.
async function writeSecrets(tx: Tx, w: any, dataKey: string) {
  const { applied, refused } = await legacy('services/pending-secrets').applyInTransaction(tx, { sessionId: w.sessionId, dataKey });
  for (const a of applied) {
    if (!a.hadValue) continue;
    await line(tx, w.eventId, w.appId, w.sessionId, a.scope === 'platform'
      ? `Platform variable "${a.key}" was declared and set by this proposal; takes effect on the platform's next deploy.`
      : `Secret "${a.key}" was declared and set by this proposal; redeploying…`);
    if (a.scope === 'platform') {
      await tx.query(
        `INSERT INTO events (user_id, app_id, event_type, metadata) VALUES ($1, $2, 'platform_env_changed', $3::jsonb)`,
        [a.userId, w.appId, JSON.stringify({ key: a.key, action: 'set', private: a.private, appliedBy: 'declaration-proposal' })]);
    }
  }
  for (const r of refused) {
    await line(tx, w.eventId, w.appId, w.sessionId, `Couldn't apply the value declared with this proposal for ${r.key}: ${r.reason}`);
  }
}

// Bounties on the requests it closes go to its author, with their events
// and lines in the same transaction.
async function writeBounties(tx: Tx, w: any) {
  const votes = legacy('routes/votes');
  for (const n of w.numbers as number[]) {
    const { awarded } = await votes.resolveIssueBounty(tx, { appId: w.appId, sessionId: w.sessionId, awardeeUserId: w.userId, issueNumber: n });
    if (!awarded.length) continue;
    await tx.query(
      `INSERT INTO events (user_id, app_id, session_id, event_type, metadata) VALUES ($1, $2, $3, 'bounty_awarded', $4::jsonb)`,
      [w.userId ?? null, w.appId, w.sessionId, JSON.stringify({ issueNumber: n, prNumber: w.prNumber, count: awarded.length })]);
    const recipient = w.userId ? `<@${w.userId}>` : 'the author';
    await line(tx, w.eventId, w.appId, w.sessionId,
      `Bounty on issue #${n} (${awarded.length} kudos) awarded to ${recipient} for PR #${w.prNumber || w.sessionId}`);
  }
}

// "<title> is live (PR #n). Built by …, backed by … (yes/active votes)",
// with the names as metadata, as [main]'s merge wrote it.
async function writeMergedLine(tx: Tx, w: any) {
  const votes = legacy('routes/votes');
  const session = { id: w.sessionId, app_id: w.appId, user_id: w.userId };
  const credits = w.force ? null : await votes.mergeCredits(tx, session, { before: w.mergedAt });
  const d = { sessionId: w.sessionId, prNumber: w.prNumber, prTitle: w.prTitle };
  const yes = w.tally?.yes ?? 0;
  const active = w.tally?.active ?? w.tally?.required ?? yes;
  const content = w.force
    ? `${label(d)} force-merged by admin ${w.forcedBy || 'an admin'} (${yes}/${active} vote${yes === 1 ? '' : 's'} at the time)`
    : `${w.prTitle || prRef(d)} ${w.prTitle ? `is live (${prRef(d)})` : 'is live'}. ${credits ? votes.creditsSentence(credits) : 'Thanks to everyone who voted'} (${yes}/${active} votes)`;
  const metadata = credits ? { merged: {
    sessionId: w.sessionId, prNumber: w.prNumber || null, title: w.prTitle || '', author: credits.author || '',
    backers: credits.backers, shapers: credits.shapers, votes: `${yes}/${active}`,
  } } : null;
  await line(tx, w.eventId, w.appId, w.sessionId, content, metadata);
}

// The author's "your change is live", once (the push trigger rings it).
async function writeMergedNotification(tx: Tx, w: any) {
  if (!w.userId) return;
  let credits: string | null = null;
  if (w.includedIn) {
    credits = legacy('services/included-changes').authorLine(legacyRow(w.includedIn));
  } else if (!w.force) {
    const votes = legacy('routes/votes');
    const c = await votes.mergeCredits(tx, { id: w.sessionId, app_id: w.appId, user_id: w.userId }, { before: w.mergedAt });
    credits = votes.creditsSentence(c, { withAuthor: false }) || null;
  }
  await legacy('services/notifications').createPrMergedNotification(tx, {
    userId: w.userId, appId: w.appId, sessionId: w.sessionId, forced: !!w.force, credits,
  });
}
