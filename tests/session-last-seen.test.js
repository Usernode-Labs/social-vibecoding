'use strict';

// #5974: when a browser session was last used (sessions.last_seen_at), for
// Settings › Linked devices. The auth middleware (src/middleware/auth.js)
// stamps it on an authenticated request at most once per 15 minutes per
// session, in a write the response never waits for:
//
//   - a row never stamped, or stamped more than 15 minutes ago, is stamped;
//   - a row stamped more recently is not, so a busy tab costs one write a
//     quarter of an hour rather than one a request;
//   - the UPDATE repeats the window in SQL, so two requests racing on one
//     stale row cost one row write;
//   - a failed stamp is a warning, never a failed request.
//
// Run with: node --test tests/session-last-seen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makePool(handlers) {
  const calls = [];
  return {
    calls,
    issued(re) { return calls.filter((c) => re.test(c.sql)); },
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      for (const [re, rows] of handlers) {
        if (re.test(String(sql))) {
          if (rows instanceof Error) throw rows;
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
  };
}

const warnings = [];

function loadMiddleware(pool) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/middleware/auth'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  stub(ids.logger, { info() {}, warn(...args) { warnings.push(args); }, error() {}, debug() {} });
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

const MINUTE = 60_000;

function sessionRow({ lastSeenAt }) {
  return {
    user_id: 7, username: 'seen', is_admin: false, admin_readonly: false, app_quota: 0,
    ai_progress_estimate: false, has_platform_access: true, is_synthetic: false,
    created_at: new Date(Date.now() - 86400_000).toISOString(),
    expires_at: new Date(Date.now() + 80 * 86400_000).toISOString(),
    last_seen_at: lastSeenAt,
  };
}

async function request(pool) {
  const { authMiddleware, restore } = loadMiddleware(pool);
  try {
    const mw = authMiddleware({});
    const req = { path: '/api/me/phones', cookies: { session: 'cookie-A' }, query: {}, headers: {} };
    const res = {
      cookie() {}, clearCookie() {}, setHeader() {}, set() {}, vary() {},
      redirect() { res.redirected = true; },
      status: (code) => ({ json: (body) => { res.statusCode = code; res.body = body; } }),
    };
    let nexted = false;
    await mw(req, res, () => { nexted = true; });
    // The stamp is not awaited: let the microtask it was queued on run.
    await new Promise((resolve) => setImmediate(resolve));
    return { req, res, nexted };
  } finally {
    restore();
  }
}

const STAMP = /UPDATE sessions\s+SET last_seen_at = NOW\(\)/;

test('a session never stamped is stamped on its request', async () => {
  const pool = makePool([[/FROM sessions s JOIN users u/, [sessionRow({ lastSeenAt: null })]]]);
  const { req, nexted } = await request(pool);
  assert.equal(nexted, true);
  assert.equal(req.user.id, 7);
  const stamps = pool.issued(STAMP);
  assert.equal(stamps.length, 1);
  assert.deepEqual(stamps[0].params, ['cookie-A'], 'this session only');
  assert.match(stamps[0].sql, /last_seen_at IS NULL OR last_seen_at < NOW\(\) - INTERVAL '15 minutes'/,
    'the window is repeated in SQL, so a racing request writes nothing');
});

test('a session stamped more than fifteen minutes ago is stamped again', async () => {
  const pool = makePool([[/FROM sessions s JOIN users u/, [sessionRow({ lastSeenAt: new Date(Date.now() - 16 * MINUTE).toISOString() })]]]);
  await request(pool);
  assert.equal(pool.issued(STAMP).length, 1);
});

test('a session stamped within fifteen minutes is left alone', async () => {
  const pool = makePool([[/FROM sessions s JOIN users u/, [sessionRow({ lastSeenAt: new Date(Date.now() - 14 * MINUTE) })]]]);
  const { nexted } = await request(pool);
  assert.equal(nexted, true);
  assert.equal(pool.issued(STAMP).length, 0, 'one write a quarter of an hour, not one a request');
});

test('the middleware reads the stamp with the session, and a failed stamp is only a warning', async () => {
  const pool = makePool([
    [/FROM sessions s JOIN users u/, [sessionRow({ lastSeenAt: null })]],
    [STAMP, new Error('synthetic write failure')],
  ]);
  warnings.length = 0;
  const { nexted, res } = await request(pool);
  assert.equal(nexted, true, 'the request went through');
  assert.equal(res.statusCode, undefined, 'and was not answered with an error');
  assert.ok(warnings.some(([, msg]) => /last-seen/.test(msg)), 'the failure is logged');
  const select = pool.calls.find((c) => /FROM sessions s JOIN users u/.test(c.sql));
  assert.match(select.sql, /s\.last_seen_at/, 'the row\'s stamp comes with the session read, no extra query');
});

test('the throttle is fifteen minutes, in the source as in the SQL', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/middleware/auth.js'), 'utf8');
  assert.match(source, /const SESSION_SEEN_THROTTLE_MS = 15 \* 60 \* 1000;/);
  assert.match(source, /touchSessionLastSeen\(pool, cookieToken, rows\[0\]\);/, 'on the cookie path, after the session is accepted');
  assert.doesNotMatch(source, /await touchSessionLastSeen/, 'never awaited');
});
