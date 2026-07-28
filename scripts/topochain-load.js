#!/usr/bin/env node
// Topochain data migration — the §8 load (Task 16; SPEC 3202-3321).
//
// This is the ONLY tool in the whole project that reads the topochain
// production system, and it NEVER writes to it — every read comes from a
// dump that has been restored into a scratch database first. Three
// independent layers enforce that:
//
//   1. The source connection is opened with
//      `options: '-c default_transaction_read_only=on'` (a Postgres
//      startup parameter — the server refuses any write on that session
//      before the driver even gets involved), AND every new connection
//      additionally runs `SET SESSION CHARACTERISTICS AS TRANSACTION
//      READ ONLY` right after connecting (belt and suspenders: two
//      independent mechanisms, so a bug in one doesn't undo the other).
//   2. The script refuses to start at all unless invoked with the
//      explicit `--i-have-restored-a-dump` flag — there is no way to
//      "accidentally" point this at a live database and have it just
//      start reading.
//   3. Every single read from the source goes through ONE function,
//      `querySource()`, a few lines below. Nothing else ever touches
//      `sourcePool.query` directly — that's what lets a static test (see
//      tests/topochain-load.test.js) assert every source-bound statement
//      in this file is a SELECT/WITH and nothing else, by construction
//      rather than by convention alone.
//
// ─── What this script does ──────────────────────────────────────────────
//
// Restores the source's 21 in-scope tables (SPEC §8.1's exclusion list)
// into the target schema (schema.sql's topochain block, Task 1), in the
// §8.6 load order, inside ONE transaction on the target database:
//
//   users <- participants (merged, §8.3-8.4) -> seasons -> season_events
//   -> user_enrollments -> challenge_kinds -> challenge_templates
//   -> challenges -> user_activities (+ the §8.6 award backfill)
//   -> onchain_accounts -> account_delegation_periods
//   -> leaderboard_snapshots -> token_allocation -> platform_settings fold
//   -> epoch_stats -> chains -> vrf_obligations
//   -> vrf_obligations_sync_state -> slot_outcome_reports -> mobile_logs
//   -> app_version_configs -> terms_versions -> user_terms_consents
//
// Every table whose id is referenced by a later table in this order gets
// a persisted `_mig_map_<source_table>` table in the TARGET database
// (source_id BIGINT PRIMARY KEY, target_id BIGINT NOT NULL) — a real
// audit trail of "what became what", not just an in-memory map, so a
// failed run can be inspected afterward and `topochain-validate.js` can
// run standalone against a target database whose load already finished.
// The seven maps: _mig_map_participants, _mig_map_seasons, _mig_map_
// phases, _mig_map_offchain_activity_types, _mig_map_phase_available_
// activities, _mig_map_offchain_activities, _mig_map_terms_versions.
//
// After the load, every §8.7 gate runs (scripts/topochain-validate.js)
// against the SAME (still-uncommitted) transaction. If every gate
// passes: the `_mig_map_*` tables are dropped, the `platform_settings`
// `topochain_migrated` marker is written, and the transaction commits.
// If ANY gate fails: the whole transaction rolls back — nothing is
// written, the target database ends up exactly as it started, and the
// failure report explains what to fix before retrying. This makes the
// script "idempotent-ish": a run that fails validation leaves no trace
// to clean up, and a run against a target that already has the marker
// refuses outright (no accidental double-load).
//
// ─── Usage ───────────────────────────────────────────────────────────────
//
//   TOPOCHAIN_SOURCE_DATABASE_URL=postgres://.../restored_dump \
//   TARGET_DATABASE_URL=postgres://.../target \
//     node scripts/topochain-load.js --i-have-restored-a-dump [--expect-users=188] [--expect-awards=131]
//
//   node scripts/topochain-load.js --i-have-restored-a-dump --validate-only
//     (runs every §8.7 gate against the CURRENT target state without
//      loading or writing anything; useful to re-check without re-running)
//
// ─── A note on the source table shapes ──────────────────────────────────
//
// SPEC §3.4 specifies the TARGET columns and cites the source column each
// comes from (mostly "=", a few renames — §8.2). It does NOT specify the
// shape of the three tables this migration converts into `user_activities`
// rows rather than loading directly (`flash_challenge_completions`,
// `zkpassport_completions`, `activity_extra_points`) or the tiny
// `point_settings` table — those are source-only, excluded-as-tables per
// §8.1, so no target schema pins their columns down. This file's
// assumptions about their shape (documented at each load function below)
// were built by reading everything SPEC §8 says ABOUT their behavior
// (e.g. "rows that already link to an activity are reconciled") and
// choosing the simplest column set consistent with that behavior. If the
// real source differs, only these specific functions need to change —
// nothing about the load order, the merge algorithm, or the validation
// gates depends on the exact shape guessed here.
//
// A second, load-bearing assumption specific to the award backfill
// (backfillAwards, below): the source enforces "one completion per
// (user, challenge)" and "one claim per (challenge, nullifier)" — the
// same guarantee its own `flash_challenge_completions`/`zkpassport_
// completions` tables existed to provide before this migration converts
// their rows into `user_activities` entries governed by the two §4.10
// replay-protection partial unique indexes. This is checked, not just
// assumed silently: findAwardBackfillCollisions() runs before any award
// row is written and fails loud, naming every colliding source row, if
// two rows would land on the same protected key.
'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('../src/services/logger');
const { runValidationGates, formatReport } = require('./topochain-validate');

// ═════════════════════════════════════════════════════════════════════
// Pure transforms — no DB access, exported for unit testing
// (tests/topochain-load.test.js exercises every one of these directly)
// ═════════════════════════════════════════════════════════════════════

// normalizeEmail(email) -> lower(trim(email)), SPEC §8.4 step 1.
function normalizeEmail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

// Fields the merge never touches when coalescing a duplicate-email group:
// `id` stays whatever the canonical (earliest) row's was — irrelevant
// past this function since the load assigns a fresh target id anyway —
// and `created_at` is deliberately NOT coalesced (kept at the earliest
// row's value; see below), so both are excluded from the generic
// non-null-overwrite loop.
const MERGE_EXCLUDED_FIELDS = new Set(['id', 'created_at']);

// mergeParticipants(rows) -> { canonicalRows, idMap }, SPEC §8.4 steps 1-3.
//
//   rows       — every source `participants` row (any shape; only `id`,
//                `email` and `created_at` are load-bearing here, every
//                other field is coalesced generically by name).
//   canonicalRows — one row per normalized email. Built from the EARLIEST
//                row in the group by `created_at` (ties broken by the
//                smaller source id, for determinism), then every other
//                field across the whole group is coalesced in ascending
//                created_at order with "newest non-null wins" (a later
//                row's non-null value always overwrites whatever was
//                there — so after the loop, each field holds whichever
//                row's value was the LAST non-null one seen, i.e. the
//                newest). `email` is force-set to the normalized form
//                afterward, so two rows differing only in
//                whitespace/case never leave a stray raw variant behind.
//                Each canonical row also carries `_source_ids` (every
//                source id folded into it) and `_canonical_source_id`
//                (the earliest row's own source id) for the load step to
//                build the real (target) id map from, once it knows what
//                target id the canonical row received.
//   idMap      — Map(source participant id -> CANONICAL SOURCE id). This
//                is a pure function with no database access, so it
//                cannot know the eventual TARGET id; the load step
//                (loadUsers, below) walks `_source_ids` on each inserted
//                canonical row to build the real source-id -> target-id
//                map once the insert returns.
function mergeParticipants(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = normalizeEmail(row.email);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const canonicalRows = [];
  const idMap = new Map();

  for (const [emailN, groupRows] of groups) {
    const sorted = [...groupRows].sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      if (ta !== tb) return ta - tb;
      return Number(a.id) - Number(b.id);
    });

    const canonical = { ...sorted[0] };
    for (const row of sorted) {
      for (const field of Object.keys(row)) {
        if (MERGE_EXCLUDED_FIELDS.has(field)) continue;
        const v = row[field];
        if (v !== null && v !== undefined) canonical[field] = v;
      }
    }
    canonical.email = emailN;
    canonical.created_at = sorted[0].created_at;
    canonical._source_ids = sorted.map((r) => r.id);
    canonical._canonical_source_id = sorted[0].id;

    canonicalRows.push(canonical);
    for (const r of sorted) idMap.set(r.id, sorted[0].id);
  }

  return { canonicalRows, idMap };
}

