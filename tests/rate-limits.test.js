// Behaviour tests for the write-route rate limiters (#522 follow-up):
// close proposals draw from their own bucket instead of the shared
// issue-create one, failed requests are refunded, full admins are exempt
// (view-only admins are not), and the 429 body carries retryAfterSeconds
// plus a message that states the limit — with no `code` field, which
// budget-exceeded-code.test.js separately asserts at the source level.
//
// The limiters are exercised over real HTTP (express app on an ephemeral
// port) because skipFailedRequests refunds on response-finish, which
// stubbed req/res objects don't emit. They are module singletons with
// shared in-memory buckets, so every test uses its own user id.
//
// Run with: node --test tests/rate-limits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const {
  issueKindLimiter,
  groupChatWriteLimiter,
  appChatReadLimiter,
  appChatLoadLimiter,
} = require('../src/middleware/rate-limits');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for authMiddleware: identity comes from headers so each
  // test can isolate itself with a fresh user id.
  app.use((req, res, next) => {
    req.user = {
      id: req.headers['x-user-id'] || 'anon',
      isAdmin: req.headers['x-is-admin'] === '1',
      canAdminWrite: req.headers['x-can-admin-write'] === '1',
    };
    next();
  });
  // Mirrors POST /api/apps/:slug/issues — the kind-dispatching limiter
  // in front, with ?fail=1 standing in for a route-level rejection.
  app.post('/issues', issueKindLimiter, (req, res) => {
    if (req.query.fail === '1') return res.status(422).json({ error: 'nope' });
    res.json({ ok: true });
  });
  app.post('/group-chat', groupChatWriteLimiter, (_req, res) => res.status(201).json({ ok: true }));
  // Mirrors a project page: what it reads as it opens (GET my-bot-requests,
  // threads/yours, /api/ai/where), and the read position it moves.
  app.get('/page-read', appChatLoadLimiter, (_req, res) => res.json({ ok: true }));
  app.post('/read-mark', appChatReadLimiter, (_req, res) => res.json({ ok: true }));

  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server?.close(); });

async function post(path, { user, kind, headers = {} } = {}) {
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': user,
      ...headers,
    },
    body: JSON.stringify(kind ? { kind } : {}),
  });
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, body };
}

test('close_issue proposals have their own bucket, separate from issue-create', async () => {
  const user = 'bucket-user';

  // Exhaust the issue-create bucket (20/hour) with general issues.
  for (let i = 0; i < 20; i++) {
    const r = await post('/issues', { user, kind: 'general' });
    assert.equal(r.status, 200, `general #${i + 1} should pass`);
  }
  const blocked = await post('/issues', { user, kind: 'general' });
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /up to 20 issues and proposals per hour/);

  // Close proposals still pass — their bucket is untouched.
  for (let i = 0; i < 20; i++) {
    const r = await post('/issues', { user, kind: 'close_issue' });
    assert.equal(r.status, 200, `close_issue #${i + 1} should pass`);
  }
  const closeBlocked = await post('/issues', { user, kind: 'close_issue' });
  assert.equal(closeBlocked.status, 429);
  assert.match(closeBlocked.body.error, /up to 20 close proposals per hour/);
});

test('failed requests are refunded and never consume budget', async () => {
  const user = 'fail-user';
  // Well past the 20/hour limit — every attempt 422s, none should count.
  for (let i = 0; i < 25; i++) {
    const r = await post('/issues?fail=1', { user, kind: 'general' });
    assert.equal(r.status, 422, `failure #${i + 1} should reach the route, not 429`);
  }
  const ok = await post('/issues', { user, kind: 'general' });
  assert.equal(ok.status, 200, 'a success after 25 failures still fits the budget');
});

test('full admins are exempt from the limiters', async () => {
  const headers = { 'x-is-admin': '1', 'x-can-admin-write': '1' };
  for (let i = 0; i < 25; i++) {
    const r = await post('/issues', { user: 'admin-user', kind: 'general', headers });
    assert.equal(r.status, 200, `admin request #${i + 1} should pass`);
  }
});

