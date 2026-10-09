// The merge gate: when a proposal (a pull request or a governance issue)
// has the votes, and the time, to merge or apply. Pure, and the one copy:
// services/active-users.js and services/governance.js re-export it for the
// merge route, the serializers, the sweepers and the client's countdown, and
// the governance workflow machine decides with it inside its transaction.
//
// The knobs are constants. They were read from the environment once per
// process, which let two processes (the old and new Pods of a release) give
// one proposal two verdicts; none was ever set.
//
// A proposal merges through one of two paths (see SPEC: "Visibility window
// + dynamic threshold"):
//
//   A. Threshold path: both gates below hold (eased Yes threshold met AND
//      the minimum visibility window has elapsed).
//   B. Lazy-consensus path: the threshold is NOT met, but the proposal has
//      real unopposed support (>= 1 Yes, Yes strictly leading, not
//      contested) and its lazy merge window has elapsed. Silence is consent:
//      on small apps the threshold (floored at 2) is often unreachable
//      because the other members simply never vote. See lazyWindowMs.
//
// Two independent, pure gates that both must hold for the threshold path:
//
//   1. requiredVotes(active, noCount): the eased Yes-vote threshold. Largest
//      discount when unopposed; rises back toward the simple majority M as No
//      votes arrive; never exceeds M and never drops below an anti-self-merge
//      floor.
//
//   2. mergeWindowMs(active, yesCount, noCount): a minimum *visibility
//      window* measured from when the proposal opened. Shrinks as the Yes
//      fraction climbs (7d at low participation → 3d at 1/3 → 0 at majority,
//      with a front-loaded non-linear drop between 1/3 and 1/2), and is
//      pushed back out toward the 7d max by opposition. A clear majority
//      (yes >= M) or a Contested proposal (No fraction >= 1/3) collapses the
//      window to 0.

const DAY_MS = 24 * 60 * 60 * 1000;

// Dynamic-threshold knobs: a quarter-of-active discount when unopposed
// (BASE_DISCOUNT_DIVISOR=4), each No worth two votes of that discount
// (DOWN_WEIGHT=2), never below two Yes once an app has >=2 active users
// (FLOOR=2).
const BASE_DISCOUNT_DIVISOR = 4;
const DOWN_WEIGHT = 2;
const FLOOR = 2;

// Visibility-window knobs (windows in ms).
const WINDOW_MAX_MS = 7 * DAY_MS;
const WINDOW_MID_MS = 3 * DAY_MS;
const WINDOW_CURVE_EXP = 3;
// Fraction breakpoints. The mid mark is where the window settles to
// WINDOW_MID_MS; the majority mark is where it collapses to 0; the contested
// mark is the No fraction at which the window stops applying entirely.
const YES_MID_FRAC = 1 / 3;
const YES_MAJORITY_FRAC = 1 / 2;
const CONTESTED_NO_FRAC = 1 / 3;

// Auto-takedown (rejection) knobs, the symmetric mirror of the merge window.
// A proposal that the group is voting down (No > Yes) without ever reaching a
// base of support (Yes fraction < REJECT_KEEPALIVE_YES_FRAC) gets a rejection
// window: ~7d when No only barely leads, shrinking non-linearly toward instant
// as No dominates. REJECT_MIN_NO mirrors the merge FLOOR so a lone No can never
// auto-close. The keep-alive fraction reuses YES_MID_FRAC (1/3).
const REJECT_WINDOW_MAX_MS = 7 * DAY_MS;
const REJECT_CURVE_EXP = 3;
const REJECT_MIN_NO = 2;
const REJECT_KEEPALIVE_YES_FRAC = YES_MID_FRAC;

// Lazy-consensus knobs: a proposal that has SOME support (Yes strictly
// leading, no contest) but hasn't reached the eased threshold arms a merge
// clock anyway: silence is consent. The clock is count-based (NOT
// fraction-based like mergeWindowMs) because on the platform's typical 2–4
// active-user apps, fractions quantize so coarsely that a single Yes is
// already 25–50% and the fraction curves degenerate (see #310 follow-up:
// timers were unreachable below 5 active users). One missing vote → 3d,
// each additional missing vote → +2d, capped at the 7d max.
const LAZY_WINDOW_BASE_MS = 3 * DAY_MS;
const LAZY_WINDOW_STEP_MS = 2 * DAY_MS;

