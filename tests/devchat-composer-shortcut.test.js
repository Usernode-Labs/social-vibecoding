// #920: Ctrl/Cmd+Enter in the dev-chat composer follows whichever action
// is actually offered.
//
// Before this change the shortcut always called _submitFromInput, which
// bails on `isStreaming` — so mid-turn the keystroke did NOTHING, even
// though the composer stays typable and the save icon (#798/#810) is
// sitting right there offering to park the text as a draft. Now a single
// router, _onComposerShortcut, picks:
//
//   running turn  → _saveComposerDraft()   (same as clicking the icon)
//   stopped chat  → _submitFromInput()     (unchanged send path)
//
// The invariants worth locking in:
//
//   1. Mid-turn + text → the text becomes a draft, the box clears, and
//      NOTHING is sent (it must never join the running turn).
//   2. Idle + text → still sends, byte-for-byte the old behaviour.
//   3. Mid-turn with nothing savable (empty / whitespace / the drafts cap)
//      → a silent no-op that leaves the box alone. Never a send, never a
//      stop.
//   4. The rule tracks SAVE AVAILABILITY (`isStreaming`), not "the red
//      Stop square is currently painted" — so it also saves through the
//      mayor2 wrap-up and the _stopping interim, where the icon is shown
//      and enabled but the button paints a spinner.
//   5. A turn ending between keypress and dispatch refuses to save and
//      leaves the text in the box; it does NOT fall through to a send the
//      user never asked for. (That case reaches _saveComposerDraft's own
//      guard, so it is covered by the "stopped → send" path plus
//      devchat-saved-drafts.test.js's refusal test.)
//   6. The hint under the box names the CURRENT action, flipping with the
//      same events the save icon does.
//   7. The real keydown listener is wired to the router for BOTH modifier
//      keys, always preventDefaults the combination (so the keystroke can
//      never leave a stray newline as its only effect), and ignores a
//      bare Enter.
//
// Same harness style as devchat-saved-drafts.test.js: dev-chat.js is a
// plain browser script, so we load its source into a vm context, expose
// DevChat, and drive the real methods against a minimal fake DOM. The one
// addition here is that elements RECORD their event listeners, so the
// wiring test can invoke the real keydown handler.
//
// Run with: node --test tests/devchat-composer-shortcut.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

function makeElement(id) {
  const classes = new Set();
  const listeners = new Map();
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    // _syncSaveDraftBtn toggles the `hidden` property, so the stub must
    // start with a real boolean for the visibility assertions to mean
    // anything.
    hidden: false,
    title: '',
    placeholder: '',
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
    // Recorded so a test can fire the REAL handler dev-chat.js installed.
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    _handlers(type) { return listeners.get(type) || []; },
    appendChild(c) { return c; },
    removeChild() {},
    remove() {},
    focus() {},
    blur() {},
    setSelectionRange() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function makeHarness(storage = new Map()) {
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
    navigator: { maxTouchPoints: 0 },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
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

  // Render plumbing that has nothing to do with the shortcut.
  DevChat.renderMessages = () => {};
  DevChat.scrollToBottom = () => {};
  DevChat.refreshBudget = () => {};
  DevChat._showSpinner = () => {};
  DevChat._renderQuickReplies = () => {};
  DevChat._applySyncBanner = () => {};
  DevChat.setTitleStatus = () => {};

  return { DevChat, sandbox, document, getEl, storage };
}

const SESSION_ID = 4242;

function open(DevChat, { streaming = false } = {}) {
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.messages = [];
  DevChat.isStreaming = streaming;
  DevChat.pendingAttachments = [];
}

// The list comes back from inside the vm context, so its prototype is not
// this realm's Array — copy into a host array before asserting.
function texts(DevChat, sessionId = SESSION_ID) {
  return Array.from(DevChat._getSavedDrafts(sessionId), (d) => d.text);
}

// Record what the shortcut would have sent, so "nothing was sent" is a
// real assertion rather than an absence of errors.
function spySend(DevChat) {
  const sent = [];
  DevChat.sendMessage = (m, atts) => sent.push(m);
  return sent;
}

// ── Routing: running turn saves ────────────────────────────────────────

test('mid-turn, the shortcut parks the text as a draft and sends nothing', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  const sent = spySend(DevChat);

  input.value = 'also make the header sticky';
  DevChat._onComposerShortcut();

  assert.deepEqual(texts(DevChat), ['also make the header sticky'],
    'the keystroke did exactly what the save icon does');
  assert.equal(input.value, '', 'box cleared for the next thought');
  assert.deepEqual(sent, [],
    'nothing was sent — it must not join the running turn');
});

