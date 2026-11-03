'use strict';

// SEC-06: a platform preview signs a reviewer in from the platform's signed
// identity (src/middleware/auth.js tryMintSessionFromIframeJwt). A reviewer
// it has no row for (an account made after its database was copied, or any
// reviewer once previews start empty) gets one, made to the copy policy's
// rule for a copied account; a handle the platform never issues to previews
// gets nothing. Against the real schema, its triggers and its sequence.
//
// Run with: TEST_DATABASE_URL=... node --test tests/preview-reviewer-signin-postgres.test.js

process.env.USERNODE_ENV = 'staging';
process.env.USERNODE_APP_ID = '42';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Client, Pool } = require('pg');
require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const identity = (user) => platformJwt.signAppIdentityToken({ appId: 42, user, ttl: '15m' });

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

async function signIn(mw, token) {
  const req = { path: '/', cookies: {}, query: { token }, headers: {} };
  const cookies = [];
  const res = {
    cookie: (name, value) => cookies.push({ name, value }),
    clearCookie: () => {},
    setHeader: () => {},
    redirect: () => { res.redirected = true; },
    status: (code) => ({ json: (body) => { res.statusCode = code; res.body = body; } }),
  };
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { user: nexted ? req.user : null, cookies };
}

test('a platform preview signs in a reviewer it has no row for, and nobody else', {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const database = `preview_reviewer_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  await admin.query(`CREATE DATABASE ${database} TEMPLATE template0`);
  const pool = new Pool({ connectionString: url.href, max: 2 });
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/middleware/auth'),
  };
  const orig = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, require.cache[id]]));
  t.after(async () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  delete require.cache[ids.subject];
  const mw = require(ids.subject).authMiddleware({});
  const row = async (id) => (await pool.query(
    `SELECT username, password, is_admin, admin_readonly, can_create_apps, has_platform_access, app_quota
       FROM users WHERE id = $1`, [id])).rows[0];

  // A production account the copy never saw: its row is made on first use.
  const reviewer = await signIn(mw, identity({ id: 7001, username: 'preview-user-7001' }));
  assert.equal(reviewer.user?.id, 7001);
  assert.equal(reviewer.user.isAdmin, false);
  assert.deepEqual(await row(7001), {
    username: 'preview-user-7001', password: '__staging_redacted__', is_admin: false, admin_readonly: false,
    can_create_apps: false, has_platform_access: true, app_quota: 2,
  });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = 7001')).rows[0].n, 1);
  assert.ok(reviewer.cookies.some((c) => c.name === 'session'));
  // Signing in again finds the row; nothing is made twice.
  assert.equal((await signIn(mw, identity({ id: 7001, username: 'preview-user-7001' }))).user?.id, 7001);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE id = 7001')).rows[0].n, 1);
  // A row the preview makes itself never takes a reviewer's id.
  const { rows: [local] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('preview-local', 'x') RETURNING id");
  assert.ok(local.id > 7001, `the sequence moved past the reviewer (got ${local.id})`);

  // The screenshot persona that checks admin screens is a view-only admin.
  const capture = await signIn(mw, identity({ id: 7100, username: 'usernode-capture-admin' }));
  assert.equal(capture.user?.isAdmin, true);
  assert.equal(capture.user.adminReadonly, true);
  assert.equal(capture.user.canAdminWrite, false);

  // A handle the platform never gives a preview, or one that is not this
  // id's, makes nothing and signs nobody in.
  for (const user of [{ id: 7003, username: 'maya' }, { id: 7004, username: 'preview-user-7001' }]) {
    const refused = await signIn(mw, identity(user));
    assert.equal(refused.user?.id, undefined, user.username);
    assert.equal(await row(user.id), undefined, user.username);
  }
  // Nor does a token for another app.
  const foreign = platformJwt.signAppIdentityToken({ appId: 43, user: { id: 7005, username: 'preview-user-7005' }, ttl: '15m' });
  assert.equal((await signIn(mw, foreign)).user?.id, undefined);
  assert.equal(await row(7005), undefined);
});
