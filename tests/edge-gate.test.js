// The app-host gate (src/services/edge-gate.js), driven the way both edges
// drive it: GET /__caddy/access with the original request's headers plus
// X-Forwarded-Host/-Method/-Uri (Caddy's forward_auth, and the Kubernetes
// gate proxy in scripts/app-gate.js), and the apex GET /__access/authorize.
//
// What it pins:
//   * private apps open only to a member with view access (or an admin);
//   * signing in at an app's own address (#3657): a single-use, one-minute
//     code bound to the host, the app, the user and the platform session,
//     traded for an HttpOnly, host-only, SameSite=Lax cookie; replayed,
//     expired, wrong-host, wrong-app, non-viewer and signed-out codes are
//     refused; `next` can never leave the host;
//   * identity reaches the app only on requests the app's own page made or
//     a person made by navigating, never on a sibling app's requests, and
//     never on a preview;
//   * the key separation the edge tokens rely on.
//
// The pool is stubbed via require.cache, the tests/kudos.test.js pattern.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const LEGACY_SECRET = 'edge-gate-test-legacy-shared-secret';
const EDGE_SECRET = 'edge-gate-test-edge-secret';
process.env.EDGE_JWT_SECRET = EDGE_SECRET;
delete process.env.APP_HOST_SIGNIN;
const keys = require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');
// USERNODE_DOMAIN env is unset in tests → services/caddy.js default.
const DOMAIN = 'social-vibecoding.usernodelabs.org';
const PUB_HOST = `pubapp.${DOMAIN}`;
const PRIV_HOST = `privapp.${DOMAIN}`;
const PUB_APP_ID = 1;
const PRIV_APP_ID = 7;
const MEMBER_ID = 10;
const OUTSIDER_ID = 99;
const ADMIN_ID = 50;
const CAPTURE_ID = 77;
const SESSION_TOKEN = 'a'.repeat(64);
const SID = crypto.createHash('sha256').update(SESSION_TOKEN).digest('hex');
const OTHER_SID = crypto.createHash('sha256').update('b'.repeat(64)).digest('hex');

// ── pool stub ──────────────────────────────────────────────────────────
const state = {
  liveSessions: new Set(),     // `${sid}:${uid}`
  redeemed: new Set(),
  blocked: new Set(),          // `${uid}:${appId}`
  customHostQueries: [],
};
function resetState() {
  state.liveSessions = new Set([`${SID}:${MEMBER_ID}`, `${SID}:${OUTSIDER_ID}`]);
  state.redeemed = new Set();
  state.blocked = new Set();
  state.customHostQueries = [];
}
resetState();
// Custom domains (#4405): the public app at app.example.com, the private one
// at members.example.org, and a claim still waiting for DNS.
const CUSTOM_PUB_HOST = 'app.example.com';
const CUSTOM_PRIV_HOST = 'members.example.org';
const CUSTOM_PENDING_HOST = 'soon.example.net';

const APPS = {
  pubapp: { id: PUB_APP_ID, slug: 'pubapp', view_visibility: 'public', collab_visibility: 'public', runtime_name: 'sv-app-1-pubapp' },
  privapp: { id: PRIV_APP_ID, slug: 'privapp', view_visibility: 'private', collab_visibility: 'private', runtime_name: null },
};
const byId = (id) => Object.values(APPS).find((a) => a.id === Number(id));
const CUSTOM_HOSTS = {
  [CUSTOM_PUB_HOST]: { status: 'live', app: APPS.pubapp },
  [CUSTOM_PRIV_HOST]: { status: 'live', app: APPS.privapp },
  [CUSTOM_PENDING_HOST]: { status: 'pending', app: APPS.pubapp },
};

