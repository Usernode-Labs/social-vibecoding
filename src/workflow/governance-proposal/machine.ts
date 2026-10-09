// governance-proposal: one instance per governance row in `issues`
// (secret_change, close_issue, maintenance_campaign, featured_illustration,
// and legacy rename). Votes, the gate, the apply and its follow-ups are
// transitions of this machine; see workflow-foundation's
// machine-governance-proposal.md for the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type {
  Check, DomainWrite, Event, Json, Machine, Notification, Outcome, Push, TransitionContext, Tx, WorkRequest,
  WorkResultPayload, WriteContext,
} from '../kernel/index.ts';
import { applyProposal } from '../rules/illustrations.ts';
import { decrypt, encrypt } from '../rules/secrets.ts';
import { deleteValue, setValue } from '../rules/platform-vars.ts';
import { appUpdate, chatLine, issuesClosed, issueUpdate as issuePush } from '../pushes.ts';
import { GOVERNANCE_KINDS, readFacts } from './facts.ts';
import type { Facts, Issue } from './facts.ts';
import { evaluate, nextCheck, withVote } from './gate.ts';
import type { Evaluation, Vote } from './gate.ts';

export const MACHINE = 'governance-proposal';
export const issueKey = (issueId: number) => `issue:${issueId}`;

// ── States ──────────────────────────────────────────────────────────────

interface Followup { kind: string; input: Json; status: 'pending' | 'done' | 'failed' | 'exhausted' | 'retried'; error?: string }

interface OpenData {
  issueId: number;
  kind: string;
  evaluation: Evaluation | null;
  targetCheck: string | null;        // work key of the close-issue target check in flight
  targetCheckedAt: string | null;
  // The gate passed (or an admin applied) and the target check decides:
  // admin null is the group vote.
  applyAfterCheck?: { admin: string | null; adminId?: number | null } | null;
}
interface ClosedData {
  issueId: number;
  kind: string;
  audit: Record<string, Json>;       // the keys projected into issues.payload
  followups: Record<string, Followup>;
}
export type GovState =
  | { name: 'open'; data: OpenData }
  | { name: 'applied' | 'refused' | 'withdrawn' | 'superseded'; data: ClosedData }
  | { name: typeof NONE; data: null };

type Closed = Exclude<GovState['name'], 'open' | typeof NONE>;

// ── Events ──────────────────────────────────────────────────────────────

const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const person = (p: any) => ({ userId: int(p?.userId, 'userId'), username: String(p?.username || '') });

const EVENTS = {
  Filed: (p: any) => ({ issueId: int(p?.issueId, 'issueId') }),
  VoteCast: (p: any) => {
    if (p?.vote !== 'up' && p?.vote !== 'down') throw new Error('vote must be up or down');
    const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim() : null;
    return { ...person(p), vote: p.vote as Vote, reason };
  },
  Evaluate: () => ({}),
  AdminApply: person,
  Withdraw: person,
  TargetClosed: (p: any) => {
    const cause = p?.cause?.kind === 'pr-merge'
      ? { kind: 'pr-merge' as const, prNumber: int(p.cause.prNumber, 'prNumber') }
      : { kind: 'github-close' as const };
    return { issueNumber: int(p?.issueNumber, 'issueNumber'), cause };
  },
  RetryFollowup: (p: any) => {
    if (typeof p?.workKey !== 'string' || !p.workKey) throw new Error('workKey is required');
    return { workKey: p.workKey as string };
  },
};

export interface MachineDeps {
  dataKey: string;               // config.dataEncryptionKey, to check a secret decrypts
  backstopMs?: number;           // re-evaluate an open proposal at least this often
  targetCheckMs?: number;        // how often an open close proposal checks its target on GitHub
  // One implementation per NOTIFIERS entry: post-commit kicks into flows not
  // migrated yet. What browsers hear is a push, published with the transition.
  notifiers: Record<string, (n: any) => void | Promise<void>>;
}

export const NOTIFIERS = ['boardChange', 'scoreVote', 'startCampaign'] as const;

// ── Copy ────────────────────────────────────────────────────────────────

