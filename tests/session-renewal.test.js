// Sliding session expiry, capped absolutely (#1416).
//
// The report, from a usernode admin: "Ensure sessions don't expire on mobile
// devices, so people don't have to log back in. Bad experience relative to
// what people expect for mobile apps."
//
// The window was seven days and ABSOLUTE — no renewal on use — so somebody
// who opened the app every single day was still signed out every seventh one.
// That is the shape of the complaint: on a phone, being logged out should be
// an event, not a schedule. Raising the number alone only moves the date.
//
// So the fix is two numbers, and neither works without the other:
//   SESSION_IDLE_DAYS  forgets a session on a device nobody returns to.
//   SESSION_MAX_DAYS   stops a renewed one living forever, which is the whole
//                      risk a sliding expiry introduces — without it a stolen
//                      cookie that keeps being used never dies.
//
// Run with: node --test tests/session-renewal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renewCookieSession, SESSION_IDLE_DAYS, SESSION_MAX_DAYS, RENEW_AFTER_MS,
} = require('../src/middleware/auth');

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (d) => new Date(Date.now() + d * DAY);
const daysAgo = (d) => new Date(Date.now() - d * DAY);

function harness({ fail = false } = {}) {
  const calls = [];
  const cookies = [];
  return {
    calls,
    cookies,
    pool: {
      query: async (sql, params) => {
        if (fail) throw new Error('db down');
        calls.push({ sql, params });
        return { rows: [] };
      },
    },
    res: { cookie: (name, value, opts) => cookies.push({ name, value, opts }) },
  };
}

test('#1416: a session well inside its window is not rewritten on every request', async () => {
  // The renewal runs on the read path of every authenticated request. Writing
  // each time would put an UPDATE behind every API call for no benefit.
  const h = harness();
  const out = await renewCookieSession(h.pool, h.res, 'tok', {
    expires_at: daysFromNow(SESSION_IDLE_DAYS - 1),
    created_at: daysAgo(1),
  });
  assert.equal(out, null);
  assert.deepEqual(h.calls, [], 'no write');
  assert.deepEqual(h.cookies, [], 'no cookie churn');
});

test('#1416: a session past its renewal point slides forward, and the cookie follows', async () => {
  const h = harness();
  const out = await renewCookieSession(h.pool, h.res, 'tok', {
    // Just past halfway through the idle window.
    expires_at: new Date(Date.now() + RENEW_AFTER_MS - DAY),
    created_at: daysAgo(30),
  });
  assert.ok(out instanceof Date, 'an expiry was written');
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].sql, /UPDATE sessions SET expires_at/);
  assert.equal(h.calls[0].params[1], 'tok');

  // The browser copy carries its own expiry. Extending only the row would
  // leave the client discarding a session the server still honours.
  assert.equal(h.cookies.length, 1);
  assert.equal(h.cookies[0].name, 'session');
  assert.equal(h.cookies[0].value, 'tok');
  assert.deepEqual(h.cookies[0].opts.expires, out);
  // And the refresh must not quietly downgrade the cookie's protections.
  assert.equal(h.cookies[0].opts.httpOnly, true);
  assert.equal(h.cookies[0].opts.sameSite, 'lax');

  const gained = out.getTime() - Date.now();
  assert.ok(gained > (SESSION_IDLE_DAYS - 1) * DAY, 'slid to roughly a full window');
});

test('#1416: the absolute cap holds, so a continuously-used session still ends', async () => {
  // This is the security half. A session born 364 days ago may only reach its
  // 365th day, not another full idle window.
  const h = harness();
  const born = daysAgo(SESSION_MAX_DAYS - 1);
  const out = await renewCookieSession(h.pool, h.res, 'tok', {
    // Below the ceiling, so there is genuinely room to extend and the clamp
    // is what limits it rather than there being nothing to gain.
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    created_at: born,
  });
  assert.ok(out instanceof Date);
  const ceiling = born.getTime() + SESSION_MAX_DAYS * DAY;
  assert.equal(out.getTime(), ceiling, 'clamped to created_at + SESSION_MAX_DAYS');
  assert.ok(out.getTime() - Date.now() < SESSION_IDLE_DAYS * DAY);
});

test('#1416: a session already at its ceiling is left to die', async () => {
  // Extending by even a second here is what would make the cap decorative.
  const h = harness();
  const born = daysAgo(SESSION_MAX_DAYS);
  const out = await renewCookieSession(h.pool, h.res, 'tok', {
    expires_at: new Date(Date.now() + 60 * 1000),
    created_at: born,
  });
  assert.equal(out, null, 'no extension past the cap');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.cookies, []);
});

test('#1416: a row with no created_at is capped from now, never uncapped', async () => {
  // Rows written before the column existed take the migration's now()
  // default; this is the belt-and-braces path if one arrives null anyway.
  // Treating it as "born now" can only bring a ceiling closer.
  const h = harness();
  const out = await renewCookieSession(h.pool, h.res, 'tok', {
    expires_at: new Date(Date.now() + DAY),
    created_at: null,
  });
  assert.ok(out instanceof Date);
  assert.ok(out.getTime() <= Date.now() + SESSION_MAX_DAYS * DAY);
});

test('#1416: a renewal failure never fails the request that was already authorised', async () => {
  // This runs after the session has been accepted. A database hiccup while
  // EXTENDING it must not turn an authorised request into an error; the cost
  // of skipping is an earlier sign-in, which is the old behaviour.
  const h = harness({ fail: true });
  const out = await renewCookieSession(h.pool, h.res, 'tok', {
    expires_at: new Date(Date.now() + 60 * 1000),
    created_at: daysAgo(1),
  });
  assert.equal(out, null);
  assert.deepEqual(h.cookies, [], 'no cookie set when the write failed');
});

test('#1416: the two windows are ordered, and the mint agrees with the renewal', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  assert.ok(SESSION_IDLE_DAYS < SESSION_MAX_DAYS,
    'an idle window at or past the cap would make the cap unreachable');

  // A new session must start on the same clock the renewal keeps it on.
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8'
  );
  const mint = routes.match(/const SESSION_DAYS = (\d+);/);
  assert.ok(mint, 'SESSION_DAYS is still declared in src/routes/auth.js');
  assert.equal(Number(mint[1]), SESSION_IDLE_DAYS);
});

test('#1416: created_at is added idempotently and not null', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'
  );
  assert.match(
    schema,
    /ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\);/,
    'the cap has nothing to measure from without this column'
  );
});