test('view-only admins stay limited like regular users', async () => {
  const headers = { 'x-is-admin': '1' }; // isAdmin but NOT canAdminWrite
  for (let i = 0; i < 20; i++) {
    const r = await post('/issues', { user: 'viewonly-admin', kind: 'general', headers });
    assert.equal(r.status, 200, `view-only admin request #${i + 1} should pass`);
  }
  const blocked = await post('/issues', { user: 'viewonly-admin', kind: 'general', headers });
  assert.equal(blocked.status, 429);
});

test('429 body carries retryAfterSeconds and a neutral message, no code field', async () => {
  const user = 'shape-user';
  for (let i = 0; i < 20; i++) {
    await post('/issues', { user, kind: 'general' });
  }
  const { status, body } = await post('/issues', { user, kind: 'general' });
  assert.equal(status, 429);
  assert.equal(typeof body.retryAfterSeconds, 'number');
  assert.ok(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 3600,
    `retryAfterSeconds within the hour window (got ${body.retryAfterSeconds})`);
  assert.match(body.error,
    /^Rate limit reached: up to 20 issues and proposals per hour\. You can try again (in about \d+ minutes|in under a minute)\.$/);
  assert.equal('code' in body, false,
    'throttle 429s must stay code-free (budget_exceeded is the billing discriminator)');
});

test('native discussion writes have their own bucket of 60 a minute', async () => {
  const user = 'group-chat-user';
  for (let i = 0; i < 60; i++) {
    const r = await post('/group-chat', { user });
    assert.equal(r.status, 201, `discussion message #${i + 1} should pass`);
  }
  const blocked = await post('/group-chat', { user });
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Too many discussion messages/);

  // Its own bucket: the issues limiter is untouched by it.
  const issue = await post('/issues', { user, kind: 'general' });
  assert.equal(issue.status, 200, 'exhausting native discussion writes throttles nothing else');
});

// #7111, #7112: a check run opens about 250 project pages as one account in
// under three minutes. Each page reads the viewer's own chat state as it
// opens; while those reads spent the read-position bucket (120 a minute), the
// page that came next got a 429, which is a console error, which failed a
// declared check that had nothing to do with it.
test('a check run\'s page loads do not spend the read-position bucket', async () => {
  const user = 'check-runner';
  const get = async () => (await fetch(`${base}/page-read`, { headers: { 'x-user-id': user } })).status;
  for (let i = 0; i < 300; i++) {
    assert.equal(await get(), 200, `page read #${i + 1} of a check run should pass`);
  }
  // The writes kept their own budget, and their own ceiling.
  for (let i = 0; i < 120; i++) {
    const r = await post('/read-mark', { user });
    assert.equal(r.status, 200, `read mark #${i + 1} should pass after 300 page reads`);
  }
  const blocked = await post('/read-mark', { user });
  assert.equal(blocked.status, 429, 'the read-position bucket still stops a runaway client');
  assert.equal(await get(), 200, 'and a throttled write leaves page reads alone');
});

test('the page-load reads still have a ceiling of their own', async () => {
  const user = 'runaway-reader';
  const get = async () => (await fetch(`${base}/page-read`, { headers: { 'x-user-id': user } })).status;
  for (let i = 0; i < 600; i++) await get();
  assert.equal(await get(), 429);
});

test('what a page reads as it opens is on the page-load bucket, never the read-position one', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const aiWork = read('src/routes/ai-work.js');
  const chat = read('src/routes/chat.js');
  assert.match(aiWork, /router\.get\('\/api\/ai\/where', appChatLoadLimiter,/);
  assert.match(aiWork, /router\.get\('\/api\/apps\/:slug\/threads\/yours', appChatLoadLimiter,/);
  assert.match(chat, /router\.get\('\/api\/apps\/:slug\/my-bot-requests', appChatLoadLimiter,/);
  // A GET added to the read-position bucket later is this bug again.
  for (const source of [aiWork, chat]) {
    assert.doesNotMatch(source, /router\.get\([^\n]*appChatReadLimiter/);
  }
});
