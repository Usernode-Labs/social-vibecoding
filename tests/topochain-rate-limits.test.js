// Per-principal rate limits on the credentialed topochain surface (#2526,
// reported by snait): the seven heavy mobile reads and their five
// session-cookie /challenges-api twins share one per-user bucket, the
// zkPassport completion has its own, and the partner point-award carries a
// per-key ceiling plus the per-participant ceiling that actually bounds
// point inflation.
//
// Same harness as tests/rate-limits.test.js, and for the same reasons: the
// limiters are module singletons with shared in-memory buckets, so every
// test uses its own principal, and they are exercised over real HTTP on an
// ephemeral port because skipFailedRequests refunds on response-finish,
// which stubbed req/res objects never emit.
//
// Run with: node --test tests/topochain-rate-limits.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  topochainMobileReadLimiter,
  topochainChallengeCompletionLimiter,
  topochainPartnerActivityLimiter,
  topochainPartnerActivityTargetLimiter,
} = require('../src/middleware/rate-limits');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());

  // Stand-in for mobileTokenAuth: the limiter is mounted AFTER the auth
  // middleware on the real routes, so req.user is already populated when
  // the key is computed. Identity comes from a header so each test can
  // isolate itself with a fresh user id.
  const asUser = (req, _res, next) => {
    req.user = { id: req.headers['x-user-id'] || 'anon', isAdmin: false };
    next();
  };

  // The /api/v4/mobile read surface and its /challenges-api twin, both
  // behind the SAME limiter instance — that sharing is the point.
  app.get('/mobile-read', asUser, topochainMobileReadLimiter, (_req, res) => res.json({ success: true }));
  app.get('/web-read', asUser, topochainMobileReadLimiter, (_req, res) => res.json({ success: true }));

  // POST /api/v4/mobile/zkpassport/complete. ?fail=1 stands in for a
  // route-level rejection (a disabled challenge, an unverified proof).
  app.post('/completion', asUser, topochainChallengeCompletionLimiter, (req, res) => {
    if (req.query.fail === '1') return res.status(422).json({ success: false, error: 'nope' });
    return res.status(201).json({ success: true });
  });

  // POST /api/v4/user-activities, both buckets in their mounted order.
  app.post(
    '/user-activities',
    topochainPartnerActivityLimiter,
    topochainPartnerActivityTargetLimiter,
    (req, res) => {
      if (req.query.fail === '1') return res.status(422).json({ success: false, error: 'nope' });
      return res.status(201).json({ success: true });
    }
  );

  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server?.close(); });

async function get(path, { user } = {}) {
  const resp = await fetch(base + path, { headers: { 'x-user-id': user } });
  return { status: resp.status, resp, body: await resp.json().catch(() => ({})) };
}

async function post(path, { user, key, body = {} } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-user-id'] = user;
  if (key) headers['x-api-key'] = key;
  const resp = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: resp.status, resp, body: await resp.json().catch(() => ({})) };
}

