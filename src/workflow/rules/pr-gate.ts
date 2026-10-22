// A proposal's vote gate (a pull request's: chat_sessions + pr_votes), read
// fresh inside a transaction that holds the proposal's row lock. The proposal
// machine decides with it when a merge claims the proposal and when its hourly
// review check looks for a vote that took it down, so a vote committed while
// the decision waited for the lock is counted (bugs R1/R2 of the proposal
// lifecycle). services/governance.js governedGate is the same rule for the
// paths that only show it (the cards, the merge's own early returns), through
// its short caches; this one reads every input itself and caches nothing.
//
// The rule is rules/governance-gate.ts computeGate; the electorate is
// rules/electorate.ts; a vote counts when its epoch is the proposal's and
// counts_toward_session_outcome holds; a project's first version waives the
// vote (rules/first-version.ts).

import type { Queryable } from './db.ts';
import { electorate, activeUserIds } from './electorate.ts';
import { appMetaFromRow, computeGate, governanceFromRow } from './governance-gate.ts';
import type { GovernedGate } from './governance-gate.ts';
import type { RulesFacts } from './governance-rules.ts';
import { firstVersionSql } from './first-version.ts';

export interface PrGateInputs {
  sessionId: number;
  appId: number;
  // promoted_at, else created_at: the clock every window runs from.
  openedAt: string | Date | null;
  // A protected settings change (#788): no clocks, and someone other than
  // the author must say Yes. Its reason says which rule decides it on a
  // project with rules of its own (#4666).
  explicitApproval: boolean;
  explicitReason: string | null;
  authorId: number | null;
  now: Date;
}

interface VoteRow { userId: number; vote: string; counts: boolean }

// One statement for everything the gate reads about the app and the
// proposal: the governance columns and rules, the app meta the electorate
// needs, what a project's own rules read (creator, community size, admins),
// the counted votes on the current epoch, whether the change is the
// project's first version, and whether its author is an account the
// platform runs.
const GATE_SQL = `
  SELECT a.approver_policy, a.approvals_required, a.governance_rules, a.self_hosted, a.collab_visibility, a.created_by,
         (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS member_count,
         COALESCE((SELECT array_agg(ad.user_id) FROM app_admins ad WHERE ad.app_id = a.id), '{}') AS admin_ids,
         COALESCE((SELECT array_agg(u.id) FROM users u WHERE u.is_admin AND NOT u.admin_readonly), '{}') AS platform_admin_ids,
         (SELECT COALESCE(json_agg(json_build_object(
                   'userId', pv.user_id, 'vote', pv.vote,
                   'counts', counts_toward_session_outcome(pv.user_id, pv.session_id))), '[]'::json)
            FROM pr_votes pv
           WHERE pv.session_id = cs.id AND pv.vote IN ('yes', 'no')
             AND pv.approval_epoch = cs.approval_epoch) AS votes,
         ${firstVersionSql('cs')} AS first_version,
         COALESCE((SELECT u.is_synthetic FROM users u WHERE u.id = $3::int), FALSE) AS author_is_bot
    FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
   WHERE cs.id = $1 AND a.id = $2`;

/**
 * The governed gate of one proposal, as services/governance.js governedGate
 * answers it for kind 'pr', from reads made now in `db`. Null when the
 * proposal or its app is gone.
 */
export async function readPrGate(db: Queryable, g: PrGateInputs): Promise<GovernedGate | null> {
  const { rows: [r] } = await db.query(GATE_SQL, [g.sessionId, g.appId, g.authorId]);
  if (!r) return null;
  const gov = governanceFromRow(r);
  const meta = appMetaFromRow(r);
  const votes = ((r.votes || []) as VoteRow[]).filter((v) => v.counts);
  const opened = g.openedAt == null ? null : new Date(g.openedAt).getTime();
  const now = g.now.getTime();
  const firstVersion = r.first_version === true;
  // The counted votes, by voter, unfiltered by the approver roster: a
  // builder's Yes (§5816) decides whether or not the roster names them.
  const voters = {
    yes: new Set(votes.filter((v) => v.vote === 'yes').map((v) => Number(v.userId))),
    no: new Set(votes.filter((v) => v.vote === 'no').map((v) => Number(v.userId))),
  };
  const appFacts: RulesFacts = {
    creatorId: !r.self_hosted && r.created_by ? Number(r.created_by) : null,
    memberCount: Number(r.member_count) || 0,
    membersActive: 1,
    adminIds: ((r.admin_ids || []) as unknown[]).map(Number).filter(Number.isFinite),
    platformAdminIds: ((r.platform_admin_ids || []) as unknown[]).map(Number).filter(Number.isFinite),
    groups: new Map(gov.rules ? gov.rules.groups.map((x) => [x.key, x.ids || []]) : []),
    activeIds: null,
  };
  if (gov.rules) {
    // #4666: a rules project decides by who voted and what its groups are.
    const { active } = await electorate(db, g.appId, gov, meta);
    const wantsActive = gov.rules.rules.some((x) => x.kind === 'percentOfActive' && x.group !== 'members');
    const facts: RulesFacts = {
      ...appFacts,
      membersActive: Math.max(Number(active) || 0, 1),
      activeIds: wantsActive ? new Set(await activeUserIds(db, g.appId, meta)) : null,
    };
    return computeGate(gov, facts.membersActive, voters.yes.size, voters.no.size, opened, now, {
      explicitApproval: g.explicitApproval, explicitReason: g.explicitApproval ? g.explicitReason : null,
      authorId: g.authorId, voters, authorIsBot: g.authorId != null && r.author_is_bot === true,
      rulesFacts: facts, memberCount: facts.memberCount, firstVersion,
      builderYes: true,
    });
  }
  const { active, approverIds } = await electorate(db, g.appId, gov, meta);
  const counted = votes.filter((v) => approverIds === null || approverIds.includes(Number(v.userId)));
  const yes = counted.filter((v) => v.vote === 'yes').length;
  const no = counted.filter((v) => v.vote === 'no').length;
  // The member floor's count: a Yes from someone other than the author (a
  // deleted author: every Yes is someone else's).
  const otherYes = counted.filter((v) => v.vote === 'yes' && Number(v.userId) !== g.authorId).length;
  return computeGate(gov, active, yes, no, opened, now, {
    explicitApproval: g.explicitApproval, otherYes,
    memberCount: g.explicitApproval ? Number(r.member_count) || 0 : undefined,
    firstVersion,
    // §5816: the project's maker or an admin approves on their own Yes too.
    voters, rulesFacts: { ...appFacts, membersActive: Math.max(Number(active) || 0, 1) },
    builderYes: true, approverIds: approverIds || null,
  });
}
