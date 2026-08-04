'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const github = require('../src/services/github');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function install(handler) {
  const calls = [];
  github._setOctokitFactoryForTests(() => ({
    request: async (route, params) => {
      calls.push({ route, params });
      return handler(route, params, calls);
    },
  }));
  return calls;
}

test.afterEach(() => github._setOctokitFactoryForTests(null));

test('ensureBranchAtSha validates the commit and creates the exact ref', async () => {
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) return { data: { sha: BASE } };
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      const err = new Error('not found'); err.status = 404; throw err;
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/refs')) return { data: {} };
    throw new Error(`unexpected ${route}`);
  });

  const result = await github.ensureBranchAtSha('acme', 'demo', 'dev/cli-u1-request', BASE);
  assert.deepEqual(result, { sha: BASE, created: true });
  assert.equal(calls[2].params.ref, 'refs/heads/dev/cli-u1-request');
  assert.equal(calls[2].params.sha, BASE);
});

test('ensureBranchAtSha refuses to reuse an orphan branch at a different SHA', async () => {
  install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) return { data: { sha: BASE } };
    return { data: { object: { sha: HEAD } } };
  });
  await assert.rejects(
    github.ensureBranchAtSha('acme', 'demo', 'dev/cli-u1-request', BASE),
    (err) => err.code === 'branch_conflict'
  );
});

test('ensureBranchAtSha treats a concurrent matching ref creation as an idempotent retry', async () => {
  let refReads = 0;
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) return { data: { sha: BASE } };
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      refReads += 1;
      if (refReads === 1) {
        const err = new Error('not found'); err.status = 404; throw err;
      }
      return { data: { object: { sha: BASE } } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/refs')) {
      const err = new Error('Reference already exists'); err.status = 422; throw err;
    }
    throw new Error(`unexpected ${route}`);
  });

  const result = await github.ensureBranchAtSha('acme', 'demo', 'dev/cli-u1-request', BASE);
  assert.deepEqual(result, { sha: BASE, created: false });
  assert.equal(calls.filter((call) => call.route.startsWith('GET /repos/{owner}/{repo}/git/ref/')).length, 2);
});

test('advanceBranchToSha proves ancestry and sends a non-forced ref update', async () => {
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: BASE } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/compare/')) {
      return { data: { status: 'ahead', ahead_by: 1, behind_by: 0, merge_base_commit: { sha: BASE } } };
    }
    if (route.startsWith('PATCH /repos/{owner}/{repo}/git/refs/')) {
      return { data: { object: { sha: HEAD } } };
    }
    throw new Error(`unexpected ${route}`);
  });

  const result = await github.advanceBranchToSha('acme', 'demo', 'dev/cli-u1-request', HEAD);
  assert.deepEqual(result, { previousSha: BASE, sha: HEAD, updated: true });
  const patch = calls.find((call) => call.route.startsWith('PATCH '));
  assert.equal(patch.params.sha, HEAD);
  assert.equal(patch.params.force, false);
});

test('getBranchSha reads the exact managed branch ref', async () => {
  const calls = install(async () => ({ data: { object: { sha: HEAD } } }));
  assert.equal(await github.getBranchSha('acme', 'demo', 'dev/cli-u1-request'), HEAD);
  assert.equal(calls[0].params.ref, 'heads/dev/cli-u1-request');
});

test('advanceBranchToSha rejects a divergent head without updating the ref', async () => {
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: BASE } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/compare/')) {
      return { data: { status: 'diverged', ahead_by: 1, behind_by: 1, merge_base_commit: { sha: 'c'.repeat(40) } } };
    }
    throw new Error(`unexpected ${route}`);
  });

  await assert.rejects(
    github.advanceBranchToSha('acme', 'demo', 'dev/cli-u1-request', HEAD),
    (err) => err.code === 'non_fast_forward'
  );
  assert.equal(calls.some((call) => call.route.startsWith('PATCH ')), false);
});
