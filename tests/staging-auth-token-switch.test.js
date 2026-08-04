// Staging identity switch in authMiddleware (src/middleware/auth.js).
//
// The parent shell is the token authority in staging: a request carrying a
// VALID iframe JWT for a DIFFERENT user than the current cookie session
// must re-mint as the token's user instead of silently keeping the old
// identity. Cookie-first-always is what broke the proposal-checks suite:
// the screenshot pass minted a non-admin capture cookie, and every later
// test navigation carrying the view-only-admin ?token= was downgraded to
// the non-admin identity — the /debug "PR closed" badge check failed on
// the "Admins only" gate. Same-user tokens and invalid tokens leave the
// existing session untouched.
//
// Run with: node --test tests/staging-auth-token-switch.test.js

// IS_STAGING and SELF_APP_ID are read at module load — must both be set
// before the require. USERNODE_APP_ID is what tells the container which
// audience its tokens carry; without it every token fails closed (see the
// last test in this file).
process.env.USERNODE_ENV = 'staging';
process.env.USERNODE_APP_ID = '42';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const keys = require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const SELF_APP_ID = 42;

// A parent-minted identity for THIS app.
function identity(user, { appId = SELF_APP_ID, ttl = '15m' } = {}) {
  return platformJwt.signAppIdentityToken({ appId, user, ttl });
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makePool(handlers) {
  const calls = [];
  return {
    calls,
    issued(re) { return calls.some((c) => re.test(c.sql)); },
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      for (const [re, rows] of handlers) {
        if (re.test(String(sql))) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
  };
}

// Cookie session belongs to the NON-admin capture user (id 2); the token
// user is the view-only admin (id 3) — the exact checks-runner shape.
// Both carry has_platform_access: staging users are cloned from prod,
// where every pre-gate account was grandfathered (onboarding flow
// alignment) — without the flag the access gate would bounce them to the
// waiting room before the token-switch logic under test even runs.
const COOKIE_USER = { user_id: 2, username: 'usernode-capture', is_admin: false, admin_readonly: false, app_quota: 0, ai_progress_estimate: false, has_platform_access: true, expires_at: new Date(Date.now() + 3600_000).toISOString() };
const TOKEN_USER = { id: 3, username: 'usernode-capture-admin', is_admin: true, admin_readonly: true, app_quota: 0, ai_progress_estimate: false, has_platform_access: true };

function loadMiddleware(pool) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/middleware/auth'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });

  delete require.cache[ids.subject];
  const { authMiddleware } = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { authMiddleware, restore };
}

function defaultHandlers({ tokenUserRow = TOKEN_USER } = {}) {
  return [
    [/FROM sessions s JOIN users u/, [COOKIE_USER]],
    [/FROM users WHERE id = \$1/, tokenUserRow ? [tokenUserRow] : []],
    [/INSERT INTO sessions/, []],
  ];
}

async function run(mw, { token } = {}) {
  const req = {
    path: '/debug',
    cookies: { session: 'cookie-A' },
    query: token ? { token } : {},
    headers: {},
  };
  const cookies = [];
  const res = {
    cookie: (name, value, opts) => cookies.push({ name, value, opts }),
    clearCookie: () => {},
    redirect: () => { res.redirected = true; },
    status: (code) => ({ json: (body) => { res.statusCode = code; res.body = body; } }),
  };
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { req, res, cookies, nexted };
}

test('a valid token for a DIFFERENT user switches the session to the token user', async () => {
  const pool = makePool(defaultHandlers());
  const { authMiddleware, restore } = loadMiddleware(pool);
  try {
    const mw = authMiddleware({});
    const token = identity({ id: 3, username: 'usernode-capture-admin' });
    const { req, cookies, nexted } = await run(mw, { token });
    assert.equal(nexted, true);
    assert.equal(req.user.id, 3, 'request runs as the token user');
    assert.equal(req.user.isAdmin, true);
    assert.equal(req.user.adminReadonly, true);
    assert.ok(pool.issued(/INSERT INTO sessions/), 'a fresh session row is minted');
    assert.equal(cookies.length, 1, 'the cookie is replaced');
  } finally {
    restore();
  }
});

test('a token for the SAME user keeps the cookie session (no re-mint)', async () => {
  const pool = makePool(defaultHandlers());
  const { authMiddleware, restore } = loadMiddleware(pool);
  try {
    const mw = authMiddleware({});
    const token = identity({ id: 2, username: 'usernode-capture' });
    const { req, nexted } = await run(mw, { token });
    assert.equal(nexted, true);
    assert.equal(req.user.id, 2);
    assert.equal(pool.issued(/INSERT INTO sessions/), false, 'no session churn for a same-user token');
  } finally {
    restore();
  }
});

test('an INVALID token keeps the cookie session', async () => {
  const pool = makePool(defaultHandlers());
  const { authMiddleware, restore } = loadMiddleware(pool);
  try {
    const mw = authMiddleware({});
    const token = jwt.sign({ id: 3, username: 'x', pur: 'iframe' }, 'wrong-secret', { expiresIn: '15m' });
    const { req, nexted } = await run(mw, { token });
    assert.equal(nexted, true);
    assert.equal(req.user.id, 2, 'a bad token must never dislodge a valid session');
    assert.equal(pool.issued(/INSERT INTO sessions/), false);
  } finally {
    restore();
  }
});

test('a differing token whose user is missing falls back to the cookie session', async () => {
  const pool = makePool(defaultHandlers({ tokenUserRow: null }));
  const { authMiddleware, restore } = loadMiddleware(pool);
  try {
    const mw = authMiddleware({});
    const token = identity({ id: 99, username: 'ghost' });
    const { req, nexted } = await run(mw, { token });
    assert.equal(nexted, true);
    assert.equal(req.user.id, 2, 'a failed mint must not break the existing session');
  } finally {
    restore();
  }
});

test('no token → plain cookie session, unchanged', async () => {
  const pool = makePool(defaultHandlers());
  const { authMiddleware, restore } = loadMiddleware(pool);
  try {
    const mw = authMiddleware({});
    const { req, nexted } = await run(mw, {});
    assert.equal(nexted, true);
    assert.equal(req.user.id, 2);
    assert.equal(pool.issued(/INSERT INTO sessions/), false);
  } finally {
    restore();
  }
});

// ── per-app scoping (RSA cutover) ──────────────────────────────────────

test('a token minted for a DIFFERENT app does not switch identity', async () => {
  const pool = makePool(defaultHandlers());
  const { authMiddleware, restore } = loadMiddleware(pool);
  try {
    const mw = authMiddleware({});
    const token = identity({ id: 3, username: 'usernode-capture-admin' }, { appId: SELF_APP_ID + 1 });
    const { req, nexted } = await run(mw, { token });
    assert.equal(nexted, true);
    assert.equal(req.user.id, 2, 'a foreign-audience token must not dislodge the session');
    assert.equal(pool.issued(/INSERT INTO sessions/), false);
  } finally {
    restore();
  }
});

// An HS256 token forged with the PUBLIC PEM. Every app container holds
// that PEM, so without the algorithm pin inside platform-jwt this would
// be a universal identity forgery against every staging clone.
test('an HS256 token forged with the public PEM does not switch identity', async () => {
  const pool = makePool(defaultHandlers());
  const { authMiddleware, restore } = loadMiddleware(pool);
  try {
    const mw = authMiddleware({});
    const forged = jwt.sign(
      { id: 3, username: 'usernode-capture-admin', pur: 'iframe' },
      keys.IFRAME_JWT_PUBLIC_KEY,
      { algorithm: 'HS256', issuer: 'usernode', audience: `usernode:app:${SELF_APP_ID}`, expiresIn: '15m' }
    );
    const { req, nexted } = await run(mw, { token: forged });
    assert.equal(nexted, true);
    assert.equal(req.user.id, 2);
    assert.equal(pool.issued(/INSERT INTO sessions/), false);
  } finally {
    restore();
  }
});

// A container with no USERNODE_APP_ID cannot know which audience to
// expect, so it must reject every token rather than accept an identity
// minted for some other app. appAudience() throws on a non-integer, which
// is what makes this fail closed for free.
test('without USERNODE_APP_ID every token is refused (fails closed)', async () => {
  const saved = process.env.USERNODE_APP_ID;
  delete process.env.USERNODE_APP_ID;
  const pool = makePool(defaultHandlers());
  const { authMiddleware, restore } = loadMiddleware(pool);
  try {
    const mw = authMiddleware({});
    const { req, nexted } = await run(mw, {
      token: identity({ id: 3, username: 'usernode-capture-admin' }),
    });
    assert.equal(nexted, true);
    assert.equal(req.user.id, 2, 'falls back to the cookie session, mints nothing');
    assert.equal(pool.issued(/INSERT INTO sessions/), false);
  } finally {
    restore();
    process.env.USERNODE_APP_ID = saved;
  }
});

// ── no legacy token shape survives anywhere ─────────────────────────────
//
// During the RSA cutover, platform-jwt.js briefly carried a staging-only
// "legacy bootstrap" shim so the preview of the cutover itself could be
// opened: a preview container's env is built by the DEPLOYED platform, and
// for one deploy window that platform injected only the old shared HS256
// secret — no IFRAME_JWT_PUBLIC_KEY, no USERNODE_APP_ID. The shim was
// self-disabling (its gate required the ABSENCE of both) and has been
// removed.
//
// These tests are the negative half that outlives it: the exact pre-cutover
// container shape must now authenticate NOTHING, and the shim's own API
// must be gone rather than merely unused — a re-introduction has to be a
// deliberate, visible act, not an accidental re-export.

// The legacy parent's token: bare HS256, no iss/aud/pur — the shape the
// pre-cutover /api/iframe-token emitted.
function legacyToken(user, secret) {
  return jwt.sign({ ...user, usernode_pubkey: null, locale: null }, secret, { expiresIn: '15m' });
}

const LEGACY_SECRET = 'legacy-shared-secret-0123456789abcdef';

// Drive the middleware with the env of a pre-cutover preview container.
async function withPreCutoverEnv(fn, { overrides = {} } = {}) {
  const saved = {
    USERNODE_APP_ID: process.env.USERNODE_APP_ID,
    IFRAME_JWT_PUBLIC_KEY: process.env.IFRAME_JWT_PUBLIC_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
    USERNODE_ENV: process.env.USERNODE_ENV,
  };
  const target = {
    USERNODE_APP_ID: undefined,
    IFRAME_JWT_PUBLIC_KEY: undefined,
    JWT_SECRET: LEGACY_SECRET,
    USERNODE_ENV: 'staging',
    ...overrides,
  };
  for (const [k, v] of Object.entries(target)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn(target.JWT_SECRET);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a pre-cutover-shaped preview authenticates nothing at all', async () => {
  await withPreCutoverEnv(async (secret) => {
    const pool = makePool(defaultHandlers());
    const { authMiddleware, restore } = loadMiddleware(pool);
    try {
      const mw = authMiddleware({});
      // The legacy bare-HS256 shape the retired shim used to accept.
      const { req, nexted } = await run(mw, {
        token: legacyToken({ id: 3, username: 'usernode-capture-admin' }, secret),
      });
      assert.equal(nexted, true);
      assert.equal(req.user.id, 2, 'the cookie session stands; no legacy switch');
      assert.equal(pool.issued(/INSERT INTO sessions/), false, 'and nothing is minted');
    } finally {
      restore();
    }
  });
});

// Fail-closed in BOTH directions, which is the property the shim's removal
// restores: with no key material there is nothing to verify against and
// nothing to sign with, and neither is papered over.
test('the shim API is gone from platform-jwt, not merely unused', () => {
  for (const name of [
    'legacyBootstrapActive',
    'verifyLegacyBootstrapToken',
    'signLegacyBootstrapToken',
  ]) {
    assert.equal(platformJwt[name], undefined, `${name} must not be exported`);
  }
});

test('a token signed with the old shared secret verifies nowhere', async () => {
  const token = await withPreCutoverEnv(
    async (secret) => legacyToken({ id: 3, username: 'usernode-capture-admin' }, secret)
  );
  // Back in the default (post-cutover) env: RS256 + issuer + audience + pur.
  assert.throws(() => platformJwt.verifyAppIdentityToken(token, { appId: SELF_APP_ID }));
  // And an HS256 forgery using the RSA public PEM as the HMAC key is
  // refused on algorithm, not accepted as a same-key match.
  const forged = jwt.sign({ id: 3, pur: 'iframe' }, keys.IFRAME_JWT_PUBLIC_KEY, {
    algorithm: 'HS256',
    issuer: 'usernode',
    audience: platformJwt.appAudience(SELF_APP_ID),
    expiresIn: '15m',
  });
  assert.throws(() => platformJwt.verifyAppIdentityToken(forged, { appId: SELF_APP_ID }));
});