export const MERGE_GATE_CONSTANTS = Object.freeze({
  BASE_DISCOUNT_DIVISOR,
  DOWN_WEIGHT,
  FLOOR,
  WINDOW_MAX_MS,
  WINDOW_MID_MS,
  WINDOW_CURVE_EXP,
  YES_MID_FRAC,
  YES_MAJORITY_FRAC,
  CONTESTED_NO_FRAC,
  REJECT_WINDOW_MAX_MS,
  REJECT_CURVE_EXP,
  REJECT_MIN_NO,
  REJECT_KEEPALIVE_YES_FRAC,
  LAZY_WINDOW_BASE_MS,
  LAZY_WINDOW_STEP_MS,
});

type Count = number | string | null | undefined;
type Instant = Date | number | string | null | undefined;

const int = (v: Count): number => parseInt(String(v), 10);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// The eased Yes-vote threshold. Pure. M = floor(active/2)+1 is both the
// simple majority and the hard upper cap (opposition can restore the bar but
// never push it above majority: no permanent deadlock).
export function requiredVotes(active: Count, noCount: Count): number {
  const a = Math.max(int(active) || 0, 1);
  const no = Math.max(int(noCount) || 0, 0);
  const M = Math.floor(a / 2) + 1;
  const discount = Math.max(0, Math.floor(a / BASE_DISCOUNT_DIVISOR) - DOWN_WEIGHT * no);
  const floorEff = Math.min(FLOOR, M);
  return clamp(M - discount, floorEff, M);
}

// Whether opposition has crossed the "Contested" line: at/above this the
// window no longer applies and the proposal is a pure simple-majority count
// gate.
export function isContested(active: Count, noCount: Count): boolean {
  const a = Math.max(int(active) || 0, 1);
  const no = Math.max(int(noCount) || 0, 0);
  return no / a >= CONTESTED_NO_FRAC;
}

// The minimum visibility window in ms. Pure. See the block comment above for
// the shape; returns 0 whenever the window doesn't gate (majority reached or
// contested).
export function mergeWindowMs(active: Count, yesCount: Count, noCount: Count): number {
  const a = Math.max(int(active) || 0, 1);
  const yes = Math.max(int(yesCount) || 0, 0);
  const no = Math.max(int(noCount) || 0, 0);
  const M = Math.floor(a / 2) + 1;
  // A clear majority satisfies the window instantly ("majority just merges").
  if (yes >= M) return 0;
  const yesFrac = yes / a;
  const noFrac = no / a;
  // Contested: opposition has removed the window entirely.
  if (noFrac >= CONTESTED_NO_FRAC) return 0;

  let yesWindow;
  if (yesFrac >= YES_MAJORITY_FRAC) {
    // >= 1/2 of active said Yes: collapse to instant.
    yesWindow = 0;
  } else if (yesFrac < YES_MID_FRAC) {
    // Low participation: linear ramp 7d (at 0) -> 3d (at 1/3).
    const f = yesFrac / YES_MID_FRAC;
    yesWindow = WINDOW_MAX_MS + f * (WINDOW_MID_MS - WINDOW_MAX_MS);
  } else {
    // Between 1/3 and 1/2: non-linear, front-loaded 3d -> 0. Stays near 3d
    // for most of the range, then drops sharply as Yes nears a majority.
    const t = (yesFrac - YES_MID_FRAC) / (YES_MAJORITY_FRAC - YES_MID_FRAC);
    yesWindow = WINDOW_MID_MS * (1 - Math.pow(t, WINDOW_CURVE_EXP));
  }

  // No-vote pushback: blend the Yes-driven window back toward the max on a
  // gradient as the No fraction rises from 0 toward the contested cut-off.
  const p = clamp(noFrac / CONTESTED_NO_FRAC, 0, 1);
  const windowMs = yesWindow + p * (WINDOW_MAX_MS - yesWindow);
  return Math.round(clamp(windowMs, 0, WINDOW_MAX_MS));
}

