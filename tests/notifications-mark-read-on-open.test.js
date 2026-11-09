// #6498: OPENING THE BELL IS READING IT.
//
// The report: "the little dot on the bell stays no matter how many times i
// open the list. read should mean read, the badge should drop." Nothing on
// open wrote `read_at`, so the badge (`unread - messageUnread` plus invites)
// stayed lit forever. These tests pin the four pieces of the fix:
//
//   1. services markRead({ all, keepPlainMessages }) clears exactly what the
//      bell counts — the server's PLAIN_MESSAGE_SQL is kept out — and refuses
//      to combine with older_than_days.
//   2. The route passes `keep_plain_messages` through the mark-all branch and
//      refuses it alongside older_than_days.
//   3. The sheet controller marks read only after a refresh that landed.
//   4. The frontend markReadOnOpen() sends the exact body, adopts the
//      server's counts, leaves plain messages unread, and stays quiet on
//      failure.
//
// Frontend logic is extracted from the shipped source (so tests cannot drift
// from what runs) and exercised against stubs, the notifications-mark-all
// pattern.
//
// Run with: node --test tests/notifications-mark-read-on-open.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifications = require('../src/services/notifications');

const FE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
);
const CONTROLLER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications-sheet-controller.js'),
  'utf8'
);
const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'notifications.js'),
  'utf8'
);

// ── 1. the service clears what the bell counts, plain messages aside ────

function stubPool(rowCount) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      return Promise.resolve({ rowCount, rows: [] });
    },
  };
}

test('markRead({all, keepPlainMessages}) keeps channel and app-less conversation messages unread', async () => {
  const pool = stubPool(5);
  const cleared = await notifications.markRead(pool, 42, { all: true, keepPlainMessages: true });
  assert.equal(cleared, 5);
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /UPDATE notifications AS n SET read_at = NOW\(\)/);
  assert.match(sql, /n\.user_id = \$1/);
  assert.match(sql, /n\.read_at IS NULL/);
  // The predicate countUnreadSplit counts with (#18): a channel message, or
  // a conversation message with no app. An app's own conversation still
  // counts on the bell, so it must still be cleared.
  assert.match(sql, /NOT \(n\.kind = 'channel_message' OR \(n\.kind = 'conversation_message' AND n\.app_id IS NULL\)\)/);
  assert.deepEqual(params, [42], 'user id is the only parameter');
});

test('markRead({all}) without the flag is still the unscoped clear-all', async () => {
  const pool = stubPool(9);
  await notifications.markRead(pool, 42, { all: true });
  const { sql } = pool.calls[0];
  assert.doesNotMatch(sql, /PLAIN_MESSAGE|channel_message/);
});

test('markRead({all, keepPlainMessages, olderThanDays}) throws like kind scoping does', async () => {
  const pool = stubPool(1);
  await assert.rejects(
    () => notifications.markRead(pool, 42, { all: true, keepPlainMessages: true, olderThanDays: 7 }),
    /olderThanDays does not combine with keepPlainMessages/
  );
  assert.equal(pool.calls.length, 0, 'refused before any query runs');
});

// ── 2. the route passes the flag through, and refuses the window ────────

test('route passes keep_plain_messages through the mark-all branch', () => {
  const m = ROUTE_SRC.match(/const cleared = await notifications\.markRead\([\s\S]*?\}\);/);
  assert.ok(m, 'markRead call found');
  assert.match(m[0], /keepPlainMessages: keepPlainMessages === true/,
    'only a literal true enables the narrow clear');
});

test('route refuses keep_plain_messages alongside older_than_days', () => {
  const m = ROUTE_SRC.match(/if \(olderThanDays != null\) \{[\s\S]*?return res\.status\(400\)\.json\(\{ error: 'Invalid older_than_days' \}\);/);
  assert.ok(m, 'older_than_days validation found');
  assert.match(m[0], /keepPlainMessages != null/,
    'the window and the narrow clear are different scopes and do not combine');
});

// ── 3. the controller marks read only after a refresh that landed ───────

test('controller refreshes, then marks read only when the refresh resolved true', () => {
  const m = CONTROLLER_SRC.match(/onOpen: \(\) => Promise\.resolve\(([\s\S]*?)\),\n\}\);/);
  assert.ok(m, 'onOpen definition found');
  assert.match(m[0], /window\.Notifications\?\.refresh\?\.\(\)/, 'refreshes on open');
  assert.match(m[0], /if \(ok && !window\.Notifications\?\._shotOpened\) window\.Notifications\?\.markReadOnOpen\?\.\(\);/,
    'clears only after a landed refresh, and not when the sheet was opened by the shot link');
});

// The shipped onOpen, extracted so the behaviour is exercised rather than
// only its text. `window` is the building function's parameter, so the arrow
// captures the stub it is built with.
function controllerOnOpen(windowStub) {
  const m = CONTROLLER_SRC.match(/onOpen: ([\s\S]*?),\n\}\);/);
  assert.ok(m, 'onOpen definition found');
  return new Function('window', `return (${m[1]});`)(windowStub);
}

