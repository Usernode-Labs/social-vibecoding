// Tests for the Caddy forward_auth edge gate (GET /__caddy/access in
// src/routes/internal.js): direct <slug>.<domain> access to view-private
// apps must require an admin or member credential, while view-public
// apps pass untouched. Pool is stubbed via require.cache, same pattern
// as tests/kudos.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

// Three authorities meet at this gate since the RSA cutover: the iframe
// token (step 5) is RS256 under the app-identity key and scoped to the
// app whose host is being gated; the grant and the scoped cookie are
// HS256 under EDGE_JWT_SECRET. The retired shared secret buys nothing.
const LEGACY_SECRET = 'edge-gate-test-legacy-shared-secret';
const EDGE_SECRET = 'edge-gate-test-edge-secret';
process.env.EDGE_JWT_SECRET = EDGE_SECRET;
const keys = require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');
// USERNODE_DOMAIN env is unset in tests → services/caddy.js default.
const DOMAIN = 'social-vibecoding.usernodelabs.org';
const PUB_HOST = `pubapp.${DOMAIN}`;
const PRIV_HOST = `privapp.${DOMAIN}`;
const PRIV_APP_ID = 7;
const MEMBER_ID = 10;
const OUTSIDER_ID = 99;
const ADMIN_ID = 50;

// ── pool stub ──────────────────────────────────────────────────────────
const fakePool = {
  async query(sql, params = []) {
    if (/SELECT id, view_visibility FROM apps WHERE slug/.test(sql)) {
      if (params[0] === 'pubapp') return { rows: [{ id: 1, view_visibility: 'public' }] };
      if (params[0] === 'privapp') return { rows: [{ id: PRIV_APP_ID, view_visibility: 'private' }] };
      return { rows: [] };
    }
    if (/SELECT view_visibility FROM apps WHERE id/.test(sql)) {
      if (params[0] === PRIV_APP_ID) return { rows: [{ view_visibility: 'private' }] };
      if (params[0] === 1) return { rows: [{ view_visibility: 'public' }] };
      return { rows: [] };
    }
    if (/FROM app_collaborators WHERE app_id = \$1 AND status = 'member'/.test(sql)) {
      return { rows: params[0] === PRIV_APP_ID ? [{ user_id: MEMBER_ID }] : [] };
    }
    if (/SELECT is_admin FROM users WHERE id/.test(sql)) {
      return { rows: [{ is_admin: params[0] === ADMIN_ID }] };
    }
    throw new Error(`edge-gate stub: unexpected query: ${sql}`);
  },
};

const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: { getPool: () => fakePool },
};
delete require.cache[require.resolve('../src/services/app-access')];
delete require.cache[require.resolve('../src/routes/internal')];

const { internalRoutes } = require('../src/routes/internal');

// ── tiny http harness ──────────────────────────────────────────────────
let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(internalRoutes({}));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

