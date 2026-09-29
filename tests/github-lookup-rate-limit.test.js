'use strict';

// #2519: the two GitHub lookup endpoints had no limiter at all.
//
//   GET /api/github/repo-info      (public repo name/description)
//   GET /api/github/verify-access  (bot access pre-flight)
//
// Neither spends the CALLER's GitHub quota. Every request is an outbound
// call on the platform's shared bot installation, whose rate limit is per
// installation — so one signed-in account looping either endpoint drains
// the budget that repo import, PR sync and check reporting all draw from,
// for every app on the platform. `verify-access` is the worse of the two:
// before answering it accepts any pending bot invitation for the repo, so
// an unbounded caller drives that side effect too.
//
// 30/hour/user. `verify-access` is the import modal's "Check access"
// BUTTON — clicked a handful of times while setting one app up, with
// nothing debounced into it — and `repo-info` has no caller left in the
// product at all, so the honest ceiling is nowhere near 30.
//
// The one deliberate difference from the write limiters in this repo: NO
// skipFailedRequests. There, a rejected request never reached the cost
// being bounded, so refunding it was right. Here a 404 from GitHub has
// ALREADY spent the quota — refunding failures would refund exactly the
// requests this limiter exists to bound, and a loop over nonexistent
// repos would run free.
//
// Behaviour over real HTTP, like tests/rate-limits.test.js: refunds happen
// on response-finish, which stubbed req/res never emit. The limiter is a
// module singleton with one shared in-memory bucket, so each test uses its
// own user id.
//
// Run with: node --test tests/github-lookup-rate-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { githubLookupLimiter } = require('../src/middleware/rate-limits');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      id: req.headers['x-user-id'] || 'anon',
      isAdmin: req.headers['x-is-admin'] === '1',
      canAdminWrite: req.headers['x-can-admin-write'] === '1',
    };
    next();
  });
  // Both real routes, and `?fail=1` standing in for the refusals they
  // actually return: an unparseable URL (400), a repo the bot cannot see
  // (404), the platform's own repo (409).
  const handler = (req, res) => {
    if (req.query.fail === '1') return res.status(404).json({ error: 'Repo not found or private' });
    res.json({ ok: true });
  };
  app.get('/api/github/repo-info', githubLookupLimiter, handler);
  app.get('/api/github/verify-access', githubLookupLimiter, handler);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server?.close(); });

async function lookup(p, user, headers = {}) {
  const resp = await fetch(base + p, {
    headers: { 'x-user-id': user, ...headers },
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

test('setting apps up all afternoon is never throttled', async () => {
  for (let i = 0; i < 30; i++) {
    const r = await lookup('/api/github/verify-access', 'u-honest');
    assert.equal(r.status, 200, `check ${i + 1} of 30 should pass`);
  }
});

test('the 31st lookup in an hour is refused', async () => {
  for (let i = 0; i < 30; i++) await lookup('/api/github/verify-access', 'u-looper');
  const over = await lookup('/api/github/verify-access', 'u-looper');
  assert.equal(over.status, 429);
  assert.match(over.body.error, /Too many repository lookups/);
  assert.ok(Number.isInteger(over.body.retryAfterSeconds));
  // #463: throttles carry no `code`, which is how clients tell them from
  // billing 429s.
  assert.equal('code' in over.body, false);
});

test('the two endpoints share one bucket', async () => {
  for (let i = 0; i < 30; i++) await lookup('/api/github/verify-access', 'u-shared');
  const other = await lookup('/api/github/repo-info', 'u-shared');
  assert.equal(other.status, 429,
    'one installation quota behind both, so one budget in front of both');
});

test('one user draining the quota does not throttle anybody else', async () => {
  for (let i = 0; i < 31; i++) await lookup('/api/github/repo-info', 'u-noisy');
  const bystander = await lookup('/api/github/repo-info', 'u-quiet');
  assert.equal(bystander.status, 200, 'keyed per user, not per address');
});

// The inverse of tests/governance-vote-rate-limit.test.js's refund test,
// and the reason this limiter is written differently. A lookup that ends
// in a 404 has already made the outbound call.
test('a failed lookup still costs budget', async () => {
  for (let i = 0; i < 30; i++) {
    const r = await lookup('/api/github/repo-info?fail=1', 'u-scanner');
    assert.equal(r.status, 404, `attempt ${i + 1} should be the route's 404`);
  }
  const over = await lookup('/api/github/repo-info?fail=1', 'u-scanner');
  assert.equal(over.status, 429,
    'a sweep over repos that do not exist burns the same quota as one that does');
});

// No exemptAdmins: the budget being protected is the platform's own, and
// an admin's loop drains it exactly as fast as anybody else's.
test('full admins are limited too', async () => {
  const headers = { 'x-is-admin': '1', 'x-can-admin-write': '1' };
  for (let i = 0; i < 30; i++) await lookup('/api/github/repo-info', 'u-admin', headers);
  const over = await lookup('/api/github/repo-info', 'u-admin', headers);
  assert.equal(over.status, 429);
});

test('both routes actually mount the limiter', () => {
  const src = read('src/routes/apps.js');
  assert.match(src, /router\.get\('\/api\/github\/repo-info', githubLookupLimiter,/);
  assert.match(src, /router\.get\('\/api\/github\/verify-access', githubLookupLimiter,/);
});
