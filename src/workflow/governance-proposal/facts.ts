// What the governance machine reads inside its transaction, after the
// instance lock: the issue and its app, the gate's inputs, the voter, and
// whether applying now would fail. Read fresh every event; nothing cached.

import { legacy } from '../legacy.ts';
import type { Event, Tx } from '../kernel/index.ts';
import type { GateInputs, Vote, Voter } from './gate.ts';

export const GOVERNANCE_KINDS: ReadonlySet<string> = new Set(
  legacy('services/governance-kinds').GOVERNANCE_KINDS as string[],
);

export interface Issue {
  id: number;
  appId: number;
  kind: string;
  status: string;
  title: string;
  payload: Record<string, any>;
  createdBy: number | null;
  authorName: string | null;
  createdAt: string;
  githubIssueNumber: number | null;
  app: { slug: string; name: string; selfHosted: boolean; repo: { owner: string; repo: string } | null; locked: boolean };
}

export interface Facts {
  issue: Issue | null;
  gate: GateInputs | null;     // while the proposal is open
  voter: Voter | null;         // for VoteCast
  refusal: string | null;      // why applying now would fail
}

// The platform's own parser: https, ssh, a .git suffix, and dotted names.
function parseRepo(url: string | null): Issue['app']['repo'] {
  return legacy('services/github').parseGithubUrl(url || '');
}

// One vote on the proposal, as the facts read it.
interface VoteRow { userId: number; vote: string; counts: boolean; admin: boolean }

// The issue and its app (with the governance and electorate columns). The
// row is locked: anything else that decides it ([main]'s apply, while old
// and new Pods overlap in a deploy) waits for this transition, or this
// transition waits for it and sees the row closed.
async function readIssue(tx: Tx, issueId: number) {
  const { rows: [r] } = await tx.query(
    `SELECT i.id, i.app_id, i.kind, i.status, i.title, i.payload, i.created_by, i.created_at,
            i.github_issue_number, u.username AS author_name,
            a.slug, a.name, a.self_hosted, a.repo_url, a.locked, a.collab_visibility,
            a.approver_policy, a.approvals_required
       FROM issues i
       JOIN apps a ON a.id = i.app_id
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.id = $1
        FOR UPDATE OF i`, [issueId]);
  if (!r) return null;
  const issue: Issue = {
    id: r.id, appId: r.app_id, kind: r.kind, status: r.status, title: r.title, payload: r.payload || {},
    createdBy: r.created_by, authorName: r.author_name, createdAt: new Date(r.created_at).toISOString(),
    githubIssueNumber: r.github_issue_number,
    app: { slug: r.slug, name: r.name, selfHosted: !!r.self_hosted, repo: parseRepo(r.repo_url), locked: !!r.locked },
  };
  return { issue, row: r };
}

// Everything about the votes, read in a statement of its own AFTER the row
// lock: a statement keeps the snapshot it started with, so a vote [main]
// committed while this transition waited for the lock would be missing from
// a read folded into the locking statement.
//
// Each vote carries counts_toward_issue_outcome (the shared rule: identity,
// test accounts) and whether its voter is a full admin; the counts are taken
// from them once the electorate is known (countVotes).
async function readVotes(tx: Tx, issue: Issue, voterId: number | null) {
  const { rows: [r] } = await tx.query(
    `SELECT (SELECT COALESCE(json_agg(json_build_object(
                      'userId', v.user_id, 'vote', v.vote,
                      'counts', counts_toward_issue_outcome(v.user_id, v.issue_id),
                      'admin', COALESCE(vu.is_admin AND NOT vu.admin_readonly, FALSE))), '[]'::json)
               FROM issue_votes v JOIN users vu ON vu.id = v.user_id
              WHERE v.issue_id = $1) AS votes,
            CASE WHEN $2::int IS NOT NULL THEN counts_toward_issue_outcome($2::int, $1) END AS voter_counts,
            CASE WHEN $2::int IS NOT NULL
              THEN COALESCE((SELECT is_admin AND NOT admin_readonly FROM users WHERE id = $2::int), FALSE) END AS voter_admin,
            -- governance.communityMemberCount, for the member floor of a secret change
            CASE WHEN $3::boolean THEN (SELECT COUNT(m.user_id)::int FROM apps a
                                          JOIN community_members m ON m.community_id = a.community_id
                                         WHERE a.id = $4) END AS member_count`,
    [issue.id, voterId, issue.kind === 'secret_change', issue.appId]);
  return r;
}