const fakePool = {
  async query(sql, params = []) {
    if (/FROM user_app_blocks WHERE user_id = \$1 AND app_id = \$2/.test(sql)) {
      return { rows: state.blocked.has(`${params[0]}:${params[1]}`) ? [{ app_id: params[1] }] : [] };
    }
    if (/FROM user_app_blocks/.test(sql)) {
      return { rows: [...state.blocked].filter((k) => k.endsWith(`:${params[0]}`)).map((k) => ({ user_id: Number(k.split(':')[0]) })) };
    }
    if (/SELECT id, view_visibility, moderation_suspended_at FROM apps WHERE slug/.test(sql)) {
      const app = APPS[params[0]];
      return { rows: app ? [{ id: app.id, view_visibility: app.view_visibility }] : [] };
    }
    if (/SELECT view_visibility, moderation_suspended_at FROM apps WHERE id/.test(sql)) {
      const app = byId(params[0]);
      return { rows: app ? [{ view_visibility: app.view_visibility }] : [] };
    }
    if (/FROM apps WHERE slug = \$1/.test(sql)) {
      const app = APPS[params[0]];
      return { rows: app ? [{ ...app, created_by: 1, self_hosted: false, moderation_suspended_at: null }] : [] };
    }
    if (/SELECT runtime_name FROM apps WHERE id/.test(sql)) {
      const app = byId(params[0]);
      return { rows: app ? [{ runtime_name: app.runtime_name }] : [] };
    }
    if (/SELECT staging_runtime_name FROM chat_sessions WHERE id = \$1 AND app_id = \$2/.test(sql)) {
      if (params[0] === 42) return { rows: [{ staging_runtime_name: 'sv-preview-7-s42' }] };
      if (params[0] === 43) return { rows: [{ staging_runtime_name: null }] };
      return { rows: [] };
    }
    if (/FROM app_collaborators WHERE app_id = \$1 AND status = 'member'/.test(sql)) {
      return { rows: params[0] === PRIV_APP_ID ? [{ user_id: MEMBER_ID }] : [] };
    }
    if (/FROM app_collaborators WHERE app_id = \$1 AND user_id = \$2/.test(sql)) {
      return { rows: params[0] === PRIV_APP_ID && params[1] === MEMBER_ID ? [{ '?column?': 1 }] : [] };
    }
    if (/SELECT is_admin FROM users WHERE id/.test(sql)) {
      return { rows: [{ is_admin: params[0] === ADMIN_ID }] };
    }
    if (/FROM sessions\s+WHERE encode\(sha256\(token::bytea\), 'hex'\) = \$1/.test(sql)) {
      return { rows: state.liveSessions.has(`${params[0]}:${params[1]}`) ? [{ '?column?': 1 }] : [] };
    }
    if (/INSERT INTO edge_grant_redemptions/.test(sql)) {
      if (state.redeemed.has(params[0])) return { rows: [] };
      state.redeemed.add(params[0]);
      return { rows: [{ jti: params[0] }] };
    }
    // (The provisional-handle column: services/edge-gate.js mintIdentity.)
    if (/SELECT id, username, usernode_pubkey, locale, is_synthetic,\s+username_provisional_since IS NOT NULL AS provisional\s+FROM users WHERE id/.test(sql)) {
      return { rows: [{ id: params[0], username: `u${params[0]}`, usernode_pubkey: null, locale: 'en', is_synthetic: false }] };
    }
    if (/SELECT id FROM users WHERE username = \$1/.test(sql)) {
      return { rows: params[0] === 'usernode-capture' ? [{ id: CAPTURE_ID }] : [] };
    }
    // A custom domain (#4405, services/app-domains.js): only a LIVE one.
    if (/FROM app_domains d JOIN apps a/.test(sql)) {
      state.customHostQueries.push(params[0]);
      const found = CUSTOM_HOSTS[params[0]];
      return { rows: found && found.status === 'live' ? [{ app_id: found.app.id, slug: found.app.slug, name: found.app.slug }] : [] };
    }
    throw new Error(`edge-gate stub: unexpected query: ${sql}`);
  },
};

const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool },
};
delete require.cache[require.resolve('../src/services/app-access')];
delete require.cache[require.resolve('../src/services/app-domains')];
delete require.cache[require.resolve('../src/services/edge-gate')];
delete require.cache[require.resolve('../src/routes/internal')];

const appAccess = require('../src/services/app-access');
const edgeGate = require('../src/services/edge-gate');
const { internalRoutes } = require('../src/routes/internal');

// ── tiny http harness ──────────────────────────────────────────────────
let server;
let baseUrl;
let apexUser = null;

test.before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(internalRoutes({}));
  // The apex hop as routes/apps.js mounts it, with req.user as the auth
  // middleware would leave it.
  app.get('/__access/authorize', (req, res, next) => { req.user = apexUser || undefined; next(); },
    (req, res) => edgeGate.handleAuthorize(fakePool, req, res));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test.beforeEach(() => {
  resetState();
  appAccess.invalidateAllVisibility();
  edgeGate._resetCachesForTest();
  delete process.env.APP_HOST_SIGNIN;
  apexUser = null;
});

