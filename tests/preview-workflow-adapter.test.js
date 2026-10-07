'use strict';

// services/preview-workflow.js: how [main]'s preview sources reach the
// preview machine. With the flag off it hands nothing (the sources run as
// before); with it on, a source that names no exact head gets the row's pin
// for its kind, else the branch tip, never 'latest' (P-A1, bug 20).

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};
const submitted = [];
const platform = { on: false, previewsEnabled: () => platform.on, submitRevision: async (r) => { submitted.push(r); return 1; } };
stub('../src/workflow/platform.ts', platform);
const tips = new Map();
stub('../src/services/github', { getBranchSha: async (owner, repo, branch) => tips.get(`${owner}/${repo}#${branch}`) ?? null });
const workflow = require('../src/services/preview-workflow');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const pool = { query: async () => ({ rows: [{ repo_url: 'https://github.com/acme/shop' }] }) };

test('with the flag off nothing is handed off', async () => {
  platform.on = false;
  assert.equal(await workflow.revision({ pool, session: { id: 1, app_id: 2 }, head: A, source: 'turn' }), false);
  assert.deepEqual(submitted, []);
});

test('an exact head is used as given; otherwise the pin for the row kind, then the branch tip', async () => {
  platform.on = true;
  tips.set('acme/shop#feature', C);
  assert.equal(await workflow.exactHead(pool, { source: null, status: 'active' }, A.toUpperCase()), A);
  assert.equal(await workflow.exactHead(pool, { source: 'imported', imported_pr_head_sha: B, status: 'promoted', reviewed_head_sha: C }, 'latest'), B);
  assert.equal(await workflow.exactHead(pool, { source: null, status: 'promoted', reviewed_head_sha: B }, null), B);
  assert.equal(await workflow.exactHead(pool, { source: 'cli_handoff', status: 'active', handoff_head_sha: B }), B);
  assert.equal(await workflow.exactHead(pool, { source: null, status: 'active', app_id: 2, branch_name: 'feature' }), C);
  await workflow.revision({ pool, session: { id: 1, app_id: 2, status: 'active', branch_name: 'feature' }, source: 'fleet', trigger: 'fleet-maintenance' });
  assert.deepEqual(submitted.at(-1), { sessionId: 1, appId: 2, head: C, source: 'fleet', trigger: 'fleet-maintenance', carryFrom: null });
});

test('a head that cannot be resolved hands nothing and builds nothing', async () => {
  platform.on = true;
  const before = submitted.length;
  assert.equal(await workflow.revision({ pool, session: { id: 1, app_id: 2, status: 'active', branch_name: 'gone' }, source: 'heal' }), true);
  assert.equal(submitted.length, before);
});
