// Issue #2796: dismissing the Send feedback dialog keeps the draft.
//
// Cancel, a backdrop click, Escape and a kit dismiss all reach the
// controller's `_reset` through the island's onClose. That used to empty the
// description and the title, so a stray tap outside the card threw away
// whatever was being typed. Now the words stay in the fields for the next
// open, and only a send empties them. In memory only: a reload starts empty.
//
// Driven through the REAL controller in a vm context, the harness
// tests/feedback-title-stale.test.js established; the stub records classes so
// `_open`/`_reset` run their full paths.
//
// Run with: node --test tests/feedback-dismiss-keeps-draft.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FEEDBACK_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dialogs', 'feedback-controller.js'),
  'utf8'
)
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  + '\n;globalThis.Feedback = Feedback;\n';

function makeEl(id) {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  const children = new Map();
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
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
    },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev, arg) { for (const fn of (listeners[ev] || [])) fn(arg); },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    querySelector(sel) {
      if (!children.has(sel)) children.set(sel, makeEl(`${id}${sel}`));
      return children.get(sel);
    },
    querySelectorAll: () => [],
    focus: () => {},
    click() { this.fire('click', { target: this, currentTarget: this }); },
  };
}

function makeHarness({ user = { id: 7 }, queue = null } = {}) {
  const els = new Map();
  const timers = new Map();
  let timerId = 0;
  const fetchCalls = [];
  const appState = { user };

  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    URLSearchParams,
    location: { search: '', hash: '', pathname: '/' },
    document: {
      getElementById: (id) => {
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
      return { ok: true, json: async () => ({}) };
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    AppView: new Proxy({}, { get: (t, p) => (p === 'appData' ? undefined : () => {}) }),
    PlatformUI: { pullToRefresh: () => {}, toast: () => {} },
    App: new Proxy(appState, {
      get: (t, p) => t[p],
      set: (t, p, v) => { t[p] = v; return true; },
    }),
    alert: () => {},
  };
  if (queue) sandbox.FeedbackQueue = queue;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FEEDBACK_SRC, sandbox);
  sandbox.init();

  const el = (id) => sandbox.document.getElementById(id);
  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return {
    sandbox,
    el,
    settle,
    appState,
    fetchCalls,
    open: () => sandbox.Feedback._open({}),
    dismiss: () => sandbox.Feedback._reset(),
    type(text) { el('feedback-text').value = text; el('feedback-text').fire('input'); },
    typeTitle(text) { el('feedback-title').value = text; el('feedback-title').fire('input'); },
    async submit() { el('feedback-submit').fire('click'); await settle(); },
    filed() {
      return fetchCalls.filter((c) => c.url === '/api/feedback').map((c) => JSON.parse(c.opts.body));
    },
  };
}

const DESC = 'The board scrolls back to the top when I drag a card.';

test('a dismissal keeps the description and title for the next open', () => {
  const h = makeHarness();
  h.open();
  h.type(DESC);
  h.typeTitle('Board jumps to top on drag');
  h.dismiss(); // backdrop, Cancel and Escape all arrive here

  h.open();
  assert.equal(h.el('feedback-text').value, DESC, 'the description is back');
  assert.equal(h.el('feedback-title').value, 'Board jumps to top on drag', 'so is the title');
});

test('a kept title the user typed is still theirs when it is sent', async () => {
  const h = makeHarness();
  h.open();
  h.typeTitle('My exact title');
  h.type(DESC);
  h.dismiss();

  h.open();
  h.type(`${DESC} Only on Safari.`);
  await h.submit();
  const [body] = h.filed();
  assert.equal(body.title, 'My exact title', 'the typed title was not treated as a stale auto-fill');
  assert.equal(body.description, `${DESC} Only on Safari.`);
});

test('a successful send clears the draft, so the next open starts empty', async () => {
  const h = makeHarness();
  h.open();
  h.type(DESC);
  await h.submit();
  assert.equal(h.filed().length, 1);
  h.dismiss(); // the 1500 ms grace-window close

  h.open();
  assert.equal(h.el('feedback-text').value, '', 'the filed words are gone');
  assert.equal(h.el('feedback-title').value, '');
});

test('a draft kept by one account is not handed to the next one', () => {
  const h = makeHarness({ user: { id: 7 } });
  h.open();
  h.type(DESC);
  h.typeTitle('Private words');
  h.dismiss();

  h.appState.user = { id: 8 }; // sign-out and sign-in without a reload
  h.open();
  assert.equal(h.el('feedback-text').value, '', 'the other account sees an empty composer');
  assert.equal(h.el('feedback-title').value, '');
});

test('a kept draft does not consume a failed outbox record it cannot show', async () => {
  let takes = 0;
  const queue = {
    init: () => {},
    count: () => 0,
    takeFailed: () => { takes += 1; return { payload: { description: 'queued words' }, lastError: 'bad' }; },
  };
  const h = makeHarness({ queue });
  h.open();
  await h.settle();
  const firstTakes = takes;
  h.el('feedback-text').value = '';
  h.type(DESC);
  h.dismiss();

  h.open();
  await h.settle();
  assert.equal(takes, firstTakes, 'the record stays in the outbox for an empty open');
  assert.equal(h.el('feedback-text').value, DESC, 'and the kept draft is untouched');
});