function request(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// What an edge sends: GET /__caddy/access with the original request's
// headers plus the X-Forwarded-* trio.
function gate({ host, uri = '/', method = 'GET', cookie, usernodeToken, dest, site, origin, ws, extra } = {}) {
  return request('/__caddy/access', {
    Host: host,
    'X-Forwarded-Host': host,
    'X-Forwarded-Method': method,
    'X-Forwarded-Uri': uri,
    ...(cookie ? { Cookie: cookie } : {}),
    ...(usernodeToken ? { 'x-usernode-token': usernodeToken } : {}),
    ...(dest ? { 'Sec-Fetch-Dest': dest } : {}),
    ...(site ? { 'Sec-Fetch-Site': site } : {}),
    ...(origin ? { Origin: origin } : {}),
    ...(ws ? { 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } : {}),
    ...(extra || {}),
  });
}

function authorize(query, { sessionCookie = SESSION_TOKEN } = {}) {
  return request(`/__access/authorize?${new URLSearchParams(query)}`,
    sessionCookie ? { Cookie: `session=${sessionCookie}` } : {});
}

const iframeToken = (id, appId = PRIV_APP_ID, username = `u${id}`) => platformJwt.signAppIdentityToken({
  appId, user: { id, username },
});

function edgeToken(pur, claims, opts = {}) {
  return jwt.sign({ ...claims, pur }, opts.secret || EDGE_SECRET, {
    algorithm: 'HS256',
    issuer: opts.issuer || 'usernode',
    audience: opts.audience || 'usernode:edge',
    expiresIn: opts.expiresIn || '1h',
    ...(opts.jwtid !== null ? { jwtid: opts.jwtid || crypto.randomBytes(16).toString('hex') } : {}),
  });
}
const accessCookie = (uid, host, appId, { sid = SID, ...opts } = {}) =>
  `__usernode_access=${edgeToken('edge:cookie', { uid, appId, host, ...(sid ? { sid } : {}) }, opts)}`;
const doorCookie = (uid, host, appId) => accessCookie(uid, host, appId, { sid: null });
const code = (uid, host, appId, { sid = SID, expiresIn = '1m', ...opts } = {}) =>
  edgeToken('edge:grant', { uid, appId, host, ...(sid ? { sid } : {}) }, { expiresIn, ...opts });
const callback = (host, c, next = '/deep/link') =>
  gate({ host, uri: `/__usernode_access?code=${encodeURIComponent(c)}&next=${encodeURIComponent(next)}` });

const setCookies = (r) => (r.headers['set-cookie'] || []);
const identityOf = (r) => r.headers['x-usernode-identity'];
// A guest token for the public app (P15): who a visitor with no person is.
const guestOf = (r) => identityOf(r)
  && platformJwt.orNull(() => platformJwt.verifyGuestToken(identityOf(r), { appId: PUB_APP_ID }));
const isAuthorize = (loc) => typeof loc === 'string' && loc.startsWith(`https://${DOMAIN}/__access/authorize?`);
const chromeless = (slug) => `https://${DOMAIN}/#app/${slug}/full`;

// ── Basics ─────────────────────────────────────────────────────────────

test('a view-public app passes with no credentials, as a guest (P15)', async () => {
  const r = await gate({ host: PUB_HOST });
  assert.equal(r.status, 200);
  assert.ok(guestOf(r), 'a guest, never a person (tests/app-host-guests.test.js)');
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('a preview inherits the production app’s visibility', async () => {
  assert.equal((await gate({ host: `pubapp--s42.${DOMAIN}` })).status, 200);
  const priv = await gate({ host: `privapp--s42.${DOMAIN}` });
  assert.equal(priv.status, 302);
  assert.ok(isAuthorize(priv.headers.location));
});

test('an unknown slug or a foreign host is 404', async () => {
  assert.equal((await gate({ host: `nosuchapp.${DOMAIN}` })).status, 404);
  assert.equal((await gate({ host: 'evil.example.com' })).status, 404);
});

// ── Signing in at a public app's own address ──────────────────────────

test('a top-level visit with no app-host cookie asks the apex once', async () => {
  const r = await gate({ host: PUB_HOST, uri: '/scores?week=2', dest: 'document', site: 'cross-site' });
  assert.equal(r.status, 302);
  assert.ok(isAuthorize(r.headers.location), r.headers.location);
  const loc = new URL(r.headers.location);
  assert.equal(loc.searchParams.get('host'), PUB_HOST);
  assert.equal(loc.searchParams.get('next'), '/scores?week=2');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
});

test('no hop for a fetch, a frame, an asset, a preview, a marked or a token-carrying request', async () => {
  for (const dest of ['empty', 'iframe', 'script', 'image']) {
    assert.equal((await gate({ host: PUB_HOST, dest })).status, 200, dest);
  }
  assert.equal((await gate({ host: `pubapp--s42.${DOMAIN}`, dest: 'document' })).status, 200, 'preview');
  assert.equal((await gate({ host: PUB_HOST, dest: 'document', cookie: '__usernode_anon=1' })).status, 200, 'anon marker');
  assert.equal((await gate({ host: PUB_HOST, uri: '/?__ua=1', dest: 'document' })).status, 200, 'loop marker');
  assert.equal((await gate({ host: PUB_HOST, uri: '/?token=x', dest: 'document' })).status, 200, 'iframe token');
  assert.equal((await gate({ host: PUB_HOST, dest: 'document', usernodeToken: 'x' })).status, 200, 'header token');
});

test('a live app-host cookie hands the app an identity token for THIS app', async () => {
  const r = await gate({
    host: PUB_HOST, cookie: accessCookie(MEMBER_ID, PUB_HOST, PUB_APP_ID), dest: 'empty', site: 'same-origin',
  });
  assert.equal(r.status, 200);
  const claims = platformJwt.verifyAppIdentityToken(identityOf(r), { appId: PUB_APP_ID });
  assert.equal(claims.id, MEMBER_ID);
  assert.equal(claims.username, `u${MEMBER_ID}`);
  assert.equal(claims.pur, 'iframe');
  assert.throws(() => platformJwt.verifyAppIdentityToken(identityOf(r), { appId: PRIV_APP_ID }),
    'audience-bound to the app being gated');
});

test('identity rides top-level visits, same-origin and user-initiated requests only', async () => {
  const cookie = accessCookie(MEMBER_ID, PUB_HOST, PUB_APP_ID);
  const self = `https://${PUB_HOST}`;
  const sibling = `https://evil.${DOMAIN}`;
  const cases = [
    [{ dest: 'document', site: 'cross-site' }, true, 'a link from anywhere opens it signed in'],
    [{ dest: 'document', site: 'none' }, true, 'a typed address'],
    [{ dest: 'empty', site: 'same-origin' }, true, 'the app’s own fetch'],
    [{ dest: 'empty', site: 'same-site', origin: sibling }, false, 'a sibling app’s fetch'],
    [{ dest: 'image', site: 'same-site' }, false, 'a sibling app’s <img>'],
    [{ dest: 'iframe', site: 'cross-site' }, false, 'framed by another site'],
    [{ dest: 'empty', site: 'cross-site', origin: 'https://evil.example' }, false, 'a cross-site fetch'],
    [{ method: 'POST', site: 'same-origin', origin: self }, true, 'a write from the app’s page'],
    [{ method: 'POST', site: 'same-site', origin: sibling }, false, 'a write from a sibling app'],
    [{ method: 'POST', origin: 'https://evil.example' }, false, 'a cross-site write'],
    [{ method: 'POST' }, false, 'a write with no Origin'],
    [{ ws: true, origin: self }, true, 'a WebSocket from the app’s page'],
    [{ ws: true, origin: sibling }, false, 'a WebSocket from a sibling app'],
    [{ ws: true }, false, 'a WebSocket with no Origin'],
  ];
  for (const [opts, expected, label] of cases) {
    const r = await gate({ host: PUB_HOST, cookie, ...opts });
    assert.equal(r.status, 200, label);
    assert.equal(!!identityOf(r), expected, label);
  }
});

test('signing out of Homeroom signs out of the app host', async () => {
  state.liveSessions.clear();
  const fetchR = await gate({ host: PUB_HOST, cookie: accessCookie(MEMBER_ID, PUB_HOST, PUB_APP_ID), site: 'same-origin' });
  assert.equal(fetchR.status, 200);
  assert.ok(guestOf(fetchR), 'no person once the session is gone: a guest (P15)');
  const nav = await gate({ host: PUB_HOST, cookie: accessCookie(MEMBER_ID, PUB_HOST, PUB_APP_ID), dest: 'document' });
  assert.ok(isAuthorize(nav.headers.location), 'and a visit asks again');
});

test('a cookie for another host, another app, or blocked by the person opens nothing', async () => {
  for (const cookie of [
    accessCookie(MEMBER_ID, `other.${DOMAIN}`, PUB_APP_ID),
    accessCookie(MEMBER_ID, PUB_HOST, PRIV_APP_ID),
  ]) {
    const r = await gate({ host: PUB_HOST, cookie, site: 'same-origin' });
    assert.ok(guestOf(r), 'no person: a guest (P15)');
  }
  state.blocked.add(`${MEMBER_ID}:${PUB_APP_ID}`);
  const blocked = await gate({ host: PUB_HOST, cookie: accessCookie(MEMBER_ID, PUB_HOST, PUB_APP_ID), site: 'same-origin' });
  assert.ok(guestOf(blocked), 'no person: a guest (P15)');
});

test('a request carrying its own token keeps it: no identity is added over it', async () => {
  const r = await gate({
    host: PUB_HOST, cookie: accessCookie(MEMBER_ID, PUB_HOST, PUB_APP_ID), site: 'same-origin',
    usernodeToken: iframeToken(OUTSIDER_ID, PUB_APP_ID),
  });
  assert.equal(r.status, 200);
  assert.equal(identityOf(r), undefined);
});

test('a preview never gets identity from the cookie', async () => {
  const host = `pubapp--s42.${DOMAIN}`;
  const r = await gate({ host, cookie: accessCookie(MEMBER_ID, host, PUB_APP_ID), site: 'same-origin' });
  assert.equal(r.status, 200);
  assert.equal(identityOf(r), undefined);
});

test('APP_HOST_SIGNIN=off: no hop, no identity, the chromeless view as before', async () => {
  process.env.APP_HOST_SIGNIN = 'off';
  assert.equal((await gate({ host: PUB_HOST, dest: 'document' })).status, 200);
  const withCookie = await gate({ host: PUB_HOST, cookie: accessCookie(MEMBER_ID, PUB_HOST, PUB_APP_ID), site: 'same-origin' });
  assert.equal(identityOf(withCookie), undefined);
  const priv = await gate({ host: PRIV_HOST, dest: 'document' });
  assert.equal(priv.headers.location, chromeless('privapp'));
});

// ── The callback: single-use, short-lived, host-bound codes ───────────

test('a valid code works once: cookie set, code gone from the address', async () => {
  const c = code(MEMBER_ID, PRIV_HOST, PRIV_APP_ID);
  const r = await callback(PRIV_HOST, c, '/deep/link?x=1');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `/__usernode_access?check=access&next=${encodeURIComponent('/deep/link?x=1')}`,
    'then a same-host check that the cookie stuck');
  const set = setCookies(r).find((v) => v.startsWith('__usernode_access='));
  assert.ok(set, 'sets the app-host cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Path=\//);
  assert.doesNotMatch(set, /Domain=/i, 'host-only');
  const minted = /__usernode_access=([^;]+)/.exec(set)[1];
  const claims = jwt.verify(minted, EDGE_SECRET, { algorithms: ['HS256'], issuer: 'usernode', audience: 'usernode:edge' });
  assert.equal(claims.pur, 'edge:cookie');
  assert.deepEqual([claims.uid, claims.appId, claims.host, claims.sid], [MEMBER_ID, PRIV_APP_ID, PRIV_HOST, SID]);
  assert.equal(claims.exp - claims.iat, 12 * 60 * 60);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');

  // The same code again: refused, no cookie, never another hop.
  const replay = await callback(PRIV_HOST, c, '/deep/link?x=1');
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.location, `${chromeless('privapp')}?path=/deep/link?x=1`);
  assert.equal(setCookies(replay).length, 0);
});

test('the check step: on to the page if the cookie stuck, on with the loop marker if not', async () => {
  const next = encodeURIComponent('/deep/link?x=1');
  const stuck = await gate({ host: PRIV_HOST, uri: `/__usernode_access?check=access&next=${next}`,
    cookie: accessCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID) });
  assert.equal(stuck.headers.location, '/deep/link?x=1');
  const refused = await gate({ host: PRIV_HOST, uri: `/__usernode_access?check=access&next=${next}` });
  assert.equal(refused.headers.location, '/deep/link?x=1&__ua=1');
  // And a marked visit never goes round the hop again.
  const marked = await gate({ host: PRIV_HOST, uri: '/deep/link?x=1&__ua=1', dest: 'document' });
  assert.equal(marked.headers.location, chromeless('privapp'));
  const anonStuck = await gate({ host: PUB_HOST, uri: '/__usernode_access?check=anon&next=%2F', cookie: '__usernode_anon=1' });
  assert.equal(anonStuck.headers.location, '/');
  const anonRefused = await gate({ host: PUB_HOST, uri: '/__usernode_access?check=anon&next=%2F' });
  assert.equal(anonRefused.headers.location, '/?__ua=1');
});

test('expired, wrong-host, wrong-app, session-less or jti-less codes are refused', async () => {
  const refused = [
    ['expired', code(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, { expiresIn: -10 })],
    ['another host', code(MEMBER_ID, `other.${DOMAIN}`, PRIV_APP_ID)],
    ['another app', code(MEMBER_ID, PRIV_HOST, PUB_APP_ID)],
    ['no session', code(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, { sid: null })],
    ['no jti', code(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, { jwtid: null })],
    ['retired secret', code(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, { secret: LEGACY_SECRET })],
    ['a cookie posing as a code', edgeToken('edge:cookie', { uid: MEMBER_ID, appId: PRIV_APP_ID, host: PRIV_HOST, sid: SID })],
  ];
  for (const [label, c] of refused) {
    const r = await callback(PRIV_HOST, c);
    assert.equal(r.status, 302, label);
    assert.ok(!isAuthorize(r.headers.location), `${label}: never loops back into the hop`);
    assert.equal(setCookies(r).length, 0, `${label}: no cookie`);
  }
});

test('a non-viewer’s code is refused, and does not spend anything', async () => {
  const c = code(OUTSIDER_ID, PRIV_HOST, PRIV_APP_ID);
  const r = await callback(PRIV_HOST, c);
  assert.equal(setCookies(r).length, 0);
  assert.equal(state.redeemed.size, 0, 'the jti is only recorded for a code that passed everything else');
});

test('a code whose platform session ended is refused', async () => {
  const c = code(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, { sid: OTHER_SID });
  assert.equal(setCookies(await callback(PRIV_HOST, c)).length, 0);
});

test('next never leaves the host', async () => {
  for (const next of ['//evil.com/x', 'https://evil.com', '/\\evil.com', 'evil', '/a\r\nSet-Cookie: x=1',
    '/__usernode_access?code=x']) {
    const r = await callback(PRIV_HOST, code(MEMBER_ID, PRIV_HOST, PRIV_APP_ID), next);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/__usernode_access?check=access&next=%2F', JSON.stringify(next));
  }
  assert.equal(edgeGate.safeNext('/ok#frag'), '/ok');
  assert.equal(edgeGate.safeNext(`/${'a'.repeat(3000)}`), '/');
});

test('a preview’s refused code goes to the platform, never back into the hop', async () => {
  const host = `privapp--s42.${DOMAIN}`;
  const r = await callback(host, code(MEMBER_ID, host, PRIV_APP_ID, { expiresIn: -10 }));
  assert.equal(r.headers.location, `https://${DOMAIN}/`);
});

test('the anonymous answer sets a short marker; a forged one only stops the loop', async () => {
  const anon = platformJwt.signEdgeAnon({ host: PUB_HOST });
  const ok = await gate({ host: PUB_HOST, uri: `/__usernode_access?anon=${encodeURIComponent(anon)}&next=%2Fplay` });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, '/__usernode_access?check=anon&next=%2Fplay');
  const marker = setCookies(ok).find((v) => v.startsWith('__usernode_anon=1'));
  assert.ok(marker);
  assert.match(marker, /Max-Age=600/);
  assert.match(marker, /HttpOnly/);

  for (const bad of [
    platformJwt.signEdgeAnon({ host: `other.${DOMAIN}` }),
    edgeToken('edge:grant', { host: PUB_HOST }),
    'garbage',
  ]) {
    const r = await gate({ host: PUB_HOST, uri: `/__usernode_access?anon=${encodeURIComponent(bad)}&next=%2Fplay` });
    assert.equal(r.headers.location, '/play?__ua=1');
    assert.equal(setCookies(r).length, 0);
  }
  // Never on a private app.
  const priv = await gate({
    host: PRIV_HOST,
    uri: `/__usernode_access?anon=${encodeURIComponent(platformJwt.signEdgeAnon({ host: PRIV_HOST }))}&next=%2F`,
  });
  assert.equal(setCookies(priv).length, 0);
});

