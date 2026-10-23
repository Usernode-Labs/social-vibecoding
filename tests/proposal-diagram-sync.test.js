'use strict';

// A declared diagram's block written into the pull request's body
// (services/proposal-diagram.js syncPrBlock, the proposal machine's
// pr.diagram move). GitHub refusing the write is final, so the proposal's
// other GitHub moves, which wait behind it, are not held up by retries; a
// limit or an outage throws, and the move is tried again.
//
// Run with: node --test tests/proposal-diagram-sync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { syncPrBlock } = require('../src/services/proposal-diagram');
const { PR_MARKER_START, PR_MARKER_END } = require('../src/services/diagram');

// A body whose diagram block is out of date: with no diagram stored now, the
// write takes the block out.
const ROW = {
  id: 7, source: 'native', pr_number: 12, pr_body: `Body\n\n${PR_MARKER_START}\nold\n${PR_MARKER_END}`, pr_diagram: null,
  pr_diagram_source: 'author', repo_url: 'https://github.com/acme/demo',
};

function pool(writes) {
  return { query: async (sql, params) => {
    if (/^\s*SELECT/.test(sql)) return { rows: [ROW] };
    writes.push(params);
    return { rowCount: 1 };
  } };
}

test('GitHub refusing the write is final; a limit or an outage is tried again', async () => {
  for (const status of [404, 410, 422]) {
    const writes = [];
    const github = { updatePR: async () => { throw Object.assign(new Error('refused'), { status }); } };
    assert.deepEqual(await syncPrBlock(pool(writes), 7, { github }), { updated: false, reason: 'github_refused', status });
    assert.deepEqual(writes, [], 'nothing recorded as written');
  }
  for (const status of [403, 429, 502, undefined]) {
    const github = { updatePR: async () => { throw Object.assign(new Error('try later'), { status }); } };
    await assert.rejects(syncPrBlock(pool([]), 7, { github }), /try later/);
  }
  const writes = [];
  const github = { updatePR: async () => ({}) };
  assert.deepEqual(await syncPrBlock(pool(writes), 7, { github }), { updated: true });
  assert.equal(writes.length, 1, 'the body it wrote is kept');
});
