'use strict';

// #5974: Settings › Linked devices, the Browsers group. What this pins about
// src/services/linked-browsers.js against the real `sessions` table:
//
//   - a linked browser is one live session row of the account that is not a
//     phone's (no native incarnation); an expired row, a phone's row or
//     another account's is no row;
//   - a row carries a digest prefix as its id, never the token; what the
//     browser is, from the short class kept at sign-in; its dates; and
//     `current` for the browser the page is open in, which comes first;
//   - signing out deletes exactly that row of this account, says whether it
//     was the caller's own, and leaves every other row, this account's and
//     anyone else's, alone;
//   - signing out another account's browser, a phone, a malformed id or one
//     already gone changes nothing and answers 0 (the route's 404).
//
// Run with: TEST_DATABASE_URL=... node --test tests/linked-browsers-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');

const {
  listLinkedBrowsers, signOutBrowser, isBrowserSessionId, classifyUserAgent,
} = require('../src/services/linked-browsers');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';
const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

// The table as the migrations build it: its CREATE and every column added
// to it since, in history order, so the suite reads the columns #5974 added.
// A column's reference to a native-session table is dropped: that table is
// not built here, and the service reads only the incarnation id's presence.
function sessionsDdl() {
  const create = schemaSql.match(/CREATE TABLE IF NOT EXISTS sessions \([\s\S]*?\n\);/);
  if (!create) throw new Error('schema.sql no longer contains sessions');
  const alters = [...schemaSql.matchAll(/^ALTER TABLE sessions ADD COLUMN IF NOT EXISTS [^;]+;/gm)]
    .map((m) => m[0].replace(/\s+REFERENCES native_session_\w+\s*\([^)]*\)(\s+ON DELETE [A-Z ]+?)?(?=\s*;)/, ''));
  assert.ok(alters.some((sql) => /user_agent_class TEXT/.test(sql)), 'the migration adds user_agent_class');
  assert.ok(alters.some((sql) => /last_seen_at TIMESTAMPTZ/.test(sql)), 'the migration adds last_seen_at');
  return [create[0], ...alters];
}

const STUB_DDL = 'CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT NOT NULL);';

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }
  const schema = `linked_browsers_test_${process.pid}`;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: DSN,
    connectionTimeoutMillis: 3000,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(STUB_DDL);
    for (const ddl of sessionsDdl()) await pool.query(ddl);
    await run(pool);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

const idOf = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);

async function addUser(pool, id) {
  await pool.query('INSERT INTO users (id, username) VALUES ($1, $2)', [id, `browser-owner-${id}`]);
}

