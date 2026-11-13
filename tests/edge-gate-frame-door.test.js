// The app-host gate (src/services/edge-gate.js) when Homeroom frames apps
// from ANOTHER site: the platform on app.onhomeroom.com, apps on
// <slug>.onhomeroom.app (docs/plans/browser-site-isolation.md, step 4).
//
// In such a frame a SameSite=Lax cookie is never sent, and with third-party
// cookies blocked no unpartitioned cookie is kept at all. What it pins:
//   * a frame's token opens a PARTITIONED door (`__Host-`, Secure,
//     SameSite=None, Partitioned), door-only like before; a top-level visit
//     keeps the Lax cookie;
//   * a frame navigation that holds nothing valid gets the frame door page
//     (401, never the app, never the sign-in hop and its state cookie),
//     which only the platform may frame and which asks only the platform;
//   * the page's trade, `/__usernode_access?frame=<token>`, opens the door
//     for a member's token from a frame, and refuses anything else onto the
//     loop marker, where the page says the app cannot open here;
//   * a browser that keeps no cookie in the frame is told so instead of
//     being handed a page whose every asset would be refused.
// tests/edge-gate.test.js pins today's shared-site layout, which this leaves
// as it was. scripts/verify-framed-private-app.js runs the same flow in a
// real browser with third-party cookies blocked.
//
// The pool is stubbed via require.cache, the tests/kudos.test.js pattern.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const express = require('express');
const cookieParser = require('cookie-parser');

// The layout is read when the modules load: set it first.
process.env.NODE_ENV = 'production';
process.env.USERNODE_DOMAIN = 'app.onhomeroom.com';
process.env.USERNODE_APPS_DOMAIN = 'onhomeroom.app';
delete process.env.APP_HOST_SIGNIN;
delete process.env.BROWSER_SITE_ISOLATION;
require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const PLATFORM = 'https://app.onhomeroom.com';
const PRIV_HOST = 'privapp.onhomeroom.app';
const PREVIEW_HOST = 'privapp--s42.onhomeroom.app';
const PUB_HOST = 'pubapp.onhomeroom.app';
const PRIV_APP_ID = 7;
const PUB_APP_ID = 1;
const MEMBER_ID = 10;
const OUTSIDER_ID = 99;
const CAPTURE_ID = 77;

const APPS = {
  pubapp: { id: PUB_APP_ID, slug: 'pubapp', view_visibility: 'public' },
  privapp: { id: PRIV_APP_ID, slug: 'privapp', view_visibility: 'private' },
};
const byId = (id) => Object.values(APPS).find((a) => a.id === Number(id));

const fakePool = {
  async query(sql, params = []) {
    if (/FROM user_app_blocks/.test(sql)) return { rows: [] };
    if (/SELECT id, view_visibility, moderation_suspended_at FROM apps WHERE slug/.test(sql)) {
      const app = APPS[params[0]];
      return { rows: app ? [{ id: app.id, view_visibility: app.view_visibility }] : [] };
    }
    if (/SELECT view_visibility, moderation_suspended_at FROM apps WHERE id/.test(sql)) {
      const app = byId(params[0]);
      return { rows: app ? [{ view_visibility: app.view_visibility }] : [] };
    }
    if (/FROM app_collaborators WHERE app_id = \$1 AND status = 'member'/.test(sql)) {
      return { rows: params[0] === PRIV_APP_ID ? [{ user_id: MEMBER_ID }] : [] };
    }
    if (/FROM app_collaborators WHERE app_id = \$1 AND user_id = \$2/.test(sql)) {
      return { rows: params[0] === PRIV_APP_ID && params[1] === MEMBER_ID ? [{ '?column?': 1 }] : [] };
    }
    if (/SELECT is_admin FROM users WHERE id/.test(sql)) return { rows: [{ is_admin: false }] };
    if (/SELECT id FROM users WHERE username = \$1/.test(sql)) {
      return { rows: params[0] === 'usernode-capture' ? [{ id: CAPTURE_ID }] : [] };
    }
    if (/UPDATE chat_sessions cs SET last_activity_at = now\(\)/.test(sql)) return { rows: [] };
    throw new Error(`frame-door stub: unexpected query: ${sql}`);
  },
};

const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool },
};
for (const mod of ['../src/services/caddy', '../src/services/app-access', '../src/services/app-domains',
  '../src/services/edge-gate', '../src/routes/internal']) {
  delete require.cache[require.resolve(mod)];
}
const appAccess = require('../src/services/app-access');
const edgeGate = require('../src/services/edge-gate');
const { internalRoutes } = require('../src/routes/internal');