// ── Private apps: members with view access only ───────────────────────

test('private, nothing presented: a visit asks the apex; a fetch too; a write is 404', async () => {
  const nav = await gate({ host: PRIV_HOST, uri: '/some/page', dest: 'document' });
  assert.ok(isAuthorize(nav.headers.location));
  assert.equal(new URL(nav.headers.location).searchParams.get('next'), '/some/page');
  for (const dest of ['iframe', 'script', 'empty']) {
    assert.ok(isAuthorize((await gate({ host: PRIV_HOST, dest })).headers.location), dest);
  }
  assert.equal((await gate({ host: PRIV_HOST, method: 'POST', dest: 'document' })).status, 404);
});

test('private: the shell’s iframe token still sets the door cookie and bounces once', async () => {
  const tok = iframeToken(MEMBER_ID);
  const r = await gate({ host: PRIV_HOST, uri: `/?token=${tok}` });
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.includes('__ua=1'));
  assert.ok(setCookies(r).some((v) => v.startsWith('__usernode_access=')));
  assert.equal((await gate({ host: PRIV_HOST, uri: `/?token=${tok}&__ua=1` })).status, 200);
  assert.equal((await gate({ host: PRIV_HOST, method: 'POST', usernodeToken: tok })).status, 200);
  assert.equal((await gate({ host: PRIV_HOST, uri: `/?token=${tok}`, ws: true })).status, 200, 'a WebSocket cannot follow a redirect');
});

