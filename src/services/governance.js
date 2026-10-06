'use strict';

// Per-app proposal-approval governance (issue #646) — the one shared
// layer between the two dapp.json-declared settings
// (apps.approver_policy / apps.approvals_required, reconciled by
// services/app-manifest.js reconcileAppGovernance) and every
// merge-gate consumer (checkAndMerge, the /promoted + /me/proposals
// serializers, the stale-PR sweeper, the conflict-resolver drain, and
// the governance-issue apply paths in routes/issues.js).
//
// Three regimes, combined from the two settings:
//
//   1. approver_policy='anyone' + approvals_required=NULL (the
//      defaults): bit-for-bit today's behavior — the dynamic
//      time-&-majority gate (services/active-users.js mergeGate) over
//      the active-user electorate, counting every vote.
//
//   2. approver_policy='invited' + approvals_required=NULL: the same
//      mergeGate math with the electorate swapped — `active` becomes
//      the number of approver members (app_approvers status='member',
//      floored at 1) and only THEIR votes feed the yes/no counts.
//      Everyone else's votes are recorded and displayed but advisory.
//
//   3. approvals_required=N ("at least N", either policy): a proposal
//      is mergeable as soon as it has N qualifying yes votes. No
//      visibility window, no lazy-consensus clock, no contested state,
//      and no auto-rejection — the countdown machinery is off in this
//      mode. Qualifying = approver votes when the policy is 'invited',
//      all votes when 'anyone'.
//
// The checks gate, behind-main gate, and locked-app admin-yes gate are
// mode-independent and enforced by checkAndMerge as before. Vote WRITE
// eligibility (app-access collab guards) is deliberately unchanged —
// approver-ness only changes which votes COUNT.
//
// Deadlock escape: when the policy is 'invited' but the app has zero
// approver members (e.g. the self-app before any invite is accepted,
// or every approver left), full admins (is_admin AND NOT
// admin_readonly — the same predicate as the locked-app gate in
// services/admin-approval.js) act as the approver set, so an app can
// never make its own merge gate unreachable.

const log = require('./logger');
const { countedVotePredicateSql } = require('./pr-vote-revision');

// Lazy accessor rather than a top-level destructure: tests stub
// services/active-users via require.cache, and this module may be
// loaded before the stub lands — resolve at call time so both bind.
function activeUsers() {
  // eslint-disable-next-line global-require
  return require('./active-users');
}

// Short in-process TTL cache for the governance columns, mirroring the
// visibility caches in services/app-access.js: reads happen on every
// vote/serialize, changes are rare and always call invalidateGovernance.
const GOV_CACHE_TTL_MS = 10 * 1000;
const govCache = new Map(); // appId -> { at, value: { approverPolicy, approvalsRequired } }

function invalidateGovernance(appId) {
  govCache.delete(appId);
}

async function getGovernance(pool, appId) {
  const hit = govCache.get(appId);
  if (hit && Date.now() - hit.at < GOV_CACHE_TTL_MS) return hit.value;
  const value = await readGovernance(pool, appId);
  govCache.set(appId, { at: Date.now(), value });
  return value;
}

// The same read without the cache, for a decision taken under a lock (the
// workflow governance machine's gate): a cached value is only as fresh as
// its TTL, and a settings change must not be missed by the vote it races.
async function readGovernance(pool, appId) {
  const { rows } = await pool.query(
    'SELECT approver_policy, approvals_required FROM apps WHERE id = $1',
    [appId]
  );
  return {
    approverPolicy: rows[0]?.approver_policy === 'invited' ? 'invited' : 'anyone',
    approvalsRequired: rows[0]?.approvals_required != null
      ? parseInt(rows[0].approvals_required, 10)
      : null,
  };
}

// The approver electorate for an 'invited'-policy app: member rows in
// app_approvers, or — when the roster is empty — the full-admin
// fallback described in the header. Returns { ids, adminFallback }.
async function getApproverSet(pool, appId) {
  const { rows } = await pool.query(
    `SELECT user_id FROM app_approvers WHERE app_id = $1 AND status = 'member'`,
    [appId]
  );
  if (rows.length) return { ids: rows.map((r) => r.user_id), adminFallback: false };
  const { rows: admins } = await pool.query(
    `SELECT id FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE`
  );
  return { ids: admins.map((r) => r.id), adminFallback: true };
}

