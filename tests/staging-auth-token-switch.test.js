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
const COOKIE_USER = { user_id: 2, username: 'usernode-capture', is_admin: false, admin_readonly: false, app_quota: 0, ai_progress_estimate: false, expires_at: new Date(Date.now() + 3600_000).toISOString() };
const TOKEN_USER = { id: 3, username: 'usernode-capture-admin', is_admin: true, admin_readonly: true, app_quota: 0, ai_progress_estimate: false };

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
//
// JWT_SECRET is deleted alongside it so this stays a pure fail-closed
// assertion: with a legacy secret present AND no key material this
// container would match the pre-cutover bootstrap shim's gate, which the
// three tests after this one cover on purpose.
test('without USERNODE_APP_ID every token is refused (fails closed)', async () => {
  const saved = process.env.USERNODE_APP_ID;
  const savedSecret = process.env.JWT_SECRET;
  delete process.env.USERNODE_APP_ID;
  delete process.env.JWT_SECRET;
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
    if (savedSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
  }
});

// ── pre-cutover staging bootstrap shim ──────────────────────────────────
//
// A preview container's env is built by the DEPLOYED platform, which
// predates app-identity-env.js: it injects the old shared HS256 secret and
// neither IFRAME_JWT_PUBLIC_KEY nor USERNODE_APP_ID. Without the shim the
// preview of the cutover itself is unopenable — the checks runner cannot
// mint a session, so every assertion on an authenticated route fails.
//
// The shim's whole safety argument is its gate, so the gate is what these
// tests pin: active only in that exact pre-cutover shape, inert the moment
// ANY conjunct stops holding.

// The legacy parent's token: bare HS256, no iss/aud/pur — the shape the
// deployed /api/iframe-token still emits.
function legacyToken(user, secret) {
  return jwt.sign({ ...user, usernode_pubkey: null, locale: null }, secret, { expiresIn: '15m' });
}

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
    JWT_SECRET: 'legacy-shared-secret-0123456789abcdef',
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

test('a pre-cutover preview accepts the legacy parent token via the shim', async () => {
  await withPreCutoverEnv(async (secret) => {
    assert.equal(platformJwt.legacyBootstrapActive(), true,
      'the pre-cutover preview shape must satisfy the gate');
    const pool = makePool(defaultHandlers());
    const { authMiddleware, restore } = loadMiddleware(pool);
    try {
      const mw = authMiddleware({});
      const token = legacyToken({ id: 3, username: 'usernode-capture-admin' }, secret);
      const { req, nexted } = await run(mw, { token });
      assert.equal(nexted, true);
      assert.equal(req.user.id, 3, 'the checks-runner admin identity must win');
      assert.equal(req.user.isAdmin, true);
      assert.equal(pool.issued(/INSERT INTO sessions/), true);
    } finally {
      restore();
    }
  });
});

test('the shim still rejects a legacy token signed with the WRONG secret', async () => {
  await withPreCutoverEnv(async () => {
    const pool = makePool(defaultHandlers());
    const { authMiddleware, restore } = loadMiddleware(pool);
    try {
      const mw = authMiddleware({});
      const token = legacyToken({ id: 3, username: 'usernode-capture-admin' }, 'not-the-secret');
      const { req, nexted } = await run(mw, { token });
      assert.equal(nexted, true);
      assert.equal(req.user.id, 2, 'a token we cannot verify must never switch identity');
      assert.equal(pool.issued(/INSERT INTO sessions/), false);
    } finally {
      restore();
    }
  });
});

