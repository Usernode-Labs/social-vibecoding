// Topochain v4 — ingest (SPEC §4.4, lines 842-848 for the group, 1454-1586
// for the three endpoints' exact contracts, 883-895 for the §4.8 contract
// deltas every v4 route applies, 2932 for the "no carrier row / no id"
// resolution carried over from §4.10).
//
// Mounted in server.js BEFORE authMiddleware, alongside public.js and
// partner.js: every route here is PUBLIC (SPEC: "Auth: none") — these are
// chain-side/backoffice telemetry callers, not browser sessions or partner
// API-key holders, so unlike partner.js there is no auth middleware to
// apply at all.
//
// Judgment calls made here where the spec text was ambiguous (documented
// inline at the point of use, flagged again in the task report):
//   1. GET /onchain-accounts's `activeParticipant` has no derivation rule
//      anywhere in SPEC 1454-1481 beyond "the string yes/no" — the response
//      shape is given, not its source column. `onchain_accounts` itself has
//      no such flag. The chosen source is `vrf_obligations.active_participant`
//      (SPEC 577-618, read during Task 1's schema work), matched on
//      `vrf_obligations.chain_id = chainId AND vrf_obligations.sender_pk_hash
//      = onchain_accounts.public_key`: the naming is an exact match (down to
//      camelCase/snake_case) with a column that already means "this VRF
//      sender is presently an active participant", `sender_pk_hash` is the
//      hashed form of the same VRF-side key `onchain_accounts.public_key`
//      documents itself as (see that table's schema.sql comment), and this
//      whole router's other two endpoints (slot-outcomes, epoch-stats) are
//      the write side of the same chain-telemetry surface this read serves —
//      i.e. this is the natural "read back what the chain told us" endpoint.
//   2. The 404 body's message text (SPEC 1478: `"No active phase found for
//      the given chainId."`) uses source vocabulary ("phase"). Every other
//      404 in this migration (public.js, partner.js) already speaks in the
//      renamed "event" vocabulary per §4.8 rule 1's phase->event rename map,
//      so the text here is carried over with that one word swapped —
//      "No active event found for the given chainId." — keeping the rest of
//      the sentence and the `message`-key quirk normalized into the v4
//      `error` envelope (`fail()`), per the task brief.
//   3. POST /epoch-stats's "explicit null 500s the NOT NULL column" quirk
//      (SPEC 1585) is preserved by NOT special-casing it in application
//      code: a counter key that is present on the payload row (even with a
//      literal `null` value) is included in the dynamic sparse-update SQL
//      exactly like any other present counter (see `isPresentKey` /
//      `buildEpochStatsUpsert` below), so the bound parameter really is SQL
//      NULL against a `NOT NULL DEFAULT 0` column. Real Postgres rejects
//      that at INSERT time exactly as the source system did, rolling back
//      the transaction into the standard `Failed to store epoch stats` 500 —
//      deterministic because it's the database's own constraint doing the
//      enforcing, not a coin flip in app code. The committed mock-pool test
//      simulates that same NOT NULL rejection to prove the path
//      deterministically without a live database.
//   4. Both batch endpoints write with one query per row inside a single
//      transaction (BEGIN/…/COMMIT, ROLLBACK on any failure) rather than one
//      bulk multi-row INSERT. This is what makes epoch-stats' per-row sparse
//      column list possible at all (each row can omit different counters),
//      and keeps slot-outcomes' failure mode simple (any row's error rolls
//      back everything written so far in the same transaction) — matching
//      "the whole batch rolls back" (SPEC 1541) without relying on a single
//      giant statement.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { ok, fail } = require('./helpers');

// ─── Body-shape detection (SPEC 1490, 1560) ──────────────────────────────
//
// Both batch endpoints accept three shapes, but the "is this actually one
// bare object, not a batch" test differs per endpoint — transcribed
// verbatim from each endpoint's own spec text rather than shared, since
// unifying them would paper over a real difference (see each function's
// comment).