let server;
let baseUrl;
test.before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(internalRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  appAccess.invalidateAllVisibility();
  edgeGate._resetCachesForTest();
});

function gate({ host = PRIV_HOST, uri = '/', method = 'GET', cookie, dest, site, ws, usernodeToken } = {}) {
  const headers = {
    Host: host,
    'X-Forwarded-Host': host,
    'X-Forwarded-Method': method,
    'X-Forwarded-Uri': uri,
    ...(cookie ? { Cookie: cookie } : {}),
    ...(dest ? { 'Sec-Fetch-Dest': dest } : {}),
    ...(site ? { 'Sec-Fetch-Site': site } : {}),
    ...(ws ? { 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } : {}),
    ...(usernodeToken ? { 'x-usernode-token': usernodeToken } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/__caddy/access`, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const token = (id = MEMBER_ID, appId = PRIV_APP_ID) => platformJwt.signAppIdentityToken({
  appId, user: { id, username: `u${id}` },
});
const setCookies = (r) => r.headers['set-cookie'] || [];
const accessSet = (r) => setCookies(r).find((v) => v.startsWith('__Host-usernode_access='));
const doorValue = (r) => /^__Host-usernode_access=([^;]+)/.exec(accessSet(r))[1];
const isAuthorize = (loc) => typeof loc === 'string' && loc.startsWith(`${PLATFORM}/__access/authorize?`);
// The frame door page's trade, as its own frame makes it.
const trade = (tok, next = '/?un-build=abc', { host = PRIV_HOST, dest = 'iframe' } = {}) => gate({
  host, dest, site: 'same-origin',
  uri: `/__usernode_access?frame=${encodeURIComponent(tok)}&next=${encodeURIComponent(next)}`,
});

// The page's script, run against a stand-in window: what it posts, where,
// and where it goes when the shell answers.
function runDoorPage(body, { href = `https://${PRIV_HOST}/?un-build=abc#un-token=T1`, framed = true } = {}) {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(body)[1];
  const url = new URL(href);
  const posted = [];
  const listeners = [];
  const timers = [];
  const blocked = { hidden: !/<main id="blocked">/.test(body) };
  const parent = { postMessage: (data, origin) => posted.push({ data, origin }) };
  const location = {
    pathname: url.pathname, search: url.search, hash: url.hash,
    replace(to) { location.replaced = to; },
  };
  const win = {
    parent: framed ? parent : null,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
  };
  if (!framed) win.parent = win;
  const context = {
    window: win, location, setTimeout: (fn) => timers.push(fn),
    document: { getElementById: (id) => (id === 'blocked' ? blocked : null) },
  };
  vm.runInNewContext(script, context);
  return {
    posted, location, blocked, timers,
    deliver: (event) => listeners.forEach((fn) => fn({ source: parent, origin: PLATFORM, ...event })),
  };
}

test('the layout: apps on onhomeroom.app are framed from another site', () => {
  assert.equal(edgeGate.framesCrossSite(PRIV_HOST), true);
  assert.equal(edgeGate.framesCrossSite(PREVIEW_HOST), true);
});

test('a frame’s token opens a partitioned door; a top-level visit keeps the Lax cookie', async () => {
  const tok = token();
  const framed = await gate({ uri: `/?token=${tok}`, dest: 'iframe', site: 'cross-site' });
  assert.equal(framed.status, 302);
  assert.ok(framed.headers.location.endsWith('&__ua=1'), 'bounces once, as before');
  const door = accessSet(framed);
  assert.ok(door, 'sets the door');
  for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned']) {
    assert.ok(door.split('; ').includes(attr), `${attr} in ${door}`);
  }
  assert.doesNotMatch(door, /Domain=/i, 'host-only');
  const claims = platformJwt.verifyEdgeCookie(doorValue(framed));
  assert.equal(claims.uid, MEMBER_ID);
  assert.equal(claims.sid, undefined, 'door-only: no platform session behind it');

  const visit = await gate({ uri: `/?token=${tok}`, dest: 'document', site: 'cross-site' });
  assert.match(accessSet(visit), /SameSite=Lax/);
  assert.doesNotMatch(accessSet(visit), /Partitioned|SameSite=None/);
});

test('the partitioned door lets the frame’s assets, fetches, sockets and navigations through, with no identity', async () => {
  const framed = await gate({ uri: `/?token=${token()}`, dest: 'iframe', site: 'cross-site' });
  const cookie = `__Host-usernode_access=${doorValue(framed)}`;
  for (const req of [
    { uri: '/app.js', dest: 'script', site: 'same-origin' },
    { uri: '/api/items', dest: 'empty', site: 'same-origin' },
    { uri: '/ws', ws: true },
    { uri: '/page2', dest: 'iframe', site: 'same-origin' },
  ]) {
    const r = await gate({ ...req, cookie });
    assert.equal(r.status, 200, req.uri);
    assert.equal(r.headers['x-usernode-identity'], undefined, `${req.uri}: identity stays the app’s own token`);
  }
});

test('a frame with nothing valid gets the frame door page, never the hop', async () => {
  for (const host of [PRIV_HOST, PREVIEW_HOST]) {
    const r = await gate({ host, uri: '/?un-build=abc', dest: 'iframe', site: 'cross-site' });
    assert.equal(r.status, 401, host);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(setCookies(r).length, 0, 'no state cookie: no hop is started');
    assert.equal(r.headers['cache-control'], 'no-store');
    const csp = r.headers['content-security-policy'];
    assert.match(csp, new RegExp(`frame-ancestors ${PLATFORM}$`), 'only the platform may frame it');
    assert.match(csp, /default-src 'none'/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.ok(r.body.includes(`<script nonce="${nonce}">`));
    assert.match(r.body, /<main id="blocked" hidden>/, 'the message waits until the relay fails');
  }
  // Two answers never share a nonce.
  const [a, b] = await Promise.all([1, 2].map(() => gate({ uri: '/', dest: 'iframe' })));
  assert.notEqual(/'nonce-([^']+)'/.exec(a.headers['content-security-policy'])[1],
    /'nonce-([^']+)'/.exec(b.headers['content-security-policy'])[1]);
});

