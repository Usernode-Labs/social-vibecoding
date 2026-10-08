'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gc = require('../src/services/shots-gc');
const environment = require('../src/services/shots-environment');
const runtime = require('../src/services/application-runtime');
const db = require('../src/services/db-manager');
const config = { appRuntime: 'kubernetes', kubernetes: { appNamespace: 'social-apps' } };
const id = 'a'.repeat(32);

test('recovery removes both generations of hosted fixtures, on both backends', async (t) => {
  for (const appRuntime of ['kubernetes', 'docker']) {
    const removed = [];
    t.mock.method(runtime, 'remove', async (_config, ref) => removed.push(ref.runtimeName));
    t.mock.method(db, 'dropDatabase', async (_name, options) => assert.equal(options.strict, true));
    t.mock.method(db, 'releasePreparedCloneSource', async () => {});
    assert.deepEqual(await gc.cleanupRunResources({ ...config, appRuntime }, { id, app_slug: 'demo' }), []);
    const prefix = appRuntime === 'kubernetes' ? 'sv-app-2147482999-' : 'usernode-app-';
    assert.ok(removed.includes(`${prefix}homeroom-shots-aaaaaaaaaaaaaaaa`));
    assert.ok(removed.includes(`${prefix}homeroom-evidence-aaaaaaaaaaaaaaaa`));
    assert.equal(new Set(removed).size, 6);
    t.mock.restoreAll();
  }
});

test('legacy API/database failures and fixture failures keep cleanup incomplete', async (t) => {
  const removed = [];
  t.mock.method(runtime, 'remove', async (_config, ref) => {
    removed.push(ref.runtimeName);
    if (ref.runtimeName === 'sv-evidence-aaaaaaaaaaaaaaaa-b') throw new Error('API unavailable');
    if (ref.runtimeName.startsWith('sv-app-') && ref.runtimeName.includes('-shots-')) throw new Error('fixture deletion failed');
  });
  t.mock.method(db, 'dropDatabase', async (name, options) => {
    assert.equal(options.strict, true);
    if (name === db.legacyShotsDbName('demo', id, 'head')) throw new Error('database unavailable');
  });
  t.mock.method(db, 'releasePreparedCloneSource', async () => {});
  const errors = await gc.cleanupRunResources(config, { id, app_slug: 'demo' });
  assert.deepEqual(errors.map((e) => e.message), ['API unavailable', 'database unavailable', 'fixture deletion failed']);
  assert.equal(removed.length, 6, 'a failure must not prevent the other resources being removed');
});

test('a Docker container surviving removal is a cleanup failure, not success', async (t) => {
  t.mock.method(runtime, 'remove', async () => ({ removed: false, error: 'container busy' }));
  t.mock.method(db, 'dropDatabase', async () => {});
  t.mock.method(db, 'releasePreparedCloneSource', async () => {});
  const errors = await gc.cleanupRunResources({ appRuntime: 'docker' }, { id, app_slug: 'demo' });
  assert.equal(errors.length, 6);
  assert.ok(errors.every((error) => error.message === 'container busy'));
  const pair = { runId: id, sides: {
    base: { runtimeName: 'base' }, head: { runtimeName: 'head' },
  }, hostedFixtureRef: { runtimeKind: 'docker', runtimeName: 'fixture' } };
  const result = await environment.cleanupPair({ appRuntime: 'docker' }, pair);
  assert.equal(result.cleaned, false);
  assert.equal(result.errors.length, 3);
});

