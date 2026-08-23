// CWE-200 regression coverage: GET /api/apps, GET /api/apps/:slug,
// POST /api/apps, and POST /api/apps/:slug/fork must never return the
// apps table's credential columns (db_password, llm_proxy_token,
// storage_api_token) to any authenticated caller — outsider, collaborator,
// creator, or admin — on a public or private app. Also cross-checks that
// every `staging:private`-tagged `apps` column in schema.sql is covered by
// appAccess.SECRET_APP_COLUMNS, mirroring
// tests/prod-debug-access.test.js's schema-tag cross-check.
//
// Harness shape borrowed from tests/apps-last-failure-route.test.js: stub
// getPool before requiring the route module, mount appRoutes on a real
// express app, hit it over HTTP.
//
// Run with: node --test tests/app-secret-exposure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  appCreator: require.resolve('../src/services/app-creator'),
  appForker: require.resolve('../src/services/app-forker'),
  caddy: require.resolve('../src/services/caddy'),
  docker: require.resolve('../src/services/docker'),
  github: require.resolve('../src/services/github'),
  driftPoller: require.resolve('../src/services/main-drift-poller'),
  appSecrets: require.resolve('../src/services/app-secrets'),
  appManifest: require.resolve('../src/services/app-manifest'),
  renamePr: require.resolve('../src/services/rename-pr'),
  staging: require.resolve('../src/services/staging'),
};

stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(ids.appCreator, { createApp: async () => {} });
stub(ids.appForker, { forkApp: async () => {} });
stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
stub(ids.docker, { getHostPort: async () => null });
stub(ids.github, { parseGithubUrl: () => null, isEnabled: () => false });
stub(ids.driftPoller, { checkAndRedeployOne: async () => ({}) });
stub(ids.appSecrets, {});
// The create/fork routes derive the app slug through the manifest module, so
// the stub carries the real slug builder rather than a second copy of its
// length budget (see appManifest.MAX_APP_SLUG_LENGTH).
const realAppManifest = require('../src/services/app-manifest');
stub(ids.appManifest, {
  MAX_APP_NAME_LENGTH: 64,
  MAX_APP_SLUG_LENGTH: realAppManifest.MAX_APP_SLUG_LENGTH,
  buildAppSlug: realAppManifest.buildAppSlug,
});
stub(ids.renamePr, {});
stub(ids.staging, { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });

const SECRET_VALUES = {
  db_password: 'fixture-db-password-do-not-leak',
  llm_proxy_token: 'fixture-llm-proxy-token-do-not-leak',
  storage_api_token: 'fixture-storage-api-token-do-not-leak',
};
const SECRET_KEYS = Object.keys(SECRET_VALUES);

function makeAppRow(overrides = {}) {
  return {
    id: 42,
    name: 'Private Notes',
    slug: 'private-notes',
    repo_url: 'https://github.com/acme/private-notes',
    container_id: null,
    status: 'running',
    retry_count: 0,
    created_by: 100,
    created_at: '2026-01-01T00:00:00.000Z',
    main_sha: null,
    main_pr_number: null,
    last_deploy_at: null,
    manifest_snapshot: null,
    last_failure: null,
    locked: false,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    approver_policy: 'anyone',
    approvals_required: null,
    screenshot_device_scale: 2,
    icon_emoji: null,
    icon_image_id: null,
    forked_from: null,
    ...SECRET_VALUES,
    ...overrides,
  };
}

const poolMod = require('../src/db/pool');
let appRow = null;
let collaboratorIds = new Set();

poolMod.getPool = () => ({
  query: async (sql, params) => {
    const s = String(sql);

    // List endpoint's big joined query — unique to that handler.
    if (/COALESCE\(msg_counts\.cnt, 0\) AS message_count/.test(s)) {
      return appRow ? { rows: [appRow] } : { rows: [] };
    }
    // Detail endpoint AND the fork endpoint's source-app lookup share this
    // shape; both are keyed by slug so disambiguate on the bound param.
    if (/FROM apps WHERE slug = \$1/.test(s)) {
      if (!appRow || params?.[0] !== appRow.slug) return { rows: [] };
      return { rows: [appRow] };
    }
    if (/FROM app_collaborators/.test(s)) {
      return collaboratorIds.has(params?.[1]) ? { rows: [{ 1: 1 }] } : { rows: [] };
    }
    // Create/fork insert-CTEs: fork's INSERT column list carries
    // forked_from, create's does not — that's the disambiguator.
    if (/INSERT INTO apps/.test(s)) {
      const inserted = /forked_from/.test(s)
        ? makeAppRow({ id: 777, slug: 'forked-app', name: 'Forked App', forked_from: null, ...SECRET_VALUES })
        : makeAppRow({ id: 778, slug: 'new-app', name: 'New App', ...SECRET_VALUES });
      return { rows: [inserted] };
    }
    return { rows: [], rowCount: 0 };
  },
});

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

let currentUser = null;

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function assertNoSecrets(obj, label) {
  for (const key of SECRET_KEYS) {
    assert.ok(!Object.hasOwn(obj, key), `${label}: ${key} key must not be present`);
  }
  const serialized = JSON.stringify(obj);
  for (const value of Object.values(SECRET_VALUES)) {
    assert.ok(!serialized.includes(value), `${label}: fixture secret value leaked into response body`);
  }
}