// slot-outcomes (SPEC 1490): "a bare JSON array … a single outcome object
// (detected by its `id` key), or an envelope {"slot_outcomes": [...]}".
// Detection order: array > explicit envelope > single-object-with-id.
// Anything else (e.g. an object with neither key) returns null, which the
// route below turns into the standard "must be an array" 422.
function extractSlotOutcomesBatch(body) {
  if (Array.isArray(body)) return body;
  if (body !== null && typeof body === 'object') {
    if (Array.isArray(body.slot_outcomes)) return body.slot_outcomes;
    if (Object.prototype.hasOwnProperty.call(body, 'id')) return [body];
  }
  return null;
}

// epoch-stats (SPEC 1560): "a bare array, a single object (any object
// without an `epoch_stats` key is wrapped), or {"epoch_stats": [...]}".
// Read literally: presence of the `epoch_stats` key is itself the test —
// if present (even with a non-array value, which the array/max validation
// below then rejects), its value is the batch; otherwise the whole body
// is wrapped as a single-row batch. This is deliberately NOT keyed off any
// field inside the object (unlike slot-outcomes' `id` key), matching the
// spec's own wording.
function extractEpochStatsBatch(body) {
  if (Array.isArray(body)) return body;
  if (body !== null && typeof body === 'object') {
    if (Object.prototype.hasOwnProperty.call(body, 'epoch_stats')) return body.epoch_stats;
    return [body];
  }
  return null;
}

const MAX_BATCH = 200;

// ─── Generic per-row validator (dotted-path errors, SPEC 1490/1560's own error tables) ─
//
// Shared by both endpoints: each field spec is `{ field, type, required?,
// min?, max?, maxLen? }`. A field that is absent OR explicitly null OR ''
// is treated as "not provided" — required fields error, optional fields are
// silently skipped (this is what lets slot-outcomes' `chain_id`/
// `wallet_address` and epoch-stats' explicit-null counters pass validation
// per SPEC's own "optional in validation" / "passes validation" language,
// while the *write* step's presence test below is intentionally stricter —
// see judgment call #3).
function validateBatchRows(batch, fields, prefix) {
  const details = {};
  batch.forEach((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      details[`${prefix}.${i}`] = ['The given data was invalid.'];
      return;
    }
    for (const f of fields) {
      const v = row[f.field];
      const provided = v !== undefined && v !== null && v !== '';
      if (!provided) {
        if (f.required) details[`${prefix}.${i}.${f.field}`] = [`The ${f.field} field is required.`];
        continue;
      }
      if (f.type === 'string') {
        if (typeof v !== 'string') {
          details[`${prefix}.${i}.${f.field}`] = [`The ${f.field} field must be a string.`];
        } else if (f.maxLen && v.length > f.maxLen) {
          details[`${prefix}.${i}.${f.field}`] = [`The ${f.field} field must not be greater than ${f.maxLen} characters.`];
        }
      } else if (f.type === 'int') {
        const n = Number(v);
        const isBlankString = typeof v === 'string' && v.trim() === '';
        if (typeof v === 'boolean' || isBlankString || !Number.isInteger(n)) {
          details[`${prefix}.${i}.${f.field}`] = [`The ${f.field} field must be an integer.`];
        } else {
          if (f.min !== undefined && n < f.min) details[`${prefix}.${i}.${f.field}`] = [`The ${f.field} field must be at least ${f.min}.`];
          if (f.max !== undefined && n > f.max) details[`${prefix}.${i}.${f.field}`] = [`The ${f.field} field must not be greater than ${f.max}.`];
        }
      } else if (f.type === 'bool') {
        if (typeof v !== 'boolean') details[`${prefix}.${i}.${f.field}`] = [`The ${f.field} field must be a boolean.`];
      }
    }
  });
  return details;
}

// Value -> bound SQL param, matching validateBatchRows' notion of "not
// provided" (undefined/null/'' -> SQL NULL).
function coerce(v, type) {
  if (v === undefined || v === null || v === '') return null;
  if (type === 'int') return Number(v);
  if (type === 'bool') return !!v;
  return String(v);
}