function voteSubject(issue: Issue): string {
  const p = issue.payload;
  switch (issue.kind) {
    case 'rename': return `rename proposal "${p.newName || issue.title}"`;
    case 'secret_change': return `secret ${p.action === 'delete' ? 'removal' : 'change'} "${p.key || issue.title}"`;
    case 'close_issue': return `close proposal for issue #${p.issueNumber || '?'}`;
    case 'maintenance_campaign': return `maintenance campaign "${p.title || issue.title}"`;
    case 'featured_illustration':
      return p.remove ? 'the proposal to remove the featured illustration' : 'the proposed featured illustration';
    default: return `issue: "${issue.title}"`;
  }
}

const REFUSALS = new Map([
  ['missing_new_name', 'it names no new name.'],
  ['missing_issue_number', 'it names no issue to close.'],
  ['missing_instructions', 'it has no instructions.'],
  ['no_image', 'it names no image.'],
  ['image_unavailable', 'the proposed image is no longer available.'],
  ['missing_key', 'it names no variable.'],
  ['unwritable', 'that variable is now set by the deploy from a GitHub secret and cannot be written here.'],
  ['undecryptable', 'its value can no longer be read.'],
  ['invalid_value', 'its value is not a valid value for that variable.'],
]);

function appliedLine(issue: Issue, how: string, campaignTitle: string): string {
  const p = issue.payload;
  switch (issue.kind) {
    case 'rename': return `App renamed from "${issue.app.name}" to "${String(p.newName).trim()}" ${how}`;
    case 'featured_illustration':
      return p.proposed ? `Featured illustration changed ${how}` : `Featured illustration removed ${how}`;
    case 'close_issue': return `Issue #${p.issueNumber} closed ${how}`;
    case 'maintenance_campaign':
      return `Maintenance campaign "${campaignTitle}" approved ${how}. `
        + 'The platform is now opening one PR per app. Progress is on the campaign dashboard.';
    default: {
      const verb = p.action === 'delete' ? 'removed' : 'set';
      return issue.app.selfHosted
        ? `Platform variable "${String(p.key).trim()}" ${verb} ${how}; takes effect on the platform's next deploy.`
        : `Secret "${String(p.key).trim()}" ${verb} ${how}; redeploying…`;
    }
  }
}

// ── Outcomes ────────────────────────────────────────────────────────────

const chat = (event: Event<any>, issue: Issue, content: string, thread: { type: string; ref: number }, msgType = 'system'): DomainWrite =>
  ({ type: 'chat', eventId: event.id, appId: issue.appId, content, msgType, thread });
const governanceThread = (issue: Issue) => ({ type: 'governance', ref: issue.id });
const issueUpdate = (issue: Issue, action: string, extra: Record<string, Json> = {}): Push =>
  issuePush({ action, appId: issue.appId, appSlug: issue.app.slug, issueId: issue.id, ...extra });
// A request board changed: the Workshop re-places its cards (the kick
// ws.pushIssueUpdate gave its in-process listeners; services/workshop-themes.js).
const boardChange = (appId: number | null, appSlug: string | null): Notification => ({ type: 'boardChange', appId, appSlug });

// The thread lines an outcome writes push themselves (the chat and vote
// writes), with the rows they inserted.
interface Extra { writes?: DomainWrite[]; push?: Push[]; notify?: Notification[] }

function close(
  name: Closed, issue: Issue, event: Event<any>, ctx: TransitionContext,
  audit: Record<string, Json>, extra: Extra & { work?: WorkRequest[] },
): Outcome<GovState> {
  const work = [...(extra.work || [])];
  // The proposal's own GitHub twin (only legacy renames have one) closes with it.
  if (issue.githubIssueNumber && issue.app.repo) {
    work.push({ kind: 'github.closeIssue', key: 'twin', input: { ...issue.app.repo, number: issue.githubIssueNumber, comment: null } });
  }
  const followups: Record<string, Followup> = {};
  for (const w of work) followups[w.key] = { kind: w.kind, input: w.input, status: 'pending' };
  return {
    next: { name, data: { issueId: issue.id, kind: issue.kind, audit, followups } },
    writes: extra.writes,
    work,
    timer: null,
    push: [...(extra.push || []), issueUpdate(issue, 'closed')],
    notify: [...(extra.notify || []), boardChange(issue.appId, issue.app.slug)],
  };
}

