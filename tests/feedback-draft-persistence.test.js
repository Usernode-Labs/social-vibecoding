// Frontend tests for issue #2796: closing Send Feedback is not throwing the
// words away. The backdrop, Cancel, the back gesture and a reload all keep
// the title and description; only a send clears them.
//
// The decisions these pin, from the request:
//   - every dismissal keeps the draft, and so does a reload (localStorage);
//   - only a successful send (or a save to the offline outbox, which owns the
//     words from then on) clears it;
//   - the destination is NOT restored — #2707 leaves that to the person;
//   - the draft belongs to the viewer: one per signed-in account, shared
//     across apps.
//
// Every dismissal path reaches the controller as `Feedback._reset` (the
// island's onClose), so the harness drives that directly, the way
// tests/feedback-target-choice.test.js drives `_open`.
//
// Run with: node --test tests/feedback-draft-persistence.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTROLLER_TEXT = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback-controller.js'),
  'utf8'
);
const FEEDBACK_SRC = CONTROLLER_TEXT
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
    readOnly: false,
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
    focus() {},
    click() { this.fire('click', { target: this, currentTarget: this }); },
  };
}

// A Map-backed localStorage shared across harnesses, so "reload" is a second
// harness over the same store.
function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const OPEN_APP = { name: 'Example App', repo_url: 'https://github.com/acme/example-app' };

function makeHarness({
  storage = makeStorage(), userId = 7, appData = null, search = '',
  feedbackQueue = null, fetchImpl = null,
} = {}) {
  const els = new Map();
  const fetchCalls = [];
  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    URLSearchParams,
    location: { search, hash: '', pathname: '/' },
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
      if (fetchImpl) return fetchImpl(url, opts);
      if (url === '/api/feedback/title') return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ issueUrl: 'https://example.invalid/1' }) };
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    localStorage: storage,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    AppView: {
      appData,
      issueStateAvailable: () => false,
      collectIssueState: async () => null,
      createPrForIssue: async () => {},
      close: () => {},
    },
    PlatformUI: { pullToRefresh: () => {}, toast: () => {} },
    FeedbackQueue: feedbackQueue || undefined,
    App: {},
    alert: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FEEDBACK_SRC, sandbox);
  sandbox.init();
  sandbox.App.currentApp = appData ? 'example-app' : null;
  sandbox.App.currentTab = appData ? 'app' : 'home';
  sandbox.App.user = userId == null ? null : { id: userId };

  const el = (id) => sandbox.document.getElementById(id);
  el('feedback-modal').classList.add('hidden');
  const flush = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
  };

  return {
    sandbox,
    storage,
    el,
    fetchCalls,
    open() {
      el('feedback-modal').classList.remove('hidden');
      sandbox.Feedback._open({});
    },
    // What the backdrop, Cancel, back and a kit dismiss all arrive as.
    dismiss() {
      sandbox.Feedback._reset();
      el('feedback-modal').classList.add('hidden');
    },
    type(text) {
      el('feedback-text').value = text;
      el('feedback-text').fire('input');
    },
    typeTitle(text) {
      el('feedback-title').value = text;
      el('feedback-title').fire('input');
    },
    text: () => el('feedback-text').value,
    title: () => el('feedback-title').value,
    async submit() {
      el('feedback-submit').fire('click');
      await flush();
    },
    flush,
    filed: () => fetchCalls.filter((c) => c.url === '/api/feedback'),
  };
}

test('dismissing keeps the text and title for the next open', () => {
  const h = makeHarness();
  h.open();
  h.typeTitle('Board scroll');
  h.type('Dragging a card scrolls the board back to the top.');
  h.dismiss();

  assert.equal(h.text(), '', 'the closed dialog holds nothing');
  h.open();
  assert.equal(h.text(), 'Dragging a card scrolls the board back to the top.');
  assert.equal(h.title(), 'Board scroll');
});

test('the draft survives a reload', () => {
  const storage = makeStorage();
  const before = makeHarness({ storage });
  before.open();
  before.typeTitle('Board scroll');
  before.type('Dragging a card scrolls the board back to the top.');
  // No dismissal at all: the page just goes away mid-sentence.

  const after = makeHarness({ storage });
  after.open();
  assert.equal(after.text(), 'Dragging a card scrolls the board back to the top.');
  assert.equal(after.title(), 'Board scroll');
});

test('a successful send clears the draft', async () => {
  const storage = makeStorage();
  const h = makeHarness({ storage });
  h.open();
  h.type('Dragging a card scrolls the board back to the top.');
  await h.submit();
  assert.equal(h.filed().length, 1, 'it was sent');
  h.dismiss();

  assert.equal(storage.map.size, 0, 'nothing is left in storage');
  h.open();
  assert.equal(h.text(), '', 'and the next open starts empty');

  const reloaded = makeHarness({ storage });
  reloaded.open();
  assert.equal(reloaded.text(), '', 'across a reload too');
});

