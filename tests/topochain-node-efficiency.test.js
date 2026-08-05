'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const TOKEN_HASH = hashToken('alice-token');
let summaryRow;
let summaryParams;
let failSummary;

function makeMockPool() {
  return {
    async query(rawSql, params = []) {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT t.id, t.user_id, t.ability, t.expires_at, u.username FROM mobile_auth_tokens')) {
        if (params[0] !== TOKEN_HASH) return { rows: [] };
        return {
          rows: [{
            id: 9,
            user_id: 41,
            ability: 'session',
            expires_at: new Date(Date.now() + 60000),
            username: 'alice',
          }],
        };
      }
      if (sql.startsWith('UPDATE mobile_auth_tokens SET last_used_at')) return { rows: [] };
      if (sql.startsWith('WITH scoped AS')) {
        summaryParams = params;
        if (failSummary) throw new Error('database unavailable');
        return { rows: [summaryRow] };
      }
      throw new Error(`Unhandled query: ${sql}`);
    },
  };
}

function withApp(fn) {
  const poolPath = require.resolve('../src/db/pool');
  const routePath = require.resolve('../src/routes/topochain/node-efficiency');
  const original = require.cache[poolPath];
  require.cache[poolPath] = {
    exports: { getPool: () => makeMockPool() },
    loaded: true,
    id: poolPath,
    filename: poolPath,
    paths: original ? original.paths : [],
  };
  delete require.cache[routePath];
  try {
    const { topochainNodeEfficiencyRoutes } = require('../src/routes/topochain/node-efficiency');
    const app = express();
    app.use(topochainNodeEfficiencyRoutes({}));
    return fn(app);
  } finally {
    if (original) require.cache[poolPath] = original;
    else delete require.cache[poolPath];
    delete require.cache[routePath];
  }
}

let server;
let base;

test.before(async () => {
  summaryRow = {};
  await withApp((app) => new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  }));
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test.beforeEach(() => {
  summaryParams = null;
  failSummary = false;
  summaryRow = {};
});

async function get(path, token = 'alice-token') {
  return fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

test('requires a mobile session token before reading private telemetry', async () => {
  const res = await get('/api/v4/mobile/me/node-efficiency', null);
  assert.equal(res.status, 401);
  assert.equal(summaryParams, null);
});

test('strictly validates the bounded measurement window', async () => {
  for (const value of ['0', '25', '168.0', 'all', '-24']) {
    const res = await get(`/api/v4/mobile/me/node-efficiency?window_hours=${value}`);
    assert.equal(res.status, 422, value);
  }
  assert.equal(summaryParams, null);
});

test('defaults to seven days and scopes the aggregate to the token user', async () => {
  const res = await get('/api/v4/mobile/me/node-efficiency');
  assert.equal(res.status, 200);
  assert.deepEqual(summaryParams, [41, 168]);
  const body = await res.json();
  assert.equal(body.data.window_hours, 168);
  assert.equal(body.data.production.reports, 0);
  assert.equal(body.data.production.reported_production_rate_percent, null);
  assert.deepEqual(body.data.battery, {
    sample_count: 0, min_percent: null, max_percent: null, latest_percent: null,
  });
});

test('returns stable units and correct aggregate math without raw telemetry', async () => {
  summaryRow = {
    report_count: '8', produced_count: '6', canonical_count: '5',
    battery_sample_count: '7', battery_min: 31, battery_max: 89, battery_latest: 72,
    wakelock_held_count: '3', foreground_service_count: '4', background_wakelock_count: '1',
    connected_count: '7', disconnected_count: '1', wifi_count: '4', cellular_count: '3', other_network_count: '1',
    alarm_lateness_p50: '120', alarm_lateness_p95: '900',
    build_p50: 20, build_p95: 45, db_diff_p50: 5, db_diff_p95: 11,
    sign_p50: 3, sign_p95: 8, inject_p50: 7, inject_p95: 15,
    batch_fetch_p50: 9, batch_fetch_p95: 21, hydration_visible_p50: 2, hydration_visible_p95: 4,
  };
  const res = await get('/api/v4/mobile/me/node-efficiency?window_hours=24');
  assert.equal(res.status, 200);
  assert.deepEqual(summaryParams, [41, 24]);
  const body = await res.json();
  assert.equal(body.data.source, 'device_reported');
  assert.equal(body.data.advisory, true);
  assert.equal(body.data.affects_rewards, false);
  assert.equal(body.data.telemetry_collection_changed, false);
  assert.equal(body.data.production.reported_production_rate_percent, 75);
  assert.deepEqual(body.data.timing_ms.alarm_lateness, { p50: 120, p95: 900 });
  assert.deepEqual(body.data.timing_ms.build, { p50: 20, p95: 45 });

  const serialized = JSON.stringify(body);
  for (const privateField of ['wallet_address', 'chain_id', 'report_uid', 'outcome_reason', 'flow_outcome_detail', 'captured_at_ms']) {
    assert.doesNotMatch(serialized, new RegExp(privateField));
  }
  assert.doesNotMatch(serialized, /token|currency|cost_estimate/i);
});

test('returns a generic 500 when the aggregate query fails', async () => {
  failSummary = true;
  const res = await get('/api/v4/mobile/me/node-efficiency?window_hours=720');
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { success: false, error: 'Internal server error.' });
});

test('schema has a partial user/time index for bounded private aggregation', () => {
  const schema = require('fs').readFileSync(require('path').join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.match(schema, /idx_slot_outcome_reports_user_captured[\s\S]*\(user_id, captured_at_ms DESC\)[\s\S]*WHERE user_id IS NOT NULL/);
});

test('aggregate query is user-scoped, bounded, and does not materialize private free-text columns', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../src/routes/topochain/node-efficiency.js'),
    'utf8'
  );
  assert.match(source, /WHERE user_id = \$1[\s\S]*captured_at_ms >=/);
  assert.doesNotMatch(source, /WITH scoped AS \(\s*SELECT \*/);
  assert.doesNotMatch(source, /SELECT[^;]*outcome_reason|SELECT[^;]*flow_outcome_detail/);
});
