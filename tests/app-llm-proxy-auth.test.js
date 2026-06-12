// Tests for the app-LLM proxy auth middleware (issue #34) —
// src/middleware/app-llm-auth.js. Covers the rejection matrix:
// private-IP gate, bad/missing app token (a staging caller never
// receives one, so missing == staging rejected), expired/garbage/
// wrong-scope user token, missing or revoked grant → grant_required,
// and the success path populating req.appLlm.
//
// Run with: node --test tests/app-llm-proxy-auth.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { appLlmAuth, invalidateGrant } = require('../src/middleware/app-llm-auth');

const JWT_SECRET = 'test-jwt-secret';
const APP_TOKEN = 'a'.repeat(64);

const state = {
  app: { id: 11, slug: 'demo-app', llm_proxy_token: APP_TOKEN },
  grant: null,
};

const pool = {
  async query(sql, params) {
    if (/FROM apps WHERE llm_proxy_token/.test(sql)) {
      return { rows: params[0] === state.app.llm_proxy_token ? [state.app] : [] };
    }
    if (/FROM app_llm_grants WHERE app_id/.test(sql)) {
      return { rows: state.grant ? [state.grant] : [] };
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
  return { ip, headers, socket: {}, path: '/api/app-llm/v1/messages' };
}

function userJwt(claims = { id: 7, username: 'tester' }, opts = {}) {
  return jwt.sign(claims, JWT_SECRET, opts);
}

async function run(req) {
  const res = makeRes();
  let nexted = false;
  const mw = appLlmAuth(pool, { jwtSecret: JWT_SECRET });
  await mw(req, res, () => { nexted = true; });
  return { res, nexted, req };
}

beforeEach(() => {
  invalidateGrant();
  state.grant = null;
});

test('non-private source IP is rejected', async () => {
  const { res, nexted } = await run(makeReq({ ip: '8.8.8.8', userToken: userJwt() }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'forbidden_ip');
});

test('missing app token (the staging-container shape) is rejected', async () => {
  const { res, nexted } = await run(makeReq({ appToken: null, userToken: userJwt() }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'missing_app_token');
});

test('malformed app token is rejected before any lookup', async () => {
  const { res } = await run(makeReq({ appToken: 'not-hex', userToken: userJwt() }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'missing_app_token');
});

test('well-formed but unknown app token is rejected', async () => {
  const { res } = await run(makeReq({ appToken: 'b'.repeat(64), userToken: userJwt() }));
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
  const expired = userJwt({ id: 7 }, { expiresIn: -10 });
  const { res } = await run(makeReq({ userToken: expired }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

test('a scoped platform JWT (worker:session) is not a user token', async () => {
  const worker = jwt.sign({ scope: 'worker:session', session_id: 5, id: 7 }, JWT_SECRET);
  const { res } = await run(makeReq({ userToken: worker }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'bad_user_token');
});

test('valid tokens but no grant → grant_required', async () => {
  const { res, nexted } = await run(makeReq({ userToken: userJwt() }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'grant_required');
});

test('revoked grant → grant_required', async () => {
  state.grant = {
    app_id: 11, user_id: 7, status: 'revoked', daily_cap_cents: 100, allow_byok: false,
  };
  const { res } = await run(makeReq({ userToken: userJwt() }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'grant_required');
});

test('active grant → next() with req.appLlm populated', async () => {
  state.grant = {
    app_id: 11, user_id: 7, status: 'active', daily_cap_cents: 250, allow_byok: true,
  };
  const { res, nexted, req } = await run(makeReq({ userToken: userJwt() }));
  assert.equal(nexted, true, `expected next(), got ${res.statusCode} ${JSON.stringify(res.body)}`);
  assert.deepEqual(req.appLlm, {
    appId: 11,
    appSlug: 'demo-app',
    userId: 7,
    grant: { dailyCapCents: 250, allowByok: true },
  });
});

test('grant-cache invalidation makes revocation immediate', async () => {
  state.grant = {
    app_id: 11, user_id: 7, status: 'active', daily_cap_cents: 100, allow_byok: false,
  };
  let r = await run(makeReq({ userToken: userJwt() }));
  assert.equal(r.nexted, true);

  // Flip to revoked. Without invalidation the 10s cache would still
  // admit the call; with it the very next call is refused.
  state.grant.status = 'revoked';
  invalidateGrant(11, 7);
  r = await run(makeReq({ userToken: userJwt() }));
  assert.equal(r.nexted, false);
  assert.equal(r.res.body.code, 'grant_required');
});
