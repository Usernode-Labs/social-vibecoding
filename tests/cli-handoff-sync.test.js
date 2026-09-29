'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileCliHandoffSync } = require('../src/services/cli-handoff-sync');

const OLD = '1'.repeat(40);
const NEW = '2'.repeat(40);
const OTHER = '3'.repeat(40);

function row(overrides = {}) {
  return {
    id: 41,
    app_id: 10,
    app_slug: 'usernode-2d5619',
    app_name: 'Homeroom',
    repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
    source: 'cli_handoff',
    status: 'active',
    branch_name: 'dev/cli-u6-work',
    handoff_head_sha: OLD,
    handoff_uploaded_sha: OLD,
    checks_commit_sha: OLD,
    reviewed_head_sha: null,
    ...overrides,
  };
}

function activeHarness({ updateRows = null, pendingError = null } = {}) {
  const calls = [];
  const pending = [];
  const notified = [];
  const pipelines = [];
  let released = 0;
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/UPDATE chat_sessions/.test(sql)) {
        return {
          rows: updateRows == null
            ? [{ ...row(), handoff_head_sha: NEW, handoff_uploaded_sha: NEW, checks_commit_sha: NEW }]
            : updateRows,
        };
      }
      if (/SELECT status, branch_name/.test(sql)) return { rows: [row()] };
      return { rows: [] };
    },
  };
  const deps = {
    github: { async getBranchSha() { return NEW; } },
    visuals: {
      async setChecksPending(...args) {
        pending.push(args);
        if (pendingError) throw pendingError;
        return true;
      },
      notifyChecksPending(...args) { notified.push(args); },
    },
    pipeline: {
      beginHandoffPipeline() { return () => { released += 1; }; },
      startHandoffPipeline(...args) { pipelines.push(args); },
    },
  };
  return { pool, deps, calls, pending, notified, pipelines, released: () => released };
}

test('active CLI handoff adopts every managed pin and starts sync-main checks', async () => {
  const h = activeHarness();
  const result = await reconcileCliHandoffSync({
    config: {}, pool: h.pool, session: row(), newHead: NEW,
  }, h.deps);

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  const adoption = h.calls.find((call) => /UPDATE chat_sessions/.test(call.sql));
  assert.match(adoption.sql, /handoff_head_sha = \$1/);
  assert.match(adoption.sql, /handoff_uploaded_sha = \$1/);
  assert.match(adoption.sql, /checks_commit_sha = \$1/);
  assert.match(adoption.sql, /handoff_head_sha IS NOT DISTINCT FROM \$4/);
  assert.match(adoption.sql, /handoff_uploaded_sha IS NOT DISTINCT FROM \$5/);
  assert.match(adoption.sql, /checks_commit_sha IS NOT DISTINCT FROM \$6/);
  assert.deepEqual(adoption.params, [NEW, 41, 'dev/cli-u6-work', OLD, OLD, OLD]);
  assert.deepEqual(h.pending[0].slice(1), [41, NEW, 'building', 'sync-main']);
  assert.deepEqual(h.notified[0], [41, NEW, 'building', 'sync-main']);
  assert.equal(h.pipelines.length, 1);
  assert.equal(h.pipelines[0][4], NEW);
  assert.equal(h.pipelines[0][6], 'sync-main');
  assert.equal(h.released(), 0, 'the detached pipeline owns its release');
});

test('remote branch movement refuses adoption before any proposal write', async () => {
  const h = activeHarness();
  h.deps.github.getBranchSha = async () => OTHER;
  const result = await reconcileCliHandoffSync({
    config: {}, pool: h.pool, session: row(), newHead: NEW,
  }, h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'branch_moved');
  assert.equal(h.calls.length, 0);
  assert.equal(h.pipelines.length, 0);
});

