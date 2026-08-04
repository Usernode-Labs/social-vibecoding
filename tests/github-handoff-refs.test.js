'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const github = require('../src/services/github');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const BLOB = 'd'.repeat(40);
const PLATFORM = 'e'.repeat(40);
const PARENT_TREE = 'f'.repeat(40);

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

test('createProposalCommit reconstructs the exact local tree and advances the bot branch', async () => {
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: BASE } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) {
      return { data: { sha: BASE, tree: { sha: PARENT_TREE }, parents: [] } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/blobs')) {
      return { data: { sha: BLOB } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/trees')) {
      return { data: { sha: TREE } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/commits')) {
      return { data: { sha: PLATFORM } };
    }
    if (route.startsWith('PATCH /repos/{owner}/{repo}/git/refs/')) return { data: {} };
    throw new Error(`unexpected ${route}`);
  });

  const result = await github.createProposalCommit('acme', 'demo', {
    branchName: 'dev/cli-u1-request',
    expectedRemoteParentSha: BASE,
    localParentSha: BASE,
    localParentTreeSha: PARENT_TREE,
    expectedTreeSha: TREE,
    localCommitSha: HEAD,
    message: 'Implement @alice request',
    authoredAt: '2026-08-04T01:02:03+04:00',
    committedAt: '2026-08-04T01:03:04+04:00',
    files: [
      { path: 'src/a.js', mode: '100755', contentBase64: 'aGk=' },
      { path: 'old.js', delete: true },
    ],
  });
  assert.deepEqual(result, {
    sha: PLATFORM, treeSha: TREE, previousSha: BASE, localParentSha: BASE, created: true,
  });
  const tree = calls.find((call) => call.route.startsWith('POST /repos/{owner}/{repo}/git/trees'));
  assert.equal(tree.params.base_tree, PARENT_TREE);
  assert.deepEqual(tree.params.tree, [
    { path: 'src/a.js', mode: '100755', type: 'blob', sha: BLOB },
    { path: 'old.js', mode: '100644', type: 'blob', sha: null },
  ]);
  const commit = calls.find((call) => call.route.startsWith('POST /repos/{owner}/{repo}/git/commits'));
  assert.deepEqual(commit.params.parents, [BASE]);
  assert.equal(commit.params.tree, TREE);
  assert.match(commit.params.message, /Usernode-Local-Commit: b{40}$/);
  assert.doesNotMatch(commit.params.message, /@alice/);
  const update = calls.find((call) => call.route.startsWith('PATCH '));
  assert.equal(update.params.sha, PLATFORM);
  assert.equal(update.params.force, false);
});

test('createProposalCommit rejects a reconstructed tree mismatch before commit or ref mutation', async () => {
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: BASE } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) {
      return { data: { tree: { sha: PARENT_TREE } } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/blobs')) return { data: { sha: BLOB } };
    if (route.startsWith('POST /repos/{owner}/{repo}/git/trees')) {
      return { data: { sha: '1'.repeat(40) } };
    }
    throw new Error(`unexpected ${route}`);
  });
  await assert.rejects(
    github.createProposalCommit('acme', 'demo', {
      branchName: 'dev/cli-u1-request', expectedRemoteParentSha: BASE,
      localParentSha: BASE, localParentTreeSha: PARENT_TREE, expectedTreeSha: TREE,
      localCommitSha: HEAD, message: 'Change', authoredAt: '2026-08-04T00:00:00Z',
      committedAt: '2026-08-04T00:00:01Z',
      files: [{ path: 'a', mode: '100644', contentBase64: '' }],
    }),
    (err) => err.code === 'tree_mismatch'
  );
  assert.equal(calls.some((call) => call.route.startsWith('POST /repos/{owner}/{repo}/git/commits')), false);
  assert.equal(calls.some((call) => call.route.startsWith('PATCH ')), false);
});

test('createProposalCommit requires the local parent tree to equal the remote tip tree', async () => {
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: BASE } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) {
      return { data: { tree: { sha: PARENT_TREE }, parents: [] } };
    }
    throw new Error(`unexpected ${route}`);
  });
  await assert.rejects(
    github.createProposalCommit('acme', 'demo', {
      branchName: 'dev/cli-u1-request', expectedRemoteParentSha: BASE,
      localParentSha: HEAD, localParentTreeSha: '1'.repeat(40), expectedTreeSha: TREE,
      localCommitSha: '2'.repeat(40), message: 'Second local change',
      authoredAt: '2026-08-04T00:00:00Z', committedAt: '2026-08-04T00:00:01Z',
      files: [{ path: 'a', mode: '100644', contentBase64: 'YQ==' }],
    }),
    (err) => err.code === 'parent_tree_mismatch'
  );
  assert.equal(calls.some((call) => call.route.startsWith('POST ')), false);
  assert.equal(calls.some((call) => call.route.startsWith('PATCH ')), false);
});

