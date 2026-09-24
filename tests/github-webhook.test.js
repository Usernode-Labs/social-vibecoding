// #2737: POST /api/github/webhook — the signed nudge that replaces waiting
// for the imported-PR sweep.
//
// What matters here is the gate, not the plumbing: the route must refuse an
// unsigned or wrongly-signed delivery, must be OFF when no secret is set,
// must not trust the payload for anything except looking a row up, and must
// hand the actual head change to the one function that already knows how to
// apply it. Everything below is that contract.
//
// Run with: node --test tests/github-webhook.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const {
  githubWebhookRoutes, signatureMatches, repoKey, HANDLED_ACTIONS,
} = require('../src/routes/github-webhook');

const SECRET = 'a-shared-secret';
const REPO = 'Usernode-Labs/social-vibecoding';

function sign(body, secret = SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** A server with a mocked pool and a recording sync. */
function harness({ secret = SECRET, sessions = [] } = {}) {
  const synced = [];
  const pool = {
    async query(sql, params) {
      if (/FROM chat_sessions cs/.test(String(sql))) {
        return { rows: sessions.filter((s) => Number(s.pr_number) === Number(params[0])) };
      }
      return { rows: [] };
    },
  };
  const prImportSync = {
    async syncImportedProposal({ session }) { synced.push(session.id); return 'updated'; },
  };
  const app = express();
  app.use(githubWebhookRoutes({ githubWebhookSecret: secret }, { pool, prImportSync }));
  return { app, synced };
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, body, { signature, event = 'pull_request' } = {}) => fetch(`${base}/api/github/webhook`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': 'test-delivery',
    ...(signature ? { 'x-hub-signature-256': signature } : {}),
  },
  body,
});

const SESSION = {
  id: 4654, pr_number: 2685, source: 'imported', status: 'promoted',
  app_slug: 'usernode-2d5619', repo_url: `https://github.com/${REPO}`,
};

const payload = (over = {}) => JSON.stringify({
  action: 'synchronize',
  pull_request: { number: 2685 },
  repository: { full_name: REPO },
  ...over,
});

// ── The signature gate ───────────────────────────────────────────────────

test('signatureMatches: only the exact HMAC over the exact bytes', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(signatureMatches(SECRET, body, sign(body)), true);
  assert.equal(signatureMatches(SECRET, body, sign(body, 'other-secret')), false, 'another secret is not enough');
  assert.equal(signatureMatches(SECRET, Buffer.from('{"a":2}'), sign(body)), false, 'the body is covered');
  assert.equal(signatureMatches(SECRET, body, 'sha256=short'), false, 'a length mismatch is not a crash');
  assert.equal(signatureMatches(SECRET, body, null), false, 'a missing header is a refusal');
  assert.equal(signatureMatches('', body, sign(body, '')), false, 'no secret means no match, ever');
});

test('an unsigned or mis-signed delivery is refused and changes nothing', async () => {
  const { app, synced } = harness({ sessions: [SESSION] });
  const { server, base } = await listen(app);
  try {
    const body = payload();
    assert.equal((await post(base, body)).status, 401, 'no signature');
    assert.equal((await post(base, body, { signature: 'sha256=deadbeef' })).status, 401, 'wrong signature');
    assert.equal((await post(base, body, { signature: sign(body, 'not-the-secret') })).status, 401, 'wrong secret');
    // The classic forgery: a valid signature for a DIFFERENT body.
    assert.equal((await post(base, payload({ pull_request: { number: 9 } }), { signature: sign(body) })).status, 401,
      'a signature does not travel to another body');
    assert.deepEqual(synced, [], 'nothing was synced by any of them');
  } finally { server.close(); }
});

test('with no secret configured the route is off rather than open', async () => {
  const { app, synced } = harness({ secret: '', sessions: [SESSION] });
  const { server, base } = await listen(app);
  try {
    const body = payload();
    const res = await post(base, body, { signature: sign(body, '') });
    assert.equal(res.status, 503, 'deny by default');
    assert.deepEqual(synced, []);
  } finally { server.close(); }
});

