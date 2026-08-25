// `#dc-composer-bar` — the dev chat's whole composer, as a React island.
//
// The bar looked like six independent controls and was really one state. Six
// writers reached into it, and every one of them was reading the SAME two
// questions — is a turn running, and where is this session built:
//
//   - `_setStreamingUI` wrote the send button's `disabled`, three state
//     classes, its `aria-label`, its `title` and its `innerHTML`; the
//     textarea's `placeholder`; and the OpenRouter row's `disabled`.
//   - `_syncSaveDraftBtn` wrote `hidden`, `disabled` and `title` on the save
//     icon, and called `_syncShortcutHint`, which wrote the hint's innerHTML.
//   - `_renderSavedDrafts` rebuilt `#dc-drafts` and toggled its active class.
//   - `_setAttachError` wrote the error line's text and its `hidden` class.
//   - `_refreshModelSelect` rewrote the picker's options in place.
//
// One publish answers it once. What this file pins is that seam, the four
// strips it absorbed, and the two rules that survived the conversion because
// they are load-bearing: the composer is HIDDEN rather than removed in a
// launchpad, and the field is UNCONTROLLED.
//
// Run with: node --test tests/dev-chat-composer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeComposerBridge, composerHtml } = require('./lib/dev-composer-html');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const DEV_CHAT_SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const COMPOSER_TSX = read('frontend', 'src', 'features', 'dev-chat', 'composer.tsx');
const MOUNT_TS = read('frontend', 'src', 'features', 'dev-chat', 'mount.ts');

