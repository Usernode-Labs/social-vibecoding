// Listing metadata API and builder aggregation. Uses the real Express
// routes with a scripted pool so access behavior and SQL shape are covered
// without requiring Postgres.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let scenario;
const calls = [];

const pool = {
  async query(sql, params = []) {
    calls.push({ sql: String(sql), params });
    if (/FROM apps a/.test(sql)) return { rows: scenario.listRows || [] };
    if (/SELECT \* FROM apps WHERE slug = \$1/.test(sql)) {
      return { rows: scenario.app ? [scenario.app] : [] };
    }
    if (/SELECT id, slug, created_by, self_hosted, collab_visibility, view_visibility FROM apps WHERE slug/.test(sql)) {
      return { rows: scenario.app ? [scenario.app] : [] };
    }
    if (/SELECT 1 FROM app_collaborators/.test(sql)) {
      return { rows: scenario.isMember ? [{ '?column?': 1 }] : [] };
    }
    if (/UPDATE apps[\s\S]*RETURNING category, tagline/.test(sql)) {
      if (params[0]) scenario.app.category = params[1];
      if (params[2]) scenario.app.tagline = params[3];
      return { rows: [{ category: scenario.app.category, tagline: scenario.app.tagline }] };
    }
    if (/FROM chat_sessions cs[\s\S]*status = 'merged'/.test(sql)) {
      return { rows: scenario.builders || [] };
    }
    return { rows: [] };
  },
};
poolMod.getPool = () => pool;

delete require.cache[require.resolve('../src/routes/apps')];
const { appRoutes } = require('../src/routes/apps');

const viewer = { id: 7, username: 'alice', isAdmin: false };
let server;
let baseUrl;

function appRow(overrides = {}) {
  return {
    id: 4,
    slug: 'demo',
    name: 'Demo',
    status: 'error',
    created_by: 9,
    self_hosted: false,
    collab_visibility: 'private',
    view_visibility: 'public',
    manifest_snapshot: null,
    repo_url: null,
    main_sha: null,
    main_pr_number: null,
    is_collaborator: false,
    is_favorited: false,
    favorite_order: null,
    category: null,
    tagline: null,
    ...overrides,
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = viewer; next(); });
  app.use(appRoutes({}));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

beforeEach(() => {
  calls.length = 0;
  scenario = { app: appRow(), isMember: false, builders: [], listRows: [] };
});

function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
}

test('PATCH listing rejects callers without build access', async () => {
  const res = await request('/api/apps/demo/listing', {
    method: 'PATCH',
    body: JSON.stringify({ category: 'game' }),
  });
  assert.equal(res.status, 404);
  assert.ok(!calls.some((call) => /UPDATE apps/.test(call.sql)));
});

test('PATCH listing validates category and tagline before writing', async () => {
  scenario.isMember = true;
  let res = await request('/api/apps/demo/listing', {
    method: 'PATCH',
    body: JSON.stringify({ category: 'finance' }),
  });
  assert.equal(res.status, 400);

  res = await request('/api/apps/demo/listing', {
    method: 'PATCH',
    body: JSON.stringify({ tagline: 'x'.repeat(81) }),
  });
  assert.equal(res.status, 400);
  assert.ok(!calls.some((call) => /UPDATE apps/.test(call.sql)));
});

test('PATCH listing trims and persists valid metadata', async () => {
  scenario.isMember = true;
  const res = await request('/api/apps/demo/listing', {
    method: 'PATCH',
    body: JSON.stringify({ category: 'tool', tagline: '  Organize shared work  ' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { category: 'tool', tagline: 'Organize shared work' });
  const update = calls.find((call) => /UPDATE apps/.test(call.sql));
  assert.deepEqual(update.params, [true, 'tool', true, 'Organize shared work', 4]);
});

test('GET apps returns listing metadata behind the existing visibility filter', async () => {
  scenario.listRows = [appRow({
    collab_visibility: 'public',
    category: 'game',
    tagline: 'Guess together',
    open_prs: '0',
    active_sessions: '0',
    open_issues: '0',
  })];
  const res = await request('/api/apps');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.apps[0].category, 'game');
  assert.equal(body.apps[0].tagline, 'Guess together');
  const listQuery = calls.find((call) => /FROM apps a/.test(call.sql));
  assert.match(listQuery.sql, /a\.view_visibility = 'public' OR me\.user_id IS NOT NULL/);
});

test('GET builders aggregates merged changes and respects view access', async () => {
  scenario.app = appRow({ view_visibility: 'public' });
  scenario.builders = [
    { user_id: 2, username: 'bea', merged_count: 3 },
    { user_id: 8, username: 'sol', merged_count: 1 },
  ];
  let res = await request('/api/apps/demo/builders');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).builders, scenario.builders);
  const aggregate = calls.find((call) => /FROM chat_sessions cs/.test(call.sql));
  assert.match(aggregate.sql, /cs\.status = 'merged'/);
  assert.match(aggregate.sql, /ORDER BY merged_count DESC/);

  calls.length = 0;
  scenario.app.view_visibility = 'private';
  scenario.isMember = false;
  res = await request('/api/apps/demo/builders');
  assert.equal(res.status, 404);
  assert.ok(!calls.some((call) => /FROM chat_sessions cs/.test(call.sql)));
});
