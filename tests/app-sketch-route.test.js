'use strict';

// GET /api/apps/:slug/sketch (src/routes/apps.js): the made screen's poll for
// the first session's card. Pinned: view access with a 404 on deny, a stale
// pending row read as failed, the card's words once it is ready (a screen
// mock from before the card reads as none), no-store, the maker's first
// artefact noted the first time it is there to draw, and no framed page.
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

const poolMod = require('../src/db/pool');
let appRow = null;
let sketchRow = null;
const artefacts = [];
poolMod.getPool = () => ({
  query: async (sql, params) => {
    const s = String(sql);
    if (/INSERT INTO events/.test(s) && /first_artefact_shown|\$3::text/.test(s)) { artefacts.push(params.slice(0, 2)); return { rows: [] }; }
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

const CARD = { kind: 'card', emoji: '🏃', tagline: 'Weekly miles for the club', points: ['Log each run', 'See who is keeping up'], source: 'model' };

function reset() {
  appRow = { id: 7, name: 'Run Club', slug: 'run-club', created_by: 5, self_hosted: false, collab_visibility: 'public', view_visibility: 'public' };
  sketchRow = null;
  currentUser = { id: 5, isAdmin: false };
  artefacts.length = 0;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the status: none, pending, the card when ready, and a stale pending row as failed', async () => {
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

    sketchRow = { app_id: 7, status: 'ready', design: CARD, html: null, created_at: new Date().toISOString(), committed_at: null };
    assert.deepEqual(await (await get('/api/apps/run-club/sketch')).json(), {
      status: 'ready',
      card: { emoji: '🏃', tagline: 'Weekly miles for the club', points: ['Log each run', 'See who is keeping up'] },
      committed: false,
    });

    // A screen mock from before the card is not shown.
    sketchRow = { app_id: 7, status: 'ready', design: { job: 'Log runs' }, html: '<h1>Run Club</h1>', created_at: new Date().toISOString() };
    assert.deepEqual(await (await get('/api/apps/run-club/sketch')).json(), { status: 'none' });
  });
});

test('the card is the maker\'s first artefact the first time it is there to draw', async () => {
  reset();
  await withServer(async (get) => {
    sketchRow = { app_id: 7, status: 'pending', created_at: new Date().toISOString() };
    await get('/api/apps/run-club/sketch');
    await settle();
    assert.deepEqual(artefacts, [], 'not while it is being made');
    sketchRow = { app_id: 7, status: 'ready', design: CARD, created_at: new Date().toISOString() };
    await get('/api/apps/run-club/sketch');
    await settle();
    assert.deepEqual(artefacts, [[7, 5]]);
  });
});

test('no framed page, and never past the view check', async () => {
  reset();
  await withServer(async (get) => {
    sketchRow = { app_id: 7, status: 'ready', design: CARD, created_at: new Date().toISOString() };
    assert.equal((await get('/api/apps/run-club/sketch.html')).status, 404, 'the card is drawn by the made screen');
    // A private project the viewer cannot see: 404, nothing enumerable.
    appRow = { ...appRow, created_by: 99, view_visibility: 'private', collab_visibility: 'private' };
    assert.equal((await get('/api/apps/run-club/sketch')).status, 404);
    appRow = null;
    assert.equal((await get('/api/apps/run-club/sketch')).status, 404);
  });
});
