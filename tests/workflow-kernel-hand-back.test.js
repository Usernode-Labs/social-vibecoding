'use strict';

// A draining process hands its shots and checks work back instead of
// failing it (23 Nov 2026). On a release the replaced process finishes its
// work on small pools (server.js shrinkPoolsForDrain), and three runs failed
// within half a minute on pg-pool's "timeout exceeded when trying to connect"
// before any of their own work had started. Pinned here, without a database:
//
//   - the kernel (src/workflow/kernel/services.ts execute): a handler that
//     throws HandedBack, in a process that claims nothing more, reports
//     nothing and gives its claim up at once, as a stopping process does, so
//     the next process carries the item on; in a process that still claims,
//     the handler's `otherwise` is its result, or its cause its failure;
//   - the shots steps (src/workflow/shots/services.ts): a connection the
//     database would not give while the process drains is handed back; the
//     same error when it is not draining is a platform fault the machine
//     takes again once; any other error while draining fails as before;
//   - the checks run (src/workflow/preview/services.ts, visuals.js
//     captureForSession) the same, its place in line kept for the next claim.
//
// Run with: node --test tests/workflow-kernel-hand-back.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { execute } = require('../src/workflow/kernel/services.ts');
const { HandedBack } = require('../src/workflow/kernel/index.ts');
const lifecycle = require('../src/services/lifecycle');
const dbRetry = require('../src/services/db-retry');

const POOL_TIMEOUT = 'timeout exceeded when trying to connect';
const poolTimeout = () => new Error(POOL_TIMEOUT);
const quiet = { info() {}, warn() {}, error() {} };

// A pool that answers every statement as if it applied, and keeps them.
function fakePool() {
  const sql = [];
  const query = async (text, values) => { sql.push({ text: String(text), values }); return { rowCount: 1, rows: [{ id: '1' }] }; };
  return {
    sql,
    query,
    async connect() { return { query, release() {}, on() {}, removeListener() {} }; },
  };
}

function item(kind) {
  return { id: 'w1', machine: 'shots', key: 'session:42', kind, work_key: 'copies:1', input: {}, checkpoint: null,
    attempt_count: 1, lost_attempts: 0, claim_id: 'c1' };
}

function serviceOptions(pool, kind, handler) {
  return { pool, handlers: new Map([[kind, handler]]), serviceId: 'test', log: quiet, versions: new Map([['shots', 1]]),
    lockTimeoutMs: 1000, statementTimeoutMs: 1000, release: null, releaseKinds: [] };
}

const reported = (pool) => pool.sql.filter((q) => /INSERT INTO wf_events/.test(q.text));
const givenUp = (pool) => pool.sql.filter((q) => /lease_until = now\(\) WHERE/.test(q.text) && /outcome = 'lost'/.test(q.text));

test('a handler that hands its item back in a process that claims nothing more reports nothing and gives its claim up', async () => {
  const pool = fakePool();
  const handler = { resumable: true, maxAttempts: 1, async run() { throw new HandedBack(poolTimeout(), { failed: { code: 'database_busy' } }); } };
  await execute(serviceOptions(pool, 'shots.copies', handler), item('shots.copies'), new AbortController().signal, () => true);
  assert.equal(reported(pool).length, 0, 'no result event: nothing failed');
  const [given] = givenUp(pool);
  assert.ok(given, 'the claim is given up at once, for the next process to take');
  assert.equal(JSON.parse(given.values[2]).code, 'handed_back');
  assert.equal(pool.sql.some((q) => /status = 'reported'/.test(q.text)), false);
});

test('in a process that still claims, the handler\'s own result is reported instead, or its cause as the failure', async () => {
  const otherwise = { failed: { code: 'database_busy', fault: 'database', message: POOL_TIMEOUT } };
  const pool = fakePool();
  const handler = { resumable: true, maxAttempts: 1, async run() { throw new HandedBack(poolTimeout(), otherwise); } };
  await execute(serviceOptions(pool, 'shots.copies', handler), item('shots.copies'), new AbortController().signal, () => false);
  assert.equal(givenUp(pool).length, 0, 'the claim is not given up: this process would take it straight back');
  const [event] = reported(pool);
  assert.equal(event.values[3], 'WorkSucceeded');
  assert.deepEqual(JSON.parse(event.values[4]).result, otherwise, 'what the step would have said without the hand-back');

  const bare = fakePool();
  const thrower = { maxAttempts: 1, async run() { throw new HandedBack(poolTimeout()); } };
  await execute(serviceOptions(bare, 'shots.copies', thrower), item('shots.copies'), new AbortController().signal, () => false);
  const [failed] = reported(bare);
  assert.equal(failed.values[3], 'WorkExhausted');
  assert.equal(JSON.parse(failed.values[4]).error.message, POOL_TIMEOUT, 'the cause is the failure, not the wrapper');
});

test('an ordinary error is reported as before, whatever the process', async () => {
  const pool = fakePool();
  const handler = { maxAttempts: 1, async run() { throw new Error('Image build failed'); } };
  await execute(serviceOptions(pool, 'shots.copies', handler), item('shots.copies'), new AbortController().signal, () => true);
  assert.equal(givenUp(pool).length, 0);
  assert.equal(reported(pool)[0].values[3], 'WorkExhausted');
});

