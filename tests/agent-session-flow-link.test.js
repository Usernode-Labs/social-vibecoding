'use strict';

// #4312: a shared `?flow=claude-code|codex` link on an agent session address
// (#messages/agent/<id|new>, #agent/<id|new>) opens the conversation with its
// "Build with" sheet on that agent's tab, as the model pill, the credits
// card's hand-off rows and AppView.createProposal({ flow }) open it.
//
//   1. app.js's router hands the value to the store (prepareHandoff) and takes
//      it out of the address, in the fragment's query or the page's.
//   2. The store gives it to the next conversation opened, sent or not, once.
//      Unknown values are ignored.
//
// The declared check that opens the link and reads the walkthrough's first
// step is dapp.json's "#4312" entry.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const appJs = read('public/js/app.js');

function world() {
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {}, PlatformUI: { toast() {} } };
  globalThis.EventSource = class { constructor(url) { this.url = url; } close() {} };
  globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });
  const react = {
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  return loadTsx('frontend/src/features/agent-session/store.ts', { stubs: { react } });
}

function cleanup() {
  delete globalThis.window;
  delete globalThis.fetch;
  delete globalThis.EventSource;
}

test('a prepared hand-off opens the next session on that tab, once', async () => {
  const store = world();
  try {
    assert.equal(typeof store.agentSessionController.prepareHandoff, 'function', 'the router reaches it on window.UsernodeReact.agentSession');
    store.prepareHandoff('codex');
    await store.openAgentSession({ id: 7, host: 'screen' });
    assert.equal(store.getAgentSessionState().handoff, 'codex');
    store.closeHandoff();
    await store.openAgentSession({ id: 8, host: 'screen' });
    assert.equal(store.getAgentSessionState().handoff, null, 'taken once, not by every later conversation');
  } finally {
    cleanup();
  }
});

test('the same session already on screen takes it too (a cold link routes it twice)', async () => {
  const store = world();
  try {
    await store.openAgentSession({ id: 7, host: 'screen' });
    assert.equal(store.getAgentSessionState().handoff, null);
    store.prepareHandoff('claude-code');
    await store.openAgentSession({ id: 7, host: 'messages' });
    assert.equal(store.getAgentSessionState().handoff, 'claude-code');
  } finally {
    cleanup();
  }
});

test('the unsent conversation takes it, fresh or already on screen', async () => {
  const store = world();
  try {
    store.prepareHandoff('claude-code');
    await store.openAgentSession({ id: 'new', host: 'screen' });
    assert.equal(store.getAgentSessionState().handoff, 'claude-code');
    store.closeHandoff();
    store.prepareHandoff('codex');
    await store.openAgentSession({ id: 'new', host: 'screen' });
    assert.equal(store.getAgentSessionState().handoff, 'codex');
    // The hint's own field (AppView.createProposal) still opens it.
    store.closeHandoff();
    store.prepareAgentDraft({ slug: 'x', entry: 'app', handoff: 'codex' });
    await store.openAgentSession({ id: 'new', host: 'screen' });
    assert.equal(store.getAgentSessionState().handoff, 'codex');
  } finally {
    cleanup();
  }
});

test('anything but the two agents is ignored', async () => {
  const store = world();
  try {
    for (const value of ['bogus', '', null, 'Claude-Code', 'homeroom']) {
      store.prepareHandoff(value);
      await store.openAgentSession({ id: 'new', host: 'screen' });
      assert.equal(store.getAgentSessionState().handoff, null, String(value));
    }
  } finally {
    cleanup();
  }
});

// The router's half, run on its own source.
function takeAgentFlow({ hash, fragQuery, search, prepared }) {
  const start = appJs.indexOf('  _takeAgentFlow(hash, fragQuery) {');
  const end = appJs.indexOf('\n  },\n', start);
  assert.ok(start > 0 && end > start, 'app.js defines _takeAgentFlow');
  const body = appJs.slice(start, end + 4).replace(/^ {2}_takeAgentFlow/, 'function _takeAgentFlow');
  const replaced = [];
  const location = { pathname: '/', search };
  const history = { state: null, replaceState: (_s, _t, url) => replaced.push(url) };
  const window = { UsernodeReact: { agentSession: { prepareHandoff: (flow) => prepared.push(flow) } } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('location', 'history', 'window', `${body}\nreturn _takeAgentFlow;`)(location, history, window);
  fn(hash, fragQuery);
  return replaced;
}

test('the router hands the link\'s flow over and takes it out of the address', () => {
  let prepared = [];
  assert.deepEqual(takeAgentFlow({ hash: 'messages/agent/new', fragQuery: 'flow=codex', search: '', prepared }), ['/#messages/agent/new']);
  assert.deepEqual(prepared, ['codex']);

  prepared = [];
  assert.deepEqual(takeAgentFlow({ hash: 'messages/agent/12', fragQuery: '', search: '?demo=1&flow=claude-code', prepared }), ['/?demo=1#messages/agent/12'],
    'the page\'s query too, keeping what else it carries');
  assert.deepEqual(prepared, ['claude-code']);

  prepared = [];
  assert.deepEqual(takeAgentFlow({ hash: 'agent/12', fragQuery: 'flow=bogus', search: '', prepared }), [], 'an unknown value is ignored and left alone');
  assert.deepEqual(prepared, []);

  // Both agent routes ask, before they navigate; the phone's rewrite of a
  // Messages address to #agent/<id> drops the query after it was handed over.
  assert.match(appJs, /const agent = App\._messagesAgentThread\(parts\);\n\s+if \(agent && agent\.kind === 'agent'\) App\._takeAgentFlow\(hash, fragQuery\);\n\s+if \(agent\) \{/);
  assert.match(appJs, /if \(parts\[0\] === 'agent'\) \{[\s\S]{0,600}App\.setChromeless\(false\);\n\s+App\._takeAgentFlow\(hash, fragQuery\);\n\s+if \(parts\[1\] === 'new'\)/);
});
