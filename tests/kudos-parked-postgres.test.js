'use strict';

// Kudos is parked (#5249), against the full PostgreSQL schema: a kudos
// notification is neither listed (the feed, its Saved section, one row by
// id) nor counted (the bell's badge, the phone's icon), while the row stays;
// and a request's or proposal's thread is read without the bounty system
// lines, while a person who typed the same words keeps them. The SQL-text
// half of this is tests/kudos-parked-server.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const notifications = require('../src/services/notifications');
const { parkedSystemLineSql } = require('../src/services/kudos-parked');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('kudos parked against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'kudos_parked_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [ada] } = await pool.query(`INSERT INTO users (username, password) VALUES ('kp_ada', 'x') RETURNING id`);
  const { rows: [sam] } = await pool.query(`INSERT INTO users (username, password) VALUES ('kp_sam', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by) VALUES ('kp-app', 'kp-app', $1) RETURNING id`, [ada.id]);
  const { rows: [change] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title) VALUES ($1, $2, 'promoted', 7, 'A change') RETURNING id`,
    [app.id, ada.id]);

  await t.test('a kudos row is neither listed nor counted, and stays in the table', async () => {
    const insert = async (kind) => (await pool.query(
      `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ada.id, app.id, change.id, sam.id, kind])).rows[0].id;
    const kudosId = await insert('kudos');
    const staleId = await insert('stale_pr');
    await pool.query('INSERT INTO notification_bookmarks (user_id, notification_id) VALUES ($1, $2), ($1, $3)', [ada.id, kudosId, staleId]);

    assert.equal(await notifications.countUnread(pool, ada.id), 1, 'only the stale_pr row counts');
    assert.deepEqual((await notifications.listForUser(pool, ada.id)).map((r) => r.kind), ['stale_pr']);
    assert.deepEqual((await notifications.listSavedForUser(pool, ada.id)).map((r) => r.kind), ['stale_pr'],
      'a kudos row saved before parking is not in Saved either');
    assert.equal(await notifications.getForUser(pool, ada.id, kudosId), null);
    assert.equal((await notifications.getForUser(pool, ada.id, staleId)).kind, 'stale_pr');
    const { rows: [kept] } = await pool.query('SELECT COUNT(*)::int AS c FROM notifications WHERE kind = $1', ['kudos']);
    assert.equal(kept.c, 1, 'nothing is deleted');
  });

  await t.test('a thread is read without the bounty system lines; a person\'s words stay', async () => {
    const line = async (content, msgType, thread, ref, userId = null) => pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref) VALUES ($1, $2, $3, $4, $5, $6)`,
      [app.id, userId, content, msgType, thread, ref]);
    await line('kp_sam placed a bounty (kudos) on issue #12', 'system', 'issue', 12);
    await line('kp_sam claimed issue #12', 'system', 'issue', 12);
    await line('kp_sam placed a bounty (kudos) on issue #12', 'message', 'issue', 12, sam.id);
    await line(`Bounty on issue #12 (2 kudos) awarded to <@${ada.id}> for PR #7`, 'system', 'session', change.id);
    await line('Bounty on issue #12 (1 kudos) awarded to the author for PR #7', 'system', 'session', change.id);
    await line('A change is live (PR #7).', 'system', 'session', change.id);
    const read = async (thread, ref) => (await pool.query(
      `SELECT m.content, m.msg_type FROM chat_messages m
        WHERE m.app_id = $1 AND m.thread_type = $2 AND m.thread_ref = $3 AND ${parkedSystemLineSql('m')}
        ORDER BY m.id`, [app.id, thread, ref])).rows.map((r) => `${r.msg_type}: ${r.content}`);
    assert.deepEqual(await read('issue', 12), [
      'system: kp_sam claimed issue #12',
      'message: kp_sam placed a bounty (kudos) on issue #12',
    ]);
    assert.deepEqual(await read('session', change.id), ['system: A change is live (PR #7).']);
  });
});
