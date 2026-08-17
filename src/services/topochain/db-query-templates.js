// Topochain v4 admin API — D10 `GET /sql-query/templates` (Task 13;
// SPEC 2914-2920).
//
// SPEC 2920's finding this fixes: "the shipped templates reference
// source table names including the excluded `metrics`" -> every query
// below is written against the MIGRATED v4 schema (`db-allowlist.js`'s
// QUERYABLE_TABLES) — there is no `metrics` table in this migration at
// all (SPEC §4.7 dropped it), so there's nothing left to accidentally
// reference.
//
// Each of these six is asserted, at module load, to pass the EXACT same
// validator `POST /sql-query/execute` runs (`sql-console.js`'s
// `validateStatement`) — not a separate "these are fine, trust me"
// claim. If a future edit to a template (or to the validator's allow-
// list/keyword rules) makes one of these fail its own gate, requiring
// this module blows up immediately at boot instead of shipping a
// template button that 400s the moment an admin clicks it.
'use strict';

const { validateStatement } = require('./sql-console');

const TEMPLATES = [
  {
    name: 'Latest leaderboard snapshot per season event',
    description: 'For every season event, the most recent leaderboard_snapshots row per user (rank + total_points).',
    query: `WITH latest_snapshot AS (
  SELECT season_event_id, MAX(snapshot_at) AS snapshot_at
    FROM leaderboard_snapshots
   GROUP BY season_event_id
)
SELECT ls.season_event_id, ls.user_id, ls.rank, ls.total_points, ls.snapshot_at
  FROM leaderboard_snapshots ls
  JOIN latest_snapshot latest
    ON latest.season_event_id = ls.season_event_id AND latest.snapshot_at = ls.snapshot_at
 ORDER BY ls.season_event_id, ls.rank`,
  },
  {
    name: 'Per-event activity point totals',
    description: 'Count and summed points of user_activities rows, grouped by season event and activity type.',
    query: `SELECT season_event_id, activity_type, COUNT(*) AS activity_count, SUM(points) AS total_points
  FROM user_activities
 GROUP BY season_event_id, activity_type
 ORDER BY season_event_id, total_points DESC`,
  },
  {
    name: 'Enrollment counts per season',
    description: 'How many user_enrollments rows exist per season (season-wide + event-scoped combined).',
    query: `SELECT season_id, COUNT(*) AS enrollment_count
  FROM user_enrollments
 GROUP BY season_id
 ORDER BY season_id`,
  },
  {
    name: 'Epoch stats per wallet',
    description: 'Per-(chain, wallet, epoch) block-production tallies from epoch_stats, most recent epochs first.',
    query: `SELECT chain_id, wallet_address, epoch, epoch_won_slots, epoch_produced_blocks, epoch_canonical_blocks
  FROM epoch_stats
 ORDER BY chain_id, epoch DESC, wallet_address`,
  },
  {
    name: 'Challenge completion counts',
    description: 'Completion counts per challenge, derived from user_activities rows tagged kind = challenge_completion.',
    query: `SELECT challenge_id, COUNT(*) AS completion_count
  FROM user_activities
 WHERE metadata->>'kind' = 'challenge_completion'
 GROUP BY challenge_id
 ORDER BY completion_count DESC`,
  },
  {
    name: 'Onchain accounts issued per season',
    description: 'Accounts issued and accounts already used, grouped by season and tier (never selects secret_key/registration_code).',
    query: `SELECT season_id, tier, COUNT(*) AS accounts_issued, COUNT(*) FILTER (WHERE is_used) AS accounts_used
  FROM onchain_accounts
 GROUP BY season_id, tier
 ORDER BY season_id, tier`,
  },
  {
    // #1130's worked example. The console used to refuse this query
    // outright ("table(s) that are not available in this console:
    // mobile_push_deliveries, mobile_push_registrations"), which is the
    // report that prompted the per-column scope. It ships as a template
    // so the shape an admin needs for push debugging is one click away —
    // and so the module-load assertion below is a permanent regression
    // lock on both tables staying queryable.
    //
    // The registration's encrypted destination and its lookup hash are
    // NOT selected and could not be: the console role holds a
    // column-level grant on that table which omits both.
    name: 'Push delivery outcomes by environment',
    description: 'mobile_push_deliveries joined to its registration: status, attempts and last_error_code per environment, platform and permission state (never selects the encrypted push destination).',
    query: `SELECT d.environment, r.platform, r.permission_status, d.status,
       COUNT(*) AS deliveries, MAX(d.attempts) AS max_attempts,
       MAX(d.last_error_code) AS sample_error_code
  FROM mobile_push_deliveries d
  LEFT JOIN mobile_push_registrations r ON r.id = d.registration_id
 GROUP BY d.environment, r.platform, r.permission_status, d.status
 ORDER BY d.environment, deliveries DESC`,
  },
  {
    // Delegation is keyed on the ut1… ADDRESS, which exists once per
    // season event in onchain_accounts — DISTINCT ON (adp.id) with the
    // is_used/used_at ordering picks each period's current claimant
    // instead of fanning one period out into N rows (the same resolution
    // the admin Delegations screen's LATERAL performs).
    name: 'Delegation periods with current claimant',
    description: 'Every account_delegation_periods row (open and closed), each resolved to the claiming user where one exists — the raw history behind the admin Delegations screen.',
    query: `SELECT DISTINCT ON (adp.id)
       adp.account, adp.started_at, adp.ended_at,
       (adp.ended_at IS NULL) AS delegated,
       u.id AS user_id, u.username
  FROM account_delegation_periods adp
  LEFT JOIN onchain_accounts oa ON oa.address = adp.account
  LEFT JOIN users u ON u.id = oa.user_id
 ORDER BY adp.id, oa.is_used DESC NULLS LAST, oa.used_at DESC NULLS LAST`,
  },
];

for (const t of TEMPLATES) {
  const result = validateStatement(t.query);
  if (!result.ok) {
    throw new Error(`db-query-templates: template "${t.name}" fails its own validator: ${result.reason}`);
  }
}

module.exports = { TEMPLATES };
