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
  Check, DomainWrite, Event, Json, Machine, Outcome, Push, TransitionContext, Tx, WorkRequest,
  WorkResultPayload, WriteContext,
} from '../kernel/index.ts';
import { changeClosed } from '../rules/agent-notes.ts';
import { resolveIssueBounty } from '../rules/bounties.ts';
import { KUDOS_PARKED } from '../rules/kudos-parked.ts';
import { createPrMergedNotification, settleDecidedChange } from '../rules/change-notifications.ts';
import { authorLine, closingComment, liveLine, threadLine } from '../rules/included-lines.ts';
import { creditsSentence, mergeCredits } from '../rules/merge-credits.ts';
import { applyInTransaction } from '../rules/pending-secret-apply.ts';
import { toBotChange, writeBotChange } from '../rules/bot-notes.ts';
import { appVersion, boardMoved, chatLine, issuesClosed, issueUpdate, toUser, voteUpdate as votePush } from '../pushes.ts';
import { readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'merge-followups';
export const sessionKey = (sessionId: number) => `session:${sessionId}`;

// Work kinds. delivery.verify (and app-delivery's answer, a message) decide
// `live`; the rest only have to happen. The deploy is app-delivery's: the
// merge asks it by message.
export const WORK = Object.freeze({
  nudge: 'host.nudgeDeployer',
  verify: 'delivery.verify',
  retire: 'worker.retire',
  find: 'included.find',
  issues: 'issues.closeAfterMerge',
  closePr: 'github.closePullRequest',
  journey: 'journey.changeLive',
});
// The kinds a follow-up can be retried as: those with a handler.
const RETRYABLE: ReadonlySet<string> = new Set(Object.values(WORK));

// Post-commit kicks into flows not migrated yet. What browsers hear is a
// push, published with the transition (thread lines, the vote card, the
// version pill, the bell).

const DELIVERY = 'app-delivery' as const;
const deliveryKey = (appId: number) => `app:${appId}`;

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
  deliveries: number;              // app-delivery requests (or app.deliver items, before) so far
  delivery?: typeof DELIVERY;      // the deploy is asked of app-delivery (absent: self-hosted, or a merge recorded before every deploy was app-delivery's)
  answered?: boolean;              // app-delivery has answered this merge's own request
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
  // app-delivery's answer to this merge's request: the deploy that served
  // it runs `sha`, or it failed (the request stays open there, so the next
  // deploy that succeeds answers Delivered).
  Delivered: (p: any) => ({ sha: sha(p?.sha, 'sha') }),
  DeliveryFailed: (p: any) => ({
    message: text(p?.message) || 'the deploy failed',
    missingSecrets: Array.isArray(p?.missingSecrets) ? p.missingSecrets.map(String) : null,
  }),
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
  writes?: DomainWrite[]; work?: WorkRequest[]; messages?: Outcome['messages']; push?: Push[];
}

// The writes that add thread lines push them with the rows they inserted.
function outcome(name: Going['name'], data: Data, x: Extra = {}): Outcome<MFState> {
  const work = x.work || [];
  return { next: { name, data: track(data, work) }, writes: x.writes, work, messages: x.messages, push: x.push };
}

const carrierRef = (d: Data): CarrierRef => ({ sessionId: d.sessionId, prNumber: d.prNumber, prTitle: d.prTitle });

