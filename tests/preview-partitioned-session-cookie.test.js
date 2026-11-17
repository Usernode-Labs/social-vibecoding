'use strict';

// A preview of Homeroom keeps its reviewer signed in inside the frame it is
// shown in (src/services/browser-session-cookies.js, "A preview of Homeroom,
// in a frame on another site").
//
// Previews have a domain of their own (config.previewsDomain), so the frame on
// app.onhomeroom.com that shows one is on another site. The preview traded
// the frame's token for a SameSite=Lax session cookie, which a browser
// neither keeps nor sends there: every preview opened on the signed-out
// "Sign in to open this page" sheet. In a preview over HTTPS the session and
// its cache label are partitioned (SameSite=None; Secure; Partitioned), and
// the platform's own cookies stay Lax.
//
// Run with: node --test tests/preview-partitioned-session-cookie.test.js

// The auth middleware reads both at load: a preview, serving app 42.
process.env.USERNODE_ENV = 'staging';
process.env.USERNODE_APP_ID = '42';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');
const { sessionCookieOptions, setSessionCookie, clearSessionCookies, partitionedPreviewCookies } =
  require('../src/services/browser-session-cookies');
const { setSessionCacheCookie } = require('../src/services/browser-api-cache');

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}

function recorder() {
  const calls = [];
  return {
    calls,
    res: {
      cookie: (name, value, options) => calls.push({ op: 'set', name, value, options }),
      clearCookie: (name, options) => calls.push({ op: 'clear', name, options }),
    },
  };
}

test('only a preview over HTTPS partitions its session cookies', () => {
  assert.equal(partitionedPreviewCookies({ USERNODE_ENV: 'staging', NODE_ENV: 'production' }), true);
  assert.equal(partitionedPreviewCookies({ NODE_ENV: 'production' }), false, 'the platform itself');
  assert.equal(partitionedPreviewCookies({ USERNODE_ENV: 'production', NODE_ENV: 'production' }), false);
  assert.equal(partitionedPreviewCookies({ USERNODE_ENV: 'staging' }), false, 'plain HTTP cannot be Partitioned');
  assert.equal(partitionedPreviewCookies({ USERNODE_ENV: 'staging', NODE_ENV: 'development' }), false);

  const expiry = new Date(Date.now() + 3600e3);
  const preview = sessionCookieOptions(expiry, { USERNODE_ENV: 'staging', NODE_ENV: 'production' });
  assert.deepEqual(preview, { httpOnly: true, secure: true, sameSite: 'none', partitioned: true,
    path: '/', expires: expiry });
  const platform = sessionCookieOptions(expiry, { NODE_ENV: 'production' });
  assert.deepEqual(platform, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires: expiry });
});

test('a preview writes the session and its cache label partitioned, after dropping a Lax copy', t => {
  environment(t, { USERNODE_ENV: 'staging', NODE_ENV: 'production', BROWSER_SITE_ISOLATION: undefined });
  const expiry = new Date(Date.now() + 3600e3);
  const { calls, res } = recorder();
  setSessionCookie(res, 'fake-preview-session', expiry);
  setSessionCacheCookie(res, 'fake-preview-session', expiry);

  assert.deepEqual(calls.map(({ op, name }) => `${op} ${name}`), [
    'clear session', 'set session',
    'clear __Host-usernode_api_scope', 'set __Host-usernode_api_scope',
    'clear usernode_api_scope',
  ]);
  for (const set of calls.filter(c => c.op === 'set')) {
    assert.equal(set.options.sameSite, 'none', set.name);
    assert.equal(set.options.partitioned, true, set.name);
    assert.equal(set.options.secure, true, set.name);
    assert.equal(set.options.path, '/', set.name);
    assert.equal(set.options.domain, undefined, set.name);
    assert.equal(set.options.expires.getTime(), expiry.getTime(), set.name);
  }
  assert.equal(calls[1].options.httpOnly, true, 'the session stays HttpOnly');
  assert.equal(calls[3].options.httpOnly, false, 'the cache label stays readable');
  // The deletion names the unpartitioned Lax copy and carries no expiry of
  // its own, which Express's clearCookie would take over its past date.
  for (const clear of [calls[0], calls[2]]) {
    assert.equal(clear.options.sameSite, 'lax', clear.name);
    assert.equal(clear.options.partitioned, undefined, clear.name);
    assert.equal(clear.options.expires, undefined, clear.name);
    assert.equal(clear.options.path, '/', clear.name);
  }
});

