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
const keys = require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const { appLlmAuth, invalidateGrant } = require('../src/middleware/app-llm-auth');

const APP_TOKEN = 'a'.repeat(64);
const APP_ID = 11;

const state = {
  app: { id: APP_ID, slug: 'demo-app', llm_proxy_token: APP_TOKEN },
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

// A real platform-minted user identity for THIS app.
function userJwt(user = { id: 7, username: 'tester' }, { appId = APP_ID, ttl } = {}) {
  return platformJwt.signAppIdentityToken({ appId, user, ttl });
}

// Hand-forged with the real private key so it passes algorithm, issuer,
// audience and `pur` — the only thing wrong with it is the claim shape.
// This is the sole way to reach the middleware's belt-and-braces branch
// now that infrastructure tokens are a separate authority entirely.
function forgedIdentity(extra) {
  return jwt.sign(
    { id: 7, username: 'tester', pur: 'iframe', ...extra },
    keys.IFRAME_JWT_PRIVATE_KEY,
    {
      algorithm: 'RS256',
      issuer: 'usernode',
      audience: `usernode:app:${APP_ID}`,
      expiresIn: '1h',
    }
  );
}

async function run(req) {
  const res = makeRes();
  let nexted = false;
  const mw = appLlmAuth(pool, {});
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
  const expired = userJwt({ id: 7 }, { ttl: -10 });
  const { res } = await run(makeReq({ userToken: expired }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

// Worker tokens are HS256 under WORKER_JWT_SECRET with their own issuer
// audience — a wholly separate authority since key separation, so one
// presented here fails at the verifier rather than on the shape check.
test('a worker token is not a user token', async () => {
  const worker = platformJwt.signWorkerToken({ sessionId: 5 });
  const { res } = await run(makeReq({ userToken: worker }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

test('a correctly-signed identity carrying a scope claim is still refused', async () => {
  const { res } = await run(makeReq({ userToken: forgedIdentity({ scope: 'worker:session' }) }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'bad_user_token');
});

test('a correctly-signed identity with a non-numeric id is refused', async () => {
  const { res } = await run(makeReq({ userToken: forgedIdentity({ id: '7' }) }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'bad_user_token');
});

// The cross-app replay hole the RSA cutover closes. Under the old single
// shared secret this token verified fine and app 11 could spend user 7's
// AI budget using an identity the user only ever handed to app 12.
test('a user token minted for a DIFFERENT app is rejected', async () => {
  state.grant = {
    app_id: APP_ID, user_id: 7, status: 'active', daily_cap_cents: 250, allow_byok: true,
  };
  const { res, nexted } = await run(makeReq({ userToken: userJwt({ id: 7, username: 'tester' }, { appId: 12 }) }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
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
    appId: APP_ID,
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
