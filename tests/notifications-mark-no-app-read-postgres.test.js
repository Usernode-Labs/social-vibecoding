'use strict';

// #6579: the Unread tab's "Across Homeroom" group Mark read.
//
// The group of notifications that belong to no project (account notices,
// people, admin notices) now has the same Mark read a project's group has. It
// clears every unread notification with no app, including rows a client has
// not paged in, while every project's rows and the plain messages the
// Messages tab owns stay unread.
//
//  1. markReadForNoApp runs the real UPDATE against the PostgreSQL schema:
//     it is scoped to the user, to `app_id IS NULL`, and to the rows that are
//     not plain messages. A string match alone would not prove that.
//  2. POST /api/notifications/read `{ no_app: true }` calls it, replies with
//     the split counts, and refuses the flag beside any other scope.
//
// Run with: node --test tests/notifications-mark-no-app-read-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const notifications = require('../src/services/notifications');

// ── 1. the service, against the real schema ────────────────────────────

test('markReadForNoApp clears the user\'s unread app-less rows, not projects or plain messages', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'mark_no_app_read_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  const { rows: [viewer] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('no_app_reader', 'x') RETURNING id"
  );
  const { rows: [other] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('no_app_other', 'x') RETURNING id"
  );
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, created_by, status) VALUES ('Notes', 'notes-6579', $1, 'running') RETURNING id",
    [viewer.id]
  );
  const insert = (userId, bank, kind, readAt = null) => pool.query(
    `INSERT INTO notifications (user_id, app_id, kind, read_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, bank, kind, readAt]
  );

  // The app-less group's unread rows: these clear.
  await insert(viewer.id, null, 'friend_request');
  await insert(viewer.id, null, 'kudos');
  // A project's row, a plain conversation message, a channel message, an
  // app-less conversation that carries a project, and an already-read row:
  // none of these clear.
  await insert(viewer.id, app.id, 'check_failed');
  await insert(viewer.id, null, 'conversation_message');
  await insert(viewer.id, null, 'channel_message');
  await insert(viewer.id, app.id, 'conversation_message');
  await insert(viewer.id, null, 'kudos', new Date('2026-01-01T00:00:00Z'));
  // Another person's app-less unread row: never the caller's.
  await insert(other.id, null, 'friend_request');

  const cleared = await notifications.markReadForNoApp(pool, viewer.id);
  assert.equal(cleared, 2, 'only the viewer\'s unread app-less notifications');

  const rows = (await pool.query(
    'SELECT kind, app_id, read_at FROM notifications WHERE user_id = $1 ORDER BY id',
    [viewer.id]
  )).rows;
  assert.ok(rows[0].read_at, 'the friend request cleared');
  assert.ok(rows[1].read_at, 'the app-less kudos cleared');
  assert.equal(rows[2].read_at, null, 'a project\'s row stays unread');
  assert.equal(rows[3].read_at, null, 'a plain conversation message stays unread');
  assert.equal(rows[4].read_at, null, 'a channel message stays unread');
  assert.equal(rows[5].read_at, null, 'a conversation carrying a project stays unread');
  assert.equal(rows[6].read_at.toISOString(), '2026-01-01T00:00:00.000Z', 'a read row keeps its timestamp');

  const untouched = (await pool.query(
    'SELECT read_at FROM notifications WHERE user_id = $1', [other.id]
  )).rows;
  assert.equal(untouched[0].read_at, null, 'another person\'s rows are not the caller\'s');

  assert.equal(await notifications.markReadForNoApp(pool, viewer.id), 0, 'idempotent: nothing left to clear');
  assert.equal(await notifications.markReadForNoApp(pool, null), 0, 'no user, nothing run');
});

// ── 2. the route ───────────────────────────────────────────────────────

const poolMod = require('../src/db/pool');
let queries = [];
const stubPool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [{ m: 1, c: 4 }], rowCount: 0 };
  },
};

const routePath = require.resolve('../src/routes/notifications');
const prevGetPool = poolMod.getPool;
poolMod.getPool = () => stubPool;
const { notificationsRoutes } = require(routePath);
poolMod.getPool = prevGetPool;

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 5, username: 'alice' };
    next();
  });
  app.use(notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function postRead(server, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const isNoAppUpdate = (q) => /app_id IS NULL/.test(q.sql) && /UPDATE notifications/.test(q.sql);

test('POST { no_app: true } clears the caller\'s app-less rows and replies with the split counts', async () => {
  queries = [];
  const server = await startServer();
  try {
    const { status, body } = await postRead(server, { no_app: true });
    assert.equal(status, 200);
    assert.equal(body.cleared, 0, 'the stub cleared none');
    assert.equal(typeof body.unread, 'number');
    assert.equal(typeof body.messageUnread, 'number');
    const update = queries.find(isNoAppUpdate);
    assert.ok(update, 'the app-less clear ran');
    assert.match(update.sql, /user_id = \$1/);
    assert.match(update.sql, /n\.app_id IS NULL/);
    assert.match(update.sql, /read_at IS NULL/);
    assert.match(update.sql, /channel_message/, 'plain messages stay out of it');
    assert.deepEqual(update.params, [5], 'the caller\'s id, nothing else');
  } finally {
    server.close();
  }
});

test('POST { no_app: true } is refused beside another scope rather than dropped', async () => {
  const server = await startServer();
  try {
    for (const body of [
      { no_app: true, app_id: 3 },
      { no_app: true, id: 3 },
      { no_app: true, ids: [1, 2] },
      { no_app: true, conversation_id: 3 },
      { no_app: true, session_id: 3 },
      { no_app: true, chat_message_id: 3 },
      { all: true, older_than_days: 7, no_app: true },
    ]) {
      queries = [];
      const { status } = await postRead(server, body);
      assert.equal(status, 400, `${JSON.stringify(body)} is refused`);
      assert.equal(queries.filter(isNoAppUpdate).length, 0, 'and nothing was cleared');
    }
  } finally {
    server.close();
  }
});
