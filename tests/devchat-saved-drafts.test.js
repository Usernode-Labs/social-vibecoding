// #798: saved draft messages in the dev-chat composer.
//
// While a turn is running the composer stays typable and the save icon
// parks the typed text as a DRAFT: a per-session, localStorage-backed list
// rendered above the box, each row with send / edit / trash. The invariants
// worth locking in (they're the whole point of the feature):
//
//   1. Save moves the composer text into the list (newest LAST) and clears
//      the box, so the next thought can be typed straight away.
//   2. The list is scoped per session id and survives a "reload" (a fresh
//      DevChat instance reading the same storage).
//   3. Sending is NEVER automatic and is REFUSED while a turn streams —
//      no draft can join a running turn.
//   4. Send (when idle) removes the draft and hands exactly its text to
//      sendMessage.
//   5. Edit puts the draft back in the composer, drops it from the list,
//      and parks whatever was already typed as another draft (nothing the
//      user wrote is ever thrown away).
//   6. Trash removes just that draft, and an emptied list STAYS empty.
//   7. The composer is not disabled while streaming (that's what made
//      typing-while-thinking impossible before).
//   8. #801: the save ICON itself is only present while the chat is
//      STOPPED — it hides for the duration of a turn (and saving is
//      refused then, not just un-clickable), and comes back when the turn
//      ends. The drafts list and the typed text are untouched by that.
//
// Same harness style as devchat-composer-restore.test.js: dev-chat.js is a
// plain browser script, so we load its source into a vm context, expose
// DevChat, and drive the real methods against a minimal fake DOM.
//
// Run with: node --test tests/devchat-saved-drafts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

function makeElement(id) {
  const classes = new Set();
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    // #801: _syncSaveDraftBtn toggles the `hidden` property, so the stub
    // must start with a real boolean (not undefined) for the
    // visible-when-stopped assertions to be meaningful.
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
    addEventListener() {},
    removeEventListener() {},
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

// `storage` is shared across harnesses on purpose when a test wants to
// simulate a page reload (a fresh DevChat over the same localStorage).
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

  // Render plumbing that has nothing to do with drafts.
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
const KEY = `usernode:dc-saved-drafts:${SESSION_ID}`;

function open(DevChat, { streaming = false } = {}) {
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.messages = [];
  DevChat.isStreaming = streaming;
  DevChat.pendingAttachments = [];
}

// Array.from(): the list comes back from inside the vm context, so its
// prototype is not this realm's Array and deepStrictEqual would reject an
// otherwise identical value. Copy into a host array before asserting.
function texts(DevChat, sessionId = SESSION_ID) {
  return Array.from(DevChat._getSavedDrafts(sessionId), (d) => d.text);
}

test('save parks the composer text as a draft (newest last) and clears the box', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');

  input.value = 'first thought';
  DevChat._saveComposerDraft();
  input.value = 'second thought';
  DevChat._saveComposerDraft();

  assert.deepEqual(texts(DevChat), ['first thought', 'second thought'],
    'drafts are ordered newest LAST');
  assert.equal(input.value, '', 'composer cleared so the next note can be typed');
  assert.equal(DevChat._getDraft(SESSION_ID), '',
    'the single-composer draft is cleared too (the text lives in the list now)');
});

test('drafts are scoped per session and survive a reload', () => {
  const { DevChat, document, storage } = makeHarness();
  open(DevChat);
  document.getElementById('dc-input').value = 'keep me';
  DevChat._saveComposerDraft();

  // A different session in the same browser sees none of it.
  assert.deepEqual(texts(DevChat, 999), []);

  // Fresh DevChat over the same localStorage == a page reload.
  const reloaded = makeHarness(storage);
  open(reloaded.DevChat);
  assert.deepEqual(texts(reloaded.DevChat), ['keep me'],
    'draft still there after a reload');
});

