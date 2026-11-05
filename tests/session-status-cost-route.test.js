'use strict';

// GET /api/sessions/:id/status answers what a change cost (`costTotalCents`,
// #3249) only to the change's author and admins, the rule GET
// /api/sessions/:id applies to the same figure for the dev chat meter. Anyone
// else who may view the session (a shared one underway, a proposal up for a
// vote) still gets the status, with the field absent rather than zero, and the
// cost is never read for them.
//
// Harness follows tests/session-stop-route.test.js: override getPool BEFORE
// requiring the route module, mount the real router, inject req.user.
//
// Run with: node --test tests/session-status-cost-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push(String(sql));
    return poolQueryHandler(String(sql), params);
  },
});

const sessionBus = require('../src/services/session-bus');
// Its streams kept in this process: no database here (services/session-bus.js).
sessionBus.init({ memory: true });

const { sessionRoutes } = require('../src/routes/sessions');

const AUTHOR = { id: 7, username: 'alice' };
const STRANGER = { id: 55, username: 'mallory' };
const VIEW_ADMIN = { id: 98, username: 'auditor', isAdmin: true, canAdminWrite: false };
const SESSION_ID = 4242;
const SHARED_AT = '2026-11-01T00:00:00.000Z';

const isCostRead = (sql) => /SUM\(m\.cost_cents\)/.test(sql);

async function statusAs(viewer, { status = 'active', sharedAt = null, costFails = false } = {}) {
  capturedQueries = [];
  poolQueryHandler = async (sql) => {
    if (/SELECT user_id, status, shared_at FROM chat_sessions/.test(sql)) {
      return { rows: [{ user_id: AUTHOR.id, status, shared_at: sharedAt }] };
    }
    if (isCostRead(sql)) {
      if (costFails) throw new Error('cost read failed');
      return { rows: [{ cents: '412.5' }] };
    }
    return { rows: [] };
  };
  const app = express();
  app.use((req, _res, next) => { req.user = viewer; next(); });
  app.use(sessionRoutes({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${SESSION_ID}/status`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

test('the author reads the cost on every state of the change', async () => {
  for (const state of [
    { status: 'active' },
    { status: 'active', sharedAt: SHARED_AT },
    { status: 'promoted' },
    { status: 'merged' },
  ]) {
    const res = await statusAs(AUTHOR, state);
    assert.equal(res.status, 200);
    assert.equal(res.body.costTotalCents, 412.5, JSON.stringify(state));
  }
});

test('an admin reads the cost, a view-only one included', async () => {
  const res = await statusAs(VIEW_ADMIN, { status: 'active' });
  assert.equal(res.status, 200);
  assert.equal(res.body.costTotalCents, 412.5);
});

test('anyone else who may view the session gets the status without the field', async () => {
  for (const state of [
    { status: 'active', sharedAt: SHARED_AT },
    { status: 'paused', sharedAt: SHARED_AT },
    { status: 'promoted' },
    { status: 'merging' },
    { status: 'merged' },
  ]) {
    const res = await statusAs(STRANGER, state);
    assert.equal(res.status, 200, JSON.stringify(state));
    assert.equal(Object.hasOwn(res.body, 'costTotalCents'), false, JSON.stringify(state));
    assert.equal(res.body.busy, false, 'the rest of the status still answers');
    assert.equal(capturedQueries.some(isCostRead), false, 'the cost is not read for them');
  }
});

test('a non-author who may not view the session still gets the 404', async () => {
  const res = await statusAs(STRANGER, { status: 'active' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Session not found' });
});

test('a failed read answers the author null, so the meter keeps its figure', async () => {
  const res = await statusAs(AUTHOR, { status: 'active', costFails: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.costTotalCents, null);
  assert.equal(Object.hasOwn(res.body, 'costTotalCents'), true);
});