// Whether a user's vote QUALIFIES (counts toward the gate) on this
// app. Under 'anyone' every vote qualifies; under 'invited' only the
// approver set's (incl. the admin fallback). Used by the vote-roster
// serializer to tag approver votes.
async function isApprover(pool, appId, userId) {
  if (!userId) return false;
  const gov = await getGovernance(pool, appId);
  if (gov.approverPolicy !== 'invited') return false;
  const { ids } = await getApproverSet(pool, appId);
  return ids.includes(userId);
}

// Pure "at least N" gate, shaped exactly like mergeGate's return so
// every consumer (merge routes, sweeper, countdown pill) reads one
// object regardless of mode. Every MERGE clock is off by design: no
// visibility window, no lazy consensus, no contested state — N approvals
// and nothing else opens the merge.
//
// #2494: the REJECTION clock is no longer off with them. It was, and the
// consequence was that a promoted proposal on an at-least-N app could
// never close itself however it was voted: `server.js` archives on
// `gate.rejectable`, and this gate could not produce a true one. A
// proposal reported eighteen days promoted at 2 yes / 2 no, still being
// prebuilt, re-checked and re-synced with main on every sweep.
//
// The rule is the default mode's, unchanged — same `REJECT_MIN_NO` floor,
// same dominance curve, same window (active-users.js oppositionWindowMs).
// Only the KEEP-ALIVE differs, because the two modes measure support
// differently: the default mode protects a proposal whose Yes share of
// active users clears a fraction; at-least-N has no active denominator,
// and its own measure of support is the threshold itself. A proposal with
// its approvals is mergeable, so it must never auto-close.
//
// WHAT THIS DOES NOT DO, because it is the group's decision and not
// this function's: expire a proposal for AGE. A tie is still a stalemate
// in both modes — `no <= yes` never arms — so a 2-2 proposal still sits
// there. "N approvals, no clock" has no notion of losing, so the real
// failure state is never-approved, and the only honest remedy is time:
// how long, whether the author is warned, whether a vote resets it.
function atLeastGate(n, yesCount, noCount = 0, openedAt = null, now = Date.now(), opts = {}) {
  const yes = Math.max(parseInt(yesCount, 10) || 0, 0);
  const required = Math.max(parseInt(n, 10) || 1, 1);
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
  const rejWindowMs = mergeable
    ? null
    : activeUsers().oppositionWindowMs(yes, noCount);
  const rejectionArmed = rejWindowMs !== null;
  const openedMs = openedAt ? new Date(openedAt).getTime() : NaN;
  // A NULLISH `now` means "now", not the epoch. The default parameter only
  // covers `undefined`, and routes/votes.js passes an explicit `null` here
  // to reach the options argument — `new Date(null).getTime()` is 0, which
  // would put every proposal's clock fifty-six years in the future and
  // report `rejectable: false` forever. That is the same shape as the bug
  // this change exists to fix, so it is normalised the way mergeGate's own
  // `toMs(now, Date.now())` does.
  const nowMs = now == null
    ? Date.now()
    : (typeof now === 'number' ? now : new Date(now).getTime());
  // An unknown open time cannot be elapsed. `NaN >= window` is already
  // false, so this guard is explicit rather than load-bearing here — it
  // says the intent out loud, because the reading that matters is the one
  // below: `rejectionEndsAt` must not become `new Date(NaN)`. The
  // behaviour either way is to stay ARMED but not yet rejectable, which
  // is the safe direction for a proposal whose age we cannot establish.
  const rejectionElapsed = rejectionArmed
    && Number.isFinite(openedMs) && nowMs - openedMs >= rejWindowMs;
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
      ? new Date(openedMs + rejWindowMs).toISOString()
      : null,
    rejectable: rejectionArmed && rejectionElapsed,
  };
}

