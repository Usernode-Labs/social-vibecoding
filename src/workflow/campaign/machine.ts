// campaign: a fleet maintenance campaign, from the moment its governance
// vote passes until every app it reaches has an outcome. One instance per
// campaign (`campaign:<id>`), created by the governance machine's apply (a
// message its write sends with the row it inserts).
//
//   running ── every app proposed, skipped or failed ─▶ done ── RetryApp ─▶ running
//      └── Stop ─▶ stopped ── Resume ─▶ running
//
// The apps it reaches are fixed when it starts (Q2). One app is changed at a
// time (campaign.change: the AI's edit, the push, the pull request, as
// work), and only while there is room for it (holdFor): the platform under
// the session limit's warning line, and fewer of its own proposals up for a
// vote than it keeps open at once. Each change goes up for a vote through the proposal machine's
// own promote (Q1): the campaign writes the proposal's row and asks it, in
// the same transaction, and hears back whether it went up (ProposalOpened,
// ProposalRefused). From then on the proposal is the proposal machine's. An
// admin's "merge all green" forces, at once, the ones whose checks pass at
// the press (Q4); Stop opens nothing more and leaves the opened ones up for
// their vote (Q3). Each app's record is data of the instance, projected to
// maintenance_campaign_apps. workflow-foundation's design-campaigns.md is the
// design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, DomainWrite, Event, Json, Machine, MessageRequest, Outcome, TransitionContext, Tx, WorkRequest,
  WorkResultPayload, WriteContext } from '../kernel/index.ts';
import { chatLine } from '../pushes.ts';
import { NO_FACTS, readFacts } from './facts.ts';
import type { AppRow, Facts, Room } from './facts.ts';

export const MACHINE = 'campaign';
export const campaignKey = (campaignId: number) => `campaign:${campaignId}`;
const proposalKey = (sessionId: number) => `session:${sessionId}`;
export const WORK = Object.freeze({ change: 'campaign.change' });
// The platform account a campaign's proposals belong to
// (services/fleet-maintenance.js PLATFORM_USERNAME), and the name its
// promote line gives.
export const PROPOSER_NAME = 'Platform maintenance';
// A campaign's proposals are the platform's, not a person's: no promoted
// cap binds them.
export const NO_CAP = 1_000_000;
// A proposal the campaign asked to go up for a vote and has not heard about
// is looked at again this often (a promote the proposal machine refused
// outright sends no answer).
export const CHECK_MS = 5 * 60 * 1000;
// A hold says so in the campaign's thread when it begins, and again only
// after this long (a window that fills each time one of its proposals
// merges would otherwise say it with every app).
export const SAY_AGAIN_MS = 6 * 60 * 60 * 1000;

// What bounds a campaign's fan-out. Its proposals skip the promoted caps
// (NO_CAP) and the start gate, which is right for one proposal and was not
// for 129: on 19 Oct 2026 the MIT LICENSE campaign opened one every 20
// seconds, took the platform from 131 to past 175 of its 140 sessions (every
// start and resume refused) and the apps namespace to the edge of its pod
// quota with their previews.
export interface CampaignDeps {
  // The deploy's session limit (MAX_GLOBAL_SESSIONS); an admin's setting,
  // read in the facts, wins.
  sessionLimit: number;
  // It changes its next app only while the platform is under this share of
  // the session limit: PLATFORM_LIMIT_WARN_PERCENT, the line the admins'
  // alert warns at, so a campaign never sets the alert off and people keep
  // the rest.
  roomPercent: number;
  // How many of its proposals may be up for a vote at once
  // (CAMPAIGN_MAX_OPEN): merging or closing them makes room for the next.
  maxOpen: number;
}
export const DEFAULT_DEPS: CampaignDeps = Object.freeze({ sessionLimit: 100, roomPercent: 80, maxOpen: 10 });

// Why the next app waits.
export interface Held {
  reason: 'platform' | 'window';
  since: string;
  used: number;
  limit: number;
  ceiling: number;
  open: number;
  maxOpen: number;
}

