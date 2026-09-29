'use strict';

// #2510: four endpoints resolved an app BY SLUG, checked that the caller was
// signed in, and then answered — without ever asking whether that caller may
// see the app.
//
//   GET  /api/apps/:slug/permissions      (routes/app-permissions.js)
//   POST /api/me/permission-grants        (routes/app-permissions.js, body.appSlug)
//   GET  /api/apps/:slug/llm-grant        (routes/llm-grants.js)
//   POST /api/me/llm-grants               (routes/llm-grants.js, body.appSlug)
//
// Every other slug-addressed route in the codebase goes through
// `appAccess.getAppForUser`, which resolves the row and enforces access in
// one call and returns null on denial so the caller can 404. These four ran
// a bare `SELECT ... FROM apps WHERE slug = $1` instead.
//
// What that leaked, to any signed-in stranger, about an app whose
// `view_visibility` is 'private':
//
//   - its existence at all — 404 vs 200 is an enumeration oracle over every
//     slug on the platform;
//   - its `id`, `name` and `slug`;
//   - parts of its MANIFEST: which gated capabilities it declares, and its
//     `llm` block's purpose string and suggested daily cap.
//
// And the two POSTs did more than leak. They WROTE: a stranger could create
// a permission grant or an LLM spend grant against a private app they cannot
// see. The `not_declared` refusal on the grant route is also an oracle in its
// own right — it distinguishes "this private app declares camera" from "it
// does not" without ever showing the manifest.
//
// The fix routes all four through `getAppForUser(..., 'view', ACCESS_COLUMNS
// + the columns the route needs)` and 404s on null, which is the same wall
// the rest of the platform already presents: a denied app is indistinguishable
// from one that does not exist.
//
// Run with: node --test tests/private-app-slug-gates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// Match CODE, not the comments that describe it.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── The four routes, behaviourally ─────────────────────────────────────
//
// Both factories take only `config` and call `getPool(config)` themselves, so
// the fixture pool goes in by stubbing that module before they are required —
// the same pattern tests/app-fork-retry-route.test.js uses.

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// One private app and one public one. `view_visibility` is what
// checkAppAccess reads; it is NOT NULL DEFAULT 'public' in schema.sql, so a
// fixture that omits it is a fixture bug, not a reason to relax the helper.
const APPS = {
  'secret-app': {
    id: 41,
    slug: 'secret-app',
    name: 'Secret App',
    created_by: 7,
    self_hosted: false,
    collab_visibility: 'private',
    view_visibility: 'private',
    manifest_snapshot: {
      permissions: [{ capability: 'camera', reason: 'To scan receipts' }],
      llm: { purpose: 'Summarise the private roadmap', suggested_daily_cap_cents: 500 },
    },
  },
  'open-app': {
    id: 42,
    slug: 'open-app',
    name: 'Open App',
    created_by: 7,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    manifest_snapshot: {
      permissions: [{ capability: 'camera', reason: 'To scan receipts' }],
      llm: { purpose: 'Summarise the public roadmap', suggested_daily_cap_cents: 500 },
    },
  },
};

// Who is a collaborator on what. `isCollaborator` is the only other way
// checkAppAccess can say yes.
const COLLABORATORS = new Set(['41:7']);