function notificationsStub({ refreshResult, shotOpened }) {
  const calls = { refresh: 0, markReadOnOpen: 0 };
  return {
    calls,
    window: {
      Notifications: {
        _shotOpened: shotOpened,
        refresh() { calls.refresh++; return Promise.resolve(refreshResult); },
        markReadOnOpen() { calls.markReadOnOpen++; },
      },
    },
  };
}

test('controller skips marking read when the sheet was opened by the shot link', async () => {
  const { calls, window } = notificationsStub({ refreshResult: true, shotOpened: true });
  await controllerOnOpen(window)();
  assert.equal(calls.refresh, 1, 'still refreshes on open');
  assert.equal(calls.markReadOnOpen, 0, 'a capture is not reading');
});

test('controller marks read once on an ordinary open after a landed refresh', async () => {
  const { calls, window } = notificationsStub({ refreshResult: true, shotOpened: false });
  await controllerOnOpen(window)();
  assert.equal(calls.refresh, 1);
  assert.equal(calls.markReadOnOpen, 1);
});

test('controller marks nothing when the refresh did not land', async () => {
  const { calls, window } = notificationsStub({ refreshResult: false, shotOpened: false });
  await controllerOnOpen(window)();
  assert.equal(calls.refresh, 1);
  assert.equal(calls.markReadOnOpen, 0, 'a failed or superseded refresh clears nothing');
});

// ── 4. markReadOnOpen, taken from the shipped source ────────────────────

