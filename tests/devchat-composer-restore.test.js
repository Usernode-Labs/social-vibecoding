// #370: the dev-chat composer must not lose the user's typed text when a
// send is rejected at the token/spend cap (HTTP 429) or any other non-ok
// response. On those paths sendMessage now puts the message back into
// #dc-input (editable, draft re-saved) and drops the optimistic,
// never-persisted user bubble so the text lives only in the editor.
//
// These tests execute the REAL DevChat.sendMessage / _restoreComposer /
// _finishStreaming against a minimal fake DOM + globals, asserting on the
// observable composer + message-list state rather than the network.
// dev-chat.js is a plain browser script (`const DevChat = {…}`), so we
// load its source into a vm context, expose DevChat, and drive it.
//
// Three cases (per the spec's edge cases):
//   1. 429 cap     → text restored, draft saved, optimistic bubble gone,
//                    rate-limit notice present, streaming torn down.
//   2. 500 non-ok  → text restored, optimistic bubble gone.
//   3. AbortError  → NOT restored (session switch / deliberate teardown;
//                    restoring would write into another session's box).
//
// Run with: node --test tests/devchat-composer-restore.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

// One persistent fake element per id (registry-backed) so the textarea we
// assert on survives re-resolution by id, mirroring the real DOM.
function makeElement(id) {
  const classes = new Set();
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    value: '',
    scrollHeight: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: () => {},
    },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { return c; },
    removeChild() {},
    remove() {},
    focus() {},
    blur() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function makeHarness() {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };

  const document = {
    _title: 'MyApp',
    get title() { return this._title; },
    set title(v) { this._title = v; },
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(`__created_${tag}`),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    document,
    localStorage,
    AbortController,
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Neutralize the noisy render / streaming-plumbing helpers; the methods
  // under test (sendMessage's failure branches, _restoreComposer,
  // _finishStreaming, _setDraft) stay real. _setStreamingUI is replaced
  // with a faithful minimal version that only toggles the input's disabled
  // flag — the one observable property the tests assert on.
  DevChat.renderMessages = () => {};
  DevChat.scrollToBottom = () => {};
  DevChat.refreshBudget = () => {};
  DevChat._showSpinner = () => {};
  DevChat._removeSpinner = () => {};
  DevChat._flushStreamingFinal = () => {};
  DevChat._stopProgressPolling = () => {};
  DevChat._closeResumableStream = () => {};
  DevChat._openResumableStream = () => {};
  DevChat._startProgressPolling = () => {};
  DevChat._setStreamingUI = (streaming) => {
    const input = document.getElementById('dc-input');
    if (input) input.disabled = !!streaming;
  };

  return { DevChat, sandbox, document, getEl, storage };
}

const SESSION_ID = 42;
const MSG = 'add a dark mode toggle to the settings page';

// Reproduce the runtime sequence: the user has typed MSG, _submitFromInput
// optimistically clears the box + draft, then sendMessage runs against a
// failing endpoint.
async function drive(DevChat, document, send) {
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.messages = [];
  DevChat.isStreaming = false;
  const input = document.getElementById('dc-input');
  input.value = '';                 // optimistic clear from _submitFromInput
  DevChat._setDraft(SESSION_ID, ''); // draft cleared from _submitFromInput
  await DevChat.sendMessage(MSG);
}

test('429 cap restores the typed text and drops the optimistic bubble', async () => {
  const { DevChat, sandbox, document, storage } = makeHarness();
  sandbox.fetch = async () => ({
    status: 429,
    ok: false,
    json: async () => ({ error: 'Daily limit reached ($5.00). Resets at midnight UTC.' }),
  });

  await drive(DevChat, document);

  const input = document.getElementById('dc-input');
  assert.equal(input.value, MSG, 'typed text is back in the composer');
  assert.equal(storage.get(`usernode:dc-draft:${SESSION_ID}`), MSG, 'draft re-saved');
  assert.equal(
    DevChat.messages.some((m) => m.role === 'user' && !m.id), false,
    'optimistic user bubble removed (no duplicate sent-looking row)'
  );
  assert.ok(
    DevChat.messages.some((m) => m.role === 'assistant' && /Rate limit reached/.test(m.content)),
    'rate-limit notice present'
  );
  assert.equal(DevChat.isStreaming, false, 'streaming torn down');
  assert.equal(input.disabled, false, 'composer re-enabled / editable');
});

test('generic non-ok (500) restores the typed text', async () => {
  const { DevChat, sandbox, document, storage } = makeHarness();
  sandbox.fetch = async () => ({
    status: 500,
    ok: false,
    json: async () => ({ error: 'Internal server error' }),
  });

  await drive(DevChat, document);

  const input = document.getElementById('dc-input');
  assert.equal(input.value, MSG, 'typed text restored on a 500');
  assert.equal(storage.get(`usernode:dc-draft:${SESSION_ID}`), MSG, 'draft re-saved');
  assert.equal(
    DevChat.messages.some((m) => m.role === 'user' && !m.id), false,
    'optimistic user bubble removed'
  );
  assert.ok(
    DevChat.messages.some((m) => m.role === 'assistant' && /Couldn't send message/.test(m.content)),
    'send-failed notice present'
  );
});

test('AbortError (session switch) does NOT repopulate the composer', async () => {
  const { DevChat, sandbox, document, storage } = makeHarness();
  sandbox.fetch = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };

  await drive(DevChat, document);

  const input = document.getElementById('dc-input');
  assert.equal(input.value, '', 'composer left empty — no restore on abort');
  assert.equal(
    storage.has(`usernode:dc-draft:${SESSION_ID}`), false,
    'draft not re-written on abort'
  );
});
