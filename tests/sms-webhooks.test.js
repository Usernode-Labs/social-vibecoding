'use strict';

// Brevo's SMS webhook: the token gate, STOP/unsubscribe opt-outs and
// delivery receipts (src/routes/sms-webhooks.js).
//
// Run with: node --test tests/sms-webhooks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const queries = [];
const optedOut = [];
stub(require.resolve('../src/services/logger'), { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(require.resolve('../src/services/sms'), {
  recordOptOut: async (_pool, phone, source) => { optedOut.push({ phone, source }); },
});
stub(require.resolve('../src/db/pool'), {
  getPool: () => ({
    query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  }),
});

const { smsWebhookRoutes } = require('../src/routes/sms-webhooks');

const TOKEN = 'webhook-token';

async function start(config) {
  const app = express();
  app.use(smsWebhookRoutes(config));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

async function post(server, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sms/webhooks/brevo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test.afterEach(() => { queries.length = 0; optedOut.length = 0; });

test('no configured token answers 404', async () => {
  const server = await start({ brevoSmsWebhookToken: '' });
  try {
    const res = await post(server, { event: 'unsubscribe', phone: '+33680065433' });
    assert.equal(res.status, 404);
    assert.equal(optedOut.length, 0);
  } finally { server.close(); }
});

test('a missing or wrong Bearer token answers 401', async () => {
  const server = await start({ brevoSmsWebhookToken: TOKEN });
  try {
    assert.equal((await post(server, { event: 'unsubscribe', phone: '+33680065433' })).status, 401);
    assert.equal((await post(server, { event: 'unsubscribe' }, { Authorization: 'Bearer nope' })).status, 401);
    assert.equal(optedOut.length, 0);
  } finally { server.close(); }
});

test('a STOP reply and an unsubscribe event both record an opt-out', async () => {
  const server = await start({ brevoSmsWebhookToken: TOKEN });
  try {
    const stop = await post(server, { event: 'reply', phone: '+33680065433', text: ' stop ' }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(stop.status, 200);
    const unsubscribe = await post(server, { event: 'unsubscribed', phone: '+447700900123' }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(unsubscribe.status, 200);
    assert.deepEqual(optedOut, [
      { phone: '+33680065433', source: 'brevo_webhook' },
      { phone: '+447700900123', source: 'brevo_webhook' },
    ]);
  } finally { server.close(); }
});

test('another reply is ignored', async () => {
  const server = await start({ brevoSmsWebhookToken: TOKEN });
  try {
    const res = await post(server, { event: 'reply', phone: '+33680065433', text: 'hello' }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200);
    assert.equal(optedOut.length, 0);
  } finally { server.close(); }
});

test('a delivery receipt updates the matching row', async () => {
  const server = await start({ brevoSmsWebhookToken: TOKEN });
  try {
    const res = await post(server, { event: 'delivered', messageId: 'm-9', status: 'delivered' }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /UPDATE sms_deliveries/);
    assert.deepEqual(queries[0].params, ['m-9', 'delivered']);
  } finally { server.close(); }
});
