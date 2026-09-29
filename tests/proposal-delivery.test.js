'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDelivery, SOURCE_REVISION_LABEL } = require('../src/services/proposal-delivery');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const ancestors = new Map([[A, new Set([B, C])], [B, new Set([C])]]);

function fixture() {
  let observed = { status: 'running', labels: { [SOURCE_REVISION_LABEL]: A } };
  let deploying = false;
  let failure = null;
  let mirrorWorks = true;
  const app = { id: 5, slug: 'child', repo_url: 'https://github.com/example/child',
    last_failure: null };
  const pool = { query: async () => ({ rows: [{ id: 12, merge_commit_sha: B }] }) };
  const delivery = createDelivery({
    runtime: {
      productionRef: () => ({ runtimeKind: 'docker', runtimeName: 'child' }),
      inspect: async () => observed,
    },
    progress: { read: () => ({ deploying }) },
    parseRepo: () => ({ owner: 'example', repo: 'child' }),
    git: {
      ensureMirror: async () => { if (!mirrorWorks) throw new Error('unavailable'); return '/mirror'; },
      defaultBranchSha: async () => C,
      isAncestor: async (_dir, base, head) => ancestors.get(base)?.has(head) || false,
    },
  });
  const read = async (mergeCommit = B) => {
    app.last_failure = failure;
    const rows = [{ id: 12, status: 'merged', merge_commit_sha: mergeCommit }];
    const summary = await delivery.annotateChild({}, pool, app, rows);
    return { row: rows[0], summary };
  };
  return {
    read,
    observe: value => { observed = value; },
    deploying: value => { deploying = value; },
    failure: value => { failure = value; },
    mirrorWorks: value => { mirrorWorks = value; },
  };
}

test('a failed rebuild before replacement never turns a merge into delivery', async () => {
  const f = fixture();
  f.failure({ sha: B, stage: 'other', reason: 'missing required secret' });
  const { row, summary } = await f.read();
  assert.equal(row.deployment_state, 'failed');
  assert.equal(summary.state, 'failed');
  assert.equal(summary.runningSha, A);
  assert.equal(row.deployment_kind, 'child');
});

test('a retry is pending until the running revision is observed', async () => {
  const f = fixture();
  f.failure({ sha: B });
  f.deploying(true);
  assert.equal((await f.read()).row.deployment_state, 'pending');
  f.deploying(false);
  f.failure(null);
  f.observe({ status: 'running', labels: { [SOURCE_REVISION_LABEL]: B } });
  assert.equal((await f.read()).row.deployment_state, 'deployed');
});

test('a later main release confirms every merge it contains', async () => {
  const f = fixture();
  f.observe({ status: 'running', labels: { [SOURCE_REVISION_LABEL]: C } });
  assert.equal((await f.read(A)).row.deployment_state, 'deployed');
  assert.equal((await f.read(B)).row.deployment_state, 'deployed');
  assert.equal((await f.read(D)).row.deployment_state, 'unknown');
});

test('a newer failed attempt includes earlier undelivered merges', async () => {
  const f = fixture();
  f.failure({ sha: C });
  assert.equal((await f.read(B)).row.deployment_state, 'failed');
  f.failure(null);
  assert.equal((await f.read(B)).row.deployment_state, 'pending');
});

test('missing, unready and uncertain runtime evidence never claims delivery', async () => {
  const f = fixture();
  f.observe(null);
  assert.equal((await f.read()).row.deployment_state, 'unknown');
  f.observe({ status: 'running', rolloutReady: false,
    labels: { [SOURCE_REVISION_LABEL]: B } });
  assert.equal((await f.read()).row.deployment_state, 'unknown');
  f.observe({ status: 'running', labels: { [SOURCE_REVISION_LABEL]: C } });
  f.mirrorWorks(false);
  assert.equal((await f.read()).row.deployment_state, 'unknown');
  f.observe({ status: 'running', labels: { [SOURCE_REVISION_LABEL]: B } });
  assert.equal((await f.read()).row.deployment_state, 'deployed',
    'the exact observed revision needs no ancestry lookup');
  assert.equal((await f.read('not-a-commit')).row.deployment_state, 'unknown');
});

test('an older keyset page still reports the latest merge in its summary', async () => {
  const f = fixture();
  const { row, summary } = await f.read(A);
  assert.equal(row.deployment_state, 'deployed');
  assert.equal(summary.state, 'pending');
});