// ─── POST /slot-outcomes: field spec (SPEC 1490-1520, transcribed in table order) ─
//
// `column: null` marks the three fields handled specially by the route
// (id -> report_uid rename; chain_id/wallet_address are conflict-key
// columns AND the silent-drop trigger, not part of the generic mutable
// column list built from this array).
const SLOT_OUTCOME_FIELDS = [
  { field: 'id', column: null, type: 'string', required: true, maxLen: 64 },
  { field: 'captured_at_ms', column: 'captured_at_ms', type: 'int', required: true, min: 0 },
  { field: 'global_slot', column: 'global_slot', type: 'int', required: true, min: 0 },
  { field: 'outcome', column: 'outcome', type: 'string', required: true, maxLen: 32 },
  { field: 'chain_id', column: null, type: 'string', maxLen: 64 },
  { field: 'wallet_address', column: null, type: 'string' },
  { field: 'participant_id', column: 'user_id', type: 'int', min: 1 },
  { field: 'epoch', column: 'epoch', type: 'int', min: 0 },
  { field: 'slot_in_epoch', column: 'slot_in_epoch', type: 'int', min: 0 },
  { field: 'slot_time_ms', column: 'slot_time_ms', type: 'int', min: 0 },
  { field: 'outcome_reason', column: 'outcome_reason', type: 'string' },
  { field: 'block_hash', column: 'block_hash', type: 'string' },
  { field: 'block_height', column: 'block_height', type: 'int', min: 0 },
  { field: 'canonical', column: 'canonical', type: 'bool' },
  { field: 'produced_at_ms', column: 'produced_at_ms', type: 'int', min: 0 },
  { field: 'discarded_at_ms', column: 'discarded_at_ms', type: 'int', min: 0 },
  { field: 'node_slot_status', column: 'node_slot_status', type: 'string', maxLen: 16 },
  { field: 'flow_outcome', column: 'flow_outcome', type: 'string', maxLen: 64 },
  { field: 'flow_outcome_detail', column: 'flow_outcome_detail', type: 'string' },
  { field: 'terminal_stage', column: 'terminal_stage', type: 'string', maxLen: 32 },
  { field: 'discard_reason', column: 'discard_reason', type: 'string' },
  { field: 'empty_reason', column: 'empty_reason', type: 'string' },
  { field: 'block_injected_at_ms', column: 'block_injected_at_ms', type: 'int', min: 0 },
  { field: 'flow_summary_at_ms', column: 'flow_summary_at_ms', type: 'int', min: 0 },
  { field: 'build_ms', column: 'build_ms', type: 'int', min: 0 },
  { field: 'db_diff_ms', column: 'db_diff_ms', type: 'int', min: 0 },
  { field: 'sign_ms', column: 'sign_ms', type: 'int', min: 0 },
  { field: 'inject_ms', column: 'inject_ms', type: 'int', min: 0 },
  { field: 'batch_fetch_ms', column: 'batch_fetch_ms', type: 'int', min: 0 },
  { field: 'hydration_visible_ms', column: 'hydration_visible_ms', type: 'int', min: 0 },
  { field: 'app_state', column: 'app_state', type: 'string', maxLen: 32 },
  { field: 'network_type', column: 'network_type', type: 'string', maxLen: 32 },
  { field: 'network_connected', column: 'network_connected', type: 'bool' },
  { field: 'platform', column: 'platform', type: 'string', maxLen: 32 },
  { field: 'platform_version', column: 'platform_version', type: 'string' },
  { field: 'app_version', column: 'app_version', type: 'string' },
  { field: 'app_build_number', column: 'app_build_number', type: 'string' },
  { field: 'battery_level', column: 'battery_level', type: 'int', min: 0, max: 100 },
  { field: 'wakelock_held', column: 'wakelock_held', type: 'bool' },
  { field: 'foreground_service_running', column: 'foreground_service_running', type: 'bool' },
  { field: 'alarm_scheduled_at_ms', column: 'alarm_scheduled_at_ms', type: 'int', min: 0 },
  { field: 'alarm_fired_at_ms', column: 'alarm_fired_at_ms', type: 'int', min: 0 },
  { field: 'monitoring_started_at_ms', column: 'monitoring_started_at_ms', type: 'int', min: 0 },
];
const SLOT_OUTCOME_MUTABLE = SLOT_OUTCOME_FIELDS.filter((f) => f.column);
const SLOT_OUTCOME_COLUMNS = ['report_uid', 'chain_id', 'wallet_address', ...SLOT_OUTCOME_MUTABLE.map((f) => f.column)];

