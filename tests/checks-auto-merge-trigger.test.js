// #451: when a proposal's checks reach a terminal verdict, the app's merge
// queue is asked to look (src/workflow/merge-queue/), so a PR that already
// had a winning vote merges the moment its checks turn green. The ask is a
// message in the preview machine's own settling transition (mergeWanted in
// src/workflow/preview/machine.ts): it cannot be lost to a crash, as the
// follow-up work's in-process kick could. Only a 'passing' (or 'skipped')
// verdict, only on a proposal in review, and it names the verdict's app.
//
// Run with: node --test tests/checks-auto-merge-trigger.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeWanted } = require('../src/workflow/preview/machine.ts');

const data = { sessionId: 7, appId: 42 };
const facts = (status) => ({ session: status ? { status } : null });

test('a passing or skipped verdict on a proposal in review asks the app\'s merge queue, naming it', () => {
  for (const state of ['passing', 'skipped']) {
    assert.deepEqual(mergeWanted(data, facts('promoted'), state), [{
      to: { machine: 'merge-queue', key: 'app:42' },
      event: { type: 'MergeWanted', payload: { appId: 42, sessionId: 7, reason: 'checks' } },
      appId: 42,
    }], state);
  }
});

test('a failing or errored verdict, or a proposal not in review (merged, gone), asks nothing', () => {
  assert.deepEqual(mergeWanted(data, facts('promoted'), 'failing'), []);
  assert.deepEqual(mergeWanted(data, facts('promoted'), 'error'), []);
  assert.deepEqual(mergeWanted(data, facts('merged'), 'passing'), []);
  assert.deepEqual(mergeWanted(data, facts('active'), 'passing'), []);
  assert.deepEqual(mergeWanted(data, facts(null), 'passing'), []);
});