function apply(
  issue: Issue, event: Event<any>, ctx: TransitionContext, e: Evaluation, refusal: string | null,
  by: { admin: string; adminId?: number | null } | null, extra: Extra,
): Outcome<GovState> {
  const at = ctx.now.toISOString();
  const tally = { upCount: e.yes, required: by ? e.yes : e.required, active: e.active };
  const writes = [...(extra.writes || [])];
  if (refusal) {
    const text = REFUSALS.get(refusal) || 'it can no longer be applied.';
    writes.push(chat(event, issue, `Proposal closed without applying: ${text}`, governanceThread(issue)));
    return close('refused', issue, event, ctx, { appliedAt: at, appliedBy: `refused:${refusal}`, ...tally }, { ...extra, writes });
  }
  const p = issue.payload;
  const how = by ? `by admin override (${by.admin})` : `by group vote (${tally.upCount}/${tally.required})`;
  const campaignTitle = String((typeof p.title === 'string' && p.title.trim()) || issue.title.replace(/^Maintenance campaign:\s*/, ''));
  const line = appliedLine(issue, how, campaignTitle);
  // The row is locked since the facts read it: its payload is current.
  writes.push({ type: 'apply', kind: issue.kind, issueId: issue.id, appId: issue.appId, selfHosted: issue.app.selfHosted,
    authorId: issue.createdBy, payload: issue.payload, campaignTitle, admin: by?.admin || null, adminId: by?.adminId ?? null });
  writes.push(chat(event, issue, line, governanceThread(issue)));
  const work: WorkRequest[] = [];
  const push: Push[] = [...(extra.push || [])];
  const notify: Notification[] = [...(extra.notify || [])];
  if (issue.kind === 'close_issue') {
    const n = Number(p.issueNumber);
    writes.push(chat(event, issue, line, { type: 'issue', ref: n }));
    if (issue.app.repo) {
      let comment = by ? `Closed by admin override (${by.admin}) on Homeroom.` : `Closed by group vote (${tally.upCount}/${tally.required}) on Homeroom.`;
      const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
      if (reason) comment += `\n\n${issue.authorName || 'The proposer'}'s reason: ${reason}`;
      work.push({ kind: 'github.closeIssue', key: 'target',
        input: { ...issue.app.repo, number: n, comment, marker: `homeroom-governance:${issueKey(issue.id)}:close`,
          bustCache: true, appId: issue.appId, appSlug: issue.app.slug } });
    }
  } else if (issue.kind === 'secret_change' && !issue.app.selfHosted) {
    work.push({ kind: 'app.rebuildProduction', key: 'rebuild', input: { appId: issue.appId } });
  } else if (issue.kind === 'rename') {
    push.push(appUpdate({ action: 'renamed', appId: issue.appId, slug: issue.app.slug,
      oldName: issue.app.name, newName: String(p.newName).trim() }));
  } else if (issue.kind === 'featured_illustration') {
    push.push(appUpdate({ action: 'illustration_changed', appId: issue.appId, slug: issue.app.slug,
      illustration: p.proposed || null }));
  } else if (issue.kind === 'maintenance_campaign') {
    notify.push({ type: 'startCampaign', issueId: issue.id });
  }
  const audit = { appliedAt: at, appliedBy: by ? `admin:${by.admin}` : 'group-vote', ...tally };
  return close('applied', issue, event, ctx, audit, { writes, work, push, notify });
}

type Timing = Required<Pick<MachineDeps, 'backstopMs' | 'targetCheckMs'>>;

// A close proposal applies only once a target check finds the issue still
// open on GitHub: an issue closed there by hand is announced by nothing
// else. [main] read its cached open-issue list at apply time and applied
// anyway when that read failed; a failed check here does the same.
const checksTarget = (issue: Issue) =>
  issue.kind === 'close_issue' && !!issue.app.repo && Number(issue.payload.issueNumber) > 0;

// Start a target check, unless one is in flight (its result decides too).
function targetCheckWork(data: OpenData, issue: Issue, ctx: TransitionContext): WorkRequest[] {
  if (data.targetCheck) return [];
  data.targetCheck = `target-check:${ctx.version + 1}`;
  return [{ kind: 'governance.checkTarget', key: data.targetCheck,
    input: { ...issue.app.repo!, number: Number(issue.payload.issueNumber) } }];
}

// Stay open until the target check answers, then apply as `by` says.
function awaitTarget(
  s: { data: OpenData }, issue: Issue, e: Evaluation, ctx: TransitionContext, timing: Timing,
  by: { admin: string | null; adminId?: number | null }, extra: Extra = {},
): Outcome<GovState> {
  const data: OpenData = { ...s.data, evaluation: e, applyAfterCheck: by };
  return {
    next: { name: 'open', data }, writes: extra.writes, push: extra.push, notify: extra.notify, work: targetCheckWork(data, issue, ctx),
    timer: { at: new Date(ctx.now.getTime() + timing.backstopMs), event: { type: 'Evaluate' } },
  };
}

