// GET /api/v4/admin/api-catalog — the route list the admin console's API
// tester (#admin/seasons/api-tester) populates its endpoint select from.
//
// The point of these tests is the DERIVATION. The catalog is introspected
// from Express's own router stack, which is only exact because every v4
// router is mounted UNSCOPED with absolute paths inside (see server.js's
// mount comment and api-catalog.js's own header). If that ever changes,
// the endpoint would quietly return an empty list and the tester would
// silently regress to a free-text box — so the assertions below pin a
// floor on the count, the presence of routes from several different
// modules, and the grouping the select renders as <optgroup> labels.
//
// Run with: node --test tests/topochain-api-catalog.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { topochainAdminRoutes } = require('../src/routes/topochain/admin');
const { topochainPublicRoutes } = require('../src/routes/topochain/public');
const { topochainPartnerRoutes } = require('../src/routes/topochain/partner');
const { topochainIngestRoutes } = require('../src/routes/topochain/ingest');
const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
const { buildCatalog } = require('../src/routes/topochain/admin/api-catalog');

// The same shape server.js mounts: every v4 router with NO path argument,
// so a route layer's own path is already the full public path.
function buildApp(role = 'admin') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role === 'anon') { next(); return; }
    if (role === 'user') { req.user = { id: 1, username: 'plain', isAdmin: false, canAdminWrite: false }; next(); return; }
    if (role === 'readonly') { req.user = { id: 2, username: 'ro', isAdmin: true, canAdminWrite: false }; next(); return; }
    req.user = { id: 3, username: 'full', isAdmin: true, canAdminWrite: true };
    next();
  });
  app.use(topochainPublicRoutes({}));
  app.use(topochainPartnerRoutes({}));
  app.use(topochainIngestRoutes({}));
  app.use(topochainMobileRoutes({}));
  app.use(topochainAdminRoutes({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function catalog(role = 'admin') {
  const { server, base } = await listen(buildApp(role));
  try {
    const res = await fetch(`${base}/api/v4/admin/api-catalog`);
    return { res, body: await res.json() };
  } finally {
    server.close();
  }
}

test('the catalog enumerates the real mounted v4 surface, not a hardcoded list', async () => {
  const { res, body } = await catalog();
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.prefix, '/api/v4');
  assert.ok(Array.isArray(body.data));
  // There were 120+ /api/v4 route registrations when this landed. The floor
  // is deliberately well under that (routes come and go) but far above the
  // 0 an introspection failure would produce.
  assert.ok(body.data.length >= 80, `expected the full v4 surface, got ${body.data.length}`);
  assert.equal(body.count, body.data.length);

  const keys = body.data.map((r) => `${r.method} ${r.path}`);
  // One route from each of several different modules — a prefix-matching
  // bug that dropped a whole router would take one of these with it.
  for (const expected of [
    'GET /admin/seasons',
    'POST /admin/seasons',
    'DELETE /admin/seasons/:id',
    'GET /admin/season-events',
    'GET /admin/users',
    'GET /admin/settings',
    'POST /admin/sql-query/execute',
    'GET /admin/api-catalog',
    'GET /mobile/leaderboard',
    'GET /delegations',
  ]) {
    assert.ok(keys.includes(expected), `catalog is missing ${expected}`);
  }
  // No duplicates: the select would otherwise show the same option twice.
  assert.equal(new Set(keys).size, keys.length, 'catalog has duplicate entries');
});

test('every entry carries the fields the endpoint select renders', async () => {
  const { body } = await catalog();
  const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  for (const r of body.data) {
    assert.ok(methods.has(r.method), `unexpected method ${r.method}`);
    assert.ok(r.path.startsWith('/'), `path must be relative to /api/v4: ${r.path}`);
    assert.equal(r.full_path, `/api/v4${r.path}`);
    assert.ok(typeof r.group === 'string' && r.group.length, `no group for ${r.path}`);
    assert.equal(r.has_params, /:[A-Za-z0-9_]+/.test(r.path));
  }
  // HEAD is registered by Express alongside every GET and `_all` layers
  // aren't callable endpoints — neither belongs in an operator's list.
  assert.ok(!body.data.some((r) => r.method === 'HEAD' || r.method === '_ALL'));
});

test('routes are grouped and ordered the way the select renders them', async () => {
  const { body } = await catalog();
  assert.ok(Array.isArray(body.groups));
  assert.ok(body.groups.includes('Admin · Seasons'), body.groups.join(', '));
  assert.ok(body.groups.includes('Admin · Season events'));
  assert.ok(body.groups.includes('Mobile'));
  // Admin headings come first (this screen lives under Seasons), the
  // token-authenticated groups after.
  const first = body.groups[0];
  assert.ok(first.startsWith('Admin · '), `expected an Admin heading first, got ${first}`);
  assert.ok(body.groups.indexOf('Mobile') > body.groups.lastIndexOf(
    body.groups.filter((g) => g.startsWith('Admin · ')).slice(-1)[0],
  ));
  // Each group is contiguous in the route list — the client walks it once
  // per group, so an interleaved list would render duplicate <optgroup>s.
  const seen = new Set();
  let prev = null;
  for (const r of body.data) {
    if (r.group !== prev) {
      assert.ok(!seen.has(r.group), `group ${r.group} is not contiguous`);
      seen.add(r.group);
      prev = r.group;
    }
  }
});

test('the catalog is admin-gated like every other /api/v4/admin route', async () => {
  const anon = await catalog('anon');
  assert.equal(anon.res.status, 403);
  const plain = await catalog('user');
  assert.equal(plain.res.status, 403);
  // A view-only admin may READ the surface — listing route names grants no
  // write capability, and the mutations still hit adminWriteGate.
  const ro = await catalog('readonly');
  assert.equal(ro.res.status, 200);
  assert.ok(ro.body.data.length >= 80);
});

test('buildCatalog tolerates an app with no router stack', () => {
  assert.deepEqual(buildCatalog(null), { routes: [], groups: [] });
  assert.deepEqual(buildCatalog({}), { routes: [], groups: [] });
});
