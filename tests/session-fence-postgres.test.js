'use strict';

// #6002 against the full PostgreSQL schema: a signed-out page's anonymous
// report through the real route is stored with no account and only route
// templates, the platform signal's SQL reads it back, and the Journey's
// invite funnel counts the landings beside unchanged opens. Runs when
// TEST_DATABASE_URL is set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';

test('an anonymous report is stored with no account, read by the signal and the Journey', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'session_fence_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  await pool.query(read('src/db/schema.sql'));
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  const { uiTelemetryRoutes } = require('../src/routes/ui-telemetry');
  const app = express();
  app.get('/api/public/invites/:token', (_req, res) => res.end());
  app.use(uiTelemetryRoutes({ databaseUrl: String(url) }, { pool }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  let n = 0;
  const visit = (v) => `visit-test-${String(v).padStart(12, '0')}`;
  const ev = (v, over) => ({ id: `event-test-${crypto.randomBytes(8).toString('hex')}`, visitId: visit(v),
    screen: 'shell_boot', occurredAt: new Date().toISOString(), sequence: ++n, build: 'abcdef1234', ...over });
  const post = (events) => fetch(`${base}/api/ui-telemetry/anonymous`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ schemaVersion: 2, batchId: `batch-test-${crypto.randomBytes(8).toString('hex')}`, events,
      delivery: { failedBatches: 0, droppedEvents: 0 } }),
  });
  const fence = { path: '/api/public/invites/<token>', reason: 'epoch', public: true, count: 2 };
  for (const v of [1, 2]) {
    const res = await post([ev(v, { kind: 'session_fence', signedIn: false, fences: [fence] }),
      ev(v, { kind: 'invite_settlement', settled: 'failed' })]);
    assert.equal(res.status, 202, await res.text());
  }
  const res3 = await post([ev(3, { kind: 'invite_settlement', settled: 'failed' })]);
  assert.equal(res3.status, 202);
  // Refused: a signed-in report, and a path with its code still in it.
  assert.equal((await post([ev(4, { kind: 'session_fence', signedIn: true, fences: [fence] })])).status, 400);
  assert.equal((await post([ev(4, { kind: 'session_fence', signedIn: false,
    fences: [{ ...fence, path: `/api/public/invites/${TOKEN}` }] })])).status, 400);
  // A request from another site never reaches the collector.
  const cross = await fetch(`${base}/api/ui-telemetry/anonymous`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' });
  assert.equal(cross.status, 403);

  const { rows } = await pool.query(
    `SELECT user_id, metadata FROM events WHERE event_type = 'ui_experience' ORDER BY id`);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.user_id === null), 'no account on any row');
  assert.deepEqual(rows[0].metadata.fences, [{ path: '/api/public/invites/:token', reason: 'epoch', public: true, count: 2 }]);
  assert.equal(JSON.stringify(rows).includes(TOKEN), false);
  const receipts = await pool.query(`SELECT COUNT(*)::int AS n FROM events WHERE event_type = 'ui_telemetry_delivery'`);
  assert.equal(receipts.rows[0].n, 0, 'an anonymous report keeps no delivery receipt');

  // Every report above came from one address: one source, so nothing files,
  // whatever visit ids the page said.
  const sources = await pool.query(
    `SELECT COUNT(DISTINCT metadata->>'source')::int AS n, bool_and(metadata->>'source' ~ '^[0-9a-f]{16}$') AS ok
       FROM events WHERE event_type = 'ui_experience'`);
  assert.deepEqual(sources.rows[0], { n: 1, ok: true });
  const fences = require('../src/services/signal-observers/session-fences');
  assert.deepEqual(await fences.run(pool), [], 'one source files nothing');

  // Many addresses across one IPv6 /48 are still one more source: with the
  // route's own, two, and nothing files.
  const telemetry = require('../src/services/ui-telemetry');
  const anonymous = async (ip, v) => {
    const batch = telemetry.parseAnonymousBatch({ schemaVersion: 2, batchId: `batch-test-${crypto.randomBytes(8).toString('hex')}`,
      events: [ev(v, { kind: 'session_fence', signedIn: false, fences: [fence] }),
        ev(v, { kind: 'invite_settlement', settled: 'failed' })],
      delivery: { failedBatches: 0, droppedEvents: 0 } }, { routes: ['/api/public/invites/:token'] });
    await telemetry.insertBatch(pool, null, batch, { receipt: false, source: telemetry.anonymousSource(ip) });
  };
  for (let i = 1; i <= 8; i += 1) await anonymous(`2001:db8:0:${(i * 256).toString(16)}::${i}`, 100 + i);
  assert.deepEqual(await fences.run(pool), [], 'eight /56s of one /48 are one source');

  // Two more networks make four sources, all anonymous: not enough. A fifth files both.
  for (const ip of ['198.51.100.1', '198.51.100.2']) {
    await anonymous(ip, ip.length);
  }
  assert.deepEqual(await fences.run(pool), [], 'four anonymous sources are not enough');
  await anonymous('203.0.113.50', 200);
  const items = await fences.run(pool);
  assert.deepEqual(items.map((i) => [i.kind, i.key]).sort(),
    [['invite_pitch_failed', 'invite'], ['session_fence_public', '/api/public/invites/:token']]);

  const journey = require('../src/services/journey');
  await pool.query(`INSERT INTO events (event_type, metadata, created_at)
    VALUES ('invite_signed_in', '{}'::jsonb, NOW() - interval '2 days')`);
  const funnel = await pool.query(journey.INVITE_FUNNEL_SQL,
    [new Date(Date.now() - 7 * 86400000), new Date(Date.now() + 60000), [], []]);
  const week = { start: new Date(Date.now() - 7 * 86400000), end: new Date(Date.now() + 60000) };
  const reading = journey.inviteFunnelReading(funnel.rows[0], { week });
  assert.deepEqual(reading.landed, { card: 0, dead: 0, failed: 5, timeout: 0 },
    'each source once: the route\'s address, the /48 and three more networks, not the 14 reports');

  // Saturation: fifty old reports of another route, three days back, do not
  // push the last hour out of a capped read. The newest are read first.
  await pool.query(
    `INSERT INTO events (user_id, event_type, metadata, created_at)
     SELECT NULL, 'ui_experience', jsonb_build_object('kind', 'session_fence', 'visitId', 'visit-old-' || g,
              'source', 'old' || g, 'signedIn', false,
              'fences', jsonb_build_array(jsonb_build_object('path', '/api/public/apps', 'reason', 'epoch', 'public', true, 'count', 1))),
            NOW() - interval '3 days'
       FROM generate_series(1, 50) g`);
  const capped = await fences.run(pool, { rowLimit: 20 });
  assert.ok(capped.some((i) => i.key === '/api/public/invites/:token'), 'the last hour survives the row cap');

  // A source stores at most its day's share, whatever the limiter let in.
  const four = telemetry.parseAnonymousBatch({ schemaVersion: 2, batchId: `batch-test-${crypto.randomBytes(8).toString('hex')}`,
    events: [1, 2, 3, 4].map((v) => ev(300 + v, { kind: 'invite_settlement', settled: 'card' })),
    delivery: { failedBatches: 0, droppedEvents: 0 } });
  assert.deepEqual(await telemetry.insertAnonymous(pool, four, { source: 'cap-test', max: 3 }), { accepted: 3, capped: true });
  const again = { ...four, events: four.events.map((e) => ({ ...e, eventId: `${e.eventId}-again` })) };
  assert.deepEqual(await telemetry.insertAnonymous(pool, again, { source: 'cap-test', max: 3 }), { accepted: 0, capped: true });

  // The cap counts the server's receipt time: reports all backdated to 23
  // hours ago still fill it, and are stored as received now.
  const backdated = new Date(Date.now() - 23 * 3600 * 1000).toISOString();
  const old = (k) => telemetry.parseAnonymousBatch({ schemaVersion: 2, batchId: `batch-test-${crypto.randomBytes(8).toString('hex')}`,
    events: [1, 2, 3, 4].map((v) => ev(400 + k * 10 + v, { kind: 'invite_settlement', settled: 'card', occurredAt: backdated })),
    delivery: { failedBatches: 0, droppedEvents: 0 } });
  assert.deepEqual(await telemetry.insertAnonymous(pool, old(1), { source: 'backdate-test', max: 3 }), { accepted: 3, capped: true });
  assert.deepEqual(await telemetry.insertAnonymous(pool, old(2), { source: 'backdate-test', max: 3 }), { accepted: 0, capped: true });
  const stored = await pool.query(
    `SELECT created_at > NOW() - interval '1 minute' AS now_ish, metadata->>'occurredAt' AS occurred
       FROM events WHERE metadata->>'source' = 'backdate-test'`);
  assert.equal(stored.rows.length, 3);
  assert.ok(stored.rows.every((r) => r.now_ish && r.occurred === backdated), 'received now, the page\'s time in the payload');
  await pool.query(`DELETE FROM events WHERE metadata->>'source' = 'backdate-test'`);

  // Retention: anonymous reports past 30 days go, the rest stay.
  await pool.query(`UPDATE events SET created_at = NOW() - interval '40 days' WHERE metadata->>'source' = 'cap-test'`);
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM events WHERE event_type = 'ui_experience'`)).rows[0].n;
  assert.deepEqual(await telemetry.pruneAnonymous(pool), { pruned: 3 });
  const after = (await pool.query(`SELECT COUNT(*)::int AS n FROM events WHERE event_type = 'ui_experience'`)).rows[0].n;
  assert.equal(after, before - 3);

  // The limiter answers before any body is read (a malformed body past the
  // limit is a 429, never a 400), and its log names no address.
  const log = require('../src/services/logger');
  const logged = [];
  const realWarn = log.warn;
  log.warn = (...args) => { logged.push(args); };
  try {
    let status = 0;
    for (let i = 0; i < 8 && status !== 429; i += 1) {
      status = (await fetch(`${base}/api/ui-telemetry/anonymous`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{not json' })).status;
    }
    assert.equal(status, 429);
  } finally {
    log.warn = realWarn;
  }
  const throttle = logged.find(([scope, what]) => scope === 'rate-limit' && what === 'Throttled');
  assert.ok(throttle, 'the throttle was logged');
  assert.equal('ip' in throttle[2], false, 'without an address');
  assert.equal(JSON.stringify(logged).includes('127.0.0.1'), false);
});
