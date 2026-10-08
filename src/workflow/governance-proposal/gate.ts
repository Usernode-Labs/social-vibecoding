// The governance gate as a pure function of facts read under the instance
// lock. services/governance.js computeGate is the rule (pure, shared with
// every other merge path); this module folds in the vote being cast, so a
// vote and the evaluation it triggers are one transition, and adds the
// locked-app condition.

import { legacy } from '../legacy.ts';

export type Vote = 'up' | 'down';

export interface GateInputs {
  gov: { approverPolicy: 'anyone' | 'invited'; approvalsRequired: number | null };
  active: number;
  yes: number;
  no: number;
  otherYes: number;            // qualifying Yes from someone other than the author
  explicitApproval: boolean;   // secret changes: no clocks, and the member floor
  memberCount: number | null;
  authorId: number | null;
  openedAt: string;
  locked: boolean;
  adminUpVoters: number[];     // full admins with an Up vote
}

// The person voting, as the facts saw them before this vote.
export interface Voter {
  userId: number;
  existing: Vote | null;
  qualifies: boolean;          // counts toward the gate (approver, not a test account)
  isAdmin: boolean;            // full admin: an Up satisfies a locked app
}

export type Waiting = 'waiting_for_votes' | 'waiting_for_window' | 'awaiting_other_member' | 'awaiting_admin';

export interface Evaluation {
  mergeable: boolean;
  waiting: Waiting | null;
  required: number;
  yes: number;
  no: number;
  active: number;
  windowEndsAt: string | null;
}

// The inputs as they are once `vote` (null: retracted) replaces the voter's existing vote.
export function withVote(g: GateInputs, voter: Voter, vote: Vote | null): GateInputs {
  const next = { ...g, adminUpVoters: g.adminUpVoters.filter((id) => id !== voter.userId) };
  if (voter.isAdmin && vote === 'up') next.adminUpVoters.push(voter.userId);
  if (!voter.qualifies) return next;
  const other = voter.userId !== g.authorId;
  const step = (v: Vote | null, sign: number) => {
    if (v === 'up') { next.yes += sign; if (other) next.otherYes += sign; }
    if (v === 'down') next.no += sign;
  };
  step(voter.existing, -1);
  step(vote, +1);
  return next;
}

export function evaluate(g: GateInputs, now: Date): Evaluation {
  const gate = legacy('services/governance').computeGate(
    g.gov, g.active, g.yes, g.no, g.openedAt, now.getTime(),
    { explicitApproval: g.explicitApproval, otherYes: g.otherYes, memberCount: g.memberCount },
  );
  let waiting: Waiting | null = null;
  if (!gate.mergeable) {
    if (gate.thresholdMet && gate.memberFloor?.applies && !gate.memberFloor.met) waiting = 'awaiting_other_member';
    else if ((gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed) waiting = 'waiting_for_window';
    else waiting = 'waiting_for_votes';
  } else if (g.locked && !g.adminUpVoters.length) {
    waiting = 'awaiting_admin';
  }
  return {
    mergeable: waiting === null,
    waiting,
    required: gate.required,
    yes: gate.qualifiedYes,
    no: gate.qualifiedNo,
    active: gate.activeCount,
    windowEndsAt: gate.windowEndsAt,
  };
}

// When to look again: the merge window's end if one is running, else the
// backstop, which catches what no event announces (people joining or
// leaving the electorate, activity ageing out of its ten days).
export function nextCheck(e: Evaluation, now: Date, backstopMs: number): Date {
  const backstop = now.getTime() + backstopMs;
  const windowEnd = e.waiting === 'waiting_for_window' && e.windowEndsAt ? Date.parse(e.windowEndsAt) : NaN;
  return new Date(Number.isFinite(windowEnd) && windowEnd > now.getTime() ? Math.min(windowEnd, backstop) : backstop);
}
