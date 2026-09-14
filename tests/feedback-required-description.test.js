// Frontend tests for issue #1603: an empty description must SAY it is
// required, both before you type and when you submit anyway.
//
// The behaviour this replaces was one line — `if (!text) return;` at the
// top of submitFeedback — and it was invisible from every angle: the
// button stayed enabled, no status was written, nothing was focused, and
// the server's own `400 Description is required` was never reached
// because the request was never sent. So the tests come in two halves:
//
//  - STATIC assertions that the requirement is on screen in the shipped
//    document (the label, its asterisk, aria-required, the empty error
//    node) and that the deep link exists in public/js/app.js. These read
//    the prerendered public/index.html, which is a generated artifact —
//    tests/README and the shell-build test own that lifecycle; here it is
//    simply the document the dapp.json checks will select against.
//
//  - BEHAVIOURAL assertions driven through the REAL controller in a vm
//    context, the harness tests/feedback-title-stale.test.js established.
//    Its stub elements no-op'd classList and setAttribute, which is
//    exactly the surface this change writes to, so the stubs here record
//    both.
//
// Run with: node --test tests/feedback-required-description.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTROLLER_PATH = path.join(
  ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback-controller.js'
);
const CONTROLLER_TEXT = fs.readFileSync(CONTROLLER_PATH, 'utf8');
const MARKUP_PATH = path.join(ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback.tsx');
const MARKUP_TEXT = fs.readFileSync(MARKUP_PATH, 'utf8');

// The exact copy. Asserted as a literal in both halves on purpose: the
// declared dapp.json check matches on this text, so a reword that only
// touched one of the two would go green here and fail the merge gate.
const MESSAGE = 'Please add a description.';

// ── Half one: the requirement is in the shipped document ─────────────

test('the description field carries a label, a required marker and aria-required', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  const label = html.match(/<label[^>]*id="feedback-text-label"[^>]*>(.*?)<\/label>/s);
  assert.ok(label, '#feedback-text-label is in the document');
  assert.match(label[1], /Description/, 'it reads "Description"');
  assert.match(
    label[1],
    /id="feedback-text-required"/,
    'the required marker is INSIDE the label — the declared check selects it through that anchor'
  );

  const textarea = html.match(/<textarea[^>]*id="feedback-text"[^>]*>/);
  assert.ok(textarea, '#feedback-text is in the document');
  assert.match(textarea[0], /aria-required="true"/, 'the requirement is announced');
  // Not the HTML attribute: these fields are not inside a <form>, so
  // `required` buys no native behaviour while switching :invalid on for
  // a field nobody has touched yet.
  assert.doesNotMatch(
    textarea[0],
    /\srequired(=|\s|>)/,
    'the bare `required` attribute is deliberately not used'
  );
});

test('the inline error node ships empty and hidden', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const node = html.match(/<p[^>]*id="feedback-text-error"[^>]*>(.*?)<\/p>/s);
  assert.ok(node, '#feedback-text-error is in the document');
  assert.match(node[0], /class="[^"]*\bhidden\b/, 'it starts hidden');
  assert.match(node[0], /role="alert"/, 'it is announced when it is filled');
  assert.equal(node[1].trim(), '', 'it renders EMPTY — the controller owns the text');
  assert.ok(
    !html.includes(MESSAGE),
    'the message is not prerendered: a refusal on open would be a lie, and a hydration mismatch'
  );
});

test('the title field is labelled optional, so the asterisk reads as a rule', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const label = html.match(/<label[^>]*id="feedback-title-label"[^>]*>(.*?)<\/label>/s);
  assert.ok(label, '#feedback-title-label is in the document');
  assert.match(label[1], /Title/);
  assert.match(label[1], /optional/);
});

test('the markup source keeps the fields uncontrolled', () => {
  // The island renders this tree once and the controller writes into it;
  // a rendered `value` would fight that owner. Guarding it here because
  // this change is the first to touch these two fields since the split.
  const fields = MARKUP_TEXT.slice(
    MARKUP_TEXT.indexOf('id="feedback-title"'),
    MARKUP_TEXT.indexOf('id="feedback-text-error"')
  );
  assert.ok(fields.length > 0);
  assert.doesNotMatch(fields, /\bvalue=/, 'neither field renders a value');
});

