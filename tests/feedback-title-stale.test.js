// Frontend tests for issue #732: an early submit must not file the
// feedback issue with a title that was auto-generated from a PARTIAL
// description. submitFeedback() now sends body.title only when the user
// typed it themselves (titleDirty) or the auto-fill is fresh (it was
// generated from exactly the description being submitted); otherwise
// the title is omitted so the server names the issue from the full
// text. It also cancels the pending preview debounce at submit so an
// in-flight preview can't rewrite the field mid-submit.
//
// We load the real app.js into a vm context (so the tests can't drift
// from shipped code), run App.bindEvents() against stub DOM elements
// with recorded listeners, fake timers, and a recording fetch, then
// drive the type → auto-fill → submit flows and assert on the body
// sent to POST /api/feedback.
//
// Run with: node --test tests/feedback-title-stale.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'),
  'utf8'
);

// Stub DOM element: records addEventListener handlers so tests can fire
// 'input' / 'click' / 'blur' events the way the browser would.
function makeEl(id) {
  const listeners = {};
  return {
    id,
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    className: '',
    innerHTML: '',
    placeholder: '',
    disabled: false,
    checked: false,
    listeners,
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => false,
    },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev, arg) { for (const fn of (listeners[ev] || [])) fn(arg); },
    setAttribute: () => {},
    hasAttribute: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus: () => {},
    click() { this.fire('click', { target: this, currentTarget: this }); },
  };
}

// Build a vm sandbox running the real app.js with:
//  - memoized stub elements for every getElementById (null for
//    header-menu-btn so HeaderMenu.init early-returns),
//  - fake timers (recorded, manually runnable/flushable),
//  - a recording fetch that answers the title-preview and feedback
//    endpoints.
function makeHarness({ previewTitle = 'Partial Title' } = {}) {
  const els = new Map();
  const timers = new Map();
  let timerId = 0;
  const fetchCalls = [];

  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    URLSearchParams,
    location: { search: '', hash: '', pathname: '/' },
    document: {
      getElementById: (id) => {
        if (id === 'header-menu-btn') return null; // HeaderMenu.init early-return
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: (tag) => makeEl(tag),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url, opts });
      if (url === '/api/feedback/title') {
        return { ok: true, json: async () => ({ title: previewTitle }) };
      }
      return { ok: true, json: async () => ({}) };
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    // bindEvents dereferences AppView.closeRenameModal etc. at bind
    // time — a permissive stub keeps the wiring alive; appData stays
    // undefined so the feedback target resolves to 'platform'.
    AppView: new Proxy({}, { get: (t, p) => (p === 'appData' ? undefined : () => {}) }),
    // Pull-to-refresh is platform presentation owned by PlatformUI. This
    // harness exercises feedback title wiring only, so keep that independent
    // production dependency inert rather than omitting the global entirely.
    PlatformUI: { pullToRefresh: () => {} },
    alert: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox);
  sandbox.window.App.bindEvents();

  const el = (id) => sandbox.document.getElementById(id);
  return {
    sandbox,
    fetchCalls,
    el,
    // Run every currently-pending fake timer (the debounce), then let
    // the async preview fetch settle.
    async flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const t of pending) t.fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    pendingTimerCount: () => timers.size,
    async settle() {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    typeDescription(text) {
      el('feedback-text').value = text;
      el('feedback-text').fire('input');
    },
    typeTitle(text) {
      el('feedback-title').value = text;
      el('feedback-title').fire('input');
    },
    async submit() {
      el('feedback-submit').fire('click');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    feedbackBody() {
      const call = fetchCalls.find((c) => c.url === '/api/feedback');
      assert.ok(call, 'POST /api/feedback was sent');
      return JSON.parse(call.opts.body);
    },
    titlePreviewCalls: () => fetchCalls.filter((c) => c.url === '/api/feedback/title').length,
  };
}

const FULL_DESC = 'add a button that exports the leaderboard as CSV';

test('fresh auto-fill (description unchanged) → title is sent', async () => {
  const h = makeHarness({ previewTitle: 'Export leaderboard as CSV' });
  h.typeDescription(FULL_DESC);
  await h.flushTimers(); // debounce fires, preview fills the field
  assert.equal(h.el('feedback-title').value, 'Export leaderboard as CSV', 'preview filled the Title field');
  await h.submit();
  assert.equal(h.feedbackBody().title, 'Export leaderboard as CSV', 'fresh auto-fill is sent (saves the server call)');
});

test('stale auto-fill (description extended, early submit) → title is omitted', async () => {
  const h = makeHarness({ previewTitle: 'Add a button' });
  h.typeDescription('add a button that');
  await h.flushTimers(); // preview generated from the partial description
  assert.equal(h.el('feedback-title').value, 'Add a button', 'partial preview landed');
  // Keep typing, then submit before the new debounce fires.
  h.typeDescription(FULL_DESC);
  await h.submit();
  const body = h.feedbackBody();
  assert.ok(!('title' in body), 'stale auto-filled title is dropped so the server names from the full text');
  assert.equal(body.description, FULL_DESC, 'full description is submitted');
});

test('user-typed title survives a later description change', async () => {
  const h = makeHarness();
  h.typeTitle('My Exact Title'); // input event → titleDirty
  h.typeDescription('add a button that');
  h.typeDescription(FULL_DESC);
  await h.submit();
  assert.equal(h.feedbackBody().title, 'My Exact Title', 'user-owned title is sent verbatim');
});

test('empty title field → no title key (regression guard)', async () => {
  const h = makeHarness();
  h.typeDescription(FULL_DESC); // debounce never flushed, field stays empty
  await h.submit();
  assert.ok(!('title' in h.feedbackBody()), 'empty field omits title as before');
});

test('pending debounce is cancelled at submit — no preview call fires after', async () => {
  const h = makeHarness();
  h.typeDescription(FULL_DESC); // schedules the debounce
  assert.equal(h.pendingTimerCount(), 1, 'debounce timer pending before submit');
  h.el('feedback-submit').fire('click'); // synchronous top of submitFeedback
  assert.equal(h.pendingTimerCount(), 0, 'submit cancelled the pending debounce');
  await h.settle();
  await h.flushTimers(); // only the post-success grace timer, if any
  assert.equal(h.titlePreviewCalls(), 0, 'no /api/feedback/title call fired after submit');
});
