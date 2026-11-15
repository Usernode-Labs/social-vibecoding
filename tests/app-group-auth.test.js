// Tests for the app-group auth middleware (#6669) —
// src/middleware/app-group-auth.js. Covers: the private-IP gate, a missing
// or malformed app token (a staging caller never receives one), an unknown
// token, and the success path populating req.appGroup. No user token: the
// list is the app's own statement about who uses it.
//
// Run with: node --test tests/app-group-auth.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { appGroupAuth } = require('../src/middleware/app-group-auth');

const APP_TOKEN = 'c'.repeat(64);
const APP_ID = 21;

const state = { app: { id: APP_ID, slug: 'gym-tracker', groups_api_token: APP_TOKEN } };

const pool = {
  async query(sql, params) {
    if (/FROM apps WHERE groups_api_token/.test(sql)) {
      return { rows: params[0] === state.app.groups_api_token ? [state.app] : [] };
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

function makeReq({ ip = '10.0.0.5', appToken = APP_TOKEN } = {}) {
  const headers = {};
  if (appToken != null) headers['x-usernode-app-token'] = appToken;
  return { headers, socket: { remoteAddress: ip }, path: '/api/app-groups' };
}

async function run(req) {
  const res = makeRes();
  let called = false;
  await appGroupAuth(pool, {})(req, res, () => { called = true; });
  return { res, called };
}

test('a call from outside the platform network is refused', async () => {
  const { res, called } = await run(makeReq({ ip: '203.0.113.9' }));
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'forbidden_ip');
});

test('a missing or malformed app token is refused', async () => {
  for (const appToken of [null, '', 'short', 'z'.repeat(64)]) {
    const { res, called } = await run(makeReq({ appToken }));
    assert.equal(called, false, `token ${appToken}`);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'missing_app_token');
  }
});

test('an unknown app token is refused', async () => {
  const { res, called } = await run(makeReq({ appToken: 'd'.repeat(64) }));
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_app_token');
});

test('the app token resolves to its own app and nothing else', async () => {
  const req = makeReq();
  const { res, called } = await run(req);
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(req.appGroup, { appId: APP_ID, appSlug: 'gym-tracker' });
});
