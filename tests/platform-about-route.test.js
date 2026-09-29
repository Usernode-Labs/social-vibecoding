// GET /api/platform/about — the "About Homeroom" pane's facts
// (src/routes/platform-about.js).
//
// The pane is the platform's page in the mark menu, the same pane every app
// has, and the design gives the platform three figures an app does not have:
// apps, members and merged. Pinned here:
//
//   - the shape the pane reads, from the one query's one row;
//   - what each figure COUNTS — only what is out in the open, so a total
//     never counts something a directory would not name;
//   - that the identity (name, tagline, repository, version) answers even
//     for a viewer who is not served the platform's own apps row, which is
//     the whole reason it is not read off GET /api/apps/:slug;
//   - `served`, the per-viewer answer the menu reads instead of probing a row
//     that would 404 (a console error) for a viewer the flag hides it from;
//   - the one-minute cache, since nothing else in the answer depends on who
//     asks;
//   - the staging ?demo=1 overlay, where real counts win;
//   - and that it refuses an anonymous caller and sits behind authMiddleware.
//
// Same harness as tests/app-contributors-route.test.js: swap getPool before
// requiring the route, mount it on a throwaway express app, hit it over HTTP.
//
// Run with: node --test tests/platform-about-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}
stub(require.resolve('../src/services/logger'),
  { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const ROW = {
  apps: 41,
  members: '368',
  merged: 1204,
  name: 'Homeroom',
  repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
  main_sha: 'f8c45cc93becdad4c79e72e29d2de13fd5bd97a5',
  last_deploy_at: '2026-09-22T10:00:00.000Z',
  description: '  Build small web apps together —\n every change is proposed, previewed and merged by a group vote.  ',
};

let row = ROW;
let queries = [];
let fail = false;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  query: async (sql, params) => {
    queries.push({ sql: String(sql), params });
    if (fail) throw new Error('boom');
    return { rows: row ? [row] : [] };
  },
});

const route = require('../src/routes/platform-about');
const express = require('express');

