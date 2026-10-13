'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const activity = require('../src/services/app-activity');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function request(batchId, entries) {
  return activity.parseActivityRequest({ version: 1, batchId, entries }, new Date('2026-10-01T18:00:00Z'));
}

test('activity receipts deduplicate concurrent delivery and preserve occurrence days (PostgreSQL)',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2_000 });
    try { await admin.query('SELECT 1'); } catch (error) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw error;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
      return;
    }
    const name = `app_activity_${crypto.randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    });
    const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
    await pool.query(schema);
    await pool.query(schema);

    const user = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('usage_tester', 'unused') RETURNING id`
    )).rows[0];
    const app = (await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility)
       VALUES ('usage-app', 'Usage app', $1, 'public', 'public') RETURNING id`,
      [user.id]
    )).rows[0];
    const batchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const parsed = request(batchId, [
      { date: '2026-09-30', seconds: 11 },
      { date: '2026-10-01', seconds: 13 },
    ]);

    const outcomes = await Promise.all([
      activity.recordActivityBatch(pool, { slug: 'usage-app', user, request: parsed }),
      activity.recordActivityBatch(pool, { slug: 'usage-app', user, request: parsed }),
    ]);
    assert.deepEqual(outcomes.map((row) => row.duplicate).sort(), [false, true]);
    assert.equal((await pool.query('SELECT count(*)::int n FROM app_activity_receipts')).rows[0].n, 1);
    assert.deepEqual((await pool.query(
      `SELECT date::text, seconds_spent FROM app_activity ORDER BY date`
    )).rows, [
      { date: '2026-09-30', seconds_spent: 11 },
      { date: '2026-10-01', seconds_spent: 13 },
    ]);
    assert.deepEqual((await pool.query(
      `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS date, count(*)::int AS n
         FROM events WHERE event_type = 'dapp_active_day' GROUP BY 1 ORDER BY 1`
    )).rows, [
      { date: '2026-09-30', n: 1 },
      { date: '2026-10-01', n: 1 },
    ]);

    const reused = request(batchId, [{ date: '2026-10-01', seconds: 99 }]);
    await assert.rejects(
      activity.recordActivityBatch(pool, { slug: 'usage-app', user, request: reused }),
      (error) => error.code === 'batch_id_reused'
    );
    assert.equal((await pool.query(
      `SELECT seconds_spent FROM app_activity WHERE app_id = $1 AND user_id = $2 AND date = '2026-10-01'`,
      [app.id, user.id]
    )).rows[0].seconds_spent, 13, 'receipt reuse rolls back without changing the total');

    // The first delivery's commit also started the throttled background
    // cleanup. Both pooled clients were busy then, so it waits for a new
    // connection and can run its DELETE after the UPDATE below, purging the
    // aged receipt itself and leaving the explicit purge nothing to count.
    // Let it finish first; the throttle keeps the later commits in this test
    // from starting another.
    await activity._awaitReceiptCleanupForTests();
    await pool.query(
      `UPDATE app_activity_receipts SET received_at = NOW() - INTERVAL '31 days'
        WHERE batch_id = $1::uuid`,
      [batchId]
    );
    const recentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await activity.recordActivityBatch(pool, {
      slug: 'usage-app', user,
      request: request(recentId, [{ date: '2026-10-01', seconds: 1 }]),
    });
    assert.equal(await activity.purgeActivityReceipts(pool), 1);
    assert.deepEqual((await pool.query(
      `SELECT batch_id::text FROM app_activity_receipts ORDER BY received_at`
    )).rows, [{ batch_id: recentId }], 'cleanup retains receipts beyond the accepted retry window');

    await pool.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES ($1, $2)', [user.id, app.id]);
    const blocked = request('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', [
      { date: '2026-10-01', seconds: 7 },
    ]);
    await assert.rejects(
      activity.recordActivityBatch(pool, { slug: 'usage-app', user, request: blocked }),
      (error) => error.code === 'not_found'
    );
    assert.equal((await pool.query(
      `SELECT count(*)::int n FROM app_activity_receipts WHERE batch_id = $1::uuid`,
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
    )).rows[0].n, 0, 'access denial writes no receipt or seconds');
  });
