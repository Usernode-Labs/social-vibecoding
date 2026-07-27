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
//      was the whole point of the issue. Nor any measured figure: the
//      picker is entirely static editorial copy now.
//   2. Each option reads "<label> — <what kind of work it is for>", and
//      the copy positions Opus and Fable as peers (heavy coding vs.
//      design/taste) rather than a size ladder.
//   3. The caption under the dropdown describes the SELECTED model in a
//      full sentence and follows the selection when it changes.
//   4. Missing guidance degrades to bare labels with the caption hidden
//      — never a crash.
//   5. The guidance copy in dev-chat.js's seed map has not drifted from
//      src/services/models.js, which is authoritative.
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

// The three-model map GET /api/models sends: label + guidance copy, and
// nothing measured. Mirrors src/services/models.js — the copy-drift guard
// at the bottom of this file is what keeps that true.
function guidanceMap() {
  return {
    'claude-sonnet-5': {
      label: 'Sonnet 5',
      changeSize: {
        short: 'simple, small changes',
        long: 'One small thing at a time: a text tweak, a colour, a single file.',
      },
    },
    'claude-opus-5': {
      label: 'Opus 5',
      changeSize: {
        short: 'general coding work',
        long: 'Anything from a quick fix to a multi-file feature, a refactor, or debugging that needs real digging.',
      },
    },
    'claude-fable-5': {
      label: 'Fable 5',
      changeSize: {
        short: 'design, taste, and difficult coding',
        long: 'Design and taste — how a screen looks, reads, and feels — plus the most difficult coding work.',
      },
    },
  };
}

function render(overrides) {
  const h = makeHarness();
  h.DevChat.MODELS = (overrides && overrides.models) || guidanceMap();
  h.DevChat.selectedModel = (overrides && overrides.selected) || 'claude-opus-5';
  h.DevChat.renderChatView();
  return { ...h, html: h.getEl('dc-view').innerHTML };
}

// ── 1. no price text anywhere ───────────────────────────────────────

test('the composer renders no price text at all (#800)', () => {
  const { html } = render();
  assert.ok(!html.includes('MTok'), 'found "MTok" in the composer markup');
  // Valid again now that the picker shows no measured cost figure either.
  assert.ok(!html.includes('$'), 'found a "$" in the composer markup');
});

test('the seed MODELS map carries no price and no measured figures', () => {
  const { DevChat } = makeHarness();
  for (const [id, meta] of Object.entries(DevChat.MODELS)) {
    assert.equal(meta.outputCostPerMTok, undefined, `${id} still seeds a price`);
    assert.equal(meta.stats, undefined, `${id} still seeds a stats block`);
  }
  // And Haiku is gone from the seed set too, so the dropdown never offers
  // it even before /api/models resolves.
  assert.ok(!('claude-haiku-4-5' in DevChat.MODELS));
});

// ── 2. option text: what kind of work, not how big ──────────────────

test('each option reads "<label> — <what it is for>"', () => {
  const { html } = render();
  for (const expected of [
    'Sonnet 5 — simple, small changes',
    'Opus 5 — general coding work',
    'Fable 5 — design, taste, and difficult coding',
  ]) {
    assert.ok(
      html.includes(expected),
      `missing option "${expected}"; got: ${html.match(/<option[^>]*>[^<]*<\/option>/g)}`
    );
  }
});

test('no option implies a size ladder between Opus and Fable', () => {
  const { html } = render();
  // The superseded copy positioned Fable as the "bigger" model. Opus is
  // now the general coding pick and Fable the taste pick, so this exact
  // string must not come back.
  assert.ok(!html.includes('Fable 5 — big or tricky work'));
  assert.ok(!html.includes('a few files'));
  // #809: Opus is the general-purpose coding model, not one reserved for
  // big or tricky changes — the old restrictive wording must not return.
  assert.ok(
    !html.includes('Opus 5 — big or tricky coding'),
    'Opus option reverted to the superseded "big or tricky" framing'
  );
});

test('modelOptionText degrades to the bare label without guidance', () => {
  const { DevChat } = makeHarness();
  assert.equal(DevChat.modelOptionText({ label: 'Opus 5' }), 'Opus 5');
  assert.equal(DevChat.modelOptionText({ label: 'Opus 5', changeSize: {} }), 'Opus 5');
  assert.equal(DevChat.modelOptionText(null), '');
});

// ── 3. the caption ──────────────────────────────────────────────────