// #788 "explicit approval" modifier. A proposal whose diff changes a
// protected dapp.json block (admins, governance, visibility,
// platform_env, secrets; services/explicit-approval.js) keeps the app's
// NORMAL approval rules — same threshold, same
// electorate, same at-least-N / invited-approver configuration, same
// contested handling — but loses every TIME-BASED merge path:
//
//   - the minimum visibility window (a clock that DELAYS an
//     already-approved proposal) is zeroed, so it merges the instant
//     its normal threshold is met by votes actually cast;
//   - lazy consensus (a clock that MERGES an under-threshold proposal
//     because nobody objected) is disarmed outright. Silence must
//     never hand out admin rights.
//
// Everything else passes through untouched — `required`, `contested`,
// `thresholdMet`, and all four rejection fields. That last point is the
// whole reason this is a modifier rather than a separate gate: the
// auto-takedown countdown and the stale-PR sweep keep behaving exactly
// as they do for any other proposal on that app, so a flagged proposal
// nobody wants still dies on schedule.
//
// Note this is a no-op on the merge side under 'at_least' (atLeastGate
// is already clock-free), and deliberately does NOT re-arm that mode's
// rejection fields — "as before" means as that app normally behaves.
//
// THE MEMBER FLOOR. `floor` (memberFloor below) adds one condition on
// top: whenever the community has more than one member, a flagged
// proposal also needs at least one qualifying Yes from someone other than
// its author. Without it the "real votes" the modifier asks for could be
// the author's alone: on a small app the eased threshold is often one Yes,
// so a proposal to make the app private, change its admins or carry a key
// value merged on its author's own say-so the moment it was proposed. The
// threshold (`required`, `thresholdMet`) still reports the vote count; the
// floor is its own fact, so a surface can say which of the two is missing.
// `floor` null means "not evaluated" (a display serializer that does not
// read it): the merge side then behaves as before, and every merge path
// that decides anything goes through governedGate, which always evaluates
// it.
function applyNoTimerMerge(gate, floor = null) {
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
// community, where nobody else exists to ask (the author alone decides, as
// on any solo project), and `met` is true whenever the floor does not apply.
function memberFloor({ memberCount, otherYes } = {}) {
  if (memberCount === undefined || memberCount === null) return null;
  const members = parseInt(memberCount, 10);
  if (!Number.isFinite(members)) return null;
  const applies = members > 1;
  const other = Math.max(parseInt(otherYes, 10) || 0, 0);
  return { applies, otherYes: other, met: !applies || other >= 1 };
}

// Pure mode dispatch given already-resolved governance + counts. The
// async governedGate below resolves the electorate/counts and calls
// this; serializers with batch-fetched counts call it directly.
//
// `opts.explicitApproval` layers the #788 no-timer modifier on top of
// whichever regime the app configured — `mode` still reports the real
// regime ('default' / 'at_least'), because the app's rules are what
// still decide the threshold.
//
// `opts.memberCount` + `opts.otherYes` evaluate the member floor for a
// flagged proposal (applyNoTimerMerge above); `memberFloor` on the result
// is null when the proposal is not flagged or the floor was not evaluated.
function computeGate(gov, active, yesCount, noCount, openedAt, now, opts = {}) {
  const explicitApproval = !!opts.explicitApproval;
  const floor = explicitApproval ? memberFloor(opts) : null;
  const base = gov.approvalsRequired != null
    ? atLeastGate(gov.approvalsRequired, yesCount, noCount, openedAt, now,
      { floorMet: !floor || floor.met })
    : activeUsers().mergeGate(active, yesCount, noCount, openedAt, now);
  const gated = explicitApproval ? applyNoTimerMerge(base, floor) : base;
  return {
    ...gated,
    policy: gov.approverPolicy,
    mode: gov.approvalsRequired != null ? 'at_least' : 'default',
    approvalsRequired: gov.approvalsRequired,
    explicitApproval,
    memberFloor: floor,
    qualifiedYes: Math.max(parseInt(yesCount, 10) || 0, 0),
    qualifiedNo: Math.max(parseInt(noCount, 10) || 0, 0),
    activeCount: Math.max(parseInt(active, 10) || 0, 1),
  };
}

// Qualifying yes/no counts for ONE proposal. `kind` picks the vote
// table: 'pr' → pr_votes (yes/no keyed by session_id), 'issue' →
// issue_votes (up/down keyed by issue_id). `approverIds` = null counts
// every vote (policy 'anyone'); an array restricts to those users.
//
// #687 Slice 3 scoped these counts to the exact PR head commit a vote was
// cast against, so that a head change re-opened approval. #2038 keeps the
// intent and changes the key: the scope is chat_sessions.approval_epoch now,
// which the platform bumps only when somebody writes bytes that were not
// already approved. A "sync with main" therefore stops re-opening approval,
// because it changes the commit without changing the work — see
// services/pr-vote-revision.js for why a commit could never answer that on
// its own. Issue votes are unscoped: they have no revision to go stale.
//
// `opts.authorId` asks for one more number, `otherYes`: the qualifying Yes
// votes cast by someone other than the proposal's author (the member floor;
// see applyNoTimerMerge). Only asked for a flagged proposal, so the common
// path keeps its exact queries. A null author (a deleted account) counts
// every Yes as someone else's.
async function qualifiedCounts(pool, kind, id, approverIds, opts) {
  const wantOther = !!opts && typeof opts === 'object'
    && Object.prototype.hasOwnProperty.call(opts, 'authorId');
  const authorNum = wantOther ? parseInt(opts.authorId, 10) : NaN;
  const authorId = Number.isFinite(authorNum) ? authorNum : null;
  const table = kind === 'issue' ? 'issue_votes' : 'pr_votes';
  const keyCol = kind === 'issue' ? 'issue_id' : 'session_id';
  const yesVal = kind === 'issue' ? 'up' : 'yes';
  const noVal = kind === 'issue' ? 'down' : 'no';
  // #2038: approvals are scoped by EPOCH now, not by head sha. The epoch
  // lives on the session row, so the clause is a scalar subquery rather than
  // a bound parameter — which also means it needs no argument juggling as
  // the placeholder numbers shift between the two branches below.
  // PR-only: issue_votes has no epoch, and an issue vote has no revision to
  // go stale against.
  const scoped = kind !== 'issue';
  // Test accounts (D1): a test account's vote on an app a real person made
  // is recorded but not counted — the same rule as countedVotePredicateSql,
  // keyed by the proposal's id because that is all this holds.
  const epochClause = (scoped
    ? ` AND approval_epoch = (SELECT approval_epoch FROM chat_sessions WHERE id = ${'$'}1)`
    : '')
    + (scoped
      ? ` AND counts_toward_session_outcome(user_id, ${'$'}1)`
      : ` AND counts_toward_issue_outcome(user_id, ${'$'}1)`);
  if (approverIds == null) {
    // Unrestricted electorate: the exact two COUNT queries the merge
    // paths always issued (cheaper than a FILTER scan, and existing
    // callers/tests recognize the shape).
    const { rows: yesRows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM ${table} WHERE ${keyCol} = $1 AND vote = '${yesVal}'${epochClause}`,
      [id]
    );
    const { rows: noRows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM ${table} WHERE ${keyCol} = $1 AND vote = '${noVal}'${epochClause}`,
      [id]
    );
    const out = {
      yes: parseInt(yesRows[0]?.cnt, 10) || 0,
      no: parseInt(noRows[0]?.cnt, 10) || 0,
    };
    if (wantOther) {
      const { rows: otherRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM ${table}
          WHERE ${keyCol} = $1 AND vote = '${yesVal}'
            AND user_id IS DISTINCT FROM $2::int${epochClause}`,
        [id, authorId]
      );
      out.otherYes = parseInt(otherRows[0]?.cnt, 10) || 0;
    }
    return out;
  }
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE vote = '${yesVal}') AS yes,
       COUNT(*) FILTER (WHERE vote = '${noVal}') AS no${wantOther
    ? `,
       COUNT(*) FILTER (WHERE vote = '${yesVal}' AND user_id IS DISTINCT FROM $3::int) AS other_yes`
    : ''}
     FROM ${table}
     WHERE ${keyCol} = $1
       AND user_id = ANY($2::int[])${epochClause}`,
    wantOther ? [id, approverIds, authorId] : [id, approverIds]
  );
  const out = {
    yes: parseInt(rows[0]?.yes, 10) || 0,
    no: parseInt(rows[0]?.no, 10) || 0,
  };
  if (wantOther) out.otherYes = parseInt(rows[0]?.other_yes, 10) || 0;
  return out;
}

// Batch variant for serializers: qualifying counts for MANY proposals
// in one query. Only called with a restricted electorate (callers use
// the raw per-row tallies under 'anyone'). Returns a Map of
// id -> { yes, no, otherYes } (missing ids have zero votes from the
// electorate). `otherYes` is the member floor's count: qualifying Yes
// votes from someone other than the row's author (chat_sessions.user_id
// for a PR, issues.created_by for an issue).
async function qualifiedCountsBatch(pool, kind, ids, approverIds) {
  const out = new Map();
  if (!ids.length) return out;
  const yesVal = kind === 'issue' ? 'up' : 'yes';
  const noVal = kind === 'issue' ? 'down' : 'no';
  const sql = kind === 'issue'
    ? `SELECT iv.issue_id AS id,
         COUNT(*) FILTER (WHERE iv.vote = '${yesVal}') AS yes,
         COUNT(*) FILTER (WHERE iv.vote = '${noVal}') AS no,
         COUNT(*) FILTER (WHERE iv.vote = '${yesVal}'
                            AND iv.user_id IS DISTINCT FROM i.created_by) AS other_yes
       FROM issue_votes iv
       JOIN issues i ON i.id = iv.issue_id
       WHERE iv.issue_id = ANY($1::int[])
         AND iv.user_id = ANY($2::int[])
         AND counts_toward_issue_outcome(iv.user_id, iv.issue_id)
       GROUP BY iv.issue_id`
    : `SELECT pv.session_id AS id,
         COUNT(*) FILTER (WHERE pv.vote = '${yesVal}') AS yes,
         COUNT(*) FILTER (WHERE pv.vote = '${noVal}') AS no,
         COUNT(*) FILTER (WHERE pv.vote = '${yesVal}'
                            AND pv.user_id IS DISTINCT FROM cs.user_id) AS other_yes
       FROM pr_votes pv
       JOIN chat_sessions cs ON cs.id = pv.session_id
       WHERE pv.session_id = ANY($1::int[])
         AND pv.user_id = ANY($2::int[])
         AND ${countedVotePredicateSql('pv', 'cs')}
       GROUP BY pv.session_id`;
  const { rows } = await pool.query(sql, [ids, approverIds]);
  for (const r of rows) {
    out.set(r.id, {
      yes: parseInt(r.yes, 10) || 0,
      no: parseInt(r.no, 10) || 0,
      otherYes: parseInt(r.other_yes, 10) || 0,
    });
  }
  return out;
}

// The member floor's two reads (applyNoTimerMerge), for the paths that
// decide something.
//
// How many people are in the community the app belongs to. A missing app
// answers null (floor not evaluated); an app with no community yet answers
// 0, which is a one-person community as far as the floor is concerned.
async function communityMemberCount(pool, appId) {
  const { rows } = await pool.query(
    `SELECT COUNT(m.user_id)::int AS n
       FROM apps a
       LEFT JOIN community_members m ON m.community_id = a.community_id
      WHERE a.id = $1
      GROUP BY a.id`,
    [appId]
  );
  return rows.length ? (parseInt(rows[0].n, 10) || 0) : null;
}

// Who proposed it: chat_sessions.user_id for a PR, issues.created_by for an
// issue. Null for a deleted account, which the floor reads as "every Yes is
// someone else's".
async function proposalAuthorId(pool, kind, id) {
  const { rows } = kind === 'issue'
    ? await pool.query('SELECT created_by AS author_id FROM issues WHERE id = $1', [id])
    : await pool.query('SELECT user_id AS author_id FROM chat_sessions WHERE id = $1', [id]);
  const n = parseInt(rows[0]?.author_id, 10);
  return Number.isFinite(n) ? n : null;
}

// Electorate resolution: who counts, and how many of them there are.
// 'anyone' → the active-user stats (approverIds null = count every
// vote); 'invited' → the approver member set (admin fallback when
// empty). Exposed for serializers that batch-count many rows.
async function getElectorate(pool, appId, gov) {
  if (gov.approverPolicy === 'invited') {
    const { ids, adminFallback } = await getApproverSet(pool, appId);
    return { active: Math.max(ids.length, 1), approverIds: ids, adminFallback };
  }
  const { active } = await activeUsers().getActiveUserStats(pool, appId);
  return { active, approverIds: null, adminFallback: false };
}

// One-call convenience: the governed merge gate for a single proposal.
// `kind` = 'pr' (chat_sessions + pr_votes) | 'issue' (issues +
// issue_votes); `id` is the session/issue id; `openedAt` the clock
// anchor (promoted_at || created_at for PRs, created_at for issues).
// Returns the mergeGate-shaped object from computeGate above, extended
// with { policy, mode, approvalsRequired, qualifiedYes, qualifiedNo,
// activeCount, memberFloor }.
//
// A flagged proposal (`explicitApproval`) always has its member floor
// evaluated here: `authorId` when the caller has the row (pass null for a
// deleted author), else it is read off the row. This is the path every
// merge and apply decision takes, so the floor can never be skipped by a
// caller that forgot to ask for it.
async function governedGate(pool, appId, {
  kind = 'pr', id, openedAt, now, explicitApproval = false, authorId,
} = {}) {
  const gov = await getGovernance(pool, appId);
  const electorate = await getElectorate(pool, appId, gov);
  let floorOpts;
  if (explicitApproval) {
    floorOpts = {
      authorId: authorId !== undefined ? authorId : await proposalAuthorId(pool, kind, id),
    };
  }
  // #2038: scoped by approval epoch inside qualifiedCounts. Callers no
  // longer pass a revision, because the revision was never the right key —
  // a proposal's commit changes for reasons that have nothing to do with
  // whether the approvals still describe it.
  const { yes, no, otherYes } = await qualifiedCounts(
    pool, kind, id, electorate.approverIds, floorOpts
  );
  const memberCount = explicitApproval ? await communityMemberCount(pool, appId) : undefined;
  // #788: the no-timer modifier rides on top of whatever regime the app
  // configured — see applyNoTimerMerge — and with it the member floor.
  const gate = computeGate(gov, electorate.active, yes, no, openedAt, now, {
    explicitApproval, otherYes, memberCount,
  });
  if (electorate.adminFallback && gov.approverPolicy === 'invited') {
    log.debug('governance', 'Approver roster empty; full admins acting as approvers', { appId });
  }
  return gate;
}

// The fields a display serializer hangs on a proposal row for the member
// floor, from the gate computeGate returned for it (with `otherYes` and
// `memberCount` passed in). `needs_other_member_yes` is true only when the
// row is flagged AND its community has more than one member; the card's
// requirement row (services/merge-requirements.js) and the status pill
// read these rather than re-deriving the rule.
function explicitApprovalRowFields(row, gate) {
  const flagged = !!(row && row.requires_explicit_approval);
  const floor = flagged && gate ? gate.memberFloor : null;
  return {
    requires_explicit_approval: flagged,
    explicit_approval_reason: flagged ? (row.explicit_approval_reason || null) : null,
    needs_other_member_yes: !!(floor && floor.applies),
    other_member_yes_count: floor ? floor.otherYes : null,
  };
}

// #3234: the electorate count to stamp on a proposal as it is promoted —
// the same number computeGate is handed. Display only, so a failed read
// answers null (no note) rather than holding up the promote.
async function electorateAtPromote(pool, appId) {
  try {
    const gov = await getGovernance(pool, appId);
    const { active } = await getElectorate(pool, appId, gov);
    return Math.max(parseInt(active, 10) || 0, 1);
  } catch (err) {
    log.warn('governance', 'Could not read the electorate at promote', { appId, err: err.message });
    return null;
  }
}

// #3234: the Yes votes this proposal would need had the electorate stayed
// what it was when voting opened, with today's No votes — so the only
// difference from the live threshold is who joined or left. Null when the
// row has no stamp, or under "at least N" (a fixed count that cannot move).
function requiredAtPromote(gov, activeAtPromote, noCount) {
  if (!gov || gov.approvalsRequired != null) return null;
  const a = parseInt(activeAtPromote, 10);
  if (!Number.isFinite(a) || a < 1) return null;
  return activeUsers().requiredVotes(a, noCount);
}

module.exports = {
  electorateAtPromote,
  requiredAtPromote,
  getGovernance,
  readGovernance,
  invalidateGovernance,
  getApproverSet,
  isApprover,
  atLeastGate,
  applyNoTimerMerge,
  memberFloor,
  computeGate,
  qualifiedCounts,
  qualifiedCountsBatch,
  communityMemberCount,
  proposalAuthorId,
  explicitApprovalRowFields,
  getElectorate,
  governedGate,
};