test('a draft is never sent automatically while the agent is thinking', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  document.getElementById('dc-input').value = 'do this next';
  DevChat._saveComposerDraft();

  const sent = [];
  DevChat.sendMessage = (m) => sent.push(m);

  DevChat.isStreaming = true;
  const [draft] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._sendSavedDraft(draft.id);

  assert.deepEqual(sent, [], 'send refused mid-turn');
  assert.deepEqual(texts(DevChat), ['do this next'], 'the draft is still parked');

  // And the row renders its Send button disabled while streaming.
  DevChat._renderSavedDrafts();
  const html = document.getElementById('dc-drafts').innerHTML;
  assert.match(html, /dc-draft-send[^>]*disabled/,
    'the row Send button is rendered disabled while thinking');
});

test('send (once idle) removes the draft and sends exactly its text', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');
  input.value = 'draft A';
  DevChat._saveComposerDraft();
  input.value = 'draft B';
  DevChat._saveComposerDraft();

  const sent = [];
  DevChat.sendMessage = (m) => sent.push(m);

  const [a] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._sendSavedDraft(a.id);

  assert.deepEqual(sent, ['draft A'], 'exactly the draft text was sent');
  assert.deepEqual(texts(DevChat), ['draft B'], 'the sent draft left the list');
});

test('edit loads the draft back into the composer and parks the typed text', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');

  // Park the draft while the chat is stopped (#801: saving is refused
  // mid-turn), then start a turn — edit must still work throughout, since
  // its job is to not throw away text, not to offer the save affordance.
  input.value = 'reword me';
  DevChat._saveComposerDraft();
  DevChat.isStreaming = true;
  input.value = 'a half-typed follow-up';

  const [draft] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._editSavedDraft(draft.id);

  assert.equal(input.value, 'reword me', 'draft is back in the box for editing');
  assert.deepEqual(texts(DevChat), ['a half-typed follow-up'],
    'the text already in the box was parked as a draft instead of being lost');
  assert.equal(DevChat._getDraft(SESSION_ID), 'reword me',
    'composer draft persisted so the edit survives a tab switch');

  // Re-saving puts it back at the end of the list — once the turn ends.
  DevChat.isStreaming = false;
  DevChat._saveComposerDraft();
  assert.deepEqual(texts(DevChat), ['a half-typed follow-up', 'reword me']);
});

test('trash removes only that draft, and an emptied list stays empty', () => {
  const { DevChat, document, storage } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');
  input.value = 'one';
  DevChat._saveComposerDraft();
  input.value = 'two';
  DevChat._saveComposerDraft();

  const [one] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._deleteSavedDraft(one.id);
  assert.deepEqual(texts(DevChat), ['two']);

  DevChat._deleteSavedDraft(DevChat._getSavedDrafts(SESSION_ID)[0].id);
  assert.deepEqual(texts(DevChat), []);
  assert.equal(storage.get(KEY), '[]',
    'the emptied list is written, not removed, so nothing can resurrect it');
});

test('the save icon is disabled until there is text, and the cap holds', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');
  const btn = document.getElementById('dc-save-draft-btn');

  DevChat._syncSaveDraftBtn();
  assert.equal(btn.disabled, true, 'nothing typed → nothing to save');
  input.value = '   ';
  DevChat._syncSaveDraftBtn();
  assert.equal(btn.disabled, true, 'whitespace is not a draft');
  input.value = 'something';
  DevChat._syncSaveDraftBtn();
  assert.equal(btn.disabled, false, 'text typed → save available');

  for (let i = 0; i < DevChat.MAX_SAVED_DRAFTS + 3; i++) {
    input.value = `note ${i}`;
    DevChat._saveComposerDraft();
  }
  assert.equal(DevChat._getSavedDrafts(SESSION_ID).length, DevChat.MAX_SAVED_DRAFTS,
    'the list is capped instead of growing without bound');
  assert.equal(input.value, `note ${DevChat.MAX_SAVED_DRAFTS + 2}`,
    'a refused save leaves the text in the box rather than dropping it');
});

