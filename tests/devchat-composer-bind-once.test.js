// #2397: "on a dev session chat, often after sending the message the input
// box doesn't clear".
//
// `renderChatView` runs more than once on the same open session (the title
// arriving after the first message, a PR opening, a venue switch). Since the
// screen became a React mount, the reconciler KEEPS `#dc-form`, `#dc-input` and
// the paperclip across that re-render, where an innerHTML write used to hand
// back fresh nodes — so each render stacked one more listener on them.
//
// With two submit listeners a single tap on Send ran both: the first sent the
// message and cleared the box, the second found a running turn and an empty
// box, took that as Stop, and `_stopCurrentTurn` put the sent text back into
// the input (and POSTed a stop).
//
// Harness: dev-chat.js in a vm against element stubs that RECORD listeners,
// with every other call renderChatView makes stubbed out, so the test drives
// the real render → real submit handler → real send path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8',
);

function makeElement(id) {
  const listeners = new Map();
  return {
    id, style: {}, dataset: {}, value: '', scrollHeight: 0, files: null,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    _handlers(type) { return listeners.get(type) || []; },
    click() {}, focus() {},
  };
}

// Every DevChat method renderChatView calls, except the ones under test: the
// wiring, and the submit listener's own routing (it is defined inside the render).
const REAL = new Set([
  '_bindOnce', '_setupTextareaResize', '_setupKeyboardShortcuts', '_setupAttachments',
  '_submitFromInput', '_sendButtonHasText', '_saveComposerDraft',
]);
const renderBody = SRC.match(/\n {2}renderChatView\(\) \{([\s\S]*?)\n {2}\},\n/)[1];
const CALLED = [...new Set([...renderBody.matchAll(/DevChat\.(\w+)\(/g)].map((m) => m[1]))]
  .filter((name) => !REAL.has(name));

function makeHarness() {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };
  const sandbox = {
    console,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    document: {
      getElementById: getEl, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { maxTouchPoints: 0 },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    PlatformUI: { attachScreenFx() {} },
    App: {}, Notifications: {},
    addEventListener() {}, removeEventListener() {},
    UsernodeReact: { devChat: new Proxy({}, { get: () => () => {} }) },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  for (const name of CALLED) DevChat[name] = () => {};

  DevChat.currentSession = { id: 77, status: 'active' };
  DevChat.messages = [];
  DevChat.pendingAttachments = [];
  DevChat.isStreaming = false;
  return { DevChat, getEl };
}

test('the harness really stubs renderChatView down to the composer wiring', () => {
  assert.ok(CALLED.includes('renderMessages') && CALLED.includes('_restoreDraft'));
  assert.ok(!CALLED.includes('_setupAttachments') && !CALLED.includes('_submitFromInput'));
});

test('re-rendering the same session binds each composer listener once', () => {
  const { DevChat, getEl } = makeHarness();
  DevChat.renderChatView();
  DevChat.renderChatView();
  DevChat.renderChatView();
  const counts = {
    'dc-form submit': getEl('dc-form')._handlers('submit').length,
    'dc-form drop': getEl('dc-form')._handlers('drop').length,
    'dc-input input': getEl('dc-input')._handlers('input').length,
    'dc-input keydown': getEl('dc-input')._handlers('keydown').length,
    'dc-input paste': getEl('dc-input')._handlers('paste').length,
    'dc-attach-btn click': getEl('dc-attach-btn')._handlers('click').length,
    'dc-file-input change': getEl('dc-file-input')._handlers('change').length,
    'dc-messages dragover': getEl('dc-messages')._handlers('dragover').length,
  };
  for (const [what, n] of Object.entries(counts)) assert.equal(n, 1, what);
});

test('one tap on Send after a re-render sends once, stops nothing, and leaves the box empty', () => {
  const { DevChat, getEl } = makeHarness();
  const sent = [];
  let stops = 0;
  DevChat.sendMessage = (msg) => { sent.push(msg); DevChat.isStreaming = true; };
  DevChat._stopCurrentTurn = () => {
    stops += 1;
    getEl('dc-input').value = sent[sent.length - 1];
  };

  DevChat.renderChatView();
  DevChat.renderChatView(); // e.g. the session's title arrived

  const input = getEl('dc-input');
  input.value = 'make the header sticky';
  const event = { preventDefault() {} };
  for (const handler of getEl('dc-form')._handlers('submit')) handler(event);

  assert.deepEqual(sent, ['make the header sticky']);
  assert.equal(stops, 0, 'the send must not also press Stop');
  assert.equal(input.value, '', 'the box is empty after sending');
});

test('a different element (another session\'s composer) is bound afresh', () => {
  const { DevChat } = makeHarness();
  const a = makeElement('a');
  const b = makeElement('b');
  const fn = () => {};
  DevChat._bindOnce(a, 'submit', fn);
  DevChat._bindOnce(a, 'submit', fn);
  DevChat._bindOnce(a, 'drop', fn);
  DevChat._bindOnce(b, 'submit', fn);
  DevChat._bindOnce(null, 'submit', fn);
  assert.equal(a._handlers('submit').length, 1);
  assert.equal(a._handlers('drop').length, 1);
  assert.equal(b._handlers('submit').length, 1);
});