// A distinct participant per test, so the per-target buckets never collide.
function award(overrides = {}) {
  return {
    participant_identifier: 'alice@example.com',
    identifier_type: 'email',
    season_event_id: 100,
    challenge_id: 500,
    activity_type: 'onchain_tx',
    points: '10.50',
    activity_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── The mobile read bucket ─────────────────────────────────────────────

test('mobile reads: 120 per minute per user, then 429', async () => {
  const user = 'read-ceiling-user';
  for (let i = 0; i < 120; i++) {
    const r = await get('/mobile-read', { user });
    assert.equal(r.status, 200, `read #${i + 1} should pass`);
  }
  const blocked = await get('/mobile-read', { user });
  assert.equal(blocked.status, 429);
});

test('mobile reads: a second user is unaffected by the first exhausting the bucket', async () => {
  const other = 'read-neighbour-user';
  const r = await get('/mobile-read', { user: other });
  assert.equal(r.status, 200);
});

test('mobile reads: the /challenges-api twin shares ONE bucket with the bearer surface', async () => {
  const user = 'shared-budget-user';
  // Spend the whole budget through the web twin...
  for (let i = 0; i < 120; i++) {
    const r = await get('/web-read', { user });
    assert.equal(r.status, 200, `web read #${i + 1} should pass`);
  }
  // ...and the bearer surface is out of budget too, rather than getting a
  // second unthrottled path to the same handlers.
  const blocked = await get('/mobile-read', { user });
  assert.equal(blocked.status, 429);
});

// ─── The completion bucket ──────────────────────────────────────────────

test('completions: own bucket at 10/minute, not drained by reads', async () => {
  const user = 'completion-user';
  // Exhaust the read bucket first — it must not touch the completion one.
  for (let i = 0; i < 120; i++) {
    const r = await get('/mobile-read', { user });
    assert.equal(r.status, 200, `read #${i + 1} should pass`);
  }
  assert.equal((await get('/mobile-read', { user })).status, 429);

  for (let i = 0; i < 10; i++) {
    const r = await post('/completion', { user });
    assert.equal(r.status, 201, `completion #${i + 1} should pass`);
  }
  const blocked = await post('/completion', { user });
  assert.equal(blocked.status, 429);
});

test('completions: failures are NOT refunded (a bridge round-trip still cost something)', async () => {
  const user = 'completion-failure-user';
  for (let i = 0; i < 10; i++) {
    const r = await post('/completion?fail=1', { user });
    assert.equal(r.status, 422, `failed completion #${i + 1} should reach the route`);
  }
  const blocked = await post('/completion', { user });
  assert.equal(blocked.status, 429);
});

// ─── The partner target bucket ──────────────────────────────────────────

test('partner awards: 20/hour per participant+event, then 429', async () => {
  const key = 'target-ceiling-key';
  const body = award({ participant_identifier: 'target-ceiling@example.com' });
  for (let i = 0; i < 20; i++) {
    const r = await post('/user-activities', { key, body });
    assert.equal(r.status, 201, `award #${i + 1} should pass`);
  }
  const blocked = await post('/user-activities', { key, body });
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /this participant/i);

  // A different event for the same participant is its own bucket...
  const otherEvent = await post('/user-activities', {
    key, body: award({ participant_identifier: 'target-ceiling@example.com', season_event_id: 101 }),
  });
  assert.equal(otherEvent.status, 201);

  // ...and so is a different participant in the same event.
  const otherParticipant = await post('/user-activities', {
    key, body: award({ participant_identifier: 'target-ceiling-2@example.com' }),
  });
  assert.equal(otherParticipant.status, 201);
});

test('partner awards: the identifier is normalized, so casing is not a bypass', async () => {
  const key = 'normalize-key';
  for (let i = 0; i < 20; i++) {
    const r = await post('/user-activities', {
      key, body: award({ participant_identifier: 'Normalize-Me@Example.com' }),
    });
    assert.equal(r.status, 201, `award #${i + 1} should pass`);
  }
  const blocked = await post('/user-activities', {
    key, body: award({ participant_identifier: '  normalize-me@example.com  ' }),
  });
  assert.equal(blocked.status, 429);
});

test('partner awards: rejected submissions are refunded, so a real participant keeps their budget', async () => {
  const key = 'refund-key';
  const body = award({ participant_identifier: 'refund@example.com' });
  for (let i = 0; i < 20; i++) {
    const r = await post('/user-activities?fail=1', { key, body });
    assert.equal(r.status, 422, `rejected award #${i + 1} should reach the route`);
  }
  const accepted = await post('/user-activities', { key, body });
  assert.equal(accepted.status, 201);
});

test('partner awards: a body with no resolvable target falls through instead of erroring', async () => {
  const r = await post('/user-activities', { key: 'fallthrough-key', body: { points: 1 } });
  assert.equal(r.status, 201);
});

// ─── The partner client ceiling ─────────────────────────────────────────

test('partner awards: the per-key ceiling is its own bucket at 300/minute', async () => {
  const key = 'client-ceiling-key';
  // Spread across 300 distinct participants so the per-target bucket (20)
  // never fires and the 301st refusal can only be the client ceiling.
  for (let i = 0; i < 300; i++) {
    const r = await post('/user-activities', {
      key, body: award({ participant_identifier: `client-ceiling-${i}@example.com` }),
    });
    assert.equal(r.status, 201, `award #${i + 1} should pass`);
  }
  const blocked = await post('/user-activities', {
    key, body: award({ participant_identifier: 'client-ceiling-overflow@example.com' }),
  });
  assert.equal(blocked.status, 429);
  assert.doesNotMatch(blocked.body.error, /this participant/i);

  // A different key is a different bucket.
  const otherKey = await post('/user-activities', {
    key: 'client-ceiling-other-key',
    body: award({ participant_identifier: 'client-ceiling-other@example.com' }),
  });
  assert.equal(otherKey.status, 201);
});

// ─── The 429 contract ───────────────────────────────────────────────────

test('429s on the v4 surface carry the v4 error envelope and a Retry-After header', async () => {
  const user = 'envelope-user';
  for (let i = 0; i < 10; i++) {
    assert.equal((await post('/completion', { user })).status, 201);
  }
  const blocked = await post('/completion', { user });

  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.success, false);
  assert.equal(typeof blocked.body.error, 'string');
  assert.ok(blocked.body.error.length > 0);
  assert.equal(blocked.body.code, 'rate_limited');
  assert.equal(typeof blocked.body.retryAfterSeconds, 'number');
  assert.ok(blocked.body.retryAfterSeconds > 0);

  const retryAfter = blocked.resp.headers.get('retry-after');
  assert.ok(Number.isInteger(Number(retryAfter)), `Retry-After should be an integer, got ${retryAfter}`);
  assert.equal(Number(retryAfter), blocked.body.retryAfterSeconds);

  // The message states the retry window rather than just refusing.
  assert.match(blocked.body.error, /try again/i);
  // No em dashes in anything a user or a partner integration reads.
  assert.doesNotMatch(blocked.body.error, /—/);
});
