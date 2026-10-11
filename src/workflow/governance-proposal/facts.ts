// What the governance machine reads inside its transaction, after the
// instance lock: the issue and its app, the gate's inputs, the voter, and
// whether applying now would fail. Read fresh every event; nothing cached.

import type { Event, Tx } from '../kernel/index.ts';
import { electorate } from '../rules/electorate.ts';
import { appMetaFromRow, governanceFromRow } from '../rules/governance-gate.ts';
import { GOVERNANCE_KINDS as KINDS } from '../rules/governance-kinds.ts';
import { parseGithubUrl } from '../rules/github-url.ts';
import { missingProposalImage } from '../rules/illustrations.ts';
import { isWritableKey, normalizeValue, validateValue } from '../rules/platform-vars.ts';
import { decrypt } from '../rules/secrets.ts';
import type { GateInputs, Vote, Voter } from './gate.ts';

export const GOVERNANCE_KINDS: ReadonlySet<string> = new Set(KINDS);

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
  return parseGithubUrl(url || '');
}

// One vote on the proposal, as the facts read it.
interface VoteRow { userId: number; vote: string; counts: boolean; admin: boolean }

// The issue, and its app as far as naming it goes. The row is locked:
// anything else that decides it ([main]'s apply, while old and new Pods
// overlap in a deploy) waits for this transition, or this transition waits
// for it and sees the row closed. Only the locked row is read as it is after
// a wait; what decides the proposal is read after it (readOpen).
async function readIssue(tx: Tx, issueId: number) {
  const { rows: [r] } = await tx.query(
    `SELECT i.id, i.app_id, i.kind, i.status, i.title, i.payload, i.created_by, i.created_at,
            i.github_issue_number, u.username AS author_name,
            a.slug, a.name, a.self_hosted, a.repo_url, a.locked
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
  return issue;
}

// What decides an open proposal, read in a statement of its own AFTER the
// row lock: a statement keeps the snapshot it started with, so a vote or a
// settings change committed while this transition waited for the lock would
// be missing from a read folded into the locking statement. The app's
// settings, its lock and self-hosting, its community's size, and the votes.
//
// Each vote carries counts_toward_issue_outcome (the shared rule: identity,
// test accounts) and whether its voter is a full admin; the counts are taken
// from them once the electorate is known (countVotes).
async function readOpen(tx: Tx, issue: Issue, voterId: number | null) {
  const { rows: [r] } = await tx.query(
    `SELECT a.approver_policy, a.approvals_required, a.self_hosted, a.collab_visibility, a.locked,
            (SELECT COALESCE(json_agg(json_build_object(
                      'userId', v.user_id, 'vote', v.vote,
                      'counts', counts_toward_issue_outcome(v.user_id, v.issue_id),
                      'admin', COALESCE(vu.is_admin AND NOT vu.admin_readonly, FALSE))), '[]'::json)
               FROM issue_votes v JOIN users vu ON vu.id = v.user_id
              WHERE v.issue_id = $1) AS votes,
            CASE WHEN $2::int IS NOT NULL THEN counts_toward_issue_outcome($2::int, $1) END AS voter_counts,
            CASE WHEN $2::int IS NOT NULL
              THEN COALESCE((SELECT is_admin AND NOT admin_readonly FROM users WHERE id = $2::int), FALSE) END AS voter_admin,
            -- governance.communityMemberCount, for the member floor of a secret change
            CASE WHEN $3::boolean THEN (SELECT COUNT(*)::int FROM community_members m
                                         WHERE m.community_id = a.community_id) END AS member_count
       FROM apps a
      WHERE a.id = $4`,
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

// The electorate (rules/electorate.ts, which services/governance.js uses
// too), with the app row passed in so it costs one query.
async function readGate(tx: Tx, issue: Issue, v: any): Promise<{ gate: GateInputs; approverIds: number[] | null }> {
  const gov = governanceFromRow(v);
  const { active, approverIds } = await electorate(tx, issue.appId, gov, appMetaFromRow(v));
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
      return missingProposalImage(tx, issue.appId, p, issue.id);
    case 'secret_change': {
      const key = String(p.key || '').trim();
      if (!key) return 'missing_key';
      if (issue.app.selfHosted && !isWritableKey(key)) return 'unwritable';
      if (p.action === 'delete') return null;
      // Without the data key every value reads as unreadable: a fault of
      // this process's configuration, never a verdict on the proposal.
      if (!dataKey) throw new Error('The data encryption key is not configured; the proposed value cannot be read');
      const plaintext = decrypt(p.valueEnc, dataKey);
      if (!plaintext) return 'undecryptable';
      if (issue.app.selfHosted && validateValue(normalizeValue(plaintext))) return 'invalid_value';
      return null;
    }
    default:
      return 'not_governance';
  }
}

export async function readFacts(tx: Tx, issueId: number, event: Event<any>, open: boolean, dataKey: string): Promise<Facts> {
  const locked = await readIssue(tx, issueId);
  if (!locked || !open) return { issue: locked, gate: null, voter: null, refusal: null };
  const voterId = event.type === 'VoteCast' ? event.payload.userId as number : null;
  const now = await readOpen(tx, locked, voterId);
  const issue: Issue = { ...locked, app: { ...locked.app, selfHosted: !!now.self_hosted, locked: !!now.locked } };
  const { gate, approverIds } = await readGate(tx, issue, now);
  const voter = voterId === null ? null : voterOf(now, voterId, approverIds);
  return { issue, gate, voter, refusal: await readRefusal(tx, issue, dataKey) };
}