// Evaluate the gate (with this event's vote folded in, if any) and either
// apply or stay open with the next check armed. `confirmed`: a target check
// has just answered.
function decide(
  s: { name: 'open'; data: OpenData }, event: Event<any>, f: Facts, ctx: TransitionContext,
  timing: Timing, gate = f.gate!, extra: Extra = {}, confirmed = false,
): Outcome<GovState> {
  const issue = f.issue!;
  const e = evaluate(gate, ctx.now);
  const admin = s.data.applyAfterCheck?.admin ? s.data.applyAfterCheck : null;
  if (e.mergeable && (confirmed || !checksTarget(issue))) return apply(issue, event, ctx, e, f.refusal, null, extra);
  if (e.mergeable || admin) return awaitTarget(s, issue, e, ctx, timing, admin || { admin: null }, extra);
  const data: OpenData = { ...s.data, evaluation: e, applyAfterCheck: null };
  const stale = !data.targetCheckedAt || ctx.now.getTime() - Date.parse(data.targetCheckedAt) >= timing.targetCheckMs;
  const work = checksTarget(issue) && stale ? targetCheckWork(data, issue, ctx) : [];
  return {
    next: { name: 'open', data }, writes: extra.writes, push: extra.push, notify: extra.notify, work,
    timer: { at: nextCheck(e, ctx.now, timing.backstopMs), event: { type: 'Evaluate' } },
  };
}

function supersede(issue: Issue, event: Event<any>, ctx: TransitionContext, cause: { kind: string; prNumber?: number }) {
  const n = issue.payload.issueNumber;
  const line = cause.kind === 'pr-merge'
    ? `Close proposal for issue #${n} resolved automatically: PR #${cause.prNumber} closed the issue`
    : `Close proposal for issue #${n} resolved automatically: the issue was closed on GitHub`;
  return close('superseded', issue, event, ctx,
    { supersededAt: ctx.now.toISOString(), supersededBy: cause.kind === 'pr-merge' ? `pr-merge:#${cause.prNumber}` : 'github-close' },
    { writes: [chat(event, issue, line, governanceThread(issue))] });
}

// A follow-up result on a closed proposal updates its record.
// A target closed on GitHub: every web process stops listing it (GitHub's
// list lags; pushes.ts issuesClosed), then the open-issues lists re-read.
function followupResult(s: { name: Closed; data: ClosedData }, e: Event<WorkResultPayload>, status: Followup['status']): Outcome<GovState> {
  const prev = s.data.followups[e.payload.workKey]!;
  const followups = { ...s.data.followups, [e.payload.workKey]: { ...prev, status, ...(e.payload.error ? { error: e.payload.error.message } : {}) } };
  const input = (prev.input || {}) as Record<string, Json>;
  const closed = status === 'done' && e.payload.kind === 'github.closeIssue' && input.bustCache
    && !(e.payload.result as { gone?: boolean } | null)?.gone;
  return {
    next: { name: s.name, data: { ...s.data, followups } },
    push: closed ? [
      issuesClosed({ owner: String(input.owner), repo: String(input.repo), numbers: [Number(input.number)] }),
      issuePush({ action: 'github_synced', appSlug: input.appSlug ?? null, appId: input.appId ?? null, source: 'close_issue_vote' }),
    ] : undefined,
    notify: closed ? [boardChange(input.appId as number ?? null, input.appSlug as string ?? null)] : undefined,
  };
}

// Something other than this machine closed or deleted the issue row: the
// flag was turned off for a while and [main]'s paths decided it, or the app
// was deleted. The proposal ends without applying, and the row, which
// already says what happened, is left as it is (see project).
const OUTSIDE = new Set(['closed_outside', 'issue_gone']);
const outside = (f: Facts) => (!f.issue ? 'issue_gone' : f.issue.status !== 'open' ? 'closed_outside' : null);

function endOutside(s: { data: OpenData }, cause: string, ctx: TransitionContext): Outcome<GovState> {
  return {
    next: { name: 'superseded', data: { issueId: s.data.issueId, kind: s.data.kind,
      audit: { supersededAt: ctx.now.toISOString(), supersededBy: cause }, followups: {} } },
    timer: null,
  };
}