// The auto-takedown (rejection) window in ms, or `null` when no rejection
// clock applies. Pure, and the symmetric mirror of mergeWindowMs. The `null`
// sentinel distinguishes "not armed / kept alive" from "armed, reject
// instantly" (0). Returns:
//   - null  if Yes fraction >= keep-alive (a base of support protects it),
//   - null  if No does not strictly outnumber Yes, or No < REJECT_MIN_NO
//           (a lone No can never auto-close: mirrors the merge FLOOR),
//   - else  REJECT_WINDOW_MAX_MS * (1 - t**REJECT_CURVE_EXP), where the
//           dominance margin t = (no - yes) / (no + yes): ~max when No barely
//           leads, front-loaded down toward 0 as No dominates Yes.
export function rejectionWindowMs(active: Count, yesCount: Count, noCount: Count): number | null {
  const a = Math.max(int(active) || 0, 1);
  const yes = Math.max(int(yesCount) || 0, 0);
  // Keep-alive: any real base of Yes support cancels the rejection clock.
  if (yes / a >= REJECT_KEEPALIVE_YES_FRAC) return null;
  return oppositionWindowMs(yesCount, noCount);
}

// The arming guard and the curve, WITHOUT a keep-alive rule (#2494).
//
// Split out because the two governance modes agree on when opposition should
// start a clock and how fast it should run, and disagree only on what
// protects a proposal from it. The default mode's keep-alive is a fraction of
// the ACTIVE user count (above); at-least-N has no meaningful active
// denominator, and its own protection is simply having reached the approval
// threshold (atLeastGate).
//
// One copy of the curve on purpose: two copies of a governance rule is how
// one of them gets tuned and the other quietly does not.
export function oppositionWindowMs(yesCount: Count, noCount: Count): number | null {
  const yes = Math.max(int(yesCount) || 0, 0);
  const no = Math.max(int(noCount) || 0, 0);
  // Arming guard: only once No strictly leads Yes AND clears the min-No
  // floor. A tie is a stalemate, not a rejection, and a lone No can never
  // auto-close anything.
  if (no <= yes || no < REJECT_MIN_NO) return null;
  const t = (no - yes) / (no + yes); // dominance margin in (0, 1]
  const windowMs = REJECT_WINDOW_MAX_MS * (1 - Math.pow(t, REJECT_CURVE_EXP));
  return Math.round(clamp(windowMs, 0, REJECT_WINDOW_MAX_MS));
}

// The lazy-consensus merge window in ms, or `null` when it doesn't apply.
// Pure. Arms when a proposal has real support but hasn't reached the eased
// threshold: at least 1 Yes, Yes strictly leading No, and not contested.
// While armed, the proposal auto-merges once the window elapses: silence is
// consent; the visibility window IS the objection period. Returns:
//   - null  if yes >= requiredVotes (the threshold path owns the clock),
//   - null  if yes < 1, or No ties/leads Yes (a tie is a stalemate, and a
//           No lead belongs to the rejection clock: mutual exclusivity),
//   - null  if contested (No >= 1/3 of active: all clocks off, pure
//           majority race),
//   - else  LAZY_WINDOW_BASE_MS + (missing - 1) * LAZY_WINDOW_STEP_MS where
//           missing = required - yes, capped at WINDOW_MAX_MS. Count-based
//           on purpose: see the knobs comment above.
export function lazyWindowMs(active: Count, yesCount: Count, noCount: Count): number | null {
  const yes = Math.max(int(yesCount) || 0, 0);
  const no = Math.max(int(noCount) || 0, 0);
  const required = requiredVotes(active, noCount);
  if (yes >= required) return null;
  if (yes < 1 || yes <= no) return null;
  if (isContested(active, noCount)) return null;
  const missing = required - yes;
  return Math.round(clamp(
    LAZY_WINDOW_BASE_MS + (missing - 1) * LAZY_WINDOW_STEP_MS,
    0, WINDOW_MAX_MS,
  ));
}

export interface Gate {
  required: number;
  windowMs: number;
  windowEndsAt: string | null;
  contested: boolean;
  thresholdMet: boolean;
  windowElapsed: boolean;
  lazyArmed: boolean;
  lazyWindowMs: number | null;
  mergeable: boolean;
  rejectionWindowMs: number | null;
  rejectionArmed: boolean;
  rejectionEndsAt: string | null;
  rejectable: boolean;
}