function makePool() {
  return {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      // The app lookup, whatever projection the route asks for.
      const slugMatch = /FROM apps WHERE slug = \$1/.exec(text);
      if (slugMatch) {
        const app = APPS[params[0]];
        return { rows: app ? [{ ...app }] : [], rowCount: app ? 1 : 0 };
      }
      // appAccess.isCollaborator
      if (/FROM app_collaborators/.test(text) || /collaborator/i.test(text)) {
        const key = `${params[0]}:${params[1]}`;
        return COLLABORATORS.has(key)
          ? { rows: [{ '?column?': 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // Grants the bootstrap reads — none, for these fixtures.
      if (/app_permission_grants|app_llm_grants|app_llm_usage/.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Drive one route's handler directly: find it on the router's stack by
// method + path, then call it with a stub req/res. This keeps the test on
// the ACCESS decision rather than on express wiring.
function findHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== routePath) continue;
    if (!layer.route.methods[method]) continue;
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
  }
  throw new Error(`no ${method.toUpperCase()} ${routePath} on this router`);
}

function stubRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

async function call(router, method, routePath, { params = {}, body = {}, user }) {
  const handler = findHandler(router, method, routePath);
  const res = stubRes();
  lastError = null;
  await handler({ params, body, query: {}, headers: {}, user, method: method.toUpperCase() }, res);
  if (res.statusCode === 500) {
    throw new Error(`route 500: ${lastError?.msg} ${JSON.stringify(lastError?.meta)}`);
  }
  return res;
}

const STRANGER = { id: 99, isAdmin: false, canAdminWrite: false };
const MEMBER = { id: 7, isAdmin: false, canAdminWrite: false };
const ADMIN = { id: 1, isAdmin: true, canAdminWrite: true };

const config = { selfAppSlug: 'platform', dataEncryptionKey: null };

let lastError = null;

// Rebuild both routers over a fresh fixture pool. The route modules are
// re-required each time so a stubbed pool cannot leak between tests.
function routers() {
  const pool = makePool();
  const poolId = require.resolve('../src/db/pool');
  const permsId = require.resolve('../src/routes/app-permissions');
  const llmId = require.resolve('../src/routes/llm-grants');
  const limitsId = require.resolve('../src/services/limits');

  stub(poolId, { getPool: () => pool });
  // Surface a route's own 500 handler instead of swallowing it — a silent
  // 500 in this file means the FIXTURE is wrong, not the access rule.
  stub(require.resolve('../src/services/logger'), {
    info() {}, warn() {}, debug() {},
    error(scope, msg, meta) { lastError = { scope, msg, meta }; },
  });
  // The LLM consent bootstrap asks limits.js what credit the caller has.
  // None of that is what this file is testing, so it answers plainly — the
  // access decision has to come first either way.
  // Keep the REAL limits module and override only the two functions that
  // would go to the database. Stubbing the whole module by hand missed
  // `isIdentityGated` and turned every route into a 500 — which is exactly
  // the failure mode a hand-written module stub has, so spread the real one.
  const realLimits = require('../src/services/limits');
  stub(limitsId, {
    ...realLimits,
    getUserCreditEntitlement: async () => ({
      entitlementAvailable: true, verificationRequired: false, tier: 'full',
    }),
    loadUserApiKey: async () => null,
  });
  delete require.cache[permsId];
  delete require.cache[llmId];
  const { appPermissionsRoutes } = require('../src/routes/app-permissions');
  const { llmGrantsRoutes } = require('../src/routes/llm-grants');
  const built = { perms: appPermissionsRoutes(config), llm: llmGrantsRoutes(config) };
  delete require.cache[poolId];
  delete require.cache[limitsId];
  return built;
}

test('a stranger cannot read a private app’s permission bootstrap', async () => {
  const { perms } = routers();
  const res = await call(perms, 'get', '/api/apps/:slug/permissions',
    { params: { slug: 'secret-app' }, user: STRANGER });
  assert.equal(res.statusCode, 404, 'a denied app must be indistinguishable from a missing one');
  assert.equal(res.body?.app, undefined, 'no id, no name, no slug');
  assert.equal(res.body?.declared, undefined, 'no manifest capabilities');
});

test('a stranger cannot read a private app’s LLM consent bootstrap', async () => {
  const { llm } = routers();
  const res = await call(llm, 'get', '/api/apps/:slug/llm-grant',
    { params: { slug: 'secret-app' }, user: STRANGER });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body?.app, undefined);
  assert.equal(res.body?.purpose, undefined, 'the manifest llm purpose must not leak');
});

test('a stranger cannot create a permission grant on a private app', async () => {
  const { perms } = routers();
  const res = await call(perms, 'post', '/api/me/permission-grants',
    { body: { appSlug: 'secret-app', capability: 'camera' }, user: STRANGER });
  assert.equal(res.statusCode, 404, 'not 400 — a 400 would confirm the app exists');
  assert.notEqual(res.body?.code, 'not_declared',
    'the declared/not-declared split is itself a manifest oracle');
});

test('a stranger cannot create an LLM grant on a private app', async () => {
  const { llm } = routers();
  const res = await call(llm, 'post', '/api/me/llm-grants',
    { body: { appSlug: 'secret-app', dailyCapCents: 100 }, user: STRANGER });
  assert.equal(res.statusCode, 404);
});

// The refusal must not be distinguishable from a slug that was never taken,
// or the four routes remain an enumeration oracle over the whole platform.
test('a private app answers exactly like one that does not exist', async () => {
  const { perms, llm } = routers();
  const cases = [
    [perms, 'get', '/api/apps/:slug/permissions', { params: { slug: 'X' }, user: STRANGER }],
    [llm, 'get', '/api/apps/:slug/llm-grant', { params: { slug: 'X' }, user: STRANGER }],
  ];
  for (const [router, method, routePath, opts] of cases) {
    const denied = await call(router, method, routePath,
      { ...opts, params: { slug: 'secret-app' } });
    const missing = await call(router, method, routePath,
      { ...opts, params: { slug: 'no-such-app-anywhere' } });
    assert.equal(denied.statusCode, missing.statusCode, `${method} ${routePath} status`);
    assert.deepEqual(denied.body, missing.body, `${method} ${routePath} body`);
  }
});

// ── and the people who SHOULD get through still do ──────────────────────

test('a public app is unchanged for everyone', async () => {
  const { perms, llm } = routers();
  const bootstrap = await call(perms, 'get', '/api/apps/:slug/permissions',
    { params: { slug: 'open-app' }, user: STRANGER });
  assert.equal(bootstrap.statusCode, 200);
  assert.equal(bootstrap.body.app.slug, 'open-app');
  assert.ok(Array.isArray(bootstrap.body.declared));

  const consent = await call(llm, 'get', '/api/apps/:slug/llm-grant',
    { params: { slug: 'open-app' }, user: STRANGER });
  assert.equal(consent.statusCode, 200);
  assert.equal(consent.body.app.slug, 'open-app');
});

test('a collaborator still reaches their own private app', async () => {
  const { perms, llm } = routers();
  const bootstrap = await call(perms, 'get', '/api/apps/:slug/permissions',
    { params: { slug: 'secret-app' }, user: MEMBER });
  assert.equal(bootstrap.statusCode, 200, 'the gate is view access, not ownership');
  assert.equal(bootstrap.body.app.id, 41);

  const consent = await call(llm, 'get', '/api/apps/:slug/llm-grant',
    { params: { slug: 'secret-app' }, user: MEMBER });
  assert.equal(consent.statusCode, 200);
});

test('an admin still reaches a private app', async () => {
  const { perms } = routers();
  const res = await call(perms, 'get', '/api/apps/:slug/permissions',
    { params: { slug: 'secret-app' }, user: ADMIN });
  assert.equal(res.statusCode, 200, 'checkAppAccess short-circuits on isAdmin');
});

test('an anonymous caller is still 401, not 404', async () => {
  const { perms, llm } = routers();
  for (const [router, method, routePath, opts] of [
    [perms, 'get', '/api/apps/:slug/permissions', { params: { slug: 'open-app' } }],
    [llm, 'get', '/api/apps/:slug/llm-grant', { params: { slug: 'open-app' } }],
  ]) {
    const res = await call(router, method, routePath, { ...opts, user: null });
    assert.equal(res.statusCode, 401, 'signing in is a different failure from not being allowed');
  }
});

// ── The shape, pinned in the sources ───────────────────────────────────

test('none of the four resolves an app by a bare slug query any more', () => {
  for (const file of ['src/routes/app-permissions.js', 'src/routes/llm-grants.js']) {
    const src = code(read(file));
    assert.doesNotMatch(src, /SELECT [^;]*FROM apps WHERE slug = \$1/,
      `${file} still resolves an app without checking access — use getAppForUser`);
    assert.match(src, /appAccess\.getAppForUser\(/,
      `${file} must route its app lookups through the access helper`);
  }
});

// checkAppAccess THROWS when the row lacks view_visibility rather than
// failing open, so every call site has to ask for ACCESS_COLUMNS. A
// projection trimmed back later would turn these routes into 500s, which is
// exactly the regression this pins.
test('each lookup selects the access columns the helper requires', () => {
  for (const file of ['src/routes/app-permissions.js', 'src/routes/llm-grants.js']) {
    const src = code(read(file));
    const calls = src.match(/getAppForUser\([^)]*\)/g) || [];
    assert.ok(calls.length >= 2, `${file}: expected both lookups to be converted`);
    for (const c of calls) {
      assert.match(c, /ACCESS_COLUMNS/, `${file}: ${c} must include the access columns`);
      assert.match(c, /'view'/, `${file}: ${c} should gate on view access`);
    }
  }
});