test('idle, the shortcut still sends (the unchanged path)', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');
  const sent = spySend(DevChat);

  input.value = 'add a dark mode toggle';
  DevChat._onComposerShortcut();

  assert.deepEqual(sent, ['add a dark mode toggle'], 'sent as before');
  assert.deepEqual(texts(DevChat), [],
    'and no draft was created behind the send');
  assert.equal(input.value, '', 'box cleared by the send path');
});

// ── Nothing savable mid-turn: a silent no-op ───────────────────────────

test('mid-turn with an empty box, the shortcut does nothing at all', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  const sent = spySend(DevChat);

  input.value = '';
  DevChat._onComposerShortcut();

  assert.deepEqual(texts(DevChat), [], 'no draft from an empty box');
  assert.deepEqual(sent, [], 'and nothing sent');
});

test('mid-turn with only whitespace, the shortcut does nothing at all', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  const sent = spySend(DevChat);

  input.value = '   \n  ';
  DevChat._onComposerShortcut();

  assert.deepEqual(texts(DevChat), [], 'whitespace is not a draft');
  assert.deepEqual(sent, [], 'and nothing sent');
  assert.equal(input.value, '   \n  ', 'the box is left exactly as it was');
});

test('mid-turn at the drafts cap, the shortcut keeps the text in the box', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  const sent = spySend(DevChat);

  for (let i = 0; i < DevChat.MAX_SAVED_DRAFTS; i++) {
    input.value = `note ${i}`;
    DevChat._onComposerShortcut();
  }
  assert.equal(DevChat._getSavedDrafts(SESSION_ID).length, DevChat.MAX_SAVED_DRAFTS,
    'the shortcut filled the list up to the cap');

  input.value = 'one too many';
  DevChat._onComposerShortcut();

  assert.equal(DevChat._getSavedDrafts(SESSION_ID).length, DevChat.MAX_SAVED_DRAFTS,
    'the cap holds — the shortcut cannot grow the list past it');
  assert.equal(input.value, 'one too many',
    'a refused save leaves the text in the box rather than swallowing it');
  assert.deepEqual(sent, [], 'and still nothing was sent');
});

// ── The rule follows SAVE AVAILABILITY, not the red square ─────────────

test('the shortcut still saves through the mayor2 wrap-up', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  const btn = document.getElementById('dc-save-draft-btn');
  const sent = spySend(DevChat);

  input.value = 'a note during the wrap-up';
  DevChat._setStreamingUI(true, 'mayor2');
  assert.equal(btn.hidden, false,
    'precondition: the save icon is offered through the wrap-up');

  DevChat._onComposerShortcut();

  assert.deepEqual(texts(DevChat), ['a note during the wrap-up'],
    'save is available there, so the shortcut saves');
  assert.deepEqual(sent, [], 'nothing sent during the wrap-up');
});

test('the shortcut still saves while a stop is landing', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  const btn = document.getElementById('dc-save-draft-btn');
  const sent = spySend(DevChat);

  DevChat._stopping = true;
  input.value = 'a note while stopping';
  DevChat._setStreamingUI(true, 'claude');
  assert.equal(btn.hidden, false,
    'precondition: the save icon is offered while the stop lands');

  DevChat._onComposerShortcut();

  assert.deepEqual(texts(DevChat), ['a note while stopping'],
    'the turn is still running, so the text is still parkable');
  assert.deepEqual(sent, [], 'and the shortcut never re-presses Stop');
});