test('a concurrent managed-head change loses the database CAS and starts no checks', async () => {
  const h = activeHarness({ updateRows: [] });
  const result = await reconcileCliHandoffSync({
    config: {}, pool: h.pool, session: row(), newHead: NEW,
  }, h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'session_state_changed');
  assert.equal(h.pending.length, 0);
  assert.equal(h.pipelines.length, 0);
});

test('already-current CLI pins make an already-synced retry an idempotent no-op', async () => {
  const h = activeHarness();
  const current = row({
    handoff_head_sha: NEW,
    handoff_uploaded_sha: NEW,
    checks_commit_sha: NEW,
  });
  const result = await reconcileCliHandoffSync({
    config: {}, pool: h.pool, session: current, newHead: null,
  }, h.deps);
  assert.deepEqual(result, {
    ok: true, applied: false, unchanged: true, headSha: NEW,
  });
  assert.equal(h.calls.length, 0);
  assert.equal(h.pipelines.length, 0);
});

test('an auxiliary phase-stamp failure cannot strand the adopted active head', async () => {
  const h = activeHarness({ pendingError: new Error('database timeout') });
  const result = await reconcileCliHandoffSync({
    config: {}, pool: h.pool, session: row(), newHead: NEW,
  }, h.deps);

  assert.equal(result.ok, true);
  assert.equal(result.checksStarted, true);
  assert.equal(h.pipelines.length, 1);
  assert.equal(h.pipelines[0][4], NEW);
  assert.equal(h.pipelines[0][6], 'sync-main');
});

test('promoted pins are not current until the reviewed revision is current too', async () => {
  const current = row({
    status: 'promoted',
    handoff_head_sha: NEW,
    handoff_uploaded_sha: NEW,
    checks_commit_sha: NEW,
    reviewed_head_sha: OLD,
  });
  let reconciled = false;
  const pool = {
    async query(sql) {
      if (/UPDATE chat_sessions/.test(sql)) {
        return { rows: [{ ...current, reviewed_head_sha: NEW }] };
      }
      return { rows: [] };
    },
  };
  const result = await reconcileCliHandoffSync({
    config: {}, pool, session: current, newHead: NEW,
  }, {
    github: { async getBranchSha() { return NEW; } },
    votes: {
      async reconcileNativeReviewedHead() {
        reconciled = true;
        return { headSha: NEW, epoch: 3, updated: true, kind: 'mechanical' };
      },
    },
    prImportSync: { async rerunChecksForNewHead() {} },
  });

  assert.equal(reconciled, true);
  assert.equal(result.ok, true);
});

test('promoted CLI handoff preserves reconciliation epoch and rebuilds with sync-main', async () => {
  const calls = [];
  const reruns = [];
  const session = row({ status: 'promoted', reviewed_head_sha: OLD });
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/UPDATE chat_sessions/.test(sql)) {
        return { rows: [{ ...session, reviewed_head_sha: NEW, checks_commit_sha: NEW }] };
      }
      return { rows: [] };
    },
  };
  let reconcileArgs = null;
  const result = await reconcileCliHandoffSync({
    config: {}, pool, session, newHead: NEW,
  }, {
    github: { async getBranchSha() { return NEW; } },
    votes: {
      async reconcileNativeReviewedHead(args) {
        reconcileArgs = args;
        return { headSha: NEW, epoch: 7, updated: true, kind: 'mechanical' };
      },
    },
    prImportSync: {
      async rerunChecksForNewHead(args) { reruns.push(args); },
    },
  });
  await Promise.resolve();

  assert.equal(reconcileArgs.deferChecks, true);
  assert.equal(result.approvalEpoch, 7);
  assert.equal(result.moveKind, 'mechanical');
  const adoption = calls.find((call) => /UPDATE chat_sessions/.test(call.sql));
  assert.doesNotMatch(adoption.sql, /approval_epoch/,
    'approval semantics belong exclusively to native-head reconciliation');
  assert.equal(reruns.length, 1);
  assert.equal(reruns[0].newHead, NEW);
  assert.equal(reruns[0].trigger, 'sync-main');
});
