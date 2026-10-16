'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const gc = require('../src/services/shots-gc');

test('retention uses configured windows and never deletes the current session-owned run', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rowCount: 0, rows: [] };
    },
  };
  await gc.prune(pool, {
    shots: { failedArtifactRetentionHours: 6, failedMetadataRetentionDays: 45 },
  });
  assert.deepEqual(calls.map((call) => call.params[0]), [6, gc.ROLLBACK_MEDIA_DAYS, 45]);
  assert.match(calls[2].sql, /NOT EXISTS[\s\S]*shots_run_id = r\.id/);
});

test('orphan checkout sweep removes only old, inactive, tightly named shots directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shots-gc-test-'));
  try {
    const active = 'usernode-shots-aaaaaaaa-active';
    const orphan = 'usernode-shots-bbbbbbbb-orphan';
    // A checkout the previous release made, named before the rename.
    const legacy = 'usernode-evidence-cccccccc-orphan';
    const unrelated = 'usernode-shots-bad';
    const names = [active, orphan, legacy, unrelated];
    await Promise.all(names.map((name) => fs.mkdir(path.join(root, name))));
    const old = new Date(Date.now() - 120_000);
    await Promise.all(names.map((name) => fs.utimes(path.join(root, name), old, old)));
    const pool = { query: async () => ({ rows: [{ id: 'aaaaaaaa' + '0'.repeat(24) }] }) };
    const result = await gc.sweepOrphanCheckouts(pool, { maxAgeMs: 60_000, tmpDir: root });
    assert.equal(result.removed, 2);
    assert.deepEqual((await fs.readdir(root)).sort(), [active, unrelated].sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cleanup of an interrupted run also removes what the previous release named it', async () => {
  const applicationRuntime = require('../src/services/application-runtime');
  const dbManager = require('../src/services/db-manager');
  const saved = { mode: applicationRuntime.mode, remove: applicationRuntime.remove, drop: dbManager.dropDatabase,
    release: dbManager.releasePreparedCloneSource };
  const removed = [];
  const dropped = [];
  applicationRuntime.mode = () => 'kubernetes';
  applicationRuntime.remove = async (_config, ref) => {
    removed.push(ref.runtimeName);
    // The runtime adapter already treats 404 as a successful no-op.
  };
  dbManager.dropDatabase = async (name) => { dropped.push(name); };
  dbManager.releasePreparedCloneSource = async () => {};
  try {
    const runId = 'd'.repeat(32);
    const errors = await gc.cleanupRunResources({ appRuntime: 'kubernetes' }, { id: runId, app_slug: 'demo' });
    assert.deepEqual(errors, [], 'a legacy name that is not there is not a cleanup failure');
    assert.deepEqual(removed, [
      'sv-shots-dddddddddddddddd-b', 'sv-evidence-dddddddddddddddd-b',
      'sv-shots-dddddddddddddddd-h', 'sv-evidence-dddddddddddddddd-h',
      'sv-app-2147482999-homeroom-shots-dddddddddddddddd',
      'sv-app-2147482999-homeroom-evidence-dddddddddddddddd',
    ]);
    assert.deepEqual(dropped.filter((name) => /_evidence_/.test(name)), [
      dbManager.legacyShotsDbName('demo', runId, 'base'), dbManager.legacyShotsDbName('demo', runId, 'head'),
    ]);
    assert.equal(dropped.filter((name) => /_shots_/.test(name)).length, 2);
  } finally {
    applicationRuntime.mode = saved.mode;
    applicationRuntime.remove = saved.remove;
    dbManager.dropDatabase = saved.drop;
    dbManager.releasePreparedCloneSource = saved.release;
  }
});