// Every transition from `open` checks that first.
function watchingOutside(t: { guard?: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => Check;
  to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<GovState> }) {
  return {
    guard: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => (outside(f) || !t.guard ? ok() : t.guard(s, e, f, ctx)),
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => {
      const cause = outside(f);
      return cause ? endOutside(s, cause, ctx) : t.to(s, e, f, ctx);
    },
  };
}

const pendingFollowup = (s: any, e: Event<WorkResultPayload>): Check =>
  s.data.followups[e.payload.workKey]?.status === 'pending' ? ok() : reject('stale_result');

// ── The machine ─────────────────────────────────────────────────────────

export function governanceProposal(deps: MachineDeps): Machine<GovState, Facts> {
  for (const n of NOTIFIERS) if (typeof deps.notifiers[n] !== 'function') throw new Error(`governance-proposal: notifier ${n} missing`);
  const timing = { backstopMs: deps.backstopMs ?? 10 * 60 * 1000, targetCheckMs: deps.targetCheckMs ?? 60 * 60 * 1000 };
  const user = (e: Event<any>) => e.actor === `user:${e.payload.userId}`;
  const closedRow = {
    '*': { ignore: 'not_open' },
    WorkSucceeded: { guard: pendingFollowup, to: (s: any, e: Event<any>) => followupResult(s, e, 'done') },
    WorkFailed: { guard: pendingFollowup, to: (s: any, e: Event<any>) => followupResult(s, e, 'failed') },
    WorkExhausted: { guard: pendingFollowup, to: (s: any, e: Event<any>) => followupResult(s, e, 'exhausted') },
    RetryFollowup: {
      guard: (s: any, e: Event<any>) => (['failed', 'exhausted'].includes(s.data.followups[e.payload.workKey]?.status)
        ? ok() : reject('not_retryable')),
      to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<GovState> => {
        const prev = s.data.followups[e.payload.workKey] as Followup;
        const key = `${e.payload.workKey.replace(/~\d+$/, '')}~${ctx.version + 1}`;
        const followups = { ...s.data.followups, [e.payload.workKey]: { ...prev, status: 'retried' }, [key]: { ...prev, status: 'pending' } };
        // The retry starts from the failed item's checkpoint: a close that
        // already commented does not comment again.
        return {
          next: { name: s.name, data: { ...s.data, followups } },
          work: [{ kind: prev.kind, key, input: prev.input, continues: e.payload.workKey }],
        };
      },
    },
  } as const;
  const targetCheckResult = (status: 'done' | 'failed') => ({
    guard: (s: any, e: Event<WorkResultPayload>) => (s.data.targetCheck === e.payload.workKey ? ok() : reject('stale_result')),
    to: (s: any, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<GovState> => {
      const result = e.payload.result as { open?: boolean } | undefined;
      if (status === 'done' && result?.open === false && f.issue) return supersede(f.issue, e, ctx, { kind: 'github-close' });
      const checked = { name: 'open' as const, data: { ...s.data, targetCheck: null, targetCheckedAt: ctx.now.toISOString() } };
      const pending = (s.data as OpenData).applyAfterCheck;
      if (!pending) return { next: checked };
      // Still open (or GitHub could not say): apply as the gate or the admin decided.
      if (pending.admin) return apply(f.issue!, e, ctx, evaluate(f.gate!, ctx.now), f.refusal, { admin: pending.admin, adminId: pending.adminId ?? null }, {});
      return decide(checked, e, f, ctx, timing, f.gate!, {}, true);
    },
  });

  return defineMachine<GovState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['Filed'],
    terminal: ['applied', 'refused', 'withdrawn', 'superseded'],
    decode: (row) => ({ name: row.state, data: row.data } as GovState),
    facts: (tx, state, event, ctx) => {
      // Before Filed, only Filed names the issue; any other event (one a
      // route sends to a row not enrolled yet) reads it off the key.
      const issueId = state.data ? state.data.issueId : event.payload.issueId ?? Number(ctx.key.slice('issue:'.length));
      return readFacts(tx, issueId, event, state.name === 'open' || state.name === NONE, deps.dataKey);
    },
    authorize: {
      Filed: (e) => (['route', 'system', 'admin'].includes(e.source.kind) ? ok() : reject('not_allowed')),
      VoteCast: (e) => (e.source.kind === 'route' && user(e) ? ok() : reject('not_the_voter')),
      Evaluate: (e) => (e.source.kind === 'timer' || e.source.kind === 'admin' ? ok() : reject('internal_only')),
      AdminApply: (e) => (e.source.kind === 'admin' && user(e) ? ok() : reject('admin_only')),
      Withdraw: (e, f) => (user(e) && f.issue?.createdBy === e.payload.userId ? ok() : reject('not_author')),
      TargetClosed: (e) => (e.source.kind === 'system' || e.source.kind === 'route' ? ok() : reject('internal_only')),
      RetryFollowup: (e) => (e.source.kind === 'admin' ? ok() : reject('admin_only')),
    },
    transitions: {
      [NONE]: {
        Filed: {
          guard: (s, e, f) => (!f.issue ? reject('no_issue')
            : !GOVERNANCE_KINDS.has(f.issue.kind) ? reject('not_governance')
              : f.issue.status !== 'open' ? reject('not_open') : ok()),
          to: (s, e, f, ctx) => decide(
            { name: 'open', data: { issueId: f.issue!.id, kind: f.issue!.kind, evaluation: null, targetCheck: null, targetCheckedAt: null, applyAfterCheck: null } },
            e, f, ctx, timing),
        },
      },
      open: {
        Filed: { ignore: 'already_filed' },
        VoteCast: watchingOutside({
          // A No needs its line, except as a retraction (the same click again).
          guard: (s, e, f) => (f.voter!.existing !== e.payload.vote && e.payload.vote === 'down' && !e.payload.reason
            ? reject('reason_required') : ok()),
          to: (s, e, f, ctx) => {
            const issue = f.issue!;
            const vote: Vote | null = f.voter!.existing === e.payload.vote ? null : e.payload.vote;
            const r = e.payload.reason;
            // The vote, its events row and its thread line are one statement.
            const line = vote
              ? chat(e, issue, `${e.payload.username} voted ${vote} on ${voteSubject(issue)}${r ? `: “${r}”` : ''}`, governanceThread(issue), 'vote')
              : null;
            const writes: DomainWrite[] = [{ type: 'vote', issueId: issue.id, appId: issue.appId, userId: e.payload.userId, vote, reason: r, line }];
            const push = [issueUpdate(issue, 'voted', vote ? { vote } : { toggled: true })];
            const notify: Notification[] = [boardChange(issue.appId, issue.app.slug), ...(vote ? [{ type: 'scoreVote' }] : [])];
            return decide(s as any, e, f, ctx, timing, withVote(f.gate!, f.voter!, vote), { writes, push, notify });
          },
        }),
        Evaluate: watchingOutside({ to: (s, e, f, ctx) => decide(s as any, e, f, ctx, timing) }),
        AdminApply: watchingOutside({
          guard: (s, e, f) => (f.issue!.kind === 'rename' ? reject('not_admin_appliable') : ok()),
          to: (s, e, f, ctx) => (checksTarget(f.issue!)
            ? awaitTarget(s, f.issue!, evaluate(f.gate!, ctx.now), ctx, timing, { admin: e.payload.username, adminId: e.payload.userId })
            : apply(f.issue!, e, ctx, evaluate(f.gate!, ctx.now), f.refusal, { admin: e.payload.username, adminId: e.payload.userId }, {})),
        }),
        Withdraw: watchingOutside({
          to: (s, e, f, ctx) => close('withdrawn', f.issue!, e, ctx,
            { withdrawnAt: ctx.now.toISOString(), withdrawnBy: e.payload.username },
            { writes: [chat(e, f.issue!, `${e.payload.username} withdrew their proposal: "${f.issue!.title}"`, governanceThread(f.issue!))] }),
        }),
        TargetClosed: watchingOutside({
          guard: (s, e, f) => (f.issue!.kind === 'close_issue' && Number(f.issue!.payload.issueNumber) === e.payload.issueNumber
            ? ok() : reject('not_target')),
          to: (s, e, f, ctx) => supersede(f.issue!, e, ctx, e.payload.cause),
        }),
        RetryFollowup: { ignore: 'no_followups' },
        WorkSucceeded: watchingOutside(targetCheckResult('done')),
        WorkFailed: watchingOutside(targetCheckResult('failed')),
        WorkExhausted: watchingOutside(targetCheckResult('failed')),
      },
      applied: closedRow,
      refused: closedRow,
      withdrawn: closedRow,
      superseded: closedRow,
    },
    writes: {
      vote: writeVote,
      chat: async (tx, w, ctx) => {
        const { rows: [row] } = await tx.query(
          `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, app_id, content, msg_type, metadata, thread_type, thread_ref, created_at`, chatValues(w));
        ctx.push(chatLine(row));
      },
      apply: (tx, w) => applyKind(tx, w, deps.dataKey),
    },
    async project(tx, before, after) {
      // On entering a closed state, from open or straight from Filed (a
      // proposal already decided, or already broken, when it is enrolled).
      if (after.name === 'open' || before.name === after.name) return;
      const data = after.data as ClosedData;
      if (OUTSIDE.has(String(data.audit.supersededBy))) return;
      // A secret's ciphertext never outlives the proposal, however it ended.
      await tx.query(
        `UPDATE issues i
            SET status = 'closed',
                payload = (CASE WHEN i.kind = 'secret_change' THEN i.payload - 'valueEnc' ELSE i.payload END)
                          || $2::jsonb
                          || CASE WHEN i.kind = 'maintenance_campaign' AND $3::boolean THEN COALESCE(
                               (SELECT jsonb_build_object('campaignId', c.id) FROM maintenance_campaigns c
                                 WHERE c.issue_id = i.id ORDER BY c.id DESC LIMIT 1), '{}'::jsonb)
                             ELSE '{}'::jsonb END
          WHERE i.id = $1`,
        [data.issueId, JSON.stringify(data.audit), after.name === 'applied']);
    },
    // What the vote and admin-apply routes answer, recorded with the receipt
    // so a retried request gets the answer it got the first time. A vote
    // the same as the voter's existing one took it back (the facts say so);
    // a vote on a row closed outside the machine recorded nothing.
    async reply(tx, event, after, ctx, facts): Promise<Json | undefined> {
      if (event.type !== 'VoteCast' && event.type !== 'AdminApply') return undefined;
      if (event.type === 'VoteCast' && facts.issue?.status === 'open' && facts.voter?.existing === event.payload.vote) {
        return { toggled: true };
      }
      return { result: await kindResult(tx, after, facts) };
    },
    notifiers: deps.notifiers,
  });
}