// Production runs a build containing the change: it is live, and now it is said.
function toLive(e: Event<any>, data: Data, deliveredSha: string | null, ctx: TransitionContext, x: Extra = {}): Outcome<MFState> {
  const d = { ...data, deliveredSha, liveAt: ctx.now.toISOString(), failure: null };
  const writes = [...(x.writes || [])];
  if (d.role === 'merge') writes.push({ type: 'mergedLine', eventId: e.id, ...lineInput(d) });
  writes.push({ type: 'mergedNotification', sessionId: d.sessionId, appId: d.appId, userId: d.authorId, force: d.force,
    mergedAt: d.mergedAt, includedIn: d.includedIn });
  // A change of the Homeroom bot's: whoever asked hears it is live, and the
  // request says so (its change machine).
  writes.push(toBotChange(d.sessionId, 'Live'));
  const work: WorkRequest[] = [...(x.work || []),
    { kind: WORK.journey, key: 'journey', input: { sessionId: d.sessionId, sha: deliveredSha, at: d.mergedAt } }];
  const messages = [...(x.messages || []), ...d.included.map((id) => ({
    to: { machine: MACHINE, key: sessionKey(id) }, event: { type: 'CarrierDelivered', payload: { sha: deliveredSha } },
  }))];
  const push = [...(x.push || []), voteUpdate(d, { live: true })];
  if (d.role === 'merge') push.push(appVersion({ appId: d.appId, appSlug: d.appSlug, sha: deliveredSha, prNumber: d.prNumber }));
  return outcome('live', d, { writes, work, messages, push });
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

// Demo mode deploys the image the checks ran against when its tree is the
// merged tree (staging.deployProduction verifies it).
function reuseOf(f: Facts | null): Json {
  const s = f?.session?.staging;
  return f?.app?.demoMode && s && f.app.repo ? { ...s, ...f.app.repo } : null;
}

// The merge's deploy, asked of app-delivery: served by its first deploy
// that starts after this, which reuses the merge commit when it already
// runs.
function deliveryRequest(d: Data, reuse: Json): NonNullable<Outcome['messages']>[number] {
  return { to: { machine: DELIVERY, key: deliveryKey(d.appId) }, event: { type: 'DeployRequested', payload: {
    appId: d.appId, reason: 'merge', prNumber: d.prNumber, revision: d.mergeSha, reuse,
  } } };
}

// Its preview goes: the preview machine retires it for good, asked by a
// message in this transaction (it cannot be lost, and the preview's own
// timeline shows it). At the merge, unless its deploy reuses the preview's
// own build (demo mode, reuseOf): that one waits for app-delivery's answer,
// since the retirement drops the preview's reference to the build. Waiting
// for every deploy held a full namespace quota shut on 19 Oct 2026: 65
// merged previews waited for 65 deploys, which waited for pods the previews
// held. Recorded as a follow-up done, so it is asked once.
const TEARDOWN = 'teardown';
function andTeardown(out: Outcome<MFState>): Outcome<MFState> {
  if (out.next.name === NONE) return out;
  const next = out.next as Going;
  const d = next.data;
  if (d.followups[TEARDOWN]) return out;
  const input = { sessionId: d.sessionId };
  return {
    ...out,
    next: { name: next.name, data: { ...d, followups: { ...d.followups, [TEARDOWN]: { kind: 'preview.retire', input, status: 'done' } } } },
    messages: [...(out.messages || []), { to: { machine: 'preview', key: sessionKey(d.sessionId) },
      event: { type: 'RetireRequested', payload: { sessionId: d.sessionId, reason: 'merged', terminal: true } }, appId: d.appId }],
  };
}

// The second look at the requests a merge closes (issues.closeAfterMerge):
// GitHub closes `Closes #N` a few seconds after the merge, or not at all,
// so a request still open at the first look is looked at again this much
// later, and closed by the platform then.
const ISSUES_SECOND_LOOK_MS = 30 * 1000;

// What every merged change has to have done: its worker goes, and the
// requests close (its preview: andTeardown). (The bot stops its other work
// on the request: the merge's write tells its change machine, settleWrites.)
function settleWork(d: Data, linkedIssues: number[], closeOnly: boolean): WorkRequest[] {
  const work: WorkRequest[] = [
    { kind: WORK.retire, key: 'worker', input: { sessionId: d.sessionId } },
  ];
  if (d.repo && d.prNumber && (!closeOnly || linkedIssues.length)) {
    work.push({ kind: WORK.issues, key: 'issues', input: {
      sessionId: d.sessionId, appId: d.appId, appSlug: d.appSlug, prNumber: d.prNumber, ...d.repo, linkedIssues, closeOnly,
      ...(d.includedIn ? { carrierPrNumber: d.includedIn.prNumber } : {}), look: 1,
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
    // A change of the Homeroom bot's: its other work on the same request
    // stops, bounded to what had started before the merge.
    toBotChange(d.sessionId, 'Merged', { before: d.mergedAt }),
  ];
}

// The proposal machine hears the move into 'merged' that this one makes
// (its lifecycle ends there): one message, in the merge's transaction.
function toProposal(d: Data): NonNullable<Outcome['messages']>[number] {
  return { to: { machine: 'proposal', key: `session:${d.sessionId}` }, event: { type: 'Merged', payload: { sessionId: d.sessionId } }, appId: d.appId };
}

// The app's main check (src/workflow/main-check/): the suite on the merge commit.
function toMainCheck(d: Data): NonNullable<Outcome['messages']>[number] {
  return { to: { machine: 'main-check', key: `app:${d.appId}` }, event: { type: 'CheckRequested', payload: {
    appId: d.appId, sha: d.mergeSha, sessionId: d.sessionId, prNumber: d.prNumber } }, appId: d.appId };
}

// The app's merge queue (src/workflow/merge-queue/): something may merge
// now (this merge moved main; its check found main green).
function toQueue(d: Data, reason: string): NonNullable<Outcome['messages']>[number] {
  return { to: { machine: 'merge-queue', key: `app:${d.appId}` }, event: { type: 'MergeWanted', payload: { appId: d.appId, reason } }, appId: d.appId };
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
    ...(!app.selfHosted ? { delivery: DELIVERY } : {}),
  };
  // The platform's own app is released by its pipeline, not by this
  // process: its release booting appends Deployed. On Docker hosts the host
  // deployer is told to fetch at once rather than on its poll.
  const work: WorkRequest[] = app.selfHosted ? [{ kind: WORK.nudge, key: 'nudge', input: { sha: d.mergeSha, prNumber: d.prNumber } }] : [];
  // The app's merge queue: the next merge (a message, not a kick: it cannot
  // be lost).
  // What the deploy is offered of the preview, which also decides whether
  // the preview waits for its answer (andTeardown, below).
  const reuse = reuseOf(f);
  const messages = [toProposal(d), ...(d.delivery ? [deliveryRequest(d, reuse)] : []), toQueue(d, 'merged')];
  work.push(...settleWork(d, s.linkedIssues, false));
  if (d.repo && d.prNumber) {
    work.push({ kind: WORK.find, key: 'included', input: { sessionId: d.sessionId, appId: d.appId, prNumber: d.prNumber, ...d.repo } });
  }
  // The repo's unit suite on the merge commit: the app's main-check
  // machine (src/workflow/main-check/), asked by message.
  if (d.mergeSha) messages.push(toMainCheck(d));
  // The requests it closes stop showing as open in every web process at
  // once, and the lists re-read (GitHub closes `Closes #N` late);
  // issues.closeAfterMerge makes sure they close.
  const push: Push[] = [voteUpdate(d, {})];
  if (d.repo && s.linkedIssues.length) {
    // The request board changed: the Workshop re-places its cards.
    push.push(issuesClosed({ ...d.repo, numbers: s.linkedIssues }),
      boardMoved(issueUpdate({ action: 'github_synced', appSlug: d.appSlug, appId: d.appId, source: 'pr_merged' })));
  }
  const x: Extra = {
    writes: [{ type: 'secrets', eventId: e.id, sessionId: d.sessionId, appId: d.appId }, ...settleWrites(e, d, s)],
    work, messages, push,
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
    if (exact) return andTeardown(toLive(e, d, exact.sha, ctx, x));
    if (d.repo) for (const b of after) work.push(verifyWork(d, b.sha));
  }
  // The platform's own app has no deploy here to wait for, and a deploy
  // that builds its own image does not need the preview: either way it goes
  // at once.
  const out = outcome('delivering', d, x);
  return app.selfHosted || !reuse ? andTeardown(out) : out;
}

// Why a carried change can no longer be included: INCLUDED_CANDIDATES_SQL's
// conditions (facts.ts), read again under the change's
// own lock. The message is then refused and no instance is made, so the
// change can still merge on its own, or be included by a later merge.
//
// What is working on it is read from the durable record of each: the turn's
// journal (active_turn), a live shots run, checks running, the operations
// the preview machine records (session-work.ts), and the head the carrier
// matched (a change revised since it was listed merges on its own).
function notIncludable(f: Facts, carrierAppId: number | null, head: string | null): string | null {
  const s = f.session;
  if (!s) return 'no_session';
  if (carrierAppId != null && s.appId !== carrierAppId) return 'other_app';
  if (s.status !== 'promoted') return 'moved_on';
  if (s.activeTurn) return 'turn_running';
  if (head && s.head !== head) return 'head_moved';
  if (s.shotsRunning) return 'shots_running';
  if (s.checksRunning) return 'checks_running';
  if (s.workedOn) return 'worked_on';
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
    messages: [toProposal(d)],
    push: [voteUpdate(d, { includedIn: ref.sessionId })],
  };
  if (p.carrierState === 'live') return andTeardown(toLive(e, d, p.deliveredSha, ctx, x));
  if (p.carrierState === 'deploy_failed') return andTeardown(toFailed(e, d, 'the change that carried it did not deploy', { ...x }));
  return andTeardown(outcome('delivering', d, x));
}

// More work, added to an outcome already decided.
function andWork(out: Outcome<MFState>, work: WorkRequest[]): Outcome<MFState> {
  if (!work.length || out.next.name === NONE) return out;
  const next = out.next as Going;
  return { ...out, next: { name: next.name, data: track(next.data, work) }, work: [...(out.work || []), ...work] };
}

// A work result updates its follow-up; delivery.verify can also make the
// change live, and included.find hands the carried changes on.
function workResult(status: Followup['status']) {
  const decide = resultOf(status);
  return {
    guard: (s: any, e: Event<WorkResultPayload>): Check =>
      (s.data.followups[e.payload.workKey]?.status === 'pending' ? ok() : reject('stale_result')),
    to: (s: any, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<MFState> => decide(s, e, f, ctx),
  };
}

function resultOf(status: Followup['status']) {
  return (s: any, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<MFState> => {
    const p = e.payload;
    const prev = s.data.followups[p.workKey]!;
    const d: Data = { ...s.data, followups: { ...s.data.followups,
      [p.workKey]: { ...prev, status, ...(p.error ? { error: p.error.message } : {}) } } };
    const result = (p.result || {}) as { sha?: string; contains?: boolean; found?: { id: number; head: string }[] };
    if (p.kind === WORK.verify && status === 'done' && result.contains && s.name !== 'live') {
      return toLive(e, d, result.sha || null, ctx);
    }
    // A shots run still works in the worker: the same retire, later.
    if (p.kind === WORK.retire && status === 'done' && (result as { waiting?: string }).waiting) {
      return outcome(s.name, d, { work: [{ kind: WORK.retire, key: `worker~${ctx.version + 1}`, input: prev.input,
        notBefore: new Date(ctx.now.getTime() + RETIRE_RECHECK_MS) }] });
    }
    if (p.kind === WORK.find && status === 'done') {
      // `found` carries each change's matched head.
      const found = (Array.isArray(result.found) ? result.found : []).filter((c) => Number.isInteger(c.id) && !d.included.includes(c.id));
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
    // What the work closed, and what it found still open (shown again),
    // in every process: the handler's own updates reached only its own.
    // (`skipped` is a reason when the work did not run, GitHub off; the
    // watcher's own result carries a list of that name.)
    // A request it found still open at the first look is looked at again
    // later (GitHub closes `Closes #N` late), and closed then. The close
    // proposals whose target it saw closed or gone are superseded, by a
    // message to their own instance (filed first: one filed before the
    // governance machine ran is adopted from its row).
    if (p.kind === WORK.issues && status === 'done' && typeof (result as { skipped?: unknown }).skipped !== 'string' && d.repo) {
      const numbers = (v: unknown) => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const r = result as { closed?: unknown; stillOpen?: unknown; waiting?: boolean; targets?: { issueId: number; number: number }[] };
      const cause = { kind: 'pr-merge', prNumber: (prev.input as { carrierPrNumber?: number }).carrierPrNumber || d.prNumber };
      const targets = (Array.isArray(r.targets) ? r.targets : []).filter((t) => Number.isInteger(t?.issueId) && Number.isInteger(t?.number));
      const messages = targets.flatMap((t): NonNullable<Outcome['messages']> => {
        const to = { machine: 'governance-proposal', key: `issue:${t.issueId}` };
        return [{ to, event: { type: 'Filed', payload: { issueId: t.issueId } }, appId: d.appId },
          { to, event: { type: 'TargetClosed', payload: { issueNumber: t.number, cause } }, appId: d.appId }];
      });
      const work: WorkRequest[] = r.waiting ? [{ kind: WORK.issues, key: `issues~${ctx.version + 1}`,
        input: { ...(prev.input as Record<string, Json>), look: 2 }, notBefore: new Date(ctx.now.getTime() + ISSUES_SECOND_LOOK_MS) }] : [];
      // A linked request still open at the first look stays hidden: the
      // second look closes it. Only what the last look leaves open is shown
      // again.
      const linked = new Set(numbers((prev.input as { linkedIssues?: unknown }).linkedIssues));
      const open = numbers(r.stillOpen).filter((n) => !r.waiting || !linked.has(n));
      return { next: { name: s.name, data: track(d, work) }, work, messages, push: [
        issuesClosed({ ...d.repo, numbers: numbers(r.closed), open }),
        boardMoved(issueUpdate({ action: 'github_synced', appSlug: d.appSlug, appId: d.appId, source: 'pr_merged' })),
      ] };
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
    // A merge that asked app-delivery waits for its own deploy's answer
    // before any other deploy counts: one that started before its request
    // was recorded (however the events were ordered) ran without the keys
    // this merge declared, applied when it merged.
    if (s.data.delivery === DELIVERY && !s.data.answered) return reject('awaiting_own_answer');
    if (!s.data.mergeSha) return reject('no_merge_commit');
    if (s.data.followups[`verify:${e.payload.sha}`]) return reject('already_checking');
    return ok();
  },
  to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<MFState> =>
    deployedBuild(e, s.name, s.data, e.payload.sha, ctx),
};

// app-delivery's answer to this merge's own request. Its first answer,
// whatever it is, lets the preview go.
const fromDelivery = (s: any, e: Event<any>): Check =>
  (s.data.role === 'merge' && s.data.delivery === DELIVERY && e.source.kind === 'message'
    && e.source.from.machine === DELIVERY && e.source.from.key === deliveryKey(s.data.appId) ? ok() : reject('not_asked'));
const delivered = {
  guard: fromDelivery,
  to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<MFState> =>
    andTeardown(deployedBuild(e, s.name, { ...s.data, answered: true }, e.payload.sha, ctx)),
};
const deliveryFailed = {
  guard: fromDelivery,
  to: (s: any, e: Event<any>): Outcome<MFState> => {
    const d = { ...s.data, answered: true };
    return andTeardown(s.name === 'delivering' ? toFailed(e, d, e.payload.message) : { next: { name: s.name, data: d } });
  },
};

const retryFollowup = {
  guard: (s: any, e: Event<any>): Check => {
    const f = s.data.followups[e.payload.workKey];
    return f && RETRYABLE.has(f.kind) && ['failed', 'exhausted'].includes(f.status) ? ok() : reject('not_retryable');
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
}

export function mergeFollowups(deps: MachineDeps): Machine<MFState, Facts> {
  const system = (e: Event<any>): Check => (e.source.kind === 'system' ? ok() : reject('internal_only'));
  const deliveryMessage = (e: Event<any>): Check =>
    (e.source.kind === 'message' && e.source.from.machine === DELIVERY ? ok() : reject('internal_only'));
  const ownMessage = (e: Event<any>): Check =>
    (e.source.kind === 'message' && e.source.from.machine === MACHINE ? ok() : reject('internal_only'));
  const admin = (e: Event<any>): Check => (e.source.kind === 'admin' ? ok() : reject('admin_only'));
  const works = { WorkSucceeded: workResult('done'), WorkFailed: workResult('failed'), WorkExhausted: workResult('exhausted') };
  const created = { Merged: { ignore: 'already_merged' }, Included: { ignore: 'already_merged' } };

  return defineMachine<MFState, Facts>({
    name: MACHINE,
    // 2: the retire waits on the shots run's row and asks again later, the
    // carried head and busy refusals, teardown after the delivery's result,
    // the issue lists' push. 3: the deploy asked of app-delivery (Delivered,
    // DeliveryFailed), the host deployer's nudge as work. 4: who works on a
    // carried change is read from the preview machine's record (worked_on,
    // and its build or run as checks running). During a rollout an older Pod
    // leaves the instances a newer version wrote alone. 5: every merge asks
    // app-delivery (an app.deliver item from before hands off to it), the
    // request's "It's live" (bot.announceLive), the issue lists' push at the
    // merge. 6: the proposal machine hears the move into 'merged' (Merged).
    // 7: the proposal machine reports the merge (Merged, by message); the
    // merge queue hears every merge and main's verdict on it. 8: the
    // preview is retired and main is checked by message; the requests a
    // merge closes are looked at twice, and their close proposals are told
    // by message once the close is confirmed.
    version: 8,
    events: EVENTS,
    create: ['Merged', 'Included'],
    terminal: ['live'],
    decode: (row) => ({ name: row.state, data: row.data } as MFState),
    // Only the creating events read anything: the row they move into 'merged'.
    facts: (tx, state, event) => (state.name === NONE && (event.type === 'Merged' || event.type === 'Included')
      ? readFacts(tx, event.payload.sessionId, { lock: true })
      : Promise.resolve({ session: null, app: null })),
    authorize: {
      // The proposal machine's merge (or an older release's checkAndMerge,
      // and its recovery, during a rollout).
      Merged: (e) => ((e.source.kind === 'message' && e.source.from.machine === 'proposal') || e.source.kind === 'system' ? ok() : reject('internal_only')),
      Included: ownMessage,
      // A deploy anyone made: the platform's release booting (system), or
      // app-delivery's for merges whose own request it did not answer.
      Deployed: (e) => (e.source.kind === 'system' ? ok() : deliveryMessage(e)),
      Delivered: deliveryMessage,
      DeliveryFailed: deliveryMessage,
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
        Delivered: delivered,
        DeliveryFailed: deliveryFailed,
        CarrierDelivered: { guard: fromCarrier, to: (s, e, f, ctx) => carrierLive(e, (s as Going).data, ctx) },
        CarrierDeployFailed: { guard: fromCarrier, to: (s, e) => toFailed(e, (s as Going).data, e.payload.message) },
        RetryDelivery: { ignore: 'not_failed' },
        RetryFollowup: retryFollowup,
      },
      deploy_failed: {
        ...created,
        ...works,
        Deployed: deployed,
        Delivered: delivered,
        DeliveryFailed: deliveryFailed,
        CarrierDelivered: { guard: fromCarrier, to: (s, e, f, ctx) => carrierLive(e, (s as Going).data, ctx) },
        CarrierDeployFailed: { ignore: 'already_failed' },
        RetryDelivery: {
          guard: (s) => ((s as Going).data.role === 'merge' && !(s as Going).data.selfHosted ? ok() : reject('carrier_delivers')),
          // Asked of app-delivery again (also for a merge whose own deploy,
          // from before, failed).
          to: (s) => {
            const d = { ...(s as Going).data, deliveries: (s as Going).data.deliveries + 1, failure: null,
              delivery: DELIVERY };
            return outcome('delivering', d, { messages: [deliveryRequest(d, null)] });
          },
        },
        RetryFollowup: retryFollowup,
      },
      live: {
        ...created,
        ...works,
        Deployed: { ignore: 'already_live' },
        Delivered: { ignore: 'already_live' },
        DeliveryFailed: { ignore: 'already_live' },
        CarrierDelivered: { ignore: 'already_live' },
        CarrierDeployFailed: { ignore: 'already_live' },
        RetryDelivery: { ignore: 'already_live' },
        RetryFollowup: retryFollowup,
      },
    },
    writes: {
      botChange: writeBotChange,
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
      // Everyone whose bell the decision changed re-reads it, and their
      // phone's icon re-badges (the badge row platform.ts publishPushes
      // writes for every notifications_changed): the asks it settled,
      // digests it was the last one waiting in (those name no session), and
      // every row about the change, whose wording follows its status (going
      // live, then live).
      bell: async (tx, w, ctx) => {
        const told = new Set(await settleDecidedChange(tx, w.sessionId, { status: 'merged' }));
        const { rows } = await tx.query('SELECT DISTINCT user_id FROM notifications WHERE session_id = $1', [w.sessionId]);
        for (const r of rows) told.add(Number(r.user_id));
        for (const userId of told) ctx.push(toUser(userId, { type: 'notifications_changed' }));
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
// and lines in the same transaction. #5249: while kudos is parked
// (rules/kudos-parked.ts) a bounty pledged before parking is still paid,
// and its event recorded, but quietly: no line in the proposal's thread.
async function writeBounties(tx: Tx, w: any, ctx: WriteContext) {
  for (const n of w.numbers as number[]) {
    const { awarded } = await resolveIssueBounty(tx, { appId: w.appId, sessionId: w.sessionId, awardeeUserId: w.userId, issueNumber: n });
    if (!awarded.length) continue;
    await tx.query(
      `INSERT INTO events (user_id, app_id, session_id, event_type, metadata) VALUES ($1, $2, $3, 'bounty_awarded', $4::jsonb)`,
      [w.userId ?? null, w.appId, w.sessionId, JSON.stringify({ issueNumber: n, prNumber: w.prNumber, count: awarded.length })]);
    if (KUDOS_PARKED) continue;
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
// on their open tabs. #4787: everyone who voted on it, yes or no, hears it
// went live too, through the same call: it writes both sets, the author
// never double-told, and the voters' part runs even when the author's id is
// null (a bot build's). Both are written in this transaction, so a failure
// in either fails the event, which is retried; neither is lost to it.
async function writeMergedNotification(tx: Tx, w: any, ctx: WriteContext) {
  let credits: string | null = null;
  if (w.includedIn) {
    credits = authorLine(prRow(w.includedIn));
  } else if (!w.force && w.userId) {
    const c = await mergeCredits(tx, { id: w.sessionId, app_id: w.appId, user_id: w.userId }, { before: w.mergedAt });
    credits = creditsSentence(c, { withAuthor: false }) || null;
  }
  await createPrMergedNotification(tx, {
    userId: w.userId ?? null, appId: w.appId, sessionId: w.sessionId, forced: !!w.force, credits,
    alsoVoters: true,
  });
  // The write triggers the phone push from the database. Nothing is pushed
  // to open tabs (#5487): a row about a change that has just merged is
  // hidden from the bell's list the moment its next fetch runs, so
  // prepending it live would flash a row that never lists and bump the
  // badge for it. The settle step sends `notifications_changed` to those
  // whose bell changed, which re-badges their phone.
}
