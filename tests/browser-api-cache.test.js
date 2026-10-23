'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { browserApiCachePolicy, sessionCacheScope, setSessionCacheCookie,
  SCOPE_COOKIE, SCOPE_HEADER } = require('../src/services/browser-api-cache');

test('cache hints are distinct non-credential labels with the session cookie lifetime', () => {
  const token = 'fake-session-token-A'.repeat(4), other = 'fake-session-token-B'.repeat(4);
  const hint = sessionCacheScope(token);
  assert.match(hint, /^[a-f0-9]{64}$/);
  assert.notEqual(hint, token);
  assert.notEqual(hint, sessionCacheScope(other));
  const calls = [], expiry = new Date(Date.now() + 86400_000);
  setSessionCacheCookie({ cookie: (...args) => calls.push(args) }, token, expiry);
  assert.equal(calls[0][0], SCOPE_COOKIE);
  assert.equal(calls[0][1], hint);
  assert.equal(calls[0][2].httpOnly, false);
  assert.equal(calls[0][2].path, '/');
  assert.equal(calls[0][2].expires.getTime(), expiry.getTime());
});

test('HTTP representations and 304s retain current cookie authority and cache policy', async t => {
  const rows = new Map([
    ['fake-A', { user_id: 101, username: 'fake-A' }],
    ['fake-B', { user_id: 202, username: 'fake-B' }],
  ]);
  const pool = { async query(sql, params) {
    if (/UPDATE sessions/.test(sql)) return { rows: [{ expires_at: params[0] }] };
    assert.match(sql, /FROM sessions s JOIN users u/);
    const user = rows.get(params[0]);
    return { rows: user ? [{ ...user, native_session_valid: true, is_synthetic: false,
      created_at: new Date(), expires_at: new Date(Date.now() + 7 * 86400_000), has_platform_access: true }] : [] };
  } };
  const poolId = require.resolve('../src/db/pool'), saved = require.cache[poolId];
  require.cache[poolId] = { id: poolId, filename: poolId, loaded: true, exports: { getPool: () => pool } };
  const { authMiddleware } = require('../src/middleware/auth');
  const { createSessionCookie } = require('../src/routes/auth');
  const app = express();
  app.use(cookieParser());
  app.use(browserApiCachePolicy);
  app.use(authMiddleware({}));
  app.get('/api/private-fixture', (req, res) => res.json({ private: `FAKE_USER_${req.user.id}` }));
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
  const server = http.createServer(app);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (saved) require.cache[poolId] = saved; else delete require.cache[poolId];
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const a = await fetch(origin + '/api/private-fixture', { headers: { cookie: 'session=fake-A' } });
  assert.deepEqual(await a.json(), { private: 'FAKE_USER_101' });
  assert.equal(a.headers.get(SCOPE_HEADER), sessionCacheScope('fake-A'));
  assert.match(a.headers.get('vary'), /Cookie/i);
  assert.match(a.headers.get('vary'), /Authorization/i);
  assert.equal(a.headers.get('cache-control'), 'private');
  const b = await fetch(origin + '/api/private-fixture', { headers: {
    cookie: 'session=fake-B', 'if-none-match': a.headers.get('etag'),
    [SCOPE_HEADER]: sessionCacheScope('fake-A'),
  } });
  assert.equal(b.status, 200, 'the other user cannot reuse the previous body through a 304');
  assert.deepEqual(await b.json(), { private: 'FAKE_USER_202' });
  assert.equal(b.headers.get(SCOPE_HEADER), sessionCacheScope('fake-B'), 'a forged cache label grants no authority');
  assert.notEqual(a.headers.get('etag'), b.headers.get('etag'));
  // Node fetch adds Cache-Control:no-cache to conditional requests. Use a
  // real HTTP conditional read to exercise Express's actual 304 branch.
  const validated = await new Promise((resolve, reject) => {
    http.get(origin + '/api/private-fixture', { headers: {
      cookie: 'session=fake-B', 'if-none-match': b.headers.get('etag'),
    } }, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });
  assert.equal(validated.statusCode, 304);
  assert.match(validated.headers.vary, /Cookie/);
  assert.equal(validated.headers[SCOPE_HEADER.toLowerCase()], sessionCacheScope('fake-B'));
  const me = await fetch(origin + '/api/auth/me', { headers: { cookie: 'session=fake-A' } });
  assert.equal(me.headers.get('cache-control'), 'private, no-store');
  assert.equal(me.headers.get(SCOPE_HEADER), sessionCacheScope('fake-A'));
  const denied = await fetch(origin + '/api/auth/me');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('cache-control'), 'private, no-store');
  assert.equal(denied.headers.get(SCOPE_HEADER), null);
  const cookies = [];
  createSessionCookie({ cookie: (...args) => cookies.push(args) }, 'fake-new-session', new Date(Date.now() + 86400_000));
  assert.equal(cookies[0][0], 'session');
  assert.equal(cookies[0][2].httpOnly, true, 'the credential remains HttpOnly');
  assert.equal(cookies[1][0], SCOPE_COOKIE);
  assert.equal(cookies[1][1], sessionCacheScope('fake-new-session'));
});
