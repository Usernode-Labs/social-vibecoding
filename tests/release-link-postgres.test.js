'use strict';

// #4594: the waitlist release mail's one-time sign-in link
// (src/services/release-links.js, POST /api/auth/release-link), against the
// real schema in a throwaway database: required when TEST_DATABASE_URL is
// set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function cookieValue(headers, name) {
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  for (const line of all) {
    const m = new RegExp(`(?:^|[,\\s])${name}=([^;]*)`).exec(line);
    if (m && m[1]) return m[1];
  }
  return null;
}

test('the release link signs its recipient in once, by POST, and only while it is live',
  { timeout: 120000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'release_link_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    const poolPath = require.resolve('../src/db/pool');
    const authPath = require.resolve('../src/routes/auth');
    const limitsPath = require.resolve('../src/middleware/rate-limits');
    const originalPool = require.cache[poolPath];
    let server = null;
    t.after(async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      delete require.cache[authPath];
      delete require.cache[limitsPath];
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true,
      id: poolPath,
      filename: poolPath,
      paths: originalPool ? originalPool.paths : [],
    };
    delete require.cache[authPath];
    delete require.cache[limitsPath];
    const releaseLinks = require('../src/services/release-links');
    const { authRoutes } = require('../src/routes/auth');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authRoutes({}));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const spend = (token) => fetch(`${base}/api/auth/release-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const released = async (email) => (await pool.query(
      'INSERT INTO waitlist_signups (email, released_at) VALUES ($1, NOW()) RETURNING id', [email]
    )).rows[0].id;

    // ── A new address: the link makes the account and opens its account step ──
    const newId = await released('new.person@example.test');
    const token = await releaseLinks.mint(pool, { signupId: newId, email: 'New.Person@example.test' });
    assert.match(token, releaseLinks.TOKEN_RE);
    const stored = (await pool.query('SELECT * FROM waitlist_release_links')).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].token_hash, releaseLinks.hashToken(token), 'stored hashed');
    assert.ok(!JSON.stringify(stored).includes(token), 'the raw token is not stored');
    const ttl = new Date(stored[0].expires_at) - new Date(stored[0].created_at);
    assert.ok(Math.abs(ttl - 7 * 24 * 3600 * 1000) < 60000, 'good for 7 days');

    // Opening the link (a GET, a scanner's prefetch) spends nothing: the
    // route answers POST only.
    const get = await fetch(`${base}/api/auth/release-link?token=${token}`);
    assert.notEqual(get.status, 200);
    assert.equal((await pool.query('SELECT consumed_at FROM waitlist_release_links')).rows[0].consumed_at, null);

    const first = await spend(token);
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.next, 'set-password');
    assert.equal(body.email, 'new.person@example.test', 'the welcome names the address');
    assert.equal(body.created, true);
    assert.equal(body.needsUsername, true, 'straight to choose-a-username');
    assert.equal(body.suggestedUsername, 'newperson', 'with the same suggestion a code gives (#4596)');
    assert.match(cookieValue(first.headers, 'usernode_signup'), /^[0-9a-f]{64}$/);
    const user = (await pool.query(
      `SELECT id, email_confirmed, password_set, has_platform_access FROM users
        WHERE email = 'new.person@example.test'`
    )).rows[0];
    assert.equal(user.email_confirmed, true);
    assert.equal(user.password_set, false);
    assert.equal(user.has_platform_access, true, 'a released address is let in');

    // Spent, it works again while the account it started is unfinished (no
    // username, no password): the same account's step, in whatever browser
    // opened it. Evan, 10 Oct 2026: the phone app's own browser spent it
    // before handing the link to Safari, where the tap found it used.
    const replay = await spend(token);
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.next, 'set-password');
    assert.equal(replayBody.created, false, 'the same account, not a second');
    assert.equal(replayBody.needsUsername, true);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = 'new.person@example.test'"
    )).rows[0].n, 1);

    // The account step finishes without a password ("Skip for now").
    const done = await fetch(`${base}/api/auth/otp/set-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `usernode_signup=${cookieValue(replay.headers, 'usernode_signup')}` },
      body: JSON.stringify({ username: 'new_person' }),
    });
    assert.equal(done.status, 200);
    assert.equal((await done.json()).user.username, 'new_person');

    // Set up, the link is spent for good.
    const spent = await spend(token);
    assert.equal(spent.status, 422);
    assert.equal((await spent.json()).code, 'invalid_release_link');

    // ── An account with nothing left to set up is signed straight in ──
    const againId = await pool.query("SELECT id FROM waitlist_signups WHERE email = 'new.person@example.test'");
    const second = await releaseLinks.mint(pool, { signupId: againId.rows[0].id, email: 'new.person@example.test' });
    const signedIn = await spend(second);
    assert.equal(signedIn.status, 200);
    const signedInBody = await signedIn.json();
    assert.equal(signedInBody.next, 'signed-in');
    assert.equal(signedInBody.user.id, user.id);
    assert.match(cookieValue(signedIn.headers, 'session'), /^[0-9a-f]{64}$/);

    // ── A newer link replaces an unspent older one ──
    const otherId = await released('other@example.test');
    const older = await releaseLinks.mint(pool, { signupId: otherId, email: 'other@example.test' });
    const newer = await releaseLinks.mint(pool, { signupId: otherId, email: 'other@example.test' });
    assert.equal((await spend(older)).status, 422);

    // ── A spent link stops working once a newer mail was sent ──
    const laterId = await released('later@example.test');
    const firstMail = await releaseLinks.mint(pool, { signupId: laterId, email: 'later@example.test' });
    assert.equal((await spend(firstMail)).status, 200, 'spent: the account is made, unfinished');
    const secondMail = await releaseLinks.mint(pool, { signupId: laterId, email: 'later@example.test' });
    assert.equal((await spend(firstMail)).status, 422, 'the older mail no longer reopens it');
    assert.equal((await spend(secondMail)).status, 200, 'the newest one does');

    // ── Expired ──
    await pool.query("UPDATE waitlist_release_links SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1",
      [releaseLinks.hashToken(newer)]);
    assert.equal((await spend(newer)).status, 422);

    // ── Bound to the row's address: a row whose address changed spends nothing ──
    const movedId = await released('moved@example.test');
    const moved = await releaseLinks.mint(pool, { signupId: movedId, email: 'moved@example.test' });
    await pool.query("UPDATE waitlist_signups SET email = 'elsewhere@example.test' WHERE id = $1", [movedId]);
    assert.equal((await spend(moved)).status, 422);
    assert.equal((await pool.query("SELECT 1 FROM users WHERE email IN ('moved@example.test', 'elsewhere@example.test')")).rows.length, 0);

    // ── Unknown and malformed ──
    assert.equal((await spend(crypto.randomBytes(32).toString('base64url'))).status, 422);
    assert.equal((await spend('short')).status, 422);
    assert.equal((await spend({ token: 'x' })).status, 422);

    // ── An admin's address is refused, as a code is ──
    await pool.query(
      "INSERT INTO users (username, password, email, email_confirmed, is_admin) VALUES ('boss', 'x', 'boss@example.test', TRUE, TRUE)"
    );
    const bossId = await released('boss@example.test');
    const boss = await releaseLinks.mint(pool, { signupId: bossId, email: 'boss@example.test' });
    const refused = await spend(boss);
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).code, 'admin_password_required');
    assert.equal(cookieValue(refused.headers, 'session'), null);
  });