test('the runtime hands work over only once it claims nothing more', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/kernel/index.ts'), 'utf8');
  assert.match(src, /execute\(service, w, stopping\.signal, \(\) => quiesced \|\| stopping\.signal\.aborted\)/);
});

// ── The shots steps ─────────────────────────────────────────────────────

function draining(t, on) {
  t.mock.method(lifecycle, 'isShuttingDown', () => on);
}

function stubOrchestrator(t, patch) {
  const orchestrator = require('../src/services/shots-orchestrator');
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = orchestrator[k]; orchestrator[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) orchestrator[k] = v; });
}

function context(kind, input) {
  return { workId: 'w1', kind, key: 'k', attempt: 1, lostAttempts: 0, resumeFrom: null, input,
    checkpoint: async () => {}, signal: new AbortController().signal,
    steps: () => ({ flush: async () => {}, fence() {} }) };
}

const SHA = (c) => c.repeat(40);
const copiesInput = { runId: 'r'.repeat(32), sessionId: 42, n: 1, intent: { stories: [] }, baseSha: SHA('a'), headSha: SHA('b'), budgetMs: 60_000 };

test('a shots step that could not get a connection while its process drains is handed back, not failed', async (t) => {
  const { shotsServices } = require('../src/workflow/shots/services.ts');
  const { WORK } = require('../src/workflow/shots/machine.ts');
  const handlers = shotsServices({ config: {}, pool: {} });
  draining(t, true);
  stubOrchestrator(t, {
    buildCopies: async () => { throw poolTimeout(); },
    resolveRevision: async () => { throw poolTimeout(); },
    dispatchAgent: async () => { throw poolTimeout(); },
  });
  for (const [kind, input] of [
    [WORK.copies, copiesInput],
    [WORK.revision, { sessionId: 42, head: SHA('b') }],
    [WORK.agent, { runId: 'r'.repeat(32), sessionId: 42, budgetMs: 60_000 }],
  ]) {
    await assert.rejects(handlers[kind].run(context(kind, input)), (error) => {
      assert.ok(error instanceof HandedBack, `${kind}: handed back`);
      assert.equal(error.cause.message, POOL_TIMEOUT);
      // What it reports where it cannot be handed back: the database's fault.
      const failed = error.otherwise.failed || error.otherwise.agent;
      assert.equal(failed.code, 'database_busy', kind);
      assert.equal(failed.fault, 'database', kind);
      return true;
    });
  }
});

test('the same error when the process is not draining is a platform fault the machine takes again once', async (t) => {
  const { shotsServices } = require('../src/workflow/shots/services.ts');
  const { WORK } = require('../src/workflow/shots/machine.ts');
  const handlers = shotsServices({ config: {}, pool: {} });
  draining(t, false);
  stubOrchestrator(t, { buildCopies: async () => { throw poolTimeout(); } });
  const out = await handlers[WORK.copies].run(context(WORK.copies, copiesInput));
  assert.deepEqual(out.failed, { code: 'database_busy', message: POOL_TIMEOUT, fault: 'database', retryAt: null });
});

test('any other error while the process drains fails as before', async (t) => {
  const { shotsServices } = require('../src/workflow/shots/services.ts');
  const { WORK } = require('../src/workflow/shots/machine.ts');
  const handlers = shotsServices({ config: {}, pool: {} });
  draining(t, true);
  stubOrchestrator(t, { buildCopies: async () => { throw Object.assign(new Error('Image build failed'), { code: 'shots_build_failed' }); } });
  const out = await handlers[WORK.copies].run(context(WORK.copies, copiesInput));
  assert.equal(out.failed.code, 'shots_build_failed');
  assert.equal(out.failed.fault, null, 'the proposal\'s, as it always was');
});

test('the drain test is the connection predicate while shutting down, nothing else', (t) => {
  assert.equal(dbRetry.handBackOnDrain(poolTimeout(), true), true);
  assert.equal(dbRetry.handBackOnDrain(poolTimeout(), false), false);
  assert.equal(dbRetry.handBackOnDrain(new Error('relation "x" does not exist'), true), false);
  draining(t, true);
  assert.equal(dbRetry.handBackOnDrain(poolTimeout()), true, 'read from lifecycle.isShuttingDown by default');
});

// ── The checks run ──────────────────────────────────────────────────────

test('a checks run that could not get a connection while its process drains is handed back with its row kept', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/visuals.js'), 'utf8');
  const capture = src.slice(src.indexOf('async function captureForSession('), src.indexOf('function workflowOperation('));
  const caught = capture.slice(capture.indexOf('} catch (err) {\n    closeProgress();'));
  const handBack = caught.indexOf('if (dbRetry.handBackOnDrain(err)) {');
  assert.ok(handBack > 0, 'the run\'s catch asks first');
  assert.ok(handBack < caught.indexOf('return databaseBusyResult()'), 'before it would settle as the platform\'s error');
  assert.match(caught.slice(handBack, handBack + 500), /throw err;/, 'rethrown, not settled');
  // Not settled, so its check_runs row (its place in line) and its Jobs stay
  // for the next claim's collect.
  assert.match(caught, /if \(harvestable && settledRun\) \{/);
});
