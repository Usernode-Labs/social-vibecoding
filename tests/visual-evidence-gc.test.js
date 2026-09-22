'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const gc = require('../src/services/visual-evidence-gc');

test('recovery starts settled intent-only proposals once for their current checked head', async () => {
  const head = 'a'.repeat(40);
  const rows = [
    { id: 42, source: 'imported', imported_pr_head_sha: head, checks_commit_sha: head },
    { id: 43, source: 'imported', imported_pr_head_sha: 'b'.repeat(40), checks_commit_sha: head },
    { id: 44, source: 'imported', imported_pr_head_sha: 'short', checks_commit_sha: 'short' },
  ];
  const calls = [];
  let queryText;
  const pool = { query: async (sql) => {
    queryText = String(sql);
    return { rows };
  } };
  const result = await gc.recoverUnstarted({ visualEvidence: { execute: true } }, pool, {
    schedule: async (_config, options) => {
      calls.push(options);
      return { scheduled: true };
    },
  });
  assert.deepEqual(result, { examined: 3, scheduled: 1 });
  assert.deepEqual(calls.map(({ sessionId, headSha, trigger }) => ({ sessionId, headSha, trigger })),
    [{ sessionId: 42, headSha: head, trigger: 'planned-recovery' }]);
  assert.match(queryText, /visual_evidence_run_id IS NULL/);
  assert.match(queryText, /cs\.status IN \('active', 'promoted'\)/);
  assert.match(queryText, /cs\.check_state IN \('passing', 'failing', 'error', 'skipped'\)/);
  assert.match(queryText, /recoveryAttemptAt/);
});

test('recovery also starts an import-time author plan whose checks settled after a restart', async () => {
  const head = 'a'.repeat(40);
  const queries = [];
  const calls = [];
  const pool = { query: async (sql) => {
    queries.push(String(sql));
    return { rows: [{ id: 45, source: 'imported', imported_pr_head_sha: head,
      checks_commit_sha: head }] };
  } };
  const result = await gc.recoverUnstarted({ visualEvidence: { execute: true } }, pool, {
    schedule: async (_config, options) => { calls.push(options); return { scheduled: true }; },
  });
  assert.deepEqual(result, { examined: 1, scheduled: 1 });
  assert.equal(calls[0].sessionId, 45);
  assert.match(queries[0], /LEFT JOIN visual_evidence_runs r ON r\.id = cs\.visual_evidence_run_id/);
  assert.match(queries[0], /r\.state = 'planned' AND r\.author_plan IS NOT NULL/);
  const interrupted = [];
  await gc.recoverInterrupted({ visualEvidence: {} }, { query: async (sql) => {
    interrupted.push(String(sql));
    return { rows: [] };
  } });
  assert.match(interrupted[0], /NOT \(r\.state = 'planned' AND r\.author_plan IS NOT NULL\)/);
});

test('an unlaunchable planned claim is deferred so it cannot starve later claims', async () => {
  const head = 'a'.repeat(40);
  const writes = [];
  const pool = { query: async (sql, params) => {
    if (String(sql).startsWith('SELECT cs.id')) {
      return { rows: [{ id: 42, source: 'imported', imported_pr_head_sha: head, checks_commit_sha: head }] };
    }
    writes.push({ sql: String(sql), params });
    return { rows: [], rowCount: 1 };
  } };
  const result = await gc.recoverUnstarted({ visualEvidence: { execute: true } }, pool, {
    schedule: async () => ({ scheduled: false, reason: 'missing_base' }),
  });
  assert.deepEqual(result, { examined: 1, scheduled: 0 });
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /recoveryAttemptAt/);
  assert.equal(writes[0].params[0], 42);
});

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
