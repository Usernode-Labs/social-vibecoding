// #451: when a proposal's checks reach a terminal verdict, the app's merge
// queue is asked to look (src/workflow/merge-queue/), so a PR that already
// had a winning vote merges the moment its checks turn green. The ask is a
// message in the preview machine's own settling transition (mergeWanted in
// src/workflow/preview/machine.ts): it cannot be lost to a crash, as the
// follow-up work's in-process kick could. Only a 'passing' (or 'skipped')
// verdict, only on a proposal in review, and it names the verdict's app.
// The verdict's follow-up work keeps only the Homeroom bot's notes.
//
// Run with: node --test tests/checks-auto-merge-trigger.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const botCalls = [];
stub('../src/services/homeroom-bot-dm', {
  async noteChangeReady(_pool, sessionId) { botCalls.push(['ready', sessionId]); },
});
stub('../src/services/homeroom-bot', {
  async noteProposalChecks(_pool, o) { botCalls.push(['checks', o.sessionId]); },
});

const { previewServices } = require('../src/workflow/preview/services.ts');
const { WORK, mergeWanted } = require('../src/workflow/preview/machine.ts');

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

test('the follow-up work keeps the Homeroom bot\'s notes, and no longer reaches into the merge', async () => {
  const queries = [];
  const pool = { async query(sql) { queries.push(String(sql)); return { rows: [] }; } };
  const handlers = previewServices({ config: { jwtSecret: 's' }, pool });
  botCalls.length = 0;
  await handlers[WORK.followUps].run({ input: { sessionId: 7, appId: 42, head: null, state: 'passing' } });
  await handlers[WORK.followUps].run({ input: { sessionId: 7, appId: 42, head: null, state: 'failing' } });
  assert.deepEqual(botCalls, [['ready', 7], ['checks', 7]]);
  assert.deepEqual(queries, [], 'no status re-read: the transition decided, under the lock');
});