function methodBody(name) {
  const re = new RegExp(name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = FE_SRC.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  return m[1];
}

function buildMarkReadOnOpen(body) {
  const run = new Function('Notifications', 'fetch', 'window', 'console', `return (async () => {${body}})();`);
  return (...args) => run(...args);
}

function fixture(overrides = {}) {
  const rendered = { badge: 0, list: 0, title: 0 };
  const N = {
    open: true,
    unread: 3,
    messageUnread: 0,
    items: [
      { id: 1, kind: 'session_done', readAt: null },
      { id: 2, kind: 'channel_message', readAt: null },
      { id: 3, kind: 'conversation_message', appId: null, readAt: null },
      // An app's own conversation counts on the bell, so it is cleared.
      { id: 4, kind: 'conversation_message', appId: 7, readAt: null },
      { id: 5, kind: 'kudos', readAt: '2026-01-01T00:00:00Z' },
    ],
    invites: [],
    _reconcileCompletionTitle() { rendered.title++; },
    _renderBadge() { rendered.badge++; },
    _renderList() { rendered.list++; },
    ...overrides,
  };
  const fetched = [];
  const toasts = [];
  let dots = 0;
  const windowStub = {
    PlatformUI: { toast(msg) { toasts.push(msg); } },
    GroupChat: { reconcileDotsFromNotifications() { dots++; } },
  };
  const warnings = [];
  const consoleStub = { warn(...a) { warnings.push(a); }, error() { throw new Error('console.error on an expected failure'); } };
  return { N, rendered, fetched, toasts, windowStub, consoleStub, warnings, dots: () => dots };
}

const okFetch = (data) => (url, opts) => {
  okFetch.calls.push({ url, opts });
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
};
okFetch.calls = [];

test('markReadOnOpen sends the exact narrow-clear body and adopts the answer', async () => {
  const f = fixture();
  okFetch.calls.length = 0;
  const data = { unread: 2, messageUnread: 2, cleared: 2 };
  const markReadOnOpen = buildMarkReadOnOpen(methodBody('async markReadOnOpen'));
  const ok = await markReadOnOpen(f.N, okFetch(data), f.windowStub, f.consoleStub);

  assert.equal(ok, true);
  assert.equal(okFetch.calls.length, 1);
  assert.equal(okFetch.calls[0].url, '/api/notifications/read');
  assert.deepEqual(JSON.parse(okFetch.calls[0].opts.body), { all: true, keep_plain_messages: true });

  assert.equal(f.N.unread, 2, 'server-reported unread adopted');
  assert.equal(f.N.messageUnread, 2, 'server-reported message count adopted');
  assert.ok(f.N.items[0].readAt, 'a session notification is cleared');
  assert.equal(f.N.items[1].readAt, null, 'a channel message stays the Messages tab\'s');
  assert.equal(f.N.items[2].readAt, null, 'an app-less conversation message stays unread');
  assert.ok(f.N.items[3].readAt, 'an app conversation notification counts on the bell, so it clears');
  assert.equal(f.N.items[4].readAt, '2026-01-01T00:00:00Z', 'already-read timestamps preserved');
  assert.ok(f.rendered.title >= 1 && f.rendered.badge >= 1 && f.rendered.list >= 1,
    'title, badge and list repainted');
  assert.equal(f.dots(), 1, 'in-chat unread dots reconciled');
  assert.deepEqual(f.toasts, [], 'no toast: the person pressed nothing');
});

test('markReadOnOpen sends nothing when the sheet is not open', async () => {
  const f = fixture({ open: false });
  okFetch.calls.length = 0;
  const markReadOnOpen = buildMarkReadOnOpen(methodBody('async markReadOnOpen'));
  assert.equal(await markReadOnOpen(f.N, okFetch({ unread: 0 }), f.windowStub, f.consoleStub), false);
  assert.equal(okFetch.calls.length, 0);
});

test('markReadOnOpen sends nothing when only plain messages are unread', async () => {
  const f = fixture({ unread: 2, messageUnread: 2 });
  okFetch.calls.length = 0;
  const markReadOnOpen = buildMarkReadOnOpen(methodBody('async markReadOnOpen'));
  assert.equal(await markReadOnOpen(f.N, okFetch({ unread: 0 }), f.windowStub, f.consoleStub), false);
  assert.equal(okFetch.calls.length, 0);
});

test('markReadOnOpen sends nothing when only a pending invite is waiting', async () => {
  const f = fixture({ unread: 0, messageUnread: 0, invites: [{ appId: 3 }] });
  okFetch.calls.length = 0;
  const markReadOnOpen = buildMarkReadOnOpen(methodBody('async markReadOnOpen'));
  assert.equal(await markReadOnOpen(f.N, okFetch({ unread: 0 }), f.windowStub, f.consoleStub), false);
  assert.equal(okFetch.calls.length, 0, 'an invite is an action, not something to read');
});

test('markReadOnOpen stays quiet and changes nothing when the clear fails', async () => {
  const f = fixture();
  const markReadOnOpen = buildMarkReadOnOpen(methodBody('async markReadOnOpen'));
  assert.equal(
    await markReadOnOpen(f.N, () => Promise.reject(new TypeError('Failed to fetch')), f.windowStub, f.consoleStub),
    false
  );
  assert.equal(f.N.unread, 3, 'badge count kept');
  assert.equal(f.N.items[0].readAt, null, 'unread marks kept');
  assert.deepEqual(f.toasts, [], 'no toast on a quiet failure');
  assert.equal(f.rendered.badge + f.rendered.list + f.rendered.title, 0, 'nothing repainted');
  assert.ok(f.warnings.length >= 1, 'warned for diagnostics, not console.error');
});

test('markReadOnOpen stays quiet on a non-ok answer', async () => {
  const f = fixture();
  const markReadOnOpen = buildMarkReadOnOpen(methodBody('async markReadOnOpen'));
  const res = await markReadOnOpen(
    f.N,
    () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    f.windowStub, f.consoleStub
  );
  assert.equal(res, false);
  assert.equal(f.N.unread, 3);
  assert.equal(f.N.items[0].readAt, null);
  assert.deepEqual(f.toasts, []);
});

// ── 5. the query itself, against a real PostgreSQL ──────────────────────
//
// The stub tests pin the SQL text; this runs the same call through the real
// service against the full schema, so a predicate that reads right but
// clears the wrong rows fails here. Skipped (unless TEST_DATABASE_URL is
// set) where no PostgreSQL is available.

test('markRead({all, keepPlainMessages}) against a real database', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const crypto = require('node:crypto');
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `notif_open_read_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  const { rows: [viewer] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('bell_reader', 'x') RETURNING id`
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by) VALUES ('Plant Pal', 'plant-pal', $1) RETURNING id`,
    [viewer.id]
  );
  const insert = (kind, appId) => pool.query(
    `INSERT INTO notifications (user_id, kind, app_id) VALUES ($1, $2, $3) RETURNING id`,
    [viewer.id, kind, appId]
  );
  const channel = (await insert('channel_message', null)).rows[0].id;
  const plainConversation = (await insert('conversation_message', null)).rows[0].id;
  const appConversation = (await insert('conversation_message', app.id)).rows[0].id;
  const mention = (await insert('mention', null)).rows[0].id;

  const cleared = await notifications.markRead(pool, viewer.id, { all: true, keepPlainMessages: true });
  assert.equal(cleared, 2, 'only the two rows the bell counts were cleared');

  const { rows } = await pool.query(
    `SELECT id, read_at FROM notifications WHERE user_id = $1 ORDER BY id`, [viewer.id]
  );
  const read = new Map(rows.map((r) => [r.id, r.read_at]));
  assert.equal(read.get(channel), null, 'a channel message stays for the Messages tab');
  assert.equal(read.get(plainConversation), null, 'an app-less conversation message stays too');
  assert.ok(read.get(appConversation), 'an app conversation counts on the bell, so it clears');
  assert.ok(read.get(mention), 'a mention clears');
});