// One-call convenience that derives every field the merge route, sweeper,
// and client need from a single (active, yes, no, openedAt) snapshot. `now`
// and `openedAt` accept a Date, ms number, or ISO string; `openedAt` falls
// back to `now` when missing (so a proposal with no anchor is treated as
// just-opened).
export function mergeGate(active: Count, yesCount: Count, noCount: Count, openedAt: Instant, now: Instant): Gate {
  const toMs = (v: Instant, fallback: number): number => {
    if (v == null) return fallback;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? ms : fallback;
  };
  const nowMs = toMs(now, Date.now());
  const openedMs = toMs(openedAt, nowMs);
  const required = requiredVotes(active, noCount);
  const contested = isContested(active, noCount);
  const yes = Math.max(int(yesCount) || 0, 0);
  const thresholdMet = yes >= required;

  // One effective merge clock, owned by whichever path applies:
  //   - threshold met → the fraction-based minimum visibility window
  //     (a brake on an already-approved proposal), or
  //   - threshold NOT met but lazy consensus armed → the count-based lazy
  //     window (an alternative path: elapsing MERGES the proposal).
  // Serialized as one windowEndsAt so every consumer (merge routes, sweeper,
  // countdown pill) reads a single timestamp regardless of which path armed.
  const lazyMs = lazyWindowMs(active, yesCount, noCount);
  const lazyArmed = !thresholdMet && lazyMs !== null;
  const windowMs = thresholdMet ? mergeWindowMs(active, yesCount, noCount)
    : lazyArmed ? lazyMs! : 0;
  const windowElapsed = windowMs <= 0 || nowMs - openedMs >= windowMs;
  const windowEndsAt = windowMs > 0 ? new Date(openedMs + windowMs).toISOString() : null;

  // Auto-takedown side, anchored on the same openedAt as the merge window.
  const rejWindowMs = rejectionWindowMs(active, yesCount, noCount);
  const rejectionArmed = rejWindowMs !== null;
  const rejectionElapsed = rejectionArmed && nowMs - openedMs >= rejWindowMs!;
  const rejectionEndsAt = rejectionArmed
    ? new Date(openedMs + rejWindowMs!).toISOString()
    : null;

  return {
    required,
    windowMs,
    windowEndsAt,
    contested,
    thresholdMet,
    windowElapsed,
    // Lazy consensus (below-threshold merge clock).
    lazyArmed,
    lazyWindowMs: lazyArmed ? lazyMs : null,
    mergeable: (thresholdMet || lazyArmed) && windowElapsed,
    // Rejection (auto-takedown) fields.
    rejectionWindowMs: rejWindowMs,
    rejectionArmed,
    rejectionEndsAt,
    rejectable: rejectionArmed && rejectionElapsed,
  };
}

// ── Per-app governance (issue #646) ─────────────────────────────────────
//
// Three regimes, combined from the two dapp.json settings
// (apps.approver_policy / apps.approvals_required):
//   1. 'anyone' + no count: the dynamic time-&-majority gate (mergeGate)
//      over the active-user electorate, counting every vote.
//   2. 'invited' + no count: the same mergeGate math with the electorate
//      swapped for the approver members.
//   3. approvals_required=N ("at least N", either policy): mergeable as soon
//      as it has N qualifying yes votes (atLeastGate).

export interface Governance { approverPolicy: 'anyone' | 'invited'; approvalsRequired: number | null }

// The governance columns of an apps row.
export function governanceFromRow(row: { approver_policy?: string | null; approvals_required?: Count } | null | undefined): Governance {
  return {
    approverPolicy: row?.approver_policy === 'invited' ? 'invited' : 'anyone',
    approvalsRequired: row?.approvals_required != null
      ? int(row.approvals_required)
      : null,
  };
}

export interface AppMeta { selfHosted: boolean; collabPrivate: boolean }

// What the vote denominator needs from an apps row (self_hosted,
// collab_visibility), for a caller that has the row already.
export function appMetaFromRow(row: { self_hosted?: unknown; collab_visibility?: string | null } | null | undefined): AppMeta {
  return {
    selfHosted: !!row?.self_hosted,
    collabPrivate: row?.collab_visibility === 'private',
  };
}

