'use strict';

// services/preview-workflow.js: how [main]'s preview sources reach the
// preview machine, the only path for a preview. A source that names no exact
// head gets the row's pin for its kind, else the branch tip, never 'latest'
// (P-A1, bug 20); one whose head resolves to nothing hands nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};
const submitted = [];
const platform = { submitRevision: async (r) => { submitted.push(r); return { status: 'accepted', reason: null }; } };
stub('../src/workflow/platform.ts', platform);
const tips = new Map();
stub('../src/services/github', { getBranchSha: async (owner, repo, branch) => tips.get(`${owner}/${repo}#${branch}`) ?? null });
const workflow = require('../src/services/preview-workflow');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const pool = { query: async () => ({ rows: [{ repo_url: 'https://github.com/acme/shop' }] }) };

test('an exact head is used as given; otherwise the pin for the row kind, then the branch tip', async () => {
  tips.set('acme/shop#feature', C);
  assert.equal(await workflow.exactHead(pool, { source: null, status: 'active' }, A.toUpperCase()), A);
  assert.equal(await workflow.exactHead(pool, { source: 'imported', imported_pr_head_sha: B, status: 'promoted', reviewed_head_sha: C }, 'latest'), B);
  assert.equal(await workflow.exactHead(pool, { source: null, status: 'promoted', reviewed_head_sha: B }, null), B);
  assert.equal(await workflow.exactHead(pool, { source: 'cli_handoff', status: 'active', handoff_head_sha: B }), B);
  assert.equal(await workflow.exactHead(pool, { source: null, status: 'active', app_id: 2, branch_name: 'feature' }), C);
  const out = await workflow.revision({ pool, session: { id: 1, app_id: 2, status: 'active', branch_name: 'feature' }, source: 'fleet', trigger: 'fleet-maintenance' });
  assert.deepEqual(out, { status: 'accepted', reason: null }, "the machine's outcome is the caller's");
  assert.deepEqual(submitted.at(-1), { sessionId: 1, appId: 2, head: C, source: 'fleet', trigger: 'fleet-maintenance', carryFrom: null });
});

test('a head that cannot be resolved hands nothing and builds nothing', async () => {
  const before = submitted.length;
  assert.deepEqual(await workflow.revision({ pool, session: { id: 1, app_id: 2, status: 'active', branch_name: 'gone' }, source: 'heal' }),
    { status: 'rejected', reason: 'no_head' });
  assert.equal(submitted.length, before);
});
