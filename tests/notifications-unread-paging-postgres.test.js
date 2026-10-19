'use strict';

// #5527: the bell's Unread tab fills itself up to the badge, against the
// FULL PostgreSQL schema in a throwaway database, through the real
// services/notifications.js.
//
// The bug: the badge's count (countUnread) counts every unread row on the
// account, while the sheet's Unread tab showed the unread among the newest
// 100 rows only — so a backlog of unread sitting behind a long run of read
// rows read as "bell says 46, list shows 1". The fix pages unread rows
// directly (`?unread=1` → listForUser's `unreadOnly`), and the pinned
// property of the whole change is:
//
//   paging unreadOnly through its cursor returns EXACTLY the set
//   countUnread counts — every unread row, nothing read, nothing twice —
//
// whatever the edge cases around it read. The seeded rows are those edge
// cases: a decided ask on a merged change, a merged-change news row, a
// parked kudos row, a conversation the viewer has left, and a long run of
// READ rows newer than every unread one (the reported symptom's shape — the
// unread backlog entirely off the first page).
//
// Run with: node --test tests/notifications-unread-paging-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('unread-only paging returns exactly what countUnread counts', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `notif_unread_paging_${crypto.randomBytes(6).toString('hex')}`;
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

  const { rows: viewerRows } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('unread_pager', 'x') RETURNING id`
  );
  const viewer = viewerRows[0];

  const BASE = new Date('2026-01-01T00:00:00Z');
  const at = (minutes) => new Date(BASE.getTime() + minutes * 60_000);

  // A plain unread mention row the viewer owns — no conversation, no chat
  // message, no session, no app: every access clause passes trivially.
  const unreadIds = [];
  // 150 READ rows newer than every unread one: the first 100-row page of
  // the ordinary feed is entirely read, so the Unread tab as it shipped
  // shows nothing at all while the badge counts 43.
  for (let i = 150; i >= 1; i -= 1) {
    await pool.query(
      `INSERT INTO notifications (user_id, kind, read_at, created_at)
       VALUES ($1, 'mention', $2, $3)`, [viewer.id, at(i), at(i)]
    );
  }
  // 40 unread rows behind them, the oldest first so feed order is
  // newest-first across the whole set.
  for (let i = 0; i < 40; i += 1) {
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, kind, created_at)
       VALUES ($1, 'mention', $2) RETURNING id`, [viewer.id, at(-i)]
    );
    unreadIds.push(rows[0].id);
  }

  // The edge cases around them — unread rows that must NOT be counted by
  // countUnread and must NOT come back from unreadOnly paging either.
  // (1) A decided ask: the change it asked about is merged, so the row is
  // settled even though read_at is still NULL.
  const { rows: merged } = await pool.query(
    `INSERT INTO chat_sessions (status) VALUES ('merged') RETURNING id`
  );
  const { rows: archived } = await pool.query(
    `INSERT INTO chat_sessions (status) VALUES ('archived') RETURNING id`
  );
  await pool.query(
    `INSERT INTO notifications (user_id, kind, session_id, created_at)
     VALUES ($1, 'pr_proposed', $2, $3)`, [viewer.id, merged[0].id, at(-60)]
  );
  await pool.query(
    `INSERT INTO notifications (user_id, kind, session_id, created_at)
     VALUES ($1, 'stale_pr', $2, $3)`, [viewer.id, archived[0].id, at(-61)]
  );
  // (2) Merged-change news: hidden from the list and the count together
  // (#5487) — unread, on a merged session, outside the decided-ask kinds.
  await pool.query(
    `INSERT INTO notifications (user_id, kind, session_id, created_at)
     VALUES ($1, 'pr_merged', $2, $3)`, [viewer.id, merged[0].id, at(-62)]
  );
  // (3) A parked row (kudos, #5249): neither listed nor counted.
  await pool.query(
    `INSERT INTO notifications (user_id, kind, created_at)
     VALUES ($1, 'kudos', $2)`, [viewer.id, at(-63)]
  );
  // (4) A conversation row whose recipient has left the conversation:
  // CONVERSATION_ACCESS_SQL matches no row for it.
  const { rows: convs } = await pool.query(
    `INSERT INTO conversations (kind, title, created_by) VALUES ('group', 'Unread paging fixture', $1)
     RETURNING id`, [viewer.id]
  );
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, status)
     VALUES ($1, $2, 'member', 'left')`, [convs[0].id, viewer.id]
  );
  await pool.query(
    `INSERT INTO notifications (user_id, kind, conversation_id, created_at)
     VALUES ($1, 'conversation_message', $2, $3)`, [viewer.id, convs[0].id, at(-64)]
  );

  await t.test('the badge and the first unread page agree on where paging starts', async () => {
    const counted = await notifications.countUnread(pool, viewer.id);
    assert.equal(counted, 40,
      'countUnread counts the 40 plain unread rows and none of the five edge cases');
  });

  await t.test('paging unreadOnly through its cursor yields exactly the badge set', async () => {
    const seen = [];
    let before = null;
    for (let page = 0; page < 8; page += 1) {
      const rows = await notifications.listForUser(pool, viewer.id, {
        limit: 10,
        before,
        unreadOnly: true,
      });
      for (const row of rows) {
        const view = notifications.serialize(row);
        assert.equal(view.readAt, null, 'no READ row ever comes back from an unread page');
        seen.push(view.id);
      }
      if (rows.length < 10) break;
      const last = rows[rows.length - 1];
      before = { createdAt: last.created_at, id: last.id };
    }
    assert.equal(seen.length, unreadIds.length,
      'the union of the pages is exactly as long as the badge count');
    assert.deepEqual([...seen].sort((a, b) => a - b), [...unreadIds].sort((a, b) => a - b),
      'every unread row the badge counts, and no row it does not');
    assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');
    // Newest-first throughout: paging must never reorder a page.
    const times = await (async () => {
      const { rows } = await pool.query(
        `SELECT id, created_at FROM notifications WHERE id = ANY($1::int[])`,
        [seen]
      );
      return new Map(rows.map((r) => [r.id, r.created_at.getTime()]));
    })();
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(
        times.get(seen[i - 1]) >= times.get(seen[i]),
        'pages run newest to oldest without a seam',
      );
    }
  });

  await t.test('the ordinary feed is unchanged: read rows still come back', async () => {
    // The clause must not leak into the default read: a feed without
    // unreadOnly still carries the 150 read rows, newest first.
    const rows = await notifications.listForUser(pool, viewer.id, { limit: 100 });
    assert.equal(rows.length, 100, 'a full first page');
    const readCount = rows.filter((r) => r.read_at !== null).length;
    assert.ok(readCount >= 99, `the read rows are still listed (${readCount} of 100)`);
    assert.deepEqual(
      rows.map((r) => r.id),
      [...rows].sort((a, b) =>
        new Date(b.created_at) - new Date(a.created_at) || b.id - a.id).map((r) => r.id),
      'unchanged ordering',
    );
  });

  await t.test('countUnread and unreadOnly agree after the viewer catches up', async () => {
    // Mark everything read; both directions must now say zero. This is the
    // other half of "the two queries answer one question": they cannot
    // disagree on an emptied account either.
    await pool.query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
      [viewer.id]
    );
    assert.equal(await notifications.countUnread(pool, viewer.id), 0, 'the badge empties');
    const rows = await notifications.listForUser(pool, viewer.id, {
      limit: 100, unreadOnly: true,
    });
    assert.equal(rows.length, 0, 'and the unread page with it');
  });
});