// One sign-in: a session row as routes/auth.js writes it, with the dates
// moved as the test needs. A phone's row carries the incarnation id its
// native credential gave it.
async function signIn(pool, { userId, userAgent = null, daysAgo = 1, seenDaysAgo = null, expired = false, native = false }) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at, created_at, user_agent_class, last_seen_at, native_session_incarnation_id)
     VALUES ($1, $2, NOW() + make_interval(days => $3), NOW() - make_interval(days => $4), $5,
             CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $6::int) END, $7)`,
    [token, userId, expired ? -1 : 90, daysAgo, classifyUserAgent(userAgent), seenDaysAgo,
      native ? `nsw_${Buffer.alloc(32, 7).toString('base64url')}` : null],
  );
  return token;
}

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const FIREFOX_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

test('a browser session id is sixteen hex digits and nothing else', () => {
  assert.equal(isBrowserSessionId('0123456789abcdef'), true);
  assert.equal(isBrowserSessionId('0123456789ABCDEF'), false);
  assert.equal(isBrowserSessionId('0123456789abcde'), false);
  assert.equal(isBrowserSessionId(crypto.randomBytes(32).toString('hex')), false, 'never a whole token');
  assert.equal(isBrowserSessionId(undefined), false);
});

test('the list is the account\'s own live browsers, this browser first, with no token in it', async (t) => {
  await withDatabase(t, async (pool) => {
    await addUser(pool, 1);
    await addUser(pool, 2);
    const here = await signIn(pool, { userId: 1, userAgent: CHROME_MAC, daysAgo: 3, seenDaysAgo: 0 });
    const old = await signIn(pool, { userId: 1, userAgent: FIREFOX_WINDOWS, daysAgo: 200, seenDaysAgo: 45 });
    const fresh = await signIn(pool, { userId: 1, userAgent: SAFARI_IPHONE, daysAgo: 1, seenDaysAgo: 1 });
    const legacy = await signIn(pool, { userId: 1, userAgent: null, daysAgo: 10 });
    await signIn(pool, { userId: 1, userAgent: CHROME_MAC, daysAgo: 100, expired: true });
    await signIn(pool, { userId: 1, userAgent: SAFARI_IPHONE, daysAgo: 2, native: true });
    const theirs = await signIn(pool, { userId: 2, userAgent: CHROME_MAC, daysAgo: 1, seenDaysAgo: 0 });

    const browsers = await listLinkedBrowsers(pool, 1, { currentToken: here });
    assert.deepEqual(browsers.map((b) => [b.id, b.browser, b.os, b.current]), [
      [idOf(here), 'chrome', 'mac', true],
      [idOf(fresh), 'safari', 'ios', false],
      [idOf(legacy), null, null, false],
      [idOf(old), 'firefox', 'windows', false],
    ], 'this browser, then by last use; no expired row, no phone, nobody else\'s');
    for (const row of browsers) {
      assert.deepEqual(Object.keys(row).sort(), ['browser', 'current', 'id', 'lastUsedAt', 'os', 'signedInAt']);
      assert.equal(row.id.length, 16);
    }
    const firefox = browsers[3];
    assert.ok(Date.parse(firefox.signedInAt) < Date.now() - 199 * 86400e3, 'signed in when its row was made');
    assert.ok(Date.parse(firefox.lastUsedAt) < Date.now() - 44 * 86400e3, 'last used when it was last seen');
    assert.ok(Date.parse(firefox.lastUsedAt) > Date.now() - 46 * 86400e3);
    const never = browsers[2];
    assert.equal(never.lastUsedAt, never.signedInAt, 'a row never stamped falls back to its sign-in');

    assert.deepEqual(
      (await listLinkedBrowsers(pool, 2)).map((b) => [b.id, b.current]),
      [[idOf(theirs), false]],
      'without a cookie nothing is current',
    );
  });
});

test('signing out deletes that browser of this account only, and says when it was this one', async (t) => {
  await withDatabase(t, async (pool) => {
    await addUser(pool, 1);
    await addUser(pool, 2);
    const here = await signIn(pool, { userId: 1, userAgent: CHROME_MAC });
    const away = await signIn(pool, { userId: 1, userAgent: FIREFOX_WINDOWS });
    const phone = await signIn(pool, { userId: 1, userAgent: SAFARI_IPHONE, native: true });
    const theirs = await signIn(pool, { userId: 2, userAgent: CHROME_MAC });

    // Somebody else's browser, a phone's row, a malformed id: nothing.
    assert.deepEqual(await signOutBrowser(pool, 2, idOf(away)), { signedOut: 0, current: false });
    assert.deepEqual(await signOutBrowser(pool, 1, idOf(phone)), { signedOut: 0, current: false });
    assert.deepEqual(await signOutBrowser(pool, 1, away), { signedOut: 0, current: false });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 4);

    assert.deepEqual(await signOutBrowser(pool, 1, idOf(away), { currentToken: here }), { signedOut: 1, current: false });
    assert.deepEqual((await listLinkedBrowsers(pool, 1, { currentToken: here })).map((b) => b.id), [idOf(here)]);
    // Already gone: nothing left to do, the route's 404.
    assert.deepEqual(await signOutBrowser(pool, 1, idOf(away), { currentToken: here }), { signedOut: 0, current: false });

    assert.deepEqual(await signOutBrowser(pool, 1, idOf(here), { currentToken: here }), { signedOut: 1, current: true });
    assert.deepEqual(await listLinkedBrowsers(pool, 1, { currentToken: here }), []);

    const { rows } = await pool.query('SELECT token FROM sessions ORDER BY token');
    assert.deepEqual(rows.map((r) => r.token).sort(), [phone, theirs].sort(), 'the phone and the other account stay');
  });
});