test('createProposalCommit applies file-directory conflicts in two tree steps', async () => {
  const intermediateTree = '9'.repeat(40);
  let treeCreates = 0;
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: BASE } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) {
      return { data: { tree: { sha: PARENT_TREE }, parents: [] } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/blobs')) {
      return { data: { sha: BLOB } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/trees')) {
      treeCreates += 1;
      return { data: { sha: treeCreates === 1 ? intermediateTree : TREE } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/commits')) {
      return { data: { sha: PLATFORM } };
    }
    if (route.startsWith('PATCH /repos/{owner}/{repo}/git/refs/')) return { data: {} };
    throw new Error(`unexpected ${route}`);
  });

  const result = await github.createProposalCommit('acme', 'demo', {
    branchName: 'dev/cli-u1-request', expectedRemoteParentSha: BASE,
    localParentSha: BASE, localParentTreeSha: PARENT_TREE, expectedTreeSha: TREE,
    localCommitSha: HEAD, message: 'Replace file with directory',
    authoredAt: '2026-08-04T00:00:00Z', committedAt: '2026-08-04T00:00:01Z',
    files: [
      { path: 'config', delete: true },
      { path: 'config/index.js', mode: '100644', contentBase64: 'YQ==' },
    ],
  });

  assert.equal(result.sha, PLATFORM);
  const trees = calls.filter((call) => call.route.startsWith(
    'POST /repos/{owner}/{repo}/git/trees'
  ));
  assert.equal(trees.length, 2);
  assert.equal(trees[0].params.base_tree, PARENT_TREE);
  assert.deepEqual(trees[0].params.tree, [
    { path: 'config', mode: '100644', type: 'blob', sha: null },
  ]);
  assert.equal(trees[1].params.base_tree, intermediateTree);
  assert.deepEqual(trees[1].params.tree, [
    { path: 'config/index.js', mode: '100644', type: 'blob', sha: BLOB },
  ]);
});

test('createProposalCommit continues when local and bot parent SHAs differ but trees match', async () => {
  const nextTree = '1'.repeat(40);
  const localCommit = '2'.repeat(40);
  const nextPlatform = '3'.repeat(40);
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: PLATFORM } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) {
      return { data: { tree: { sha: TREE }, parents: [{ sha: BASE }], message: 'Prior bot commit' } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/blobs')) {
      return { data: { sha: BLOB } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/trees')) {
      return { data: { sha: nextTree } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/commits')) {
      return { data: { sha: nextPlatform } };
    }
    if (route.startsWith('PATCH /repos/{owner}/{repo}/git/refs/')) return { data: {} };
    throw new Error(`unexpected ${route}`);
  });
  const result = await github.createProposalCommit('acme', 'demo', {
    branchName: 'dev/cli-u1-request', expectedRemoteParentSha: PLATFORM,
    localParentSha: HEAD, localParentTreeSha: TREE, expectedTreeSha: nextTree,
    localCommitSha: localCommit, message: 'Second local commit',
    authoredAt: '2026-08-04T00:00:02Z', committedAt: '2026-08-04T00:00:03Z',
    files: [{ path: 'a', mode: '100644', contentBase64: 'Yg==' }],
  });
  assert.deepEqual(result, {
    sha: nextPlatform,
    treeSha: nextTree,
    previousSha: PLATFORM,
    localParentSha: HEAD,
    created: true,
  });
  const commit = calls.find((call) => call.route.startsWith('POST /repos/{owner}/{repo}/git/commits'));
  assert.deepEqual(commit.params.parents, [PLATFORM],
    'the bot commit continues the managed remote chain, not the unavailable local SHA');
});