// Pure "at least N" gate, shaped exactly like mergeGate's return so
// every consumer (merge routes, sweeper, countdown pill) reads one
// object regardless of mode. Every MERGE clock is off by design: no
// visibility window, no lazy consensus, no contested state; N approvals
// and nothing else opens the merge.
//
// #2494: the REJECTION clock is no longer off with them. It was, and the
// consequence was that a promoted proposal on an at-least-N app could
// never close itself however it was voted: `server.js` archives on
// `gate.rejectable`, and this gate could not produce a true one.
//
// The rule is the default mode's, unchanged: same `REJECT_MIN_NO` floor,
// same dominance curve, same window (oppositionWindowMs). Only the
// KEEP-ALIVE differs, because the two modes measure support differently:
// the default mode protects a proposal whose Yes share of active users
// clears a fraction; at-least-N has no active denominator, and its own
// measure of support is the threshold itself. A proposal with its
// approvals is mergeable, so it must never auto-close.
//
// WHAT THIS DOES NOT DO, because it is the group's decision and not
// this function's: expire a proposal for AGE. A tie is still a stalemate
// in both modes (`no <= yes` never arms), so a 2-2 proposal still sits
// there.
export function atLeastGate(
  n: Count, yesCount: Count, noCount: Count = 0, openedAt: Instant = null, now: Instant = Date.now(),
  opts: { floorMet?: boolean } = {},
  opposition: (yes: Count, no: Count) => number | null = oppositionWindowMs,
): Gate {
  const yes = Math.max(int(yesCount) || 0, 0);
  const required = Math.max(int(n) || 1, 1);
  const thresholdMet = yes >= required;
  // The member floor (applyNoTimerMerge below): a flagged proposal whose
  // only qualifying Yes is its author's is not mergeable however many
  // approvals the count shows. `floorMet` defaults to true, so every caller
  // that is not flagged keeps exactly the old gate.
  const floorMet = opts.floorMet !== false;
  const mergeable = thresholdMet && floorMet;
  // Keep-alive: a proposal that already has its approvals is mergeable,
  // and must not be auto-rejected out from under them. Keyed on MERGEABLE,
  // not on the count: an author's own Yes on a flagged proposal is not
  // support the floor accepts, so it must not keep a proposal the group is
  // voting down alive forever either.
  const rejWindowMs = mergeable ? null : opposition(yes, noCount);
  const rejectionArmed = rejWindowMs !== null;
  const openedMs = openedAt ? new Date(openedAt).getTime() : NaN;
  // A NULLISH `now` means "now", not the epoch. The default parameter only
  // covers `undefined`, and routes/votes.js passes an explicit `null` here
  // to reach the options argument: `new Date(null).getTime()` is 0, which
  // would put every proposal's clock fifty-six years in the future and
  // report `rejectable: false` forever.
  const nowMs = now == null
    ? Date.now()
    : (typeof now === 'number' ? now : new Date(now).getTime());
  // An unknown open time cannot be elapsed. `rejectionEndsAt` must not
  // become `new Date(NaN)`: stay ARMED but not yet rejectable, the safe
  // direction for a proposal whose age we cannot establish.
  const rejectionElapsed = rejectionArmed
    && Number.isFinite(openedMs) && nowMs - openedMs >= rejWindowMs!;
  return {
    required,
    windowMs: 0,
    windowEndsAt: null,
    contested: false,
    thresholdMet,
    windowElapsed: true,
    lazyArmed: false,
    lazyWindowMs: null,
    mergeable,
    rejectionWindowMs: rejWindowMs,
    rejectionArmed,
    rejectionEndsAt: rejectionArmed && Number.isFinite(openedMs)
      ? new Date(openedMs + rejWindowMs!).toISOString()
      : null,
    rejectable: rejectionArmed && rejectionElapsed,
  };
}

export interface Floor { applies: boolean; otherYes: number; met: boolean }

