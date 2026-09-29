// Tests for the submission limiter on POST /api/feedback (#2520).
//
// The route files a real GitHub issue and may spend a Haiku call naming
// it, but shipped without a limiter while both of its siblings in the
// same file had one — so any signed-in user could loop it into unlimited
// issues and unlimited LLM spend. feedbackSubmitLimiter closes that:
//
//  - FEEDBACK_SUBMITS_PER_HOUR submissions per hour per user pass and the
//    next is a 429 that files nothing. #2669 raised that number from 10 to
//    30, so the tests READ the constant rather than restating it — the
//    limit and the message it prints must agree, and the only way to keep
//    them agreeing is to have one source for both;
//  - the 429 body is the file's standard throttle shape (a user-facing
//    `error` string plus `retryAfterSeconds`, and no `code` field, which
//    clients use to tell billing 429s apart);
//  - the bucket is per user, so one abuser cannot throttle everyone else;
//  - failures count too (no skipFailedRequests) — title generation runs
//    before the GitHub call, so a refunded failure would leave the LLM
//    spend loop unbounded.
//
// Run with: node --test tests/feedback-submit-rate-limit.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({ query: async () => ({ rows: [] }) });

const llm = require('../src/services/llm');
llm.generateIssueTitle = async () => ({ title: 'Generated title', usage: undefined, model: 'claude-haiku-4-5' });

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};

// Platform-target feedback files through a raw fetch to api.github.com —
// stub that and count the creations, passing local requests through.
process.env.GITHUB_BOT_TOKEN = 'test-pat';
let ghCreates = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('api.github.com')) {
    ghCreates++;
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 77, html_url: 'https://github.com/plat/repo/issues/77' }),
    };
  }
  return realFetch(url, opts);
};

const { feedbackRoutes } = require('../src/routes/feedback');
// #2669: read the cap, never restate it. The number the limiter enforces
// and the number its message prints come from one constant, and these
// tests assert against that same constant so raising it cannot leave a
// stale assertion (or a stale sentence) behind.
const { FEEDBACK_SUBMITS_PER_HOUR: LIMIT } = require('../src/middleware/rate-limits');
const express = require('express');

// The limiter is a module singleton with one in-memory bucket per user,
// shared across this whole process — so every test picks its own id.
let currentUserId = 1;

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: currentUserId, username: 'tester' }; next(); });
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function post(server, body) {
  const port = server.address().port;
  return realFetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('feedbackSubmitLimiter is mounted: one past the cap is a 429 that files nothing', async () => {
  currentUserId = 25201;
  ghCreates = 0;
  const server = await startServer();
  try {
    for (let i = 0; i < LIMIT; i++) {
      const res = await post(server, { description: `report number ${i}` });
      assert.equal(res.status, 200, `submission ${i + 1} passes the limiter`);
    }
    assert.equal(ghCreates, LIMIT, 'every accepted submission filed an issue');

    const res = await post(server, { description: 'one too many' });
    assert.equal(res.status, 429);
    assert.equal(ghCreates, LIMIT, 'the throttled submission files no issue');

    const body = await res.json();
    // The number the person reads must be the number enforced.
    assert.match(body.error, new RegExp(`up to ${LIMIT} issue reports per hour`));
    assert.match(body.error, /try again/i);
    assert.ok(!body.error.includes('—'), 'no em dash in user-facing copy');
    assert.equal(typeof body.retryAfterSeconds, 'number');
    assert.ok(body.retryAfterSeconds > 0);
    // Clients discriminate billing 429s by their `code` tag, so throttles
    // must stay code-free.
    assert.ok(!('code' in body), '429 carries no code field');
  } finally {
    server.close();
  }
});

// #2669: the reported symptom was hitting the cap during ordinary use.
// The sizing argument that set it at 10 said the offline outbox "caps
// itself at 10 entries, so 10 / hour clears a full flush and still never
// bites". The premise is true and the conclusion is not: a full flush
// spent the ENTIRE budget, so the next live report was refused. This pins
// the relationship rather than either number on its own.
test('a full offline flush cannot exhaust the hour on its own', () => {
  const queue = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'feedback-queue.js'), 'utf8');
  const m = /const MAX_ENTRIES = (\d+);/.exec(queue);
  assert.ok(m, 'the outbox cap moved; this relationship needs re-deriving');
  const outbox = Number(m[1]);

  assert.ok(LIMIT > outbox,
    `a full flush (${outbox}) must leave room to file another report, but the `
    + `cap is ${LIMIT}`);
  assert.ok(LIMIT - outbox >= outbox,
    'and it should leave at least another flush of headroom, not one spare slot');
});

test('the limit the user is told is the limit enforced', () => {
  // These drifted apart once already: the cap was a literal and the
  // sentence repeated it. Both now read FEEDBACK_SUBMITS_PER_HOUR.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'rate-limits.js'), 'utf8');
  const block = src.slice(
    src.indexOf('const feedbackSubmitLimiter = makeLimiter({'),
    src.indexOf('});', src.indexOf('const feedbackSubmitLimiter = makeLimiter({')));
  assert.match(block, /max: FEEDBACK_SUBMITS_PER_HOUR/);
  assert.match(block, /up to \$\{FEEDBACK_SUBMITS_PER_HOUR\} issue reports per hour/);
  assert.doesNotMatch(block, /up to \d+ issue reports/,
    'the number must not be written into the sentence by hand');
});

test('the bucket is per user: another account is unaffected by an exhausted one', async () => {
  currentUserId = 25202;
  const server = await startServer();
  try {
    for (let i = 0; i < LIMIT; i++) {
      assert.equal((await post(server, { description: `report ${i}` })).status, 200);
    }
    assert.equal((await post(server, { description: 'blocked' })).status, 429);

    currentUserId = 25203;
    assert.equal((await post(server, { description: 'different account' })).status, 200);
  } finally {
    server.close();
  }
});

test('rejected submissions count against the bucket (no refund)', async () => {
  currentUserId = 25204;
  const server = await startServer();
  try {
    for (let i = 0; i < LIMIT; i++) {
      assert.equal((await post(server, { description: '' })).status, 400, 'validation rejection');
    }
    const res = await post(server, { description: 'a perfectly valid report' });
    assert.equal(res.status, 429, 'the budget was spent by the rejections');
  } finally {
    server.close();
  }
});