let currentUser = { id: 7 };
function start(config = { selfAppSlug: 'usernode-2d5619' }) {
  const app = express();
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(route.platformAboutRoutes(config));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}
async function get(server, qs = '') {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/platform/about${qs}`);
  return { status: res.status, body: await res.json() };
}
function reset() {
  row = ROW; queries = []; fail = false; currentUser = { id: 7 };
  delete process.env.USERNODE_ENV;
  delete process.env.GIT_SHA;
}

test('the pane gets the platform\'s identity and its three figures', async () => {
  reset();
  const server = await start();
  try {
    const { status, body } = await get(server);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      name: 'Homeroom',
      tagline: 'Build small web apps together — every change is proposed, previewed and merged by a group vote.',
      repoUrl: 'https://github.com/Usernode-Labs/social-vibecoding',
      version: 'f8c45cc',
      updatedAt: '2026-09-22T10:00:00.000Z',
      stats: { apps: 41, members: 368, merged: 1204 },
      selfAppSlug: 'usernode-2d5619',
      served: false,
    });
    assert.deepEqual(queries[0].params, ['usernode-2d5619'],
      'the identity is the self-hosted row, found by the configured slug');
  } finally { server.close(); }
});

test('what each figure counts is only what is out in the open', () => {
  const sql = route.ABOUT_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /FROM apps WHERE NOT self_hosted AND view_visibility = 'public'\) AS apps/,
    'apps: every app anyone can view, never the platform row, never a private app');
  assert.match(sql, /FROM users WHERE has_platform_access AND NOT is_synthetic\) AS members/,
    'members: accounts the platform admits, not the demo partners that cannot sign in');
  assert.match(sql, /cs\.status = 'merged' AND \(a\.self_hosted OR a\.view_visibility = 'public'\)\) AS merged/,
    'merged: merged proposals on those apps and the platform itself');
  assert.match(sql, /LEFT JOIN apps s ON s\.slug = \$1 AND s\.self_hosted/,
    'a database with no self row still answers the counts');
});

test('served: the same two flags GET /api/apps/:slug applies, per viewer, never cached', async () => {
  // The client's menu reads this instead of probing the row: a probe that
  // 404s is a console error for every viewer the flag hides the row from.
  const apps = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'apps.js'), 'utf8');
  assert.match(apps, /appRow\.self_hosted && !req\.user\?\.isAdmin && !config\.selfAppPublicVoting/,
    'the rule this mirrors is still the row route\'s');
  reset();
  const server = await start({ selfAppSlug: 'usernode-2d5619', selfAppPublicVoting: false });
  try {
    currentUser = { id: 8, isAdmin: false };
    assert.equal((await get(server)).body.served, false, 'flag off, not an admin: not served');
    currentUser = { id: 9, isAdmin: true };
    assert.equal((await get(server)).body.served, true, 'an admin is, from the same cached copy');
    assert.equal(queries.length, 1, 'the per-viewer answer is added per request, not cached');
  } finally { server.close(); }
  reset();
  const open = await start({ selfAppSlug: 'usernode-2d5619', selfAppPublicVoting: true });
  try {
    currentUser = { id: 8, isAdmin: false };
    const { body } = await get(open);
    assert.equal(body.served, true, 'public voting on: everyone is served');
    assert.equal(body.selfAppSlug, 'usernode-2d5619');
  } finally { open.close(); }
});

test('the identity does not depend on the viewer being served the platform row', async () => {
  // SELF_APP_PUBLIC_VOTING off: a non-admin gets a 404 for the platform's
  // apps row, yet the platform they stand in still has a name, a tagline, a
  // repository and a version. This route never consults the visibility gate.
  reset();
  currentUser = { id: 8, isAdmin: false };
  const server = await start({ selfAppSlug: 'usernode-2d5619', selfAppPublicVoting: false });
  try {
    const { status, body } = await get(server);
    assert.equal(status, 200);
    assert.equal(body.name, 'Homeroom');
    assert.ok(body.repoUrl);
  } finally { server.close(); }
});

test('the version is the build answering, then the row\'s', () => {
  const base = { ...ROW };
  assert.equal(route.shapeAbout(base, { gitSha: '0123456789abcdef' }).version, '0123456');
  assert.equal(route.shapeAbout(base, { gitSha: 'dev' }).version, 'f8c45cc',
    'a staging build reports "dev", which is not a version');
  assert.equal(route.shapeAbout({ ...base, main_sha: null }, {}).version, null);
});

test('no self row, no description: sensible defaults rather than blanks', () => {
  const shaped = route.shapeAbout({ apps: 3, members: 0, merged: null },
    { config: { platformRepoUrl: 'https://github.com/example/fork' } });
  assert.equal(shaped.name, 'Homeroom');
  assert.equal(shaped.tagline, null, 'no sentence is better than an invented one');
  assert.equal(shaped.repoUrl, 'https://github.com/example/fork', 'a fork names its own repository');
  assert.deepEqual(shaped.stats, { apps: 3, members: 0, merged: 0 });
  assert.equal(route.shapeAbout({ ...ROW, description: 'x'.repeat(400) }).tagline.length, 160,
    'capped the way the launcher caps a manifest description');
});

test('one answer for everyone, cached for a minute', async () => {
  reset();
  const server = await start();
  try {
    await get(server);
    currentUser = { id: 99 };
    await get(server);
    assert.equal(queries.length, 1, 'the second viewer is served the cached copy');
    assert.equal(route.CACHE_TTL_MS, 60 * 1000);
  } finally { server.close(); }
});

test('an anonymous caller is refused; a failed query is a 500', async () => {
  reset();
  currentUser = null;
  let server = await start();
  try {
    assert.equal((await get(server)).status, 401);
  } finally { server.close(); }
  reset();
  fail = true;
  server = await start();
  try {
    assert.equal((await get(server)).status, 500);
  } finally { server.close(); }
});

test('staging ?demo=1 fills an empty merged count, and real counts win', async () => {
  reset();
  process.env.USERNODE_ENV = 'staging';
  row = { ...ROW, merged: 0 };
  let server = await start();
  try {
    const { body } = await get(server, '?demo=1');
    assert.equal(body.stats.merged, route.DEMO_MERGED);
    assert.equal(body.demo, true);
    const plain = await get(server);
    assert.equal(plain.body.stats.merged, 0, 'no ?demo=1, no overlay');
  } finally { server.close(); }
  reset();
  process.env.USERNODE_ENV = 'staging';
  server = await start();
  try {
    assert.equal((await get(server, '?demo=1')).body.stats.merged, 1204, 'a real count is never replaced');
  } finally { server.close(); }
  reset();
  row = { ...ROW, merged: 0 };
  server = await start();
  try {
    const { body } = await get(server, '?demo=1');
    assert.equal(body.stats.merged, 0, 'and production never injects');
    assert.equal(body.demo, undefined);
  } finally { server.close(); reset(); }
});

test('server.js mounts it behind authMiddleware', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const auth = src.indexOf('app.use(authMiddleware(config));');
  const mount = src.indexOf('app.use(platformAboutRoutes(config));');
  assert.ok(auth > 0 && mount > auth, 'mounted, and after the session middleware');
});
