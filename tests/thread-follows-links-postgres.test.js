'use strict';

// #6605: a change keeps the thread of the first request it was linked to.
// Against the REAL schema in a throwaway database, this pins the migration
// `change-thread-follows-links`:
//
//   1. Relinking a draft, or a change up for a vote, moves it to its new
//      first request's thread, and its replies go with it.
//   2. A change people have voted on, a merged one and one with a thread move
//      still being gathered stay where they are.
//   3. Links that did not change, or an update that names linked_issues but
//      leaves it the same, move nothing.
//   4. Removing every link sends a change back to its own thread, so no
//      request page shows it.
//   5. The one-time backfill moves a mismatched change, carries its replies
//      and refreshes both threads' state.
//   6. PR 6581 (change 13356) is moved to #6581's thread even after votes.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-follows-links-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const MIGRATION = path.join(__dirname, '..', 'src', 'db', 'migrations', 'change-thread-follows-links.sql');

test('a change\'s thread follows its links', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `thread_follows_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const migrations = require('../src/db/schema-migrations');
  await migrations.applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await migrations.applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const threads = require('../src/services/threads');
  const migrationSql = fs.readFileSync(MIGRATION, 'utf8');
  const runMigrationAgain = () => pool.query(migrationSql);

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [username])).rows[0];
  const [ana, dewi, maya] = [await user('op_ana'), await user('op_dewi'), await user('op_maya')];
  const makeApp = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility)
     VALUES ($1, $2, 'running', 'public', 'public') RETURNING id, slug`, [slug, slug])).rows[0];
  const app = await makeApp('follow-club');
  const makeRequest = (appId, number, state, by) => pool.query(
    `INSERT INTO requests (app_id, number, title, state, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [appId, number, `Request ${number}`, state, by.id]);
  await makeRequest(app.id, 10, 'open', ana);
  await makeRequest(app.id, 11, 'open', ana);

  const change = async (appId, by, { pr = null, linked = [], status = 'promoted', from = null, threadId = null, title = 'A change' } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, created_from_issue_number, pr_number, pr_title, branch_name, thread_id)
     VALUES ($1, $2, $3, $4::int[], $5, $6, $7, $8, $9) RETURNING id, thread_id`,
    [appId, by.id, status, linked, from, pr, title, `feature/${pr || crypto.randomBytes(3).toString('hex')}`, threadId])).rows[0];
  const reply = (appId, who, sessionId, content) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, $3, 'session', $4)`,
    [appId, who.id, content, sessionId]);
  const threadOf = async (appId, number) => Number((await threads.threadForNumber(pool, { appId, number })).id);
  const threadIdOf = async (sessionId) => Number((await pool.query(
    'SELECT thread_id FROM chat_sessions WHERE id = $1', [sessionId])).rows[0].thread_id);
  const repliesOn = async (sessionId) => (await pool.query(
    `SELECT thread_id FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1`, [sessionId])).rows
    .map((r) => Number(r.thread_id));
  const vote = (sessionId, who) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [sessionId, who.id]);

  await t.test('relinking a draft moves it and its replies to its new first request\'s thread', async () => {
    const draft = await change(app.id, dewi, { linked: [10], status: 'active', pr: 50 });
    assert.equal(await threadIdOf(draft.id), await threadOf(app.id, 10), 'it starts in #10\'s thread');
    await reply(app.id, maya, draft.id, 'Still thinking.');
    await pool.query('UPDATE chat_sessions SET linked_issues = $2::int[] WHERE id = $1', [draft.id, [11]]);
    const home = await threadOf(app.id, 11);
    assert.equal(await threadIdOf(draft.id), home, 'it followed its link');
    assert.deepEqual(await repliesOn(draft.id), [home], 'its reply moved with it');
    assert.deepEqual(await threads.requestHome(pool, { appId: app.id, sessionId: draft.id, viewerId: dewi.id }), {
      number: 11, threadId: home,
    }, 'its address opens #11\'s page now');
  });

  await t.test('relinking a change up for a vote moves it too', async () => {
    const promoted = await change(app.id, dewi, { linked: [10], status: 'promoted', pr: 51 });
    await pool.query('UPDATE chat_sessions SET linked_issues = $2::int[] WHERE id = $1', [promoted.id, [11]]);
    assert.equal(await threadIdOf(promoted.id), await threadOf(app.id, 11));
  });

  await t.test('a change people have voted on stays where it is', async () => {
    const voted = await change(app.id, dewi, { linked: [10], status: 'promoted', pr: 52 });
    await vote(voted.id, maya);
    const before = await threadIdOf(voted.id);
    await pool.query('UPDATE chat_sessions SET linked_issues = $2::int[] WHERE id = $1', [voted.id, [11]]);
    assert.equal(await threadIdOf(voted.id), before, 'votes keep it');
  });

  await t.test('a merged change and one with a thread move being gathered stay', async () => {
    const merged = await change(app.id, dewi, { linked: [10], status: 'merged', pr: 53 });
    await pool.query('UPDATE chat_sessions SET linked_issues = $2::int[] WHERE id = $1', [merged.id, [11]]);
    assert.equal(await threadIdOf(merged.id), await threadOf(app.id, 10), 'a merged change has left the relink behind');

    const gathering = await change(app.id, dewi, { linked: [10], status: 'promoted', pr: 54 });
    await pool.query(
      `INSERT INTO thread_moves (app_id, thread_id, kind, deadline, for_session_id)
       VALUES ($1, $2, 'merge', NOW() + INTERVAL '1 day', $3)`,
      [app.id, await threadOf(app.id, 10), gathering.id]);
    await pool.query('UPDATE chat_sessions SET linked_issues = $2::int[] WHERE id = $1', [gathering.id, [11]]);
    assert.equal(await threadIdOf(gathering.id), await threadOf(app.id, 10), 'its gather is not orphaned');
  });

  await t.test('unchanged links move nothing', async () => {
    const still = await change(app.id, dewi, { linked: [11], status: 'promoted', pr: 55 });
    const before = await threadIdOf(still.id);
    await pool.query('UPDATE chat_sessions SET linked_issues = linked_issues WHERE id = $1', [still.id]);
    await pool.query('UPDATE chat_sessions SET pr_title = $2 WHERE id = $1', [still.id, 'Renamed']);
    assert.equal(await threadIdOf(still.id), before);
  });

  await t.test('removing every link sends the change back to its own thread', async () => {
    const loose = await change(app.id, dewi, { linked: [10], status: 'promoted', pr: 56 });
    await reply(app.id, maya, loose.id, 'A reply.');
    await pool.query(`UPDATE chat_sessions SET linked_issues = '{}'::int[] WHERE id = $1`, [loose.id]);
    const own = await threadOf(app.id, 56);
    assert.equal(await threadIdOf(loose.id), own, 'its own thread, by PR number');
    assert.deepEqual(await repliesOn(loose.id), [own], 'its reply came along');
    assert.equal(await threads.requestHome(pool, { appId: app.id, sessionId: loose.id, viewerId: dewi.id }), null,
      'no request page shows it');
  });

  await t.test('the backfill moves a mismatched change, carries replies and refreshes both threads', async () => {
    const second = await makeApp('follow-second');
    await makeRequest(second.id, 30, 'open', ana);
    await makeRequest(second.id, 31, 'closed', ana);
    const oldThread = await threadOf(second.id, 31);
    const mismatched = await change(second.id, dewi, {
      linked: [30], status: 'active', pr: 70, threadId: oldThread,
    });
    assert.equal(await threadIdOf(mismatched.id), oldThread, 'it starts on the wrong page');
    await reply(second.id, maya, mismatched.id, 'Carried.');
    const stateOf = async (id) => (await pool.query('SELECT state FROM threads WHERE id = $1', [id])).rows[0].state;
    assert.equal(await stateOf(oldThread), 'open', 'the change kept its old thread open');

    await runMigrationAgain();
    const home = await threadOf(second.id, 30);
    assert.equal(await threadIdOf(mismatched.id), home, 'the backfill moved it home');
    assert.deepEqual(await repliesOn(mismatched.id), [home], 'its reply came along');
    assert.equal(await stateOf(oldThread), 'closed', 'the thread it left closes');
    assert.equal(await stateOf(home), 'open', 'the thread it joined opens');
  });

  await t.test('PR 6581 moves to #6581\'s thread even after votes', async () => {
    const third = await makeApp('follow-pr');
    await makeRequest(third.id, 6407, 'closed', ana);
    await makeRequest(third.id, 6581, 'closed', ana);
    await makeRequest(third.id, 6582, 'closed', ana);
    await makeRequest(third.id, 6583, 'closed', ana);
    const wrong = await threadOf(third.id, 6407);
    await pool.query(
      `INSERT INTO chat_sessions (id, app_id, user_id, status, linked_issues, pr_number, pr_title, branch_name, thread_id)
       VALUES (13356, $1, $2, 'promoted', '{6581,6582,6583}', 6581, 'One standing', 'feature/6581', $3)`,
      [third.id, dewi.id, wrong]);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES (13356, $1, 'yes')`, [maya.id]);
    assert.equal(await threadIdOf(13356), wrong, 'it starts on #6407\'s page');

    await runMigrationAgain();
    assert.equal(await threadIdOf(13356), await threadOf(third.id, 6581), 'the named fix puts it under #6581');
  });

  // #6605: what the pages say about the requests a change closes. A closed
  // request is not open work, and a change that belongs in this request's
  // thread but stayed because of votes says why.
  await t.test('a card knows when its request is closed and when a voted change stays away', async () => {
    const fourth = await makeApp('follow-cards');
    await makeRequest(fourth.id, 40, 'open', ana);
    await makeRequest(fourth.id, 41, 'open', ana);
    const pin = await change(fourth.id, dewi, { linked: [40, 41], status: 'promoted', pr: 80 });
    await pool.query('UPDATE requests SET state = $2 WHERE app_id = $1 AND number = 41', [fourth.id, 'closed']);

    const page41 = await threads.threadPage(pool, { thread: await threads.threadForNumber(pool, { appId: fourth.id, number: 41 }), viewerId: ana.id });
    assert.equal(page41.elsewhere.length, 1);
    assert.equal(page41.elsewhere[0].closed, true, 'the request is already closed');
    assert.equal(page41.elsewhere[0].ask, false, 'so there is nothing to answer');

    // A change whose first link is #40 but which sits in #41's thread, with a
    // vote, is the one that would have moved to #40 and did not.
    const voted = await change(fourth.id, dewi, {
      linked: [40, 41], status: 'promoted', pr: 81,
      threadId: Number((await threads.threadForNumber(pool, { appId: fourth.id, number: 41 })).id),
    });
    await vote(voted.id, maya);
    await pool.query('UPDATE requests SET state = $2 WHERE app_id = $1 AND number = 41', [fourth.id, 'open']);
    const page40 = await threads.threadPage(pool, { thread: await threads.threadForNumber(pool, { appId: fourth.id, number: 40 }), viewerId: ana.id });
    const stayed = page40.elsewhere.find((e) => e.id === Number(voted.id));
    assert.equal(stayed.stays, true, 'it belongs on #40 but votes kept it on #41');
    assert.equal(stayed.closed, false, 'the request is open again');
    assert.equal(page40.elsewhere.find((e) => e.id === Number(pin.id)), undefined, 'the change in #40 has no elsewhere card');

    const closes = page40.items.find((i) => i.type === 'change' && i.id === Number(pin.id)).closesRequests;
    assert.deepEqual(closes.map((r) => [r.number, r.closed]), [[40, false], [41, false]]);
  });
});
