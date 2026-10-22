'use strict';

// hydrateAndPush reads a batch of notifications in one query (22 Oct 2026),
// against the full PostgreSQL schema: the batch read is the single read with
// `n.id = ANY($1)`, so every row reads exactly as it does alone, a row the
// bell does not list is left out of the batch as it reads null alone, and one
// call per recipient pushes each recipient their own row from a single read.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/notifications-push-batch-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const notifications = require('../src/services/notifications');
const ws = require('../src/services/ws');

test('a batch of notifications reads as each does alone, against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `notif_batch_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const pushed = [];
  const realPush = ws.pushNotificationToUser;
  ws.pushNotificationToUser = (userId, payload) => { pushed.push({ userId: Number(userId), id: payload.notification.id }); };
  t.after(() => { ws.pushNotificationToUser = realPush; });

  const { rows: users } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access)
     SELECT 'reader_' || i, 'x', TRUE FROM generate_series(1, 3) i RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Plant Pal', 'plant-pal', 'running', $1) RETURNING id`,
    [users[0].id],
  );
  const { rows: [merged] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, merged_at, live_at, pr_number, pr_title)
     VALUES ($1, $2, 'merged', NOW(), NOW(), 7, 'Water reminders') RETURNING id`,
    [app.id, users[0].id],
  );
  // One per reader, as a notification to many people is written, and a
  // fourth the bell does not list (news about a change that has merged).
  const { rows: listed } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, kind, detail)
     SELECT u, $1, 'app_quota_requested', 'Plant Pal' FROM unnest($2::int[]) u RETURNING id, user_id`,
    [app.id, users.map((u) => u.id)],
  );
  const { rows: [hidden] } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, kind) VALUES ($1, $2, $3, 'voted_change_merged') RETURNING id, user_id`,
    [users[1].id, app.id, merged.id],
  );
  const ids = [...listed.map((r) => r.id), hidden.id];

  await t.test('the batch read is the single read, row for row', async () => {
    const batch = await notifications.hydrateNotifications(pool, ids);
    for (const id of ids) {
      const alone = await notifications.hydrateNotification(pool, id);
      assert.deepEqual(batch.get(id) || null, alone, `notification ${id}`);
    }
    assert.equal(batch.has(hidden.id), false, 'a row the bell does not list is left out, as it reads null alone');
    assert.equal(batch.size, listed.length);
  });

  await t.test('one call per recipient pushes each their own row, from one read', async () => {
    const seen = [];
    const counting = { query: (...args) => { seen.push(String(args[0])); return pool.query(...args); } };
    pushed.length = 0;
    await Promise.all([...listed, hidden].map((row) => notifications.hydrateAndPush(counting, row)));
    assert.equal(seen.length, 1, 'one read for the batch');
    assert.deepEqual(pushed.sort((a, b) => a.id - b.id),
      listed.map((r) => ({ userId: r.user_id, id: r.id })).sort((a, b) => a.id - b.id));
  });
});