// services/governance.js qualifiedCounts, over the vote rows already read:
// a vote counts when counts_toward_issue_outcome holds and its voter is in
// the electorate (approverIds null: everyone); otherYes leaves out the
// author's own Yes (a null author: every Yes is someone else's).
export function countVotes(votes: VoteRow[], approverIds: number[] | null, authorId: number | null) {
  const counted = votes.filter((v) => v.counts && (approverIds === null || approverIds.includes(v.userId)));
  return {
    yes: counted.filter((v) => v.vote === 'up').length,
    no: counted.filter((v) => v.vote === 'down').length,
    otherYes: counted.filter((v) => v.vote === 'up' && v.userId !== authorId).length,
  };
}

// The electorate is [main]'s JavaScript (governance.getElectorate), with
// the app row passed in so it costs one query.
async function readGate(tx: Tx, issue: Issue, app: any, v: any): Promise<{ gate: GateInputs; approverIds: number[] | null }> {
  const governance = legacy('services/governance');
  const gov = governance.governanceFromRow(app);
  const { active, approverIds } = await governance.getElectorate(tx, issue.appId, gov,
    legacy('services/active-users').appMetaFromRow(app));
  const explicitApproval = issue.kind === 'secret_change';
  const votes = v.votes as VoteRow[];
  const counts = countVotes(votes, approverIds, issue.createdBy);
  return {
    approverIds,
    gate: {
      gov, active, yes: counts.yes, no: counts.no, otherYes: counts.otherYes,
      explicitApproval, memberCount: explicitApproval ? Number(v.member_count) || 0 : null,
      authorId: issue.createdBy, openedAt: issue.createdAt, locked: issue.app.locked,
      adminUpVoters: votes.filter((x) => x.vote === 'up' && x.admin).map((x) => x.userId),
    },
  };
}

function voterOf(r: any, userId: number, approverIds: number[] | null): Voter {
  const existing = (r.votes as VoteRow[]).find((v) => v.userId === userId)?.vote;
  return {
    userId,
    existing: (existing === 'up' || existing === 'down') ? existing as Vote : null,
    qualifies: !!r.voter_counts && (approverIds === null || approverIds.includes(userId)),
    isAdmin: !!r.voter_admin,
  };
}

// The per-kind reasons [main] would fail (or loop) at apply time, checked
// up front so the proposal ends `refused` instead of staying open.
async function readRefusal(tx: Tx, issue: Issue, dataKey: string): Promise<string | null> {
  const p = issue.payload;
  switch (issue.kind) {
    case 'rename':
      return String(p.newName || '').trim() ? null : 'missing_new_name';
    case 'close_issue':
      return Number.isInteger(Number(p.issueNumber)) && Number(p.issueNumber) > 0 ? null : 'missing_issue_number';
    case 'maintenance_campaign':
      return typeof p.instructions === 'string' && p.instructions.trim() ? null : 'missing_instructions';
    case 'featured_illustration':
      return legacy('services/illustration-proposals').missingProposalImage(tx, issue.appId, p, issue.id);
    case 'secret_change': {
      const platformEnv = legacy('services/platform-env');
      const key = String(p.key || '').trim();
      if (!key) return 'missing_key';
      if (issue.app.selfHosted && !platformEnv.isWritableKey(key)) return 'unwritable';
      if (p.action === 'delete') return null;
      const plaintext = legacy('services/secrets').decrypt(p.valueEnc, dataKey);
      if (!plaintext) return 'undecryptable';
      if (issue.app.selfHosted && platformEnv.validateValue(platformEnv.normalizeValue(plaintext))) return 'invalid_value';
      return null;
    }
    default:
      return 'not_governance';
  }
}

export async function readFacts(tx: Tx, issueId: number, event: Event<any>, open: boolean, dataKey: string): Promise<Facts> {
  const read = await readIssue(tx, issueId);
  if (!read || !open) return { issue: read?.issue ?? null, gate: null, voter: null, refusal: null };
  const { issue, row } = read;
  const voterId = event.type === 'VoteCast' ? event.payload.userId as number : null;
  const votes = await readVotes(tx, issue, voterId);
  const { gate, approverIds } = await readGate(tx, issue, row, votes);
  const voter = voterId === null ? null : voterOf(votes, voterId, approverIds);
  return { issue, gate, voter, refusal: await readRefusal(tx, issue, dataKey) };
}
