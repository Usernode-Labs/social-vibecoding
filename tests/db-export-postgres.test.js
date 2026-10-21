'use strict';

// A database export's claim and its download ticket, kept on its own
// db_exports row (services/db-export.js), against the full PostgreSQL
// schema: one dump at a time on any process, a dump whose process went away
// released once its heartbeat lapses, a boot that leaves a live dump on
// another process alone, and a ticket issued by one process redeemed by
// another, once, by its own admin. Both were in one process's memory.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/db-export-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('an export is claimed and ticketed on its row, wherever it is asked', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'db_export_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  // Two processes: two pools on one database.
  const one = new Pool({ connectionString: String(url), max: 4 });
  const two = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await one.end();
    await two.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await one.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const dbExport = require('../src/services/db-export');

  const { rows: [u] } = await one.query(`INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id`);
  const { rows: [v] } = await one.query(`INSERT INTO users (username, password) VALUES ('bob', 'x') RETURNING id`);
  const request = async (userId) => (await one.query(
    `INSERT INTO db_exports (user_id, username, db_name, status, ip) VALUES ($1, 'x', 'usernode', 'requested', '203.0.113.5') RETURNING id`,
    [userId])).rows[0].id;
  const row = async (id) => (await one.query('SELECT status, ticket_hash, error FROM db_exports WHERE id = $1', [id])).rows[0];

  // A ticket issued by one process is redeemed by another, by its admin, once.
  const first = await request(u.id);
  const { token } = await dbExport.issueTicket(one, { auditId: first });
  assert.notEqual((await row(first)).ticket_hash, token, 'only its hash is kept');
  assert.equal(await dbExport.consumeTicket(two, token, v.id), null, 'not another admin\'s');
  const ticket = await dbExport.consumeTicket(two, token, u.id);
  assert.deepEqual(ticket, { auditId: Number(first), userId: u.id, ip: '203.0.113.5', dbName: 'usernode' });
  assert.equal(await dbExport.consumeTicket(one, token, u.id), null, 'single use');

  // One dump at a time across processes.
  const claim = await dbExport.beginExport(two, first);
  assert.equal(claim.claimed, true);
  t.after(() => claim.end());
  assert.equal(await dbExport.isExportInProgress(one), true, 'seen from the other process');
  const second = await request(v.id);
  assert.deepEqual(await dbExport.beginExport(one, second), { claimed: false, reason: 'in_progress' });
  assert.equal((await row(second)).status, 'requested', 'still waiting for its download');

  // A boot leaves the live dump alone.
  assert.equal(await dbExport.settleAbandoned(one), 0);
  assert.equal((await row(first)).status, 'streaming');

  // Its process went away: once the heartbeat lapses, the next claim settles
  // it and takes the dump.
  claim.end();
  await one.query(`UPDATE db_exports SET heartbeat_at = NOW() - interval '10 minutes' WHERE id = $1`, [first]);
  assert.equal(await dbExport.isExportInProgress(one), false);
  const next = await dbExport.beginExport(one, second);
  assert.equal(next.claimed, true);
  next.end();
  assert.deepEqual(await row(first), { status: 'interrupted', ticket_hash: null, error: 'platform restarted while the export was in flight' });

  // A row closed out releases the claim; a claim of a row no longer
  // waiting is refused as gone.
  await one.query(`UPDATE db_exports SET status = 'completed', finished_at = NOW() WHERE id = $1`, [second]);
  assert.deepEqual(await dbExport.beginExport(one, second), { claimed: false, reason: 'gone' });
  assert.equal(await dbExport.isExportInProgress(one), false);

  // A ticket that expired unused: refused, and its request settled by a boot.
  const third = await request(u.id);
  const late = await dbExport.issueTicket(one, { auditId: third });
  await one.query(`UPDATE db_exports SET ticket_expires_at = NOW() - interval '5 minutes' WHERE id = $1`, [third]);
  assert.equal(await dbExport.consumeTicket(two, late.token, u.id), null);
  assert.equal(await dbExport.settleAbandoned(two), 1);
  assert.deepEqual(await row(third), { status: 'interrupted', ticket_hash: null, error: 'the download was never started' });
});
