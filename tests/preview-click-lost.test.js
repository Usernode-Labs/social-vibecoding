'use strict';

// A Preview click with the preview machine on (WF_PREVIEWS_ENABLED). The
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
  enabled: () => true,
  held: async () => true,
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

test('the heal pass reports it the same way, as before', async () => {
  calls.length = 0;
  const out = await rebuildSessionStaging({ config: {}, pool: null, session: SESSION, reason: 'heal' });
  assert.equal(out, 'handed_off');
  assert.deepEqual(calls, [['lost', 31, 'heal']]);
});