// #788 "explicit approval" modifier. A proposal whose diff changes a
// protected dapp.json block (admins, governance, visibility,
// platform_env, secrets; services/explicit-approval.js) keeps the app's
// NORMAL approval rules but loses every TIME-BASED merge path:
//   - the minimum visibility window is zeroed, so it merges the instant
//     its normal threshold is met by votes actually cast;
//   - lazy consensus is disarmed outright. Silence must never hand out
//     admin rights.
// Everything else passes through untouched: `required`, `contested`,
// `thresholdMet`, and all four rejection fields, so a flagged proposal
// nobody wants still dies on schedule.
//
// THE MEMBER FLOOR. `floor` (memberFloor below) adds one condition on
// top: whenever the community has more than one member, a flagged
// proposal also needs at least one qualifying Yes from someone other than
// its author. `floor` null means "not evaluated" (a display serializer
// that does not read it): the merge side then behaves as before.
export function applyNoTimerMerge<G extends Gate>(gate: G, floor: Floor | null = null): G {
  const floorMet = !floor || floor.met !== false;
  return {
    ...gate,
    windowMs: 0,
    windowEndsAt: null,
    windowElapsed: true,
    lazyArmed: false,
    lazyWindowMs: null,
    mergeable: !!gate.thresholdMet && floorMet,
  };
}

// The member floor for one flagged proposal, from the community's member
// count and the qualifying Yes votes cast by someone other than the author.
// Returns null when the member count is unknown (not evaluated), else
// { applies, otherYes, met }: `applies` is false for a one-member
// community, where nobody else exists to ask, and `met` is true whenever
// the floor does not apply.
export function memberFloor({ memberCount, otherYes }: { memberCount?: Count; otherYes?: Count } = {}): Floor | null {
  if (memberCount === undefined || memberCount === null) return null;
  const members = int(memberCount);
  if (!Number.isFinite(members)) return null;
  const applies = members > 1;
  const other = Math.max(int(otherYes) || 0, 0);
  return { applies, otherYes: other, met: !applies || other >= 1 };
}

export interface GovernedGate extends Gate {
  policy: Governance['approverPolicy'];
  mode: 'at_least' | 'default';
  approvalsRequired: number | null;
  explicitApproval: boolean;
  memberFloor: Floor | null;
  qualifiedYes: number;
  qualifiedNo: number;
  activeCount: number;
}

// The two rules computeGate dispatches to. services/governance.js passes
// them as services/active-users.js exports them, so a test that stubs that
// module still reaches the gate it stubbed.
export interface GateRules {
  mergeGate: typeof mergeGate;
  oppositionWindowMs: typeof oppositionWindowMs;
}
const RULES: GateRules = { mergeGate, oppositionWindowMs };

// Pure mode dispatch given already-resolved governance + counts.
//
// `opts.explicitApproval` layers the #788 no-timer modifier on top of
// whichever regime the app configured: `mode` still reports the real
// regime ('default' / 'at_least'), because the app's rules are what
// still decide the threshold.
//
// `opts.memberCount` + `opts.otherYes` evaluate the member floor for a
// flagged proposal (applyNoTimerMerge above); `memberFloor` on the result
// is null when the proposal is not flagged or the floor was not evaluated.
export function computeGate(
  gov: Governance, active: Count, yesCount: Count, noCount: Count, openedAt: Instant, now: Instant,
  opts: { explicitApproval?: boolean; memberCount?: Count; otherYes?: Count } = {},
  rules: GateRules = RULES,
): GovernedGate {
  const explicitApproval = !!opts.explicitApproval;
  const floor = explicitApproval ? memberFloor(opts) : null;
  const base = gov.approvalsRequired != null
    ? atLeastGate(gov.approvalsRequired, yesCount, noCount, openedAt, now,
      { floorMet: !floor || floor.met }, rules.oppositionWindowMs)
    : rules.mergeGate(active, yesCount, noCount, openedAt, now);
  const gated = explicitApproval ? applyNoTimerMerge(base, floor) : base;
  return {
    ...gated,
    policy: gov.approverPolicy,
    mode: gov.approvalsRequired != null ? 'at_least' : 'default',
    approvalsRequired: gov.approvalsRequired,
    explicitApproval,
    memberFloor: floor,
    qualifiedYes: Math.max(int(yesCount) || 0, 0),
    qualifiedNo: Math.max(int(noCount) || 0, 0),
    activeCount: Math.max(int(active) || 0, 1),
  };
}
