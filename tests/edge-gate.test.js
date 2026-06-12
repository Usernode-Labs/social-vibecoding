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

const JWT_SECRET = 'edge-gate-test-secret';
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
  app.use(internalRoutes({ jwtSecret: JWT_SECRET }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

// Simulates what Caddy's forward_auth sends: GET /__caddy/access with the
// original request's Host/Cookie/x-usernode-token headers plus the
// X-Forwarded-* pair.
function gate({ host, uri = '/', method = 'GET', cookie, usernodeToken } = {}) {
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

const iframeToken = (id) => jwt.sign({ id, username: `u${id}` }, JWT_SECRET, { expiresIn: '1h' });
const accessCookie = (uid, host, appId = PRIV_APP_ID) =>
  `__usernode_access=${jwt.sign({ t: 'app-access', uid, appId, host }, JWT_SECRET, { expiresIn: '1h' })}`;
const grantToken = (uid, host, appId = PRIV_APP_ID) =>
  jwt.sign({ t: 'app-access-grant', uid, appId, host }, JWT_SECRET, { expiresIn: '2m' });

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

test('iframe token signed with the wrong secret is rejected', async () => {
  const bad = jwt.sign({ id: MEMBER_ID }, 'wrong-secret', { expiresIn: '1h' });
  const r = await gate({ host: PRIV_HOST, uri: `/?token=${bad}` });
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.startsWith(`https://${DOMAIN}/__access/authorize?`));
});
