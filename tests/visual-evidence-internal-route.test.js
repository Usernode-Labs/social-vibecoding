'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'evidence-route-test-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'evidence-route-test-secret';

// The route acquires a pool at construction, but this request needs only the
// run-scoped in-memory control. Keep the HTTP test independent of Postgres.
require('../src/db/pool').getPool = () => ({ query: async () => assert.fail('unexpected database request') });

const { internalRoutes } = require('../src/routes/internal');
const controlPlane = require('../src/services/visual-evidence-control');
const platformJwt = require('../src/services/platform-jwt');
const contract = require('../src/services/visual-evidence-plan');
const fixtures = require('./fixtures/visual-evidence');

test('the authenticated plan endpoint responds before paired replay finishes', async (t) => {
  controlPlane._clearForTests();
  const runId = 'a'.repeat(32);
  const sessionId = 42;
  let releaseReplay;
  const pendingReplay = new Promise((resolve) => { releaseReplay = resolve; });
  t.after(() => { releaseReplay(); controlPlane._clearForTests(); });
  let replayCalls = 0;
  const registration = controlPlane.registerRun({
    runId, sessionId, intent: fixtures.intent(), context: {},
    expiresAt: Date.now() + 10_000,
    runPlan: async (plan) => {
      replayCalls += 1;
      await pendingReplay;
      return { hardVerdict: { passed: true }, planHash: contract.planHash(plan) };
    },
  });
  t.after(() => registration.unregister());

  const app = express();
  app.use(express.json());
  app.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET }));
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/api/internal/evidence/${runId}/run-plan`;
  const token = platformJwt.signEvidenceToken({ runId, sessionId });
  const replays = [{ id: 'invite-suggestions', replay: fixtures.plan().stories[0].replay }];
  const submit = async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ replays }),
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const first = await submit();
  assert.equal(first.ok, true);
  assert.equal(first.result.accepted, true);
  assert.equal(first.result.duplicate, false);
  assert.equal(registration.control.latestHard, null);
  const retry = await submit();
  assert.equal(retry.result.duplicate, true);
  assert.equal(registration.control.planCalls, 1);
  releaseReplay();
  await registration.control.waitForPlan();
  assert.equal(replayCalls, 1);
  assert.equal(registration.control.latestHard.passed, true);
});