function makeDevChat(over = {}) {
  const t = makeComposerBridge();
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, value: '', style: {}, dataset: {}, innerHTML: '', textContent: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, setAttribute() {},
        getAttribute: () => null, removeAttribute() {},
        querySelector: () => null, querySelectorAll: () => [],
        appendChild() {}, focus() {},
      });
    }
    return els.get(id);
  };
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentApp: 'demo-app', switchTab: () => {} },
    document: {
      getElementById: el,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      createElement: () => el('__created'),
      body: { appendChild() {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    navigator: { sendBeacon: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.UsernodeReact = { devChat: t.bridge };
  vm.createContext(sandbox);
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat.currentSession = { id: 7, status: 'active' };
  DevChat._currentVenueId = () => 'usernode-claude';
  Object.assign(DevChat, over);
  return { DevChat, sandbox, t, el, view: () => JSON.parse(JSON.stringify(DevChat._composerView())) };
}

// ── 1. The six writers are one publish ─────────────────────────────────

test('every writer that reached into the bar publishes instead', () => {
  for (const fn of [
    '_setStreamingUI', '_syncSaveDraftBtn', '_syncShortcutHint',
    '_renderSavedDrafts', '_setAttachError', '_refreshModelSelect',
  ]) {
    const at = DEV_CHAT_SRC.indexOf(`  ${fn}(`);
    assert.ok(at > 0, `${fn} is still the entry point every caller uses`);
    const body = DEV_CHAT_SRC.slice(at, DEV_CHAT_SRC.indexOf('\n  },', at));
    assert.match(body, /DevChat\._publishComposer\(\)/, `${fn} publishes`);
    assert.doesNotMatch(body, /\.innerHTML|\.textContent =|classList\.(add|remove|toggle)/,
      `${fn} touches no node`);
  }
  // …and the bar is the SCREEN's markup now (features/dev-chat/view.tsx),
  // which is what folded the last string in this module away. Its own class
  // run is still a decision made there rather than here.
  const VIEW_TSX = read('frontend', 'src', 'features', 'dev-chat', 'view.tsx');
  assert.match(VIEW_TSX, /id="dc-composer-bar" className=\{s\.barEmpty \? BAR\.bare : BAR\.framed\}/);
  assert.doesNotMatch(COMPOSER_TSX, /id="dc-composer-bar"/,
    'the composer renders the CHILDREN, never the bar');
});

test('the composer flushes synchronously, because its caller reads the DOM next', () => {
  // `_syncSaveDraftBtn` reads the textarea's live `value`; `_setupAttachments`,
  // `_restoreDraft` and the form's submit listener resolve controls by id on
  // the lines after the mount.
  assert.match(MOUNT_TS, /composerStore\.setFlush\(flushSync\);/);
});

// ── 2. The send button, which is the state most writers were about ─────

test('the send button resolves its four states from module state alone', () => {
  const { DevChat, view } = makeDevChat();
  assert.deepEqual(view().send, { kind: 'send' }, 'idle');

  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, 'cc');
  assert.deepEqual(view().send, { kind: 'stop' }, 'a stoppable turn');

  DevChat._setStreamingUI(true, 'mayor2');
  assert.equal(view().send.kind, 'busy', 'the wrap-up cannot be interrupted');
  assert.equal(view().send.label, 'Finishing up');

  DevChat._setStreamingUI(true, 'cc', { stoppable: false });
  assert.equal(view().send.label, 'Working', '#1378: running, but not stoppable from here');

  DevChat._stopping = true;
  assert.deepEqual(view().send, { kind: 'stopping' }, '#889 outranks both');

  DevChat._stopping = false;
  DevChat.isStreaming = false;
  DevChat._setStreamingUI(false);
  assert.deepEqual(view().send, { kind: 'send' });
});

test('the busy paint is not `isStreaming` — the ?shot capture has no turn', () => {
  // #801: the screenshot state paints a mid-turn composer with nothing
  // running, which is why the latch exists at all.
  const { DevChat, view } = makeDevChat();
  DevChat._setStreamingUI(true, 'claude');
  assert.equal(DevChat.isStreaming, false, 'no turn is running');
  assert.equal(view().send.kind, 'stop', 'and the composer still paints one');
  assert.equal(view().placeholder, DevChat.COMPOSER_PLACEHOLDER_BUSY);
});

// ── 3. The two rules that had to survive ───────────────────────────────

test('#1281: the composer is HIDDEN, never removed', () => {
  // Every public/js/** and chat-helper module looks its controls up by id. A
  // getElementById that started returning null would throw on a route the
  // checks load, and a console error on any route fails proposal checks.
  const { DevChat, view } = makeDevChat();
  DevChat._launchpadVenue = () => 'web-claude-code';
  assert.equal(view().hidden, true);
  const html = composerHtml(view());
  assert.match(html, /id="dc-composer-controls" hidden=""/);
  for (const id of ['dc-form', 'dc-input', 'dc-send-btn', 'dc-budget', 'dc-runner']) {
    assert.ok(html.includes(`id="${id}"`), `${id} is still in the document`);
  }
});

test('the field is UNCONTROLLED, because two module writers own its value', () => {
  // `_restoreDraft` and `_editSavedDraft` set `.value` directly and
  // `_setupTextareaResize` grows `style.height` on every keystroke. A
  // rendered `value` would make React the owner of the first, and a rendered
  // `style` would make it diff the second away.
  const at = COMPOSER_TSX.indexOf('<Textarea');
  const tag = COMPOSER_TSX.slice(at, COMPOSER_TSX.indexOf('/>', at));
  assert.doesNotMatch(tag, /\bvalue=/, 'no value prop');
  assert.doesNotMatch(tag, /\bdefaultValue=/, 'and no defaultValue either');
  assert.doesNotMatch(tag, /\bstyle=/, 'no style prop for the auto-grow to fight');
  assert.doesNotMatch(tag, /\bdisabled/, '#798: the box stays typable mid-turn');
});

// ── 4. What the four absorbed strips look like now ─────────────────────

test('the four strips inside it lost their hosts, not their stores', () => {
  // `#dc-attachments`, `#dc-quick-replies`, `#dc-runner` and `#dc-budget`
  // were four portal hosts written by the template. The composer renders
  // their elements, so what is left of each seam is its state.
  for (const gone of [
    'mountAttachStrip', 'mountQuickReplies', 'mountRunnerControls', 'mountBudgetPill',
  ]) {
    assert.doesNotMatch(DEV_CHAT_SRC, new RegExp(`react\\.${gone}\\(`), `${gone} has no caller`);
    assert.doesNotMatch(MOUNT_TS, new RegExp(`\\b${gone}\\(`), `${gone} is retired from the bridge`);
  }
  for (const kept of [
    'publishAttachStrip', 'publishQuickReplies', 'publishRunner', 'publishBudgetPill',
  ]) {
    assert.match(MOUNT_TS, new RegExp(`${kept}\\(state`), `${kept} still crosses the seam`);
  }
  // Their two `*-active` classes come from the same list that draws the rows
  // now, so there is one answer to "is this strip empty" instead of two.
  assert.doesNotMatch(DEV_CHAT_SRC, /classList\.toggle\('dc-(attach-strip|quick-replies)-active'/);
});

// ── 5. The provider split, as nullable fields ──────────────────────────

test('each venue gets its own model control, and the others get none', () => {
  const { DevChat, view } = makeDevChat();
  DevChat.MODELS = { 'claude-opus-5': { label: 'Opus 5' } };
  DevChat.selectedModel = 'claude-opus-5';
  assert.deepEqual(view().models, {
    options: [{ id: 'claude-opus-5', label: 'Opus 5' }], selected: 'claude-opus-5',
  });
  assert.equal(view().openRouter, null);

  DevChat._currentVenueId = () => 'usernode-openrouter';
  DevChat.currentSession = { id: 7, status: 'active', agent_model: 'x/y-flash' };
  assert.equal(view().models, null, 'no platform picker on a pinned session');
  assert.equal(view().openRouter.model, 'x/y-flash');

  DevChat.currentSession = { id: 7, status: 'active' };
  assert.equal(view().openRouter.model, 'No model is pinned');

  DevChat._currentVenueId = () => 'own-tools-pr';
  assert.equal(view().models, null);
  assert.equal(view().openRouter, null, 'a hand-off venue has no model control at all');
});

test('#800: an allowlist change reaches an open composer without losing the pick', () => {
  const { DevChat, view } = makeDevChat();
  DevChat.MODELS = { a: { label: 'A' }, b: { label: 'B' } };
  DevChat.selectedModel = 'b';
  DevChat._refreshModelSelect();
  assert.deepEqual(view().models.options.map((o) => o.id), ['a', 'b']);
  assert.equal(view().models.selected, 'b', 'the selection is a field, so it cannot be lost');
});

// ── 6. The venue sentence's latch ──────────────────────────────────────

test('the venue note survives a republish but not the next full render', () => {
  // It explains a venue you did NOT get: reported once, on the paint after
  // creation. Reading the reason per publish would clear it on the first
  // keystroke — the save icon and the hint flip on every one of them.
  const { DevChat } = makeDevChat();
  DevChat._venueNoteForRender = '<span>fell back to Claude</span>';
  DevChat._venueFallbackReason = null;
  assert.match(DevChat._composerView().venueNoteHtml, /fell back to Claude/);
  DevChat._syncSaveDraftBtn();
  assert.match(DevChat._composerView().venueNoteHtml, /fell back to Claude/,
    'a keystroke must not clear it');
  const at = DEV_CHAT_SRC.indexOf('DevChat._venueNoteForRender = window.BuildVenues');
  assert.ok(at > 0, 'the latch is set by the render that shows it');
  assert.match(DEV_CHAT_SRC.slice(at, at + 260), /DevChat\._venueFallbackReason = null;/,
    'and the reason is consumed there, not per publish');
});

test('the empty slots collapse, which is what their :empty rules need', () => {
  const html = composerHtml({
    venueNoteHtml: '', hidden: false, models: null, openRouter: null,
    drafts: { rows: [], busy: false }, attachError: null, placeholder: '',
    saveDraft: { hidden: true, disabled: true, title: '' },
    send: { kind: 'send' }, shortcutHintHtml: '',
  });
  assert.ok(html.startsWith('<div id="dc-venue-slot" class="dc-venue-slot"></div>'),
    '.dc-venue-slot:empty needs no children at all, not even a comment');
  assert.ok(html.includes('<div id="dc-drafts" class="dc-drafts"></div>'));
  assert.ok(html.includes('<div id="dc-attachments" class="dc-attach-strip"></div>'));
  assert.ok(html.includes('<span id="dc-runner" class="dc-runner"></span>'));
});

// ── 7. The error line, which now survives a repaint ────────────────────

test('the attach error is a field, so a repaint cannot swallow it', () => {
  const { DevChat, view } = makeDevChat();
  assert.equal(view().attachError, null);
  DevChat._setAttachError('That file is too big');
  assert.equal(view().attachError, 'That file is too big');
  assert.match(composerHtml(view()), /id="dc-attach-error" class="dc-attach-error">That file is too big/);

  DevChat._setAttachError(null);
  assert.equal(view().attachError, null);
  assert.match(composerHtml(view()), /id="dc-attach-error" class="dc-attach-error hidden"/);
});