test('private: outsiders, other apps’ tokens, forged and worker tokens are refused', async () => {
  const refused = [
    iframeToken(OUTSIDER_ID),
    iframeToken(MEMBER_ID, PRIV_APP_ID + 1),
    jwt.sign({ id: MEMBER_ID, pur: 'iframe' }, 'wrong-secret', { expiresIn: '1h' }),
    jwt.sign({ id: MEMBER_ID, pur: 'iframe' }, keys.IFRAME_JWT_PUBLIC_KEY,
      { algorithm: 'HS256', issuer: 'usernode', audience: `usernode:app:${PRIV_APP_ID}`, expiresIn: '1h' }),
    platformJwt.signWorkerToken({ sessionId: 3 }),
  ];
  for (const tok of refused) {
    const r = await gate({ host: PRIV_HOST, uri: `/?token=${encodeURIComponent(tok)}` });
    assert.equal(r.status, 302);
    assert.ok(isAuthorize(r.headers.location));
  }
  const admin = await gate({ host: PRIV_HOST, uri: `/?token=${iframeToken(ADMIN_ID)}&__ua=1` });
  assert.equal(admin.status, 200, 'an admin passes');
});

test('private: the screenshot fixture passes on a preview only', async () => {
  const preview = `privapp--s42.${DOMAIN}`;
  const tok = iframeToken(CAPTURE_ID, PRIV_APP_ID, 'usernode-capture');
  assert.equal((await gate({ host: preview, usernodeToken: tok })).status, 200);
  assert.equal((await gate({ host: PRIV_HOST, usernodeToken: tok })).status, 302, 'never on production');
});