// ── Domain writes ───────────────────────────────────────────────────────

// The per-kind result the client has always read off a vote or an admin
// apply: { applied, superseded, refused, awaitingAdmin, ... }. It is what
// the projection wrote into the row: the payload the facts read, and the
// audit (only a campaign's id, set by the projection, is read back).
async function kindResult(tx: Tx, after: GovState, facts: Facts): Promise<Json> {
  if (after.name === 'open') {
    const e: Partial<Evaluation> = after.data.evaluation || {};
    return { applied: false, awaitingAdmin: e.waiting === 'awaiting_admin', upCount: e.yes, required: e.required,
      active: e.active, windowEndsAt: e.windowEndsAt, waitingForWindow: e.waiting === 'waiting_for_window',
      checkingTarget: !!after.data.applyAfterCheck } as Json;
  }
  if (after.name === 'superseded') return { applied: false, superseded: true };
  const audit = (after.data as ClosedData).audit;
  if (after.name === 'applied') {
    const p = facts.issue?.payload || {};
    const campaignId = facts.issue?.kind === 'maintenance_campaign'
      ? (await tx.query('SELECT payload->\'campaignId\' AS id FROM issues WHERE id = $1', [facts.issue.id])).rows[0]?.id
      : undefined;
    return { applied: true, issueNumber: p.issueNumber, newName: p.newName, campaignId,
      illustration: p.proposed || null, upCount: audit.upCount, required: audit.required, active: audit.active } as Json;
  }
  if (after.name === 'refused') return { applied: false, refused: true, error: String(audit.appliedBy || '').replace(/^refused:/, '') };
  return { applied: false };
}

