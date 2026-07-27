// Topochain v4 ingest API (plan Task 7; SPEC §4.4, lines 842-848/1454-1586).
//
// HTTP-level tests against a throwaway express app + a regex-dispatching
// mock pool (same idiom as tests/topochain-partner-api.test.js), extended
// with two small in-memory "tables" (`makeUpsertTable`) that parse the
// actual generated SQL (column list + ON CONFLICT target) so the tests can
// assert real upsert/sparse-update/rollback *behavior*, not just that a
// query was issued. This is deliberately not a stub that always returns
// success — it re-derives table state from the SQL text the route module
// produces, so a bug in the column list or conflict target shows up as a
// failing assertion here rather than only in a live database.
//
// Run with: node --test tests/topochain-ingest-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// ─── Fixture data (GET /onchain-accounts) ────────────────────────────────
//
// Event 5 and event 10 both list "chainA" in their comma-separated
// chain_id column (event 10 also lists chainB) — this is deliberate, to
// prove the deterministic id-ASC winner (SPEC 1481). Event 20 also
// matches "chainC" but is inactive, so it must never be picked.
const SEASON_EVENTS = [
  { id: 5, season_id: 50, chain_id: 'chainA', is_active: true },
  { id: 10, season_id: 60, chain_id: 'chainA,chainB', is_active: true },
  { id: 20, season_id: 70, chain_id: 'chainC', is_active: false },
];

// pk-event5-a: event-scoped to event 5. pk-event5-b: season-wide grant on
// season 50 (season_event_id null) — still resolves under event 5 via the
// same nullable-event-scope fallback onchain_accounts uses elsewhere.
// pk-event10-a: scoped to event 10, must NOT appear when event 5 wins.
const ONCHAIN_ACCOUNTS = [
  { public_key: 'pk-event5-a', season_event_id: 5, season_id: 50 },
  { public_key: 'pk-event5-b', season_event_id: null, season_id: 50 },
  { public_key: 'pk-event10-a', season_event_id: 10, season_id: 60 },
];

// pk-event5-a is a currently-active VRF participant on chainA; pk-event5-b
// has a vrf_obligations row but active_participant=false; pk-event10-a has
// no vrf_obligations row at all (EXISTS -> false, i.e. "no").
const VRF_OBLIGATIONS = [
  { chain_id: 'chainA', sender_pk_hash: 'pk-event5-a', active_participant: true },
  { chain_id: 'chainA', sender_pk_hash: 'pk-event5-b', active_participant: false },
];

function resolveEvent(chainId) {
  return SEASON_EVENTS
    .filter((e) => e.is_active && e.chain_id.split(',').map((c) => c.trim()).includes(chainId))
    .sort((a, b) => a.id - b.id)[0];
}

// ─── Generic in-memory upsert table, driven by the route's own SQL text ──
//
// Parses `INSERT INTO <table> (col1, col2, …, created_at, updated_at)
// VALUES ($1, $2, …, NOW(), NOW()) ON CONFLICT (k1, k2, …) DO UPDATE SET
// …` — i.e. exactly the shape both ingest.js upsert builders produce — so
// the mock reflects whatever column list/conflict target the route
// actually generated, including the sparse (row-varying) list epoch-stats
// builds per row. `notNullCols` simulates the real schema's NOT NULL
// constraint (judgment call #3 in ingest.js: an explicit null bound to one
// of these throws, exactly like Postgres would). `defaults` seed a
// brand-new row before the bound columns are applied, mirroring the
// schema's own `DEFAULT 0` for counters that a sparse insert never
// mentions.
function makeUpsertTable({ notNullCols = [], defaults = {} } = {}) {
  let committed = new Map();
  let pending = null;
  const insertSqls = [];

  function parseColumns(sql) {
    const m = /INSERT INTO \w+ \(([^)]+)\)/.exec(sql);
    return m[1].split(',').map((s) => s.trim());
  }
  function parseConflictTarget(sql) {
    const m = /ON CONFLICT \(([^)]+)\)/.exec(sql);
    return m ? m[1].split(',').map((s) => s.trim()) : [];
  }

  return {
    begin() { pending = new Map(committed); },
    commit() { committed = pending; pending = null; },
    rollback() { pending = null; },
    insert(sql, params) {
      insertSqls.push(collapse(sql));
      const target = pending || committed;
      const cols = parseColumns(sql);
      const conflictCols = parseConflictTarget(sql);
      // Only the first `params.length` columns are bound placeholders —
      // the trailing `created_at, updated_at` are literal NOW(), never params.
      const boundCols = cols.slice(0, params.length);
      const bound = {};
      boundCols.forEach((c, i) => { bound[c] = params[i]; });

      for (const c of notNullCols) {
        if (Object.prototype.hasOwnProperty.call(bound, c) && bound[c] === null) {
          throw new Error(`null value in column "${c}" violates not-null constraint`);
        }
      }

      const key = conflictCols.map((c) => bound[c]).join('||');
      const existing = target.get(key);
      const base = existing || { ...defaults };
      target.set(key, { ...base, ...bound });
    },
    rows() { return Array.from((pending || committed).values()); },
    insertSqls,
    reset() { committed = new Map(); pending = null; insertSqls.length = 0; },
  };
}

