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
  const { rows } = await pool.query(
    'SELECT approver_policy, approvals_required FROM apps WHERE id = $1',
    [appId]
  );
  const value = {
    approverPolicy: rows[0]?.approver_policy === 'invited' ? 'invited' : 'anyone',
    approvalsRequired: rows[0]?.approvals_required != null
      ? parseInt(rows[0].approvals_required, 10)
      : null,
  };
  govCache.set(appId, { at: Date.now(), value });
  return value;
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
// object regardless of mode. All clocks off by design: no visibility
// window, no lazy consensus, no contested state, no auto-rejection.
function atLeastGate(n, yesCount) {
  const yes = Math.max(parseInt(yesCount, 10) || 0, 0);
  const required = Math.max(parseInt(n, 10) || 1, 1);
  const thresholdMet = yes >= required;
  return {
    required,
    windowMs: 0,
    windowEndsAt: null,
    contested: false,
    thresholdMet,
    windowElapsed: true,
    lazyArmed: false,
    lazyWindowMs: null,
    mergeable: thresholdMet,
    rejectionWindowMs: null,
    rejectionArmed: false,
    rejectionEndsAt: null,
    rejectable: false,
  };
}

// Pure mode dispatch given already-resolved governance + counts. The
// async governedGate below resolves the electorate/counts and calls
// this; serializers with batch-fetched counts call it directly.
function computeGate(gov, active, yesCount, noCount, openedAt, now) {
  const base = gov.approvalsRequired != null
    ? atLeastGate(gov.approvalsRequired, yesCount)
    : activeUsers().mergeGate(active, yesCount, noCount, openedAt, now);
  return {
    ...base,
    policy: gov.approverPolicy,
    mode: gov.approvalsRequired != null ? 'at_least' : 'default',
    approvalsRequired: gov.approvalsRequired,
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
// #687 Slice 3: `headSha` (optional, PR kind only) scopes the count to
// votes cast against that exact PR head commit — imported proposals stamp
// pr_votes.head_sha at vote time, so a head change re-opens approval and
// the gate counts only approvals matching the current head. NULL/undefined
// (native proposals + every issue vote) applies no head filter, so their
// counting is byte-for-byte unchanged.
async function qualifiedCounts(pool, kind, id, approverIds, headSha = null) {
  const table = kind === 'issue' ? 'issue_votes' : 'pr_votes';
  const keyCol = kind === 'issue' ? 'issue_id' : 'session_id';
  const yesVal = kind === 'issue' ? 'up' : 'yes';
  const noVal = kind === 'issue' ? 'down' : 'no';
  // Head-scoping is PR-only (issue_votes has no head_sha column).
  const scoped = kind !== 'issue' && headSha != null;
  if (approverIds == null) {
    // Unrestricted electorate: the exact two COUNT queries the merge
    // paths always issued (cheaper than a FILTER scan, and existing
    // callers/tests recognize the shape).
    const shaClause = scoped ? " AND head_sha = $2" : '';
    const shaArgs = scoped ? [headSha] : [];
    const { rows: yesRows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM ${table} WHERE ${keyCol} = $1 AND vote = '${yesVal}'${shaClause}`,
      [id, ...shaArgs]
    );
    const { rows: noRows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM ${table} WHERE ${keyCol} = $1 AND vote = '${noVal}'${shaClause}`,
      [id, ...shaArgs]
    );
    return {
      yes: parseInt(yesRows[0]?.cnt, 10) || 0,
      no: parseInt(noRows[0]?.cnt, 10) || 0,
    };
  }
  const shaClause = scoped ? " AND head_sha = $3" : '';
  const shaArgs = scoped ? [headSha] : [];
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE vote = '${yesVal}') AS yes,
       COUNT(*) FILTER (WHERE vote = '${noVal}') AS no
     FROM ${table}
     WHERE ${keyCol} = $1
       AND user_id = ANY($2::int[])${shaClause}`,
    [id, approverIds, ...shaArgs]
  );
  return {
    yes: parseInt(rows[0]?.yes, 10) || 0,
    no: parseInt(rows[0]?.no, 10) || 0,
  };
}

// Batch variant for serializers: qualifying counts for MANY proposals
// in one query. Only called with a restricted electorate (callers use
// the raw per-row tallies under 'anyone'). Returns a Map of
// id -> { yes, no } (missing ids have zero votes from the electorate).
async function qualifiedCountsBatch(pool, kind, ids, approverIds) {
  const out = new Map();
  if (!ids.length) return out;
  const table = kind === 'issue' ? 'issue_votes' : 'pr_votes';
  const keyCol = kind === 'issue' ? 'issue_id' : 'session_id';
  const yesVal = kind === 'issue' ? 'up' : 'yes';
  const noVal = kind === 'issue' ? 'down' : 'no';
  const { rows } = await pool.query(
    `SELECT ${keyCol} AS id,
       COUNT(*) FILTER (WHERE vote = '${yesVal}') AS yes,
       COUNT(*) FILTER (WHERE vote = '${noVal}') AS no
     FROM ${table}
     WHERE ${keyCol} = ANY($1::int[])
       AND user_id = ANY($2::int[])
     GROUP BY ${keyCol}`,
    [ids, approverIds]
  );
  for (const r of rows) out.set(r.id, { yes: parseInt(r.yes, 10) || 0, no: parseInt(r.no, 10) || 0 });
  return out;
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
// activeCount }.
async function governedGate(pool, appId, { kind = 'pr', id, openedAt, now, headSha = null } = {}) {
  const gov = await getGovernance(pool, appId);
  const electorate = await getElectorate(pool, appId, gov);
  // #687 Slice 3: for an imported proposal the caller passes the current
  // imported_pr_head_sha so only approvals cast against that revision count
  // (a head change re-opens approval). Native/issue callers pass no headSha.
  const { yes, no } = await qualifiedCounts(pool, kind, id, electorate.approverIds, headSha);
  const gate = computeGate(gov, electorate.active, yes, no, openedAt, now);
  if (electorate.adminFallback && gov.approverPolicy === 'invited') {
    log.debug('governance', 'Approver roster empty; full admins acting as approvers', { appId });
  }
  return gate;
}

module.exports = {
  getGovernance,
  invalidateGovernance,
  getApproverSet,
  isApprover,
  atLeastGate,
  computeGate,
  qualifiedCounts,
  qualifiedCountsBatch,
  getElectorate,
  governedGate,
};