test('the platform itself keeps Lax cookies and drops no copy', t => {
  environment(t, { USERNODE_ENV: undefined, NODE_ENV: 'production', BROWSER_SITE_ISOLATION: undefined });
  const { calls, res } = recorder();
  setSessionCookie(res, 'fake-platform-session', new Date(Date.now() + 3600e3));
  setSessionCacheCookie(res, 'fake-platform-session', new Date(Date.now() + 3600e3));
  assert.deepEqual(calls.map(({ op, name }) => `${op} ${name}`),
    ['set session', 'set __Host-usernode_api_scope', 'clear usernode_api_scope']);
  for (const set of calls.filter(c => c.op === 'set')) {
    assert.equal(set.options.sameSite, 'lax', set.name);
    assert.equal(set.options.partitioned, undefined, set.name);
  }
});

test('signing out of a preview deletes the partitioned copies', t => {
  environment(t, { USERNODE_ENV: 'staging', NODE_ENV: 'production', BROWSER_SITE_ISOLATION: undefined });
  const { calls, res } = recorder();
  clearSessionCookies(res);
  const byName = Object.fromEntries(calls.map(c => [c.name, c.options]));
  assert.equal(byName.session.partitioned, true);
  assert.equal(byName.session.sameSite, 'none');
  assert.equal(byName['__Host-usernode_api_scope'].partitioned, true);
});

// The whole trip: the frame's token, traded by the auth middleware, comes
// back as Set-Cookie headers a browser keeps inside a cross-site frame.
test('a preview signing in from the frame token answers with partitioned Set-Cookie headers', async t => {
  environment(t, { NODE_ENV: 'production', BROWSER_SITE_ISOLATION: undefined });
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    auth: require.resolve('../src/middleware/auth'),
  };
  const saved = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, require.cache[id]]));
  t.after(() => {
    for (const [k, id] of Object.entries(ids)) {
      if (saved[k]) require.cache[id] = saved[k]; else delete require.cache[id];
    }
  });
  const stub = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] }; };
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  const reviewer = { id: 7001, username: 'preview-user-7001', is_admin: false, admin_readonly: false,
    app_quota: 0, has_platform_access: true };
  stub(ids.pool, { getPool: () => ({ async query(sql) {
    if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [reviewer] };
    return { rows: [] };
  } }) });
  delete require.cache[ids.auth];
  const { authMiddleware } = require(ids.auth);

  const app = express();
  app.use(authMiddleware({}));
  app.get('/api/auth/me', (req, res) => res.json({ id: req.user.id }));
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));

  const token = platformJwt.signAppIdentityToken({ appId: 42, user: { id: reviewer.id, username: reviewer.username }, ttl: '15m' });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/me?token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: reviewer.id });

  const headers = res.headers.getSetCookie();
  const kept = headers.filter(h => !/Expires=Thu, 01 Jan 1970/.test(h));
  assert.deepEqual(kept.map(h => h.split('=')[0]).sort(), ['__Host-usernode_api_scope', 'session']);
  for (const header of kept) {
    assert.match(header, /; Secure/, header);
    assert.match(header, /; Partitioned/, header);
    assert.match(header, /; SameSite=None/, header);
    assert.doesNotMatch(header, /; Domain=/i, header);
  }
  const session = headers.indexOf(kept.find(h => h.startsWith('session=')));
  assert.match(headers[session - 1], /^session=; .*Expires=Thu, 01 Jan 1970.*SameSite=Lax/,
    'the Lax copy is dropped just before the partitioned session is written');
  assert.doesNotMatch(headers[session - 1], /Partitioned/);
});
