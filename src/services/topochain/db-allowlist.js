// Topochain v4 admin DB tooling — the single source of truth for which
// tables the admin database export, SQL console (execute/schema), and
// templates endpoints are allowed to touch (Task 13; SPEC D10 2852-2920,
// Global Constraints #9). Shared by ../../routes/topochain/admin/db-tools.js
// and its two service modules (sql-console.js, db-export.js) so the four
// endpoints can never drift out of sync with each other about what's in
// scope.
'use strict';

// All 22 topochain tables (schema.sql Task 1), in FK-dependency order —
// a parent table always appears before any table that references it.
// This ordering matters for `db-export.js`: INSERTs replay in this same
// order so foreign keys are always satisfied on restore.
const ALL_TOPOCHAIN_TABLES = [
  'seasons',
  'season_events',
  'user_enrollments',
  'challenge_kinds',
  'challenge_templates',
  'challenges',
  'user_activities',
  'onchain_accounts',
  'account_delegation_periods',
  'leaderboard_snapshots',
  'token_allocation',
  'epoch_stats',
  'chains',
  'vrf_obligations',
  'vrf_obligations_sync_state',
  'slot_outcome_reports',
  'mobile_logs',
  'mobile_otp_codes',
  'app_version_configs',
  'terms_versions',
  'user_terms_consents',
  'mobile_auth_tokens',
];

// The subset every D10 endpoint (export, sql-query/execute, sql-query/
// schema, sql-query/templates) is actually allowed to read — SPEC's own
// instruction (task brief) is explicit: `mobile_otp_codes` and
// `mobile_auth_tokens` are excluded ENTIRELY, not just column-scrubbed.
// `mobile_otp_codes` holds login-code hashes for accounts that may not
// even be identity-merged yet; `mobile_auth_tokens` holds bearer-token
// hashes for the live mobile session surface (Global Constraints #4) —
// neither belongs in an admin export or an ad-hoc SQL console, hashed or
// not. This is the ONE allow-list every D10 endpoint consults; nothing
// in this task adds a second, slightly-different list.
const QUERYABLE_TABLES = ALL_TOPOCHAIN_TABLES.filter(
  (t) => t !== 'mobile_otp_codes' && t !== 'mobile_auth_tokens'
);

// Lowercased Set for O(1) membership checks (sql-console.js's allow-list
// validation, export's table loop).
const QUERYABLE_TABLES_SET = new Set(QUERYABLE_TABLES);

// Columns excluded from EVERY D10 surface, even though their TABLE is in
// scope (task brief: "exclude the COLUMNS for onchain_accounts.secret_key
// + registration_code"). `secret_key` is a live testnet credential;
// `registration_code` is the single-use claim code that hands an account
// to a user — both are tagged `staging:private` on the column itself in
// schema.sql (Task 2) for the SAME reason.
//
// The task brief's wording ("exclude the COLUMNS from export") only
// names the export endpoint, but scoping the redaction to export ALONE
// would leave a real hole: `sql-query/execute` reads the SAME live
// table, and nothing about the table-allow-list or statement hardening
// (sql-console.js) stops `SELECT secret_key FROM onchain_accounts` —
// that query references an allow-listed table with an allowed verb, so
// it would otherwise sail through and hand a full (or even view-only —
// execute is intentionally reachable by both) admin the raw secret.
// `sql-console.js` (query validation) and `db-schema-info.js` (schema
// listing) both import this same map so a column tagged secret here is
// invisible to every D10 surface, not just the file download.
//
// Keyed by table name so `db-export.js` can look up "what do I drop from
// this table's DDL/SELECT list" without hardcoding the column names a
// second time; `EXCLUDED_SECRET_COLUMN_NAMES` below is the flattened
// form the other two consult when they don't care which table a name
// came from.
const EXCLUDED_EXPORT_COLUMNS = {
  onchain_accounts: ['secret_key', 'registration_code'],
};

// Flat, deduplicated list of every column name in `EXCLUDED_EXPORT_
// COLUMNS`, for callers that just need "is this identifier a secret
// column, regardless of table" (sql-console.js's query-time deny check).
const EXCLUDED_SECRET_COLUMN_NAMES = [
  ...new Set(Object.values(EXCLUDED_EXPORT_COLUMNS).flat()),
];

// Tables whose primary key is NOT a BIGSERIAL `id` column, so
// db-export.js must not try to emit a `setval('<table>_id_seq', ...)`
// line for them: `challenge_kinds.id` is a hand-assigned VARCHAR slug,
// and `vrf_obligations_sync_state`'s PK is `chain_id` (no `id` column at
// all). See schema.sql's own CREATE TABLE statements for both.
const TABLES_WITHOUT_SERIAL_ID = new Set(['challenge_kinds', 'vrf_obligations_sync_state']);

module.exports = {
  ALL_TOPOCHAIN_TABLES,
  QUERYABLE_TABLES,
  QUERYABLE_TABLES_SET,
  EXCLUDED_EXPORT_COLUMNS,
  EXCLUDED_SECRET_COLUMN_NAMES,
  TABLES_WITHOUT_SERIAL_ID,
};
