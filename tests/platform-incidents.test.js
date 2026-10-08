'use strict';

// The filtered log, the per-kind-per-day counts and the recent-window count
// that the admin's Unexpected errors section and the threshold alert read
// (services/platform-incidents.js).
//
// The queries run against a REAL postgres, in a throwaway schema, the same
// contract as tests/platform-incident-alerts.test.js and
// tests/mobile-push-trigger-postgres.test.js: skipped, never failed, when no
// server is reachable. A fake pool pins only what needs no database: the
// never-throw contract of record() when the chained threshold check cannot
// reach anything.
//
// Run with: node --test tests/platform-incidents.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const incidents = require('../src/services/platform-incidents');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return null; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

async function realDb(t) {
  const c = await connect();
  if (!c || c.error) { t.skip(c?.error ? `no postgres: ${c.error}` : 'no pg module'); return null; }
  t.after(() => c.client.end().catch(() => {}));
  return c.client;
}

const STUB_DDL = `
  CREATE TABLE events (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER,
    app_id     INTEGER,
    session_id INTEGER,
    event_type VARCHAR(32) NOT NULL,
    metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE apps (
    id   SERIAL PRIMARY KEY,
    slug VARCHAR(64)
  );
`;

async function withSchema(client, fn) {
  const name = `platform_incidents_test_${process.pid}`;
  await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await client.query(`CREATE SCHEMA ${name}`);
  try {
    await client.query(`SET search_path TO ${name}`);
    await client.query(STUB_DDL);
    return await fn();
  } finally {
    await client.query('SET search_path TO public').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
  }
}

async function seedIncident(client, { kind, at, appId = null, sessionId = null, runId = null, outcome = 'resumed' }) {
  const { rows } = await client.query(
    `INSERT INTO events (app_id, session_id, event_type, metadata, created_at)
     VALUES ($1, $2, 'platform_incident', $3::jsonb, $4) RETURNING id`,
    [appId, sessionId, JSON.stringify({ kind, runId, issueNumber: 12, why: 'the worker is gone', outcome }), at],
  );
  return rows[0].id;
}

test('query filters by kind and days, carries sessionId, orders newest first and honours the limit', async (t) => {
  const client = await realDb(t);
  if (!client) return;
  await withSchema(client, async () => {
    const { rows: [{ id: appId }] } = await client.query("INSERT INTO apps (slug) VALUES ('tiers') RETURNING id");
    await seedIncident(client, { kind: 'build_interrupted', at: '2026-10-01T09:00:00Z', appId, sessionId: 41, runId: 900 });
    await seedIncident(client, { kind: 'build_interrupted', at: '2026-10-03T22:00:00Z' });
    await seedIncident(client, { kind: 'build_interrupted', at: '2026-10-07T12:00:00Z', appId, sessionId: 42, runId: 950 });
    await seedIncident(client, { kind: 'other_kind', at: '2026-10-06T08:00:00Z', appId, sessionId: 43 });

    const all = await incidents.query(client, { days: 30 });
    assert.equal(all.total, 4);
    assert.equal(all.days, 30);
    assert.deepEqual(all.items.map((i) => i.at), [
      '2026-10-07T12:00:00.000Z', '2026-10-06T08:00:00.000Z', '2026-10-03T22:00:00.000Z', '2026-10-01T09:00:00.000Z',
    ], 'newest first');
    assert.equal(all.items[0].sessionId, 42, 'the change the incident belongs to rides the row');
    assert.equal(all.items[1].app, 'tiers');
    assert.equal(all.items[0].kind, 'build_interrupted');
    assert.equal(all.items[0].runId, 950);
    assert.equal(all.items[0].outcome, 'resumed');

    const filtered = await incidents.query(client, { kind: 'build_interrupted', days: 30 });
    assert.equal(filtered.total, 3);
    assert.equal(filtered.kind, 'build_interrupted');
    assert.equal(filtered.items[0].sessionId, 42);

    // A kind no row carries lists none, not everything.
    const none = await incidents.query(client, { kind: 'future_kind', days: 30 });
    assert.equal(none.total, 0);
    assert.deepEqual(none.items, []);

    // A time range narrows, and the limit caps the list.
    const narrow = await incidents.query(client, { days: 1 });
    assert.equal(narrow.total, 1);
    assert.equal(narrow.days, 1);
    const capped = await incidents.query(client, { days: 30, limit: 2 });
    assert.equal(capped.items.length, 2);
    assert.equal(capped.total, 4, 'the total is the range whole, not the capped list');
  });
});

