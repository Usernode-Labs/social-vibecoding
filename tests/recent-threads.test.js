'use strict';

// #6785: the notifications sheet's Recent threads tab, read side.
//
// The sheet's own feed holds only notifications sent TO the viewer, and the
// bell skips the viewer's own actions, so a person's own posts and votes leave
// no row there. services/recent-threads.js therefore reads the threads
// themselves, by the rule a thread's followers are worked out by, less the two
// branches that are not taking part (Notify me / a lapsed Claim) and plus the
// two mention kinds.
//
// What this pins:
//   1. Against a real PostgreSQL schema: a thread the viewer filed, wrote in,
//      voted in, built in, or was mentioned in is listed once, whichever
//      branches match; Notify-me alone and a muted thread are not; a thread in
//      a private project they are not in is not; a merged-away thread is
//      listed as the thread it became; the newest activity comes first, and
//      the cursor pages without repeating a row.
//   2. The statement itself carries every participation branch and no
//      thread_followers inclusion branch.
//   3. The route: 401 when signed out, a limit clamped to 1..50 (default 30),
//      and a rejected bad cursor.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/recent-threads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the threads a person took part in, against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `recent_threads_${crypto.randomBytes(6).toString('hex')}`;
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
  const recentThreads = require('../src/services/recent-threads');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username) => one(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [username]);
  const ada = await user('rt_ada');
  const bob = await user('rt_bob');
  const openApp = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Seed swap', 'rt-open', 'running', $1, 'public', 'public') RETURNING id`, [bob.id]);
  const privateApp = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Private club', 'rt-private', 'running', $1, 'private', 'private') RETURNING id`, [bob.id]);

  // threads.id is BIGSERIAL: pg hands it back as a string, and the service's
  // row says it as a number.
  const thread = async (app, number, createdAt) => ({ id: Number((await one(
    `INSERT INTO threads (app_id, number, kind, title, state, created_at)
     VALUES ($1, $2, 'work', $3, 'open', $4)
     RETURNING id`, [app.id, number, `Thread ${number}`, createdAt])).id) });

  const mergedThread = async (app, number, createdAt, into) => ({ id: Number((await one(
    `INSERT INTO threads (app_id, number, kind, title, state, created_at, merged_into)
     VALUES ($1, $2, 'work', $3, 'open', $4, $5)
     RETURNING id`, [app.id, number, `Thread ${number}`, createdAt, into])).id) });

  // Whole hours on one day, so the order is explicit and no two threads tie.
  const at = (hour) => new Date(Date.UTC(2026, 10, 1, hour)).toISOString();
  // A: filed (a request by ada).
  const filed = await thread(openApp, 1, at(1));
  await one(
    `INSERT INTO requests (app_id, number, title, created_by, thread_id, updated_at)
     VALUES ($1, 1, 'Water reminders by plant', $2, $3, $4) RETURNING id`,
    [openApp.id, ada.id, filed.id, at(2)]);
  // B: wrote in it.
  const wrote = await thread(openApp, 2, at(3));
  await one(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_id, created_at)
     VALUES ($1, $2, 'I can try it on my phone', $3, $4) RETURNING id`,
    [openApp.id, ada.id, wrote.id, at(4)]);
  // C: mentioned in it (a 'mention' notification pointing at a message).
  const mentioned = await thread(openApp, 3, at(5));
  const mentionMessage = await one(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_id, created_at)
     VALUES ($1, $2, '@rt_ada could you look?', $3, $4) RETURNING id`,
    [openApp.id, bob.id, mentioned.id, at(6)]);
  await one(
    `INSERT INTO notifications (user_id, app_id, kind, chat_message_id) VALUES ($1, $2, 'mention', $3) RETURNING id`,
    [ada.id, openApp.id, mentionMessage.id]);
  // D: named in a request (issue_mention carries its number in detail).
  const namedInRequest = await thread(openApp, 4, at(7));
  await one(
    `INSERT INTO issues (app_id, github_issue_number, title, kind, created_by, thread_id)
     VALUES ($1, 4, 'Rename the project', 'general', $2, $3) RETURNING id`,
    [openApp.id, bob.id, namedInRequest.id]);
  await one(
    `INSERT INTO notifications (user_id, app_id, kind, detail) VALUES ($1, $2, 'issue_mention', '4') RETURNING id`,
    [ada.id, openApp.id]);
  // E: only chose Notify me — a subscription, not taking part.
  const followed = await thread(openApp, 5, at(8));
  await pool.query(
    'INSERT INTO thread_followers (thread_id, user_id) VALUES ($1, $2)', [followed.id, ada.id]);
  // F: wrote in it, then muted it.
  const muted = await thread(openApp, 6, at(9));
  await one(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_id, created_at)
     VALUES ($1, $2, 'One more thing', $3, $4) RETURNING id`,
    [openApp.id, ada.id, muted.id, at(10)]);
  await pool.query(
    'INSERT INTO thread_followers (thread_id, user_id, muted_at) VALUES ($1, $2, NOW())',
    [muted.id, ada.id]);
  // G: wrote in a private project's thread she is not a member of.
  const hidden = await thread(privateApp, 7, at(11));
  await one(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_id, created_at)
     VALUES ($1, $2, 'Secret words', $3, $4) RETURNING id`,
    [privateApp.id, ada.id, hidden.id, at(12)]);
  // H: a thread merged into another one, answered by the thread it became.
  const target = await thread(openApp, 8, at(13));
  const mergedAway = await mergedThread(openApp, 9, at(14), target.id);
  await one(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_id, created_at)
     VALUES ($1, $2, 'Same discussion', $3, $4) RETURNING id`,
    [openApp.id, ada.id, mergedAway.id, at(15)]);

  const rows = await recentThreads.listRecentThreads(pool, ada.id, { limit: 30 });
  const ids = rows.map((row) => row.threadId);
  // #6816: the page says how many there are in all, which the cursor's own
  // cut does not shrink — Home's card counts what it could not list.
  const page = await recentThreads.recentThreadsPage(pool, ada.id, { limit: 2 });
  const later = await recentThreads.recentThreadsPage(pool, ada.id, {
    limit: 2, before: page.threads[page.threads.length - 1].lastAt,
    beforeId: page.threads[page.threads.length - 1].threadId,
  });
  assert.equal(page.threads.length, 2);
  assert.equal(page.total, rows.length, 'the whole list, not the page');
  assert.equal(later.total, rows.length, 'and the same on a later page');
  assert.ok(ids.includes(filed.id), 'a request she filed is listed');
  assert.ok(ids.includes(wrote.id), 'a thread she wrote in is listed');
  assert.ok(ids.includes(mentioned.id), 'a thread she was @mentioned in is listed');
  assert.ok(ids.includes(namedInRequest.id), 'a request she was named in is listed');
  assert.ok(!ids.includes(followed.id), 'Notify me alone is not taking part');
  assert.ok(!ids.includes(muted.id), 'a muted thread is not listed, even one she wrote in');
  assert.ok(!ids.includes(hidden.id), 'a private project she is not in is not listed');
  assert.ok(!ids.includes(mergedAway.id), 'a merged-away thread is not its own row');
  assert.ok(ids.includes(target.id), 'it is listed as the thread it was merged into');
  assert.equal(new Set(ids).size, ids.length, 'one row per thread');

  // Newest activity first: the merged thread's newest message (at 15) leads
  // the named request (at 7, the thread's own creation at 7 wins over its
  // issue's), then the mention (at 6) and the written thread (at 4), and the
  // filed request (at 2).
  assert.deepEqual(
    ids.slice(0, 5),
    [target.id, namedInRequest.id, mentioned.id, wrote.id, filed.id],
  );

  // The row says what the page it opens says.
  const filedRow = rows.find((row) => row.threadId === filed.id);
  assert.equal(filedRow.kind, 'request');
  assert.equal(filedRow.number, 1);
  assert.equal(filedRow.title, 'Water reminders by plant');
  assert.equal(filedRow.appSlug, 'rt-open');
  assert.equal(filedRow.href, '#app/rt-open/dev/issues/1');
  const wroteRow = rows.find((row) => row.threadId === wrote.id);
  assert.equal(wroteRow.kind, 'change', 'a thread with no request is its change, or its number');
  assert.equal(wroteRow.number, 2, 'the thread\'s own number is the fallback');

  // The cursor pages without repeating a row.
  const firstPage = await recentThreads.listRecentThreads(pool, ada.id, { limit: 2 });
  assert.equal(firstPage.length, 2);
  const last = firstPage[firstPage.length - 1];
  const nextPage = await recentThreads.listRecentThreads(pool, ada.id, {
    limit: 2, before: last.lastAt, beforeId: last.threadId,
  });
  assert.ok(nextPage.length > 0);
  assert.ok(!nextPage.some((row) => firstPage.some((seen) => seen.threadId === row.threadId)));
});

test('the statement reads every way of taking part, and never follows', () => {
  const { participatedSql } = require('../src/services/recent-threads');
  const sql = participatedSql('$1');
  assert.match(sql, /FROM requests r\s+WHERE r\.created_by/);
  assert.match(sql, /FROM issues i\s+WHERE i\.created_by/);
  assert.match(sql, /homeroom_bot_requesters/);
  assert.match(sql, /FROM chat_sessions s[\s\S]*?s\.user_id = \$1[\s\S]*?is_headless = FALSE/);
  assert.match(sql, /FROM pr_votes v/);
  assert.match(sql, /FROM issue_votes v/);
  assert.match(sql, /FROM chat_messages m[\s\S]*?m\.user_id = \$1[\s\S]*?msg_type = 'message'[\s\S]*?deleted_at IS NULL/);
  assert.match(sql, /n\.kind = 'mention'/);
  assert.match(sql, /n\.kind = 'issue_mention'/);
  assert.match(sql, /n\.detail ~ '\^\[0-9\]\{1,9\}\$'/);
  assert.doesNotMatch(sql, /thread_followers/, 'Notify me is a subscription, not taking part');
  assert.doesNotMatch(sql, /issue_claims/, 'a lapsed Claim is not something they did');
});

// ── the route ───────────────────────────────────────────────────────────

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [], rowCount: 0 });
let queries = [];
const stubPool = { query: (...args) => poolQueryHandler(...args) };

const routePath = require.resolve('../src/routes/notifications');
const prevGetPool = poolMod.getPool;
poolMod.getPool = () => stubPool;
const { notificationsRoutes } = require(routePath);
poolMod.getPool = prevGetPool;

function reset() {
  queries = [];
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
}

async function startServer({ anonymous = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!anonymous) req.user = { id: 5, username: 'alice' };
    next();
  });
  app.use(notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const urlFor = (server, path) => `http://127.0.0.1:${server.address().port}${path}`;