const ROLES = [
  { label: 'outsider on a public app', user: { id: 999, username: 'outsider' }, visibility: 'public', collaborators: [] },
  { label: 'accepted collaborator on a private app', user: { id: 200, username: 'collab' }, visibility: 'private', collaborators: [200] },
  // The creator is auto-enrolled as an app_collaborators member on
  // creation, so view-access for the creator flows through the same
  // isCollaborator() check as any other collaborator.
  { label: 'creator of a private app', user: { id: 100, username: 'creator' }, visibility: 'private', collaborators: [100] },
  { label: 'admin viewing a private app', user: { id: 300, username: 'admin', isAdmin: true }, visibility: 'private', collaborators: [] },
];

for (const role of ROLES) {
  test(`GET /api/apps list never exposes secrets to ${role.label}`, async () => {
    appRow = makeAppRow({ view_visibility: role.visibility, created_by: 100 });
    collaboratorIds = new Set(role.collaborators);
    currentUser = role.user;
    const server = await startServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps`);
      assert.equal(res.status, 200);
      const { apps } = await res.json();
      const app = apps.find((a) => a.slug === 'private-notes');
      assert.ok(app, 'fixture app should be present in the list for this role');
      assertNoSecrets(app, `list/${role.label}`);
    } finally {
      server.close();
    }
  });

  test(`GET /api/apps/:slug detail never exposes secrets to ${role.label}`, async () => {
    appRow = makeAppRow({ view_visibility: role.visibility, created_by: 100 });
    collaboratorIds = new Set(role.collaborators);
    currentUser = role.user;
    const server = await startServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/private-notes`);
      assert.equal(res.status, 200);
      const { app } = await res.json();
      assertNoSecrets(app, `detail/${role.label}`);
    } finally {
      server.close();
    }
  });
}

test('POST /api/apps create response never exposes secrets', async () => {
  appRow = null;
  collaboratorIds = new Set();
  currentUser = { id: 100, username: 'creator', canAdminWrite: true };
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New App' }),
    });
    assert.equal(res.status, 201);
    const { app } = await res.json();
    assertNoSecrets(app, 'create');
  } finally {
    server.close();
  }
});

test('POST /api/apps/:slug/fork response never exposes secrets', async () => {
  appRow = makeAppRow({ slug: 'private-notes', self_hosted: false, view_visibility: 'public' });
  collaboratorIds = new Set();
  currentUser = { id: 555, username: 'forker', canAdminWrite: true };
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/private-notes/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Forked App' }),
    });
    assert.equal(res.status, 201);
    const { app } = await res.json();
    assertNoSecrets(app, 'fork');
  } finally {
    server.close();
  }
});

// ── The secrets panel's own response ──────────────────────────────────
//
// GET /api/apps/:slug/secrets grew two new row sources, and neither may
// carry plaintext:
//   * a `proposed` row (a declaration up for vote) — its value lives
//     encrypted in pending_secret_declarations, and only a NON-private
//     one may preview its last 4 characters;
//   * a `github-actions` row — GitHub's API returns no value at all, so
//     value/valueLast4 are hard nulls rather than derived.
// Both are asserted at the source: the view builders in
// src/routes/apps.js, and the DAO that feeds the first one.

test('a proposed row never carries plaintext, and a private one carries no preview', () => {
  const appsJs = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  const merge = appsJs.slice(
    appsJs.indexOf('async function mergePendingDeclarations('),
    appsJs.indexOf('// Can this user open a declaration proposal')
  );
  assert.ok(merge.length, 'mergePendingDeclarations not found');
  assert.match(merge, /value: null/, 'a proposed row has no plaintext field to leak');
  assert.match(merge, /valueLast4: p\.valueLast4/,
    'the preview comes from the DAO, which nulls it for a private declaration');

  // …and the DAO is where that nulling happens, so pin it there too.
  const pendingJs = fs.readFileSync(
    path.join(__dirname, '../src/services/pending-secrets.js'), 'utf8'
  );
  assert.match(pendingJs, /valueLast4: decl\.private \? null : \(r\.value_last4 \|\| null\)/);
  assert.match(pendingJs, /if \(isPrivate\) return null;/, 'and no last-4 is ever stored for one');
});

test('a GitHub Actions row hard-codes null for value and last-4', () => {
  const appsJs = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  const block = appsJs.slice(
    appsJs.indexOf("if (actionsSecrets && Array.isArray(actionsSecrets.secrets))"),
    appsJs.indexOf('// Group in key order within a group')
  );
  assert.ok(block.length, 'the Actions-secrets merge was not found');
  assert.match(block, /value: null/);
  assert.match(block, /valueLast4: null/);
  assert.ok(!/includeValues/.test(block),
    'these rows must not become value-bearing for an admin — there is no value to bear');
});

test('the declaration route holds the value encrypted, never in the clear', () => {
  const pendingJs = fs.readFileSync(
    path.join(__dirname, '../src/services/pending-secrets.js'), 'utf8'
  );
  assert.match(pendingJs, /encrypt\(value, dataKey\)/, 'held values are encrypted at rest');
  assert.match(pendingJs, /SET value_enc = NULL/,
    'and the ciphertext is dropped once the value is live in the real store');
});

// ── Schema cross-check (mirrors tests/prod-debug-access.test.js) ───────

test('every staging:private apps.<column> in schema.sql is covered by SECRET_APP_COLUMNS', () => {
  const appAccess = require('../src/services/app-access');
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const tagged = [...schema.matchAll(
    /COMMENT ON COLUMN\s+apps\.([a-z_]+)\s+IS\s+'staging:private'/g
  )].map((m) => m[1]);
  assert.ok(tagged.length >= 3, `expected to find tagged apps columns, got ${tagged.length}`);
  for (const column of tagged) {
    assert.ok(
      appAccess.SECRET_APP_COLUMNS.includes(column),
      `staging:private column apps.${column} is not in SECRET_APP_COLUMNS`
    );
  }
});