test('the empty-description branch is the FIRST thing submit does', () => {
  const submit = CONTROLLER_TEXT.slice(CONTROLLER_TEXT.indexOf('const submitFeedback = async'));
  assert.ok(submit.length > 0, 'submitFeedback is still named that');

  const guard = submit.indexOf('if (!text)');
  assert.ok(guard > 0, 'the empty-description guard is still there');
  assert.match(
    submit.slice(guard, guard + 120),
    /showDescriptionError\(\)/,
    'and it now explains itself instead of returning silently'
  );

  // Ahead of the offline branch specifically: that one queues the message
  // on the device, so a later guard would save an empty description.
  const offline = submit.indexOf('isOfflineNow()');
  assert.ok(offline > 0, 'the offline branch is still there');
  assert.ok(guard < offline, 'the empty check runs before anything can queue or send');
});

test('the copy lives in exactly one place', () => {
  const hits = CONTROLLER_TEXT.split(MESSAGE).length - 1;
  assert.equal(hits, 1, `"${MESSAGE}" is written once, in showDescriptionError`);
});

test('?shot=feedback-required is a recognised deep link', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  // Scoped to the method, so a match cannot come from somewhere else in
  // this 5000-line file.
  const start = app.indexOf('_applyFeedbackShot() {');
  assert.ok(start > 0, 'the shot handler is still named that');
  const shot = app.slice(start, app.indexOf('renderAdminButton()', start));
  assert.ok(shot.length > 0, 'and still sits above renderAdminButton');
  assert.match(shot, /'feedback-required'/, 'the shot name is accepted');
  assert.match(shot, /feedback-text-error/, 'and it waits for the visible refusal');
  assert.match(
    shot,
    /App\._simulateEmptyFeedbackSubmit/,
    'through the controller hook, like the capture-failure shot beside it'
  );
  assert.match(
    CONTROLLER_TEXT,
    /App\._simulateEmptyFeedbackSubmit = \(\) => \{ void submitFeedback\(\); \}/,
    'and that hook runs the real submit rather than a mock of it'
  );
});

test('both declared checks exist and match the shipped ids and copy', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  const declared = manifest.tests || [];

  const marker = declared.find((t) => t.expectSelector
    && t.expectSelector.includes('#feedback-text-required'));
  assert.ok(marker, 'the required marker is covered');
  assert.equal(marker.path, '/?shot=feedback');

  const error = declared.find((t) => t.path === '/?shot=feedback-required');
  assert.ok(error, 'the empty submit is covered');
  assert.match(error.expectSelector, /#feedback-text-error:not\(\.hidden\)/);
  assert.ok(
    MESSAGE.startsWith(error.expectText),
    'the check\'s expectText is a prefix of the message the controller writes'
  );

  // Both selectors reach the card through `body:has(...)`, never as a
  // DESCENDANT of #feedback-modal. useStaticModal lifts the card out of
  // that root into the native kit's own shell when the dialog opens
  // (the root keeps only a <!--platform-modal-home--> placeholder), so
  // `#feedback-modal:not(.hidden) #feedback-text-label` matches nothing
  // precisely when the dialog IS open — a born-failing check. #1284's
  // two entries above already use this form; these follow it.
  for (const t of [marker, error]) {
    assert.match(
      t.expectSelector,
      /^body:has\(#feedback-modal:not\(\.hidden\)\) /,
      `${t.name}: the card is selected via body:has(), not through the lifted root`
    );
  }
});

// ── Half two: the controller, run for real ───────────────────────────

// Same treatment as tests/feedback-title-stale.test.js: frontend/ is ESM
// and there is no bundler here, so the two module keywords come off. The
// single import is a side-effect one these flows never reach.
// `Feedback` is an exported const, so unlike `init` (a function
// declaration) it does not land on the sandbox by itself — the last line
// hands it over so the open/close halves can be driven directly.
const FEEDBACK_SRC = CONTROLLER_TEXT
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  + '\n;globalThis.Feedback = Feedback;\n';

// The stub from feedback-title-stale.test.js, with the two surfaces this
// change writes to made observable: `classes` records the live class set
// and `attrs` the setAttribute/removeAttribute pairs.
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
    focused: 0,
    listeners,
    classes,
    attrs,
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
    // Element-level, unlike document's below: init() reads the screenshot
    // button's `[data-screenshot-label]` span and then writes to it, and a
    // null there makes _open/_reset throw before they reach this change.
    querySelector(sel) {
      if (!children.has(sel)) children.set(sel, makeEl(`${id}${sel}`));
      return children.get(sel);
    },
    querySelectorAll: () => [],
    focus() { this.focused += 1; },
    click() { this.fire('click', { target: this, currentTarget: this }); },
  };
}