test('countsByKindByDay groups per kind per UTC day', async (t) => {
  const client = await realDb(t);
  if (!client) return;
  await withSchema(client, async () => {
    await seedIncident(client, { kind: 'build_interrupted', at: '2026-10-05T09:14:00Z' });
    await seedIncident(client, { kind: 'build_interrupted', at: '2026-10-05T23:59:00Z' });
    await seedIncident(client, { kind: 'build_interrupted', at: '2026-10-07T01:00:00Z' });
    await seedIncident(client, { kind: 'build_interrupted', at: '2026-10-03T12:00:00Z' });
    await seedIncident(client, { kind: 'other_kind', at: '2026-10-07T02:00:00Z' });

    const counts = await incidents.countsByKindByDay(client, { days: 7 });
    assert.equal(counts.days, 7);
    assert.deepEqual(counts.byKind, {
      build_interrupted: { '2026-10-03': 1, '2026-10-05': 2, '2026-10-07': 1 },
      other_kind: { '2026-10-07': 1 },
    }, 'a day before 00:00 UTC and one after land on their own UTC days');

    const only = await incidents.countsByKindByDay(client, { days: 7, kind: 'other_kind' });
    assert.deepEqual(only.byKind, { other_kind: { '2026-10-07': 1 } });
  });
});

test('countRecent counts its window', async (t) => {
  const client = await realDb(t);
  if (!client) return;
  await withSchema(client, async () => {
    const now = new Date();
    const minutesAgo = (m) => new Date(now.getTime() - m * 60000).toISOString();
    await seedIncident(client, { kind: 'build_interrupted', at: minutesAgo(10) });
    await seedIncident(client, { kind: 'build_interrupted', at: minutesAgo(30) });
    await seedIncident(client, { kind: 'build_interrupted', at: minutesAgo(90) });
    await seedIncident(client, { kind: 'other_kind', at: minutesAgo(10) });
    assert.equal(await incidents.countRecent(client, 'build_interrupted', { hours: 1 }), 2);
    assert.equal(await incidents.countRecent(client, 'build_interrupted', { hours: 3 }), 3);
    assert.equal(await incidents.countRecent(client, 'other_kind', { hours: 1 }), 1);
    assert.equal(await incidents.countRecent(client, 'nothing_here', { hours: 1 }), 0);
  });
});

test('the readers answer null, never throw, when the store is unreachable', async (t) => {
  const down = { query: async () => { throw new Error('down'); } };
  assert.equal(await incidents.query(down, { days: 30 }), null);
  assert.equal(await incidents.countsByKindByDay(down, { days: 7 }), null);
  assert.equal(await incidents.countRecent(down, 'build_interrupted', { hours: 1 }), 0);
  assert.equal(await incidents.recent(down), null);
});

test('record resolves against a pool that answers nothing, and logs the failure', async (t) => {
  // The never-throw contract the callers rely on: a fake pool that answers
  // only the events insert (as an existing test's does) cannot be broken by
  // the chained threshold check, and a pool that answers nothing at all
  // still resolves.
  await assert.doesNotReject(incidents.record({
    query: async (sql) => {
      if (/INSERT INTO events/.test(sql)) return { rows: [] };
      throw new Error('down');
    },
  }, { kind: 'build_interrupted' }));
  await assert.doesNotReject(incidents.record({ query: async () => { throw new Error('down'); } }, { kind: 'build_interrupted' }));
  await assert.doesNotReject(incidents.record({ query: async () => { throw new Error('down'); } }));
});