// Full-row upsert (SPEC: "Upsert on (chain_id, wallet_address, report_uid) —
// re-posting the same report id overwrites the stored row"). Unlike
// epoch-stats, slot-outcomes has no sparse-update rule — every mutable
// column is written every time, so this SQL is a fixed constant built once
// at module load rather than assembled per row.
const SLOT_OUTCOME_INSERT_SQL = `
  INSERT INTO slot_outcome_reports (${SLOT_OUTCOME_COLUMNS.join(', ')}, created_at, updated_at)
  VALUES (${SLOT_OUTCOME_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')}, NOW(), NOW())
  ON CONFLICT (chain_id, wallet_address, report_uid) DO UPDATE SET
    ${SLOT_OUTCOME_MUTABLE.map((f) => `${f.column} = EXCLUDED.${f.column}`).join(', ')},
    updated_at = NOW()
`;

function slotOutcomeParams(row) {
  return [
    String(row.id),
    row.chain_id,
    row.wallet_address,
    ...SLOT_OUTCOME_MUTABLE.map((f) => coerce(row[f.field], f.type)),
  ];
}

// ─── POST /epoch-stats: field spec + sparse-update query builder (SPEC 1560-1583) ─
const EPOCH_STATS_FIELDS = [
  { field: 'chain_id', type: 'string', maxLen: 64 },
  { field: 'wallet_address', type: 'string' },
  { field: 'epoch', type: 'int', min: 0 },
  { field: 'participant_id', type: 'int', min: 1 },
  { field: 'epoch_won_slots', type: 'int', min: 0 },
  { field: 'epoch_produced_blocks', type: 'int', min: 0 },
  { field: 'epoch_canonical_blocks', type: 'int', min: 0 },
  { field: 'epoch_orphaned_blocks', type: 'int', min: 0 },
  { field: 'epoch_failed_blocks', type: 'int', min: 0 },
];
const EPOCH_STATS_COUNTERS = ['epoch_won_slots', 'epoch_produced_blocks', 'epoch_canonical_blocks', 'epoch_orphaned_blocks', 'epoch_failed_blocks'];

// A payload key counts as "present" for sparse-update purposes if the key
// exists on the row at all — deliberately including an explicit `null`
// (judgment call #3), which is a stricter test than validateBatchRows'
// "provided" (which excludes null/''). This IS the sparse-update mechanism:
// an omitted counter is never mentioned in the generated SQL at all, so on
// UPDATE it keeps its stored value and on INSERT it falls through to the
// column's own `DEFAULT 0` (SPEC: "An omitted counter keeps its stored
// value; on insert it defaults to 0").
function isKeyPresent(row, field) {
  return Object.prototype.hasOwnProperty.call(row, field);
}

// Builds one row's INSERT .. ON CONFLICT statement from only the counters
// (and user_id, same treatment) actually present on that row — this is
// what makes the sparse update possible: a counter absent from `row` never
// appears in the column list, VALUES list, or ON CONFLICT SET clause.
function buildEpochStatsUpsert(row) {
  const hasUserId = isKeyPresent(row, 'participant_id');
  const presentCounters = EPOCH_STATS_COUNTERS.filter((c) => isKeyPresent(row, c));

  const dynamicCols = [...(hasUserId ? ['user_id'] : []), ...presentCounters];
  const cols = ['chain_id', 'epoch', 'wallet_address', ...dynamicCols];
  const values = [
    row.chain_id,
    coerce(row.epoch, 'int'),
    row.wallet_address,
    ...(hasUserId ? [coerce(row.participant_id, 'int')] : []),
    ...presentCounters.map((c) => coerce(row[c], 'int')),
  ];
  const placeholders = values.map((_, i) => `$${i + 1}`);
  const setClause = dynamicCols.length
    ? `${dynamicCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = NOW()`
    : 'updated_at = NOW()';

  const sql = `
    INSERT INTO epoch_stats (${cols.join(', ')}, created_at, updated_at)
    VALUES (${placeholders.join(', ')}, NOW(), NOW())
    ON CONFLICT (chain_id, epoch, wallet_address) DO UPDATE SET ${setClause}
  `;
  return { sql, values };
}