/** Why the campaign may not change its next app now, or null. */
export function holdFor(room: Room | null, deps: CampaignDeps): Omit<Held, 'since'> | null {
  if (!room) return null;
  const ceiling = Math.max(1, Math.floor((room.limit * deps.roomPercent) / 100));
  const base = { used: room.used, limit: room.limit, ceiling, open: room.open, maxOpen: deps.maxOpen };
  if (room.used >= ceiling) return { reason: 'platform', ...base };
  if (room.open >= deps.maxOpen) return { reason: 'window', ...base };
  return null;
}

const holdLine = (d: Data, h: Omit<Held, 'since'>) => (h.reason === 'platform'
  ? `Maintenance campaign "${d.title}" is waiting for room: ${h.used} of ${h.limit} sessions are in use, `
    + `and it changes its next app only below ${h.ceiling}. It looks again every few minutes.`
  : `Maintenance campaign "${d.title}" is waiting: ${h.open} of its proposals are up for a vote, `
    + `the most it keeps open at once. Merging or closing them lets it go on.`);
// ── State ───────────────────────────────────────────────────────────────

export type AppState = 'waiting' | 'changing' | 'proposing' | 'proposed' | 'skipped' | 'failed' | 'not_reached';
export interface AppRec {
  appId: number;
  slug: string;
  state: AppState;
  n: number;                    // the app's change attempts (its work keys)
  sessionId: number | null;     // its proposal, once the proposal machine answered
  prNumber: number | null;
  error: string | null;
  // The last change attempt failed after it may have pushed: a retry starts
  // from that attempt's checkpoint (the change, the pull request).
  resumable: boolean;
  // Its change made again from scratch after its proposal closed: a branch
  // of its own (the closed proposal's may still be closing its pull request).
  gen?: number;
}
export interface Data {
  campaignId: number;
  issueId: number | null;
  threadAppId: number | null;
  title: string;
  // The platform account its proposals belong to (the change work reports it).
  proposerId: number | null;
  apps: AppRec[];
  // The first success's summary, carried to the next apps for consistency.
  exemplar: string | null;
  // The last "merge all green": who, when, which proposals.
  drained: { at: string; by: string | null; asked: number[] } | null;
  stopped: { at: string; by: string | null } | null;
  // Waiting for room to change its next app (holdFor), and the last hold
  // its thread was told about. Absent on an instance an older release made.
  held?: Held | null;
  said?: { reason: string; at: string } | null;
  // An admin asked it to merge each of its proposals whose checks pass as
  // they come in (its "Merge all green", every check), and who; and the
  // proposals it has asked to merge so (each once: a force lasts until the
  // proposal merges, closes or moves).
  autoMerge?: { at: string; by: string; userId: number | null; username: string | null } | null;
  autoAsked?: number[];
}
type Name = 'running' | 'done' | 'stopped';
export type CState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<CState, { data: Data }>;

// What maintenance_campaign_apps.state reads for each app state: the values
// its readers always knew, and 'stopped' for an app a stop never reached.
export const ROW_STATE: ReadonlyMap<AppState, string> = new Map([
  ['waiting', 'pending'], ['changing', 'running'], ['proposing', 'running'], ['proposed', 'pr_open'],
  ['skipped', 'skipped'], ['failed', 'failed'], ['not_reached', 'stopped'],
]);
const CAMPAIGN_STATUS: ReadonlyMap<Name, string> = new Map([['running', 'running'], ['done', 'done'], ['stopped', 'cancelled']]);

// ── Events ──────────────────────────────────────────────────────────────

const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown, what: string) => (v == null ? null : int(v, what));
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const by = (p: any) => ({ userId: optInt(p?.userId, 'userId'), username: text(p?.username, 100) });

const EVENTS = {
  Start: (p: any) => ({ campaignId: int(p?.campaignId, 'campaignId') }),
  ProposalOpened: (p: any) => ({ appId: int(p?.appId, 'appId'), sessionId: int(p?.sessionId, 'sessionId'),
    prNumber: optInt(p?.prNumber, 'prNumber') }),
  ProposalRefused: (p: any) => ({ appId: int(p?.appId, 'appId'), sessionId: int(p?.sessionId, 'sessionId'),
    code: text(p?.code, 64), message: text(p?.message, 500) }),
  RetryApp: (p: any) => ({ appId: int(p?.appId, 'appId'), ...by(p) }),
  MergeGreen: (p: any) => ({ ...by(p) }),
  Stop: (p: any) => ({ ...by(p) }),
  Resume: (p: any) => ({ ...by(p) }),
  AutoMerge: (p: any) => ({ on: p?.on === true, ...by(p) }),
  Check: () => ({}),
};