// The conjunct that makes the shim structurally unreachable in
// production: config.js REQUIRED_PROD lists IFRAME_JWT_PUBLIC_KEY, so
// production cannot boot without it, so this branch can never be taken
// there no matter what else is set.
test('the shim is inert once IFRAME_JWT_PUBLIC_KEY is present', async () => {
  await withPreCutoverEnv(async (secret) => {
    assert.equal(platformJwt.legacyBootstrapActive(), false,
      'key material present → the real path only');
    const pool = makePool(defaultHandlers());
    const { authMiddleware, restore } = loadMiddleware(pool);
    try {
      const mw = authMiddleware({});
      const { req, nexted } = await run(mw, {
        token: legacyToken({ id: 3, username: 'usernode-capture-admin' }, secret),
      });
      assert.equal(nexted, true);
      assert.equal(req.user.id, 2);
      assert.equal(pool.issued(/INSERT INTO sessions/), false);
    } finally {
      restore();
    }
  }, { overrides: { IFRAME_JWT_PUBLIC_KEY: keys.IFRAME_JWT_PUBLIC_KEY } });
});

// Self-disabling: the moment the cutover is on main, appIdentityEnv()
// gives every new preview USERNODE_APP_ID, and the shim is dead code.
test('the shim is inert once USERNODE_APP_ID is present', async () => {
  await withPreCutoverEnv(async () => {
    assert.equal(platformJwt.legacyBootstrapActive(), false,
      'a container that knows its app id is post-cutover');
  }, { overrides: { USERNODE_APP_ID: '42' } });
});

test('the shim is inert outside staging, and with no legacy secret', async () => {
  await withPreCutoverEnv(async () => {
    assert.equal(platformJwt.legacyBootstrapActive(), false, 'production is never eligible');
  }, { overrides: { USERNODE_ENV: 'production' } });

  await withPreCutoverEnv(async () => {
    assert.equal(platformJwt.legacyBootstrapActive(), false, 'nothing to verify against');
  }, { overrides: { JWT_SECRET: undefined } });
});

// A caller that forgets the gate must not be able to smuggle a legacy
// token into a container that has real key material — in EITHER direction.
test('verifyLegacyBootstrapToken throws when the shim is not active', () => {
  assert.equal(platformJwt.legacyBootstrapActive(), false);
  assert.throws(
    () => platformJwt.verifyLegacyBootstrapToken(legacyToken({ id: 3 }, 'whatever')),
    /legacy bootstrap not active/
  );
});

test('signLegacyBootstrapToken throws when the shim is not active', () => {
  assert.equal(platformJwt.legacyBootstrapActive(), false);
  assert.throws(
    () => platformJwt.signLegacyBootstrapToken({ user: { id: 3, username: 'x' } }),
    /legacy bootstrap not active/
  );
});

// The mint half exists for the preview acting AS the parent shell: the
// self-app clone renders app views, each of which fetches
// /api/iframe-token for the embedded child. A preview has no private key,
// so without this the endpoint 500s on every app view. Round-trip the
// token through the verify half to pin that the two agree on the shape.
test('the shim mints a legacy-shape token a pre-cutover container can verify', async () => {
  await withPreCutoverEnv(async (secret) => {
    const token = platformJwt.signLegacyBootstrapToken({
      user: { id: 3, username: 'usernode-capture-admin', usernode_pubkey: 'ut1abc', locale: 'id' },
    });
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    assert.equal(header.alg, 'HS256', 'the retired signer emitted bare HS256');

    const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
    assert.equal(claims.id, 3);
    assert.equal(claims.username, 'usernode-capture-admin');
    assert.equal(claims.usernode_pubkey, 'ut1abc');
    assert.equal(claims.locale, 'id');
    assert.equal(claims.aud, undefined, 'no audience — the legacy shape had none');
    assert.equal(claims.pur, undefined);
    assert.ok(claims.exp > claims.iat, 'and it expires');

    // The two halves of the shim are each other's counterpart.
    assert.deepEqual(platformJwt.verifyLegacyBootstrapToken(token).id, 3);
  });
});

test('a legacy-minted token is useless against a post-cutover container', async () => {
  const token = await withPreCutoverEnv(async () => platformJwt.signLegacyBootstrapToken({
    user: { id: 3, username: 'usernode-capture-admin' },
  }));
  // Back in the default (post-cutover) env: RS256 + audience + purpose.
  assert.throws(() => platformJwt.verifyAppIdentityToken(token, { appId: SELF_APP_ID }));
});