let slotTable;
let epochTable;

function resetFixtures() {
  slotTable = makeUpsertTable({ notNullCols: ['report_uid', 'chain_id', 'wallet_address', 'captured_at_ms', 'global_slot', 'outcome'] });
  epochTable = makeUpsertTable({
    notNullCols: ['chain_id', 'epoch', 'wallet_address', 'epoch_won_slots', 'epoch_produced_blocks', 'epoch_canonical_blocks', 'epoch_orphaned_blocks', 'epoch_failed_blocks'],
    defaults: { epoch_won_slots: 0, epoch_produced_blocks: 0, epoch_canonical_blocks: 0, epoch_orphaned_blocks: 0, epoch_failed_blocks: 0, user_id: null },
  });
}

// ─── logger spy (dropped-ids logging assertion) ──────────────────────────
const logger = require('../src/services/logger');
let warnCalls;
const originalWarn = logger.warn;

// ─── Mock pool ────────────────────────────────────────────────────────────

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);

  if (sql === 'BEGIN') { slotTable.begin(); epochTable.begin(); return { rows: [] }; }
  if (sql === 'COMMIT') { slotTable.commit(); epochTable.commit(); return { rows: [] }; }
  if (sql === 'ROLLBACK') { slotTable.rollback(); epochTable.rollback(); return { rows: [] }; }

  // GET /onchain-accounts: active-event resolution.
  if (sql.startsWith('SELECT id, season_id FROM season_events WHERE is_active = TRUE')) {
    const event = resolveEvent(params[0]);
    return { rows: event ? [{ id: event.id, season_id: event.season_id }] : [] };
  }

  // GET /onchain-accounts: account list + vrf-derived activeParticipant.
  if (sql.startsWith('SELECT oa.public_key,')) {
    const [chainId, eventId, seasonId] = params;
    const rows = ONCHAIN_ACCOUNTS
      .filter((a) => a.season_event_id === eventId || (a.season_event_id === null && a.season_id === seasonId))
      .map((a) => {
        const vrf = VRF_OBLIGATIONS.find((v) => v.chain_id === chainId && v.sender_pk_hash === a.public_key);
        return { public_key: a.public_key, active_participant: !!(vrf && vrf.active_participant) };
      });
    return { rows };
  }

  if (sql.startsWith('INSERT INTO slot_outcome_reports')) {
    // Sentinel used by the rollback test below to simulate a real write
    // failure (e.g. a constraint violation) partway through a batch.
    if (params.includes('FORCE_DB_ERROR')) throw new Error('simulated write failure');
    slotTable.insert(rawSql, params);
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO epoch_stats')) {
    epochTable.insert(rawSql, params);
    return { rows: [] };
  }

  throw new Error(`Unhandled mock query: ${sql}`);
}

function makeMockPool() {
  return {
    query: async (sql, params) => handleQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => handleQuery(sql, params),
      release: () => {},
    }),
  };
}

// ─── Test app wiring (require.cache pool swap, mirrors topochain-partner-api.test.js) ─

function withMockPool(config, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const ingestModulePath = require.resolve('../src/routes/topochain/ingest');
  const mockPool = makeMockPool();
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => mockPool },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  delete require.cache[ingestModulePath];
  try {
    const { topochainIngestRoutes } = require('../src/routes/topochain/ingest');
    const app = express();
    app.use(express.json());
    app.use(topochainIngestRoutes(config));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[ingestModulePath];
  }
}

let server;
let base;

function startServer(config) {
  return new Promise((resolve) => {
    withMockPool(config, (app) => {
      server = app.listen(0);
      server.once('listening', () => resolve());
    });
  });
}

