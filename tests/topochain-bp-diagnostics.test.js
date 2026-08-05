// Privacy-safe block-production diagnostics admin endpoint.
//
// Run with: node --test tests/topochain-bp-diagnostics.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let currentPool;
// Admin subrouters capture the pool at construction time. Keep a stable
// proxy while allowing each test to install an isolated mock pool.
poolMod.getPool = () => ({ query: (...args) => currentPool.query(...args) });

const { topochainAdminRoutes } = require('../src/routes/topochain/admin');

const EVENT = {
  id: 42,
  name: 'Active Event',
  chain_id: 'chain-a, chain-b, chain-empty',
  start_epoch: 100,
  end_epoch: 110,
  starts_at: new Date('2026-08-01T00:00:00Z'),
  ends_at: new Date('2026-08-31T00:00:00Z'),
};

let aggregateRows;
let queries;

function makePool() {
  return {
    async query(rawSql, params = []) {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      queries.push({ sql, params });
      if (sql.includes('FROM season_events WHERE id = $1')) {
        return { rows: params[0] === EVENT.id ? [{ ...EVENT }] : [] };
      }
      if (sql.includes('FROM season_events') && sql.includes('is_active = TRUE')) {
        return { rows: [{ ...EVENT }] };
      }
      if (sql.includes('FROM epoch_stats')) return { rows: aggregateRows.map((row) => ({ ...row })) };
      throw new Error(`Unhandled query: ${sql}`);
    },
  };
}

let server;
let base;
let viewer = { id: 1, isAdmin: true, canAdminWrite: false };

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = viewer; next(); });
  app.use(topochainAdminRoutes({ databaseUrl: 'postgres://fake/fake' }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test.beforeEach(() => {
  queries = [];
  aggregateRows = [];
  currentPool = makePool();
  viewer = { id: 1, isAdmin: true, canAdminWrite: false };
});

async function get(path = '/api/v4/admin/block-production-diagnostics') {
  const endpoint = '/api/v4/admin/block-production-diagnostics';
  return fetch(base + (path.startsWith('?') ? endpoint + path : path));
}

test('non-admins are rejected by the existing v4 admin read gate', async () => {
  viewer = { id: 2, isAdmin: false, canAdminWrite: false };
  const res = await get();
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), {
    success: false,
    error: 'Unauthorized. Admin access required.',
  });
  assert.equal(queries.length, 0);
});

test('default selection uses the current active event and configured epoch bounds', async () => {
  aggregateRows = [{
    chain_id: 'chain-a', wallet_count: 5, epoch_wallet_rows: 10,
    first_epoch: 100, last_epoch: 110, won_slots: 20,
    produced_blocks: 15, canonical_blocks: 12, orphaned_blocks: 3,
    failed_blocks: 5, last_updated_at: new Date('2026-08-05T00:00:00Z'),
  }];
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.selection, 'latest_active_event');
  assert.deepEqual(body.data.event.chain_ids, ['chain-a', 'chain-b', 'chain-empty']);
  assert.equal(body.data.metric.numerator, 'sum(epoch_canonical_blocks)');
  assert.equal(body.data.metric.denominator, 'sum(epoch_won_slots)');
  assert.equal(body.data.metric.target, null);

  const aggregate = queries.find((q) => q.sql.includes('FROM epoch_stats'));
  assert.deepEqual(aggregate.params, [['chain-a', 'chain-b', 'chain-empty'], 100, 110]);
  assert.match(aggregate.sql, /chain_id = ANY\(\$1\) AND epoch >= \$2 AND epoch <= \$3/);

  const ready = body.data.cohorts[0];
  assert.equal(ready.status, 'ready');
  assert.equal(ready.canonical_success_rate, 60);
  assert.equal(ready.produced_success_rate, 75);
  assert.equal(ready.canonicality_rate, 80);
  assert.equal(ready.wallet_count, 5);
  assert.equal(body.data.cohorts[1].status, 'no_data');
  assert.equal(body.data.cohorts[2].status, 'no_data');
  assert.ok(!JSON.stringify(body).includes('wallet_address'));
  assert.ok(!JSON.stringify(body).includes('user_id'));
});

test('an explicit event is selected strictly and a missing event is a 404', async () => {
  const selected = await get('?season_event_id=42');
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).data.selection, 'explicit_event');
  const eventRead = queries.find((q) => q.sql.includes('WHERE id = $1'));
  assert.deepEqual(eventRead.params, [42]);

  const missing = await get('?season_event_id=99');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'Season event not found.');
  const malformed = await get('?season_event_id=42x');
  assert.equal(malformed.status, 422);
});

test('cohorts below five wallets expose no exact counts, rates, epochs, or freshness', async () => {
  aggregateRows = [{
    chain_id: 'chain-a', wallet_count: 4, epoch_wallet_rows: 999,
    first_epoch: 100, last_epoch: 110, won_slots: 99,
    produced_blocks: 90, canonical_blocks: 80, orphaned_blocks: 10,
    failed_blocks: 9, last_updated_at: new Date('2026-08-05T00:00:00Z'),
  }];
  const body = await (await get()).json();
  assert.deepEqual(body.data.cohorts[0], {
    chain_id: 'chain-a',
    status: 'suppressed',
    minimum_cohort_wallets: 5,
  });
});

test('zero denominators produce null rates and inconsistent totals carry quality flags', async () => {
  aggregateRows = [{
    chain_id: 'chain-a', wallet_count: 6, epoch_wallet_rows: 6,
    first_epoch: 100, last_epoch: 100, won_slots: 0,
    produced_blocks: 2, canonical_blocks: 3, orphaned_blocks: 0,
    failed_blocks: 1, last_updated_at: new Date('2026-08-05T00:00:00Z'),
  }];
  const cohort = (await (await get()).json()).data.cohorts[0];
  assert.equal(cohort.canonical_success_rate, null);
  assert.equal(cohort.produced_success_rate, null);
  assert.equal(cohort.canonicality_rate, 150);
  assert.deepEqual(cohort.quality_flags, [
    'produced_blocks_exceed_won_slots',
    'canonical_blocks_exceed_produced_blocks',
    'canonical_blocks_exceed_won_slots',
    'failed_blocks_exceed_won_slots',
  ]);
});

test('an event without a complete valid epoch range never triggers an all-history scan', async () => {
  const originalStart = EVENT.start_epoch;
  EVENT.start_epoch = null;
  try {
    const body = await (await get()).json();
    assert.equal(queries.some((q) => q.sql.includes('FROM epoch_stats')), false);
    assert.deepEqual(body.data.cohorts[0], {
      chain_id: 'chain-a',
      status: 'unavailable',
      reason: 'event_epoch_bounds_required',
    });
    assert.match(body.data.limitations.join(' '), /never trigger an all-history scan/i);
  } finally {
    EVENT.start_epoch = originalStart;
  }
});
