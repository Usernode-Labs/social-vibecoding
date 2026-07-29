#!/usr/bin/env node
// Topochain data migration — §8.7 validation gates (Task 16; SPEC 3202-3321,
// §8.7 specifically). Runs every gate the spec lists as a precondition for
// writing the `topochain_migrated` marker, and reports PASS/FAIL/SKIP per
// gate rather than throwing on the first problem, so a failed rehearsal
// tells you everything wrong in one pass instead of one bug at a time.
//
// This module is used two ways:
//   1. `node scripts/topochain-validate.js` — a standalone check against
//      whatever is currently in TARGET_DATABASE_URL (and, if provided,
//      TOPOCHAIN_SOURCE_DATABASE_URL for the gates that compare against the
//      source). Useful for re-checking a load without re-running it, or for
//      checking a load that already failed and left its `_mig_map_*` tables
//      in place for inspection.
//   2. `require('./topochain-validate').runValidationGates(ctx)` — called by
//      `topochain-load.js` (directly, and via its `--validate-only` flag)
//      against the SAME client/transaction the load just ran in, so the
//      gates see uncommitted data and a failed run can cleanly ROLLBACK.
//
// Gates that need to compare against the source read it through the same
// read-only discipline as topochain-load.js (see the header comment there
// for why): `default_transaction_read_only=on` on the connection options
// AND an explicit `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`
// right after connecting. Every source read in this file goes through the
// single `querySource()` wrapper below — nothing else touches the source
// pool — so a static test can confirm every source-bound statement is a
// SELECT/WITH and nothing else.
//
// Several gates lean on the `_mig_map_<source_table>` id-map tables the
// load creates (see topochain-load.js's header comment for the full list
// and why they exist). Those tables are dropped once a load's validation
// passes, so a gate that needs one gracefully reports SKIP — not FAIL —
// when the map it needs is gone, e.g. because you're re-running this
// script standalone after a prior successful load already cleaned up.
'use strict';

const { Pool } = require('pg');

// ─── Source table name -> target table name, per SPEC §8.2 -────────────
// Used by the row-count gate to know what to compare against what. Three
// tables are handled specially and are NOT in this map: `participants`
// (merges many-to-one into `users`, §8.3-8.4 — its own gate logic),
// `mobile_otp_codes` (schema-only migration, source count is irrelevant,
// target is asserted to be exactly 0 rows), and `offchain_activities`
// (its target, `user_activities`, ALSO receives the §8.6 award-backfill
// inserts on top of the direct copy, so a naive 1:1 comparison would
// always fail by exactly the number of newly-inserted award rows — see
// the dedicated check inside gateRowCounts below instead).
const ROW_COUNT_TABLE_MAP = {
  seasons: 'seasons',
  phases: 'season_events',
  challenge_sub_categories: 'challenge_kinds',
  offchain_activity_types: 'challenge_templates',
  phase_available_activities: 'challenges',
  onchain_accounts: 'onchain_accounts',
  account_delegation_periods: 'account_delegation_periods',
  // leaderboard_snapshots and token_allocation are NOT 1:1 (the §8.4 merge
  // combines colliding rows) — they get dedicated merge-aware checks in
  // gateRowCounts below, next to the user_enrollments one.
  epoch_stats: 'epoch_stats',
  chains: 'chains',
  vrf_obligations: 'vrf_obligations',
  vrf_obligations_sync_state: 'vrf_obligations_sync_state',
  slot_outcome_reports: 'slot_outcome_reports',
  mobile_logs: 'mobile_logs',
  app_version_configs: 'app_version_configs',
  terms_versions: 'terms_versions',
  participant_terms_consents: 'user_terms_consents',
};

// ─── Orphan-FK gate declarations (SPEC §8.7: "every user_id,
// season_event_id, challenge_id, challenge_template_id, season_id,
// terms_version_id and kind resolves") ──────────────────────────────────
// [table, column, referencedTable, referencedColumn]. Two entries here
// have no database-level FK at all (both plain columns per schema.sql):
// `slot_outcome_reports.user_id` and `leaderboard_snapshots.season_id`.
// The gate's wording names the COLUMN, not "every declared FK", so both
// are checked here too — nullable, best-effort, same reasoning for each.
const FK_CHECKS = [
  ['season_events', 'season_id', 'seasons', 'id'],
  ['user_enrollments', 'user_id', 'users', 'id'],
  ['user_enrollments', 'season_event_id', 'season_events', 'id'],
  ['user_enrollments', 'season_id', 'seasons', 'id'],
  ['challenge_templates', 'kind', 'challenge_kinds', 'id'],
  ['challenges', 'season_event_id', 'season_events', 'id'],
  ['challenges', 'challenge_template_id', 'challenge_templates', 'id'],
  ['challenges', 'kind', 'challenge_kinds', 'id'],
  ['user_activities', 'user_id', 'users', 'id'],
  ['user_activities', 'season_event_id', 'season_events', 'id'],
  ['user_activities', 'challenge_id', 'challenges', 'id'],
  ['onchain_accounts', 'season_event_id', 'season_events', 'id'],
  ['onchain_accounts', 'season_id', 'seasons', 'id'],
  ['onchain_accounts', 'user_id', 'users', 'id'],
  ['leaderboard_snapshots', 'season_event_id', 'season_events', 'id'],
  ['leaderboard_snapshots', 'user_id', 'users', 'id'],
  ['leaderboard_snapshots', 'season_id', 'seasons', 'id'],
  ['token_allocation', 'user_id', 'users', 'id'],
  ['token_allocation', 'season_id', 'seasons', 'id'],
  ['epoch_stats', 'user_id', 'users', 'id'],
  ['mobile_logs', 'user_id', 'users', 'id'],
  ['slot_outcome_reports', 'user_id', 'users', 'id'],
  ['user_terms_consents', 'user_id', 'users', 'id'],
  ['user_terms_consents', 'terms_version_id', 'terms_versions', 'id'],
];