test('private: a member’s live cookie signs them in; the door-only cookie upgrades on a visit', async () => {
  const live = await gate({ host: PRIV_HOST, cookie: accessCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID), site: 'same-origin' });
  assert.equal(live.status, 200);
  assert.equal(platformJwt.verifyAppIdentityToken(identityOf(live), { appId: PRIV_APP_ID }).id, MEMBER_ID);

  const door = doorCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID);
  const asset = await gate({ host: PRIV_HOST, cookie: door, dest: 'script' });
  assert.equal(asset.status, 200, 'the door still opens');
  assert.equal(identityOf(asset), undefined, 'but carries no identity');
  const visit = await gate({ host: PRIV_HOST, cookie: door, dest: 'document' });
  assert.ok(isAuthorize(visit.headers.location), 'a visit asks the apex for a signed-in cookie');
  assert.equal((await gate({ host: PRIV_HOST, uri: '/?__ua=1', cookie: door, dest: 'document' })).status, 200);
});

test('private: a cookie whose session ended, or an outsider’s, opens nothing', async () => {
  state.liveSessions.clear();
  const ended = await gate({ host: PRIV_HOST, cookie: accessCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID) });
  assert.ok(isAuthorize(ended.headers.location));
  const endedWrite = await gate({ host: PRIV_HOST, method: 'POST', cookie: accessCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID) });
  assert.equal(endedWrite.status, 404);
  resetState();
  const outsider = await gate({ host: PRIV_HOST, cookie: accessCookie(OUTSIDER_ID, PRIV_HOST, PRIV_APP_ID) });
  assert.ok(isAuthorize(outsider.headers.location));
});

test('private: a write that carries only the cookie must come from the app’s own page', async () => {
  const cookie = accessCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID);
  const foreign = await gate({ host: PRIV_HOST, method: 'POST', cookie, origin: `https://evil.${DOMAIN}`, site: 'same-site' });
  assert.equal(foreign.status, 403);
  const none = await gate({ host: PRIV_HOST, method: 'DELETE', cookie });
  assert.equal(none.status, 403, 'no Origin at all');
  const own = await gate({ host: PRIV_HOST, method: 'POST', cookie, origin: `https://${PRIV_HOST}`, site: 'same-origin' });
  assert.equal(own.status, 200);
  assert.ok(identityOf(own));
});

test('edge tokens with the wrong secret, audience or issuer open nothing', async () => {
  for (const opts of [{ secret: LEGACY_SECRET }, { audience: 'usernode:worker' }, { issuer: 'somebody-else' }]) {
    const r = await gate({ host: PRIV_HOST, cookie: accessCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, opts) });
    assert.ok(isAuthorize(r.headers.location), JSON.stringify(opts));
  }
  // A code presented as the cookie.
  const r = await gate({ host: PRIV_HOST, cookie: `__usernode_access=${code(MEMBER_ID, PRIV_HOST, PRIV_APP_ID)}` });
  assert.ok(isAuthorize(r.headers.location));
});

// ── The Kubernetes gate proxy's extra answers ─────────────────────────

test('asked by the Kubernetes gate, a 2xx names the app’s Service', async () => {
  const k = { 'X-Usernode-Gate': 'kubernetes' };
  const prod = await gate({ host: PUB_HOST, extra: k });
  assert.equal(prod.headers['x-usernode-upstream'], 'sv-app-1-pubapp', 'the stored runtime name');
  assert.equal(prod.headers['x-usernode-applink'], chromeless('pubapp'));
  const derived = await gate({ host: PRIV_HOST, uri: `/?token=${iframeToken(MEMBER_ID)}&__ua=1`, extra: k });
  assert.equal(derived.headers['x-usernode-upstream'], 'sv-app-7-privapp', 'or the name it would have been given');
  const preview = await gate({ host: `pubapp--s42.${DOMAIN}`, extra: k });
  assert.equal(preview.headers['x-usernode-upstream'], 'sv-preview-7-s42');
  assert.equal(preview.headers['x-usernode-applink'], undefined, 'no rescue link for a preview');
  const unknownPreview = await gate({ host: `pubapp--s99.${DOMAIN}`, extra: k });
  assert.equal(unknownPreview.status, 404);
  // Caddy never asks, and never gets one.
  assert.equal((await gate({ host: PUB_HOST })).headers['x-usernode-upstream'], undefined);
});