// rewritePasswordHash(password, opts?) -> { hash, passwordSet }, SPEC §8.5.
//   - a real `$2y$` (PHP/Laravel bcrypt) hash gets its prefix rewritten to
//     `$2b$` (Node's bcrypt) — the hash bytes are otherwise identical
//     between the two prefixes, so this is a pure string rewrite.
//   - a null/empty password (199 of 200 production rows, per §8.3) gets a
//     random, unusable bcrypt hash — of 32 random bytes nobody has ever
//     seen — purely to satisfy the target's NOT NULL, and `passwordSet:
//     false` so the mobile OTP flow (§4.5, Task 8) knows to treat this
//     account as still needing a caller-chosen password.
//   - `opts.randomBytesFn` / `opts.bcryptImpl` are injectable so unit
//     tests can assert the passwordless branch deterministically without
//     depending on real randomness or bcrypt's cost factor.
function rewritePasswordHash(password, opts = {}) {
  const randomBytesFn = opts.randomBytesFn || crypto.randomBytes;
  const bcryptImpl = opts.bcryptImpl || bcrypt;

  if (typeof password === 'string' && password.length > 0) {
    const hash = password.startsWith('$2y$') ? '$2b$' + password.slice(4) : password;
    return { hash, passwordSet: true };
  }

  const unusable = randomBytesFn(32).toString('hex');
  return { hash: bcryptImpl.hashSync(unusable, 10), passwordSet: false };
}

// deriveScopeColumns(seasonEventId, seasonEventToSeasonMap) -> { season_event_id, season_id }
//
// SPEC §8.6's "derive the scope columns" note: `user_enrollments` and
// `onchain_accounts` both need `season_id` filled in from their event's
// season. `seasonEventId` here is already a TARGET id (post-remap);
// `seasonEventToSeasonMap` is a Map(target season_event id -> target
// season id), built while loading season_events. A null/undefined event
// id means "season-wide, no event" and passes through as both null —
// that's new capability the §8 load itself never produces (it only
// creates event-level rows, per SPEC §8.4's user_enrollments note), but
// the function stays total so it's safe to reuse if that changes.
function deriveScopeColumns(seasonEventId, seasonEventToSeasonMap) {
  if (seasonEventId === null || seasonEventId === undefined) {
    return { season_event_id: null, season_id: null };
  }
  const seasonId = seasonEventToSeasonMap.get(seasonEventId);
  if (seasonId === undefined) {
    throw new Error(`deriveScopeColumns: unknown season_event_id ${seasonEventId}`);
  }
  return { season_event_id: seasonEventId, season_id: seasonId };
}

// buildBackfillMetadata(origin, row) -> the `metadata` object carried
// into `user_activities.metadata` for one backfilled award row (SPEC
// §8.6: "carry the identifying fields into metadata — kind, origin,
// session_id, nullifier_hex, wallet_address, reason").
//
//   - `origin` identifies which excluded source table the row came from.
//   - `kind` is 'challenge_completion' for the two completion tables
//     (this is the exact value the two replay-protection partial unique
//     indexes on user_activities key off — schema.sql:2246-2252) and
//     'extra_points' for activity_extra_points rows, which are NOT
//     replay-guarded the same way (a user can legitimately receive more
//     than one manual bonus award on the same challenge).
//   - `session_id`/`nullifier_hex` only ever come from zkpassport rows;
//     `wallet_address`/`reason` only ever come from activity_extra_points
//     rows. Omitted (not just null) when the origin doesn't carry them,
//     so `metadata->>'nullifier_hex' IS NOT NULL` stays a clean filter.
function buildBackfillMetadata(origin, row) {
  const metadata = { origin };
  if (origin === 'activity_extra_points') {
    metadata.kind = 'extra_points';
    if (row.reason != null) metadata.reason = row.reason;
    if (row.wallet_address != null) metadata.wallet_address = row.wallet_address;
  } else {
    metadata.kind = 'challenge_completion';
    if (origin === 'zkpassport_completions' && row.session_id != null) metadata.session_id = row.session_id;
    if (origin === 'zkpassport_completions' && row.nullifier_hex != null) metadata.nullifier_hex = row.nullifier_hex;
  }
  return metadata;
}

// mapBackfillRow(origin, row, ctx) -> the pure decision for one award-
// backfill source row, SPEC §8.6: "rows that already link to an activity
// are reconciled to it rather than duplicated; the rest are inserted
// with source = 'migration'".
//
//   ctx = { userId, challengeId, seasonEventId } — all already resolved
//   to TARGET ids by the caller (this function does no id-map lookups
//   itself, keeping it pure/testable without any map objects).
//
// Returns either:
//   { mode: 'reconcile', sourceOffchainActivityId, metadataPatch }
//     — row.offchain_activity_id was set: an activity for this
//       completion/award already exists (it will already have been
//       loaded as part of the base `offchain_activities` ->
//       `user_activities` load). The caller merges `metadataPatch` into
//       that existing row rather than inserting a second one — this is
//       what keeps the points from being double-counted.
//   { mode: 'insert', row }
//     — no existing activity to reconcile with: `row` is the full column
//       set for a brand-new `user_activities` insert, `source:
//       'migration'`. `activity_extra_points` rows carry a real point
//       value (that table's entire purpose); the two completion tables
//       never stored one (they were pure anti-replay markers), so their
//       backfilled rows carry `points: 0` — the points for a real
//       completion already exist in `offchain_activities` when linked,
//       and an orphaned completion (no offchain_activity_id at all)
//       never had a point value to preserve in the first place.
function mapBackfillRow(origin, row, ctx) {
  const metadata = buildBackfillMetadata(origin, row);

  if (row.offchain_activity_id !== null && row.offchain_activity_id !== undefined) {
    return { mode: 'reconcile', sourceOffchainActivityId: row.offchain_activity_id, metadataPatch: metadata };
  }

  return {
    mode: 'insert',
    row: {
      user_id: ctx.userId,
      season_event_id: ctx.seasonEventId,
      challenge_id: ctx.challengeId,
      activity_type: origin === 'activity_extra_points' ? 'bonus_points' : 'challenge_completion',
      points: origin === 'activity_extra_points' ? Number(row.points) || 0 : 0,
      description: null,
      metadata,
      activity_at: row.completed_at || row.created_at,
      source: 'migration',
    },
  };
}

// ═════════════════════════════════════════════════════════════════════
// DB helpers
// ═════════════════════════════════════════════════════════════════════

// THE only place `sourcePool.query` is ever called — see the header
// comment for why. Every string passed as `sql` MUST be a SELECT or WITH
// (enforced by the static test in tests/topochain-load.test.js).
async function querySource(sourcePool, sql, params) {
  return sourcePool.query(sql, params);
}

async function fetchAll(sourcePool, table, orderBy = 'id') {
  const { rows } = await querySource(sourcePool, `SELECT * FROM ${table} ORDER BY ${orderBy}`);
  return rows;
}

// Keyset-paginated read of a (potentially huge) source table, batchSize
// rows at a time, ordered by `id`. Used for the three large tables
// (vrf_obligations, slot_outcome_reports, epoch_stats/chains) so the
// process never has to hold the whole table in memory — the write side
// batches in the same sizes (insertBatch, below), which is the "batched
// multi-row INSERTs of ~1000 rows" approach SPEC §8.6's volume note asks
// for in place of a `pg-copy-streams` dependency this repo doesn't have.
async function* iterateSourceBatches(sourcePool, table, batchSize = 1000) {
  let lastId = 0;
  for (;;) {
    const { rows } = await querySource(
      sourcePool,
      `SELECT * FROM ${table} WHERE id > $1 ORDER BY id LIMIT $2`,
      [lastId, batchSize]
    );
    if (rows.length === 0) return;
    yield rows;
    lastId = rows[rows.length - 1].id;
    if (rows.length < batchSize) return;
  }
}

