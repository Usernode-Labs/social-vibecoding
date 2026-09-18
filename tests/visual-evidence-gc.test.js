'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const gc = require('../src/services/visual-evidence-gc');

test('retention uses configured windows and never deletes the current session-owned run', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rowCount: 0, rows: [] };
    },
  };
  await gc.prune(pool, {
    visualEvidence: { failedArtifactRetentionHours: 6, failedMetadataRetentionDays: 45 },
  });
  assert.deepEqual(calls.map((call) => call.params[0]), [6, gc.ROLLBACK_MEDIA_DAYS, 45]);
  assert.match(calls[2].sql, /NOT EXISTS[\s\S]*visual_evidence_run_id = r\.id/);
});

test('orphan checkout sweep removes only old, inactive, tightly named evidence directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-evidence-gc-test-'));
  try {
    const active = 'usernode-evidence-aaaaaaaa-active';
    const orphan = 'usernode-evidence-bbbbbbbb-orphan';
    const unrelated = 'usernode-evidence-bad';
    await Promise.all([active, orphan, unrelated].map((name) => fs.mkdir(path.join(root, name))));
    const old = new Date(Date.now() - 120_000);
    await Promise.all([active, orphan, unrelated].map((name) => fs.utimes(path.join(root, name), old, old)));
    const pool = { query: async () => ({ rows: [{ id: 'aaaaaaaa' + '0'.repeat(24) }] }) };
    const result = await gc.sweepOrphanCheckouts(pool, { maxAgeMs: 60_000, tmpDir: root });
    assert.equal(result.removed, 1);
    assert.deepEqual((await fs.readdir(root)).sort(), [active, unrelated].sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
