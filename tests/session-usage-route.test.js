'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const poolMod = require('../src/db/pool');
let captured = [], fail = false;
poolMod.getPool = () => ({ query: async (sql, params) => {
  captured.push({ sql, params });
  if (/collab_visibility/.test(sql)) return { rows: [{
    id: 42, slug: 'demo', created_by: 99, self_hosted: false,
    collab_visibility: 'public', view_visibility: 'public',
  }] };
  if (/AS chat_cents/.test(sql)) {
    if (fail) throw new Error('private database detail');
    return { rows: params[0] === 51 && params[1] === 99 ? [{
      chat_cents: '10', agent_cost_cents: '50', openrouter_cents: '5.5', unpriced_turns: '0',
    }] : [] };
  }
  return { rows: [] };
} });
const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

async function request(user, id = '51') {
  captured = [];
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(sessionRoutes({}));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${id}/usage`);
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
  } finally { server.close(); }
}

test('owner sees only the aggregate and reading it performs no writes', async () => {
  const r = await request({ id: 99 });
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'private, no-store');
  assert.equal(r.body.usage.totalCents, 65.5);
  assert.deepEqual(Object.keys(r.body), ['usage']);
  assert.ok(captured.every(q => /^\s*SELECT/.test(q.sql)));
  assert.deepEqual(captured.find(q => /AS chat_cents/.test(q.sql)).params, [51, 99]);
});

test('another member, even an admin, cannot read a session owner’s private usage', async () => {
  for (const user of [{ id: 7 }, { id: 7, isAdmin: true, canAdminWrite: true }]) {
    const r = await request(user);
    assert.equal(r.status, 404);
    assert.equal(r.body.usage, undefined);
  }
});

test('anonymous caller is refused', async () => {
  const r = await request(null);
  assert.equal(r.status, 401);
  assert.equal(captured.some(q => /AS chat_cents/.test(q.sql)), false);
});

test('invalid IDs do not reach the usage query', async () => {
  for (const id of ['0', '51x', '01', '2147483648']) {
    const r = await request({ id: 99 }, id);
    assert.equal(r.status, 404);
    assert.equal(captured.some(q => /AS chat_cents/.test(q.sql)), false);
  }
});

test('database failure is recoverable and does not expose internal details', async () => {
  fail = true;
  try {
    const r = await request({ id: 99 });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'Could not load session usage');
  } finally { fail = false; }
});