test('createProposalCommit recognizes an already-created local upload idempotently', async () => {
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: PLATFORM } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) {
      return { data: {
        sha: PLATFORM,
        tree: { sha: TREE },
        parents: [{ sha: BASE }],
        message: `Change\n\nUsernode-Local-Commit: ${HEAD}`,
      } };
    }
    throw new Error(`unexpected ${route}`);
  });
  const result = await github.createProposalCommit('acme', 'demo', {
    branchName: 'dev/cli-u1-request', expectedRemoteParentSha: BASE,
    localParentSha: BASE, localParentTreeSha: PARENT_TREE, expectedTreeSha: TREE,
    localCommitSha: HEAD, message: 'Change', authoredAt: '2026-08-04T00:00:00Z',
    committedAt: '2026-08-04T00:00:01Z', files: [],
  });
  assert.deepEqual(result, {
    sha: PLATFORM, treeSha: TREE, previousSha: BASE, localParentSha: BASE, created: false,
  });
  assert.equal(calls.some((call) => call.route.startsWith('POST ')), false);
  assert.equal(calls.some((call) => call.route.startsWith('PATCH ')), false);
});

test('createProposalCommit recognizes a retry after its head was persisted', async () => {
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: PLATFORM } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) {
      return { data: {
        sha: PLATFORM,
        tree: { sha: TREE },
        parents: [{ sha: BASE }],
        message: `Change\n\nUsernode-Local-Commit: ${HEAD}`,
      } };
    }
    throw new Error(`unexpected ${route}`);
  });

  const result = await github.createProposalCommit('acme', 'demo', {
    branchName: 'dev/cli-u1-request', expectedRemoteParentSha: PLATFORM,
    localParentSha: BASE, localParentTreeSha: PARENT_TREE, expectedTreeSha: TREE,
    localCommitSha: HEAD, message: 'Change', authoredAt: '2026-08-04T00:00:00Z',
    committedAt: '2026-08-04T00:00:01Z', files: [],
  });
  assert.deepEqual(result, {
    sha: PLATFORM, treeSha: TREE, previousSha: BASE, localParentSha: BASE, created: false,
  });
  assert.equal(calls.some((call) => call.route.startsWith('POST ')), false);
  assert.equal(calls.some((call) => call.route.startsWith('PATCH ')), false);
});

test('createProposalCommit does not treat a copied upload marker as a retry', async () => {
  const unrelatedParent = '1'.repeat(40);
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      return { data: { object: { sha: PLATFORM } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) {
      return { data: {
        sha: PLATFORM,
        tree: { sha: TREE },
        parents: [{ sha: unrelatedParent }],
        message: `Change\n\nUsernode-Local-Commit: ${HEAD}`,
      } };
    }
    throw new Error(`unexpected ${route}`);
  });

  await assert.rejects(
    github.createProposalCommit('acme', 'demo', {
      branchName: 'dev/cli-u1-request', expectedRemoteParentSha: BASE,
      localParentSha: BASE, localParentTreeSha: PARENT_TREE, expectedTreeSha: TREE,
      localCommitSha: HEAD, message: 'Change', authoredAt: '2026-08-04T00:00:00Z',
      committedAt: '2026-08-04T00:00:01Z', files: [],
    }),
    (err) => err.code === 'branch_moved'
  );
  assert.equal(calls.some((call) => call.route.startsWith('POST ')), false);
  assert.equal(calls.some((call) => call.route.startsWith('PATCH ')), false);
});

test('createProposalCommit confirms an ambiguous ref response from the live branch tip', async () => {
  let refReads = 0;
  const calls = install(async (route) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) {
      refReads += 1;
      return { data: { object: { sha: refReads === 1 ? BASE : PLATFORM } } };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) {
      return { data: { tree: { sha: PARENT_TREE }, parents: [] } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/blobs')) {
      return { data: { sha: BLOB } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/trees')) {
      return { data: { sha: TREE } };
    }
    if (route.startsWith('POST /repos/{owner}/{repo}/git/commits')) {
      return { data: { sha: PLATFORM } };
    }
    if (route.startsWith('PATCH /repos/{owner}/{repo}/git/refs/')) {
      const err = new Error('response lost'); err.code = 'ECONNRESET'; throw err;
    }
    throw new Error(`unexpected ${route}`);
  });
  const result = await github.createProposalCommit('acme', 'demo', {
    branchName: 'dev/cli-u1-request', expectedRemoteParentSha: BASE,
    localParentSha: BASE, localParentTreeSha: PARENT_TREE, expectedTreeSha: TREE,
    localCommitSha: HEAD, message: 'Change', authoredAt: '2026-08-04T00:00:00Z',
    committedAt: '2026-08-04T00:00:01Z',
    files: [{ path: 'a', mode: '100644', contentBase64: 'YQ==' }],
  });
  assert.equal(result.sha, PLATFORM);
  assert.equal(result.created, true);
  assert.equal(refReads, 2);
  assert.equal(calls.filter((call) => call.route.startsWith('PATCH ')).length, 1);
});
