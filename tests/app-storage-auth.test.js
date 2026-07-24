// Tests for the app-storage auth middleware (#752) —
// src/middleware/app-storage-auth.js. Sibling of
// tests/app-llm-proxy-auth.test.js, minus the grant matrix (storage has
// no per-user consent grant). Covers: private-IP gate, bad/missing app
// token (a staging caller never receives one, so missing == staging
// rejected), expired/garbage/wrong-scope user token, and the success
// path populating req.appStorage.
//
// Run with: node --test tests/app-storage-auth.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { appStorageAuth } = require('../src/middleware/app-storage-auth');

const JWT_SECRET = 'test-jwt-secret';
const APP_TOKEN = 'b'.repeat(64);

const state = {
  app: { id: 11, slug: 'demo-app', storage_api_token: APP_TOKEN },
};

const pool = {
  async query(sql, params) {
    if (/FROM apps WHERE storage_api_token/.test(sql)) {
      return { rows: params[0] === state.app.storage_api_token ? [state.app] : [] };
    }
    return { rows: [] };
  },
};

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function makeReq({ ip = '10.0.0.5', appToken = APP_TOKEN, userToken } = {}) {
  const headers = {};
  if (appToken != null) headers['x-usernode-app-token'] = appToken;
  if (userToken != null) headers['x-usernode-user-token'] = userToken;
  return { ip, headers, socket: {}, path: '/api/app-storage/files' };
}

function userJwt(claims = { id: 7, username: 'tester' }, opts = {}) {
  return jwt.sign(claims, JWT_SECRET, opts);
}

async function run(req) {
  const res = makeRes();
  let nexted = false;
  const mw = appStorageAuth(pool, { jwtSecret: JWT_SECRET });
  await mw(req, res, () => { nexted = true; });
  return { res, nexted, req };
}

test('non-private source IP is rejected', async () => {
  const { res, nexted } = await run(makeReq({ ip: '8.8.8.8', userToken: userJwt() }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'forbidden_ip');
});

test('missing app token (the staging case) is rejected', async () => {
  const { res, nexted } = await run(makeReq({ appToken: null, userToken: userJwt() }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'missing_app_token');
});

test('malformed app token is rejected before any lookup', async () => {
  const { res } = await run(makeReq({ appToken: 'not-64-hex', userToken: userJwt() }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'missing_app_token');
});

test('unknown app token is rejected', async () => {
  const { res } = await run(makeReq({ appToken: 'c'.repeat(64), userToken: userJwt() }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_app_token');
});

test('missing user token is rejected', async () => {
  const { res } = await run(makeReq({}));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'missing_user_token');
});

test('garbage user token is rejected', async () => {
  const { res } = await run(makeReq({ userToken: 'garbage' }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

test('expired user token is rejected', async () => {
  const token = userJwt({ id: 7 }, { expiresIn: '-1s' });
  const { res } = await run(makeReq({ userToken: token }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

test('scoped platform JWTs (infrastructure identities) are rejected', async () => {
  const token = userJwt({ id: 7, scope: 'worker:session' });
  const { res } = await run(makeReq({ userToken: token }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'bad_user_token');
});

test('non-numeric id claim is rejected', async () => {
  const token = userJwt({ id: 'seven' });
  const { res } = await run(makeReq({ userToken: token }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'bad_user_token');
});

test('success path attaches req.appStorage', async () => {
  const { res, nexted, req } = await run(makeReq({ userToken: userJwt({ id: 7 }) }));
  assert.equal(res.statusCode, 200);
  assert.equal(nexted, true);
  assert.deepEqual(req.appStorage, { appId: 11, appSlug: 'demo-app', userId: 7 });
});