test.before(async () => {
  await startServer({ databaseUrl: 'postgres://fake/fake' });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => {
  resetFixtures();
  warnCalls = [];
  logger.warn = (...args) => warnCalls.push(args);
});

test.afterEach(() => { logger.warn = originalWarn; });

test.after(() => server && server.close());

async function get(path) {
  return fetch(`${base}${path}`);
}
async function postJson(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── __ping ───────────────────────────────────────────────────────────────

test('__ping responds 200 unauthenticated', async () => {
  const res = await fetch(`${base}/api/v4/ingest/__ping`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
});

// ─── GET /onchain-accounts ────────────────────────────────────────────────

test('GET /onchain-accounts: missing chainId -> 422', async () => {
  const res = await get('/api/v4/onchain-accounts');
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(body.details.chainId);
});

test('GET /onchain-accounts: no active event -> 404, message normalized to error envelope, event vocabulary', async () => {
  const res = await get('/api/v4/onchain-accounts?chainId=chainZ');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { success: false, error: 'No active event found for the given chainId.' });
  assert.ok(!('message' in body));
});

test('GET /onchain-accounts: inactive event with a matching chain_id is never picked -> 404', async () => {
  const res = await get('/api/v4/onchain-accounts?chainId=chainC');
  assert.equal(res.status, 404);
});

test('GET /onchain-accounts: multiple active events match -> deterministic lowest-id winner', async () => {
  const res = await get('/api/v4/onchain-accounts?chainId=chainA');
  assert.equal(res.status, 200);
  const body = await res.json();
  const pubKeys = body.data.map((d) => d.pubKey).sort();
  // Event 5 wins (lower id) over event 10, even though both list chainA.
  assert.deepEqual(pubKeys, ['pk-event5-a', 'pk-event5-b']);
});

test('GET /onchain-accounts: pubKey/activeParticipant shape, yes/no strings, no pagination, no secret_key', async () => {
  const res = await get('/api/v4/onchain-accounts?chainId=chainA');
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(!('meta' in body));
  const byKey = Object.fromEntries(body.data.map((d) => [d.pubKey, d]));
  assert.equal(byKey['pk-event5-a'].activeParticipant, 'yes');
  assert.equal(byKey['pk-event5-b'].activeParticipant, 'no');
  for (const row of body.data) {
    assert.deepEqual(Object.keys(row).sort(), ['activeParticipant', 'pubKey']);
  }
});

test('GET /onchain-accounts: event-scoped chainB match returns only event 10 accounts', async () => {
  const res = await get('/api/v4/onchain-accounts?chainId=chainB');
  const body = await res.json();
  assert.deepEqual(body.data.map((d) => d.pubKey), ['pk-event10-a']);
  // Not in vrf_obligations at all -> "no".
  assert.equal(body.data[0].activeParticipant, 'no');
});

// ─── POST /slot-outcomes ──────────────────────────────────────────────────

function slotOutcome(overrides = {}) {
  return {
    id: 'report-1',
    captured_at_ms: 1000,
    global_slot: 42,
    outcome: 'produced',
    chain_id: 'chainA',
    wallet_address: 'wallet-1',
    ...overrides,
  };
}

test('POST /slot-outcomes: bare array shape', async () => {
  const res = await postJson('/api/v4/slot-outcomes', [slotOutcome()]);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
});

test('POST /slot-outcomes: single object shape (detected by its id key)', async () => {
  const res = await postJson('/api/v4/slot-outcomes', slotOutcome());
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
});

test('POST /slot-outcomes: envelope {slot_outcomes: [...]} shape', async () => {
  const res = await postJson('/api/v4/slot-outcomes', { slot_outcomes: [slotOutcome()] });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
});

test('POST /slot-outcomes: neither array nor id-bearing object -> 422 array-required', async () => {
  const res = await postJson('/api/v4/slot-outcomes', { foo: 'bar' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details.slot_outcomes);
});

test('POST /slot-outcomes: batch over 200 -> 422, nothing written', async () => {
  const batch = Array.from({ length: 201 }, (_, i) => slotOutcome({ id: `r${i}` }));
  const res = await postJson('/api/v4/slot-outcomes', batch);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details.slot_outcomes);
  assert.equal(slotTable.rows().length, 0);
});

test('POST /slot-outcomes: per-row validation uses dotted-path keys', async () => {
  const res = await postJson('/api/v4/slot-outcomes', [slotOutcome({ outcome: undefined }), slotOutcome({ id: 'r2', global_slot: -1 })]);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details['slot_outcomes.0.outcome']);
  assert.ok(body.details['slot_outcomes.1.global_slot']);
});

test('POST /slot-outcomes: row missing chain_id or wallet_address passes validation but is dropped, counted, and logged', async () => {
  const res = await postJson('/api/v4/slot-outcomes', [
    slotOutcome({ id: 'keep-1' }),
    slotOutcome({ id: 'drop-1', chain_id: undefined }),
    slotOutcome({ id: 'drop-2', wallet_address: undefined }),
  ]);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
  assert.equal(body.dropped, 2);
  assert.equal(slotTable.rows().length, 1);

  assert.equal(warnCalls.length, 1);
  const [, , ctx] = warnCalls[0];
  assert.deepEqual(ctx.reportUids.sort(), ['drop-1', 'drop-2']);
});

test('POST /slot-outcomes: in-batch dedup on (chain_id, wallet_address, id) is last-wins, applied before writing', async () => {
  const res = await postJson('/api/v4/slot-outcomes', [
    slotOutcome({ outcome: 'first' }),
    slotOutcome({ outcome: 'second' }), // same id/chain_id/wallet_address
  ]);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1, 'dedup collapses to a single stored row, not 2');
  const rows = slotTable.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'second', 'last row in the batch wins');
});

