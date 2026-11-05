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
//   6. #6348: once the change has a newer head than the ask was made against,
//      the ask no longer holds, and a turn marker older than any turn can run
//      is no update on its way.
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
  const change = async (by, pr, linked, {
    reviewedHeadSha = null, importedHeadSha = null, source = null,
  } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, check_state, promoted_at,
                                reviewed_head_sha, imported_pr_head_sha, source)
     VALUES ($1, $2, 'promoted', $3::int[], $4, $5, 'passing', NOW(), $6, $7, $8) RETURNING id`,
    [app.id, by.id, linked, pr, `Change ${pr}`, reviewedHeadSha, importedHeadSha, source])).rows[0];
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
  const ask = (sessionId, status, {
    instruction = 'drop the second credit line', ago = '1 minute', askedHead = null, issueNumber = 7,
  } = {}) => one(
    `INSERT INTO homeroom_bot_change_asks
       (app_id, session_id, issue_number, instruction, status, created_at, taken_at, asked_head_sha)
     VALUES ($1, $2, $3, $4, $5, NOW() - make_interval(mins => $6),
             CASE WHEN $5 = 'taken' THEN NOW() ELSE NULL END, $7)
     RETURNING id`,
    [app.id, sessionId, issueNumber, instruction, status,
      Number(ago.split(' ')[0]) * (ago.includes('hour') ? 60 : 1), askedHead]);

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

  // ── #6348: the hold ends once the head it was asked against has moved ──
  const HEAD_ONE = 'a'.repeat(40);
  const HEAD_TWO = 'b'.repeat(40);

  await t.test('a queued ask stops holding once the change has a newer head', async () => {
    const c = await change(bob, 30, [8], { reviewedHeadSha: HEAD_ONE });
    assert.ok((await feed()).includes(c.id), 'owed before the ask');
    await ask(c.id, 'queued', { askedHead: HEAD_ONE, issueNumber: 8 });
    assert.ok(!(await feed()).includes(c.id), 'a queued ask on this head holds it');
    await pool.query(`UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1`, [c.id, HEAD_TWO]);
    assert.ok((await feed()).includes(c.id), 'the update landed: owed again');
  });

  await t.test('a taken ask stops holding once the change has a newer head', async () => {
    const c = await change(bob, 31, [9], { reviewedHeadSha: HEAD_ONE });
    await ask(c.id, 'taken', { askedHead: HEAD_ONE, issueNumber: 9 });
    assert.ok(!(await feed()).includes(c.id), 'a taken ask on this head holds it');
    await pool.query(`UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1`, [c.id, HEAD_TWO]);
    assert.ok((await feed()).includes(c.id), 'the update landed: owed again');
  });

  await t.test('an ask made before heads were recorded keeps its window', async () => {
    const c = await change(bob, 32, [10], { reviewedHeadSha: HEAD_ONE });
    await ask(c.id, 'queued', { issueNumber: 10 });
    assert.ok(!(await feed()).includes(c.id), 'asked_head_sha NULL still holds within its window');
  });

  await t.test('a turn marker past the longest turn no longer holds', async () => {
    const c = await change(bob, 33, [11], { reviewedHeadSha: HEAD_ONE });
    const turn = (msAgo) => JSON.stringify({ startedAt: new Date(Date.now() - msAgo).toISOString() });
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`,
      [c.id, turn(10 * 60 * 1000)]);
    assert.ok(!(await feed()).includes(c.id), 'a turn 10 minutes in is an update on its way');
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`,
      [c.id, turn(7 * 60 * 60 * 1000)]);
    assert.ok((await feed()).includes(c.id), 'a turn 7 hours old cannot still be running');
    await pool.query(`UPDATE chat_sessions SET active_turn = NULL WHERE id = $1`, [c.id]);
  });

  await t.test('an imported change compares the ask against its PR head', async () => {
    const c = await change(bob, 34, [12], { importedHeadSha: HEAD_ONE, source: 'imported' });
    await ask(c.id, 'queued', { askedHead: HEAD_ONE, issueNumber: 12 });
    assert.ok(!(await feed()).includes(c.id), 'the ask matches the imported PR head');
    await pool.query(`UPDATE chat_sessions SET imported_pr_head_sha = $2 WHERE id = $1`, [c.id, HEAD_TWO]);
    assert.ok((await feed()).includes(c.id), 'the PR head moved: owed again');
  });
});