const chatValues = (w: any) => [w.appId, w.content, w.msgType, JSON.stringify({ wfEvent: w.eventId }), w.thread.type, w.thread.ref];

// One statement: the vote, its `events` row and its thread line. A flip
// replaces the line: the old sentence argued for the side this vote left.
async function writeVote(tx: Tx, w: any, ctx: WriteContext) {
  if (!w.vote) {
    await tx.query('DELETE FROM issue_votes WHERE issue_id = $1 AND user_id = $2', [w.issueId, w.userId]);
    return;
  }
  const line = w.line ? chatValues(w.line) : [null, null, null, null, null, null];
  const { rows } = await tx.query(
    `WITH voted AS (
       INSERT INTO issue_votes (issue_id, user_id, vote, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (issue_id, user_id) DO UPDATE
         SET vote = EXCLUDED.vote, reason = EXCLUDED.reason, created_at = NOW()
       RETURNING id),
     logged AS (
       INSERT INTO events (user_id, app_id, event_type, metadata)
       SELECT $2, $5, $6, jsonb_build_object('vote', $3::text, 'issueId', $1::int, 'issueVoteId', voted.id) FROM voted),
     line AS (
       INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
       SELECT $7, $8, $9, $10::jsonb, $11, $12 WHERE $8::text IS NOT NULL
       RETURNING id, app_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
     SELECT * FROM line`,
    [w.issueId, w.userId, w.vote, w.reason, w.appId, 'issue_vote_cast', ...line]);
  for (const row of rows) ctx.push(chatLine(row));
}