// ── Moves ───────────────────────────────────────────────────────────────

const step = (next: Live, more: Omit<Outcome<CState>, 'next'> = {}): Outcome<CState> => ({ next, ...more });
const workKey = (a: AppRec) => `app:${a.appId}:${a.n}`;
const branchOf = (d: Data, a: AppRec) => `maint/c${d.campaignId}/${a.slug}${a.gen ? `-${a.gen + 1}` : ''}`;
const withApp = (d: Data, appId: number, change: Partial<AppRec>): Data =>
  ({ ...d, apps: d.apps.map((a) => (a.appId === appId ? { ...a, ...change } : a)) });
const count = (d: Data, ...states: AppState[]) => d.apps.filter((a) => states.includes(a.state)).length;
const who = (p: any) => p.username || (p.userId ? `admin #${p.userId}` : 'an admin');

// The governance thread's line (a channel carries no activity).
const threadLine = (d: Data, content: string): DomainWrite =>
  ({ type: 'line', appId: d.threadAppId, issueId: d.issueId, content });

// The next thing the campaign does: change the next waiting app when there
// is room for it (else wait, and look again with the check), or, with
// nothing waiting, changing or being put up for a vote, finish.
function next(s: Live, f: Facts, ctx: TransitionContext, deps: CampaignDeps,
  extra: { writes?: DomainWrite[]; messages?: MessageRequest[]; work?: WorkRequest[] } = {}): Outcome<CState> {
  let d = s.data;
  const writes = [...(extra.writes || [])];
  const work = [...(extra.work || [])];
  let name: Name = s.name;
  if (name === 'running' && !d.apps.some((a) => a.state === 'changing')) {
    const a = d.apps.find((x) => x.state === 'waiting');
    const hold = a ? holdFor(f.room, deps) : null;
    if (a && hold) {
      const now = ctx.now.toISOString();
      const since = d.held && d.held.reason === hold.reason ? d.held.since : now;
      const say = !d.said || d.said.reason !== hold.reason || ctx.now.getTime() - Date.parse(d.said.at) >= SAY_AGAIN_MS;
      d = { ...d, held: { ...hold, since }, ...(say ? { said: { reason: hold.reason, at: now } } : {}) };
      if (say) writes.push(threadLine(d, holdLine(d, hold)));
    } else if (a) {
      if (d.held) d = { ...d, held: null };
      const n = a.n + 1;
      const prev = a.n ? `app:${a.appId}:${a.n}` : null;
      d = withApp(d, a.appId, { state: 'changing', n, error: null, resumable: false });
      work.push({
        kind: WORK.change, key: `app:${a.appId}:${n}`,
        input: { campaignId: d.campaignId, appId: a.appId, branch: branchOf(d, a), exemplar: d.exemplar },
        ...(prev && a.resumable ? { continues: prev } : {}),
      });
    } else if (!count(d, 'proposing')) {
      name = 'done';
      if (d.held) d = { ...d, held: null };
      writes.push(threadLine(d, `Maintenance campaign "${d.title}" finished fanning out: `
        + `${count(d, 'proposed')} PRs opened, ${count(d, 'skipped')} skipped, ${count(d, 'failed')} failed. `
        + 'Each PR now runs its own checks and merge vote.'));
    }
  }
  return { next: { name, data: d }, writes, work, messages: extra.messages };
}

// The timer is set once an app is being put up for a vote, the campaign
// waits for room, or it merges its green proposals itself while any are
// open (autoMerge), kept while one of those lasts (not pushed back by every
// event), and cleared otherwise; the check sets it again (the transitions
// call this on their outcome).
function clocked(out: Outcome<CState>, ctx: TransitionContext, before: CState | null, rearm = false,
  f: Facts | null = null): Outcome<CState> {
  const open = (f?.room?.open ?? 0) > 0;
  const proposing = (st: CState | null) => !!st && st.name !== NONE
    && ((st as Live).data.apps.some((a) => a.state === 'proposing') || !!(st as Live).data.held
      || (!!(st as Live).data.autoMerge && open));
  const waiting = proposing(out.next);
  if (waiting && proposing(before) && !rearm) return { ...out, timer: undefined };
  return { ...out, timer: waiting ? { at: new Date(ctx.now.getTime() + CHECK_MS), event: { type: 'Check' } } : null };
}