// ── The turn-ends-first race ───────────────────────────────────────────

test('once the turn has settled the shortcut sends rather than saving', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  const sent = spySend(DevChat);

  input.value = 'typed while thinking';
  // The turn finishes before the user hits the keys.
  DevChat.isStreaming = false;
  DevChat._setStreamingUI(false);
  DevChat._onComposerShortcut();

  assert.deepEqual(sent, ['typed while thinking'],
    'sending is possible again, so the shortcut sends');
  assert.deepEqual(texts(DevChat), [],
    'and no draft is parked for text that could simply be sent');
});

// ── The hint under the box ─────────────────────────────────────────────

test('the shortcut hint names the action the keystroke currently performs', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const hint = document.getElementById('dc-shortcut-hint');
  document.getElementById('dc-input').value = 'a note';

  DevChat._syncSaveDraftBtn();
  assert.equal(hint.innerHTML, DevChat.SHORTCUT_HINT_SEND,
    'stopped chat: the keystroke sends, so the hint says send');

  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, 'claude');
  assert.equal(hint.innerHTML, DevChat.SHORTCUT_HINT_SAVE,
    'running chat: the keystroke saves, so the hint says save');

  DevChat.isStreaming = false;
  DevChat._setStreamingUI(false);
  assert.equal(hint.innerHTML, DevChat.SHORTCUT_HINT_SEND,
    'and it flips back the moment the turn settles');
});

test('the save icon tooltip advertises the shortcut', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  const btn = document.getElementById('dc-save-draft-btn');

  input.value = 'something worth saving';
  DevChat._syncSaveDraftBtn();

  assert.match(btn.title, /Ctrl\+Enter/,
    'the icon names the keystroke that does the same thing');
});

// ── The real keydown wiring ────────────────────────────────────────────

function keydownHandler(DevChat, document) {
  DevChat._setupKeyboardShortcuts();
  const handlers = document.getElementById('dc-input')._handlers('keydown');
  assert.equal(handlers.length, 1, 'exactly one keydown listener is bound');
  return handlers[0];
}

test('both Ctrl+Enter and Cmd+Enter reach the router, and preventDefault runs', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const { DevChat, document } = makeHarness();
    open(DevChat, { streaming: true });
    const onKeydown = keydownHandler(DevChat, document);

    let routed = 0;
    let prevented = 0;
    DevChat._onComposerShortcut = () => { routed++; };

    onKeydown({ [modifier]: true, key: 'Enter', preventDefault: () => { prevented++; } });

    assert.equal(routed, 1, `${modifier}+Enter routes through _onComposerShortcut`);
    assert.equal(prevented, 1,
      `${modifier}+Enter is swallowed so it can never insert a newline`);
  }
});

test('a bare Enter is left alone (newlines still work)', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const onKeydown = keydownHandler(DevChat, document);

  let routed = 0;
  let prevented = 0;
  DevChat._onComposerShortcut = () => { routed++; };

  onKeydown({ key: 'Enter', preventDefault: () => { prevented++; } });
  onKeydown({ ctrlKey: true, key: 'a', preventDefault: () => { prevented++; } });

  assert.equal(routed, 0, 'neither a bare Enter nor Ctrl+A is the shortcut');
  assert.equal(prevented, 0, 'and neither is swallowed');
});

test('end to end: the real keydown handler parks a draft mid-turn', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  const sent = spySend(DevChat);
  const onKeydown = keydownHandler(DevChat, document);

  input.value = 'and rename the tab';
  onKeydown({ metaKey: true, key: 'Enter', preventDefault: () => {} });

  assert.deepEqual(texts(DevChat), ['and rename the tab'],
    'the wired handler, not just the router, saves the draft');
  assert.equal(input.value, '', 'box cleared');
  assert.deepEqual(sent, [], 'nothing sent');
});