// The kind's own change, in the transaction that closes the proposal.
async function applyKind(tx: Tx, w: any, dataKey: string) {
  const p = w.payload || {};
  switch (w.kind) {
    case 'rename':
      await tx.query('UPDATE apps SET name = $1 WHERE id = $2', [String(p.newName).trim(), w.appId]);
      return;
    case 'featured_illustration':
      await applyProposal(tx, w.appId, p, w.issueId);
      return;
    case 'close_issue':
      // The platform's open twin rows for the target, and its open bounties
      // (no merged PR, so nobody earns them).
      await tx.query(
        `UPDATE issues SET status = 'closed'
          WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open' AND kind = 'general'`,
        [w.appId, Number(p.issueNumber)]);
      await tx.query(
        `UPDATE issue_bounties SET status = 'voided', awarded_at = NOW()
          WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'`,
        [w.appId, Number(p.issueNumber)]);
      return;
    case 'maintenance_campaign': {
      const targetFilter = Array.isArray(p.targetFilter) && p.targetFilter.length ? p.targetFilter : null;
      await tx.query(
        `INSERT INTO maintenance_campaigns (issue_id, title, instructions, target_filter, status, created_by)
         VALUES ($1, $2, $3, $4, 'running', $5)`,
        [w.issueId, w.campaignTitle.slice(0, 300), p.instructions.trim(),
          targetFilter ? JSON.stringify(targetFilter) : null, w.authorId]);
      return;
    }
    case 'secret_change':
      await applySecret(tx, w, p, w.authorId, dataKey);
      return;
    default:
      throw new Error(`governance-proposal: no apply for kind ${w.kind}`);
  }
}

async function applySecret(tx: Tx, w: any, p: any, createdBy: number | null, dataKey: string) {
  const key = String(p.key).trim();
  const isPrivate = !!(p.private || p.sensitive);
  if (p.action === 'delete') {
    if (w.selfHosted) await deleteValue(tx, w.appId, key);
    else await tx.query('DELETE FROM app_secrets WHERE app_id = $1 AND key = $2', [w.appId, key]);
  } else {
    const plaintext = decrypt(p.valueEnc, dataKey)!;
    if (w.selfHosted) {
      // The DAO re-encrypts, re-checks writability and takes `private` from the declaration.
      await setValue(tx, w.appId, key, plaintext, { userId: createdBy, dataKey });
    } else {
      await tx.query(
        `INSERT INTO app_secrets (app_id, key, value_enc, value_last4, updated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (app_id, key)
         DO UPDATE SET value_enc = EXCLUDED.value_enc, value_last4 = EXCLUDED.value_last4,
                       updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [w.appId, key, encrypt(plaintext, dataKey), isPrivate ? null : plaintext.slice(-4), createdBy]);
    }
  }
  if (w.selfHosted) {
    // One event type for a platform-variable change whichever path wrote
    // it, recorded as [main] did: by the admin who forced it, else by the
    // proposal's author.
    await tx.query(
      `INSERT INTO events (user_id, app_id, event_type, metadata) VALUES ($1, $2, 'platform_env_changed', $3::jsonb)`,
      [w.admin ? (w.adminId ?? null) : createdBy, w.appId, JSON.stringify({
        key, action: p.action === 'delete' ? 'clear' : 'set', private: isPrivate,
        appliedBy: w.admin ? 'admin-force-apply' : 'group-vote',
      })]);
  }
}