// An app's record as the campaign starts: waiting for its turn.
function fresh(r: AppRow): AppRec {
  return { appId: r.appId, slug: r.slug, n: 0, state: 'waiting', sessionId: null, prNumber: null, error: null, resumable: false };
}

function start(e: Event<any>, f: Facts, ctx: TransitionContext, deps: CampaignDeps): Outcome<CState> {
  const c = f.campaign!;
  const data: Data = {
    campaignId: c.id, issueId: c.issueId, threadAppId: c.threadAppId, title: c.title, proposerId: null,
    apps: f.apps.map(fresh), exemplar: null, drained: null, stopped: null, held: null, said: null,
  };
  const name: Name = c.status === 'done' ? 'done' : c.status === 'cancelled' ? 'stopped' : 'running';
  const s: Live = { name, data };
  // Its app rows (the targets, fixed now).
  const writes: DomainWrite[] = [{ type: 'adopt', campaignId: c.id, appIds: data.apps.map((a) => a.appId) }];
  return clocked(next(s, f, ctx, deps, { writes }), ctx, null, false, f);
}

// The AI's change for the app it was working on.
function changed(s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext, deps: CampaignDeps): Outcome<CState> {
  const p = e.payload;
  const a = s.data.apps.find((x) => x.state === 'changing' && workKey(x) === p.workKey)!;
  if (e.type !== 'WorkSucceeded') {
    // A permanent failure is the app's (a budget, no change made, no
    // repository); exhausted retries name GitHub's or the model's error.
    const message = p.error?.message || 'the change failed';
    return clocked(next({ ...s, data: withApp(s.data, a.appId, { state: 'failed', error: message.slice(0, 2000), resumable: true }) }, f, ctx, deps), ctx, s, false, f);
  }
  const r = (p.result || {}) as any;
  // Stopped before it reached the repository: not reached, or, when the
  // campaign was resumed meanwhile, waiting again.
  if (r.stopped) {
    return clocked(next({ ...s, data: withApp(s.data, a.appId, { state: s.name === 'running' ? 'waiting' : 'not_reached' }) },
      f, ctx, deps), ctx, s, false, f);
  }
  if (r.skipped) {
    return clocked(next({ ...s, data: withApp(s.data, a.appId, { state: 'skipped', error: String(r.reason || 'not applicable').slice(0, 2000) }) }, f, ctx, deps), ctx, s, false, f);
  }
  // Deleted while it was being changed: there is no app to propose to.
  if (f.appAlive === false) {
    const error = `The app was deleted while it was being changed${r.prNumber ? ` (its pull request #${r.prNumber} is left on GitHub)` : ''}`;
    return clocked(next({ ...s, data: withApp(s.data, a.appId, { state: 'failed', error }) }, f, ctx, deps), ctx, s, false, f);
  }
  let d = { ...withApp(s.data, a.appId, { state: 'proposing' as const, prNumber: r.prNumber ?? null }), proposerId: Number(r.userId) };
  if (!d.exemplar && typeof r.summary === 'string' && r.summary.trim()) d = { ...d, exemplar: r.summary.slice(0, 4000) };
  // The proposal's row, and its promote in the same transaction (the write
  // sends it: only it knows the row's id).
  const writes: DomainWrite[] = [{
    type: 'propose', campaignId: d.campaignId, appId: a.appId, userId: r.userId, branch: r.branch,
    prNumber: r.prNumber, prUrl: r.prUrl, prTitle: r.prTitle, head: r.head, key: campaignKey(d.campaignId),
  }];
  return clocked(next({ ...s, data: d }, f, ctx, deps, { writes }), ctx, s, false, f);
}

function opened(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: CampaignDeps): Outcome<CState> {
  const p = e.payload;
  const d = withApp(s.data, p.appId, { state: 'proposed', sessionId: p.sessionId, prNumber: p.prNumber ?? null, error: null });
  return clocked(next({ ...s, data: d }, f, ctx, deps), ctx, s, false, f);
}

function refused(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: CampaignDeps): Outcome<CState> {
  const p = e.payload;
  const error = `Could not put it up for a vote: ${p.message || p.code || 'refused'}`.slice(0, 2000);
  const d = withApp(s.data, p.appId, { state: 'failed', sessionId: p.sessionId, error });
  return clocked(next({ ...s, data: d }, f, ctx, deps, { messages: [closeMessage(p.sessionId, p.appId)] }), ctx, s, false, f);
}

// A proposal the campaign could not put up for a vote is closed (with its
// pull request): nobody can act on the platform account's underway change,
// and a retry makes the change again.
export const closeMessage = (sessionId: number, appId: number): MessageRequest => ({
  to: { machine: 'proposal', key: proposalKey(sessionId) },
  event: { type: 'Close', payload: { sessionId, from: 'active', reason: 'campaign-refused', userId: null, username: PROPOSER_NAME } },
  appId,
});

// A promote of the campaign's, for a proposal row it wrote.
export const promoteMessage = (o: { sessionId: number; appId: number; userId: number; head: string | null; key: string }): MessageRequest => ({
  to: { machine: 'proposal', key: proposalKey(o.sessionId) },
  event: { type: 'Promote', payload: {
    sessionId: o.sessionId, from: 'active', userId: o.userId, username: PROPOSER_NAME, cap: NO_CAP,
    pr: o.head ? { state: 'open', draft: false, merged: false, head: o.head } : null,
    expectedHead: o.head, campaign: { key: o.key, appId: o.appId },
  } },
  appId: o.appId,
});

function retry(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: CampaignDeps): Outcome<CState> {
  const p = e.payload;
  const a = s.data.apps.find((x) => x.appId === p.appId)!;
  // A proposal it could not put up for a vote was closed with its pull
  // request: the change is made again from scratch, on a branch of its own
  // (the closed one's may still be closing). A change that failed after its
  // push carries its checkpoint on.
  const proposed = a.sessionId != null;
  const d = withApp(s.data, a.appId, {
    state: 'waiting', error: null, sessionId: null,
    resumable: a.state === 'failed' && a.resumable && !proposed,
    ...(proposed ? { gen: (a.gen || 0) + 1 } : {}),
  });
  return clocked(next({ name: 'running', data: d }, f, ctx, deps), ctx, s, false, f);
}

const askForceMerge = (g: { sessionId: number; appId: number }, by: { userId: number | null; username: string | null }): MessageRequest => ({
  to: { machine: 'proposal', key: proposalKey(g.sessionId) },
  event: { type: 'ForceMerge', payload: { sessionId: g.sessionId, from: 'promoted', userId: by.userId, username: by.username } },
  appId: g.appId,
});

function mergeGreen(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  const p = e.payload;
  const messages: MessageRequest[] = f.green.map((g) => askForceMerge(g, p));
  const drained = { at: ctx.now.toISOString(), by: who(p), asked: f.green.map((g) => g.sessionId) };
  // Asked here, so auto-merge does not ask them again.
  const autoAsked = s.data.autoMerge ? [...new Set([...(s.data.autoAsked || []), ...drained.asked])] : s.data.autoAsked;
  return step({ ...s, data: { ...s.data, drained, ...(autoAsked ? { autoAsked } : {}) } }, { messages });
}

// Auto-merge: its proposals whose checks pass now, and that it has not
// asked to merge already, are asked (the same force as "Merge all green",
// in the name of the admin who turned it on).
function autoMerged(d: Data, f: Facts): { data: Data; messages: MessageRequest[] } {
  if (!d.autoMerge) return { data: d, messages: [] };
  const asked = new Set(d.autoAsked || []);
  const fresh = f.green.filter((g) => !asked.has(g.sessionId));
  if (!fresh.length) return { data: d, messages: [] };
  const by = { userId: d.autoMerge.userId, username: d.autoMerge.username };
  return { data: { ...d, autoAsked: [...asked, ...fresh.map((g) => g.sessionId)] }, messages: fresh.map((g) => askForceMerge(g, by)) };
}

// An admin turns auto-merge on (merging what is green at once) or off.
function autoMerge(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  const p = e.payload;
  if (!p.on) {
    if (!s.data.autoMerge) return step(s);
    const d: Data = { ...s.data, autoMerge: null };
    return clocked(step({ ...s, data: d }, {
      writes: [threadLine(d, `Auto-merge for maintenance campaign "${d.title}" was turned off by ${who(p)}. Its green proposals wait for their vote or "Merge all green" again.`)],
    }), ctx, s, false, f);
  }
  const already = !!s.data.autoMerge;
  const on = s.data.autoMerge || { at: ctx.now.toISOString(), by: who(p), userId: p.userId ?? null, username: p.username ?? null };
  const { data: d, messages } = autoMerged({ ...s.data, autoMerge: on }, f);
  const writes: DomainWrite[] = already ? [] : [threadLine(d, `Auto-merge for maintenance campaign "${d.title}" was turned on by ${who(p)}: `
    + 'each of its proposals is merged as soon as its checks pass, without waiting for its vote.')];
  return clocked(step({ ...s, data: d }, { writes, messages }), ctx, s, true, f);
}

// Stop: no further app is reached. The change under way is not cancelled
// (it may have pushed, or opened its pull request, already): its work reads
// the campaign's status before the push and before the pull request, and
// stops there; a change that reports with its pull request is put up for a
// vote like the others (Q3: the opened ones stay).
function stop(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  const apps = s.data.apps.map((a) => (a.state === 'waiting' ? { ...a, state: 'not_reached' as const } : a));
  const d: Data = { ...s.data, apps, held: null, stopped: { at: ctx.now.toISOString(), by: who(e.payload) } };
  const finishing = count(d, 'changing');
  const out = step({ name: 'stopped', data: d }, {
    writes: [threadLine(d, `Maintenance campaign "${d.title}" was stopped by ${who(e.payload)}: `
      + `${count(d, 'proposed') + count(d, 'proposing')} PRs opened${finishing ? `, ${finishing} change still finishing` : ''}, `
      + `${count(d, 'not_reached')} apps not reached. The opened ones stay up for their vote.`)],
  });
  return clocked(out, ctx, s, false, f);
}

// Resume: a stopped campaign goes on with the apps the stop never reached,
// under the same room as ever (holdFor), from where it stopped. What it
// already opened, skipped or failed stays as it is.
function resume(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: CampaignDeps): Outcome<CState> {
  const apps = s.data.apps.map((a) => (a.state === 'not_reached' ? { ...a, state: 'waiting' as const, error: null, resumable: false } : a));
  const d: Data = { ...s.data, apps, stopped: null, held: null };
  const left = count(d, 'waiting');
  const writes: DomainWrite[] = [threadLine(d, `Maintenance campaign "${d.title}" was resumed by ${who(e.payload)}: `
    + `${left} app${left === 1 ? '' : 's'} left to reach. It changes one at a time, while there is room.`)];
  return clocked(next({ name: 'running', data: d }, f, ctx, deps, { writes }), ctx, s, false, f);
}

const resumable = (s: Live): Check => (s.data.apps.some((a) => a.state === 'not_reached') ? ok() : reject('nothing_to_resume'));

// The proposals it asked to go up for a vote and has not heard about: what
// their rows say now. A promote the proposal's guard refused outright sends
// no answer; one not applied yet is waited for (a backlog, a rollout).
function checked(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: CampaignDeps): Outcome<CState> {
  let d = s.data;
  const messages: MessageRequest[] = [];
  for (const q of f.asked) {
    const a = d.apps.find((x) => x.appId === q.appId);
    if (!a || a.state !== 'proposing') continue;
    const fail = (error: string) => { d = withApp(d, a.appId, { state: 'failed', sessionId: q.sessionId ?? a.sessionId, error: error.slice(0, 2000) }); };
    if (q.gone) {
      fail('The app or its proposal was deleted before it went up for a vote');
    } else if (q.status === 'promoted' || q.status === 'merging' || q.status === 'merged') {
      d = withApp(d, a.appId, { state: 'proposed', sessionId: q.sessionId, prNumber: q.prNumber ?? a.prNumber });
    } else if (q.status === 'archived') {
      fail('Closed before it went up for a vote');
    } else if (q.promote?.result === 'rejected') {
      fail(`Could not put it up for a vote: ${q.promote.reason || 'refused'}`);
      if (q.sessionId) messages.push(closeMessage(q.sessionId, a.appId));
    }
  }
  const auto = autoMerged(d, f);
  return clocked(next({ ...s, data: auto.data }, f, ctx, deps, { messages: [...messages, ...auto.messages] }), ctx, s, true, f);
}

// ── The machine ─────────────────────────────────────────────────────────

const fromProposal = (e: Event<any>): Check =>
  ((e.source.kind === 'message' && e.source.from.machine === 'proposal') || e.source.kind === 'system' ? ok() : reject('internal_only'));
const starter = (e: Event<any>): Check =>
  ((e.source.kind === 'message' && e.source.from.machine === 'governance-proposal') || e.source.kind === 'system' ? ok() : reject('internal_only'));
const admin = (e: Event<any>): Check => (e.source.kind === 'route' || e.source.kind === 'admin' || e.source.kind === 'system' ? ok() : reject('not_a_producer'));
const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));
const service = (e: Event<any>): Check => (e.source.kind === 'service' || e.source.kind === 'system' ? ok() : reject('not_a_producer'));

