'use strict';

// Old callbacks are tombstones: no request may publish or create a proposal.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const platformJwt = require('../src/services/platform-jwt');

for (const [endpoint, code, message] of [
  ['push', 'push_retired', 'The conductor publishes completed turns.'],
  ['pr', 'pr_retired', 'The conductor creates proposals after turn completion.'],
]) test(`retired worker ${endpoint} returns permanent 410 without privileged I/O`, async t => {
  const previousSecret = process.env.WORKER_JWT_SECRET;
  process.env.WORKER_JWT_SECRET = 'retired-callback-synthetic-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.WORKER_JWT_SECRET;
    else process.env.WORKER_JWT_SECRET = previousSecret;
  });
  const matching = platformJwt.signWorkerToken({ sessionId: 42 });
  assert.equal(platformJwt.verifyWorkerToken(matching).session_id, 42);
  const tokens = [null, 'invalid-old-worker-token', matching,
    platformJwt.signWorkerToken({ sessionId: 99 }),
    platformJwt.signVisibleChangesToken({ sessionId: 42 })];
  // Retirement is independent of token validation and signer availability.
  delete process.env.WORKER_JWT_SECRET;

  const forbidden = [];
  const deny = name => () => { forbidden.push(name); throw new Error(`retired endpoint invoked ${name}`); };
  const pool = { query: deny('database query'), connect: deny('database connection') };
  t.mock.method(require('../src/db/pool'), 'getPool', () => pool);
  t.mock.method(require('../src/services/worker'), 'execPushFromWorker', deny('worker publication'));
  t.mock.method(require('../src/services/worker-git-push'), 'push', deny('trusted Git pusher'));
  t.mock.method(require('../src/services/github'), 'getInstallationToken', deny('GitHub credential'));
  t.mock.method(require('../src/services/github'), 'createPR', deny('PR creation'));
  t.mock.method(require('../src/services/native-pulls'), 'create', deny('native proposal creation'));

  const app = express(); app.use(express.json()); app.use(require('../src/routes/internal').internalRoutes({}));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const sessionId of ['42', '99', 'not-a-session']) for (const token of tokens) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/sessions/${sessionId}/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ title: 'Create this proposal', body: 'Worker-supplied body',
        branch: 'main', repoUrl: 'https://attacker.invalid', command: 'steal' }),
    });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { ok: false, code, permanent: true, message });
  }
  assert.deepEqual(forbidden, [], 'no database, Git, credential, or proposal operation occurred');
});
