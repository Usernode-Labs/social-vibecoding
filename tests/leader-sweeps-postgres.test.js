'use strict';

// The durable sweep clock (src/services/leader-timers.js dueInMs/recordRun)
// against a REAL postgres, using the leader_sweeps DDL exactly as
// src/db/schema.sql declares it.
//
// tests/leader-timers.test.js drives the scheduling with a stand-in pool;
// this runs the two statements themselves: the due time is computed from
// the database's clock on both sides (so a pod's clock cannot move it), is
// never negative, never more than one interval, and the record is an
// upsert one row per sweep. The DDL is applied twice: schema.sql runs on
// every boot, so it must be idempotent.
//
// Skips when no postgres is reachable (TEST_DATABASE_URL, else
// DATABASE_URL, else localhost).
//
// Run with: node --test tests/leader-sweeps-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { dueInMs, recordRun } = require('../src/services/leader-timers');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const DDL = (() => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS leader_sweeps');
  if (start < 0) throw new Error('leader_sweeps is not in schema.sql any more');
  return schema.slice(start, schema.indexOf(';', start) + 1);
})();

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

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test('leader_sweeps: due times by the database clock, and an upserted record', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  const schemaName = `leader_sweeps_test_${process.pid}`;
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}`);
    await client.query(DDL);
    await client.query(DDL); // every boot applies it again

    assert.equal(await dueInMs(client, 'stale-pr-sweep', HOUR), 0, 'never ran: due at once');

    await recordRun(client, 'stale-pr-sweep');
    const justRan = await dueInMs(client, 'stale-pr-sweep', HOUR);
    assert.ok(justRan > HOUR - 5000 && justRan <= HOUR, `just ran: due in an interval (${justRan}ms)`);

    await client.query(`UPDATE leader_sweeps SET last_run_at = NOW() - INTERVAL '50 minutes' WHERE name = 'stale-pr-sweep'`);
    const tenLeft = await dueInMs(client, 'stale-pr-sweep', HOUR);
    assert.ok(Math.abs(tenLeft - 10 * MIN) < 5000, `ran 50 minutes ago: due in ten (${tenLeft}ms)`);

    await client.query(`UPDATE leader_sweeps SET last_run_at = NOW() - INTERVAL '3 hours' WHERE name = 'stale-pr-sweep'`);
    assert.equal(await dueInMs(client, 'stale-pr-sweep', HOUR), 0, 'overdue: due at once, never negative');

    await client.query(`UPDATE leader_sweeps SET last_run_at = NOW() + INTERVAL '5 hours' WHERE name = 'stale-pr-sweep'`);
    assert.equal(await dueInMs(client, 'stale-pr-sweep', HOUR), HOUR, 'a clock gone wrong waits one interval at most');

    await recordRun(client, 'stale-pr-sweep');
    await recordRun(client, 'workshop-theme-sweep');
    const { rows } = await client.query('SELECT name, last_run_at > NOW() - INTERVAL \'1 minute\' AS fresh FROM leader_sweeps ORDER BY name');
    assert.deepEqual(rows, [
      { name: 'stale-pr-sweep', fresh: true },
      { name: 'workshop-theme-sweep', fresh: true },
    ], 'one row per sweep, overwritten by each completed run');
  } finally {
    await client.query('SET search_path TO public').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }
});