test('the frame door page asks the platform only, and trades the answer keeping the address', async () => {
  const r = await gate({ uri: '/?un-build=abc', dest: 'iframe' });
  const page = runDoorPage(r.body);
  assert.equal(page.posted.length, 1);
  assert.equal(page.posted[0].origin, PLATFORM, 'posted to the platform’s origin only');
  const { nonce } = page.posted[0].data;
  assert.equal(page.posted[0].data.__usernode_frame_door, 'open');
  assert.match(nonce, /^[A-Za-z0-9_-]{16,64}$/);

  // Not the platform, not the parent, not this page's question: ignored.
  page.deliver({ origin: `https://evil.onhomeroom.app`, data: { __usernode_frame_door: 'token', nonce, token: 'x' } });
  page.deliver({ source: {}, data: { __usernode_frame_door: 'token', nonce, token: 'x' } });
  page.deliver({ data: { __usernode_frame_door: 'token', nonce: 'another-nonce-0000', token: 'x' } });
  assert.equal(page.location.replaced, undefined);

  page.deliver({ data: { __usernode_frame_door: 'token', nonce, token: 'T2.a+b' } });
  assert.equal(page.location.replaced,
    `/__usernode_access?frame=T2.a%2Bb&next=${encodeURIComponent('/?un-build=abc')}#un-token=T1`,
    'the fragment rides along: the app gets back its own #un-token');
});

test('the frame door page shows its message when the shell says no, or never answers', async () => {
  const r = await gate({ uri: '/', dest: 'iframe' });
  const refused = runDoorPage(r.body);
  refused.deliver({ data: { __usernode_frame_door: 'token', nonce: refused.posted[0].data.nonce, token: null } });
  assert.equal(refused.blocked.hidden, false);
  assert.equal(refused.location.replaced, undefined);

  const silent = runDoorPage(r.body);
  assert.equal(silent.timers.length, 1);
  silent.timers[0]();
  assert.equal(silent.blocked.hidden, false);

  const unframed = runDoorPage(r.body, { framed: false });
  assert.equal(unframed.posted.length, 0, 'outside a frame it asks nobody');
  assert.equal(unframed.blocked.hidden, false);
});