test('POST /slot-outcomes: upsert conflict target is (chain_id, wallet_address, report_uid), id renamed', async () => {
  await postJson('/api/v4/slot-outcomes', [slotOutcome()]);
  assert.equal(slotTable.insertSqls.length, 1);
  assert.match(slotTable.insertSqls[0], /ON CONFLICT \(chain_id, wallet_address, report_uid\) DO UPDATE SET/);
  const rows = slotTable.rows();
  assert.equal(rows[0].report_uid, 'report-1');
});

test('POST /slot-outcomes: participant_id maps to user_id column', async () => {
  await postJson('/api/v4/slot-outcomes', [slotOutcome({ participant_id: 7 })]);
  assert.equal(slotTable.rows()[0].user_id, 7);
});

test('POST /slot-outcomes: unknown keys are silently ignored', async () => {
  const res = await postJson('/api/v4/slot-outcomes', [slotOutcome({ this_key_does_not_exist: 'whatever' })]);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
});

test('POST /slot-outcomes: write failure rolls back the whole batch -> 500 with the normalized error body, no id field', async () => {
  const res = await postJson('/api/v4/slot-outcomes', [
    slotOutcome({ id: 'ok-1' }),
    slotOutcome({ id: 'ok-2', outcome: 'FORCE_DB_ERROR', wallet_address: 'wallet-2' }),
  ]);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, { success: false, error: 'Failed to store slot outcomes' });
  assert.ok(!('id' in body));
  // Row 1 was written to the pending map before row 2 threw; ROLLBACK must
  // discard it too — nothing from this batch should have persisted.
  assert.equal(slotTable.rows().length, 0);
});

test('POST /slot-outcomes: response is 201 {success, message, stored, dropped} with no id field', async () => {
  const res = await postJson('/api/v4/slot-outcomes', [slotOutcome()]);
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(body).sort(), ['dropped', 'message', 'stored', 'success']);
  assert.equal(body.message, 'Slot outcomes stored successfully');
});

// ─── POST /epoch-stats ────────────────────────────────────────────────────

function epochStat(overrides = {}) {
  return {
    chain_id: 'chainA',
    wallet_address: 'wallet-1',
    epoch: 1,
    ...overrides,
  };
}

test('POST /epoch-stats: bare array shape', async () => {
  const res = await postJson('/api/v4/epoch-stats', [epochStat()]);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
});

test('POST /epoch-stats: single object shape (any object without an epoch_stats key is wrapped)', async () => {
  const res = await postJson('/api/v4/epoch-stats', epochStat());
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
});

test('POST /epoch-stats: envelope {epoch_stats: [...]} shape', async () => {
  const res = await postJson('/api/v4/epoch-stats', { epoch_stats: [epochStat()] });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
});

test('POST /epoch-stats: epoch_stats key present but not an array -> 422', async () => {
  const res = await postJson('/api/v4/epoch-stats', { epoch_stats: 'nope' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details.epoch_stats);
});

test('POST /epoch-stats: batch over 200 -> 422, nothing written', async () => {
  const batch = Array.from({ length: 201 }, () => epochStat());
  const res = await postJson('/api/v4/epoch-stats', batch);
  assert.equal(res.status, 422);
  assert.equal(epochTable.rows().length, 0);
});

test('POST /epoch-stats: per-row validation uses dotted-path keys', async () => {
  const res = await postJson('/api/v4/epoch-stats', [epochStat({ epoch: -1 }), epochStat({ epoch_won_slots: -5 })]);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details['epoch_stats.0.epoch']);
  assert.ok(body.details['epoch_stats.1.epoch_won_slots']);
});