const proposingApp = (s: Live, e: Event<any>): Check => {
  const a = s.data.apps.find((x) => x.appId === e.payload.appId);
  return a && a.state === 'proposing' ? ok() : reject('not_proposing');
};
const changingWork = (s: Live, e: Event<WorkResultPayload>): Check =>
  (e.payload.kind === WORK.change && s.data.apps.some((a) => a.state === 'changing' && workKey(a) === e.payload.workKey)
    ? ok() : reject('stale_result'));
const retryable = (s: Live, e: Event<any>): Check => {
  const a = s.data.apps.find((x) => x.appId === e.payload.appId);
  if (!a) return reject('not_in_campaign');
  return a.state === 'failed' || a.state === 'skipped' ? ok() : reject('not_retryable');
};

export function campaign(deps: CampaignDeps = DEFAULT_DEPS): Machine<CState, Facts> {
  const live = (to: (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: CampaignDeps) => Outcome<CState>) =>
    (s: CState, e: Event<any>, f: Facts, ctx: TransitionContext) => to(s as Live, e, f, ctx, deps);
  const g = (check: (s: Live, e: Event<any>) => Check) => (s: CState, e: Event<any>) => check(s as Live, e);
  const work = { guard: g(changingWork), to: live(changed) };
  const answers = {
    ProposalOpened: { guard: g(proposingApp), to: live(opened) },
    ProposalRefused: { guard: g(proposingApp), to: live(refused) },
    Check: { to: live(checked) },
    MergeGreen: { to: live(mergeGreen) },
    AutoMerge: { to: live(autoMerge) },
  };
  const create = {
    Start: {
      guard: (_s: CState, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
        if (ctx.key !== campaignKey(e.payload.campaignId)) return reject('key_mismatch');
        if (!f.campaign) return reject('not_found');
        return ok();
      },
      to: (_s: CState, e: Event<any>, f: Facts, ctx: TransitionContext) => start(e, f, ctx, deps),
    },
  };
  return defineMachine<CState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['Start'],
    terminal: [],
    decode: (row) => ({ name: row.state, data: row.data } as CState),
    facts: (tx: Tx, state: CState, event: Event<any>) => {
      const id = state.name === NONE ? Number((event.payload as any)?.campaignId) : (state.data as Data).campaignId;
      if (!Number.isInteger(id) || id <= 0) return Promise.resolve(NO_FACTS);
      const proposing = state.name === NONE ? [] : (state.data as Data).apps.filter((a) => a.state === 'proposing').map((a) => a.appId);
      return readFacts(tx, id, event, proposing,
        { deployLimit: deps.sessionLimit, autoMerge: state.name !== NONE && !!(state.data as Data).autoMerge });
    },
    authorize: {
      Start: starter, ProposalOpened: fromProposal, ProposalRefused: fromProposal,
      RetryApp: admin, MergeGreen: admin, Stop: admin, Resume: admin, AutoMerge: admin, Check: timer,
    },
    transitions: {
      [NONE]: create,
      running: {
        ...answers, WorkSucceeded: work, WorkFailed: work, WorkExhausted: work,
        Start: { ignore: 'already_started' },
        RetryApp: { guard: g(retryable), to: live(retry) },
        Stop: { to: live(stop) },
        Resume: { ignore: 'running' },
      },
      done: {
        ...answers, WorkSucceeded: work, WorkFailed: work, WorkExhausted: work,
        Start: { ignore: 'already_started' },
        RetryApp: { guard: g(retryable), to: live(retry) },
        Stop: { ignore: 'done' },
        Resume: { ignore: 'done' },
      },
      stopped: {
        ...answers, WorkSucceeded: work, WorkFailed: work, WorkExhausted: work,
        Start: { ignore: 'already_started' },
        RetryApp: { ignore: 'stopped' },
        Stop: { ignore: 'stopped' },
        Resume: { guard: g(resumable), to: live(resume) },
      },
    } as any,
    writes: {
      adopt: writeAdopt,
      propose: writePropose,
      line: writeLine,
    },
    project: async (tx, before, after) => {
      if (after.name === NONE) return;
      const d = (after as Live).data;
      const was = before.name === NONE ? null : (before as Live);
      if (!was || was.name !== after.name) {
        await tx.query(
          `UPDATE maintenance_campaigns
              SET status = $2, completed_at = CASE WHEN $2 = 'running' THEN NULL ELSE COALESCE(completed_at, NOW()) END
            WHERE id = $1 AND status IS DISTINCT FROM $2`,
          [d.campaignId, CAMPAIGN_STATUS.get(after.name as Name)]);
      }
      const prior = new Map((was ? was.data.apps : []).map((a) => [a.appId, a]));
      const changedApps = d.apps.filter((a) => {
        const b = prior.get(a.appId);
        return !b || b.state !== a.state || b.error !== a.error || b.sessionId !== a.sessionId;
      });
      if (!changedApps.length) return;
      // The proposal's link is the data's, but while it is being put up for a
      // vote the write that inserted the proposal set it (the data learns it
      // from the answer).
      await tx.query(
        `UPDATE maintenance_campaign_apps mca
            SET state = x.state, error = x.error, updated_at = NOW(),
                session_id = CASE WHEN x.keep THEN mca.session_id ELSE x.session_id END
           FROM jsonb_to_recordset($2::jsonb) AS x(app_id int, state text, error text, session_id int, keep boolean)
          WHERE mca.campaign_id = $1 AND mca.app_id = x.app_id`,
        [d.campaignId, JSON.stringify(changedApps.map((a) => ({
          app_id: a.appId, state: ROW_STATE.get(a.state), error: a.error, session_id: a.sessionId,
          keep: a.state === 'proposing' && a.sessionId == null,
        })))]);
    },
    reply: async (tx, event, after) => {
      if (after.name === NONE) return null;
      const d = (after as Live).data;
      const out: Record<string, Json> = { state: after.name };
      if (event.type === 'MergeGreen' && d.drained) out.asked = d.drained.asked;
      return out;
    },
  });
}

