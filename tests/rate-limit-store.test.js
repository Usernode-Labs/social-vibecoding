'use strict';

// A shared limiter (services/rate-limit-store.js) while its database cannot
// answer: the request goes through rather than a 500, and the refund a
// success asks for (skipSuccessfulRequests), from a promise nobody awaits,
// never rejects: an unhandled rejection ends the process.
// tests/rate-limit-store-postgres.test.js counts against the real table.
//
// Run with: node --test tests/rate-limit-store.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('a shared limiter whose database fails lets the request through and never rejects a refund', async (t) => {
  const store = require('../src/services/rate-limit-store');
  const queries = [];
  store.setPool({ query: async (sql) => { queries.push(sql); throw new Error('the database went away'); } });
  t.after(() => store.setPool(null));
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  // express-rate-limit logs the store's error through console.error.
  t.mock.method(console, 'error', () => {});

  const { otpVerifyLimiter } = require('../src/middleware/rate-limits');
  const app = express();
  app.post('/verify', otpVerifyLimiter, (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/verify`, { method: 'POST' });
  assert.equal(res.status, 200, 'not a 500 while the count cannot be read');
  assert.ok(queries.some((q) => /INSERT INTO rate_limit_hits/.test(q)), 'the shared count was asked');

  // The refund: asked after the response, unawaited.
  await assert.doesNotReject(new store.SharedStore('otp-verify').decrement('k'));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(unhandled, []);
});