// Simulates what Caddy's forward_auth sends: GET /__caddy/access with the
// original request's Host/Cookie/x-usernode-token headers plus the
// X-Forwarded-* pair.
function gate({ host, uri = '/', method = 'GET', cookie, usernodeToken, secFetchDest } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/__caddy/access`, {
      method: 'GET',
      headers: {
        Host: host,
        'X-Forwarded-Host': host,
        'X-Forwarded-Method': method,
        'X-Forwarded-Uri': uri,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(usernodeToken ? { 'x-usernode-token': usernodeToken } : {}),
        // forward_auth copies the original request headers, so a browser
        // navigation's Sec-Fetch-Dest reaches the gate as-is.
        ...(secFetchDest ? { 'Sec-Fetch-Dest': secFetchDest } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A platform-minted identity for the app being gated. `appId` is
// overridable so the cross-app case can be exercised.
const iframeToken = (id, appId = PRIV_APP_ID) => platformJwt.signAppIdentityToken({
  appId, user: { id, username: `u${id}` },
});

// Edge credentials as platform-jwt mints them: HS256 on EDGE_JWT_SECRET,
// `usernode` issuer, `usernode:edge` audience, distinguished by `pur`.
function edgeToken(pur, { uid, appId, host }, opts = {}) {
  return jwt.sign({ uid, appId, host, pur }, opts.secret || EDGE_SECRET, {
    algorithm: 'HS256',
    issuer: opts.issuer || 'usernode',
    audience: opts.audience || 'usernode:edge',
    expiresIn: opts.expiresIn || '1h',
  });
}
const accessCookie = (uid, host, appId = PRIV_APP_ID, opts) =>
  `__usernode_access=${edgeToken('edge:cookie', { uid, appId, host }, opts)}`;
const grantToken = (uid, host, appId = PRIV_APP_ID, opts) =>
  edgeToken('edge:grant', { uid, appId, host }, { expiresIn: '2m', ...opts });

// ── tests ──────────────────────────────────────────────────────────────

test('view-public app passes with no credentials', async () => {
  const r = await gate({ host: PUB_HOST });
  assert.equal(r.status, 200);
});

test('staging preview host inherits the prod app visibility', async () => {
  const r = await gate({ host: `pubapp--s42.${DOMAIN}` });
  assert.equal(r.status, 200);
});

test('unknown slug is 404', async () => {
  const r = await gate({ host: `nosuchapp.${DOMAIN}` });
  assert.equal(r.status, 404);
});

test('host outside the platform domain is 404', async () => {
  const r = await gate({ host: 'evil.example.com' });
  assert.equal(r.status, 404);
});

test('view-private + no credentials: browser GET bounces to apex authorize', async () => {
  const r = await gate({ host: PRIV_HOST, uri: '/some/page' });
  assert.equal(r.status, 302);
  const loc = r.headers.location;
  assert.ok(loc.startsWith(`https://${DOMAIN}/__access/authorize?`), loc);
  assert.ok(loc.includes(encodeURIComponent(PRIV_HOST)), loc);
  assert.ok(loc.includes(encodeURIComponent('/some/page')), loc);
});

test('view-private + no credentials: non-GET is an existence-hiding 404', async () => {
  const r = await gate({ host: PRIV_HOST, uri: '/api/thing', method: 'POST' });
  assert.equal(r.status, 404);
});

// ── Chromeless share-link redirect (top-level document navigations) ────

test('view-private + no credentials: document navigation goes to the chromeless shell view', async () => {
  const r = await gate({ host: PRIV_HOST, secFetchDest: 'document' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `https://${DOMAIN}/#app/privapp/full`);
});

test('document navigation to a staging preview keeps the authorize bounce', async () => {
  const r = await gate({ host: `privapp--s42.${DOMAIN}`, secFetchDest: 'document' });
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.startsWith(`https://${DOMAIN}/__access/authorize?`), r.headers.location);
});

test('iframe/asset/fetch destinations keep the authorize bounce', async () => {
  for (const dest of ['iframe', 'script', 'empty']) {
    const r = await gate({ host: PRIV_HOST, secFetchDest: dest });
    assert.equal(r.status, 302);
    assert.ok(r.headers.location.startsWith(`https://${DOMAIN}/__access/authorize?`), `dest=${dest}`);
  }
});

test('non-GET stays an existence-hiding 404 even as a document navigation', async () => {
  const r = await gate({ host: PRIV_HOST, method: 'POST', secFetchDest: 'document' });
  assert.equal(r.status, 404);
});

test('view-public document navigation still passes straight through (Caddy owns the 401 rescue)', async () => {
  const r = await gate({ host: PUB_HOST, secFetchDest: 'document' });
  assert.equal(r.status, 200);
});

test('view-private + member iframe ?token=: cookie-setting redirect to self', async () => {
  const tok = iframeToken(MEMBER_ID);
  const r = await gate({ host: PRIV_HOST, uri: `/?token=${tok}` });
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.includes('__ua=1'), r.headers.location);
  const setCookie = (r.headers['set-cookie'] || []).join(';');
  assert.ok(setCookie.includes('__usernode_access='), 'sets scoped cookie');
});

test('view-private + member token with retry marker: 200 (no loop)', async () => {
  const tok = iframeToken(MEMBER_ID);
  const r = await gate({ host: PRIV_HOST, uri: `/?token=${tok}&__ua=1` });
  assert.equal(r.status, 200);
});

