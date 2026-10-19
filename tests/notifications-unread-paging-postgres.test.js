'use strict';

// #5527: the bell said 46 unread and the Unread list showed 1.
//
// The badge is countUnread, which counts every unread row on the account.
// The sheet's first page is the newest 100 rows of the WHOLE feed, read and
// unread, so an unread row behind a long run of read ones was never loaded
// and the Unread tab could not show it. `listForUser({ unreadOnly: true })`
// pages the unread rows only, under countUnread's filters.
//
// This runs that query against the FULL PostgreSQL schema, through the real
// code, and pins the thing that makes the two numbers agree: paging
// `unreadOnly` to exhaustion returns EXACTLY the rows countUnread counts —
// no read row, no duplicate, nothing the badge did not count and nothing it
// did count left out. The excluded cases are seeded too (a decided ask on a
// merged change, a pr_merged row on a merged session, a parked kudos row and
// a row from a conversation the user left), because those are precisely the
// filters that could drift apart.
//
// Run with: node --test tests/notifications-unread-paging-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('unread paging returns exactly what the badge counts', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `notif_unread_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  // Boot-idempotent, like every real deployment restart.
  await pool.query(schema);
  await pool.query(schema);

  const notifications = require('../src/services/notifications');

  const inserted = await pool.query(
    `INSERT INTO users (username, password) VALUES ('unread_pager', 'x') RETURNING id`
  );
  const userId = inserted.rows[0].id;
  const other = await pool.query(
    `INSERT INTO users (username, password) VALUES ('unread_other', 'x') RETURNING id`
  );
  const otherId = other.rows[0].id;

  // A merged change behind the decided ask and the pr_merged row.
  const mergedSession = (await pool.query(
    `INSERT INTO chat_sessions (user_id, status) VALUES ($1, 'merged') RETURNING id`, [userId]
  )).rows[0].id;
  // A conversation this user has LEFT: its notification is not theirs to see
  // any more, so neither the badge nor the list may count it.
  const leftConversation = (await pool.query(
    `INSERT INTO conversations (kind, title, created_by) VALUES ('group', 'Left behind', $1) RETURNING id`,
    [userId]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'left')`,
    [leftConversation, userId]
  );

  const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + seconds * 1000);
  const insert = (kind, { read = false, sessionId = null, conversationId = null, when } = {}) => pool.query(
    `INSERT INTO notifications (user_id, kind, session_id, conversation_id, read_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, kind, sessionId, conversationId, read ? when : null, when]
  );

  // The bug's shape: 150 READ rows are newer than the 40 UNREAD ones, so the
  // newest page of the feed (100 rows) holds no unread row at all.
  const readIds = [];
  for (let i = 0; i < 150; i += 1) {
    const when = at(1000 + i);
    readIds.push((await insert('mention', { read: true, when })).rows[0].id);
  }
  const unreadIds = [];
  for (let i = 0; i < 40; i += 1) {
    const when = at(100 + i);
    unreadIds.push((await insert('mention', { when })).rows[0].id);
  }

  // What the filters must leave out, seeded unread and looking countable.
  const decidedAsk = (await insert('pr_proposed', {
    sessionId: mergedSession, when: at(500),
  })).rows[0].id;
  const mergedNews = (await insert('pr_merged', {
    sessionId: mergedSession, when: at(501),
  })).rows[0].id;
  const parkedKudos = (await insert('kudos', { when: at(502) })).rows[0].id;
  const leftRow = (await insert('conversation_message', {
    conversationId: leftConversation, when: at(503),
  })).rows[0].id;
  // Someone else's row is not in this user's feed either.
  await pool.query(
    `INSERT INTO notifications (user_id, kind, created_at) VALUES ($1, 'mention', $2)`,
    [otherId, at(504)]
  );

  await t.test('the newest feed page holds no unread row, which is the reported bug', async () => {
    const page = await notifications.listForUser(pool, userId, { limit: 100 });
    assert.equal(page.length, 100);
    assert.equal(page.filter((row) => row.read_at === null).length, 0,
      'the first page is all read rows: the Unread tab filtered it to nothing');
  });

  await t.test('paging unreadOnly reaches exactly the badge\'s rows', async () => {
    const badge = await notifications.countUnread(pool, userId);
    assert.equal(badge, 40, 'the badge counts the 40 older unread rows and nothing else');

    const seen = [];
    let before = null;
    for (let page = 0; page < 50; page += 1) {
      const rows = await notifications.listForUser(pool, userId, {
        unreadOnly: true, limit: 10, before,
      });
      seen.push(...rows);
      if (rows.length < 10) break;
      const last = rows[rows.length - 1];
      before = { createdAt: last.created_at, id: last.id };
    }

    assert.equal(seen.length, badge,
      'the pages to exhaustion hold every row the badge counted');
    const ids = seen.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, 'no row is returned twice across the cursor');
    assert.deepEqual([...ids].sort((a, b) => a - b), [...unreadIds].sort((a, b) => a - b),
      'exactly the unread rows, and none of the read ones');
    for (const excluded of [decidedAsk, mergedNews, parkedKudos, leftRow]) {
      assert.ok(!ids.includes(excluded), `filtered row ${excluded} stays out of the page`);
    }
    assert.ok(!ids.some((id) => readIds.includes(id)), 'no read row is paged as unread');
    assert.ok(seen.every((row) => row.read_at === null),
      'the settle expression does not hand back a row it marked read');
  });

  await t.test('unreadOnly without a cursor starts at the newest unread row', async () => {
    const first = await notifications.listForUser(pool, userId, { unreadOnly: true, limit: 3 });
    assert.equal(first.length, 3);
    assert.deepEqual(first.map((row) => row.id), [...unreadIds].reverse().slice(0, 3));
  });
});