// ── Custom domains (#4405) ─────────────────────────────────────────────

test('a live custom domain is the app’s production address: the same gate, the same sign-in', async () => {
  require('../src/services/app-domains').resetCachesForTest();
  // A public app: a guest, like at its Homeroom address.
  const guest = await gate({ host: CUSTOM_PUB_HOST });
  assert.equal(guest.status, 200);
  assert.ok(guestOf(guest), 'a guest token for the app the host serves');
  // A top-level visit hops to the apex with THIS host.
  const visit = await gate({ host: CUSTOM_PUB_HOST, uri: '/scores', dest: 'document', site: 'cross-site' });
  assert.equal(visit.status, 302);
  assert.equal(new URL(visit.headers.location).searchParams.get('host'), CUSTOM_PUB_HOST);
  // A cookie bound to the custom host signs the person in there.
  const r = await gate({ host: CUSTOM_PUB_HOST, cookie: accessCookie(MEMBER_ID, CUSTOM_PUB_HOST, PUB_APP_ID), dest: 'document' });
  assert.equal(r.status, 200);
  assert.equal(jwt.decode(identityOf(r)).aud, `usernode:app:${PUB_APP_ID}`);
  // The Homeroom host's cookie opens nothing here, and the other way round.
  const other = await gate({ host: CUSTOM_PUB_HOST, cookie: accessCookie(MEMBER_ID, PUB_HOST, PUB_APP_ID) });
  assert.ok(guestOf(other), 'a guest, not the person the Homeroom host’s cookie names');
  // Never a preview: the production rules apply.
  const k = await gate({ host: CUSTOM_PUB_HOST, extra: { 'X-Usernode-Gate': 'kubernetes' } });
  assert.equal(k.headers['x-usernode-upstream'], 'sv-app-1-pubapp');
  assert.equal(k.headers['x-usernode-applink'], chromeless('pubapp'));
  // Caddy's custom-domain site asks for the container the same way.
  const c = await gate({ host: CUSTOM_PUB_HOST, extra: { 'X-Usernode-Gate': 'caddy' } });
  assert.equal(c.headers['x-usernode-upstream'], 'usernode-app-pubapp');
  assert.equal(c.headers['x-usernode-applink'], chromeless('pubapp'));
  // A private app at its custom domain: members only, as at its Homeroom address.
  const priv = await gate({ host: CUSTOM_PRIV_HOST, dest: 'document' });
  assert.equal(priv.status, 302);
  assert.ok(isAuthorize(priv.headers.location));
  const member = await gate({ host: CUSTOM_PRIV_HOST, cookie: accessCookie(MEMBER_ID, CUSTOM_PRIV_HOST, PRIV_APP_ID), dest: 'document' });
  assert.equal(member.status, 200);
  assert.equal(jwt.decode(identityOf(member)).aud, `usernode:app:${PRIV_APP_ID}`);
  const outsider = await gate({ host: CUSTOM_PRIV_HOST, cookie: accessCookie(OUTSIDER_ID, CUSTOM_PRIV_HOST, PRIV_APP_ID), method: 'POST', origin: `https://${CUSTOM_PRIV_HOST}` });
  assert.equal(outsider.status, 404);
});

test('a pending claim or an unknown host is 404 at the gate and at the apex hop: never an open redirect', async () => {
  require('../src/services/app-domains').resetCachesForTest();
  assert.equal((await gate({ host: CUSTOM_PENDING_HOST, dest: 'document' })).status, 404);
  assert.equal((await gate({ host: 'nobody.example.com', dest: 'document' })).status, 404);
  apexUser = { id: MEMBER_ID, username: `u${MEMBER_ID}` };
  assert.equal((await authorize({ host: CUSTOM_PENDING_HOST, next: '/' })).status, 404);
  assert.equal((await authorize({ host: 'nobody.example.com', next: '/' })).status, 404);
  const ok = await authorize({ host: CUSTOM_PUB_HOST, next: '/scores' });
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.location);
  assert.equal(loc.host, CUSTOM_PUB_HOST, 'back to the custom host, with a code bound to it');
  const code = platformJwt.verifyEdgeGrant(loc.searchParams.get('code'));
  assert.equal(code.host, CUSTOM_PUB_HOST);
  assert.equal(code.appId, PUB_APP_ID);
  // Homeroom hosts never reach the table.
  state.customHostQueries = [];
  await gate({ host: PUB_HOST });
  await gate({ host: `pubapp--s42.${DOMAIN}` });
  assert.deepEqual(state.customHostQueries, []);
});

// ── The apex hop ───────────────────────────────────────────────────────

