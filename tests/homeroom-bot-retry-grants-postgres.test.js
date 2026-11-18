'use strict';

// #6776: the reads behind "Let it try again" against the real tables.
//
// roundState decides whether the round a grant bought is queued or running
// from homeroom_bot_queue (its row, and its place in the queue's own order),
// a pending FixAsked and the change's active turn; the sweep finds grants
// left open with nothing behind them. The unit suite next to this one pins
// the answers; this pins that the SQL runs and reads what it claims.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-retry-grants-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('roundState and the sweep read the queue, the grant and the change', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_retry_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  const grants = require('../src/services/homeroom-bot-retry-grants');

  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, self_hosted) VALUES ('Homeroom', 'usernode-2d5619', TRUE) RETURNING id",
  );
  const { rows: [user] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('retry-grants-test', 'not-a-login') RETURNING id",
  );
  const change = async (status, issue = 7001) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, linked_issues, check_state)
       VALUES ($1, $2, $3, $4, ARRAY[$5]::int[], 'failing') RETURNING id`,
      [app.id, user.id, `test/retry-${crypto.randomBytes(4).toString('hex')}`, status, issue],
    );
    return Number(row.id);
  };

  // Nothing queued, nothing running.
  const idle = await change('promoted');
  assert.deepEqual(await grants.roundState(pool, idle), { state: 'none' });

  // A waiting queue row is queued, with its place in the queue's own order.
  const other = await change('promoted', 7002);
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, enqueued_at)
     VALUES ($1, 7003, 1, 'refresh', NOW() - INTERVAL '2 minutes')`, [app.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, enqueued_at)
     VALUES ($1, 7001, 1, 'checks_failing', NOW() - INTERVAL '1 minute')`, [app.id],
  );
  const queued = await grants.roundState(pool, idle);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.place, 2, 'the earlier request is ahead of it');
  assert.deepEqual(await grants.roundState(pool, other), { state: 'none' }, 'another request is not the change\'s');

  // Its row started: running.
  await pool.query(
    "UPDATE homeroom_bot_queue SET started_at = NOW() WHERE app_id = $1 AND issue_number = 7001", [app.id],
  );
  assert.deepEqual(await grants.roundState(pool, idle), { state: 'running' });
  await pool.query(
    "DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 7001", [app.id],
  );

  // A pending FixAsked for the change counts as queued, with no place yet.
  const kernel = require('../src/workflow/kernel/index.ts');
  await kernel.appendEvent(pool, 'bot-request', `request:${app.id}:7001`, {
    type: 'FixAsked',
    payload: { appId: Number(app.id), issueNumber: 7001, sessionId: idle, head: 'a'.repeat(40) },
  }, { requestKey: `fix:${idle}:test`, source: { kind: 'system', name: 'bot-change' }, appId: Number(app.id) });
  assert.deepEqual(await grants.roundState(pool, idle), { state: 'queued', place: null });

  // The sweep: a grant older than the interval with nothing behind it is
  // queued again; one whose change merged is closed; a young one is left.
  const strandedChange = await change('promoted');
  const mergedChange = await change('merged');
  const youngChange = await change('promoted');
  const grant = async (sessionId, minutes) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO homeroom_bot_revision_grants (app_id, session_id, created_at)
       VALUES ($1, $2, NOW() - make_interval(mins => $3)) RETURNING id`,
      [app.id, sessionId, minutes],
    );
    return Number(row.id);
  };
  const strandedGrant = await grant(strandedChange, 6);
  const mergedGrant = await grant(mergedChange, 6);
  await grant(youngChange, 2);
  const asked = [];
  const out = await grants.sweepStrandedGrants(pool, null, {
    homeroomBot: { queueChecksFix: async (_pool, args) => { asked.push(args); return { queued: true }; } },
  });
  assert.deepEqual(out, { requeued: 1, closed: 1 });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].sessionId, strandedChange);
  assert.match(asked[0].again, /^sweep:/);
  const { rows: closed } = await pool.query(
    'SELECT used_at, run_id FROM homeroom_bot_revision_grants WHERE id = $1', [mergedGrant],
  );
  assert.ok(closed[0].used_at, 'the merged change\'s try is closed');
  assert.equal(closed[0].run_id, null);
  const { rows: [open] } = await pool.query(
    'SELECT used_at FROM homeroom_bot_revision_grants WHERE id = $1', [strandedGrant],
  );
  assert.equal(open.used_at, null, 'the re-queued try stays open: its round spends it');
});
