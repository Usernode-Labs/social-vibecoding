'use strict';

// One-time phone sign-ins for test numbers (services/test-accounts.js
// mintPhoneSignIn / redeemPhoneSignIn, the connector's
// create_test_phone_sign_in) against the full schema, through the real routes,
// with the server in PRODUCTION mode — where PHONE_TEST_CODE is refused and a
// minted code is the only way a test number signs in. Pinned: only a full
// admin mints; the code signs in once, for a test number only, within its
// tries and its 30 minutes; the account it makes is the minting admin's test
// account and follows the invite like any newcomer; naming a live test
// account's number signs in to it again; a minted number is never added to a
// real account; the cap counts unused codes. Skipped when no server is
// reachable, and required when TEST_DATABASE_URL is set.

process.env.NODE_ENV = 'production';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');
const cookieParser = require('cookie-parser');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Firebase set up as in production. A test number must never reach it.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('identitytoolkit.googleapis.com')) {
    throw new Error('Identity Toolkit must not be called for a test number');
  }
  return realFetch(url, opts);
};

function post(base, path, body = {}, headers = {}) {
  return realFetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('one-time phone sign-ins, in production mode, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'test_phone_sign_ins_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const config = {
    databaseUrl: String(url),
    firebasePhoneAuthEnabled: true,
    firebaseWebApiKey: 'web-key',
    firebaseProjectId: 'proj',
    firebaseServiceAccountJsonB64: 'e30=',
    // Set, and refused: production never honours it.
    phoneTestCode: '123456',
  };
  const routePool = require('../src/db/pool').getPool(config);
  let server = null;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await routePool.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const invites = require('../src/services/community-invites');
  const phoneAuth = require('../src/services/firebase-phone-auth');
  const { phoneAuthRoutes } = require('../src/routes/phone-auth');
  const { testAccountRoutes } = require('../src/routes/test-accounts');
  assert.equal(phoneAuth.testNumbersOn(config), false, 'PHONE_TEST_CODE is off in production');
  assert.equal(phoneAuth.offered(config), true);

  async function user(username, { isAdmin = false, access = true } = {}) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, is_admin, has_platform_access) VALUES ($1, 'x', $2, $3) RETURNING id, username`,
      [username, isAdmin, access]
    );
    return u;
  }
  const ops = await user('ops', { isAdmin: true });
  const viewer = await user('viewer', { isAdmin: true });
  const maya = await user('maya');

  // Maya's private group, and a link to it.
  await pool.query(
    `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
     VALUES ('Plant Pal', 'plant-pal', $1, 'private', 'private')`,
    [maya.id]
  );
  const { rows: [group] } = await pool.query(
    `SELECT id, slug, name, created_by, self_hosted, collab_visibility, view_visibility, community_id
       FROM apps WHERE slug = 'plant-pal'`
  );
  await pool.query("INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')", [group.id, maya.id]);
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [group.community_id, maya.id]);
  const made = await invites.createInvite(pool, {
    app: group, user: { ...maya, isAdmin: false, hasPlatformAccess: true }, maxUses: 0,
  });
  assert.ok(made.ok);
  const inviteCookie = `${invites.INVITE_COOKIE}=${made.link.token}`;

  let currentUser = null;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => { if (currentUser) req.user = currentUser; next(); });
  app.use(testAccountRoutes(config));
  app.use(phoneAuthRoutes(config));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const asOps = () => { currentUser = { id: ops.id, username: 'ops', isAdmin: true, canAdminWrite: true }; };
  const signedOut = () => { currentUser = null; };
  async function mint(body = {}) {
    asOps();
    const res = await post(base, '/api/test-accounts/phone-sign-ins', body);
    signedOut();
    return { status: res.status, body: await res.json(), cacheControl: res.headers.get('cache-control') };
  }
  // The Join sheet's two steps. Production's code-request buckets apply to
  // test numbers too (10 per source, 5 per number), so a number is asked for
  // once and its codes tried against that one sessionInfo.
  async function ask(phoneNumber) {
    const asked = await post(base, '/api/auth/phone/request', { phoneNumber });
    assert.equal(asked.status, 200);
    const { sessionInfo } = await asked.json();
    assert.match(sessionInfo, /^hr-test-session\./, 'a test number is never texted');
    return sessionInfo;
  }
  async function verify(sessionInfo, code, headers = { cookie: inviteCookie }) {
    const res = await post(base, '/api/auth/phone/verify',
      { sessionInfo, code, name: 'Ben Ito', followInvite: true }, headers);
    return { status: res.status, body: await res.json() };
  }

  await t.test('only a full admin mints, and the answer is not cached', async () => {
    currentUser = { id: viewer.id, username: 'viewer', isAdmin: true, canAdminWrite: false };
    const refused = await post(base, '/api/test-accounts/phone-sign-ins', {});
    assert.equal(refused.status, 403, 'a view-only admin cannot');
    currentUser = { id: maya.id, username: 'maya', isAdmin: false, canAdminWrite: false };
    assert.equal((await post(base, '/api/test-accounts/phone-sign-ins', {})).status, 403);
    signedOut();
    assert.equal((await post(base, '/api/test-accounts/phone-sign-ins', {})).status, 403);
    const ok = await mint();
    assert.equal(ok.status, 200);
    assert.equal(ok.cacheControl, 'no-store');
    assert.match(ok.body.signIn.phoneNumber, /^\+141555501\d\d$/);
    assert.match(ok.body.signIn.code, /^\d{6}$/);
    const minutes = (new Date(ok.body.signIn.expiresAt) - Date.now()) / 60000;
    assert.ok(minutes > 29 && minutes <= 30, `expires in 30 minutes, not ${minutes}`);
    const { rows: [row] } = await pool.query(
      'SELECT code_hash, created_by FROM test_phone_sign_ins WHERE phone_e164 = $1', [ok.body.signIn.phoneNumber]
    );
    assert.equal(row.created_by, ops.id);
    assert.ok(!row.code_hash.includes(ok.body.signIn.code), 'only a hash is kept');
  });

  let ben;
  await t.test('the code signs a newcomer in once, through the invite, as the admin\'s test account', async () => {
    const { body: { signIn } } = await mint();
    const session = await ask(signIn.phoneNumber);
    const wrong = await verify(session, signIn.code === '000000' ? '111111' : '000000');
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.code, 'invalid_or_expired_code');

    if (signIn.code !== '123456') {
      const fixed = await verify(session, '123456');
      assert.equal(fixed.status, 422, 'PHONE_TEST_CODE does not sign in in production');
    }

    const res = await verify(session, signIn.code);
    assert.equal(res.status, 200);
    assert.equal(res.body.next, 'signed-in');
    assert.equal(res.body.created, true);
    assert.equal(res.body.invite.status, 'joined');
    ben = res.body.user;

    const { rows: [row] } = await pool.query(
      `SELECT u.test_account_created_at IS NOT NULL AS test_account, u.test_account_created_by,
              u.private_member_since IS NOT NULL AS private_member, u.display_name, i.firebase_uid
         FROM users u JOIN user_phone_identities i ON i.user_id = u.id WHERE u.id = $1`,
      [ben.id]
    );
    assert.equal(row.test_account, true);
    assert.equal(row.test_account_created_by, ops.id, 'the minting admin made it');
    assert.equal(row.private_member, true);
    assert.equal(row.display_name, 'Ben Ito');
    assert.equal(row.firebase_uid, `test-phone:${signIn.phoneNumber}`);
    const { rows: [used] } = await pool.query(
      'SELECT used_at IS NOT NULL AS used, used_by FROM test_phone_sign_ins WHERE phone_e164 = $1 ORDER BY id DESC LIMIT 1',
      [signIn.phoneNumber]
    );
    assert.deepEqual(used, { used: true, used_by: ben.id });
    const { rows: audit } = await pool.query(
      `SELECT actor_user_id, payload FROM support_actions WHERE target_user_id = $1 AND action = 'test_account_create'`,
      [ben.id]
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, ops.id);
    assert.equal(audit[0].payload.via, 'phone_sign_in');

    const again = await verify(session, signIn.code);
    assert.equal(again.status, 422, 'a code works once');
  });

  await t.test('naming a live test account\'s number signs in to it again', async () => {
    const number = (await pool.query('SELECT phone_e164 FROM user_phone_identities WHERE user_id = $1', [ben.id])).rows[0].phone_e164;
    const { body: { signIn } } = await mint({ phoneNumber: number });
    assert.equal(signIn.signsInTo, ben.username);
    const res = await verify(await ask(number), signIn.code, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.created, false);
    assert.equal(res.body.user.id, ben.id);
  });

  await t.test('a code is gone after five tries, and after its 30 minutes', async () => {
    const { body: { signIn } } = await mint({ phoneNumber: '+1 212 555 0150' });
    const wrong = signIn.code === '999999' ? '888888' : '999999';
    const session = await ask(signIn.phoneNumber);
    for (let i = 0; i < 5; i++) assert.equal((await verify(session, wrong)).status, 422);
    assert.equal((await verify(session, signIn.code)).status, 422, 'the right code after five tries');

    const late = (await mint({ phoneNumber: '+1 212 555 0151' })).body.signIn;
    await pool.query("UPDATE test_phone_sign_ins SET expires_at = NOW() - INTERVAL '1 second' WHERE phone_e164 = $1", [late.phoneNumber]);
    assert.equal((await verify(await ask(late.phoneNumber), late.code)).status, 422, 'an expired code');
  });

  await t.test('only test numbers are minted, and never a real account\'s', async () => {
    const real = await mint({ phoneNumber: '+44 7700 900123' });
    assert.equal(real.status, 400);
    assert.equal(real.body.code, 'not_test_number');
    // A real account somehow holding a test number (PHONE_TEST_CODE on a
    // local stack once): minting it would sign in to a real person's account.
    await pool.query(
      `INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164) VALUES ($1, 'test-phone:+12125550160', '+12125550160')`,
      [maya.id]
    );
    const held = await mint({ phoneNumber: '+12125550160' });
    assert.equal(held.status, 409);
    assert.equal(held.body.code, 'number_in_use');
  });

  await t.test('a minted number is never added to a real account', async () => {
    const { body: { signIn } } = await mint({ phoneNumber: '+1 212 555 0170' });
    const { rows: [rae] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ('rae', 'x') RETURNING id`
    );
    currentUser = { id: rae.id, username: 'rae', isAdmin: false };
    const asked = await post(base, '/api/auth/phone-link/request', { phoneNumber: signIn.phoneNumber });
    assert.equal(asked.status, 200);
    const { sessionInfo } = await asked.json();
    const res = await post(base, '/api/auth/phone-link/verify', { sessionInfo, code: signIn.code });
    signedOut();
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'test_number_not_allowed');
    const { rows } = await pool.query('SELECT 1 FROM user_phone_identities WHERE user_id = $1', [rae.id]);
    assert.equal(rows.length, 0);
  });

  await t.test('unused codes count against the cap of 25', async () => {
    const { rows: [{ n }] } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM users WHERE test_account_created_at IS NOT NULL AND anonymised_at IS NULL)
            + (SELECT COUNT(*) FROM test_phone_sign_ins WHERE used_at IS NULL AND expires_at > NOW()) AS n`
    );
    for (let i = Number(n); i < 25; i++) {
      await pool.query(
        `INSERT INTO users (username, password, test_account_created_at) VALUES ($1, 'x', NOW())`,
        [`filler_${i}`]
      );
    }
    const full = await mint();
    assert.equal(full.status, 429);
    assert.equal(full.body.code, 'at_capacity');
  });
});