test('view-private + member x-usernode-token header: 200 directly', async () => {
  const r = await gate({
    host: PRIV_HOST, uri: '/api/data', method: 'POST',
    usernodeToken: iframeToken(MEMBER_ID),
  });
  assert.equal(r.status, 200);
});

test('view-private + outsider token: denied (authorize redirect on GET)', async () => {
  const tok = iframeToken(OUTSIDER_ID);
  const r = await gate({ host: PRIV_HOST, uri: `/?token=${tok}` });
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.startsWith(`https://${DOMAIN}/__access/authorize?`));
});

test('view-private + admin token: allowed', async () => {
  const tok = iframeToken(ADMIN_ID);
  const r = await gate({ host: PRIV_HOST, uri: `/?token=${tok}&__ua=1` });
  assert.equal(r.status, 200);
});

test('view-private + valid scoped cookie: 200', async () => {
  const r = await gate({ host: PRIV_HOST, cookie: accessCookie(MEMBER_ID, PRIV_HOST) });
  assert.equal(r.status, 200);
});

test('scoped cookie bound to a different host is rejected', async () => {
  const r = await gate({ host: PRIV_HOST, cookie: accessCookie(MEMBER_ID, `other.${DOMAIN}`) });
  assert.equal(r.status, 302); // falls through to authorize
});

test('scoped cookie for a user who lost membership is rejected', async () => {
  const r = await gate({ host: PRIV_HOST, cookie: accessCookie(OUTSIDER_ID, PRIV_HOST) });
  assert.equal(r.status, 302);
});

test('grant callback mints the scoped cookie and redirects to next', async () => {
  const grant = grantToken(MEMBER_ID, PRIV_HOST);
  const r = await gate({
    host: PRIV_HOST,
    uri: `/__usernode_access?grant=${encodeURIComponent(grant)}&next=${encodeURIComponent('/deep/link')}`,
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/deep/link');
  const setCookie = (r.headers['set-cookie'] || []).join(';');
  assert.ok(setCookie.includes('__usernode_access='));
});

test('grant callback sanitizes absolute next targets', async () => {
  const grant = grantToken(MEMBER_ID, PRIV_HOST);
  const r = await gate({
    host: PRIV_HOST,
    uri: `/__usernode_access?grant=${encodeURIComponent(grant)}&next=${encodeURIComponent('//evil.com/x')}`,
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/');
});

test('grant for the wrong host restarts the authorize dance', async () => {
  const grant = grantToken(MEMBER_ID, `other.${DOMAIN}`);
  const r = await gate({
    host: PRIV_HOST,
    uri: `/__usernode_access?grant=${encodeURIComponent(grant)}&next=%2F`,
  });
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.startsWith(`https://${DOMAIN}/__access/authorize?`));
});

test('iframe token signed with the wrong key is rejected', async () => {
  const bad = jwt.sign({ id: MEMBER_ID, pur: 'iframe' }, 'wrong-secret', { expiresIn: '1h' });
  const r = await gate({ host: PRIV_HOST, uri: `/?token=${bad}` });
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.startsWith(`https://${DOMAIN}/__access/authorize?`));
});

// An HS256 token forged with the PUBLIC PEM — which every app container
// holds — must not open the gate. Only the algorithm pin stops this.
test('HS256 token forged with the public PEM is rejected', async () => {
  const forged = jwt.sign(
    { id: MEMBER_ID, pur: 'iframe' },
    keys.IFRAME_JWT_PUBLIC_KEY,
    { algorithm: 'HS256', issuer: 'usernode', audience: `usernode:app:${PRIV_APP_ID}`, expiresIn: '1h' }
  );
  const r = await gate({ host: PRIV_HOST, uri: `/?token=${forged}` });
  assert.equal(r.status, 302);
});

// The token is per-app. A member's identity minted for some OTHER app
// they can see must not unlock this host.
test('iframe token minted for a different app is rejected', async () => {
  const other = iframeToken(MEMBER_ID, PRIV_APP_ID + 1);
  const r = await gate({ host: PRIV_HOST, uri: `/?token=${other}` });
  assert.equal(r.status, 302);
});

// The same identity, but as a capture token (15m) rather than an iframe
// token — same authority, same audience, so it is accepted. Pinned so a
// later purpose split does not silently break screenshot capture of
// view-private apps.
test('a capture-TTL identity for this app still opens the gate', async () => {
  const tok = platformJwt.signAppIdentityToken({
    appId: PRIV_APP_ID,
    user: { id: MEMBER_ID, username: `u${MEMBER_ID}` },
    ttl: platformJwt.CAPTURE_TTL,
  });
  const r = await gate({ host: PRIV_HOST, usernodeToken: tok });
  assert.equal(r.status, 200);
});

// A worker token is a different authority with a different `pur`.
test('a worker token does not open the edge gate', async () => {
  const r = await gate({
    host: PRIV_HOST, usernodeToken: platformJwt.signWorkerToken({ sessionId: 3 }),
  });
  assert.equal(r.status, 302);
});

// ── key separation ─────────────────────────────────────────────────────
//
// The edge authority is EDGE_JWT_SECRET, and it is the ONLY thing that
// mints edge credentials. The retired shared secret is dead everywhere.

test('scoped cookie signed with the retired shared secret is rejected', async () => {
  const r = await gate({
    host: PRIV_HOST,
    cookie: accessCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, { secret: LEGACY_SECRET }),
  });
  assert.equal(r.status, 302);
});

test('grant signed with the retired shared secret restarts the authorize dance', async () => {
  const grant = grantToken(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, { secret: LEGACY_SECRET });
  const r = await gate({
    host: PRIV_HOST,
    uri: `/__usernode_access?grant=${encodeURIComponent(grant)}&next=%2F`,
  });
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.startsWith(`https://${DOMAIN}/__access/authorize?`));
});

