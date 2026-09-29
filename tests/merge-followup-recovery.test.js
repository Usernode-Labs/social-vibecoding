const test = require('node:test');
const assert = require('node:assert/strict');
const recovery = require('../src/services/merge-followup-recovery');

const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const BASE = {
  id: 9, session_id: 42, pr_number: 123, merge_commit_sha: SHA,
  slug: 'demo', repo_url: 'https://github.com/org/demo', self_hosted: false,
  main_sha: 'c'.repeat(40), main_check_sha: null, main_check_state: null,
};

function fixture(row, { head = SHA, rebuildResult = null, rebuildError = null, writeCount = 1 } = {}) {
  const calls = { sql: [], rebuild: [], check: [], head: [] };
  const pool = {
    async query(sql, params = []) {
      calls.sql.push({ sql, params });
      if (/WITH latest AS/.test(sql)) return { rows: [row] };
      if (/UPDATE apps SET container_id/.test(sql)) return { rowCount: writeCount, rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const opts = {
    pool, enabled: () => true,
    getMain: async (owner, repo) => { calls.head.push([owner, repo]); return head; },
    rebuild: async (_config, app, options) => {
      calls.rebuild.push({ app, options });
      if (rebuildError) throw rebuildError;
      return rebuildResult || { sha: head, containerId: 'running-container' };
    },
    check: async (_config, _pool, options) => { calls.check.push(options); },
  };
  return { calls, opts };
}

test('a confirmed merge with missing delivery and check resumes both once', async () => {
  const { calls, opts } = fixture({ ...BASE });
  const result = await recovery.recover({}, opts);
  await result.done;
  assert.deepEqual([result.scanned, result.delivered, result.checks], [1, 1, 1]);
  assert.equal(calls.rebuild[0].options.reuseRunningRevision, SHA);
  assert.deepEqual(calls.check[0].session, { id: 42, pr_number: 123 });
  assert.equal(calls.check[0].mergeSha, SHA);
  const saved = calls.sql.find(({ sql }) => /UPDATE apps SET container_id/.test(sql));
  assert.deepEqual(saved.params, ['running-container', SHA, 123, 9, BASE.main_sha]);
});

test('a live finalizer keeps recovery away from its external effects', async () => {
  const { calls, opts } = fixture({ ...BASE });
  let released = false;
  opts.pool.connect = async () => ({
    query: async () => ({ rows: [{ acquired: false }] }),
    release: () => { released = true; },
  });
  const result = await recovery.recover({}, opts);
  await result.done;
  assert.equal(released, true);
  assert.equal(calls.rebuild.length, 0);
  assert.equal(calls.check.length, 0);
});

test('completed effects are observed and not repeated', async () => {
  const { calls, opts } = fixture({ ...BASE, main_sha: SHA, main_check_sha: SHA, main_check_state: 'passing' });
  const result = await recovery.recover({}, opts);
  await result.done;
  assert.deepEqual([result.delivered, result.checks], [0, 0]);
  assert.equal(calls.rebuild.length, 0);
  assert.equal(calls.check.length, 0);
});

test('a merged PR is recovered even when GitHub did not return its merge SHA to the session', async () => {
  const { calls, opts } = fixture({ ...BASE, merge_commit_sha: null });
  const result = await recovery.recover({}, opts);
  await result.done;
  assert.equal(result.delivered, 1);
  assert.equal(calls.check.length, 1);
  assert.equal(calls.check[0].session, null);
  assert.match(calls.sql[0].sql, /cs\.pr_number IS NOT NULL/);
});

test('a newer main is recovered as the current tree without attributing delivery to the older PR', async () => {
  const { calls, opts } = fixture({ ...BASE }, { head: NEWER });
  const result = await recovery.recover({}, opts);
  await result.done;
  assert.equal(calls.check[0].mergeSha, NEWER);
  assert.equal(calls.check[0].session, null);
  assert.equal(calls.sql.find(({ sql }) => /UPDATE apps SET container_id/.test(sql)).params[2], null);
});

test('a concurrent newer delivery is not overwritten by recovery of an older row snapshot', async () => {
  const { calls, opts } = fixture({ ...BASE }, { writeCount: 0 });
  const result = await recovery.recover({}, opts);
  await result.done;
  assert.equal(result.delivered, 0);
  assert.match(calls.sql.find(({ sql }) => /UPDATE apps SET container_id/.test(sql)).sql,
    /main_sha IS NOT DISTINCT FROM \$5/);
});

test('failed delivery leaves source merged and does not suppress the independent check', async () => {
  const { calls, opts } = fixture({ ...BASE }, { rebuildError: new Error('missing secret') });
  const result = await recovery.recover({}, opts);
  await result.done;
  assert.equal(result.delivered, 0);
  assert.equal(result.checks, 1);
  assert.equal(calls.sql.filter(({ sql }) => /UPDATE apps/.test(sql)).length, 0);
});

test('self-hosted delivery belongs to release watch, while its main check is recovered', async () => {
  const { calls, opts } = fixture({ ...BASE, self_hosted: true });
  const result = await recovery.recover({}, opts);
  await result.done;
  assert.equal(calls.rebuild.length, 0);
  assert.equal(calls.check.length, 1);
});
