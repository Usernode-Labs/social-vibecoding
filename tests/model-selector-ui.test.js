// UI contract for the #800 model selector in public/js/dev-chat.js.
//
// Same approach as openSession-streaming-reset.test.js: dev-chat.js is a
// plain browser script (`const DevChat = {…}`), so we load its source
// into a vm context, expose DevChat, and drive the REAL renderChatView
// against a minimal fake DOM — asserting on the markup a user would see
// rather than on tokens in the source.
//
// What must hold:
//   1. No price text ($ / MTok) survives anywhere in the picker — that
//      was the whole point of the issue.
//   2. A model with enough data reads "<label> — solves <lo>–<hi>% ·
//      <size hint>"; one below the threshold reads "new" instead of a
//      fake-precise number.
//   3. The caption under the dropdown describes the SELECTED model and
//      follows the selection when it changes.
//   4. stats:null (aggregate failed, or the pre-fetch seed map) degrades
//      to bare labels with the caption hidden — never a crash.
//
// Run with: node --test tests/model-selector-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// ── Minimal fake DOM ────────────────────────────────────────────────
// Registry-backed like the streaming-reset harness (getElementById keeps
// returning the same handle across innerHTML rewrites), plus real
// listener capture and a real classList.toggle so the caption's
// show/hide can be asserted.
function makeElement(id) {
  const classes = new Set();
  const listeners = new Map();
  return {
    id,
    style: {},
    dataset: {},
    _attrs: {},
    _children: [],
    _listeners: listeners,
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    value: '',
    scrollHeight: 0,
    scrollTop: 0,
    className: '',
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: (x, force) => {
        const on = force === undefined ? !classes.has(x) : !!force;
        if (on) classes.add(x); else classes.delete(x);
        return on;
      },
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    // Test seam: dispatch a captured listener.
    _fire(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    appendChild(c) { this._children.push(c); return c; },
    removeChild() {},
    insertBefore(c) { this._children.push(c); return c; },
    replaceChildren() { this._children = []; },
    append() {}, prepend() {}, remove() {},
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, setSelectionRange() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
    },
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
    addEventListener() {}, removeEventListener() {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
    hidden: false,
    visibilityState: 'visible',
  };

  const storage = new Map();
  const sandbox = {
    console,
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    document,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: { sendBeacon: () => true },
    EventSource: class { constructor() { this.readyState = 1; } close() {} },
    URL,
    Blob: class { constructor() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    // Real-ish escaping so an assertion on "—" / "·" isn't defeated by a
    // pass-through stub, while still keeping the markup readable.
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    PlatformUI: {
      isTouch: () => false, hasKit: () => false, toast: () => {},
      alert: async () => ({}), confirm: async () => true,
      transition: (fn) => fn(),
      attachScreenFx: () => {}, detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }),
      swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Neutralize the heavy DOM plumbing renderChatView calls — none of it
  // touches the model row, and all of it wants a real document.
  for (const fn of [
    'renderMessages', 'refreshBudget', 'initScrollTracking', 'restoreSessionScroll',
    '_setupTextareaResize', '_setupKeyboardShortcuts', '_restoreDraft',
    'renderSessionList', '_loadSpecViewer', '_startHeartbeat', '_setNotifyOnDone',
    '_renderQuickReplies', '_wireQuickReplies', '_wireCreditsBanner',
    '_setupAttachments', '_renderSavedDrafts', '_wireSavedDrafts', '_syncSaveDraftBtn',
  ]) DevChat[fn] = () => {};
  for (const fn of [
    '_renderSyncBannerHtml', '_renderNewChangeBannerHtml', '_renderCreditsBannerHtml',
    '_renderHeaderStatusPill',
  ]) DevChat[fn] = () => '';

  DevChat.currentSession = { id: 7, branch_name: 'dev/x', session_title: 'A change' };
  DevChat.messages = [];

  return { DevChat, getEl };
}

// Three-model map mirroring what GET /api/models sends: one with a band,
// one below the threshold, one more with a band.
function statsMap() {
  return {
    'claude-sonnet-5': {
      label: 'Sonnet 5',
      changeSize: {
        short: 'small changes',
        long: 'One small thing at a time: a text tweak, a colour, a single file.',
      },
      stats: {
        attempts: 19, solved: 10, lowPct: null, highPct: null, hasEnoughData: false,
      },
    },
    'claude-opus-5': {
      label: 'Opus 5',
      changeSize: {
        short: 'a few files',
        long: 'A normal fix or feature: a few files, one screen.',
      },
      stats: {
        attempts: 312, solved: 149, lowPct: 43, highPct: 52, hasEnoughData: true,
      },
    },
    'claude-fable-5': {
      label: 'Fable 5',
      changeSize: {
        short: 'big or tricky work',
        long: 'Multi-file features, refactors, and debugging that needs real digging.',
      },
      stats: {
        attempts: 401, solved: 221, lowPct: 51, highPct: 59, hasEnoughData: true,
      },
    },
  };
}

function render(overrides) {
  const h = makeHarness();
  h.DevChat.MODELS = (overrides && overrides.models) || statsMap();
  h.DevChat.selectedModel = (overrides && overrides.selected) || 'claude-opus-5';
  h.DevChat.renderChatView();
  return { ...h, html: h.getEl('dc-view').innerHTML };
}

// ── 1. no price text anywhere ───────────────────────────────────────

test('the composer no longer renders any $/MTok price text (#800)', () => {
  const { html } = render();
  assert.ok(!html.includes('MTok'), 'found "MTok" in the composer markup');
  assert.ok(!html.includes('$'), 'found a "$" in the composer markup');
});

test('the seed MODELS map carries no price field at all', () => {
  const { DevChat } = makeHarness();
  for (const [id, meta] of Object.entries(DevChat.MODELS)) {
    assert.equal(meta.outputCostPerMTok, undefined, `${id} still seeds a price`);
  }
  // And Haiku is gone from the seed set too, so the dropdown never offers
  // it even before /api/models resolves.
  assert.ok(!('claude-haiku-4-5' in DevChat.MODELS));
});

// ── 2. option text ──────────────────────────────────────────────────

test('a model with enough data shows its solve range and size hint', () => {
  const { html } = render();
  assert.ok(
    html.includes('Opus 5 — solves 43–52% · a few files'),
    `option text missing; got: ${html.match(/<option[^>]*>[^<]*<\/option>/g)}`
  );
  assert.ok(html.includes('Fable 5 — solves 51–59% · big or tricky work'));
});

test('a model below the attempts threshold reads "new", not a percentage', () => {
  const { html } = render();
  assert.ok(html.includes('Sonnet 5 — new · small changes'));
  assert.ok(!html.includes('Sonnet 5 — solves'));
});

test('modelOptionText degrades to the bare label without guidance', () => {
  const { DevChat } = makeHarness();
  assert.equal(
    DevChat.modelOptionText({ label: 'Opus 5', stats: { hasEnoughData: true, lowPct: 1, highPct: 2 } }),
    'Opus 5'
  );
  assert.equal(DevChat.modelOptionText(null), '');
});

// ── 3. the caption ──────────────────────────────────────────────────

test('the caption describes the selected model in full sentences', () => {
  const { getEl } = render({ selected: 'claude-opus-5' });
  const note = getEl('dc-model-note');
  assert.equal(
    note.textContent,
    'Opus 5 — merged 43–52% of the issues it was pointed at (312 attempts in the last 90 days). '
      + 'Best for a normal fix or feature: a few files, one screen.'
  );
  assert.match(note.title, /share that ended with the change actually merged/);
  assert.equal(note.classList.contains('hidden'), false);
});

test('the below-threshold caption says so instead of quoting a rate', () => {
  const { getEl } = render({ selected: 'claude-sonnet-5' });
  const note = getEl('dc-model-note');
  assert.equal(
    note.textContent,
    'Sonnet 5 — not enough finished attempts yet to show a solve rate (19 so far). '
      + 'Best for one small thing at a time: a text tweak, a colour, a single file.'
  );
});

test('the caption follows the selection when the dropdown changes', () => {
  const { DevChat, getEl } = render({ selected: 'claude-opus-5' });
  const note = getEl('dc-model-note');
  assert.match(note.textContent, /^Opus 5 —/);

  getEl('dc-model-select')._fire('change', { target: { value: 'claude-fable-5' } });

  assert.equal(DevChat.selectedModel, 'claude-fable-5');
  assert.match(note.textContent, /^Fable 5 — merged 51–59% of the issues/);
  assert.match(note.textContent, /Best for multi-file features/);
});

test('staging demo numbers are labelled as such in the caption', () => {
  const { DevChat } = makeHarness();
  const text = DevChat.modelNoteText({
    label: 'Opus 5',
    changeSize: { short: 'a few files', long: 'A normal fix or feature: a few files, one screen.' },
    stats: { attempts: 312, solved: 149, lowPct: 43, highPct: 52, hasEnoughData: true, demo: true },
  });
  assert.ok(text.endsWith('· staging demo data'), text);
});

// ── 4. missing stats degrade, never crash ───────────────────────────

test('stats:null renders bare labels with the caption hidden', () => {
  const models = statsMap();
  for (const meta of Object.values(models)) meta.stats = null;

  const { html, getEl } = render({ models });

  assert.ok(html.includes('>Opus 5</option>'), 'expected a bare label option');
  assert.ok(!html.includes('solves'));
  assert.ok(!html.includes('new ·'));

  const note = getEl('dc-model-note');
  assert.equal(note.textContent, '');
  assert.equal(note.classList.contains('hidden'), true);
});

test('a garbage MODELS entry does not throw the whole chat view', () => {
  assert.doesNotThrow(() => {
    render({ models: { 'claude-opus-5': { label: 'Opus 5' } } });
  });
});