test('terminal cleanup rotates failed attempts and marks only successful runs complete', async () => {
  const rows = [
    { id: '1'.repeat(32), state: 'cancelled', failure_code: 'superseded', app_slug: 'demo' },
    { id: '2'.repeat(32), state: 'stale', app_slug: 'demo', trace_summary: { cleanupComplete: true } },
    { id: '3'.repeat(32), state: 'verified', app_slug: 'demo' },
  ];
  const updates = [];
  let selection;
  const pool = { query: async (sql, params) => {
    if (sql.includes('SELECT r.*') && sql.includes("WHERE r.state IN ('verified'")) {
      selection = { sql, params };
      return { rows };
    }
    if (sql.includes('UPDATE shot_runs')) updates.push({ sql, params });
    return { rows: [], rowCount: 1 };
  } };
  const attempted = [];
  const result = await gc.recoverInterrupted(config, pool, { cleanup: async (_config, run) => {
    attempted.push(run.id);
    if (run.id === rows[0].id) throw new Error('transient API failure');
    return [];
  } });
  assert.deepEqual(attempted, rows.map((r) => r.id));
  assert.equal(result.cleanupRetried, 2);
  assert.deepEqual(updates.filter((u) => u.sql.includes("'cleanupComplete', true")).map((u) => u.params),
    rows.slice(1).map((r) => [r.id, environment.RESOURCE_CLEANUP_VERSION]));
  assert.equal(updates.filter((u) => u.sql.includes("'cleanupAttemptAt'")).length, 3);
  assert.doesNotMatch(selection.sql, /failure_code\s*=/);
  assert.match(selection.sql, /'verified','failed','stale','cancelled','not_required','overridden'/);
  assert.match(selection.sql, /ORDER BY COALESCE.*cleanupAttemptAt/);
  assert.equal(selection.params[1], environment.RESOURCE_CLEANUP_VERSION);
  assert.ok(selection.params[2] >= 300_000, 'allow in-process cleanup to settle');
});

const now = Date.parse('2026-10-06T12:00:00Z');
const old = new Date(now - 86_400_000).toISOString();
function ref(token, createdAt = old) {
  return { runId: token.repeat(32), sessionId: 42, runtimeKind: 'kubernetes',
    runtimeName: `sv-shots-${token.repeat(16)}-b`, createdAt };
}

test('inventory removes terminal and missing-row runtimes, preserving live and recent runs', async () => {
  const inventory = ['a', 'b', 'c', 'd', 'e', 'f'].map((token) => ref(token));
  inventory.push(ref('0', new Date(now - 60_000).toISOString()), ref('1', null));
  const removed = [];
  const rows = [
    { id: inventory[0].runId, session_id: 42, state: 'stale', updated_at: old },
    // b's row disappeared with its session.
    { id: inventory[2].runId, session_id: 42, state: 'exploring', updated_at: old },
    { id: inventory[3].runId, session_id: 42, state: 'verified', updated_at: new Date(now - 60_000) },
    { id: inventory[4].runId, session_id: 99, state: 'failed', updated_at: old },
    { id: inventory[5].runId, session_id: 42, state: 'verified', updated_at: old },
  ];
  const result = await gc.sweepOrphanRuntimes(config, { query: async () => ({ rows }) }, {
    now, list: async () => inventory, remove: async (_config, candidate) => removed.push(candidate.runId),
  });
  assert.deepEqual(removed, ['a', 'b', 'f'].map((token) => token.repeat(32)));
  assert.deepEqual(result, { examined: 6, removed: 3, failed: 0 });
});

test('inventory failures cannot turn unknown run state into permission to delete', async () => {
  let removed = 0;
  await assert.rejects(gc.sweepOrphanRuntimes(config, { query: async () => { throw new Error('DB offline'); } }, {
    now, list: async () => [ref('a')], remove: async () => { removed += 1; },
  }), /DB offline/);
  await assert.rejects(gc.sweepOrphanRuntimes(config, { query: async () => { throw new Error('must not query'); } }, {
    now, list: async () => { throw new Error('API offline'); }, remove: async () => { removed += 1; },
  }), /API offline/);
  assert.equal(removed, 0);
});

test('inventory bounds removal attempts and isolates API failures', async () => {
  const attempts = [];
  const result = await gc.sweepOrphanRuntimes(config, { query: async () => ({ rows: [] }) }, {
    now, limit: 2, list: async () => ['a', 'b', 'c'].map((token) => ref(token)),
    remove: async (_config, candidate) => {
      attempts.push(candidate.runId);
      if (attempts.length === 1) throw new Error('API timeout');
    },
  });
  assert.equal(attempts.length, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.failed, 1);
});

test('metadata retention keeps the run until versioned resource cleanup succeeds', async () => {
  const queries = [];
  await gc.prune({ query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 0 }; } });
  const deletion = queries.find((q) => q.sql.includes('DELETE FROM shot_runs'));
  assert.match(deletion.sql, /'cleanupComplete', true, 'cleanupVersion', \$2::int/);
  assert.equal(deletion.params[1], environment.RESOURCE_CLEANUP_VERSION);
});
