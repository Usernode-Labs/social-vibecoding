'use strict';

// Apple and Google sign-in against the FULL PostgreSQL schema
// (src/services/sign-in-providers.js, src/routes/sign-in-providers.js): who
// a provider's sign-in signs in, makes, or refuses, the username step, and
// the whole HTTP round trip with the provider's exchange stubbed.
// The settings, the exchange and the ID token's checks run without a
// database in tests/sign-in-providers.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const providers = require('../src/services/sign-in-providers');
const { createSchemaDatabase } = require('./lib/schema-database');

async function createSession(client, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 86400000);
  await client.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, expiresAt]);
  return { token, expiresAt };
}

function cookiesFrom(res) {
  const out = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const at = pair.indexOf('=');
    out[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
  }
  return out;
}

test('Apple and Google sign-in against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `sign_in_providers_${crypto.randomBytes(6).toString('hex')}`;
  await createSchemaDatabase(admin, name);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  let n = 0;
  async function account({ email, passwordSet = true, confirmed = true, isAdmin = false, chosen = true } = {}) {
    n += 1;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, email, email_confirmed, password_set, is_admin,
                          needs_username_choice, has_platform_access)
       VALUES ($1, 'x', $2, $3, $4, $5, $6, TRUE) RETURNING id, username`,
      [`person_${n}`, email, confirmed, passwordSet, isAdmin, !chosen]
    );
    return rows[0];
  }
  const claims = (subject, email, emailVerified = true) => ({ subject, email, emailVerified, name: null });
  const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

  await t.test('a new verified address makes an account that picks its username before it gets a session', async () => {
    const result = await providers.signIn(pool, 'google', claims('g-1', 'new@example.com'), { createSession });
    assert.equal(result.next, 'username');
    assert.equal(result.created, true);
    const { rows: [u] } = await pool.query(
      `SELECT email, email_confirmed, password_set, needs_username_choice, needs_communities_choice,
              getting_started_gate, username
         FROM users WHERE id = $1`, [result.userId]);
    assert.equal(u.email, 'new@example.com');
    assert.equal(u.email_confirmed, true, 'the provider verified it');
    assert.equal(u.password_set, false, 'no password: it signs in with Google, or an email code');
    assert.equal(u.needs_username_choice, true);
    assert.match(u.username, /^member_/, 'a placeholder, never the address');
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1', [result.userId]), 0);
    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM user_oauth_identities WHERE user_id = $1 AND provider = 'google' AND subject = 'g-1'`, [result.userId]), 1);

    // The username step: a taken name keeps the continuation, a free one spends it.
    await account({ email: 'taken@example.com' });
    await assert.rejects(
      providers.completeUsername(pool, { signupToken: result.signupToken, username: `person_${n}`, createSession }),
      { code: 'username_taken' });
    await assert.rejects(
      providers.completeUsername(pool, { signupToken: result.signupToken, username: 'no spaces', createSession }),
      { code: 'invalid_username' });
    const done = await providers.completeUsername(pool, { signupToken: result.signupToken, username: 'ada_g', createSession });
    assert.equal(done.user.username, 'ada_g');
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1', [result.userId]), 1);
    await assert.rejects(
      providers.completeUsername(pool, { signupToken: result.signupToken, username: 'ada_g2', createSession }),
      { code: 'invalid_signup_session' }, 'single use');

    // Next time the subject finds it, whatever the address says now.
    const again = await providers.signIn(pool, 'google', claims('g-1', 'renamed@example.com', false), { createSession });
    assert.equal(again.next, 'signed-in');
    assert.equal(again.userId, result.userId);
    assert.equal(again.created, false);
  });

  await t.test('an existing account with the verified address is linked and signed in', async () => {
    const existing = await account({ email: 'Grace@Example.com' });
    const result = await providers.signIn(pool, 'apple', claims('a-1', 'grace@example.com'), { createSession });
    assert.equal(result.next, 'signed-in');
    assert.equal(result.userId, existing.id);
    assert.equal(result.user.username, existing.username);
    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM user_oauth_identities WHERE user_id = $1 AND provider = 'apple'`, [existing.id]), 1);
    // A second Apple identity with the same address is not swapped in.
    const other = await providers.signIn(pool, 'apple', claims('a-2', 'grace@example.com'), { createSession });
    assert.deepEqual(other, { refuse: 'linked_elsewhere' });
    // An account with no password yet and an unconfirmed address gets it confirmed.
    const halfway = await account({ email: 'halfway@example.com', passwordSet: false, confirmed: false });
    const linked = await providers.signIn(pool, 'google', claims('g-halfway', 'halfway@example.com'), { createSession });
    assert.equal(linked.userId, halfway.id);
    assert.equal((await pool.query('SELECT email_confirmed FROM users WHERE id = $1', [halfway.id])).rows[0].email_confirmed, true);
  });

  await t.test('the email code\'s refusals: admins, unconfirmed password accounts, and no verified address', async () => {
    await account({ email: 'boss@example.com', isAdmin: true });
    assert.deepEqual(await providers.signIn(pool, 'google', claims('g-boss', 'boss@example.com'), { createSession }),
      { refuse: 'admin_password_required' });
    await account({ email: 'unconfirmed@example.com', confirmed: false });
    assert.deepEqual(await providers.signIn(pool, 'google', claims('g-u', 'unconfirmed@example.com'), { createSession }),
      { refuse: 'password_required' });
    assert.deepEqual(await providers.signIn(pool, 'google', claims('g-nv', 'someone@example.com', false), { createSession }),
      { refuse: 'no_verified_email' });
    assert.deepEqual(await providers.signIn(pool, 'google', claims('g-none', null), { createSession }),
      { refuse: 'no_verified_email' });
    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM users WHERE email = 'someone@example.com'`), 0, 'nothing made');
  });

  await t.test('the round trip over HTTP: start, callback, username step, session', async () => {
    const config = { cliAuthOrigin: 'http://localhost', dataEncryptionKey: 'pg-test-key', jwtSecret: 'test' };
    await providers.saveProvider(pool, config, 'google', {
      clientId: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-pg_test_secret', enabled: true,
    }, null);
    const poolMod = require('../src/db/pool');
    const priorPool = poolMod.getPool;
    poolMod.getPool = () => pool;
    const { signInProviderRoutes } = require('../src/routes/sign-in-providers');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(signInProviderRoutes(config));
    poolMod.getPool = priorPool;
    const priorExchange = providers.exchangeCode;
    let nextClaims = null;
    const exchanged = [];
    providers.exchangeCode = async (_pool, _config, provider, { code, state }) => {
      exchanged.push({ provider, code, state });
      return nextClaims;
    };
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => { providers.exchangeCode = priorExchange; server.close(); });
    const base = `http://localhost:${server.address().port}`;
    const get = (path, cookie = '') => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

    // Start: off to Google, with the binder in an HttpOnly cookie.
    const start = await get('/api/auth/oauth/google/start?from=story&return=%2F');
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get('location'));
    assert.equal(to.host, 'accounts.google.com');
    const binder = cookiesFrom(start).hr_oauth_binder;
    assert.ok(binder);
    assert.match(start.headers.getSetCookie().join('\n'), /hr_oauth_binder=[^;]+; Max-Age=600; Path=\/api\/auth\/oauth; Expires=[^;]+; HttpOnly; SameSite=Lax/);

    // Without its binder, the callback signs nobody in.
    nextClaims = claims('g-http', 'http@example.com');
    const stray = await get(`/api/auth/oauth/google/callback?code=c0&state=${to.searchParams.get('state')}`);
    assert.equal(stray.status, 303);
    assert.equal(cookiesFrom(stray).hr_oauth_result, 'error-expired');
    assert.equal(exchanged.length, 0, 'the code is never exchanged');

    // A fresh trip, with its binder: a new account, so the username step.
    const start2 = await get('/api/auth/oauth/google/start?from=story&return=%2F');
    const state2 = new URL(start2.headers.get('location')).searchParams.get('state');
    const back = await get(`/api/auth/oauth/google/callback?code=c1&state=${state2}`, `hr_oauth_binder=${cookiesFrom(start2).hr_oauth_binder}`);
    assert.equal(back.status, 303);
    assert.equal(back.headers.get('location'), '/');
    const backCookies = cookiesFrom(back);
    assert.equal(backCookies.hr_oauth_result, 'username');
    assert.ok(backCookies.hr_oauth_signup);
    assert.equal(backCookies.session, undefined, 'no session before the username');
    assert.equal(exchanged[0].code, 'c1');
    const made = (await pool.query(
      `SELECT id, needs_communities_choice, getting_started_seen->>'first_session' AS first_session
         FROM users WHERE email = 'http@example.com'`)).rows[0];
    assert.equal(made.first_session, 'story', 'started from the story: asked what to make instead');
    assert.equal(made.needs_communities_choice, true, 'and asked until it answers, not answered by the start');

    const finish = await fetch(`${base}/api/auth/oauth/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `hr_oauth_signup=${backCookies.hr_oauth_signup}` },
      body: JSON.stringify({ username: 'http_person' }),
    });
    assert.equal(finish.status, 200);
    const body = await finish.json();
    assert.equal(body.user.username, 'http_person');
    assert.equal(body.user.isAdmin, false);
    assert.ok(cookiesFrom(finish).session, 'the ordinary web session');

    // Apple's form POST becomes the GET, fields and all.
    const posted = await fetch(`${base}/api/auth/oauth/apple/callback`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=abc&state=xyz&user=%7B%7D',
    });
    assert.equal(posted.status, 303);
    assert.equal(posted.headers.get('location'), '/api/auth/oauth/apple/callback?code=abc&state=xyz');

    // A provider that is not set up sends the person back with the reason.
    const off = await get('/api/auth/oauth/apple/start?return=%2F');
    assert.equal(off.status, 303);
    assert.equal(cookiesFrom(off).hr_oauth_result, 'error-not_offered');
  });

  await t.test('inside the app over HTTP: a state and a nonce, the app\'s ID token, the account', async () => {
    const config = { cliAuthOrigin: 'http://localhost', dataEncryptionKey: 'pg-test-key', jwtSecret: 'test' };
    const { privateKey: appleKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await providers.saveProvider(pool, config, 'apple', {
      clientId: 'com.example.web', teamId: 'ABCDE12345', keyId: 'XYZ9876543',
      secret: appleKey.export({ type: 'pkcs8', format: 'pem' }), enabled: true,
    }, null);
    const { SignJWT, exportJWK, createLocalJWKSet } = await import('jose');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
    const appleToken = (claims) => new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://appleid.apple.com').setAudience('com.onhomeroom.app').setIssuedAt().setExpirationTime('5m')
      .sign(privateKey);
    const realVerify = providers.verifyNativeIdToken;
    providers.verifyNativeIdToken = (p, c, provider, idToken, state) => realVerify(p, c, provider, idToken, state, { jwks });
    const poolMod = require('../src/db/pool');
    const priorPool = poolMod.getPool;
    poolMod.getPool = () => pool;
    const { signInProviderRoutes } = require('../src/routes/sign-in-providers');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(signInProviderRoutes(config));
    poolMod.getPool = priorPool;
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => { providers.verifyNativeIdToken = realVerify; server.close(); });
    const base = `http://localhost:${server.address().port}`;
    const post = (path, body, cookie = '') => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

    // Not offered in the app until its client IDs are saved.
    assert.equal((await post('/api/auth/oauth/apple/native/start', { from: 'story' })).status, 404);
    await providers.saveProvider(pool, config, 'apple', { appClientIds: ['com.onhomeroom.app'] }, null);

    const begin = async () => {
      const res = await post('/api/auth/oauth/apple/native/start', { from: 'invite', follow: true });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(res.headers.getSetCookie().join('\n'), /hr_oauth_binder=[^;]+; Max-Age=600; Path=\/api\/auth\/oauth; Expires=[^;]+; HttpOnly; SameSite=Lax/);
      return { ...body, binder: cookiesFrom(res).hr_oauth_binder };
    };

    // Without the binder of the web view that started it, nobody is signed in.
    const stray = await begin();
    const strayToken = await appleToken({ sub: '001.native', email: 'native@example.com', email_verified: 'true', nonce: sha(stray.nonce) });
    const refused = await post('/api/auth/oauth/apple/native', { state: stray.state, idToken: strayToken });
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).code, 'expired');

    // With it: a new account, so the username step, then the session.
    const first = await begin();
    const token = await appleToken({ sub: '001.native', email: 'native@example.com', email_verified: 'true', nonce: sha(first.nonce) });
    const made = await post('/api/auth/oauth/apple/native', { state: first.state, idToken: token }, `hr_oauth_binder=${first.binder}`);
    assert.equal(made.status, 200);
    assert.deepEqual(await made.json(), { next: 'username', created: true });
    const madeCookies = cookiesFrom(made);
    assert.ok(madeCookies.hr_oauth_signup);
    assert.equal(madeCookies.session, undefined, 'no session before the username');
    assert.equal(await count(
      `SELECT COUNT(*)::int AS n FROM user_oauth_identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = 'apple' AND i.subject = '001.native' AND u.email = 'native@example.com'`), 1);
    const finish = await post('/api/auth/oauth/finish', { username: 'native_person' }, `hr_oauth_signup=${madeCookies.hr_oauth_signup}`);
    assert.equal(finish.status, 200);
    assert.equal((await finish.json()).user.username, 'native_person');

    // The same token again, on a fresh state: spent.
    const again = await begin();
    const replay = await post('/api/auth/oauth/apple/native', { state: again.state, idToken: token }, `hr_oauth_binder=${again.binder}`);
    assert.equal(replay.status, 502);
    assert.equal((await replay.json()).code, 'bad_token');

    // A second sign-in finds the linked account and signs straight in.
    const next = await begin();
    const token2 = await appleToken({ sub: '001.native', email: 'native@example.com', email_verified: 'true', nonce: sha(next.nonce) });
    const signedIn = await post('/api/auth/oauth/apple/native', { state: next.state, idToken: token2 }, `hr_oauth_binder=${next.binder}`);
    assert.equal(signedIn.status, 200);
    const body = await signedIn.json();
    assert.deepEqual([body.next, body.created, body.user.username, body.user.isAdmin], ['signed-in', false, 'native_person', false]);
    assert.ok(cookiesFrom(signedIn).session, 'the ordinary web session');

    // A token another nonce was given to signs nobody in.
    const other = await begin();
    const wrong = await appleToken({ sub: '001.native', email: 'native@example.com', email_verified: 'true', nonce: sha('not-this-one') });
    const mismatch = await post('/api/auth/oauth/apple/native', { state: other.state, idToken: wrong }, `hr_oauth_binder=${other.binder}`);
    assert.equal(mismatch.status, 502);
  });
});