async function insertReturningId(client, table, values) {
  const columns = Object.keys(values);
  const params = columns.map((c) => values[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    params
  );
  return rows[0].id;
}

async function insertRow(client, table, values) {
  const columns = Object.keys(values);
  const params = columns.map((c) => values[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, params);
}

// Batched multi-row INSERT — see iterateSourceBatches's comment above for
// why 1000 rows is the unit both the read and write sides use.
async function insertBatch(client, table, columns, rowsOfArrays, batchSize = 1000) {
  for (let i = 0; i < rowsOfArrays.length; i += batchSize) {
    const chunk = rowsOfArrays.slice(i, i + batchSize);
    const valuesSql = [];
    const params = [];
    chunk.forEach((row, rIdx) => {
      const placeholders = row.map((_, cIdx) => `$${rIdx * row.length + cIdx + 1}`);
      valuesSql.push(`(${placeholders.join(', ')})`);
      params.push(...row);
    });
    await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${valuesSql.join(', ')}`, params);
  }
}

async function createMapTable(client, name) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${name} (source_id BIGINT PRIMARY KEY, target_id BIGINT NOT NULL)`);
}

async function persistMapEntries(client, name, entries) {
  if (!entries.length) return;
  await insertBatch(client, name, ['source_id', 'target_id'], entries.map(([s, t]) => [s, t]));
}

// The seven id-map tables this load creates, in the order Task 16's
// brief names them — dropped once every §8.7 gate has passed.
const MAP_TABLES = [
  '_mig_map_participants',
  '_mig_map_seasons',
  '_mig_map_phases',
  '_mig_map_offchain_activity_types',
  '_mig_map_phase_available_activities',
  '_mig_map_offchain_activities',
  '_mig_map_terms_versions',
];

async function dropMapTables(client) {
  for (const t of MAP_TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${t}`);
  }
}

async function hasMigratedMarker(client) {
  const { rows } = await client.query("SELECT 1 FROM platform_settings WHERE key = 'topochain_migrated'");
  return rows.length > 0;
}

async function writeMigratedMarker(client) {
  await client.query(
    "INSERT INTO platform_settings (key, value) VALUES ('topochain_migrated', '1') ON CONFLICT (key) DO NOTHING"
  );
}

// ═════════════════════════════════════════════════════════════════════
// Per-table load functions, in SPEC §8.6 order
// ═════════════════════════════════════════════════════════════════════

// users <- participants (merged). SPEC §8.3-8.5.
async function loadUsers(client, sourcePool, opts) {
  const rows = await fetchAll(sourcePool, 'participants');
  const { canonicalRows } = mergeParticipants(rows);

  if (canonicalRows.length !== opts.expectUsers) {
    throw new Error(
      `Identity merge produced ${canonicalRows.length} canonical users, expected ${opts.expectUsers} ` +
        `(pass --expect-users=${canonicalRows.length} to override if production counts have drifted since ` +
        'SPEC §8.3 was measured)'
    );
  }

  const participantMap = new Map(); // source participant id -> target user id
  for (const canonical of canonicalRows) {
    const { hash, passwordSet } = rewritePasswordHash(canonical.password);
    const emailN = normalizeEmail(canonical.email);
    const targetId = await insertReturningId(client, 'users', {
      username: emailN,
      password: hash,
      is_admin: false,
      created_at: canonical.created_at,
      email: emailN,
      email_confirmed: canonical.email_confirmed ?? false,
      email_confirmation_token: canonical.email_confirmation_token ?? null,
      email_confirmation_sent_at: canonical.email_confirmation_sent_at ?? null,
      email_confirmed_at: canonical.email_confirmed_at ?? null,
      display_name: canonical.display_name ?? null,
      telegram: canonical.telegram ?? null,
      discord: canonical.discord ?? null,
      github: canonical.github ?? null,
      x: canonical.x ?? null,
      is_in_waitlist: canonical.is_in_waitlist ?? false,
      waitlist_submitted_at: canonical.waitlist_submitted_at ?? null,
      waitlist_ip: canonical.waitlist_ip ?? null,
      waitlist_answers: canonical.waitlist_answers ?? null,
      referrer: canonical.referrer ?? null,
      referrer_handle: canonical.referrer_handle ?? null,
      country: canonical.country ?? null,
      city: canonical.city ?? null,
      device_info: canonical.device_info ?? null,
      exclude_podium: canonical.exclude_podium ?? false,
      accept_logs: canonical.accept_logs ?? true,
      updated_at: canonical.updated_at ?? null,
      password_set: passwordSet,
    });
    for (const sourceId of canonical._source_ids) participantMap.set(sourceId, targetId);
  }

  await createMapTable(client, '_mig_map_participants');
  await persistMapEntries(client, '_mig_map_participants', [...participantMap.entries()]);
  return { participantMap, userCount: canonicalRows.length, sourceParticipantCount: rows.length };
}

// seasons <- seasons (unchanged shape, fresh ids — SPEC §8.2).
async function loadSeasons(client, sourcePool) {
  const rows = await fetchAll(sourcePool, 'seasons');
  const seasonsMap = new Map();
  for (const row of rows) {
    const targetId = await insertReturningId(client, 'seasons', {
      name: row.name,
      description: row.description ?? null,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      is_active: row.is_active ?? true,
      internal: row.internal ?? false,
      display_order: row.display_order ?? 0,
      pool_info: row.pool_info ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    });
    seasonsMap.set(row.id, targetId);
  }
  await createMapTable(client, '_mig_map_seasons');
  await persistMapEntries(client, '_mig_map_seasons', [...seasonsMap.entries()]);
  return seasonsMap;
}

// season_events <- phases. Two passes: the self-referential
// `account_source_season_event_id` FK can point at a phase inserted
// AFTER it (or, in principle, later in iteration order), so every row is
// inserted first with that column null, then a second pass fills it in
// once every phase has a target id.
async function loadSeasonEvents(client, sourcePool, seasonsMap) {
  const rows = await fetchAll(sourcePool, 'phases');
  const phasesMap = new Map();
  const seasonEventToSeasonMap = new Map(); // target season_event id -> target season id
  const selfFkPending = [];

  for (const row of rows) {
    const seasonId = row.season_id != null ? seasonsMap.get(row.season_id) : null;
    if (row.season_id != null && seasonId === undefined) {
      throw new Error(`season_events: unmapped season_id ${row.season_id} (source phase ${row.id})`);
    }
    const targetId = await insertReturningId(client, 'season_events', {
      name: row.name,
      description: row.description ?? null,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      is_active: row.is_active ?? true,
      scoring_formula: row.scoring_formula,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      start_epoch: row.start_epoch ?? null,
      end_epoch: row.end_epoch ?? null,
      internal: row.internal ?? false,
      disclaimer: row.disclaimer ?? null,
      display_leaderboard: row.display_leaderboard ?? true,
      score_start_time: row.score_start_time ?? null,
      score_end_time: row.score_end_time ?? null,
      display_disclaimer: row.display_disclaimer ?? false,
      chain_id: row.chain_id ?? null,
      rank_based_on_bp_or_success_rate: row.rank_based_on_bp_or_success_rate || 'BP',
      display_activities: row.display_activities ?? false,
      season_id: seasonId ?? null,
      type: row.type || 'regular',
      account_inheritance_mode: row.account_inheritance_mode || 'none',
      account_source_season_event_id: null,
    });
    phasesMap.set(row.id, targetId);
    if (seasonId != null) seasonEventToSeasonMap.set(targetId, seasonId);
    if (row.account_source_phase_id != null) selfFkPending.push([targetId, row.account_source_phase_id]);
  }

  for (const [targetId, sourceAccountSourcePhaseId] of selfFkPending) {
    const targetAccountSourceId = phasesMap.get(sourceAccountSourcePhaseId);
    if (targetAccountSourceId === undefined) {
      throw new Error(`season_events: unmapped account_source_phase_id ${sourceAccountSourcePhaseId}`);
    }
    await client.query('UPDATE season_events SET account_source_season_event_id = $1 WHERE id = $2', [
      targetAccountSourceId,
      targetId,
    ]);
  }

  await createMapTable(client, '_mig_map_phases');
  await persistMapEntries(client, '_mig_map_phases', [...phasesMap.entries()]);
  return { phasesMap, seasonEventToSeasonMap };
}

// user_enrollments <- phase_participants. The §8 load only ever creates
// event-level rows (season_event_id always set) — season-wide enrollment
// is new capability the app starts using afterward (SPEC §3.4 note on
// `user_enrollments`) — so `deriveScopeColumns` here always resolves a
// real season_id.
async function loadUserEnrollments(client, sourcePool, participantMap, phasesMap, seasonEventToSeasonMap) {
  const rows = await fetchAll(sourcePool, 'phase_participants');
  const columns = ['season_event_id', 'user_id', 'season_id', 'registered_at', 'created_at', 'updated_at'];
  const batch = [];
  for (const row of rows) {
    const userId = participantMap.get(row.participant_id);
    if (userId === undefined) throw new Error(`user_enrollments: unmapped participant_id ${row.participant_id}`);
    const seasonEventId = phasesMap.get(row.phase_id);
    if (seasonEventId === undefined) throw new Error(`user_enrollments: unmapped phase_id ${row.phase_id}`);
    const scope = deriveScopeColumns(seasonEventId, seasonEventToSeasonMap);
    batch.push([
      scope.season_event_id,
      userId,
      scope.season_id,
      row.registered_at || row.created_at || new Date(),
      row.created_at ?? null,
      row.updated_at ?? null,
    ]);
  }
  await insertBatch(client, 'user_enrollments', columns, batch);
}

// challenge_kinds <- challenge_sub_categories. PK is a hand-assigned
// VARCHAR slug in both source and target (SPEC: "id | varchar(100) | PK
// | | ="), so it is copied verbatim — no id map needed. Returns the set
// of valid slugs so challenge_templates/challenges can clean orphaned
// `kind` values before those tables' real FK goes on (SPEC §3.4's
// challenge_sub_categories note: "the source validated in application
// code only, so clean orphaned slug values during the load").
async function loadChallengeKinds(client, sourcePool) {
  const rows = await fetchAll(sourcePool, 'challenge_sub_categories');
  const validKindIds = new Set();
  for (const row of rows) {
    await insertRow(client, 'challenge_kinds', {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    });
    validKindIds.add(row.id);
  }
  return validKindIds;
}

function cleanKind(rawKind, validKindIds) {
  if (rawKind === null || rawKind === undefined) return { kind: null, wasOrphaned: false };
  if (validKindIds.has(rawKind)) return { kind: rawKind, wasOrphaned: false };
  return { kind: null, wasOrphaned: true };
}

// challenge_templates <- offchain_activity_types.
async function loadChallengeTemplates(client, sourcePool, validKindIds) {
  const rows = await fetchAll(sourcePool, 'offchain_activity_types');
  const templatesMap = new Map();
  let orphaned = 0;
  for (const row of rows) {
    const { kind, wasOrphaned } = cleanKind(row.sub_category, validKindIds);
    if (wasOrphaned) orphaned++;
    const targetId = await insertReturningId(client, 'challenge_templates', {
      category: row.category,
      goal: row.goal,
      task: row.task,
      reward: row.reward,
      description: row.description ?? null,
      requirements: row.requirements ?? null,
      schedule_start: row.schedule_start ?? null,
      schedule_end: row.schedule_end ?? null,
      reward_logic: row.reward_logic ?? null,
      cta_button: row.cta_button ?? null,
      cta_label: row.cta_label ?? null,
      cta_link: row.cta_link ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      kind,
      cta_type: row.cta_type ?? null,
      mobile_cta_type: row.mobile_cta_type ?? null,
      mobile_cta_label: row.mobile_cta_label ?? null,
      mobile_cta_link: row.mobile_cta_link ?? null,
      metric_type: row.metric_type ?? null,
      metric_target: row.metric_target ?? null,
      metric_label: row.metric_label ?? null,
    });
    templatesMap.set(row.id, targetId);
  }
  if (orphaned > 0) log.warn('topochain-load', `Cleaned ${orphaned} orphaned kind value(s) on challenge_templates`);
  await createMapTable(client, '_mig_map_offchain_activity_types');
  await persistMapEntries(client, '_mig_map_offchain_activity_types', [...templatesMap.entries()]);
  return templatesMap;
}

// challenges <- phase_available_activities.
async function loadChallenges(client, sourcePool, phasesMap, templatesMap, validKindIds) {
  const rows = await fetchAll(sourcePool, 'phase_available_activities');
  const challengesMap = new Map();
  const challengeToSeasonEvent = new Map(); // target challenge id -> target season_event id
  let orphaned = 0;
  for (const row of rows) {
    const seasonEventId = phasesMap.get(row.phase_id);
    if (seasonEventId === undefined) throw new Error(`challenges: unmapped phase_id ${row.phase_id}`);
    const templateId = templatesMap.get(row.offchain_activity_type_id);
    if (templateId === undefined) {
      throw new Error(`challenges: unmapped offchain_activity_type_id ${row.offchain_activity_type_id}`);
    }
    const { kind, wasOrphaned } = cleanKind(row.sub_category, validKindIds);
    if (wasOrphaned) orphaned++;
    const targetId = await insertReturningId(client, 'challenges', {
      season_event_id: seasonEventId,
      challenge_template_id: templateId,
      goal: row.goal ?? null,
      task: row.task ?? null,
      reward: row.reward ?? null,
      description: row.description ?? null,
      requirements: row.requirements ?? null,
      schedule_start: row.schedule_start ?? null,
      schedule_end: row.schedule_end ?? null,
      reward_logic: row.reward_logic ?? null,
      cta_button: row.cta_button ?? null,
      cta_label: row.cta_label ?? null,
      cta_link: row.cta_link ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      enabled: row.enabled ?? true,
      display_order: row.display_order ?? 0,
      completed: row.completed ?? false,
      kind,
      cta_type: row.cta_type ?? null,
      mobile_cta_type: row.mobile_cta_type ?? null,
      mobile_cta_label: row.mobile_cta_label ?? null,
      mobile_cta_link: row.mobile_cta_link ?? null,
      metric_type: row.metric_type ?? null,
      metric_target: row.metric_target ?? null,
      metric_label: row.metric_label ?? null,
      featured: row.featured ?? false,
      featured_order: row.featured_order ?? null,
    });
    challengesMap.set(row.id, targetId);
    challengeToSeasonEvent.set(targetId, seasonEventId);
  }
  if (orphaned > 0) log.warn('topochain-load', `Cleaned ${orphaned} orphaned kind value(s) on challenges`);
  await createMapTable(client, '_mig_map_phase_available_activities');
  await persistMapEntries(client, '_mig_map_phase_available_activities', [...challengesMap.entries()]);
  return { challengesMap, challengeToSeasonEvent };
}

// user_activities <- offchain_activities.
async function loadUserActivities(client, sourcePool, participantMap, phasesMap, challengesMap) {
  const rows = await fetchAll(sourcePool, 'offchain_activities');
  const activitiesMap = new Map(); // source offchain_activities id -> target user_activities id
  for (const row of rows) {
    const userId = participantMap.get(row.participant_id);
    if (userId === undefined) throw new Error(`user_activities: unmapped participant_id ${row.participant_id}`);
    const seasonEventId = phasesMap.get(row.phase_id);
    if (seasonEventId === undefined) throw new Error(`user_activities: unmapped phase_id ${row.phase_id}`);
    const challengeId = challengesMap.get(row.phase_available_activity_id);
    if (challengeId === undefined) {
      throw new Error(`user_activities: unmapped phase_available_activity_id ${row.phase_available_activity_id}`);
    }
    const targetId = await insertReturningId(client, 'user_activities', {
      user_id: userId,
      season_event_id: seasonEventId,
      activity_type: row.activity_type,
      points: row.points ?? 0,
      description: row.description ?? null,
      metadata: row.metadata ?? null,
      activity_at: row.activity_at,
      added_by: null, // admins are not migrated, SPEC §8.1
      source: row.source || 'admin_ui',
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      challenge_id: challengeId,
    });
    activitiesMap.set(row.id, targetId);
  }
  await createMapTable(client, '_mig_map_offchain_activities');
  await persistMapEntries(client, '_mig_map_offchain_activities', [...activitiesMap.entries()]);
  return activitiesMap;
}

// findAwardBackfillCollisions(actions) -> [] | [{ indexName, key, actions }]
//
// Pure pre-flight check for the award backfill's two replay-protection
// partial unique indexes (schema.sql:2246-2252 — `user_activities_
// completion_unique (user_id, challenge_id) WHERE kind =
// 'challenge_completion'` and `user_activities_nullifier_unique
// (challenge_id, nullifier_hex) WHERE nullifier_hex IS NOT NULL`).
//
// This migration ASSUMES the source enforces "one completion per
// (user, challenge)" and "one claim per (challenge, nullifier)" — the
// same guarantee `flash_challenge_completions`/`zkpassport_completions`
// existed to provide in the source app (see the file header's
// documented-assumptions note). If a dump violates that assumption, the
// backfill would otherwise hit one of these indexes as a raw Postgres
// 23505 buried inside a loop — useless for an operator to act on. This
// function finds every violated key BEFORE any insert/update runs and
// names every source row involved, so the failure is a diagnosis, not a
// stack trace.
//
//   actions: [{ origin, sourceId, userId, challengeId, kind, nullifierHex, targetIdentity }]
//     `targetIdentity` distinguishes "the same physical destination row"
//     from "a genuinely different one": a RECONCILE action's identity is
//     the (already-existing) target user_activities id it will UPDATE —
//     so two award rows reconciling onto the SAME existing activity are
//     never flagged (it's one UPDATE landing twice, not a conflict). An
//     INSERT action's identity is unique to itself (a new row always
//     collides with anything else sharing its key). A real collision is
//     a key backed by 2+ DISTINCT target identities.
function findAwardBackfillCollisions(actions) {
  const byCompletionKey = new Map();
  const byNullifierKey = new Map();
  for (const action of actions) {
    if (action.kind === 'challenge_completion') {
      const key = `${action.userId}:${action.challengeId}`;
      if (!byCompletionKey.has(key)) byCompletionKey.set(key, []);
      byCompletionKey.get(key).push(action);
    }
    if (action.nullifierHex != null) {
      const key = `${action.challengeId}:${action.nullifierHex}`;
      if (!byNullifierKey.has(key)) byNullifierKey.set(key, []);
      byNullifierKey.get(key).push(action);
    }
  }

  const collisions = [];
  const check = (map, indexName) => {
    for (const [key, groupActions] of map) {
      const distinctTargets = new Set(groupActions.map((a) => a.targetIdentity));
      if (distinctTargets.size > 1) {
        collisions.push({
          indexName,
          key,
          actions: groupActions.map((a) => ({ origin: a.origin, sourceId: a.sourceId })),
        });
      }
    }
  };
  check(byCompletionKey, 'user_activities_completion_unique (user_id, challenge_id)');
  check(byNullifierKey, 'user_activities_nullifier_unique (challenge_id, nullifier_hex)');
  return collisions;
}

function formatAwardBackfillCollisions(collisions) {
  const detail = collisions
    .map((c) => `${c.indexName} key ${c.key}: ${c.actions.map((a) => `${a.origin}#${a.sourceId}`).join(', ')}`)
    .join('; ');
  return (
    'Award backfill would violate a replay-protection unique index on user_activities. This migration assumes ' +
    'the source enforces "one completion per (user, challenge)" and "one claim per (challenge, nullifier)" (see ' +
    "this file's header) — that assumption does not hold for this dump; the offending rows need manual " +
    `reconciliation before re-running. Colliding groups: ${detail}`
  );
}

// If the pre-flight check above somehow misses a case (it is not
// expected to, but it is defense in depth, the same two-independent-
// mechanisms posture as the read-only source guarantee), a genuine
// 23505 from Postgres is rethrown with the same diagnosis rather than
// left as a bare driver error.
function diagnoseUniqueViolation(err, origin, sourceId) {
  if (err && err.code === '23505') {
    return new Error(
      `Award backfill row from ${origin}#${sourceId} violated a replay-protection unique index on ` +
        `user_activities (${err.constraint || 'unknown constraint'}) that the pre-flight collision check did not ` +
        `catch. This migration assumes the source enforces "one completion per (user, challenge)" and "one claim ` +
        `per (challenge, nullifier)" (see the file header) — that assumption does not hold for this dump. ` +
        `Original error: ${err.message}`
    );
  }
  return err;
}

// The §8.6 award backfill: flash_challenge_completions +
// zkpassport_completions + activity_extra_points -> user_activities.
// Assumed source shape for all three (see the file header note): each
// row carries `participant_id`, `phase_available_activity_id` (which
// challenge the award/completion is against) and a nullable
// `offchain_activity_id` (set when the source app already recorded a
// matching points-bearing activity row for this exact completion/award —
// the reconcile path). zkpassport rows additionally carry `session_id`/
// `nullifier_hex`; activity_extra_points rows carry `points`/`reason`/
// `wallet_address`. A further assumption, load-bearing for this
// function specifically: the source enforces "one completion per (user,
// challenge)" and "one claim per (challenge, nullifier)" the same way
// its own now-excluded completion tables did — findAwardBackfillCollisions
// checks that assumption up front rather than trusting it silently.
async function backfillAwards(client, sourcePool, participantMap, challengesMap, challengeToSeasonEvent, activitiesMap) {
  const origins = ['flash_challenge_completions', 'zkpassport_completions', 'activity_extra_points'];

  // Phase 1: resolve every row's ids and decide its mode (reconcile vs
  // insert) WITHOUT touching the database — this is what makes the
  // collision check below possible before any write happens.
  const planned = [];
  for (const origin of origins) {
    const rows = await fetchAll(sourcePool, origin);
    for (const row of rows) {
      const userId = participantMap.get(row.participant_id);
      if (userId === undefined) throw new Error(`${origin}: unmapped participant_id ${row.participant_id}`);
      const challengeId = challengesMap.get(row.phase_available_activity_id);
      if (challengeId === undefined) {
        throw new Error(`${origin}: unmapped phase_available_activity_id ${row.phase_available_activity_id}`);
      }
      const seasonEventId = challengeToSeasonEvent.get(challengeId);
      const mapped = mapBackfillRow(origin, row, { userId, challengeId, seasonEventId });

      let targetIdentity;
      if (mapped.mode === 'reconcile') {
        const targetActivityId = activitiesMap.get(mapped.sourceOffchainActivityId);
        if (targetActivityId === undefined) {
          throw new Error(`${origin}: unmapped offchain_activity_id ${mapped.sourceOffchainActivityId} to reconcile`);
        }
        targetIdentity = `reconcile:${targetActivityId}`;
      } else {
        targetIdentity = `insert:${origin}:${row.id}`;
      }

      const metadata = mapped.mode === 'reconcile' ? mapped.metadataPatch : mapped.row.metadata;
      planned.push({
        origin,
        sourceId: row.id,
        userId,
        challengeId,
        kind: metadata.kind,
        nullifierHex: metadata.nullifier_hex ?? null,
        targetIdentity,
        mapped,
      });
    }
  }

  // Phase 2: fail loud, up front, if any two rows would land on the same
  // replay-protection key.
  const collisions = findAwardBackfillCollisions(planned);
  if (collisions.length > 0) {
    throw new Error(formatAwardBackfillCollisions(collisions));
  }

  // Phase 3: execute. The 23505 catch here is defense in depth (see
  // diagnoseUniqueViolation's comment) — the collision check above
  // should already have ruled this out.
  let inserted = 0;
  let reconciled = 0;
  for (const action of planned) {
    const { mapped, origin, sourceId } = action;
    if (mapped.mode === 'reconcile') {
      const targetActivityId = activitiesMap.get(mapped.sourceOffchainActivityId);
      try {
        await client.query(
          "UPDATE user_activities SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2",
          [JSON.stringify(mapped.metadataPatch), targetActivityId]
        );
      } catch (err) {
        throw diagnoseUniqueViolation(err, origin, sourceId);
      }
      reconciled++;
    } else {
      try {
        await insertRow(client, 'user_activities', mapped.row);
      } catch (err) {
        throw diagnoseUniqueViolation(err, origin, sourceId);
      }
      inserted++;
    }
  }
  return { inserted, reconciled, total: inserted + reconciled };
}

// onchain_accounts <- onchain_accounts (unchanged shape + scope derive).
async function loadOnchainAccounts(client, sourcePool, participantMap, phasesMap, seasonEventToSeasonMap) {
  const rows = await fetchAll(sourcePool, 'onchain_accounts');
  const columns = [
    'amount', 'identity_uid', 'address', 'public_key', 'secret_key', 'tier', 'description',
    'registration_code', 'season_event_id', 'season_id', 'user_id', 'is_used', 'used_at',
    'created_at', 'updated_at',
  ];
  const batch = [];
  for (const row of rows) {
    const seasonEventId = row.phase_id != null ? phasesMap.get(row.phase_id) : null;
    if (row.phase_id != null && seasonEventId === undefined) {
      throw new Error(`onchain_accounts: unmapped phase_id ${row.phase_id}`);
    }
    const scope = deriveScopeColumns(seasonEventId ?? null, seasonEventToSeasonMap);
    let userId = null;
    if (row.participant_id != null) {
      userId = participantMap.get(row.participant_id);
      if (userId === undefined) throw new Error(`onchain_accounts: unmapped participant_id ${row.participant_id}`);
    }
    batch.push([
      row.amount, row.identity_uid, row.address, row.public_key, row.secret_key, row.tier,
      row.description ?? null, row.registration_code, scope.season_event_id, scope.season_id, userId,
      row.is_used ?? false, row.used_at ?? null, row.created_at ?? null, row.updated_at ?? null,
    ]);
  }
  await insertBatch(client, 'onchain_accounts', columns, batch);
}

async function loadAccountDelegationPeriods(client, sourcePool) {
  const rows = await fetchAll(sourcePool, 'account_delegation_periods');
  const columns = ['account', 'started_at', 'ended_at', 'created_at', 'updated_at'];
  const batch = rows.map((row) => [
    row.account, row.started_at, row.ended_at ?? null, row.created_at ?? null, row.updated_at ?? null,
  ]);
  await insertBatch(client, 'account_delegation_periods', columns, batch);
}

// leaderboard_snapshots <- leaderboard_snapshots. `season_id` is a plain
// (no-FK) column in the target but still an id whose VALUE changes
// across the migration (fresh season ids, SPEC §8.2), so it is remapped
// through `seasonsMap` the same as everywhere else and fails loud (like
// every other unmapped-id case in this file) rather than silently
// nulling out on an unmapped id — there is no database FK to catch that
// for us here, so this is the one place doing so is entirely on this
// function; topochain-validate.js's orphan-fk gate checks it too, since
// SPEC §8.7 names `season_id` as a column to verify at every occurrence,
// not only where a database FK happens to exist (the same reasoning
// behind that gate also covering slot_outcome_reports.user_id).
async function loadLeaderboardSnapshots(client, sourcePool, participantMap, phasesMap, seasonsMap) {
  const rows = await fetchAll(sourcePool, 'leaderboard_snapshots');
  const columns = [
    'season_event_id', 'user_id', 'rank', 'total_points', 'extra_points', 'snapshot_at', 'created_at', 'updated_at',
    'last_epoch_total_produced_blocks', 'event_total_produced_blocks', 'event_success_rate', 'epoch_success_rate',
    'first_block_points', 'produced_half_blocks_points', 'top_3_points', 'success_50_percent_points',
    'bug_report_points', 'inviting_new_participant_points', 'community_contribution_points',
    'vrf_total_won_slots', 'canonical_total_won_slots', 'canonical_total_produced_blocks',
    'canonical_won_slots_up_to_current', 'canonical_produced_blocks_up_to_current',
    'max_bp_success_rate_up_to_current', 'season_id', 'challenge_details',
  ];
  const batch = [];
  for (const row of rows) {
    const seasonEventId = phasesMap.get(row.phase_id);
    if (seasonEventId === undefined) throw new Error(`leaderboard_snapshots: unmapped phase_id ${row.phase_id}`);
    const userId = participantMap.get(row.participant_id);
    if (userId === undefined) throw new Error(`leaderboard_snapshots: unmapped participant_id ${row.participant_id}`);
    let seasonId = null;
    if (row.season_id != null) {
      seasonId = seasonsMap.get(row.season_id);
      if (seasonId === undefined) throw new Error(`leaderboard_snapshots: unmapped season_id ${row.season_id}`);
    }
    batch.push([
      seasonEventId, userId, row.rank, row.total_points ?? 0, row.offchain_points ?? 0, row.snapshot_at,
      row.created_at ?? null, row.updated_at ?? null,
      row.last_epoch_total_produced_blocks ?? 0, row.phase_total_produced_blocks ?? 0,
      row.phase_success_rate ?? null, row.epoch_success_rate ?? null,
      row.first_block_points ?? 0, row.produced_half_blocks_points ?? 0, row.top_3_points ?? 0,
      row.success_50_percent_points ?? 0, row.bug_report_points ?? 0, row.inviting_new_participant_points ?? 0,
      row.community_contribution_points ?? 0, row.vrf_total_won_slots ?? 0, row.canonical_total_won_slots ?? 0,
      row.canonical_total_produced_blocks ?? 0, row.canonical_won_slots_up_to_current ?? 0,
      row.canonical_produced_blocks_up_to_current ?? 0, row.max_bp_success_rate_up_to_current ?? 0,
      seasonId, row.challenge_details ?? null,
    ]);
  }
  await insertBatch(client, 'leaderboard_snapshots', columns, batch);
}

async function loadTokenAllocation(client, sourcePool, participantMap, seasonsMap) {
  const rows = await fetchAll(sourcePool, 'token_allocation');
  const columns = [
    'user_id', 'season_id', 'total_points', 'total_season_tokens', 'allocated_tokens',
    'description', 'created_at', 'updated_at', 'updated_by',
  ];
  const batch = [];
  for (const row of rows) {
    const userId = participantMap.get(row.participant_id);
    if (userId === undefined) throw new Error(`token_allocation: unmapped participant_id ${row.participant_id}`);
    const seasonId = seasonsMap.get(row.season_id);
    if (seasonId === undefined) throw new Error(`token_allocation: unmapped season_id ${row.season_id}`);
    batch.push([
      userId, seasonId, row.total_points ?? 0, row.total_season_tokens ?? 0, row.allocated_tokens ?? 0,
      row.description ?? null, row.created_at ?? null, row.updated_at ?? null,
      null, // updated_by referenced a source admin; admins are not migrated, SPEC §8.1
    ]);
  }
  await insertBatch(client, 'token_allocation', columns, batch);
}

// point_settings folds into platform_settings (SPEC §8.2, §3.5). Only
// the seven keys Task 2 already seeded as `topochain_`-prefixed defaults
// are meaningful settings; anything else in point_settings is ignored
// (it either isn't a real setting or, per Task 2's own resolution note,
// some names like `bug_report_points` are per-row leaderboard_snapshots
// columns, not settings at all). Source values win over the Task-2
// defaults via ON CONFLICT DO UPDATE — they're real measured production
// configuration, more authoritative than a bootstrap default.
const SETTINGS_KEY_ALLOWLIST = new Set([
  'first_block_points', 'produced_half_blocks_points', 'top_1_points', 'top_2_points',
  'top_3_points', 'success_50_percent_points', 'inviting_new_participant_points',
]);

async function foldPlatformSettings(client, sourcePool) {
  let rows;
  try {
    rows = await fetchAll(sourcePool, 'point_settings', 'key');
  } catch (err) {
    log.warn('topochain-load', `point_settings unreadable, skipping the settings fold: ${err.message}`);
    return { folded: 0 };
  }
  let folded = 0;
  for (const row of rows) {
    if (!SETTINGS_KEY_ALLOWLIST.has(row.key)) continue;
    await client.query(
      'INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [`topochain_${row.key}`, String(row.value)]
    );
    folded++;
  }
  return { folded };
}

async function loadEpochStats(client, sourcePool, participantMap) {
  const columns = [
    'chain_id', 'wallet_address', 'user_id', 'epoch', 'epoch_won_slots', 'epoch_produced_blocks',
    'epoch_canonical_blocks', 'epoch_orphaned_blocks', 'epoch_failed_blocks', 'created_at', 'updated_at',
  ];
  for await (const rows of iterateSourceBatches(sourcePool, 'epoch_stats')) {
    const batch = rows.map((row) => [
      row.chain_id, row.wallet_address,
      row.participant_id != null ? participantMap.get(row.participant_id) ?? null : null,
      row.epoch, row.epoch_won_slots ?? 0, row.epoch_produced_blocks ?? 0, row.epoch_canonical_blocks ?? 0,
      row.epoch_orphaned_blocks ?? 0, row.epoch_failed_blocks ?? 0, row.created_at ?? null, row.updated_at ?? null,
    ]);
    await insertBatch(client, 'epoch_stats', columns, batch);
  }
}

async function loadChains(client, sourcePool) {
  const columns = [
    'chain_id', 'global_slot', 'block_height', 'slot_time', 'canonical', 'block_hash',
    'producer', 'predecessor', 'epoch', 'created_at', 'updated_at',
  ];
  for await (const rows of iterateSourceBatches(sourcePool, 'chains')) {
    const batch = rows.map((row) => [
      row.chain_id, row.global_slot, row.block_height, row.slot_time, row.canonical, row.block_hash,
      row.producer, row.predecessor ?? null, row.epoch, row.created_at ?? null, row.updated_at ?? null,
    ]);
    await insertBatch(client, 'chains', columns, batch);
  }
}

// vrf_obligations — by far the largest table (SPEC: ~3.08M rows). No id
// map (nothing references it), no participant translation (chain_id/
// sender_pk_hash are the only identity here) — a straight batched copy.
async function loadVrfObligations(client, sourcePool) {
  const columns = [
    'chain_id', 'global_slot', 'sender_pk_hash', 'sender', 'active_participant', 'stake', 'tier', 'threshold',
    'status', 'produced_count', 'out_of_window_produced_count', 'dropped_count', 'evidence_run_id',
    'evidence_event_id', 'evidence_timestamp_ms', 'observed_first_seen_ms', 'observed_last_seen_ms',
    'epoch', 'epoch_slot', 'slot_time_ms', 'raw', 'synced_at', 'created_at', 'updated_at',
    'vrf_output_truncated', 'vrf_output_be_bytes',
  ];
  let total = 0;
  for await (const rows of iterateSourceBatches(sourcePool, 'vrf_obligations', 1000)) {
    const batch = rows.map((row) => [
      row.chain_id, row.global_slot, row.sender_pk_hash, row.sender ?? null,
      row.active_participant ?? false, row.stake ?? null, row.tier ?? null, row.threshold ?? null,
      row.status, row.produced_count ?? 0, row.out_of_window_produced_count ?? 0, row.dropped_count ?? 0,
      row.evidence_run_id ?? null, row.evidence_event_id ?? null, row.evidence_timestamp_ms ?? null,
      row.observed_first_seen_ms ?? null, row.observed_last_seen_ms ?? null, row.epoch, row.epoch_slot ?? null,
      row.slot_time_ms ?? null, row.raw ?? null, row.synced_at || new Date(), row.created_at ?? null,
      row.updated_at ?? null, row.vrf_output_truncated ?? null, row.vrf_output_be_bytes ?? null,
    ]);
    await insertBatch(client, 'vrf_obligations', columns, batch, 1000);
    total += rows.length;
  }
  return total;
}

async function loadVrfObligationsSyncState(client, sourcePool) {
  const rows = await fetchAll(sourcePool, 'vrf_obligations_sync_state', 'chain_id');
  for (const row of rows) {
    await insertRow(client, 'vrf_obligations_sync_state', {
      chain_id: row.chain_id,
      last_synced_slot: row.last_synced_slot ?? 0,
      partial_window_from_slot: row.partial_window_from_slot ?? null,
      partial_window_to_slot: row.partial_window_to_slot ?? null,
      last_synced_at: row.last_synced_at ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      descending_cursor_slot: row.descending_cursor_slot ?? null,
      last_known_tip_slot: row.last_known_tip_slot ?? null,
    });
  }
}

// slot_outcome_reports — `metric_id` is read from source but never
// written: it referenced `metrics_v2`, an excluded telemetry table
// (SPEC §3.4's dropped-column note). `user_id` has no database FK in
// either schema but is still translated through `participantMap` (best-
// effort, nullable) since the §8.7 orphan gate checks it by column name.
async function loadSlotOutcomeReports(client, sourcePool, participantMap) {
  const columns = [
    'report_uid', 'chain_id', 'wallet_address', 'user_id', 'captured_at_ms', 'global_slot', 'epoch',
    'slot_in_epoch', 'slot_time_ms', 'outcome', 'outcome_reason', 'block_hash', 'block_height', 'canonical',
    'produced_at_ms', 'discarded_at_ms', 'node_slot_status', 'flow_outcome', 'flow_outcome_detail',
    'terminal_stage', 'discard_reason', 'empty_reason', 'block_injected_at_ms', 'flow_summary_at_ms',
    'build_ms', 'db_diff_ms', 'sign_ms', 'inject_ms', 'batch_fetch_ms', 'hydration_visible_ms', 'app_state',
    'network_type', 'network_connected', 'platform', 'platform_version', 'app_version', 'app_build_number',
    'battery_level', 'wakelock_held', 'foreground_service_running', 'alarm_scheduled_at_ms',
    'alarm_fired_at_ms', 'monitoring_started_at_ms', 'created_at', 'updated_at',
  ];
  for await (const rows of iterateSourceBatches(sourcePool, 'slot_outcome_reports', 1000)) {
    const batch = rows.map((row) => [
      row.report_uid, row.chain_id, row.wallet_address,
      row.participant_id != null ? participantMap.get(row.participant_id) ?? null : null,
      row.captured_at_ms, row.global_slot, row.epoch ?? null, row.slot_in_epoch ?? null, row.slot_time_ms ?? null,
      row.outcome, row.outcome_reason ?? null, row.block_hash ?? null, row.block_height ?? null,
      row.canonical ?? null, row.produced_at_ms ?? null, row.discarded_at_ms ?? null,
      row.node_slot_status ?? null, row.flow_outcome ?? null, row.flow_outcome_detail ?? null,
      row.terminal_stage ?? null, row.discard_reason ?? null, row.empty_reason ?? null,
      row.block_injected_at_ms ?? null, row.flow_summary_at_ms ?? null, row.build_ms ?? null,
      row.db_diff_ms ?? null, row.sign_ms ?? null, row.inject_ms ?? null, row.batch_fetch_ms ?? null,
      row.hydration_visible_ms ?? null, row.app_state ?? null, row.network_type ?? null,
      row.network_connected ?? null, row.platform ?? null, row.platform_version ?? null,
      row.app_version ?? null, row.app_build_number ?? null, row.battery_level ?? null,
      row.wakelock_held ?? null, row.foreground_service_running ?? null, row.alarm_scheduled_at_ms ?? null,
      row.alarm_fired_at_ms ?? null, row.monitoring_started_at_ms ?? null, row.created_at ?? null,
      row.updated_at ?? null,
    ]);
    await insertBatch(client, 'slot_outcome_reports', columns, batch, 1000);
  }
}

async function loadMobileLogs(client, sourcePool, participantMap) {
  const rows = await fetchAll(sourcePool, 'mobile_logs');
  const columns = ['user_id', 'payload', 'created_at', 'updated_at'];
  const batch = [];
  for (const row of rows) {
    const userId = participantMap.get(row.participant_id);
    if (userId === undefined) throw new Error(`mobile_logs: unmapped participant_id ${row.participant_id}`);
    batch.push([userId, row.payload ?? null, row.created_at ?? null, row.updated_at ?? null]);
  }
  await insertBatch(client, 'mobile_logs', columns, batch);
}

// `mobile_otp_codes` is deliberately NOT loaded here at all (SPEC §8.1:
// "schema only... migrating live login codes would be a security
// smell") — no load function exists for it; the §8.7 row-count gate
// asserts its target count is exactly 0.

async function loadAppVersionConfigs(client, sourcePool) {
  const rows = await fetchAll(sourcePool, 'app_version_configs');
  const columns = [
    'os', 'min_build_number', 'recommended_build_number', 'current_version', 'must_update_message',
    'is_active', 'created_at', 'updated_at', 'should_update_message', 'update_url',
  ];
  const batch = rows.map((row) => [
    row.os, row.min_build_number, row.recommended_build_number ?? null, row.current_version ?? null,
    row.must_update_message ?? null, row.is_active ?? true, row.created_at ?? null, row.updated_at ?? null,
    row.should_update_message ?? null, row.update_url ?? null,
  ]);
  await insertBatch(client, 'app_version_configs', columns, batch);
}

async function loadTermsVersions(client, sourcePool) {
  const rows = await fetchAll(sourcePool, 'terms_versions');
  const termsMap = new Map();
  for (const row of rows) {
    const targetId = await insertReturningId(client, 'terms_versions', {
      version: row.version,
      title: row.title,
      body_markdown: row.body_markdown,
      terms_link: row.terms_link ?? null,
      published_at: row.published_at ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    });
    termsMap.set(row.id, targetId);
  }
  await createMapTable(client, '_mig_map_terms_versions');
  await persistMapEntries(client, '_mig_map_terms_versions', [...termsMap.entries()]);
  return termsMap;
}

async function loadUserTermsConsents(client, sourcePool, participantMap, termsMap) {
  const rows = await fetchAll(sourcePool, 'participant_terms_consents');
  const columns = ['user_id', 'terms_version_id', 'status', 'responded_at', 'ip', 'app_version', 'created_at', 'updated_at'];
  const batch = [];
  for (const row of rows) {
    const userId = participantMap.get(row.participant_id);
    if (userId === undefined) throw new Error(`user_terms_consents: unmapped participant_id ${row.participant_id}`);
    const termsVersionId = termsMap.get(row.terms_version_id);
    if (termsVersionId === undefined) throw new Error(`user_terms_consents: unmapped terms_version_id ${row.terms_version_id}`);
    batch.push([
      userId, termsVersionId, row.status, row.responded_at, row.ip ?? null, row.app_version ?? null,
      row.created_at ?? null, row.updated_at ?? null,
    ]);
  }
  await insertBatch(client, 'user_terms_consents', columns, batch);
}

// ═════════════════════════════════════════════════════════════════════
// Orchestrator — SPEC §8.6 load order, verbatim
// ═════════════════════════════════════════════════════════════════════
async function runLoad(client, sourcePool, opts) {
  const summary = {};

  const { participantMap, userCount, sourceParticipantCount } = await loadUsers(client, sourcePool, opts);
  summary.users = { count: userCount, sourceParticipantCount };

  const seasonsMap = await loadSeasons(client, sourcePool);
  const { phasesMap, seasonEventToSeasonMap } = await loadSeasonEvents(client, sourcePool, seasonsMap);
  await loadUserEnrollments(client, sourcePool, participantMap, phasesMap, seasonEventToSeasonMap);

  const validKindIds = await loadChallengeKinds(client, sourcePool);
  const templatesMap = await loadChallengeTemplates(client, sourcePool, validKindIds);
  const { challengesMap, challengeToSeasonEvent } = await loadChallenges(
    client, sourcePool, phasesMap, templatesMap, validKindIds
  );

  const activitiesMap = await loadUserActivities(client, sourcePool, participantMap, phasesMap, challengesMap);
  summary.awards = await backfillAwards(
    client, sourcePool, participantMap, challengesMap, challengeToSeasonEvent, activitiesMap
  );

  await loadOnchainAccounts(client, sourcePool, participantMap, phasesMap, seasonEventToSeasonMap);
  await loadAccountDelegationPeriods(client, sourcePool);
  await loadLeaderboardSnapshots(client, sourcePool, participantMap, phasesMap, seasonsMap);
  await loadTokenAllocation(client, sourcePool, participantMap, seasonsMap);
  summary.settings = await foldPlatformSettings(client, sourcePool);
  await loadEpochStats(client, sourcePool, participantMap);
  await loadChains(client, sourcePool);
  summary.vrfObligationsCount = await loadVrfObligations(client, sourcePool);
  await loadVrfObligationsSyncState(client, sourcePool);
  await loadSlotOutcomeReports(client, sourcePool, participantMap);
  await loadMobileLogs(client, sourcePool, participantMap);
  await loadAppVersionConfigs(client, sourcePool);

  const termsMap = await loadTermsVersions(client, sourcePool);
  await loadUserTermsConsents(client, sourcePool, participantMap, termsMap);

  return summary;
}

// ═════════════════════════════════════════════════════════════════════
// CLI
// ═════════════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const has = (flag) => argv.includes(flag);
  const val = (name, def) => {
    const found = argv.find((a) => a.startsWith(`${name}=`));
    return found ? found.slice(name.length + 1) : def;
  };
  return {
    iHaveRestoredADump: has('--i-have-restored-a-dump'),
    validateOnly: has('--validate-only'),
    expectUsers: parseInt(val('--expect-users', '188'), 10),
    expectAwards: parseInt(val('--expect-awards', '131'), 10),
  };
}

// The hardened, read-only source pool — see the header comment for why
// both mechanisms exist. Exported so tests/topochain-load.test.js can
// assert the exact strings are present without duplicating them.
function makeSourcePool(connectionString) {
  // Mechanism #1, the standalone guarantee: the `options` connection
  // parameter is a Postgres startup-packet option, equivalent to
  // `psql -c`, so `default_transaction_read_only=on` is set by the
  // SERVER for this session before any query — even a bug in this file
  // that somehow ran a mutating statement would still be refused.
  // Mechanism #2, belt-and-braces: `onConnect` (pg-pool's own hook,
  // `node_modules/pg-pool/index.js`) runs before a newly-connected
  // client is EVER handed back to a caller — pg-pool awaits it and, if
  // it rejects, tears the client down and fails whatever was waiting on
  // it, so a failed SET here can never be silently swallowed the way an
  // unawaited `client.query()` on the 'connect' event would be.
  const pool = new Pool({
    connectionString,
    options: '-c default_transaction_read_only=on',
    onConnect: (client) => client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'),
  });
  return pool;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = process.env.TOPOCHAIN_SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;

  if (!targetUrl) {
    console.error('TARGET_DATABASE_URL is required.');
    process.exit(1);
  }
  if (!sourceUrl) {
    console.error('TOPOCHAIN_SOURCE_DATABASE_URL is required.');
    process.exit(1);
  }
  if (!args.iHaveRestoredADump) {
    console.error(
      'Refusing to start: pass --i-have-restored-a-dump to confirm TOPOCHAIN_SOURCE_DATABASE_URL points at a ' +
        'RESTORED DUMP in a scratch database — never the live topochain production database.'
    );
    process.exit(1);
  }

  const sourcePool = makeSourcePool(sourceUrl);
  const targetPool = new Pool({ connectionString: targetUrl });
  const client = await targetPool.connect();

  try {
    if (args.validateOnly) {
      await client.query('BEGIN READ ONLY');
      const { gates, allPass } = await runValidationGates({
        targetClient: client, sourcePool, expectUsers: args.expectUsers, expectAwards: args.expectAwards,
      });
      console.log(formatReport(gates));
      await client.query('COMMIT');
      process.exitCode = allPass ? 0 : 1;
      return;
    }

    if (await hasMigratedMarker(client)) {
      console.error(
        'Refusing to run: platform_settings already has topochain_migrated. The load has already completed once.'
      );
      process.exitCode = 1;
      return;
    }

    await client.query('BEGIN');
    try {
      log.info('topochain-load', 'Starting load', { expectUsers: args.expectUsers, expectAwards: args.expectAwards });
      const summary = await runLoad(client, sourcePool, { expectUsers: args.expectUsers });
      log.info('topochain-load', 'Load complete, running §8.7 validation gates', summary);

      const { gates, allPass } = await runValidationGates({
        targetClient: client, sourcePool, expectUsers: args.expectUsers, expectAwards: args.expectAwards,
      });
      console.log(formatReport(gates));

      if (!allPass) {
        await client.query('ROLLBACK');
        console.error('Validation failed — the entire load has been rolled back. The target database was not changed.');
        process.exitCode = 1;
        return;
      }

      await dropMapTables(client);
      await writeMigratedMarker(client);
      await client.query('COMMIT');
      console.log('Load committed. topochain_migrated marker written; _mig_map_* tables dropped.');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
    await targetPool.end();
    await sourcePool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  // Pure transforms
  normalizeEmail,
  mergeParticipants,
  rewritePasswordHash,
  deriveScopeColumns,
  buildBackfillMetadata,
  mapBackfillRow,
  findAwardBackfillCollisions,
  // DB-touching, exported for reuse/testing
  querySource,
  makeSourcePool,
  runLoad,
  runValidationGates,
  formatReport,
};