test('authorize: a signed-in viewer goes back with a code bound to host, app, user and session', async () => {
  apexUser = { id: MEMBER_ID, username: `u${MEMBER_ID}` };
  const r = await authorize({ host: PRIV_HOST, next: '/a?b=1' });
  assert.equal(r.status, 302);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  const loc = new URL(r.headers.location);
  assert.equal(loc.origin, `https://${PRIV_HOST}`);
  assert.equal(loc.pathname, '/__usernode_access');
  assert.equal(loc.searchParams.get('next'), '/a?b=1');
  const claims = platformJwt.verifyEdgeGrant(loc.searchParams.get('code'));
  assert.deepEqual([claims.uid, claims.appId, claims.host, claims.sid], [MEMBER_ID, PRIV_APP_ID, PRIV_HOST, SID]);
  assert.match(claims.jti, /^[0-9a-f]{32}$/);
  assert.equal(claims.exp - claims.iat, 60, 'one minute');

  // And that code is good, once, at the gate.
  const first = await callback(PRIV_HOST, loc.searchParams.get('code'), '/a?b=1');
  assert.equal(first.headers.location, `/__usernode_access?check=access&next=${encodeURIComponent('/a?b=1')}`);
  assert.ok(setCookies(first).length);
});

test('authorize: a signed-in person who may not view a private app gets no code', async () => {
  apexUser = { id: OUTSIDER_ID, username: 'out' };
  const r = await authorize({ host: PRIV_HOST, next: '/' });
  assert.equal(r.headers.location, chromeless('privapp'));
});

test('authorize: no session cookie (a bearer-authenticated caller) gets no code', async () => {
  apexUser = { id: MEMBER_ID, username: `u${MEMBER_ID}` };
  const r = await authorize({ host: PRIV_HOST, next: '/' }, { sessionCookie: null });
  assert.equal(r.headers.location, chromeless('privapp'));
});

test('authorize: signed out keeps today’s behaviour, except a public app answers itself', async () => {
  const priv = await authorize({ host: PRIV_HOST, next: '/x' }, { sessionCookie: null });
  assert.equal(priv.headers.location, `${chromeless('privapp')}?path=/x`);
  const preview = await authorize({ host: `privapp--s42.${DOMAIN}`, next: '/x' }, { sessionCookie: null });
  assert.equal(preview.headers.location, `https://${DOMAIN}/`);
  const pub = await authorize({ host: PUB_HOST, next: '/x' }, { sessionCookie: null });
  const loc = new URL(pub.headers.location);
  assert.equal(loc.origin, `https://${PUB_HOST}`);
  assert.equal(platformJwt.verifyEdgeAnon(loc.searchParams.get('anon')).host, PUB_HOST);
  assert.equal(loc.searchParams.get('code'), null);
});

test('authorize: next is sanitised and unknown hosts are 404', async () => {
  apexUser = { id: MEMBER_ID, username: `u${MEMBER_ID}` };
  const r = await authorize({ host: PRIV_HOST, next: '//evil.com' });
  assert.equal(new URL(r.headers.location).searchParams.get('next'), '/');
  assert.equal((await authorize({ host: 'evil.example.com', next: '/' })).status, 404);
  assert.equal((await authorize({ host: DOMAIN, next: '/' })).status, 404, 'never the platform itself');
});

// ── Pure pieces ────────────────────────────────────────────────────────

test('cookie names carry the __Host- prefix in production', () => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.deepEqual(edgeGate.cookieNames(), {
      access: '__Host-usernode_access', anon: '__Host-usernode_anon', guest: '__Host-usernode_guest',
    });
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
  }
  assert.deepEqual(edgeGate.cookieNames(), { access: '__usernode_access', anon: '__usernode_anon', guest: '__usernode_guest' });
});

test('stripGateCookies removes only the gate’s cookies, in either spelling', () => {
  assert.equal(edgeGate.stripGateCookies('a=1; __Host-usernode_access=x; b=2'), 'a=1; b=2');
  assert.equal(edgeGate.stripGateCookies('__usernode_access=x; __Host-usernode_anon=1'), '');
  assert.equal(edgeGate.stripGateCookies('usernode_access=keep; x__usernode_access=keep'), 'usernode_access=keep; x__usernode_access=keep');
  assert.equal(edgeGate.stripGateCookies(undefined), '');
  // The proxy carries its own copy (it reads no platform module); keep them one.
  assert.equal(require('../scripts/app-gate').stripGateCookies('a=1; __Host-usernode_access=x'), 'a=1');
});

test('the capture fixture name is the one services/visuals.js signs as', () => {
  const visuals = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  assert.match(visuals, new RegExp(`const CAPTURE_USERNAME = '${edgeGate.CAPTURE_USERNAME}';`));
});

test('the sign-in code is one minute and the anon answer too', () => {
  assert.equal(platformJwt.EDGE_GRANT_TTL_S, 60);
  assert.equal(platformJwt.EDGE_ANON_TTL_S, 60);
  assert.equal(edgeGate.ANON_TTL_S, 600);
});

test('the platform’s auth middleware lets the apex hop answer a signed-out visitor itself', async () => {
  delete require.cache[require.resolve('../src/middleware/auth')];
  const { authMiddleware } = require('../src/middleware/auth');
  const mw = authMiddleware({});
  const run = (p) => new Promise((resolve) => {
    const req = { path: p, method: 'GET', query: {}, headers: {}, cookies: {} };
    const res = {
      redirect: (status, loc) => resolve({ redirected: loc || status }),
      status: () => ({ json: () => resolve({ rejected: true }) }),
      setHeader() {},
    };
    mw(req, res, () => resolve({ next: true, user: req.user }));
  });
  assert.deepEqual(await run('/__access/authorize'), { next: true, user: undefined });
  assert.deepEqual(await run('/__access/authorize-something-else'), { redirected: '/' }, 'that path only');
});