test('the composer stays typable while a turn streams', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');

  DevChat._setStreamingUI(true, 'claude');
  assert.equal(input.disabled, false, 'typing while the agent thinks is the point');
  assert.equal(input.placeholder, DevChat.COMPOSER_PLACEHOLDER_BUSY,
    'the placeholder explains that the text stays in the box');

  DevChat._setStreamingUI(false);
  assert.equal(input.disabled, false);
  assert.equal(input.placeholder, DevChat.COMPOSER_PLACEHOLDER,
    'the normal placeholder comes back when the turn ends');
});

test('typed-but-unsent text still cannot be submitted mid-turn', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'this must not join the running turn';
  const sent = [];
  DevChat.sendMessage = (m) => sent.push(m);

  DevChat._submitFromInput();

  assert.deepEqual(sent, [], 'Ctrl+Enter mid-turn sends nothing');
  assert.equal(input.value, 'this must not join the running turn',
    'and the text is left alone');
});

// ── #801: the icon is present only while the chat is stopped ──────────

test('the save icon is hidden while a turn streams and returns when it stops', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');
  const btn = document.getElementById('dc-save-draft-btn');
  input.value = 'something worth saving';

  DevChat.isStreaming = true;
  DevChat._syncSaveDraftBtn();
  assert.equal(btn.hidden, true, 'no save affordance while Claude is working');
  assert.equal(btn.disabled, true,
    'hidden implies inert — a stray activation cannot save mid-turn');

  DevChat.isStreaming = false;
  DevChat._syncSaveDraftBtn();
  assert.equal(btn.hidden, false, 'the icon comes back once the chat is stopped');
  assert.equal(btn.disabled, false, 'and is live again because there is text');
});

test('every streaming transition toggles the icon (incl. the mayor2 wrap-up)', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const btn = document.getElementById('dc-save-draft-btn');
  document.getElementById('dc-input').value = 'a note';

  // _setStreamingUI is the single choke point every transition funnels
  // through (send, reconnect, phase change, finish, stop).
  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, 'claude');
  assert.equal(btn.hidden, true, 'hidden as soon as the turn starts');

  DevChat._setStreamingUI(true, 'mayor2');
  assert.equal(btn.hidden, true, 'still hidden through the un-stoppable wrap-up');

  DevChat.isStreaming = false;
  DevChat._setStreamingUI(false);
  assert.equal(btn.hidden, false, 'and restored the moment the turn settles');
  assert.equal(btn.disabled, false);
});

test('when stopped, the icon is visible whether or not there is text', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');
  const btn = document.getElementById('dc-save-draft-btn');

  DevChat._syncSaveDraftBtn();
  assert.equal(btn.hidden, false, 'an empty box still shows the icon…');
  assert.equal(btn.disabled, true, '…just greyed out');

  input.value = 'now there is something';
  DevChat._syncSaveDraftBtn();
  assert.equal(btn.hidden, false);
  assert.equal(btn.disabled, false);
});

test('saving is refused mid-turn, not merely un-clickable', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');
  input.value = 'parked before the turn';
  DevChat._saveComposerDraft();

  // A click landing exactly as a turn starts, or any programmatic call.
  DevChat.isStreaming = true;
  input.value = 'must not become a draft mid-turn';
  DevChat._saveComposerDraft();

  assert.deepEqual(texts(DevChat), ['parked before the turn'],
    'the list is unchanged while the chat is running');
  assert.equal(input.value, 'must not become a draft mid-turn',
    'and the typed text is left in the box rather than swallowed');

  // Once the turn ends the same call works normally again.
  DevChat.isStreaming = false;
  DevChat._saveComposerDraft();
  assert.deepEqual(texts(DevChat),
    ['parked before the turn', 'must not become a draft mid-turn'],
    'saving resumes as soon as the chat is stopped');
  assert.equal(input.value, '', 'and the box is cleared for the next thought');
});
