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

function parseRepo(url: string | null): Issue['app']['repo'] {
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url || '');
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

async function readIssue(tx: Tx, issueId: number): Promise<Issue | null> {
  const { rows: [r] } = await tx.query(
    `SELECT i.id, i.app_id, i.kind, i.status, i.title, i.payload, i.created_by, i.created_at,
            i.github_issue_number, u.username AS author_name,
            a.slug, a.name, a.self_hosted, a.repo_url, a.locked
       FROM issues i
       JOIN apps a ON a.id = i.app_id
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.id = $1`, [issueId]);
  if (!r) return null;
  return {
    id: r.id, appId: r.app_id, kind: r.kind, status: r.status, title: r.title, payload: r.payload || {},
    createdBy: r.created_by, authorName: r.author_name, createdAt: new Date(r.created_at).toISOString(),
    githubIssueNumber: r.github_issue_number,
    app: { slug: r.slug, name: r.name, selfHosted: !!r.self_hosted, repo: parseRepo(r.repo_url), locked: !!r.locked },
  };
}

async function readGate(tx: Tx, issue: Issue): Promise<{ gate: GateInputs; approverIds: number[] | null }> {
  const governance = legacy('services/governance');
  const gov = await governance.readGovernance(tx, issue.appId);
  const { active, approverIds } = await governance.getElectorate(tx, issue.appId, gov);
  const explicitApproval = issue.kind === 'secret_change';
  const counts = await governance.qualifiedCounts(tx, 'issue', issue.id, approverIds, { authorId: issue.createdBy });
  const memberCount = explicitApproval ? await governance.communityMemberCount(tx, issue.appId) : null;
  const { rows: admins } = await tx.query(
    `SELECT iv.user_id FROM issue_votes iv JOIN users u ON u.id = iv.user_id
      WHERE iv.issue_id = $1 AND iv.vote = 'up' AND u.is_admin AND NOT u.admin_readonly`, [issue.id]);
  return {
    approverIds,
    gate: {
      gov, active, yes: counts.yes, no: counts.no, otherYes: counts.otherYes ?? 0,
      explicitApproval, memberCount, authorId: issue.createdBy, openedAt: issue.createdAt,
      locked: issue.app.locked, adminUpVoters: admins.map((a: { user_id: number }) => a.user_id),
    },
  };
}

async function readVoter(tx: Tx, issueId: number, userId: number, approverIds: number[] | null): Promise<Voter> {
  const { rows: [r] } = await tx.query(
    `SELECT (SELECT vote FROM issue_votes WHERE issue_id = $1 AND user_id = $2) AS existing,
            counts_toward_issue_outcome($2, $1) AS counts,
            COALESCE((SELECT is_admin AND NOT admin_readonly FROM users WHERE id = $2), FALSE) AS is_admin`,
    [issueId, userId]);
  return {
    userId,
    existing: (r.existing === 'up' || r.existing === 'down') ? r.existing as Vote : null,
    qualifies: !!r.counts && (approverIds === null || approverIds.includes(userId)),
    isAdmin: !!r.is_admin,
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
  const issue = await readIssue(tx, issueId);
  if (!issue || !open) return { issue, gate: null, voter: null, refusal: null };
  const { gate, approverIds } = await readGate(tx, issue);
  const voter = event.type === 'VoteCast' ? await readVoter(tx, issue.id, event.payload.userId, approverIds) : null;
  return { issue, gate, voter, refusal: await readRefusal(tx, issue, dataKey) };
}