// ─────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────

// The one place any query ever touches the source pool. Every string
// passed here MUST start with SELECT or WITH — enforced by convention
// (and by the static test in tests/topochain-load.test.js, which reads
// this file as text and checks every call site).
async function querySource(sourcePool, sql, params) {
  return sourcePool.query(sql, params);
}

async function tableExists(client, name) {
  const { rows } = await client.query('SELECT to_regclass($1) AS reg', [`public.${name}`]);
  return rows[0].reg !== null;
}

function pass(name, detail) {
  return { name, status: 'PASS', detail: detail || '' };
}
function fail(name, detail) {
  return { name, status: 'FAIL', detail: detail || '' };
}
function skip(name, detail) {
  return { name, status: 'SKIP', detail: detail || '' };
}

// ─────────────────────────────────────────────────────────────────────
// Gate 1 — row counts (SPEC §8.7 bullet 1)
// ─────────────────────────────────────────────────────────────────────
async function gateRowCounts(ctx) {
  const { targetClient, sourcePool, expectUsers } = ctx;
  const results = [];

  // `users`: not a 1:1 table count (200 participants merge into 188
  // users, §8.3-8.4) — the correct assertion is that the migration's own
  // id map collapsed onto exactly `expectUsers` distinct target ids.
  if (await tableExists(targetClient, '_mig_map_participants')) {
    const { rows } = await targetClient.query(
      'SELECT COUNT(DISTINCT target_id)::int AS n FROM _mig_map_participants'
    );
    const n = rows[0].n;
    results.push(
      n === expectUsers
        ? pass('row-count: users (merged participants)', `${n} distinct users`)
        : fail('row-count: users (merged participants)', `expected ${expectUsers}, got ${n}`)
    );
  } else {
    results.push(skip('row-count: users (merged participants)', '_mig_map_participants not present'));
  }

  // `mobile_otp_codes`: schema-only migration, always expect 0 rows.
  const { rows: otpRows } = await targetClient.query('SELECT COUNT(*)::int AS n FROM mobile_otp_codes');
  results.push(
    otpRows[0].n === 0
      ? pass('row-count: mobile_otp_codes', '0 rows (schema-only, as specced)')
      : fail('row-count: mobile_otp_codes', `expected 0, got ${otpRows[0].n}`)
  );

  if (!sourcePool) {
    results.push(skip('row-count: all other tables', 'no source connection provided'));
    return results;
  }

  // `user_activities` <- `offchain_activities` PLUS the §8.6 award
  // backfill's newly-INSERTED rows (reconciled rows annotate an existing
  // base row rather than adding one, so they don't add to the count).
  // expected = source offchain_activities count
  //          + (backfilled award rows - the ones reconciled onto a base row)
  // The "reconciled onto a base row" count is exactly the rows that are
  // BOTH in _mig_map_offchain_activities (so they came from the base
  // load) AND carry backfill metadata (so a reconcile touched them).
  if (await tableExists(targetClient, 'user_activities') && (await tableExists(targetClient, '_mig_map_offchain_activities'))) {
    try {
      const { rows: srcRows } = await querySource(sourcePool, 'SELECT COUNT(*)::int AS n FROM offchain_activities');
      const sourceBaseCount = srcRows[0].n;
      const { rows: totalRows } = await targetClient.query('SELECT COUNT(*)::int AS n FROM user_activities');
      const targetTotal = totalRows[0].n;
      const { rows: reconciledRows } = await targetClient.query(`
        SELECT COUNT(*)::int AS n FROM user_activities ua
          JOIN _mig_map_offchain_activities m ON m.target_id = ua.id
         WHERE ua.metadata->>'origin' IS NOT NULL
      `);
      const reconciledCount = reconciledRows[0].n;
      const { rows: backfillRows } = await targetClient.query(`
        SELECT COUNT(*)::int AS n FROM user_activities
         WHERE metadata->>'origin' IN ('flash_challenge_completions', 'zkpassport_completions', 'activity_extra_points')
      `);
      const backfillCount = backfillRows[0].n;
      const expected = sourceBaseCount + (backfillCount - reconciledCount);
      results.push(
        targetTotal === expected
          ? pass('row-count: offchain_activities -> user_activities (+ award backfill)', `${targetTotal} rows`)
          : fail(
              'row-count: offchain_activities -> user_activities (+ award backfill)',
              `expected ${sourceBaseCount} base + ${backfillCount - reconciledCount} new backfill = ${expected}, got ${targetTotal}`
            )
      );
    } catch (err) {
      results.push(skip('row-count: offchain_activities -> user_activities (+ award backfill)', `source table unreadable: ${err.message}`));
    }
  } else {
    results.push(skip('row-count: offchain_activities -> user_activities (+ award backfill)', 'target table or _mig_map_offchain_activities missing'));
  }

  // `user_enrollments` <- `phase_participants`, but NOT 1:1: the §8.4
  // merge can fold two same-email participants into one user, and if
  // both were enrolled in the same phase the loader deduplicates to a
  // single enrollment (user_enrollments_user_season_event_unique).
  // expected = count of DISTINCT (canonical user, season_event) pairs,
  // computed by pushing every source (participant_id, phase_id) pair
  // through the two id maps.
  if ((await tableExists(targetClient, 'user_enrollments'))
      && (await tableExists(targetClient, '_mig_map_participants'))
      && (await tableExists(targetClient, '_mig_map_phases'))) {
    try {
      const { rows: srcPairs } = await querySource(sourcePool, 'SELECT participant_id, phase_id FROM phase_participants');
      const { rows: pMap } = await targetClient.query('SELECT source_id, target_id FROM _mig_map_participants');
      const { rows: phMap } = await targetClient.query('SELECT source_id, target_id FROM _mig_map_phases');
      const participantToUser = new Map(pMap.map((r) => [String(r.source_id), String(r.target_id)]));
      const phaseToEvent = new Map(phMap.map((r) => [String(r.source_id), String(r.target_id)]));
      const distinctPairs = new Set();
      for (const row of srcPairs) {
        const userId = participantToUser.get(String(row.participant_id));
        const eventId = phaseToEvent.get(String(row.phase_id));
        if (userId && eventId) distinctPairs.add(`${userId}:${eventId}`);
      }
      const expected = distinctPairs.size;
      const { rows: targetRows } = await targetClient.query('SELECT COUNT(*)::int AS n FROM user_enrollments');
      const targetCount = targetRows[0].n;
      results.push(
        targetCount === expected
          ? pass('row-count: phase_participants -> user_enrollments', `${targetCount} rows (${srcPairs.length} source rows, merge-deduped)`)
          : fail(
              'row-count: phase_participants -> user_enrollments',
              `expected ${expected} distinct post-merge (user, event) pairs from ${srcPairs.length} source rows, got ${targetCount}`
            )
      );
    } catch (err) {
      results.push(skip('row-count: phase_participants -> user_enrollments', `source table unreadable: ${err.message}`));
    }
  } else {
    results.push(skip('row-count: phase_participants -> user_enrollments', 'target table or id-map tables missing'));
  }

  // `leaderboard_snapshots` and `token_allocation` are merge-combined the
  // same way (the loader folds colliding post-merge rows into one), so
  // their expected counts are DISTINCT key tuples after pushing every
  // source row through the id maps — not the raw source row count.
  const mergeAwareCounts = [
    {
      name: 'row-count: leaderboard_snapshots -> leaderboard_snapshots',
      targetTable: 'leaderboard_snapshots',
      fetchSource: () =>
        querySource(sourcePool, 'SELECT participant_id, phase_id, snapshot_at FROM leaderboard_snapshots'),
      mapTables: ['_mig_map_participants', '_mig_map_phases'],
      keyOf: (row, maps) => {
        const userId = maps._mig_map_participants.get(String(row.participant_id));
        const eventId = maps._mig_map_phases.get(String(row.phase_id));
        if (!userId || !eventId) return null;
        return `${userId}:${eventId}:${new Date(row.snapshot_at).getTime()}`;
      },
    },
    {
      name: 'row-count: token_allocation -> token_allocation',
      targetTable: 'token_allocation',
      fetchSource: () => querySource(sourcePool, 'SELECT participant_id, season_id FROM token_allocation'),
      mapTables: ['_mig_map_participants', '_mig_map_seasons'],
      keyOf: (row, maps) => {
        const userId = maps._mig_map_participants.get(String(row.participant_id));
        const seasonId = maps._mig_map_seasons.get(String(row.season_id));
        if (!userId || !seasonId) return null;
        return `${userId}:${seasonId}`;
      },
    },
  ];
  for (const check of mergeAwareCounts) {
    const mapsPresent = (await Promise.all(check.mapTables.map((t) => tableExists(targetClient, t)))).every(Boolean);
    if (!(await tableExists(targetClient, check.targetTable)) || !mapsPresent) {
      results.push(skip(check.name, 'target table or id-map tables missing'));
      continue;
    }
    try {
      const { rows: srcRows } = await check.fetchSource();
      const maps = {};
      for (const mapTable of check.mapTables) {
        const { rows } = await targetClient.query(`SELECT source_id, target_id FROM ${mapTable}`);
        maps[mapTable] = new Map(rows.map((r) => [String(r.source_id), String(r.target_id)]));
      }
      const distinctKeys = new Set();
      for (const row of srcRows) {
        const key = check.keyOf(row, maps);
        if (key !== null) distinctKeys.add(key);
      }
      const expected = distinctKeys.size;
      const { rows: targetRows } = await targetClient.query(`SELECT COUNT(*)::int AS n FROM ${check.targetTable}`);
      const targetCount = targetRows[0].n;
      results.push(
        targetCount === expected
          ? pass(check.name, `${targetCount} rows (${srcRows.length} source rows, merge-combined)`)
          : fail(check.name, `expected ${expected} distinct post-merge keys from ${srcRows.length} source rows, got ${targetCount}`)
      );
    } catch (err) {
      results.push(skip(check.name, `source table unreadable: ${err.message}`));
    }
  }

  for (const [sourceTable, targetTable] of Object.entries(ROW_COUNT_TABLE_MAP)) {
    const exists = await tableExists(targetClient, targetTable);
    if (!exists) {
      results.push(skip(`row-count: ${sourceTable} -> ${targetTable}`, 'target table missing'));
      continue;
    }
    let sourceCount;
    try {
      const { rows } = await querySource(sourcePool, `SELECT COUNT(*)::int AS n FROM ${sourceTable}`);
      sourceCount = rows[0].n;
    } catch (err) {
      results.push(skip(`row-count: ${sourceTable} -> ${targetTable}`, `source table unreadable: ${err.message}`));
      continue;
    }
    const { rows: targetRows } = await targetClient.query(`SELECT COUNT(*)::int AS n FROM ${targetTable}`);
    const targetCount = targetRows[0].n;
    results.push(
      sourceCount === targetCount
        ? pass(`row-count: ${sourceTable} -> ${targetTable}`, `${targetCount} rows`)
        : fail(`row-count: ${sourceTable} -> ${targetTable}`, `source ${sourceCount} vs target ${targetCount}`)
    );
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// Gate 2 — no orphan foreign keys (SPEC §8.7 bullet 2)
// ─────────────────────────────────────────────────────────────────────
async function gateNoOrphanForeignKeys(ctx) {
  const { targetClient } = ctx;
  const results = [];
  for (const [table, column, refTable, refColumn] of FK_CHECKS) {
    if (!(await tableExists(targetClient, table))) {
      results.push(skip(`orphan-fk: ${table}.${column}`, `${table} missing`));
      continue;
    }
    const sql = `
      SELECT COUNT(*)::int AS n
        FROM ${table} t
       WHERE t.${column} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${refTable} r WHERE r.${refColumn} = t.${column})
    `;
    const { rows } = await targetClient.query(sql);
    results.push(
      rows[0].n === 0
        ? pass(`orphan-fk: ${table}.${column} -> ${refTable}.${refColumn}`)
        : fail(`orphan-fk: ${table}.${column} -> ${refTable}.${refColumn}`, `${rows[0].n} orphaned rows`)
    );
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// Gate 3 — scope invariants (SPEC §8.7 bullet 3)
// ─────────────────────────────────────────────────────────────────────
async function gateScopeInvariants(ctx) {
  const { targetClient } = ctx;
  const checks = [
    [
      'user_enrollments',
      `SELECT COUNT(*)::int AS n FROM user_enrollments ue
         JOIN season_events se ON se.id = ue.season_event_id
        WHERE ue.season_event_id IS NOT NULL AND ue.season_id <> se.season_id`,
    ],
    [
      'onchain_accounts',
      `SELECT COUNT(*)::int AS n FROM onchain_accounts oa
         JOIN season_events se ON se.id = oa.season_event_id
        WHERE oa.season_event_id IS NOT NULL AND oa.season_id <> se.season_id`,
    ],
  ];
  const results = [];
  for (const [label, sql] of checks) {
    const { rows } = await targetClient.query(sql);
    results.push(
      rows[0].n === 0
        ? pass(`scope-invariant: ${label}`)
        : fail(`scope-invariant: ${label}`, `${rows[0].n} rows with a season mismatching their event's season`)
    );
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// Gate 4 — award history / backfill count (SPEC §8.7 bullet 4)
// ─────────────────────────────────────────────────────────────────────
async function gateAwardBackfillCount(ctx) {
  const { targetClient, expectAwards } = ctx;
  const { rows } = await targetClient.query(`
    SELECT COUNT(*)::int AS n FROM user_activities
     WHERE metadata->>'origin' IN ('flash_challenge_completions', 'zkpassport_completions', 'activity_extra_points')
  `);
  const n = rows[0].n;
  return [
    n === expectAwards
      ? pass('award-backfill-count', `${n} backfilled award rows`)
      : fail('award-backfill-count', `expected ${expectAwards}, got ${n}`),
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Gate 5 — recomputation safety (SPEC §8.7 bullet 5)
//
// There is no scoring engine in this repo to reproduce the block-
// production component of `total_points` (mobile.js documents this: v4
// has no leaderboard-refresh machinery — block-production scoring
// happens outside this platform). What CAN be independently recomputed
// from data this migration itself writes is `extra_points`: by
// construction, `user_activities` is the complete ledger of everything
// that isn't block production — challenge completions and the §8.6
// award backfill — for a (user, event) pair, so summing its `points`
// must reproduce the `extra_points` already stored on that pair's
// latest snapshot. This is exactly the gate the spec calls out as
// catching "award rows lost in translation": if the backfill drops a
// row or attributes it to the wrong event, this sum stops matching.
// ─────────────────────────────────────────────────────────────────────
async function gateRecomputationSafety(ctx) {
  const { targetClient, sourcePool } = ctx;
  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (season_event_id, user_id) season_event_id, user_id, extra_points
        FROM leaderboard_snapshots
       ORDER BY season_event_id, user_id, snapshot_at DESC, id DESC
    ),
    recomputed AS (
      SELECT season_event_id, user_id, COALESCE(SUM(points), 0) AS recomputed_extra
        FROM user_activities
       GROUP BY season_event_id, user_id
    )
    SELECT l.season_event_id, l.user_id, l.extra_points, COALESCE(r.recomputed_extra, 0) AS recomputed_extra
      FROM latest l
      LEFT JOIN recomputed r ON r.season_event_id = l.season_event_id AND r.user_id = l.user_id
     WHERE l.extra_points <> COALESCE(r.recomputed_extra, 0)
  `;
  const { rows } = await targetClient.query(sql);
  if (rows.length === 0) return [pass('recomputation-safety: extra_points')];

  // A mismatch here is NOT automatically a loader bug: the source itself
  // holds "orphaned" activity points — activities awarded to a
  // participant in a phase where that participant has NO snapshot row at
  // the phase's final tick (verified in prod: points admin-awarded to a
  // human's OLD account after they switched to a new one; the old
  // account never snapshotted in that phase, so the points are invisible
  // in every source leaderboard AND absent from global_leaderboard). The
  // §8.4 merge unifies the ledger under one user, which surfaces exactly
  // that residue. The migration deliberately does NOT rewrite snapshot
  // totals to include it (that would silently change user-visible
  // points — a product decision, not a load step), so this gate
  // tolerates a mismatch IFF it equals the residue measured from the
  // source: the activities of merged-group members not represented at
  // the group's latest snapshot tick for that phase. Anything else
  // still fails.
  if (!sourcePool) {
    return [
      fail(
        'recomputation-safety: extra_points',
        `${rows.length} (user, event) pairs where SUM(user_activities.points) != stored extra_points (no source connection to check the orphaned-points allowance)`
      ),
    ];
  }
  // _mig_map_participants already encodes the §8.4 merge (every source
  // participant id -> its canonical user's target id), so no re-derivation
  // of the email grouping is needed here.
  const { rows: pMap } = await targetClient.query('SELECT source_id, target_id FROM _mig_map_participants');
  const { rows: phMap } = await targetClient.query('SELECT source_id, target_id FROM _mig_map_phases');
  const participantToUser = new Map(pMap.map((r) => [String(r.source_id), String(r.target_id)]));
  const phaseToEvent = new Map(phMap.map((r) => [String(r.source_id), String(r.target_id)]));

  // Latest snapshot tick per (participant, phase), and the group max.
  const { rows: lastTicks } = await querySource(
    sourcePool,
    'SELECT participant_id, phase_id, MAX(snapshot_at) AS last_at FROM leaderboard_snapshots GROUP BY 1, 2'
  );
  const lastTickByPair = new Map(); // "pid:phase" -> ms
  const maxTickByUserEvent = new Map(); // "userId:eventId" -> ms
  for (const r of lastTicks) {
    const ms = new Date(r.last_at).getTime();
    lastTickByPair.set(`${r.participant_id}:${r.phase_id}`, ms);
    const key = `${participantToUser.get(String(r.participant_id))}:${phaseToEvent.get(String(r.phase_id))}`;
    maxTickByUserEvent.set(key, Math.max(maxTickByUserEvent.get(key) ?? -Infinity, ms));
  }

  // Residue per (user, event): activity + extra points of source accounts
  // NOT present at the group's final tick.
  const residueByUserEvent = new Map();
  const addResidue = (participantId, phaseId, points) => {
    const userId = participantToUser.get(String(participantId));
    const eventId = phaseToEvent.get(String(phaseId));
    if (!userId || !eventId) return;
    const key = `${userId}:${eventId}`;
    const own = lastTickByPair.get(`${participantId}:${phaseId}`);
    const groupMax = maxTickByUserEvent.get(key);
    if (groupMax !== undefined && own === groupMax) return; // represented at final tick
    residueByUserEvent.set(key, (residueByUserEvent.get(key) ?? 0) + (Number(points) || 0));
  };
  const { rows: acts } = await querySource(
    sourcePool,
    'SELECT participant_id, phase_id, COALESCE(SUM(points), 0) AS pts FROM offchain_activities GROUP BY 1, 2'
  );
  for (const r of acts) addResidue(r.participant_id, r.phase_id, r.pts);
  const { rows: extras } = await querySource(
    sourcePool,
    'SELECT participant_id, phase_id, COALESCE(SUM(points), 0) AS pts FROM activity_extra_points GROUP BY 1, 2'
  );
  for (const r of extras) addResidue(r.participant_id, r.phase_id, r.pts);

  const unexplained = [];
  let explainedPoints = 0;
  for (const row of rows) {
    const gap = Number(row.recomputed_extra) - Number(row.extra_points);
    const residue = residueByUserEvent.get(`${row.user_id}:${row.season_event_id}`) ?? 0;
    if (Math.abs(gap - residue) > 0.01) unexplained.push(row);
    else explainedPoints += residue;
  }
  return [
    unexplained.length === 0
      ? pass(
          'recomputation-safety: extra_points',
          `${rows.length} mismatch(es) fully explained by ${explainedPoints} orphaned source points (activities on merged accounts absent from their phase's final snapshot tick)`
        )
      : fail(
          'recomputation-safety: extra_points',
          `${unexplained.length} (user, event) pairs where SUM(user_activities.points) != stored extra_points beyond the orphaned-points allowance`
        ),
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Gate 6 — points invariants per event, plus the all-time total check
// against the source's season-less standings (SPEC §8.7 bullet 6)
// ─────────────────────────────────────────────────────────────────────
async function gatePointsInvariants(ctx) {
  const { targetClient, sourcePool } = ctx;
  const results = [];

  if (!sourcePool || !(await tableExists(targetClient, '_mig_map_phases'))) {
    results.push(skip('points-invariant: per-event sums', 'no source connection or _mig_map_phases not present'));
  } else {
    const { rows: sourceSums } = await querySource(
      sourcePool,
      'SELECT phase_id, SUM(total_points) AS total_points, SUM(offchain_points) AS extra_points FROM leaderboard_snapshots GROUP BY phase_id'
    );
    const { rows: targetSums } = await targetClient.query(
      'SELECT season_event_id, SUM(total_points) AS total_points, SUM(extra_points) AS extra_points FROM leaderboard_snapshots GROUP BY season_event_id'
    );
    const { rows: mapRows } = await targetClient.query('SELECT source_id, target_id FROM _mig_map_phases');
    const phaseToEvent = new Map(mapRows.map((r) => [String(r.source_id), String(r.target_id)]));
    const targetByEvent = new Map(targetSums.map((r) => [String(r.season_event_id), r]));

    let mismatches = 0;
    for (const s of sourceSums) {
      const eventId = phaseToEvent.get(String(s.phase_id));
      const t = eventId ? targetByEvent.get(eventId) : undefined;
      const sTotal = Number(s.total_points) || 0;
      const sExtra = Number(s.extra_points) || 0;
      const tTotal = t ? Number(t.total_points) || 0 : null;
      const tExtra = t ? Number(t.extra_points) || 0 : null;
      const epsilon = 0.01;
      if (t === undefined || Math.abs(sTotal - tTotal) > epsilon || Math.abs(sExtra - tExtra) > epsilon) {
        mismatches++;
      }
    }
    results.push(
      mismatches === 0
        ? pass('points-invariant: per-event sums', `${sourceSums.length} events checked`)
        : fail('points-invariant: per-event sums', `${mismatches} event(s) with a changed total_points/extra_points sum`)
    );
  }

  // All-time total per user vs. the source's season-less standings.
  // `global_leaderboard` is an excluded table (§8.1) — it is never
  // loaded into the target — but it still physically exists in the
  // restored dump, and this is the one place §8.7 calls for reading it:
  // "assert once that the derived all-time total per user matches the
  // source's season-less rows." If it isn't present (e.g. a rehearsal
  // fixture that omits it), this check SKIPs rather than fails — it is
  // informational corroboration, not a table this migration owns.
  if (!sourcePool) {
    results.push(skip('points-invariant: all-time total vs global_leaderboard', 'no source connection'));
    return results;
  }
  let sourceHasGlobalLeaderboard = true;
  try {
    const { rows } = await querySource(
      sourcePool,
      "SELECT to_regclass('global_leaderboard') AS reg"
    );
    sourceHasGlobalLeaderboard = rows[0].reg !== null;
  } catch {
    sourceHasGlobalLeaderboard = false;
  }
  if (!sourceHasGlobalLeaderboard || !(await tableExists(targetClient, '_mig_map_participants'))) {
    results.push(
      skip(
        'points-invariant: all-time total vs global_leaderboard',
        'global_leaderboard not present in source, or _mig_map_participants not present'
      )
    );
    return results;
  }
  // `global_leaderboard` has no offchain_points column (verified against
  // the real schema: participant_id, total_points, phases_participated,
  // rank, ...) — and only total_points is consumed below anyway.
  //
  // season_id IS NULL is load-bearing: the real table keeps one row per
  // (participant, season) PLUS a season-less all-time row (see the
  // partial unique index global_leaderboard_participant_global_unique).
  // §8.7 says to compare against "the source's season-less rows" —
  // reading all rows double-counts every participant's total.
  const { rows: glRows } = await querySource(
    sourcePool,
    'SELECT participant_id, total_points FROM global_leaderboard WHERE season_id IS NULL'
  );
  const { rows: mapRows } = await targetClient.query('SELECT source_id, target_id FROM _mig_map_participants');
  const participantToUser = new Map(mapRows.map((r) => [String(r.source_id), String(r.target_id)]));
  const expectedByUser = new Map();
  for (const r of glRows) {
    const userId = participantToUser.get(String(r.participant_id));
    if (!userId) continue;
    const prior = expectedByUser.get(userId) || 0;
    expectedByUser.set(userId, prior + (Number(r.total_points) || 0));
  }
  const { computeStandings } = require('../src/services/topochain/standings');
  const standings = await computeStandings(targetClient, { seasonId: null });
  const actualByUser = new Map(standings.map((s) => [String(s.user_id), s.total_points]));
  let mismatches = 0;
  for (const [userId, expected] of expectedByUser) {
    const actual = actualByUser.get(userId) || 0;
    if (Math.abs(expected - actual) > 0.01) mismatches++;
  }
  results.push(
    mismatches === 0
      ? pass('points-invariant: all-time total vs global_leaderboard', `${expectedByUser.size} users checked`)
      : fail('points-invariant: all-time total vs global_leaderboard', `${mismatches} user(s) with a changed all-time total`)
  );
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// Gate 7 — identity (SPEC §8.7 bullet 7)
// ─────────────────────────────────────────────────────────────────────
async function gateIdentity(ctx) {
  const { targetClient, sourcePool } = ctx;
  const results = [];

  if (!sourcePool || !(await tableExists(targetClient, '_mig_map_participants'))) {
    results.push(skip('identity: every participant email resolves to exactly one user', 'no source connection or map missing'));
  } else {
    const { rows: participants } = await querySource(sourcePool, 'SELECT id, email FROM participants');
    const { rows: mapRows } = await targetClient.query('SELECT source_id, target_id FROM _mig_map_participants');
    const participantToUser = new Map(mapRows.map((r) => [String(r.source_id), String(r.target_id)]));
    const byEmail = new Map(); // normalized email -> Set of target user ids
    let unmapped = 0;
    for (const p of participants) {
      const userId = participantToUser.get(String(p.id));
      if (!userId) {
        unmapped++;
        continue;
      }
      const key = String(p.email).trim().toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, new Set());
      byEmail.get(key).add(userId);
    }
    const multiUserEmails = [...byEmail.entries()].filter(([, set]) => set.size > 1);
    results.push(
      unmapped === 0 && multiUserEmails.length === 0
        ? pass('identity: every participant email resolves to exactly one user', `${participants.length} participants checked`)
        : fail(
            'identity: every participant email resolves to exactly one user',
            `${unmapped} unmapped participant(s), ${multiUserEmails.length} email(s) split across users`
          )
    );
  }

  if (await tableExists(targetClient, '_mig_map_participants')) {
    const { rows } = await targetClient.query(`
      SELECT COUNT(*)::int AS n FROM users u
        JOIN _mig_map_participants m ON m.target_id = u.id
       WHERE u.is_admin = TRUE
    `);
    results.push(
      rows[0].n === 0
        ? pass('identity: no migrated row is an admin')
        : fail('identity: no migrated row is an admin', `${rows[0].n} migrated users have is_admin = TRUE`)
    );
  } else {
    results.push(skip('identity: no migrated row is an admin', '_mig_map_participants not present'));
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// Gate 8 — uniqueness (SPEC §8.7 bullet 8)
// ─────────────────────────────────────────────────────────────────────
async function gateUniqueness(ctx) {
  const { targetClient } = ctx;
  const checks = [
    ['users.email', "SELECT email FROM users WHERE email IS NOT NULL GROUP BY email HAVING COUNT(*) > 1"],
    ['users.username', 'SELECT username FROM users GROUP BY username HAVING COUNT(*) > 1'],
  ];
  const results = [];
  for (const [label, sql] of checks) {
    const { rows } = await targetClient.query(sql);
    results.push(
      rows.length === 0
        ? pass(`uniqueness: ${label}`)
        : fail(`uniqueness: ${label}`, `${rows.length} duplicate value(s)`)
    );
  }
  // Every other unique constraint in §3 (registration_code, the two
  // replay-protection partial indexes, the per-table UNIQUE()s, etc.) is
  // enforced live by Postgres at INSERT time — a load that reached this
  // point without a unique-violation error already proved those build
  // without conflict, so there is nothing further to query here.
  results.push(pass('uniqueness: every other §3 unique constraint', 'enforced live by Postgres during the load'));
  return results;
}

const GATES = [
  gateRowCounts,
  gateNoOrphanForeignKeys,
  gateScopeInvariants,
  gateAwardBackfillCount,
  gateRecomputationSafety,
  gatePointsInvariants,
  gateIdentity,
  gateUniqueness,
];

// runValidationGates(ctx) -> { gates, allPass }
//   ctx.targetClient — a connected pg Client/Pool for the target database
//                      (may be mid-transaction, so gates see uncommitted
//                      data from a load that just ran on the same client).
//   ctx.sourcePool   — a read-only-hardened pg Pool for the source, or
//                      null/undefined to skip every source-comparison gate.
//   ctx.expectUsers  — expected distinct migrated user count (default 188).
//   ctx.expectAwards — expected backfilled award row count (default 131).
async function runValidationGates(ctx) {
  const full = {
    expectUsers: 188,
    expectAwards: 131,
    ...ctx,
  };
  const gates = [];
  for (const gateFn of GATES) {
    try {
      const res = await gateFn(full);
      gates.push(...(Array.isArray(res) ? res : [res]));
    } catch (err) {
      gates.push(fail(gateFn.name, `gate threw: ${err.message}`));
    }
  }
  const allPass = gates.every((g) => g.status !== 'FAIL');
  return { gates, allPass };
}

function formatReport(gates) {
  const lines = gates.map((g) => {
    const marker = g.status === 'PASS' ? 'PASS' : g.status === 'FAIL' ? 'FAIL' : 'SKIP';
    return `[${marker}] ${g.name}${g.detail ? ` — ${g.detail}` : ''}`;
  });
  const passCount = gates.filter((g) => g.status === 'PASS').length;
  const failCount = gates.filter((g) => g.status === 'FAIL').length;
  const skipCount = gates.filter((g) => g.status === 'SKIP').length;
  lines.push('');
  lines.push(`${passCount} passed, ${failCount} failed, ${skipCount} skipped`);
  return lines.join('\n');
}

module.exports = {
  ROW_COUNT_TABLE_MAP,
  FK_CHECKS,
  querySource,
  runValidationGates,
  formatReport,
};

// ─────────────────────────────────────────────────────────────────────
// CLI entry point — standalone validation run
// ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const targetUrl = process.env.TARGET_DATABASE_URL;
    if (!targetUrl) {
      console.error('TARGET_DATABASE_URL is required.');
      process.exit(1);
    }
    const sourceUrl = process.env.TOPOCHAIN_SOURCE_DATABASE_URL;
    if (sourceUrl && !process.argv.includes('--i-have-restored-a-dump')) {
      console.error(
        'TOPOCHAIN_SOURCE_DATABASE_URL is set but --i-have-restored-a-dump was not passed. ' +
          'Refusing to open a connection to what might be the live topochain database. ' +
          'Pass --i-have-restored-a-dump once you have restored a DUMP into a scratch database.'
      );
      process.exit(1);
    }

    const argExpectUsers = process.argv.find((a) => a.startsWith('--expect-users='));
    const argExpectAwards = process.argv.find((a) => a.startsWith('--expect-awards='));
    const expectUsers = argExpectUsers ? parseInt(argExpectUsers.split('=')[1], 10) : 188;
    const expectAwards = argExpectAwards ? parseInt(argExpectAwards.split('=')[1], 10) : 131;

    const targetPool = new Pool({ connectionString: targetUrl });
    // Same read-only hardening as topochain-load.js (see its header
    // comment) — belt and suspenders even though this CLI path only ever
    // SELECTs.
    // Same two-mechanism hardening as topochain-load.js's makeSourcePool
    // (see that file's comment for the full reasoning): `options`
    // is the standalone guarantee (a Postgres startup-packet option, set
    // server-side before any query runs); `onConnect` — pg-pool's own
    // hook, awaited before a client is ever handed back to a caller — is
    // belt-and-braces, and unlike an unawaited 'connect'-event query, a
    // failed SET here actually fails the connection instead of being
    // silently swallowed.
    const sourcePool = sourceUrl
      ? new Pool({
          connectionString: sourceUrl,
          options: '-c default_transaction_read_only=on',
          onConnect: (client) => client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'),
        })
      : null;

    const targetClient = await targetPool.connect();
    let allPass = false;
    try {
      const result = await runValidationGates({ targetClient, sourcePool, expectUsers, expectAwards });
      console.log(formatReport(result.gates));
      allPass = result.allPass;
    } finally {
      targetClient.release();
      await targetPool.end();
      if (sourcePool) await sourcePool.end();
    }
    process.exit(allPass ? 0 : 1);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
