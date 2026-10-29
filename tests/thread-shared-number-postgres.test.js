'use strict';

// #6019 follow-up, 29 Oct: Change #6002 (SEC-09) listed Request #6002
// (Guardrail 1) and Change #5996 "In this thread". On a project still on
// GitHub a pull request's number is GitHub's and a request's Homeroom's
// (services/app-numbers.js), so an unrelated change and request shared a
// number, and the change joined the request's thread by it. Against the REAL
// schema in a throwaway database, this pins what a change's page and its
// replies now read:
//
//   1. The change's thread is its own, with no number; the request's thread
//      no longer lists it, and the change's page (`asChange`) reads its own.
//   2. Its page says the thread is the change's (not a decision's).
//   3. A reply on it is named by the change's number, as a change's thread.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-shared-number-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a change that shares a request\'s number keeps a thread of its own', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `thread_shared_number_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  require('../src/db/pool').getPool = () => pool;
  const threads = require('../src/services/threads');

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [username])).rows[0];
  const [evan, bruno, snait] = [await user('sn_evan'), await user('sn_bruno'), await user('sn_snait')];
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility) VALUES ('Homeroom', 'sn-homeroom', 'public', 'public') RETURNING id, slug`);
  await pool.query(`INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 6002, 'Guardrail 1', $2)`, [app.id, evan.id]);
  const change = async (by, pr, linked, title) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, branch_name)
     VALUES ($1, $2, 'promoted', $3::int[], $4, $5, $6) RETURNING id, thread_id`,
    [app.id, by.id, linked, pr, title, `feature/${pr}`])).rows[0];
  const fences = await change(snait, 5996, [6002], 'Session fences');
  const sec09 = await change(bruno, 6002, [], 'SEC-09');
  const { rows: [reply] } = await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'ready', 'session', $3) RETURNING id`,
    [app.id, bruno.id, sec09.id]);

  await t.test('its page reads its own thread, which holds only it', async () => {
    const thread = await threads.threadForNumber(pool, { appId: app.id, number: 6002, asChange: true });
    assert.equal(String(thread.id), String(sec09.thread_id));
    assert.equal(thread.number, null);
    const page = await threads.threadPage(pool, { thread, viewerId: bruno.id });
    assert.deepEqual(page.items.map((i) => [i.type, i.number]), [['change', 6002]]);
    assert.equal(page.thread.lead, 'change', 'the change leads it; it is no decision');
  });

  await t.test('the request\'s thread no longer lists it', async () => {
    const thread = await threads.threadForNumber(pool, { appId: app.id, number: 6002 });
    assert.equal(String(thread.id), String(fences.thread_id));
    const page = await threads.threadPage(pool, { thread, viewerId: evan.id });
    assert.deepEqual(page.items.map((i) => [i.type, i.number]).sort(), [['change', 5996], ['request', 6002]]);
    assert.equal(page.thread.lead, 'request');
  });

  await t.test('a reply on it is named by the change, as a change\'s thread', async () => {
    const row = await threads.threadOfMessage(pool, { appId: app.id, messageId: reply.id });
    assert.equal(String(row.thread_id), String(sec09.thread_id));
    assert.equal(Number(row.number), 6002);
    assert.equal(row.change_led, true);
  });
});
