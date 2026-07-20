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

// IS_STAGING is read at module load — must be set before the require.
process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const SECRET = 'test-secret';

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
    const mw = authMiddleware({ jwtSecret: SECRET });
    const token = jwt.sign({ id: 3, username: 'usernode-capture-admin' }, SECRET, { expiresIn: '15m' });
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
    const mw = authMiddleware({ jwtSecret: SECRET });
    const token = jwt.sign({ id: 2, username: 'usernode-capture' }, SECRET, { expiresIn: '15m' });
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
    const mw = authMiddleware({ jwtSecret: SECRET });
    const token = jwt.sign({ id: 3, username: 'x' }, 'wrong-secret', { expiresIn: '15m' });
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
    const mw = authMiddleware({ jwtSecret: SECRET });
    const token = jwt.sign({ id: 99, username: 'ghost' }, SECRET, { expiresIn: '15m' });
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
    const mw = authMiddleware({ jwtSecret: SECRET });
    const { req, nexted } = await run(mw, {});
    assert.equal(nexted, true);
    assert.equal(req.user.id, 2);
    assert.equal(pool.issued(/INSERT INTO sessions/), false);
  } finally {
    restore();
  }
});
