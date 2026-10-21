'use strict';

// A Preview click on a preview the machine holds. The
// route rebuilds only once it found the runtime missing or stale
// (routes/sessions.js inspectPreview), so for a session the machine holds
// and serves, the click is an observation: it reports the preview lost and
// the machine rebuilds it. Asked as a plain "ensure", the machine answered
// that it already serves that head, and the reviewer's loader waited for a
// preview nothing built.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const calls = [];
const serving = { now: true };
stub('../src/services/preview-workflow', {
  held: async () => true,
  working: async () => false,
  lost: async ({ session, detail }) => { calls.push(['lost', session.id, detail]); return serving.now; },
  request: async (o) => { calls.push(['request', o.session.id, o.reason]); return { taken: true }; },
  revision: async (o) => { calls.push(['revision', o.session.id, o.source]); return { taken: true }; },
});

const { rebuildSessionStaging } = require('../src/services/staging-recovery');
const SESSION = { id: 31, app_id: 4, status: 'active', branch_name: 'dev/x' };

test('a Preview click on a preview the machine serves reports it lost', async () => {
  calls.length = 0;
  const out = await rebuildSessionStaging({ config: {}, pool: null, session: SESSION, reason: 'preview-click' });
  assert.equal(out, 'handed_off');
  assert.deepEqual(calls, [['lost', 31, 'preview-click']], 'never a plain ensure the machine would refuse as already serving');
});

test('the preview-runtimes clock reports a vote-backed preview whose runtime is gone the same way', async () => {
  // The leader's heal pass is gone: the clock (lookForLostPreviews) looks at
  // every preview the machine says serves a proposal up for a vote.
  const queries = [];
  const rows = [
    { id: 41, app_id: 4, staging_url: null },
    { id: 42, app_id: 4, staging_url: null },
  ];
  stub('../src/db/pool', { getPool: () => ({ query: async (sql) => { queries.push(String(sql)); return { rows }; } }) });
  const { lookForLostPreviews } = require('../src/services/staging-recovery');
  calls.length = 0;
  serving.now = true;
  assert.deepEqual(await lookForLostPreviews({}), { examined: 2, lost: 2 });
  assert.deepEqual(calls, [['lost', 41, 'runtime gone'], ['lost', 42, 'runtime gone']], 'reported lost, never asked to build');
  assert.match(queries[0], /cs\.status IN \('promoted', 'merging'\)/, 'only previews that back a vote');

  // One the machine no longer serves is not counted; an ended lease stops the look.
  calls.length = 0;
  serving.now = false;
  assert.deepEqual(await lookForLostPreviews({}), { examined: 2, lost: 0 });
  const stop = new AbortController();
  stop.abort();
  calls.length = 0;
  assert.deepEqual(await lookForLostPreviews({}, { signal: stop.signal }), { examined: 2, lost: 0 });
  assert.deepEqual(calls, []);
});