function makeHarness() {
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
        return { ok: true, json: async () => ({ title: 'Generated Title' }) };
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
    AppView: new Proxy({}, { get: (t, p) => (p === 'appData' ? undefined : () => {}) }),
    PlatformUI: { pullToRefresh: () => {}, toast: () => {} },
    App: new Proxy({}, {
      get: (t, p) => t[p],
      set: (t, p, v) => { t[p] = v; return true; },
    }),
    alert: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FEEDBACK_SRC, sandbox);
  sandbox.init();

  const el = (id) => sandbox.document.getElementById(id);
  // The island's useStaticModal reveals the root; _open is the state half
  // the controller owns, and it is what a real open runs.
  el('feedback-text-error').classList.add('hidden');

  return {
    sandbox,
    el,
    fetchCalls,
    error: () => el('feedback-text-error'),
    errorShown: () => !el('feedback-text-error').classList.contains('hidden'),
    filed: () => fetchCalls.filter((c) => c.url === '/api/feedback'),
    async submit() {
      el('feedback-submit').fire('click');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    type(text) {
      el('feedback-text').value = text;
      el('feedback-text').fire('input');
    },
  };
}

test('submitting an empty description explains itself and files nothing', async () => {
  const h = makeHarness();
  await h.submit();

  assert.equal(h.filed().length, 0, 'nothing was sent');
  assert.ok(h.errorShown(), 'the refusal is visible');
  assert.equal(h.error().textContent, MESSAGE);
  assert.equal(
    h.el('feedback-text').getAttribute('aria-invalid'),
    'true',
    'the field is marked invalid'
  );
  assert.equal(
    h.el('feedback-text').getAttribute('aria-describedby'),
    'feedback-text-error',
    'and points at the message'
  );
  assert.ok(h.el('feedback-text').focused > 0, 'the caret lands where the fix is');
});

test('a description of nothing but whitespace is refused the same way', async () => {
  const h = makeHarness();
  h.el('feedback-text').value = '   \n\t ';
  await h.submit();

  assert.equal(h.filed().length, 0);
  assert.ok(h.errorShown());
});

test('the submit button stays live, so the refusal is the only thing that changed', async () => {
  const h = makeHarness();
  await h.submit();

  assert.equal(h.el('feedback-submit').disabled, false, 'Submit is still clickable');
  assert.equal(h.el('feedback-submit').textContent, '', 'and was never relabelled');
  // paintQueueState reads feedbackBtn.disabled to decide between "Submit"
  // and "Save for later"; a validation-driven disable would break the two
  // declared offline checks that assert on that label.
});

test('typing clears the refusal', async () => {
  const h = makeHarness();
  await h.submit();
  assert.ok(h.errorShown());

  h.type('The board scrolls back to the top when I drag a card.');

  assert.equal(h.errorShown(), false, 'the message is gone');
  assert.equal(h.error().textContent, '');
  assert.equal(h.el('feedback-text').getAttribute('aria-invalid'), null);
  assert.equal(h.el('feedback-text').getAttribute('aria-describedby'), null);
});

test('a refused submit leaves the rest of the dialog untouched', async () => {
  const h = makeHarness();
  h.el('feedback-title').value = 'A title I typed myself';
  h.el('feedback-bounty-checkbox').checked = true;

  await h.submit();

  assert.equal(h.el('feedback-title').value, 'A title I typed myself', 'the title survives');
  assert.equal(h.el('feedback-bounty-checkbox').checked, true, 'so does the bounty opt-in');
  assert.equal(h.el('feedback-text').disabled, false, 'nothing is locked');
});

test('a filled description submits as before', async () => {
  const h = makeHarness();
  h.type('The board scrolls back to the top when I drag a card.');
  await h.submit();

  assert.equal(h.filed().length, 1, 'the happy path is unchanged');
  assert.equal(h.errorShown(), false, 'and says nothing about a missing description');
});

test('reopening the dialog does not greet you with the previous refusal', async () => {
  const h = makeHarness();
  await h.submit();
  assert.ok(h.errorShown());

  h.sandbox.Feedback._reset();
  assert.equal(h.errorShown(), false, 'closing clears it');

  await h.submit();
  assert.ok(h.errorShown(), 'and a fresh empty submit says so again');

  h.sandbox.Feedback._open({});
  assert.equal(h.errorShown(), false, 'opening clears it too');
});
