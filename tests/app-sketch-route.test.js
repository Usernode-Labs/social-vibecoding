'use strict';

// GET /api/apps/:slug/sketch and /sketch.html (src/routes/apps.js): the made
// screen's status poll and the framed page. Pinned: view access with a 404
// on deny, a stale pending row read as failed, and the page served only
// when ready, with the sandbox CSP, nosniff and no-store.
//
// Same harness as tests/app-contributors-route.test.js.
//
// Run with: node --test tests/app-sketch-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(require.resolve('../src/services/app-creator'), { createApp: async () => {} });
stub(require.resolve('../src/services/app-forker'), { forkApp: async () => {} });
stub(require.resolve('../src/services/caddy'), { productionHostname: (slug) => `${slug}.example.test` });
stub(require.resolve('../src/services/docker'), { getHostPort: async () => null });
stub(require.resolve('../src/services/github'), { parseGithubUrl: () => null, isEnabled: () => false });
stub(require.resolve('../src/services/main-drift-poller'), { checkAndRedeployOne: async () => ({}) });
stub(require.resolve('../src/services/app-secrets'), {});
stub(require.resolve('../src/services/app-manifest'), { MAX_APP_NAME_LENGTH: 64 });
stub(require.resolve('../src/services/rename-pr'), {});
stub(require.resolve('../src/services/staging'), { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });

const appSketch = require('../src/services/app-sketch');

const poolMod = require('../src/db/pool');
let appRow = null;
let sketchRow = null;
poolMod.getPool = () => ({
  query: async (sql) => {
    const s = String(sql);
    if (/FROM apps WHERE slug = \$1/.test(s)) return { rows: appRow ? [appRow] : [] };
    if (/FROM app_sketches WHERE app_id = \$1/.test(s)) return { rows: sketchRow ? [sketchRow] : [] };
    return { rows: [], rowCount: 0 };
  },
});

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

let currentUser = { id: 5, isAdmin: false };

async function withServer(fn) {
  const app = express();
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn((p) => fetch(`http://127.0.0.1:${server.address().port}${p}`));
  } finally {
    server.close();
  }
}

const DESIGN = appSketch.normalizeDesign({ job: 'Log runs', primaryAction: 'Log a run', accentName: 'red', accent: { light: '#c2410c', dark: '#fb923c' } });
const HTML = '<header><h1 class="text-title">Run Club</h1><p class="text-body text-muted">Twelve of us, every Sunday.</p></header>';

function reset() {
  appRow = { id: 7, name: 'Run Club', slug: 'run-club', created_by: 5, self_hosted: false, collab_visibility: 'public', view_visibility: 'public' };
  sketchRow = null;
  currentUser = { id: 5, isAdmin: false };
}

test('the status: none, pending, ready with its words, and a stale pending row as failed', async () => {
  reset();
  await withServer(async (get) => {
    let res = await get('/api/apps/run-club/sketch');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'none' });
    assert.equal(res.headers.get('cache-control'), 'no-store');

    sketchRow = { app_id: 7, status: 'pending', created_at: new Date().toISOString() };
    assert.deepEqual(await (await get('/api/apps/run-club/sketch')).json(), { status: 'pending' });

    sketchRow = { app_id: 7, status: 'pending', created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    assert.deepEqual(await (await get('/api/apps/run-club/sketch')).json(), { status: 'failed' });

    sketchRow = { app_id: 7, status: 'ready', design: DESIGN, html: HTML, created_at: new Date().toISOString(), committed_at: null };
    assert.deepEqual(await (await get('/api/apps/run-club/sketch')).json(), {
      status: 'ready', job: 'Log runs', primaryAction: 'Log a run', accentName: 'red', committed: false,
    });
  });
});

test('the page: served sandboxed when ready, 404 otherwise, and never past the view check', async () => {
  reset();
  await withServer(async (get) => {
    assert.equal((await get('/api/apps/run-club/sketch.html')).status, 404, 'no sketch');
    sketchRow = { app_id: 7, status: 'pending', created_at: new Date().toISOString() };
    assert.equal((await get('/api/apps/run-club/sketch.html')).status, 404, 'not yet');

    sketchRow = { app_id: 7, status: 'ready', design: DESIGN, html: HTML, created_at: new Date().toISOString() };
    const res = await get('/api/apps/run-club/sketch.html?theme=dark');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.equal(res.headers.get('content-security-policy'), appSketch.SKETCH_CSP);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.text();
    assert.match(body, /<title>Run Club: a sketch<\/title>/);
    assert.match(body, /<main class="sketch-screen">\s*<header><h1 class="text-title">Run Club<\/h1>/);
    assert.match(body, /:root\{--ground:12 10 9;/, 'the dark look, pinned');

    // A private project the viewer cannot see: 404 for both, nothing enumerable.
    appRow = { ...appRow, created_by: 99, view_visibility: 'private', collab_visibility: 'private' };
    assert.equal((await get('/api/apps/run-club/sketch')).status, 404);
    assert.equal((await get('/api/apps/run-club/sketch.html')).status, 404);
    appRow = null;
    assert.equal((await get('/api/apps/run-club/sketch')).status, 404);
  });
});
