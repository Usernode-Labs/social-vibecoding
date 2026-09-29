// Browser session renewal: mobile-like idle lease with a fixed safety cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renewCookieSession,
  SESSION_IDLE_DAYS,
  SESSION_MAX_DAYS,
  SESSION_RENEW_BEFORE_MS,
} = require('../src/middleware/auth');

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days) => new Date(Date.now() + days * DAY_MS);
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

function harness({ fail = false, update = true } = {}) {
  const queries = [];
  const cookies = [];
  return {
    queries,
    cookies,
    pool: {
      query: async (sql, params) => {
        if (fail) throw new Error('database unavailable');
        queries.push({ sql, params });
        return { rows: update ? [{ expires_at: params[0] }] : [] };
      },
    },
    res: {
      cookie: (name, value, options) => cookies.push({ name, value, options }),
    },
  };
}

test('a new session is not rewritten before one day of its lease has elapsed', async () => {
  const h = harness();
  const result = await renewCookieSession(h.pool, h.res, 'token', {
    expires_at: daysFromNow(SESSION_IDLE_DAYS - 0.5),
    created_at: daysAgo(0.5),
  });

  assert.equal(result, null);
  assert.deepEqual(h.queries, []);
  assert.deepEqual(h.cookies, []);
});

test('a due session renews its database lease and protected cookie together', async () => {
  const h = harness();
  const previousExpiry = new Date(Date.now() + SESSION_RENEW_BEFORE_MS - 60_000);
  const result = await renewCookieSession(h.pool, h.res, 'token', {
    expires_at: previousExpiry,
    created_at: daysAgo(2),
  });

  assert.ok(result instanceof Date);
  assert.equal(h.queries.length, 1);
  assert.match(h.queries[0].sql, /UPDATE sessions/);
  assert.match(h.queries[0].sql, /expires_at = \$3 AND expires_at > NOW\(\)/);
  assert.deepEqual(h.queries[0].params.slice(1), ['token', previousExpiry]);

  assert.equal(h.cookies.length, 1);
  assert.equal(h.cookies[0].name, 'session');
  assert.equal(h.cookies[0].value, 'token');
  assert.equal(h.cookies[0].options.httpOnly, true);
  assert.equal(h.cookies[0].options.sameSite, 'lax');
  assert.deepEqual(h.cookies[0].options.expires, result);

  const remaining = result.getTime() - Date.now();
  assert.ok(remaining > (SESSION_IDLE_DAYS - 1) * DAY_MS);
  assert.ok(remaining <= SESSION_IDLE_DAYS * DAY_MS);
});

test('renewal is clamped to the absolute lifetime cap', async () => {
  const h = harness();
  const createdAt = daysAgo(SESSION_MAX_DAYS - 1);
  const result = await renewCookieSession(h.pool, h.res, 'token', {
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    created_at: createdAt,
  });

  assert.ok(result instanceof Date);
  assert.equal(result.getTime(), createdAt.getTime() + SESSION_MAX_DAYS * DAY_MS);
  assert.equal(h.cookies.length, 1);
});

test('a session already at its absolute cap is left to expire', async () => {
  const h = harness();
  const createdAt = daysAgo(SESSION_MAX_DAYS - 1);
  const result = await renewCookieSession(h.pool, h.res, 'token', {
    expires_at: new Date(createdAt.getTime() + SESSION_MAX_DAYS * DAY_MS),
    created_at: createdAt,
  });

  assert.equal(result, null);
  assert.deepEqual(h.queries, []);
  assert.deepEqual(h.cookies, []);
});

test('a concurrently changed or deleted row never receives a renewed cookie', async () => {
  const h = harness({ update: false });
  const result = await renewCookieSession(h.pool, h.res, 'token', {
    expires_at: daysFromNow(1),
    created_at: daysAgo(1),
  });

  assert.equal(result, null);
  assert.equal(h.queries.length, 1);
  assert.deepEqual(h.cookies, []);
});

test('a row without a trustworthy creation time is never renewed', async () => {
  const h = harness();
  const result = await renewCookieSession(h.pool, h.res, 'token', {
    expires_at: daysFromNow(1),
    created_at: null,
  });

  assert.equal(result, null);
  assert.deepEqual(h.queries, []);
  assert.deepEqual(h.cookies, []);
});

test('a renewal failure does not fail the already-authorized request', async () => {
  const h = harness({ fail: true });
  const result = await renewCookieSession(h.pool, h.res, 'token', {
    expires_at: daysFromNow(1),
    created_at: daysAgo(1),
  });

  assert.equal(result, null);
  assert.deepEqual(h.cookies, []);
});

test('mint and renewal use the same idle lease and retain a larger hard cap', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  const mintDays = routes.match(/const SESSION_DAYS = (\d+);/);

  assert.ok(mintDays);
  assert.equal(Number(mintDays[1]), SESSION_IDLE_DAYS);
  assert.ok(SESSION_IDLE_DAYS < SESSION_MAX_DAYS);
  assert.equal(SESSION_RENEW_BEFORE_MS, (SESSION_IDLE_DAYS - 1) * DAY_MS);
});

test('the schema records the fixed birthday used by the absolute cap', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

  assert.match(
    schema,
    /ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\);/
  );
});
