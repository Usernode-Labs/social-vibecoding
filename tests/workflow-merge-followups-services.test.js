'use strict';

// The merge-followups machine's work handlers (src/workflow/merge-followups/
// services.ts): a handler that could not finish must throw, so the kernel
// retries it, rather than report success over a failure it swallowed.
// GitHub, the watcher and the database are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const gh = {
  closes: new Map(),   // issue number -> error status, or absent to succeed
  isEnabled: () => true,
  async closeIssue(owner, repo, n) {
    const status = gh.closes.get(n);
    if (status) throw Object.assign(new Error(`HTTP ${status}`), { status });
  },
  noteIssuesClosed() {}, unsuppressIssues() {}, invalidateIssuesCache() {},
};
stub('../src/services/github', gh);
const watch = { result: { closed: [], skipped: [], stillOpen: [] } };
const records = { fail: false, strict: [] };
stub('../src/services/issue-close-watcher', {
  async watchIssuesClosedAfterMerge(args) { records.strict.push(args.strict); return watch.result; },
  bustAndBroadcast() {},
  async closeTwinRows(args) { records.strict.push(args.strict); if (records.fail) throw new Error('db down'); },
  async resolveSupersededProposals(args) { records.strict.push(args.strict); },
});
stub('../src/routes/issues', { async resolveSupersededCloseProposals() { return { resolved: [] }; } });
const realWs = require('../src/services/ws');
stub('../src/services/ws', { ...realWs, pushIssueUpdate() {} });

const { mergeFollowupsServices } = require('../src/workflow/merge-followups/services.ts');
const { WORK } = require('../src/workflow/merge-followups/machine.ts');

const pool = { async query() { return { rows: [] }; } };
const handlers = mergeFollowupsServices({ config: {}, pool });
const run = (input) => handlers[WORK.issues].run({ input, key: 'issues', attempt: 1, resumeFrom: null, checkpoint: async () => {} });
const base = { sessionId: 5, appId: 2, appSlug: 'shop', prNumber: 8, owner: 'acme', repo: 'shop' };

test('an included change\'s requests: a close GitHub refused is retried, a request that is gone is not (review finding 4)', async () => {
  gh.closes = new Map([[4, 503]]);
  await assert.rejects(run({ ...base, linkedIssues: [3, 4], closeOnly: true, carrierPrNumber: 9 }), /Could not close request #4 on GitHub/);
  gh.closes = new Map([[4, 404]]);
  assert.deepEqual(await run({ ...base, linkedIssues: [3, 4], closeOnly: true, carrierPrNumber: 9 }), { closed: [3] });
  gh.closes = new Map();
  assert.deepEqual(await run({ ...base, linkedIssues: [3, 4], closeOnly: true, carrierPrNumber: 9 }), { closed: [3, 4] });
});

test('a merge\'s requests: a linked one still open after the watch is retried; one only the body names is not', async () => {
  watch.result = { closed: [3], skipped: [], stillOpen: [4] };
  await assert.rejects(run({ ...base, linkedIssues: [3, 4], closeOnly: false }), /Linked request #4 still open on GitHub/);
  watch.result = { closed: [3], skipped: [], stillOpen: [12] };
  assert.deepEqual(await run({ ...base, linkedIssues: [3, 4], closeOnly: false }), watch.result);
});

test('recording a close is part of the work: a database failure there is retried (review finding, second pass)', async () => {
  gh.closes = new Map();
  records.fail = true;
  records.strict = [];
  await assert.rejects(run({ ...base, linkedIssues: [7], closeOnly: true, carrierPrNumber: 9 }), /db down/);
  assert.ok(records.strict.length && records.strict.every((s) => s === true), 'every recording step runs strict');
  records.fail = false;
  records.strict = [];
  watch.result = { closed: [7], skipped: [], stillOpen: [] };
  await run({ ...base, linkedIssues: [7], closeOnly: false });
  assert.deepEqual(records.strict, [true], 'the watch runs strict too');
});
