// #4817 — the import routes tell "GitHub could not be read" apart from
// "there is nothing to import" and from "that pull request does not exist".
//
//   GET  /api/apps/:slug/pr-import/candidates
//     GitHub or the repo not configured → 200 { candidates: [], configured: false }
//     listOpenPulls throws              → 502 { error }
//     success                           → 200 { candidates, configured: true }
//   GET  /api/apps/:slug/pr-import/preview and POST /api/apps/:slug/pr-import
//     getPR throws with status 404      → 404 "PR #N not found on GitHub"
//     getPR throws anything else        → 502 "Could not reach GitHub …"
//
// Before, a rate limit or a timeout answered an empty 200 (the dialog said
// "No open pull requests") and every getPR failure answered 404.
//
// Run with: node --test tests/pr-import-github-failures.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.USERNODE_ENV; // the real client, not the staging mock

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({ query: async () => ({ rows: [], rowCount: 0 }) });

const APP = { id: 5, slug: 'widget', name: 'Widget', repo_url: 'https://github.com/acme/widget' };
const appAccess = require('../src/services/app-access');
let currentApp = APP;
appAccess.getAppForUser = async () => currentApp;

const github = require('../src/services/github');
let enabled = true;
let listOpenPulls = async () => [];
let getPR = async () => { throw new Error('unset'); };
github.isEnabled = () => enabled;
github.listOpenPulls = (...a) => listOpenPulls(...a);
github.getPR = (...a) => getPR(...a);

const { voteRoutes } = require('../src/routes/votes');
const express = require('express');

function ghError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

let server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  // An admin passes the membership gate; app access is stubbed above.
  app.use((req, res, next) => { req.user = { id: 7, username: 'evan', isAdmin: true }; next(); });
  app.use(voteRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  enabled = true;
  currentApp = APP;
  listOpenPulls = async () => [];
  getPR = async () => { throw new Error('unset'); };
});

async function call(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('candidates: GitHub not configured answers configured:false, not a bare empty list', async () => {
  enabled = false;
  const off = await call('GET', '/api/apps/widget/pr-import/candidates');
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, { candidates: [], configured: false });

  enabled = true;
  currentApp = { ...APP, repo_url: null };
  const noRepo = await call('GET', '/api/apps/widget/pr-import/candidates');
  assert.deepEqual(noRepo.body, { candidates: [], configured: false });
});

test('candidates: a failed listOpenPulls is a 502, not "no open pull requests"', async () => {
  listOpenPulls = async () => { throw ghError(403, 'API rate limit exceeded'); };
  const r = await call('GET', '/api/apps/widget/pr-import/candidates');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Could not load open pull requests from GitHub/);
  assert.equal(r.body.candidates, undefined);
});

test('candidates: success carries configured:true, and an empty repo is an empty list', async () => {
  const empty = await call('GET', '/api/apps/widget/pr-import/candidates');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { candidates: [], configured: true });

  listOpenPulls = async () => [{ number: 3, title: 'Fix', user: { login: 'a' }, head: { ref: 'f', sha: 'abc' }, base: { ref: 'main' } }];
  const some = await call('GET', '/api/apps/widget/pr-import/candidates');
  assert.equal(some.body.configured, true);
  assert.deepEqual(some.body.candidates.map((c) => c.number), [3]);
});

test('preview: only GitHub\'s own 404 reads as "not found"', async () => {
  getPR = async () => { throw ghError(404, 'Not Found'); };
  const missing = await call('GET', '/api/apps/widget/pr-import/preview?pr=12');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'PR #12 not found on GitHub');

  getPR = async () => { throw ghError(500, 'Server Error'); };
  const down = await call('GET', '/api/apps/widget/pr-import/preview?pr=12');
  assert.equal(down.status, 502);
  assert.match(down.body.error, /Could not reach GitHub to read PR #12/);

  getPR = async () => { throw new Error('socket hang up'); }; // no status at all
  const timeout = await call('GET', '/api/apps/widget/pr-import/preview?pr=12');
  assert.equal(timeout.status, 502);
});

test('import: only GitHub\'s own 404 reads as "not found"', async () => {
  getPR = async () => { throw ghError(404, 'Not Found'); };
  const missing = await call('POST', '/api/apps/widget/pr-import', { pr: 12 });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'PR #12 not found on GitHub');

  getPR = async () => { throw ghError(403, 'API rate limit exceeded'); };
  const limited = await call('POST', '/api/apps/widget/pr-import', { pr: 12 });
  assert.equal(limited.status, 502);
  assert.match(limited.body.error, /Could not reach GitHub to read PR #12/);
});