// ─── Router ───────────────────────────────────────────────────────────

function topochainIngestRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Mount-order probe (plan Task 3), kept as-is per the Task 7 brief.
  router.get('/api/v4/ingest/__ping', (_req, res) => ok(res, {}));

  // ── GET /onchain-accounts (SPEC 1454-1483, v2 GET /onchain-accounts) ─
  router.get('/api/v4/onchain-accounts', async (req, res) => {
    try {
      const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
      if (!chainId) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { chainId: ['The chainId field is required.'] },
        });
      }

      // SPEC 1481: "scanning active events for one whose chain_id list
      // (comma-separated) contains the value. With multiple matches the
      // winner is non-deterministic — v4 should order explicitly." id ASC
      // is the explicit, deterministic tiebreak chosen here. Each list
      // element is trimmed so "a, b" and "a,b" resolve identically.
      const { rows: eventRows } = await pool.query(
        `SELECT id, season_id
           FROM season_events
          WHERE is_active = TRUE
            AND chain_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM unnest(string_to_array(chain_id, ',')) AS cid
               WHERE trim(cid) = $1
            )
          ORDER BY id ASC
          LIMIT 1`,
        [chainId]
      );
      const event = eventRows[0];
      // SPEC 1478's `message`-key body is normalized into the v4 `error`
      // envelope; judgment call #2 swaps "phase" -> "event" in the sentence
      // to match this migration's renamed vocabulary everywhere else.
      if (!event) return fail(res, 404, 'No active event found for the given chainId.');

      // Judgment call #1: `activeParticipant` sourced from
      // `vrf_obligations.active_participant` keyed on the same chainId and
      // the account's VRF-side public key. No filtering on podium exclusion
      // or `user_id` — SPEC 1483: "Returns every account for the event,
      // deliberately including podium-excluded users"; `secret_key` is
      // never selected.
      const { rows: acctRows } = await pool.query(
        `SELECT oa.public_key,
                EXISTS (
                  SELECT 1 FROM vrf_obligations vo
                   WHERE vo.chain_id = $1
                     AND vo.sender_pk_hash = oa.public_key
                     AND vo.active_participant = TRUE
                ) AS active_participant
           FROM onchain_accounts oa
          WHERE oa.season_event_id = $2 OR (oa.season_event_id IS NULL AND oa.season_id = $3)`,
        [chainId, event.id, event.season_id]
      );

      const data = acctRows.map((r) => ({
        pubKey: r.public_key,
        activeParticipant: r.active_participant ? 'yes' : 'no',
      }));

      return ok(res, { data });
    } catch (err) {
      log.error('topochain-ingest', 'GET /onchain-accounts failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /slot-outcomes (SPEC 1485-1546, v2 POST /slot_outcomes) ────
  router.post('/api/v4/slot-outcomes', async (req, res) => {
    try {
      const batch = extractSlotOutcomesBatch(req.body);
      if (!Array.isArray(batch)) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { slot_outcomes: ['The slot_outcomes field is required and must be an array.'] },
        });
      }
      if (batch.length > MAX_BATCH) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { slot_outcomes: ['The slot_outcomes field must not have more than 200 items.'] },
        });
      }

      const details = validateBatchRows(batch, SLOT_OUTCOME_FIELDS, 'slot_outcomes');
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      // SPEC 1541: rows missing chain_id/wallet_address pass validation
      // (both are optional-in-validation) but are silently dropped and
      // counted; v4 additionally logs which report ids (the `id` field,
      // renamed report_uid on write) were dropped.
      const droppedIds = [];
      const kept = [];
      for (const row of batch) {
        if (!row.chain_id || !row.wallet_address) {
          droppedIds.push(row.id);
          continue;
        }
        kept.push(row);
      }
      if (droppedIds.length) {
        log.warn('topochain-ingest', 'POST /slot-outcomes dropped rows missing chain_id/wallet_address', {
          reportUids: droppedIds,
        });
      }

      // SPEC 1545: "Duplicate ids within one batch currently cause a 500 on
      // PostgreSQL … v4 should de-duplicate server-side." Last-wins,
      // applied BEFORE writing (unlike epoch-stats below, which relies on
      // sequential per-row upserts instead — see that route's own comment).
      const dedup = new Map();
      for (const row of kept) {
        // `::` is not a valid character in any of chain_id/wallet_address/id
        // per their own maxLen/charset expectations in practice, so a
        // plain-concatenated key would be ambiguous (e.g. chain_id="a",
        // wallet_address="b c" colliding with chain_id="a b",
        // wallet_address="c") — this separator keeps the three parts
        // distinguishable.
        dedup.set(`${row.chain_id}::${row.wallet_address}::${row.id}`, row);
      }
      const toWrite = Array.from(dedup.values());

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          for (const row of toWrite) {
            await client.query(SLOT_OUTCOME_INSERT_SQL, slotOutcomeParams(row));
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      } finally {
        client.release();
      }

      // SPEC 2932/1537: v4 drops both the source's `metrics_v2` carrier
      // row write and the response's `id` field entirely.
      return ok(res.status(201), {
        message: 'Slot outcomes stored successfully',
        stored: toWrite.length,
        dropped: droppedIds.length,
      });
    } catch (err) {
      log.error('topochain-ingest', 'POST /slot-outcomes failed', { message: err.message });
      // SPEC 1546: `{"error": "Failed to store slot outcomes"}` normalized
      // into the v4 envelope, message text kept verbatim.
      return fail(res, 500, 'Failed to store slot outcomes');
    }
  });

  // ── POST /epoch-stats (SPEC 1548-1586, v2 POST /epoch_stats) ────────
  router.post('/api/v4/epoch-stats', async (req, res) => {
    try {
      const batch = extractEpochStatsBatch(req.body);
      if (!Array.isArray(batch)) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { epoch_stats: ['The epoch_stats field is required and must be an array.'] },
        });
      }
      if (batch.length > MAX_BATCH) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { epoch_stats: ['The epoch_stats field must not have more than 200 items.'] },
        });
      }

      const details = validateBatchRows(batch, EPOCH_STATS_FIELDS, 'epoch_stats');
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      // SPEC 1583: rows dropped (silently, counted, not logged per-row —
      // unlike slot-outcomes there is no natural per-row id to log) when
      // chain_id or wallet_address is missing, or epoch is null/absent.
      // `epoch === 0` is explicitly valid (SPEC: "0 is valid"), so the
      // check is against null/absent, never falsy.
      const dropped = [];
      const kept = [];
      for (const row of batch) {
        const epochProvided = isKeyPresent(row, 'epoch') && row.epoch !== null && row.epoch !== '';
        if (!row.chain_id || !row.wallet_address || !epochProvided) {
          dropped.push(row);
          continue;
        }
        kept.push(row);
      }

      // SPEC 1586: "Rows are written one at a time inside a single
      // transaction, so duplicates within a batch are safe here (last one
      // wins) — the opposite of slot outcomes." No pre-dedup: every kept
      // row gets its own upsert, executed in order, so a later duplicate
      // key naturally overwrites an earlier one via ON CONFLICT.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          for (const row of kept) {
            const { sql, values } = buildEpochStatsUpsert(row);
            await client.query(sql, values);
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      } finally {
        client.release();
      }

      // SPEC 1580: no carrier row and no `id` field here either — unlike
      // slot-outcomes, the source never wrote one for this endpoint.
      return ok(res.status(201), {
        message: 'Epoch stats stored successfully',
        stored: kept.length,
        dropped: dropped.length,
      });
    } catch (err) {
      log.error('topochain-ingest', 'POST /epoch-stats failed', { message: err.message });
      // SPEC 1586: `{"error": "Failed to store epoch stats"}` normalized
      // into the v4 envelope, message text kept verbatim. This is also the
      // observable outcome of judgment call #3 (explicit-null counter hits
      // the real NOT NULL constraint and rolls back into this same 500).
      return fail(res, 500, 'Failed to store epoch stats');
    }
  });

  return router;
}

module.exports = { topochainIngestRoutes };