test('POST /epoch-stats: rows dropped when chain_id or wallet_address missing, or epoch is null; epoch 0 is valid', async () => {
  const res = await postJson('/api/v4/epoch-stats', [
    epochStat({ epoch: 0 }), // kept: 0 is a valid epoch
    epochStat({ chain_id: undefined }), // dropped
    epochStat({ wallet_address: undefined }), // dropped
    epochStat({ epoch: null }), // dropped
  ]);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
  assert.equal(body.dropped, 3);
});

test('POST /epoch-stats: sparse-update SQL only mentions counters actually present on the row', async () => {
  await postJson('/api/v4/epoch-stats', [epochStat({ epoch_won_slots: 5 })]);
  const sql = epochTable.insertSqls[0];
  assert.match(sql, /epoch_won_slots/);
  assert.doesNotMatch(sql, /epoch_produced_blocks/);
  assert.doesNotMatch(sql, /epoch_canonical_blocks/);
});

test('POST /epoch-stats: an omitted counter keeps its stored value across two sparse writes; insert defaults to 0', async () => {
  await postJson('/api/v4/epoch-stats', [epochStat({ epoch: 9, epoch_won_slots: 4 })]);
  let row = epochTable.rows().find((r) => r.epoch === 9);
  assert.equal(row.epoch_won_slots, 4);
  assert.equal(row.epoch_produced_blocks, 0, 'insert defaults the never-mentioned counter to 0');

  // Second write to the same key mentions only epoch_produced_blocks.
  await postJson('/api/v4/epoch-stats', [epochStat({ epoch: 9, epoch_produced_blocks: 7 })]);
  row = epochTable.rows().find((r) => r.epoch === 9);
  assert.equal(row.epoch_produced_blocks, 7, 'newly-written counter applied');
  assert.equal(row.epoch_won_slots, 4, 'first write is preserved — sparse update never touched it');
});

test('POST /epoch-stats: upsert key is (chain_id, epoch, wallet_address)', async () => {
  await postJson('/api/v4/epoch-stats', [epochStat()]);
  assert.match(epochTable.insertSqls[0], /ON CONFLICT \(chain_id, epoch, wallet_address\) DO UPDATE SET/);
});

test('POST /epoch-stats: participant_id maps to user_id column', async () => {
  await postJson('/api/v4/epoch-stats', [epochStat({ participant_id: 3 })]);
  assert.equal(epochTable.rows()[0].user_id, 3);
});

test('POST /epoch-stats: in-batch duplicates are NOT pre-deduped — both count toward stored, last write wins in the table', async () => {
  const res = await postJson('/api/v4/epoch-stats', [
    epochStat({ epoch_won_slots: 1 }),
    epochStat({ epoch_won_slots: 9 }), // same (chain_id, epoch, wallet_address)
  ]);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  // Opposite of slot-outcomes: no pre-dedup, so both write attempts count.
  assert.equal(body.stored, 2);
  const rows = epochTable.rows();
  assert.equal(rows.length, 1, 'sequential upserts still collapse to one final row');
  assert.equal(rows[0].epoch_won_slots, 9, 'second (later) write wins');
});

test('POST /epoch-stats: explicit null on a present counter deterministically 500s (NOT NULL column), whole batch rolls back', async () => {
  const res = await postJson('/api/v4/epoch-stats', [
    epochStat({ epoch: 2, epoch_won_slots: 1 }), // would succeed alone
    epochStat({ epoch: 3, epoch_won_slots: null }), // explicit null -> NOT NULL violation
  ]);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, { success: false, error: 'Failed to store epoch stats' });
  // Row 1 (epoch 2) must be rolled back along with row 2's failure — the
  // whole transaction is one unit.
  assert.equal(epochTable.rows().find((r) => r.epoch === 2), undefined);
});

test('POST /epoch-stats: omitting a counter entirely (vs explicit null) passes validation and never touches the DB column', async () => {
  const res = await postJson('/api/v4/epoch-stats', [epochStat({ epoch: 4 })]); // no counters mentioned at all
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.stored, 1);
  const sql = epochTable.insertSqls[epochTable.insertSqls.length - 1];
  assert.doesNotMatch(sql, /epoch_won_slots/);
});

test('POST /epoch-stats: response is 201 {success, message, stored, dropped}', async () => {
  const res = await postJson('/api/v4/epoch-stats', [epochStat()]);
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(body).sort(), ['dropped', 'message', 'stored', 'success']);
  assert.equal(body.message, 'Epoch stats stored successfully');
});
