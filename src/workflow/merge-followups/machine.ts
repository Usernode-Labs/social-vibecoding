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
  Check, DomainWrite, Event, Json, Machine, Notification, Outcome, Push, TransitionContext, Tx, WorkRequest,
  WorkResultPayload, WriteContext,
} from '../kernel/index.ts';
import { changeClosed } from '../rules/agent-notes.ts';
import { resolveIssueBounty } from '../rules/bounties.ts';
import { createPrMergedNotification, settleDecidedChange } from '../rules/change-notifications.ts';
import { authorLine, closingComment, liveLine, threadLine } from '../rules/included-lines.ts';
import { creditsSentence, mergeCredits } from '../rules/merge-credits.ts';
import { applyInTransaction } from '../rules/pending-secret-apply.ts';
import { appVersion, chatLine, issuesClosed, issueUpdate, toUser, voteUpdate as votePush } from '../pushes.ts';
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

// Post-commit kicks into flows not migrated yet. What browsers hear is a
// push, published with the transition (thread lines, the vote card, the
// version pill, the bell).
export const NOTIFIERS = ['kickQueue', 'nudgeDeployer', 'boardChange', 'badgeSync'] as const;

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
      // The head the carrier found among its commits (absent from a message
      // sent before it was carried: then the head is not compared).
      head: sha(p?.head, 'head'),
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

// How far before a merge a recorded boot still counts as possibly after it.
const BOOT_CLOCK_MARGIN_MS = 5 * 60 * 1000;
// How long to wait before looking again at a shots run that keeps the
// change's worker (worker.retire).
const RETIRE_RECHECK_MS = 2 * 60 * 1000;

// ── Copy ────────────────────────────────────────────────────────────────

const prRef = (d: { prNumber: number | null; sessionId: number }) => `PR #${d.prNumber || d.sessionId}`;
const label = (d: { prNumber: number | null; sessionId: number; prTitle: string | null }) =>
  (d.prTitle ? `${prRef(d)}: ${d.prTitle}` : prRef(d));
const prRow = (r: { sessionId: number; prNumber: number | null; prTitle: string | null }) =>
  ({ id: r.sessionId, pr_number: r.prNumber, pr_title: r.prTitle });

function failureLine(d: Data, message: string): string {
  return `${label(d)} merged on GitHub, but the production deploy failed: ${message}. `
    + 'The change is on main; it goes live with the next deploy that succeeds.';
}

// ── Outcomes ────────────────────────────────────────────────────────────

const chat = (e: Event<any>, appId: number, sessionId: number, content: string, metadata: Json = null): DomainWrite =>
  ({ type: 'chat', eventId: e.id, appId, thread: { type: 'session', ref: sessionId }, content, metadata });
const voteUpdate = (d: Data, extra: Record<string, Json>): Push =>
  votePush({ sessionId: d.sessionId, appSlug: d.appSlug, appId: d.appId, merged: true, merging: false, selfHosted: d.selfHosted, ...extra });

// Every work item is a follow-up the admin view can read.
function track(data: Data, work: WorkRequest[]): Data {
  const followups = { ...data.followups };
  for (const w of work) followups[w.key] = { kind: w.kind, input: w.input, status: 'pending' };
  return { ...data, followups };
}

interface Extra {
  writes?: DomainWrite[]; work?: WorkRequest[]; messages?: Outcome['messages']; push?: Push[]; notify?: Notification[];
}

// The writes that add thread lines push them with the rows they inserted.
function outcome(name: Going['name'], data: Data, x: Extra = {}): Outcome<MFState> {
  const work = x.work || [];
  return { next: { name, data: track(data, work) }, writes: x.writes, work, messages: x.messages, push: x.push, notify: x.notify };
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
  const push = [...(x.push || []), voteUpdate(d, { live: true })];
  if (d.role === 'merge') push.push(appVersion({ appId: d.appId, appSlug: d.appSlug, sha: deliveredSha, prNumber: d.prNumber }));
  return outcome('live', d, { writes, work, messages, push, notify: x.notify });
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
  return outcome('deploy_failed', d, { ...x, writes, messages, push: [...(x.push || []), voteUpdate(d, { deployFailed: true })] });
}

