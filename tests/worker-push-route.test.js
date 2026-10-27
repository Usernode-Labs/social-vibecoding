'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { requestWorkerPush: askPush } = require('../src/workflow/worker-push/request.ts');
const { failure } = require('../src/workflow/worker-push/machine.ts');

test('worker push HTTP callback preserves auth, session scope and conductor results', async t => {
  const db = require('../src/db/pool');
  const row = { app_id: 7, branch_name: 'dev/stored', status: 'active', repo_url: 'https://github.com/owner/stored' };
  let session = row; let lookupError = false; let reads = 0;
  const pool = { query: async () => {
    reads++; if (lookupError) throw new Error('synthetic database failure');
    return { rows: session ? [session] : [] };
  } };
  t.mock.method(db, 'getPool', () => pool);
  const calls = []; let result = { ok: true, sha: 'a'.repeat(40) };
  const runtime = {
    appendAndWait: async (_machine, _key, event, options) => {
      calls.push([event.payload.sessionId, event.payload.branchName, options.appId]);
      return { status: 'accepted' };
    },
    waitFor: async () => ({ state: 'done', data: { result } }),
  };
  const requestWorkerPush = sessionId => askPush(runtime, pool, { sessionId });
  const Module = require('node:module'); const load = Module._load;
  t.mock.method(Module, '_load', function (name, parent, ...rest) {
    if (name === '../workflow/platform.ts' && parent?.filename === require.resolve('../src/routes/internal')) return { requestWorkerPush };
    return load.call(this, name, parent, ...rest);
  });
  t.mock.method(require('../src/services/worker'), 'execPushFromWorker', () => { throw new Error('web executed a worker'); });
  t.mock.method(require('../src/services/github'), 'checkRepoPublic', () => { throw new Error('web contacted authenticated GitHub'); });
  const previousSecret = process.env.WORKER_JWT_SECRET;
  process.env.WORKER_JWT_SECRET = 'synthetic-worker-push-route-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.WORKER_JWT_SECRET;
    else process.env.WORKER_JWT_SECRET = previousSecret;
  });
  const jwt = require('../src/services/platform-jwt');
  const app = express(); app.use(express.json()); app.use(require('../src/routes/internal').internalRoutes({}));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function push(token = jwt.signWorkerPushToken({ sessionId: 42 }), body = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/sessions/42/push`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  await t.test('both supported push tokens queue only the stored session and branch', async () => {
    for (const token of [jwt.signWorkerPushToken({ sessionId: 42 }), jwt.signWorkerToken({ sessionId: 42 })]) {
      const before = reads;
      assert.deepEqual(await push(token, { branch: 'main', repoUrl: 'https://attacker.invalid', command: 'steal' }), {
        status: 200, body: { ok: true, branch: 'dev/stored', sha: 'a'.repeat(40) },
      });
      assert.deepEqual(calls.at(-1), [42, 'dev/stored', 7]);
      assert.equal(reads - before, 1, 'the HTTP/request path loads its session once');
    }
  });
  await t.test('missing auth, wrong purpose and cross-session tokens never enqueue work', async () => {
    const before = calls.length;
    assert.equal((await push(null)).status, 401);
    assert.equal((await push(jwt.signWorkerPurpose({ sessionId: 42, purpose: jwt.PUR_ISSUES_READ }))).status, 401);
    assert.equal((await push(jwt.signWorkerPushToken({ sessionId: 43 }))).status, 403);
    assert.equal(calls.length, before);
  });
  await t.test('missing, inactive and branchless sessions keep their immediate refusal', async () => {
    const before = calls.length;
    session = null; assert.equal((await push()).status, 404);
    session = { ...row, branch_name: null }; assert.equal((await push()).body.code, 'no_branch');
    session = { ...row, status: 'closed' }; assert.equal((await push()).status, 409);
    session = { ...row, anonymised_at: new Date() }; assert.equal((await push()).status, 409);
    session = row; assert.equal(calls.length, before);
  });
  await t.test('a session lookup failure keeps its 500 response and never enqueues', async () => {
    const before = calls.length; lookupError = true;
    const response = await push(); lookupError = false;
    assert.equal(response.status, 500); assert.equal(response.body.code, 'db_error'); assert.equal(calls.length, before);
  });
  await t.test('public-only refusal and permanent Git errors retain useful status and detail', async () => {
    result = failure('private_repo', 'Repository is private.', 403, true);
    assert.equal((await push()).status, 403);
    result = { ...failure('no_token', 'No Git credential.', 502, true), detail: 'Ask an admin.' };
    assert.deepEqual(await push(), { status: 502, body: { ok: false, code: 'no_token', message: 'No Git credential.', detail: 'Ask an admin.', permanent: true } });
  });
  await t.test('an unavailable conductor produces a retryable 503', async () => {
    result = failure('push_unavailable', 'Retry the push.', 503);
    assert.deepEqual(await push(), { status: 503, body: { ok: false, code: 'push_unavailable', message: 'Retry the push.', detail: null, permanent: false } });
  });
});