// ── What a good delivery does ────────────────────────────────────────────

test('a signed synchronize hands the proposal to the existing head sync', async () => {
  const { app, synced } = harness({ sessions: [SESSION] });
  const { server, base } = await listen(app);
  try {
    const body = payload();
    const res = await post(base, body, { signature: sign(body) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, action: 'synchronize', prNumber: 2685 });
    // The handler answers first and works after, so give it a tick.
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(synced, [4654], 'one call, to the function the sweep also calls');
  } finally { server.close(); }
});

test('the repository has to match, not just the number', async () => {
  const { app, synced } = harness({
    sessions: [{ ...SESSION, repo_url: 'https://github.com/someone-else/other-app' }],
  });
  const { server, base } = await listen(app);
  try {
    const body = payload();
    await post(base, body, { signature: sign(body) });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(synced, [],
      'two apps can carry the same PR number; the delivery never picks the row on its own');
  } finally { server.close(); }
});

test('a ping is answered, and an action we do not handle is ignored', async () => {
  const { app, synced } = harness({ sessions: [SESSION] });
  const { server, base } = await listen(app);
  try {
    const ping = JSON.stringify({ zen: 'Design for failure.' });
    const res = await post(base, ping, { signature: sign(ping), event: 'ping' });
    assert.deepEqual(await res.json(), { ok: true, pong: true });

    const labelled = payload({ action: 'labeled' });
    const res2 = await post(base, labelled, { signature: sign(labelled) });
    assert.deepEqual(await res2.json(), { ok: true, ignored: 'labeled' });

    const issue = JSON.stringify({ action: 'opened', issue: { number: 1 } });
    const res3 = await post(base, issue, { signature: sign(issue), event: 'issues' });
    assert.deepEqual(await res3.json(), { ok: true, ignored: 'issues' });

    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(synced, [], 'none of those touched a proposal');
  } finally { server.close(); }
});

test('the actions handled are the ones that move a head', () => {
  assert.deepEqual([...HANDLED_ACTIONS].sort(), ['closed', 'opened', 'reopened', 'synchronize']);
});

test('repoKey normalizes what the apps table stores', () => {
  assert.equal(repoKey('https://github.com/Usernode-Labs/social-vibecoding'), 'usernode-labs/social-vibecoding');
  assert.equal(repoKey('https://github.com/Usernode-Labs/social-vibecoding.git'), 'usernode-labs/social-vibecoding');
  assert.equal(repoKey('not a url'), null);
});

// ── Where it is mounted, and on what ─────────────────────────────────────

test('it mounts before the body parser and outside the session gate', () => {
  const server = read('server.js');
  const mount = server.indexOf('app.use(githubWebhookRoutes(config));');
  assert.ok(mount > 0, 'the route is mounted');
  assert.ok(mount < server.indexOf('express.json()('),
    'BEFORE the JSON parser: the signature is over the raw bytes');
  assert.ok(mount < server.indexOf('app.use(authMiddleware'),
    'and before authMiddleware: GitHub has no session');

  const src = read('src/routes/github-webhook.js');
  assert.match(src, /express\.raw\(/, 'the body arrives as bytes');
  assert.match(src, /crypto\.timingSafeEqual/, 'and the comparison is timing-safe');
  assert.match(src, /githubWebhookSecret/);
  assert.match(read('src/config.js'), /githubWebhookSecret: process\.env\.GITHUB_WEBHOOK_SECRET \|\| ''/,
    'the secret comes from the environment and defaults to off');
  assert.ok(!/head\.sha|head_sha/.test(src),
    'the head SHA is never taken from the delivery: the sync re-reads it from GitHub');
});

test('the poller is kept as the fallback', () => {
  const server = read('server.js');
  assert.match(server, /Pass 6: imported-PR head sync/,
    'a missed delivery still heals on the sweep, so the webhook is an optimisation not a dependency');
});