test('the trade opens the partitioned door for a member’s token, from a frame', async () => {
  const r = await trade(token(), '/notes?id=3');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `/__usernode_access?check=access&next=${encodeURIComponent('/notes?id=3')}`);
  const door = accessSet(r);
  assert.ok(door.split('; ').includes('Partitioned'));
  assert.ok(door.split('; ').includes('SameSite=None'));
  const claims = platformJwt.verifyEdgeCookie(doorValue(r));
  assert.deepEqual([claims.uid, claims.appId, claims.host, claims.sid], [MEMBER_ID, PRIV_APP_ID, PRIV_HOST, undefined]);

  // The check: a door that stuck goes on to the page, one that did not
  // carries the loop marker.
  const cookie = `__Host-usernode_access=${doorValue(r)}`;
  const stuck = await gate({ uri: r.headers.location, dest: 'iframe', cookie });
  assert.equal(stuck.headers.location, '/notes?id=3');
  const lost = await gate({ uri: r.headers.location, dest: 'iframe' });
  assert.equal(lost.headers.location, '/notes?id=3&__ua=1');

  // The screenshot fixture, on a preview only.
  assert.ok(accessSet(await trade(token(CAPTURE_ID), '/', { host: PREVIEW_HOST })));
  assert.equal(accessSet(await trade(token(CAPTURE_ID), '/')), undefined);
});

test('the trade refuses anything but a member’s token for this app, from a frame, onto the loop marker', async () => {
  const refused = [
    ['an outsider', await trade(token(OUTSIDER_ID))],
    ['another app’s token', await trade(token(MEMBER_ID, PRIV_APP_ID + 1))],
    ['garbage', await trade('not-a-token')],
    ['an edge cookie, not a token', await trade(platformJwt.signEdgeCookie({ uid: MEMBER_ID, appId: PRIV_APP_ID, host: PRIV_HOST }))],
  ];
  for (const [why, r] of refused) {
    assert.equal(r.status, 302, why);
    assert.equal(r.headers.location, '/?un-build=abc&__ua=1', why);
    assert.equal(accessSet(r), undefined, why);
  }
  const visit = await trade(token(), '/x', { dest: 'document' });
  assert.equal(visit.headers.location, '/x', 'a top-level visit is the hop’s, not the frame door’s');
  assert.equal(accessSet(visit), undefined);
  const pub = await trade(token(MEMBER_ID, PUB_APP_ID), '/x', { host: PUB_HOST });
  assert.equal(pub.headers.location, '/x', 'a public app needs no door');
  assert.equal(accessSet(pub), undefined);
  const away = await trade(token(), '//evil.example/x');
  assert.equal(away.headers.location, `/__usernode_access?check=access&next=${encodeURIComponent('/')}`, 'next never leaves the host');
});

test('a browser that keeps no cookie in the frame is told so, with the app offered in its own tab', async () => {
  // The bounce after a frame's token came back without the door.
  const tok = token();
  const bounced = await gate({ uri: `/notes?token=${tok}&un-theme=dark&__ua=1`, dest: 'iframe', site: 'same-origin' });
  assert.equal(bounced.status, 401);
  assert.match(bounced.body, /<main id="blocked">/);
  assert.ok(bounced.body.includes('href="/notes?un-theme=dark" target="_blank" rel="noopener"'),
    'the link opens the page asked for, without the token or the marker');
  assert.ok(!bounced.body.includes(tok), 'the token never lands in the page');
  const page = runDoorPage(bounced.body);
  assert.equal(page.posted.length, 0, 'it does not go round again');

  // The same after the frame door's own trade failed to stick.
  const again = await gate({ uri: '/?un-build=abc&__ua=1', dest: 'iframe' });
  assert.equal(again.status, 401);
  assert.match(again.body, /<main id="blocked">/);

  // With the door it is the app, as before.
  const framed = await gate({ uri: `/?token=${tok}`, dest: 'iframe', site: 'cross-site' });
  const ok = await gate({ uri: `/?token=${tok}&__ua=1`, dest: 'iframe', cookie: `__Host-usernode_access=${doorValue(framed)}` });
  assert.equal(ok.status, 200);
});

test('nothing else changes: visits still hop, assets and fetches still go to the apex, public apps still pass', async () => {
  const visit = await gate({ uri: '/notes', dest: 'document', site: 'none' });
  assert.equal(visit.status, 302);
  assert.ok(isAuthorize(visit.headers.location), 'a top-level visit signs in by the hop');
  const asset = await gate({ uri: '/app.js', dest: 'script', site: 'same-origin' });
  assert.equal(asset.status, 302, 'an asset with no door is no page to answer with');
  assert.ok(isAuthorize(asset.headers.location));
  const pub = await gate({ host: PUB_HOST, uri: '/', dest: 'iframe', site: 'cross-site' });
  assert.equal(pub.status, 200, 'a public app in the frame is open, as before');
  const header = await gate({ uri: '/api/items', usernodeToken: token(), dest: 'empty', site: 'same-origin' });
  assert.equal(header.status, 200, 'the token the app forwards still opens every request');
});
