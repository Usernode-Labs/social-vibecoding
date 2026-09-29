'use strict';

// #2525: the two governance vote endpoints had no limiter at all.
//
//   POST /api/sessions/:id/vote   (proposals)
//   POST /api/issues/:id/vote     (issues)
//
// Unlike the attribute vote — a quiet field update, already bounded at
// 60/min — a governance vote is loud. Every CHANGED vote calls
// sendSystemMessage to post a `vote` line into the item's own thread,
// broadcasts a tally push and notifies. Casting the SAME vote twice is
// already short-circuited as `unchanged`, so the spam shape is a FLIP:
// yes, no, yes, no — each one another line and another notification for
// everyone reading that thread.
//
// 30/minute/user. Nobody reads and answers more than 30 proposals in a
// minute, so an honest voter never meets it — including the fast path, the
// Workshop's Needs-you deck, which answers with the Y and N keys. A scripted
// flipper stops at 30 lines a minute instead of thousands.
//
// Behaviour over real HTTP, like tests/rate-limits.test.js: skipFailedRequests
// refunds on response-finish, which stubbed req/res never emit. The limiter is
// a module singleton with one shared in-memory bucket, so each test uses its
// own user id.
//
// Run with: node --test tests/governance-vote-rate-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { governanceVoteLimiter } = require('../src/middleware/rate-limits');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: req.headers['x-user-id'] || 'anon',
      isAdmin: req.headers['x-is-admin'] === '1',
      canAdminWrite: req.headers['x-can-admin-write'] === '1',
    };
    next();
  });
  // Both real routes, and `?fail=1` standing in for a route-level refusal
  // (an unknown session, a vote value that is not yes/no).
  const handler = (req, res) => {
    if (req.query.fail === '1') return res.status(400).json({ error: 'nope' });
    res.json({ ok: true });
  };
  app.post('/sessions/vote', governanceVoteLimiter, handler);
  app.post('/issues/vote', governanceVoteLimiter, handler);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server?.close(); });

async function vote(p, user, headers = {}) {
  const resp = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': user, ...headers },
    body: '{}',
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

test('an honest voter clearing a queue is never throttled', async () => {
  for (let i = 0; i < 30; i++) {
    const r = await vote('/sessions/vote', 'u-honest');
    assert.equal(r.status, 200, `vote ${i + 1} of 30 should pass`);
  }
});

test('the 31st vote in a minute is refused', async () => {
  for (let i = 0; i < 30; i++) await vote('/sessions/vote', 'u-flipper');
  const over = await vote('/sessions/vote', 'u-flipper');
  assert.equal(over.status, 429);
  assert.match(over.body.error, /Too many votes/);
  assert.ok(Number.isInteger(over.body.retryAfterSeconds));
  // #463: throttles carry no `code`, which is how clients tell them from
  // billing 429s.
  assert.equal('code' in over.body, false);
});

test('proposal and issue votes share one bucket', async () => {
  for (let i = 0; i < 30; i++) await vote('/sessions/vote', 'u-shared');
  const other = await vote('/issues/vote', 'u-shared');
  assert.equal(other.status, 429, 'the same act, the same blast radius, one budget');
});

test('one user’s spam does not throttle anybody else', async () => {
  for (let i = 0; i < 31; i++) await vote('/sessions/vote', 'u-noisy');
  const bystander = await vote('/sessions/vote', 'u-quiet');
  assert.equal(bystander.status, 200, 'keyed per user, not per address');
});

test('a refused vote costs no budget', async () => {
  for (let i = 0; i < 40; i++) {
    const r = await vote('/sessions/vote?fail=1', 'u-rejected');
    assert.equal(r.status, 400, `attempt ${i + 1} should be the route's 400, never a 429`);
  }
  assert.equal((await vote('/sessions/vote', 'u-rejected')).status, 200);
});

test('both routes actually mount the limiter', () => {
  assert.match(read('src/routes/votes.js'),
    /router\.post\('\/api\/sessions\/:id\/vote', governanceVoteLimiter,/);
  assert.match(read('src/routes/issues.js'),
    /router\.post\('\/api\/issues\/:id\/vote', governanceVoteLimiter,/);
});