// ── Domain writes ───────────────────────────────────────────────────────

// The campaign's app rows (the targets, fixed at its start; rows already
// there are kept as they are).
async function writeAdopt(tx: Tx, w: any) {
  await tx.query(
    `INSERT INTO maintenance_campaign_apps (campaign_id, app_id)
     SELECT $1, x FROM unnest($2::int[]) AS x
     ON CONFLICT (campaign_id, app_id) DO NOTHING`, [w.campaignId, w.appIds]);
}

// A change made: its proposal's row (the platform's, its pull request open,
// holding no worker), linked to the campaign's app row, and its promote.
async function writePropose(tx: Tx, w: any, ctx: WriteContext) {
  const { rows: [s] } = await tx.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', 'maintenance') RETURNING id`,
    [w.appId, w.userId, w.branch, w.prNumber, w.prUrl, w.prTitle]);
  await tx.query('UPDATE maintenance_campaign_apps SET session_id = $3 WHERE campaign_id = $1 AND app_id = $2',
    [w.campaignId, w.appId, s.id]);
  ctx.message(promoteMessage({ sessionId: Number(s.id), appId: w.appId, userId: w.userId, head: w.head, key: w.key }));
}

async function writeLine(tx: Tx, w: any, ctx: WriteContext) {
  if (!w.appId || !w.issueId) return;
  const { rows: [row] } = await tx.query(
    `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, 'system', '{}'::jsonb, 'governance', $3)
     RETURNING id, app_id, content, msg_type, metadata, thread_type, thread_ref, created_at`,
    [w.appId, w.content, w.issueId]);
  ctx.push(chatLine(row));
}
