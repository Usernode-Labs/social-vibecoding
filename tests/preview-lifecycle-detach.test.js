'use strict';

// Work launched from inside a preview run that outlives it (the visual
// evidence hand-off from a checks run's `finally`, the Workshop's debounced
// reconcile) must not keep the run's guarded pool: once the run settles,
// every query through it throws "superseded".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycle } = require('../src/services/preview-lifecycle');

const SHA = 'a'.repeat(40);

// Just enough of a pool for one run: the session row, the operation row, and
// an ownership check that holds until the run is over.
function fakePool() {
  const answer = async (sql) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    if (/INSERT INTO preview_operations/.test(text)) return { rows: [{ desired_revision: SHA, updated_at: new Date() }] };
    if (/SELECT \* FROM chat_sessions/.test(text)) return { rows: [{ id: 1, status: 'active', checks_commit_sha: SHA }] };
    if (/SELECT \* FROM preview_operations/.test(text)) return { rows: [{ desired_revision: SHA, phase: null }] };
    if (/SELECT o\.run_id/.test(text)) return { rows: [{ run_id: 'r' }] };
    return { rows: [], rowCount: 1 };
  };
  return { query: answer, connect: async () => ({ query: answer, release() {} }) };
}

test('detach leaves the running operation, synchronously and for what it schedules', async () => {
  const saved = process.env.PREVIEW_LIFECYCLE_ENABLED;
  process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
  try {
    const lifecycle = createLifecycle({
      poolFor: fakePool,
      lock: async (_config, _lock, _id, fn) => fn(),
      checks: () => ({ cancelPreviewChecks: async () => {} }),
      pollMs: 60_000,
    });
    let inside;
    let detachedNow;
    let detachedLater;
    let inheritedLater;
    await lifecycle.run({ appRuntime: 'kubernetes' }, { id: 1 }, SHA, 'capture', async () => {
      inside = lifecycle.current();
      detachedNow = lifecycle.detach(() => lifecycle.current());
      detachedLater = lifecycle.detach(() => new Promise((resolve) => setTimeout(() => resolve(lifecycle.current()), 0)));
      inheritedLater = new Promise((resolve) => setTimeout(() => resolve(lifecycle.current()), 0));
    });
    assert.ok(inside?.pool, 'the run has a guarded pool');
    assert.equal(detachedNow, undefined);
    assert.equal(await detachedLater, undefined, 'a timer armed inside detach does not carry the run');
    assert.equal(await inheritedLater, inside, 'without detach, a timer armed in the run still sees it');
  } finally {
    if (saved === undefined) delete process.env.PREVIEW_LIFECYCLE_ENABLED;
    else process.env.PREVIEW_LIFECYCLE_ENABLED = saved;
  }
});

test('visual evidence scheduled from a checks run launches outside it, on the base pool', async () => {
  const lifecycle = require('../src/services/preview-lifecycle');
  const orchestrator = require('../src/services/visual-evidence-orchestrator');
  const visuals = require('../src/services/visuals');
  const { getPool } = require('../src/db/pool');
  const config = { databaseUrl: 'postgres://unused/none' };
  const guarded = { query: async () => { throw lifecycle.cancelled(); } };
  const operation = { pool: guarded };
  let detached = false;
  const saved = { current: lifecycle.current, detach: lifecycle.detach, schedule: orchestrator.scheduleForSession };
  lifecycle.current = () => (detached ? undefined : operation);
  lifecycle.detach = (fn) => {
    detached = true;
    try { return fn(); } finally { detached = false; }
  };
  const launched = [];
  orchestrator.scheduleForSession = async (_config, args) => {
    launched.push(args);
    return { scheduled: true };
  };
  try {
    visuals.scheduleVisualEvidence(config, guarded, 42, SHA, 'preview-ready');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launched.length, 1);
    assert.notEqual(launched[0].pool, guarded, 'never the settled run\'s guarded pool');
    assert.equal(launched[0].pool, lifecycle.detach(() => getPool(config)), 'the base pool');    assert.equal(launched[0].headSha, SHA);

    const injected = { query: async () => ({ rows: [] }) };
    visuals.scheduleVisualEvidence(config, injected, 42, SHA, 'checks-already-decided');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launched[1].pool, injected, 'a pool that is not the run\'s is used as given');
  } finally {
    lifecycle.current = saved.current;
    lifecycle.detach = saved.detach;
    orchestrator.scheduleForSession = saved.schedule;
  }
});