// Both edge purposes share one key, so `pur` is the only thing stopping a
// 120s grant from being pasted in as a 12h cookie (and vice versa).
test('a grant presented as the scoped cookie is rejected', async () => {
  const r = await gate({
    host: PRIV_HOST,
    cookie: `__usernode_access=${grantToken(MEMBER_ID, PRIV_HOST)}`,
  });
  assert.equal(r.status, 302);
});

test('a scoped cookie presented as the grant is rejected', async () => {
  const cookieTok = edgeToken('edge:cookie', {
    uid: MEMBER_ID, appId: PRIV_APP_ID, host: PRIV_HOST,
  });
  const r = await gate({
    host: PRIV_HOST,
    uri: `/__usernode_access?grant=${encodeURIComponent(cookieTok)}&next=%2F`,
  });
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.startsWith(`https://${DOMAIN}/__access/authorize?`));
});

test('edge token with the wrong audience is rejected', async () => {
  const r = await gate({
    host: PRIV_HOST,
    cookie: accessCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, { audience: 'usernode:worker' }),
  });
  assert.equal(r.status, 302);
});

test('edge token with the wrong issuer is rejected', async () => {
  const r = await gate({
    host: PRIV_HOST,
    cookie: accessCookie(MEMBER_ID, PRIV_HOST, PRIV_APP_ID, { issuer: 'somebody-else' }),
  });
  assert.equal(r.status, 302);
});

test('the cookie the gate mints is a real edge:cookie token, not a grant', async () => {
  const grant = grantToken(MEMBER_ID, PRIV_HOST);
  const r = await gate({
    host: PRIV_HOST,
    uri: `/__usernode_access?grant=${encodeURIComponent(grant)}&next=%2F`,
  });
  const setCookie = (r.headers['set-cookie'] || []).join(';');
  const minted = /__usernode_access=([^;]+)/.exec(setCookie)[1];
  const claims = jwt.verify(minted, EDGE_SECRET, {
    algorithms: ['HS256'], issuer: 'usernode', audience: 'usernode:edge',
  });
  assert.equal(claims.pur, 'edge:cookie');
  assert.equal(claims.uid, MEMBER_ID);
  assert.equal(claims.appId, PRIV_APP_ID);
  assert.equal(claims.host, PRIV_HOST);
  // 12h, not the grant's 2m.
  assert.equal(claims.exp - claims.iat, 12 * 60 * 60);
});