test('the route answers 401 when signed out', async () => {
  reset();
  const server = await startServer({ anonymous: true });
  try {
    const res = await fetch(urlFor(server, '/api/me/recent-threads'));
    assert.equal(res.status, 401);
    assert.equal(queries.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the route clamps its limit and keeps its no-store cache header', async () => {
  for (const [asked, expected] of [[undefined, 30], ['500', 50], ['0', 1], ['abc', 30]]) {
    reset();
    const server = await startServer();
    try {
      const qs = asked === undefined ? '' : `?limit=${asked}`;
      const res = await fetch(urlFor(server, `/api/me/recent-threads${qs}`));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      const body = await res.json();
      assert.deepEqual(body.threads, []);
      assert.equal(body.total, 0, 'how many threads in all (#6816)');
      assert.equal(body.hasMore, false);
      assert.equal(body.nextBefore, null);
      assert.equal(queries.length, 1);
      assert.equal(queries[0].params[1], expected, `limit ${asked} is clamped to ${expected}`);
      assert.equal(queries[0].params[3], null, 'no cursor on a first page');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('a cursor the route cannot read is refused rather than run', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/me/recent-threads?before=not-a-date&before_id=3'));
    assert.equal(res.status, 400);
    assert.equal(queries.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a cursor is passed through, and a full page answers a next cursor', async () => {
  reset();
  const at = '2026-11-01T02:00:00.000Z';
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    return {
      rows: [{
        id: 8, kind: 'work', number: 8, title: 'Thread 8', created_at: at,
        slug: 'rt-open', app_name: 'Seed swap', icon_emoji: null, icon_image_id: null,
        request_number: null, request_title: null, pr_number: 88,
        change_title: 'Show who lent each book', decision_id: null, last_at: at,
      }],
      rowCount: 1,
    };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, `/api/me/recent-threads?limit=1&before=${encodeURIComponent(at)}&before_id=9`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hasMore, true);
    assert.equal(body.total, 1, 'the row the stub answered stands for the whole list');
    assert.deepEqual(body.nextBefore, { lastAt: at, id: 8 });
    assert.deepEqual(queries[0].params.slice(3), [at, 9]);
    assert.deepEqual(body.threads[0], {
      threadId: 8,
      kind: 'change',
      number: 88,
      title: 'Show who lent each book',
      appSlug: 'rt-open',
      appName: 'Seed swap',
      appIconEmoji: null,
      appIconUrl: null,
      lastAt: at,
      href: '#app/rt-open/dev/changes/88',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