test('the caption describes the selected model in a full sentence', () => {
  const { getEl } = render({ selected: 'claude-opus-5' });
  const note = getEl('dc-model-note');
  // Locks modelNoteText's first-character lower-casing against the new
  // strings: "Anything from …" has to read as "best for anything from …".
  assert.equal(
    note.textContent,
    'Opus 5 — best for anything from a quick fix to a multi-file feature, a refactor, or debugging that needs real digging.'
  );
  assert.equal(note.classList.contains('hidden'), false);
});

test('the caption carries the guidance tooltip, not the old size-ladder wording', () => {
  const { getEl } = render();
  const note = getEl('dc-model-note');
  assert.match(note.title, /general coding pick/);
  assert.match(note.title, /genuinely difficult/);
  assert.match(note.title, /A suggestion, not a rule/);
  assert.ok(
    !/Bigger models/i.test(note.title),
    'tooltip reverted to the superseded "bigger models cost more" framing'
  );
});

test('the caption follows the selection when the dropdown changes', () => {
  const { DevChat, getEl } = render({ selected: 'claude-opus-5' });
  const note = getEl('dc-model-note');
  assert.match(note.textContent, /^Opus 5 —/);

  getEl('dc-model-select')._fire('change', { target: { value: 'claude-fable-5' } });

  assert.equal(DevChat.selectedModel, 'claude-fable-5');
  assert.equal(
    note.textContent,
    'Fable 5 — best for design and taste — how a screen looks, reads, and feels — '
      + 'plus the most difficult coding work.'
  );
});

test('the Fable option owns difficult coding without displacing Opus as the general pick', () => {
  const { html } = render();
  // The trio's positioning: Sonnet = simple/small, Opus = general
  // coding, Fable = design/taste plus the MOST difficult coding. Fable
  // gaining "difficult coding" must not revert Opus to a
  // big-or-tricky-only framing.
  assert.ok(html.includes('Fable 5 — design, taste, and difficult coding'));
  assert.ok(!html.includes('Opus 5 — big or tricky coding'));
  assert.ok(html.includes('Opus 5 — general coding work'));
});

test('the Sonnet caption stays the small-change pick', () => {
  const { getEl } = render({ selected: 'claude-sonnet-5' });
  assert.equal(
    getEl('dc-model-note').textContent,
    'Sonnet 5 — best for one small thing at a time: a text tweak, a colour, a single file.'
  );
});

// ── 4. missing guidance degrades, never crashes ─────────────────────

test('a model with no guidance renders a bare label with the caption hidden', () => {
  const models = { 'claude-opus-5': { label: 'Opus 5' } };
  const { html, getEl } = render({ models });

  assert.ok(html.includes('>Opus 5</option>'), 'expected a bare label option');
  assert.ok(!html.includes('best for'));

  const note = getEl('dc-model-note');
  assert.equal(note.textContent, '');
  assert.equal(note.classList.contains('hidden'), true);
});

test('a garbage MODELS entry does not throw the whole chat view', () => {
  assert.doesNotThrow(() => {
    render({ models: { 'claude-opus-5': { label: 'Opus 5', changeSize: null } } });
  });
});

// ── 5. copy-drift guard ─────────────────────────────────────────────
// The guidance copy lives in TWO places by design: src/services/models.js
// is authoritative, and dev-chat.js seeds a duplicate purely so the
// dropdown paints correctly before /api/models resolves. Nothing else in
// the suite would notice them diverging, and a drift would show users one
// string then silently swap it for another mid-load.

test('the dev-chat seed map matches src/services/models.js exactly', () => {
  const server = require('../src/services/models');
  const { DevChat } = makeHarness();

  assert.deepEqual(
    Object.keys(DevChat.MODELS).sort(),
    Object.keys(server.MODELS).sort(),
    'seed map and allowlist offer different models'
  );

  for (const [id, serverMeta] of Object.entries(server.MODELS)) {
    const seedMeta = DevChat.MODELS[id];
    assert.ok(seedMeta, `${id} missing from the dev-chat seed map`);
    assert.equal(seedMeta.label, serverMeta.label, `${id} label drifted`);
    assert.equal(
      seedMeta.changeSize.short, serverMeta.changeSize.short,
      `${id} changeSize.short drifted between models.js and dev-chat.js`
    );
    assert.equal(
      seedMeta.changeSize.long, serverMeta.changeSize.long,
      `${id} changeSize.long drifted between models.js and dev-chat.js`
    );
  }
});