test('a dismissal while the send is in flight does not resurrect the sent words', async () => {
  const storage = makeStorage();
  let respond;
  const h = makeHarness({
    storage,
    fetchImpl: (url) => (url === '/api/feedback'
      ? new Promise((r) => { respond = r; })
      : Promise.resolve({ ok: true, json: async () => ({}) })),
  });
  h.open();
  h.type('Dragging a card scrolls the board back to the top.');
  h.el('feedback-submit').fire('click');
  await h.flush();
  h.dismiss(); // saves the words as a draft while the POST is pending
  respond({ ok: true, json: async () => ({ issueUrl: 'https://example.invalid/1' }) });
  await h.flush();

  h.open();
  assert.equal(h.text(), '', 'the filed feedback is not offered again');
});

test('a failed send keeps the draft', async () => {
  const h = makeHarness({
    fetchImpl: (url) => Promise.resolve(url === '/api/feedback'
      ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      : { ok: true, json: async () => ({}) }),
  });
  h.open();
  h.type('Dragging a card scrolls the board back to the top.');
  await h.submit();
  h.dismiss();
  h.open();
  assert.equal(h.text(), 'Dragging a card scrolls the board back to the top.');
});

test('clearing both fields and closing forgets the draft', () => {
  const storage = makeStorage();
  const h = makeHarness({ storage });
  h.open();
  h.type('Dragging a card scrolls the board back to the top.');
  h.type('');
  h.dismiss();
  assert.equal(storage.map.size, 0);
});

test('the destination is not restored (#2707)', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.type('Dragging a card scrolls the board back to the top.');
  h.el('feedback-target-app').fire('click');
  assert.equal(h.el('feedback-target-app').getAttribute('aria-checked'), 'true');
  h.dismiss();

  h.open();
  assert.equal(h.text(), 'Dragging a card scrolls the board back to the top.');
  assert.equal(h.el('feedback-target-app').getAttribute('aria-checked'), 'false');
  assert.equal(h.el('feedback-target-platform').getAttribute('aria-checked'), 'false');
  // #2888: the question is asked again (Submit stays pressable and refuses
  // with the row turned red until a destination is tapped).
  assert.equal(h.el('feedback-target-hint').classList.contains('hidden'), false, 'the person still has to choose');
});

test('the draft belongs to the viewer', () => {
  const storage = makeStorage();
  const alice = makeHarness({ storage, userId: 7 });
  alice.open();
  alice.type('Alice’s half-written report.');
  alice.dismiss();

  const bob = makeHarness({ storage, userId: 8 });
  bob.open();
  assert.equal(bob.text(), '', 'another account on the same device sees nothing');

  const aliceAgain = makeHarness({ storage, userId: 7 });
  aliceAgain.open();
  assert.equal(aliceAgain.text(), 'Alice’s half-written report.');
});

test('the draft is shared across apps', () => {
  const storage = makeStorage();
  const onApp = makeHarness({ storage, appData: OPEN_APP });
  onApp.open();
  onApp.type('The platform menu covers the app header.');
  onApp.dismiss();

  const onHome = makeHarness({ storage, appData: null });
  onHome.open();
  assert.equal(onHome.text(), 'The platform menu covers the app header.');
});

test('?shot= review states neither save nor restore a draft', () => {
  const storage = makeStorage();
  const real = makeHarness({ storage });
  real.open();
  real.type('A real draft.');
  real.dismiss();

  const shot = makeHarness({ storage, search: '?shot=feedback' });
  shot.open();
  assert.equal(shot.text(), '', 'the photograph shows the empty dialog');
  shot.type('Synthetic words.');
  shot.dismiss();

  const again = makeHarness({ storage });
  again.open();
  assert.equal(again.text(), 'A real draft.', 'and the real draft is untouched');
});

test('storage that throws never breaks the dialog', () => {
  const broken = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  const h = makeHarness({ storage: broken });
  h.open();
  h.type('Still typing.');
  h.dismiss();
  h.open();
  assert.equal(h.text(), '');
});

test('a failed outbox record is not taken over a saved draft', async () => {
  const storage = makeStorage();
  let takes = 0;
  const feedbackQueue = {
    takeFailed: async () => { takes += 1; return { payload: { description: 'Old failed words.' }, lastError: 'nope' }; },
    count: async () => 0,
    pending: async () => [],
    init: () => {},
  };
  const h = makeHarness({ storage, feedbackQueue });
  h.open();
  await h.flush();
  assert.equal(h.text(), 'Old failed words.', 'an empty composer gets the failed send back');
  assert.equal(takes, 1);
  h.dismiss();

  // That hand-back is now the draft; reopening shows it and leaves the
  // outbox alone rather than consuming a record it would have to discard.
  h.open();
  await h.flush();
  assert.equal(h.text(), 'Old failed words.');
  assert.equal(takes, 1, 'takeFailed is not called while a draft is on screen');
});
