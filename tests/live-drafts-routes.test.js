'use strict';

// The live drafts routes (src/routes/live-drafts.js): every one is the
// signed-in person's own and checks its input; a thread about Homeroom
// itself is never offered a draft; writes are refused unless the Homeroom
// page itself sent them; and each write hands the service (stood in for
// here, src/services/live-drafts.js has its own suite) the person and the
// thread or draft it names.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolModule = require('../src/db/pool');
const liveDrafts = require('../src/services/live-drafts');

test('the live drafts routes', async (t) => {
  const threads = new Map([[9, { slug: 'gym', self_hosted: false }], [10, { slug: 'usernode-self', self_hosted: false }], [11, { slug: 'plat', self_hosted: true }]]);
  const pool = {
    async query(sql, params) {
      if (/FROM private_threads pt JOIN apps a/.test(sql)) {
        const row = threads.get(Number(params[0]));
        return { rows: row && params[1] === 7 ? [row] : [] };
      }
      return { rows: [] };
    },
  };
  const realGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  const real = { ...liveDrafts };
  const calls = [];
  const draftRow = { id: 3, state: 'open', live_state: 'live', session_id: 5, root_message_id: 9, app_slug: 'gym', app_name: 'Gym', edits: 1 };
  Object.assign(liveDrafts, {
    forThread: async ({}, { userId, rootId }) => (userId === 7 && rootId === 9 ? draftRow : null),
    enabled: async () => true,
    open: async (_p, _c, args) => { calls.push(['open', args.user.id, args.rootId]); return { status: 200, body: { ok: true } }; },
    propose: async (_p, _c, args) => { calls.push(['propose', args.user.id, args.draftId, args.title]); return { status: 200, body: { ok: true } }; },
    close: async (_p, args) => { calls.push(['close', args.user.id, args.draftId]); return { status: 200, body: { ok: true } }; },
    byId: async (_p, id, { userId } = {}) => (Number(id) === 3 && (!userId || userId === 7) ? draftRow : null),
    syncPreview: async () => { calls.push(['sync']); return { ok: true, synced: true }; },
  });
  const { liveDraftRoutes } = require('../src/routes/live-drafts');
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) req.user = { id: Number(req.headers['x-test-user']), username: 'evan' };
    next();
  });
  app.use(liveDraftRoutes({ selfAppSlug: 'usernode-self' }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => {
    server.close();
    poolModule.getPool = realGetPool;
    Object.assign(liveDrafts, real);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { user = 7, site = 'same-origin', body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      ...(user ? { 'x-test-user': String(user) } : {}),
      ...(site ? { 'sec-fetch-site': site } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  await t.test('reads: signed in, a thread named, and Homeroom itself never offered', async () => {
    assert.equal((await call('GET', '/api/live-drafts?rootId=9', { user: null })).status, 401);
    assert.equal((await call('GET', '/api/live-drafts')).status, 400);
    const mine = await (await call('GET', '/api/live-drafts?rootId=9')).json();
    assert.deepEqual([mine.enabled, mine.draft.id, mine.draft.live], [true, 3, 'live']);
    assert.equal((await (await call('GET', '/api/live-drafts?rootId=10')).json()).enabled, false, 'the platform by its slug');
    assert.equal((await (await call('GET', '/api/live-drafts?rootId=11')).json()).enabled, false, 'a self-hosted app');
    const other = await (await call('GET', '/api/live-drafts?rootId=9', { user: 8 })).json();
    assert.deepEqual([other.enabled, other.draft], [false, null], 'someone else\'s thread');
  });

  await t.test('writes: only from the Homeroom page, with the person and what they name', async () => {
    assert.equal((await call('POST', '/api/live-drafts', { site: 'cross-site', body: { rootId: 9 } })).status, 403);
    assert.equal((await call('POST', '/api/live-drafts', { body: {} })).status, 400);
    assert.equal((await call('POST', '/api/live-drafts', { body: { rootId: 9 } })).status, 200);
    assert.equal((await call('POST', '/api/live-drafts/3/propose', { body: { title: 'Bigger button' } })).status, 200);
    assert.equal((await call('POST', '/api/live-drafts/3/close')).status, 200);
    assert.equal((await call('POST', '/api/live-drafts/x/close')).status, 404);
    const preview = await (await call('POST', '/api/live-drafts/3/preview')).json();
    assert.deepEqual([preview.ok, preview.synced], [true, true]);
    assert.equal((await call('POST', '/api/live-drafts/3/preview', { user: 8 })).status, 404, 'not theirs');
    assert.deepEqual(calls, [['open', 7, 9], ['propose', 7, 3, 'Bigger button'], ['close', 7, 3], ['sync']]);
  });
});