function deliverWork(d: Data, f: Facts | null): WorkRequest {
  const key = d.deliveries > 1 ? `deliver~${d.deliveries}` : 'deliver';
  // Demo mode deploys the image the checks ran against when its tree is
  // the merged tree (staging.rebuildProduction verifies it).
  const s = f?.session?.staging;
  const reuse = f?.app?.demoMode && s && f.app.repo ? { ...s, ...f.app.repo } : null;
  return { kind: WORK.deliver, key, input: { appId: d.appId, sessionId: d.sessionId, mergeSha: d.mergeSha, prNumber: d.prNumber, reuse } };
}

// Its preview goes. For a merge that is delivered here, only once the
// delivery has its result: in demo mode the delivery deploys the preview's
// own build, and the teardown drops the preview's reference to it.
const teardownWork = (d: Data): WorkRequest => ({ kind: WORK.teardown, key: 'teardown', input: { sessionId: d.sessionId } });

// What every merged change has to have done: its preview and worker go, the
// bot stops its other work on the request, and the requests close.
function settleWork(d: Data, linkedIssues: number[], closeOnly: boolean, { teardown = true } = {}): WorkRequest[] {
  const work: WorkRequest[] = [
    ...(teardown ? [teardownWork(d)] : []),
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

function merged(e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<MFState> {
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
  work.push(...settleWork(d, s.linkedIssues, false, { teardown: app.selfHosted }));
  if (d.repo && d.prNumber) {
    work.push({ kind: WORK.find, key: 'included', input: { sessionId: d.sessionId, appId: d.appId, prNumber: d.prNumber, ...d.repo } });
  }
  if (d.mergeSha) work.push({ kind: WORK.mainCheck, key: 'main-check', input: { appId: d.appId, sessionId: d.sessionId, prNumber: d.prNumber, mergeSha: d.mergeSha } });
  const notify: Notification[] = [{ type: 'kickQueue', appId: d.appId, excludeSessionId: d.sessionId },
    { type: 'badgeSync', sessionId: d.sessionId }];
  if (app.selfHosted) notify.push({ type: 'nudgeDeployer', sha: d.mergeSha, prNumber: d.prNumber });
  // The requests it closes stop showing as open in every web process at
  // once, as [main]'s merge had its own process do (GitHub closes
  // `Closes #N` late); issues.closeAfterMerge makes sure they close.
  const push: Push[] = [voteUpdate(d, {})];
  if (d.repo && s.linkedIssues.length) push.push(issuesClosed({ ...d.repo, numbers: s.linkedIssues }));
  const x: Extra = {
    writes: [{ type: 'secrets', eventId: e.id, sessionId: d.sessionId, appId: d.appId }, ...settleWrites(e, d, s)],
    work, notify, push,
  };
  // The platform's own release reports itself when it boots, to the merges
  // waiting then. A merge recorded after such a boot (recovery finding it
  // late) checks the builds booted since it merged, any of which may contain
  // it: live_at is when production first ran it. A build that booted before
  // the merge cannot contain it (a margin for clocks), so an ordinary merge,
  // recorded at once, checks nothing here.
  if (app.selfHosted && d.mergeSha) {
    const since = Date.parse(d.mergedAt) - BOOT_CLOCK_MARGIN_MS;
    const after = app.booted.filter((b) => Date.parse(b.at) >= since);
    const exact = after.find((b) => b.sha === d.mergeSha);
    if (exact) return toLive(e, d, exact.sha, ctx, x);
    if (d.repo) for (const b of after) work.push(verifyWork(d, b.sha));
  }
  return outcome('delivering', d, x);
}

// Why a carried change can no longer be included: [main]'s CANDIDATES_SQL
// and MARK_SQL conditions, now read under the change's own lock. The
// message is then refused and no instance is made, so the change can still
// merge on its own, or be included by a later merge.
//
// What is working on it is read from the durable record of each: the turn's
// journal (active_turn), a live shots run, checks running, and the head
// itself. A sync with main, a hand-off upload or a Mayor dispatch keeps no
// record of its own while it runs, but whatever it changes moves the head,
// and a moved head is refused: the change merges on its own instead.
function notIncludable(f: Facts, carrierAppId: number | null, head: string | null): string | null {
  const s = f.session;
  if (!s) return 'no_session';
  if (carrierAppId != null && s.appId !== carrierAppId) return 'other_app';
  if (s.status !== 'promoted') return 'moved_on';
  if (s.activeTurn) return 'turn_running';
  if (head && s.head !== head) return 'head_moved';
  if (s.shotsRunning) return 'shots_running';
  if (s.checksRunning) return 'checks_running';
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
  // "Went live" only when it has: until its carrier is live, it is merged and
  // goes live with it (the thread says so again on CarrierDelivered).
  const live = p.carrierState === 'live';
  const work = settleWork(d, s.linkedIssues, true);
  if (d.repo && d.prNumber) {
    work.unshift({ kind: WORK.closePr, key: 'close-pr', input: {
      ...d.repo, number: d.prNumber, comment: closingComment(prRow(ref), { live }), marker: `homeroom-included-${d.sessionId}`,
    } });
  }
  const x: Extra = {
    writes: [...settleWrites(e, d, s), chat(e, d.appId, d.sessionId, threadLine(prRow(d), prRow(ref), { live }),
      { included: { sessionId: d.sessionId, inSessionId: ref.sessionId, inPrNumber: ref.prNumber } })],
    work,
    push: [voteUpdate(d, { includedIn: ref.sessionId })],
    notify: [{ type: 'badgeSync', sessionId: d.sessionId }],
  };
  if (p.carrierState === 'live') return toLive(e, d, p.deliveredSha, ctx, x);
  if (p.carrierState === 'deploy_failed') return toFailed(e, d, 'the change that carried it did not deploy', { ...x });
  return outcome('delivering', d, x);
}

// More work, added to an outcome already decided.
function andWork(out: Outcome<MFState>, work: WorkRequest[]): Outcome<MFState> {
  if (!work.length || out.next.name === NONE) return out;
  const next = out.next as Going;
  return { ...out, next: { name: next.name, data: track(next.data, work) }, work: [...(out.work || []), ...work] };
}

// A work result updates its follow-up; app.deliver and delivery.verify can
// also make the change live, and included.find hands the carried changes on.
// Delivery's first result, whatever it is, lets the preview go.
function workResult(status: Followup['status']) {
  const decide = resultOf(status);
  return {
    guard: (s: any, e: Event<WorkResultPayload>): Check =>
      (s.data.followups[e.payload.workKey]?.status === 'pending' ? ok() : reject('stale_result')),
    to: (s: any, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<MFState> => {
      const out = decide(s, e, f, ctx);
      return e.payload.kind === WORK.deliver && !s.data.followups.teardown ? andWork(out, [teardownWork(s.data)]) : out;
    },
  };
}

function resultOf(status: Followup['status']) {
  return (s: any, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<MFState> => {
    const p = e.payload;
    const prev = s.data.followups[p.workKey]!;
    const d: Data = { ...s.data, followups: { ...s.data.followups,
      [p.workKey]: { ...prev, status, ...(p.error ? { error: p.error.message } : {}) } } };
    const result = (p.result || {}) as { sha?: string; contains?: boolean; ids?: number[]; found?: { id: number; head: string }[] };
    if (p.kind === WORK.deliver && s.name !== 'live') {
      if (status === 'done') return deployedBuild(e, s.name, d, result.sha ? String(result.sha).toLowerCase() : null, ctx);
      if (s.name === 'delivering') return toFailed(e, d, p.error?.message || 'the deploy failed');
    }
    if (p.kind === WORK.verify && status === 'done' && result.contains && s.name !== 'live') {
      return toLive(e, d, result.sha || null, ctx);
    }
    // A shots run still works in the worker: the same retire, later.
    if (p.kind === WORK.retire && status === 'done' && (result as { waiting?: string }).waiting) {
      return outcome(s.name, d, { work: [{ kind: WORK.retire, key: `worker~${ctx.version + 1}`, input: prev.input,
        notBefore: new Date(ctx.now.getTime() + RETIRE_RECHECK_MS) }] });
    }
    if (p.kind === WORK.find && status === 'done') {
      // `found` carries each change's matched head; a result from before
      // it did names ids only.
      const named = Array.isArray(result.found) ? result.found
        : (Array.isArray(result.ids) ? result.ids : []).map((id) => ({ id, head: null as string | null }));
      const found = named.filter((c) => Number.isInteger(c.id) && !d.included.includes(c.id));
      const next = { ...d, included: [...d.included, ...found.map((c) => c.id)] };
      return { next: { name: s.name, data: next }, messages: found.map((c) => ({
        to: { machine: MACHINE, key: sessionKey(c.id) },
        event: { type: 'Included', payload: {
          sessionId: c.id, carrier: { ...carrierRef(d), mergeSha: d.mergeSha, mergedAt: d.mergedAt, force: d.force },
          carrierState: s.name, deliveredSha: d.deliveredSha, ...(c.head ? { head: c.head } : {}),
        } },
      })) };
    }
    // The requests it closed: every web process forgets its copy of the
    // open issues (an included change's own closes are named), and the
    // lists re-read. Only when it ran: GitHub off skips it, as [main]'s
    // merge did.
    if (p.kind === WORK.issues && status === 'done' && !(result as { skipped?: string }).skipped && d.repo) {
      const closeOnly = !!(prev.input as { closeOnly?: boolean } | null)?.closeOnly;
      const closed = closeOnly ? ((result as { closed?: unknown[] }).closed || []).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
      const cache = issuesClosed({ ...d.repo, numbers: closed });
      if (closeOnly) return { next: { name: s.name, data: d }, push: [cache] };
      return { next: { name: s.name, data: d }, push: [cache, issueUpdate({ action: 'github_synced', appSlug: d.appSlug, appId: d.appId, source: 'pr_merged' })],
        notify: [{ type: 'boardChange', appId: d.appId, appSlug: d.appSlug }] };
    }
    return { next: { name: s.name, data: d } };
  };
}

// An included change whose carrier is now live: it is live too, and its
// thread, which said it goes live with the carrier, says it is.
function carrierLive(e: Event<any>, d: Data, ctx: TransitionContext): Outcome<MFState> {
  const line = liveLine(prRow(d), prRow(d.includedIn!));
  return toLive(e, d, e.payload.sha, ctx, { writes: [chat(e, d.appId, d.sessionId, line)] });
}

const fromCarrier = (s: any, e: Event<any>): Check =>
  (s.data.role === 'included' && e.source.kind === 'message' && e.source.from.key === sessionKey(s.data.includedIn!.sessionId)
    ? ok() : reject('not_the_carrier'));

// Production runs `sha`. The merge commit itself is live at once; any other
// build is live only once GitHub says it contains the merge (delivery.verify),
// whoever deployed it, the merge's own delivery included: a rebuild deploys
// main's tip, which a rewritten main need not contain. Without a merge
// commit (GitHub off) there is nothing to compare, and the delivery is the
// fact.
function deployedBuild(e: Event<any>, name: Going['name'], d: Data, sha: string | null, ctx: TransitionContext): Outcome<MFState> {
  if (!d.mergeSha) return toLive(e, d, sha, ctx);
  if (sha === d.mergeSha) return toLive(e, d, sha, ctx);
  if (!sha || !d.repo || d.followups[`verify:${sha}`]) return { next: { name, data: d } };
  return outcome(name, d, { work: [verifyWork(d, sha)] });
}

const verifyWork = (d: Data, sha: string): WorkRequest =>
  ({ kind: WORK.verify, key: `verify:${sha}`, input: { ...d.repo!, mergeSha: d.mergeSha, sha } });

// A production deploy of `sha` reported from outside (Deployed).
const deployed = {
  guard: (s: any, e: Event<any>): Check => {
    if (s.data.role !== 'merge') return reject('carrier_delivers');
    if (!s.data.mergeSha) return reject('no_merge_commit');
    if (s.data.followups[`verify:${e.payload.sha}`]) return reject('already_checking');
    return ok();
  },
  to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<MFState> =>
    deployedBuild(e, s.name, s.data, e.payload.sha, ctx),
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
          to: (s, e, f, ctx) => merged(e, f, ctx),
        },
        Included: {
          guard: (s, e, f, ctx) => {
            if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
            const reason = notIncludable(f, e.appId, e.payload.head);
            return reason ? reject(reason) : ok();
          },
          to: (s, e, f, ctx) => included(e, f, ctx),
        },
      },
      delivering: {
        ...created,
        ...works,
        Deployed: deployed,
        CarrierDelivered: { guard: fromCarrier, to: (s, e, f, ctx) => carrierLive(e, (s as Going).data, ctx) },
        CarrierDeployFailed: { guard: fromCarrier, to: (s, e) => toFailed(e, (s as Going).data, e.payload.message) },
        RetryDelivery: { ignore: 'not_failed' },
        RetryFollowup: retryFollowup,
      },
      deploy_failed: {
        ...created,
        ...works,
        Deployed: deployed,
        CarrierDelivered: { guard: fromCarrier, to: (s, e, f, ctx) => carrierLive(e, (s as Going).data, ctx) },
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
      chat: (tx, w, ctx) => writeChat(tx, w, ctx),
      event: async (tx, w) => tx.query(
        `INSERT INTO events (user_id, app_id, session_id, event_type, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [w.userId ?? null, w.appId, w.sessionId, w.eventType, JSON.stringify(w.metadata || {})]),
      secrets: (tx, w, ctx) => writeSecrets(tx, w, deps.dataKey, ctx),
      bounties: writeBounties,
      agentNote: async (tx, w) => {
        if (!w.agentSessionId) return;
        await changeClosed(tx,
          { change: { id: w.sessionId, agent_session_id: w.agentSessionId, pr_number: w.prNumber }, outcome: 'merged' });
      },
      // Everyone whose bell the decision settled re-reads it: the asks
      // about this change, and digests it was the last one waiting in
      // (those name no session).
      bell: async (tx, w, ctx) => {
        for (const userId of await settleDecidedChange(tx, w.sessionId, { status: 'merged' })) {
          ctx.push(toUser(userId, { type: 'notifications_changed' }));
        }
      },
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

// A thread line, marked with its event, pushed to the app's room.
async function writeChat(tx: Tx, w: any, ctx: WriteContext) {
  const { rows: [row] } = await tx.query(
    `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, 'system', $3, $4, $5) RETURNING id, app_id, content, msg_type, metadata, thread_type, thread_ref, created_at`,
    [w.appId, w.content, JSON.stringify({ ...(w.metadata || {}), wfEvent: w.eventId }), w.thread.type, w.thread.ref]);
  ctx.push(chatLine(row));
}
const line = (tx: Tx, ctx: WriteContext, eventId: number, appId: number, sessionId: number, content: string, metadata: Json = null) =>
  writeChat(tx, { eventId, appId, content, metadata, thread: { type: 'session', ref: sessionId } }, ctx);

// The values this proposal declared, written with the merge.
async function writeSecrets(tx: Tx, w: any, dataKey: string, ctx: WriteContext) {
  const { applied, refused } = await applyInTransaction(tx, { sessionId: w.sessionId, dataKey });
  for (const a of applied) {
    if (!a.hadValue) continue;
    await line(tx, ctx, w.eventId, w.appId, w.sessionId, a.scope === 'platform'
      ? `Platform variable "${a.key}" was declared and set by this proposal; takes effect on the platform's next deploy.`
      : `Secret "${a.key}" was declared and set by this proposal; redeploying…`);
    if (a.scope === 'platform') {
      await tx.query(
        `INSERT INTO events (user_id, app_id, event_type, metadata) VALUES ($1, $2, 'platform_env_changed', $3::jsonb)`,
        [a.userId, w.appId, JSON.stringify({ key: a.key, action: 'set', private: a.private, appliedBy: 'declaration-proposal' })]);
    }
  }
  for (const r of refused) {
    await line(tx, ctx, w.eventId, w.appId, w.sessionId, `Couldn't apply the value declared with this proposal for ${r.key}: ${r.reason}`);
  }
}

// Bounties on the requests it closes go to its author, with their events
// and lines in the same transaction.
async function writeBounties(tx: Tx, w: any, ctx: WriteContext) {
  for (const n of w.numbers as number[]) {
    const { awarded } = await resolveIssueBounty(tx, { appId: w.appId, sessionId: w.sessionId, awardeeUserId: w.userId, issueNumber: n });
    if (!awarded.length) continue;
    await tx.query(
      `INSERT INTO events (user_id, app_id, session_id, event_type, metadata) VALUES ($1, $2, $3, 'bounty_awarded', $4::jsonb)`,
      [w.userId ?? null, w.appId, w.sessionId, JSON.stringify({ issueNumber: n, prNumber: w.prNumber, count: awarded.length })]);
    const recipient = w.userId ? `<@${w.userId}>` : 'the author';
    await line(tx, ctx, w.eventId, w.appId, w.sessionId,
      `Bounty on issue #${n} (${awarded.length} kudos) awarded to ${recipient} for PR #${w.prNumber || w.sessionId}`);
  }
}

// "<title> is live (PR #n). Built by …, backed by … (yes/active votes)",
// with the names as metadata, as [main]'s merge wrote it.
async function writeMergedLine(tx: Tx, w: any, ctx: WriteContext) {
  const session = { id: w.sessionId, app_id: w.appId, user_id: w.userId };
  const credits = w.force ? null : await mergeCredits(tx, session, { before: w.mergedAt });
  const d = { sessionId: w.sessionId, prNumber: w.prNumber, prTitle: w.prTitle };
  const yes = w.tally?.yes ?? 0;
  const active = w.tally?.active ?? w.tally?.required ?? yes;
  const content = w.force
    ? `${label(d)} force-merged by admin ${w.forcedBy || 'an admin'} (${yes}/${active} vote${yes === 1 ? '' : 's'} at the time)`
    : `${w.prTitle || prRef(d)} ${w.prTitle ? `is live (${prRef(d)})` : 'is live'}. ${credits ? creditsSentence(credits) : 'Thanks to everyone who voted'} (${yes}/${active} votes)`;
  const metadata = credits ? { merged: {
    sessionId: w.sessionId, prNumber: w.prNumber || null, title: w.prTitle || '', author: credits.author || '',
    backers: credits.backers, shapers: credits.shapers, votes: `${yes}/${active}`,
  } } : null;
  await line(tx, ctx, w.eventId, w.appId, w.sessionId, content, metadata);
}

// The author's "your change is live", once (the push trigger rings it), and
// on their open tabs.
async function writeMergedNotification(tx: Tx, w: any, ctx: WriteContext) {
  if (!w.userId) return;
  let credits: string | null = null;
  if (w.includedIn) {
    credits = authorLine(prRow(w.includedIn));
  } else if (!w.force) {
    const c = await mergeCredits(tx, { id: w.sessionId, app_id: w.appId, user_id: w.userId }, { before: w.mergedAt });
    credits = creditsSentence(c, { withAuthor: false }) || null;
  }
  const created = await createPrMergedNotification(tx, {
    userId: w.userId, appId: w.appId, sessionId: w.sessionId, forced: !!w.force, credits,
  });
  // Named, not carried: the relaying web process reads the row for the
  // author's tabs (ws.js relayNotification), so the bell's query never runs
  // in, or holds up, the transition that makes the change live.
  for (const row of created || []) {
    ctx.push(toUser(Number(row.user_id), { type: 'notification_new', notificationId: Number(row.id) }));
  }
}
