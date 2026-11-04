'use strict';

// #6282 (4 Nov 2026): the Needs you feed asks for no vote on a change that is
// about to be updated, against the REAL schema in a throwaway PostgreSQL
// database.
//
// What this pins:
//   1. A promoted change the viewer has not voted on is owed: in the Needs
//      you feed, in COUNTS_SQL's `needs` and `owed` keys, and in
//      OWED_BY_COMMUNITY_SQL's waiting count.
//   2. Each of three things takes it out of all three: an ask of Homeroom bot
//      waiting its turn ('queued'), an ask it has taken ('taken'), and a turn
//      in flight on the change (chat_sessions.active_turn).
//   3. It comes back once the ask is done, or the turn ends.
//   4. An ask past its window does not hold: a taken ask older than
//      STALE_ASK_HOURS (3), or a queued ask older than the sweep's week.
//   5. In a ballot, a rival's queued ask takes the whole ballot out, so
//      nobody picks a change that is about to change.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/needs-feed-update-coming-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('an update on its way leaves the Needs you feed, and comes back', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `needs_update_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const overview = require('../src/routes/workshop-overview');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username) => one(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username]);
  const ada = await user('nu_ada');
  const bob = await user('nu_bob');
  const cat = await user('nu_cat');
  const app = await one(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility)
     VALUES ('Night mode', 'nu-night', 'public', 'public') RETURNING id, slug`);
  for (const u of [ada, bob, cat]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, u.id]);
  }
  await pool.query(`INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 7, 'Night mode', $2)`, [app.id, ada.id]);
  const change = async (by, pr, linked) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, check_state, promoted_at)
     VALUES ($1, $2, 'promoted', $3::int[], $4, $5, 'passing', NOW()) RETURNING id`,
    [app.id, by.id, linked, pr, `Change ${pr}`])).rows[0];
  const a = await change(bob, 20, [7]);

  // What the three readers say about the change for ada, who owes its vote.
  const feed = async () => (await pool.query(
    overview.NEEDS_FEED_SQL, [ada.id, false, false, overview.NEEDS_FEED_MAX])).rows
    .filter((r) => Number(r.app_id) === Number(app.id) && r.kind === 'proposal')
    .map((r) => Number(r.id));
  const counts = async () => {
    const row = (await pool.query(overview.COUNTS_SQL, [ada.id, false, false])).rows
      .find((r) => r.slug === app.slug);
    return row ? { needs: Number(row.needs), owed: row.owed } : { needs: 0, owed: [] };
  };
  const waiting = async () => {
    const row = (await overview.owedByCommunity(pool, ada.id)).find((r) => r.slug === app.slug);
    return row ? Number(row.waiting) : 0;
  };
  const everywhere = async () => {
    const [f, c, w] = await Promise.all([feed(), counts(), waiting()]);
    return { feed: f, needs: c.needs, owed: c.owed, waiting: w };
  };
  const ask = (sessionId, status, { instruction = 'drop the second credit line', ago = '1 minute' } = {}) => one(
    `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, instruction, status, created_at, taken_at)
     VALUES ($1, $2, 7, $3, $4, NOW() - make_interval(mins => $5),
             CASE WHEN $4 = 'taken' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [app.id, sessionId, instruction, status, Number(ago.split(' ')[0]) * (ago.includes('hour') ? 60 : 1)]);

  await t.test('owed to begin with', async () => {
    const now = await everywhere();
    assert.deepEqual(now.feed, [a.id]);
    assert.equal(now.needs, 1);
    assert.ok(now.owed.includes(`proposal:${a.id}@0`), 'the key the seen record uses');
    assert.equal(now.waiting, 1);
  });

  await t.test('a queued ask takes it out of the feed, the counts and every community', async () => {
    const q = await ask(a.id, 'queued');
    assert.deepEqual(await everywhere(), { feed: [], needs: 0, owed: [], waiting: 0 });
    // Taken now: still holding it.
    await pool.query(`UPDATE homeroom_bot_change_asks SET status = 'taken', taken_at = NOW() WHERE id = $1`, [q.id]);
    assert.deepEqual(await everywhere(), { feed: [], needs: 0, owed: [], waiting: 0 });
    // Done: the update landed, and it asks again.
    await pool.query(`UPDATE homeroom_bot_change_asks SET status = 'done', done_at = NOW() WHERE id = $1`, [q.id]);
    const back = await everywhere();
    assert.deepEqual(back.feed, [a.id]);
    assert.equal(back.needs, 1);
    assert.equal(back.waiting, 1);
  });

  await t.test('a turn in flight on the change holds it too, and it returns when the turn ends', async () => {
    await pool.query(`UPDATE chat_sessions SET active_turn = '{}'::jsonb WHERE id = $1`, [a.id]);
    assert.deepEqual(await everywhere(), { feed: [], needs: 0, owed: [], waiting: 0 });
    await pool.query(`UPDATE chat_sessions SET active_turn = NULL WHERE id = $1`, [a.id]);
    assert.equal((await everywhere()).needs, 1);
  });

  await t.test('an ask past its window does not hold the vote', async () => {
    // The bot puts a taken ask older than 3 hours back to queued.
    const stale = await ask(a.id, 'taken', { ago: '240 minutes' });
    // Taken four hours ago: past the bot's own STALE_ASK_HOURS (3), which is
    // when takeAsks would put it back to queued.
    await pool.query(`UPDATE homeroom_bot_change_asks SET taken_at = NOW() - INTERVAL '4 hours' WHERE id = $1`, [stale.id]);
    assert.equal((await everywhere()).needs, 1, 'a taken ask older than STALE_ASK_HOURS holds nothing');
    await pool.query(`UPDATE homeroom_bot_change_asks SET status = 'queued', taken_at = NULL WHERE id = $1`, [stale.id]);
    // ...and once requeued it holds again, as queued.
    assert.equal((await everywhere()).needs, 0);
    // A queued ask older than the sweep's week is not an update any more.
    await pool.query(`UPDATE homeroom_bot_change_asks SET created_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [stale.id]);
    assert.equal((await everywhere()).needs, 1);
    await pool.query(`DELETE FROM homeroom_bot_change_asks WHERE id = $1`, [stale.id]);
  });

  await t.test('a rival\'s queued ask takes the whole ballot out', async () => {
    // A second change that would close the same request: one ballot between
    // them, carried by the older change (a).
    const b = await change(cat, 21, [7]);
    assert.deepEqual(await feed(), [a.id], 'one ballot, on its oldest change');
    const q = await ask(b.id, 'queued');
    assert.deepEqual(await feed(), [], 'nobody picks a change that is about to change');
    await pool.query(`UPDATE homeroom_bot_change_asks SET status = 'done', done_at = NOW() WHERE id = $1`, [q.id]);
    assert.deepEqual(await feed(), [a.id], 'back once the rival\'s update lands');
  });
});
