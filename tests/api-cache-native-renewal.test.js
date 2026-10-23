'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { loadTsx } = require('./lib/render-tsx');
const { worker, ORIGIN, SCOPE_HEADER } = require('./lib/private-cache-worker');
const { browserApiCachePolicy, sessionCacheScope, SCOPE_COOKIE } = require('../src/services/browser-api-cache');
const nativeChromeSource = fs.readFileSync(require.resolve('../public/js/native-chrome.js'), 'utf8');
const { installApiCacheIdentity } = loadTsx('frontend/src/lib/api-cache-identity.ts');
const { installSessionRenewalRetry } = loadTsx('frontend/src/lib/session-renewal-retry.ts');

// test:changed: when public/sw.js (native cookie rotation through the worker)
// test:changed: when src/middleware/auth.js (real Set-Cookie renewal)

test('admitted native recovery verifies the rotated cookie and immediately restores same-user offline reads', async t => {
  const firstToken = 'FAKE_NATIVE_COOKIE_1', secondToken = 'FAKE_NATIVE_COOKIE_2';
  const rows = new Map([[firstToken, { user_id: 101, username: 'FAKE_SAME_USER',
    native_session_valid: true, has_platform_access: true, is_synthetic: false,
    created_at: new Date(), expires_at: new Date(Date.now() + 90 * 86400_000) }]]);
  const pool = { async query(sql, params) {
    if (/UPDATE sessions/.test(sql)) {
      const row = rows.get(params[1]);
      assert.ok(row);
      row.expires_at = params[0];
      return { rows: [{ expires_at: params[0] }] };
    }
    assert.match(sql, /FROM sessions s JOIN users u/);
    return { rows: rows.has(params[0]) ? [{ ...rows.get(params[0]) }] : [] };
  } };
  const poolId = require.resolve('../src/db/pool'), saved = require.cache[poolId];
  require.cache[poolId] = { id: poolId, filename: poolId, loaded: true, exports: { getPool: () => pool } };
  t.after(() => { if (saved) require.cache[poolId] = saved; else delete require.cache[poolId]; });
  const { authMiddleware } = require('../src/middleware/auth');
  const app = express();
  app.use(cookieParser(), browserApiCachePolicy, authMiddleware({}));
  let privateReads = 0;
  app.get('/api/private-fixture', (req, res) => {
    privateReads++;
    res.json({ userId: req.user.id, fake: 'PERMITTED_SAME_USER' });
  });
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map([['session', firstToken], [SCOPE_COOKIE, sessionCacheScope(firstToken)]]);
  const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const setCookie = raw => {
    const [key, value] = raw.split(';')[0].split('=');
    jar.set(key, value);
  };
  let offline = false, restoreCount = 0, restoredUser = 101;
  const requests = [], windowEvents = {}, intervals = [], storage = new Map();
  const h = worker({ fetcher: async req => {
    if (offline) throw new TypeError('synthetic native offline');
    const headers = new Headers(req.headers);
    headers.set('cookie', cookieHeader());
    const path = new URL(req.url).pathname;
    const response = await fetch(origin + path, { headers, cache: req.cache });
    for (const cookie of response.headers.getSetCookie()) setCookie(cookie);
    requests.push({ path, scope: req.headers.get(SCOPE_HEADER), cache: req.cache,
      renewedHint: response.headers.getSetCookie().some(cookie => cookie.startsWith(SCOPE_COOKIE + '=')) });
    return response;
  } });
  const document = {
    visibilityState: 'visible', addEventListener() {},
    get cookie() { return [...jar].filter(([key]) => key !== 'session').map(([key, value]) => `${key}=${value}`).join('; '); },
    set cookie(value) { setCookie(value); },
  };
  const win = {
    document, location: { origin: ORIGIN, href: ORIGIN + '/' },
    App: { user: { id: 101 }, _sessionFromSnapshot: false },
    addEventListener(name, fn) { windowEvents[name] = fn; },
    localStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    usernode: { isNative: true,
      async getBridgeInfo() { return { version: 5, sessionLifecycleProtocol: 2, capabilities: ['restoreWebSession'] }; },
      async restoreWebSession() {
        restoreCount++;
        rows.clear();
        rows.set(secondToken, { user_id: restoredUser, username: 'FAKE_RESTORED_USER',
          native_session_valid: true, has_platform_access: true, is_synthetic: false,
          created_at: new Date(), expires_at: new Date(Date.now() + 7 * 86400_000) });
        jar.set('session', secondToken); // The OS installs only the protected cookie.
        return { status: 'restored', protocol: 2, userId: String(restoredUser), attemptId: 'nsa_' + 'A'.repeat(43) };
      },
    },
    fetch(req, init) {
      const request = new Request(req, init), url = new URL(request.url);
      return h.get(request.headers.get(SCOPE_HEADER), url.pathname + url.search,
        { method: request.method, headers: request.headers, cache: request.cache });
    },
  };
  // Skip only UI initialization; run the production native recovery methods.
  assert.equal(nativeChromeSource.split('NativeChrome.init();').length, 2);
  vm.runInNewContext(nativeChromeSource.replace('NativeChrome.init();', '/* Test host initializes recovery. */'), {
    window: win, document, App: win.App, localStorage: win.localStorage, console,
    setInterval: fn => intervals.push(fn), setTimeout, clearTimeout, URL, Date, Promise,
  });
  const native = win.NativeChrome;
  native._sessionAdmitted = true;
  native._publicSessionStatus = { identity: { participantId: '101' } };
  installApiCacheIdentity(win);
  installSessionRenewalRetry(win);
  win.UsernodeReact.apiCache.setViewer(101);
  const read = () => win.fetch('/api/private-fixture');
  assert.equal((await (await read()).json()).userId, 101);
  await h.drain();

  native._initSessionRecoveryEvents();
  windowEvents.online();
  const restoration = native._webRecovery;
  assert.ok(restoration);
  await restoration;
  await native.recoverSessionAdmission();
  assert.equal(restoreCount, 1);
  assert.equal(native.webSessionRenewal().epoch, 1);
  assert.equal(jar.get(SCOPE_COOKIE), sessionCacheScope(firstToken), 'native admission did not repair the hint');

  const [first, second] = await Promise.all([read(), read()]);
  assert.equal((await first.json()).userId, 101, 'the first ordinary read after renewal does not abort');
  assert.equal((await second.json()).userId, 101);
  assert.equal(requests.filter(req => req.path === '/api/auth/me').length, 1, 'ordinary readers share one verification');
  const me = requests.find(req => req.path === '/api/auth/me');
  assert.equal(me.renewedHint, true, 'real middleware renewed the cookie pair');
  assert.equal(me.cache, 'no-store');
  assert.equal(me.scope, null);
  assert.equal(jar.get(SCOPE_COOKIE), sessionCacheScope(secondToken));
  assert.equal(requests.at(-1).scope, sessionCacheScope(secondToken));
  assert.equal(requests.at(-1).cache, 'reload');
  await h.drain();
  offline = true;
  for (const response of await Promise.all([read(), read()])) {
    assert.deepEqual(await response.json(), { userId: 101, fake: 'PERMITTED_SAME_USER' });
  }

  // Even if an OS bridge installs another viewer, it cannot disclose that
  // account's ordinary API body to this already-admitted document.
  offline = false;
  restoredUser = 202;
  await native.restoreWebSession({ force: true });
  const before = privateReads;
  await assert.rejects(read(), { name: 'AbortError' });
  assert.equal(privateReads, before, 'viewer mismatch is refused before the private route');
  await h.drain();
});
