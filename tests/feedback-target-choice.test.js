// Frontend tests for issue #2707: when Send Feedback has more than one
// destination to offer, the person picks one — the dialog does not pick
// for them.
//
// What this replaces was a single line in the open handler:
//
//     // Default to the app the user is looking at — most likely intent.
//     setFeedbackTarget('app');
//
// A guess about intent is exactly what miscategorises a report. Somebody
// reading their own words, not the row above them, files an app bug against
// the platform (or the reverse) without ever making that choice — and the
// mistake is invisible to the person who made it, so nobody reports it.
//
// The asymmetric half matters just as much and is easy to lose in a later
// refactor: when only ONE destination is reachable there is nothing to
// disambiguate, so it stays selected and Submit is live on open. A tap with
// exactly one possible answer teaches people to tap past the question.
//
// Two halves, the arrangement tests/feedback-required-description.test.js
// established:
//
//  - STATIC assertions against the shipped document and the declared
//    dapp.json checks. public/index.html is a generated artifact here, not
//    a committed fixture — tests/README and the shell-build test own that
//    lifecycle.
//
//  - BEHAVIOURAL assertions driven through the REAL controller in a vm
//    context, with `AppView.appData` posed to produce each case.
//
// Run with: node --test tests/feedback-target-choice.test.js

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

// The exact copy, asserted as a literal on both sides: the declared
// dapp.json check matches on this text, so a reword that touched only one
// of the two would go green here and fail the merge gate.
const HINT = 'Choose where this feedback goes.';

// ── Half one: the shipped document ───────────────────────────────────

test('neither destination is pre-checked in the shipped markup', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const id of ['feedback-target-app', 'feedback-target-platform']) {
    const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(button, `#${id} is in the document`);
    assert.match(
      button[0],
      /aria-checked="false"/,
      `#${id} ships unchecked — the controller decides on open, and a`
      + ' prerendered choice would be a claim about an app it cannot see'
    );
  }
});

test('neither caret is shown in the shipped markup', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const id of ['feedback-caret-app', 'feedback-caret-platform']) {
    const caret = html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`));
    assert.ok(caret, `#${id} is in the document`);
    assert.match(caret[0], /class="[^"]*\bhidden\b/, `#${id} starts hidden`);
  }
});

test('the hint ships empty, hidden and adjacent to the row it is about', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const node = html.match(/<p[^>]*id="feedback-target-hint"[^>]*>(.*?)<\/p>/s);
  assert.ok(node, '#feedback-target-hint is in the document');
  assert.match(node[0], /class="[^"]*\bhidden\b/, 'it starts hidden');
  assert.equal(node[1].trim(), '', 'it renders EMPTY — the controller owns the text');
  assert.ok(
    !html.includes(HINT),
    'the copy is not prerendered: the one-destination case never shows it,'
    + ' and a message on the initial render would mismatch on hydration'
  );
  // The declared check reaches it as `#feedback-target + #feedback-target-hint`.
  assert.match(
    html,
    /id="feedback-target"[\s\S]*?<\/div><\/div><p[^>]*id="feedback-target-hint"/,
    'it is the radiogroup\'s immediate next sibling'
  );
});

test('the copy lives in exactly one place', () => {
  assert.equal(
    CONTROLLER_TEXT.split(HINT).length - 1,
    1,
    `"${HINT}" is written once, as CHOOSE_TARGET_HINT`
  );
});

test('?shot=feedback-choose is a recognised deep link', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const start = app.indexOf('_applyFeedbackShot() {');
  assert.ok(start > 0, 'the shot handler is still named that');
  const shot = app.slice(start, app.indexOf('renderAdminButton()', start));
  assert.match(shot, /'feedback-choose'/, 'the shot name is accepted');
  assert.match(shot, /feedback-target-hint/, 'and it waits for the visible hint');
  assert.match(
    shot,
    /App\._simulateFeedbackTargetChoice/,
    'through the controller hook, like the two shots beside it'
  );
  assert.match(
    CONTROLLER_TEXT,
    /App\._simulateFeedbackTargetChoice = \(name\) => applyTargetAvailability\(true, \{ name \}\)/,
    'and that hook runs the SHIPPED branch rather than posing the row by hand'
  );
});

test('all three declared checks exist and match the shipped ids and copy', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  const declared = manifest.tests || [];

  const choice = declared.find((t) => t.id === 'feedback.destination-choice');
  assert.ok(choice, 'the unchosen state is covered');
  assert.equal(choice.path, '/?shot=feedback-choose');
  assert.equal(choice.visual, true, 'and it is the representative visual flow');
  assert.ok(
    HINT.startsWith(choice.expectText),
    'the check\'s expectText is a prefix of the copy the controller writes'
  );

  const dead = declared.find((t) => t.path === '/?shot=feedback-choose'
    && /#feedback-submit:disabled/.test(t.expectSelector));
  assert.ok(dead, 'the disabled Submit is covered');

  const single = declared.find((t) => /#feedback-target-hint\.hidden/.test(t.expectSelector || ''));
  assert.ok(single, 'the ONE-destination case is covered too');
  assert.equal(single.path, '/?shot=feedback', 'on the route where no app is open');
  assert.match(
    single.expectSelector,
    /#feedback-submit:not\(:disabled\)/,
    'and it asserts Submit is live there — no pointless extra tap'
  );

  // Every selector reaches the card through `body:has(...)`, never as a
  // DESCENDANT of #feedback-modal: useStaticModal lifts the card out of that
  // root into the kit's own shell when the dialog opens, so a descendant
  // selector matches nothing precisely when the dialog IS open.
  for (const t of [choice, dead, single]) {
    assert.match(
      t.expectSelector,
      /^body:has\(#feedback-modal:not\(\.hidden\)\)/,
      `${t.name}: the card is selected via body:has(), not through the lifted root`
    );
  }
});

// ── Half two: the controller, run for real ───────────────────────────

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
    querySelector(sel) {
      if (!children.has(sel)) children.set(sel, makeEl(`${id}${sel}`));
      return children.get(sel);
    },
    querySelectorAll: () => [],
    focus() { this.focused += 1; },
    click() { this.fire('click', { target: this, currentTarget: this }); },
  };
}

// `appData` poses the context the dialog opens in. null is home/leaderboard
// (no app open); a repo_url with no self_hosted flag is an ordinary app on
// its App or Dev tab, which is the two-destination case.
function makeHarness({ appData = null, sessionDraft = null } = {}) {
  const els = new Map();
  const fetchCalls = [];
  let timerId = 0;
  const timers = new Map();

  const AppView = {
    appData,
    issueStateAvailable: () => false,
    collectIssueState: async () => null,
    createPrForIssue: async () => {},
    close: () => {},
  };

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
      return { ok: true, json: async () => ({ issueUrl: 'https://example.invalid/1' }) };
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: {
      getItem: () => (sessionDraft ? JSON.stringify(sessionDraft) : null),
      setItem: () => {},
      removeItem: () => {},
    },
    AppView,
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

  // What the shell's own open path establishes before Feedback._open runs.
  sandbox.App.currentApp = appData ? 'example-app' : null;
  sandbox.App.currentTab = appData ? 'app' : 'home';
  sandbox.App.user = { id: 7 };

  const el = (id) => sandbox.document.getElementById(id);
  el('feedback-text-error').classList.add('hidden');
  el('feedback-modal').classList.add('hidden');

  return {
    sandbox,
    el,
    fetchCalls,
    open() { sandbox.Feedback._open({}); },
    filed: () => fetchCalls.filter((c) => c.url === '/api/feedback'),
    hintShown: () => !el('feedback-target-hint').classList.contains('hidden'),
    checked: (which) => el(`feedback-target-${which}`).getAttribute('aria-checked'),
    caretShown: (which) => !el(`feedback-caret-${which}`).classList.contains('hidden'),
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

const OPEN_APP = { name: 'Example App', repo_url: 'https://github.com/acme/example-app' };

test('with two destinations, the dialog opens with neither chosen', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();

  assert.equal(h.checked('app'), 'false', '"This app" is not preselected');
  assert.equal(h.checked('platform'), 'false', 'and neither is the platform');
  assert.equal(h.caretShown('app'), false, 'no caret marks a choice nobody made');
  assert.equal(h.caretShown('platform'), false);
  assert.equal(h.el('feedback-target-app').disabled, false, 'both options are tappable');
  assert.equal(h.el('feedback-target-platform').disabled, false);
});

test('and Submit is dead until one is tapped, with the reason on screen', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();

  assert.equal(h.el('feedback-submit').disabled, true, 'Submit is disabled');
  assert.ok(h.hintShown(), 'and the row says why');
  assert.equal(h.el('feedback-target-hint').textContent, HINT);
  assert.equal(
    h.el('feedback-target').getAttribute('aria-describedby'),
    'feedback-target-hint',
    'the radiogroup points at its own explanation'
  );
});

test('tapping a destination selects it, clears the hint and frees Submit', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.el('feedback-target-app').fire('click');

  assert.equal(h.checked('app'), 'true');
  assert.equal(h.checked('platform'), 'false');
  assert.equal(h.caretShown('app'), true, 'the caret moves under the choice');
  assert.equal(h.hintShown(), false, 'the prompt has been answered');
  assert.equal(h.el('feedback-target').getAttribute('aria-describedby'), null);
  assert.equal(h.el('feedback-submit').disabled, false, 'Submit is live');
});

test('the platform option frees it just the same', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.el('feedback-target-platform').fire('click');

  assert.equal(h.checked('platform'), 'true');
  assert.equal(h.checked('app'), 'false');
  assert.equal(h.caretShown('platform'), true);
  assert.equal(h.el('feedback-submit').disabled, false);
});

test('a submit with no destination files NOTHING and re-asks', async () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.type('Dragging a card scrolls the board back to the top.');

  await h.submit();

  assert.equal(h.filed().length, 0, 'nothing was sent against a destination nobody picked');
  assert.ok(h.hintShown(), 'the question is still on screen');
});

test('the destination that was tapped is the one submitted', async () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.type('Dragging a card scrolls the board back to the top.');
  h.el('feedback-target-app').fire('click');

  await h.submit();

  const [call] = h.filed();
  assert.ok(call, 'it was sent');
  const body = JSON.parse(call.opts.body);
  assert.equal(body.target, 'app');
  assert.equal(body.appSlug, 'example-app');
});

test('with ONE destination it stays selected and Submit is live on open', () => {
  // No app open: "This app" is grayed out, so there is nothing to
  // disambiguate and an extra tap would buy nobody anything.
  const h = makeHarness({ appData: null });
  h.open();

  assert.equal(h.el('feedback-target-app').disabled, true, '"This app" is not selectable');
  assert.equal(h.checked('platform'), 'true', 'the only destination is chosen');
  assert.equal(h.caretShown('platform'), true);
  assert.equal(h.hintShown(), false, 'and nothing asks for a choice that does not exist');
  assert.equal(h.el('feedback-submit').disabled, false, 'Submit is live immediately');
});

test('a self-hosted app is the one-destination case too', () => {
  const h = makeHarness({
    appData: { ...OPEN_APP, self_hosted: true },
  });
  h.open();

  assert.equal(h.el('feedback-target-app').disabled, true);
  assert.equal(h.checked('platform'), 'true');
  assert.equal(h.hintShown(), false);
  assert.equal(h.el('feedback-submit').disabled, false);
});

test('an app with no repo yet keeps its name on the grayed option', () => {
  const h = makeHarness({ appData: { name: 'Example App', repo_url: '' } });
  h.open();

  assert.equal(h.el('feedback-target-app').textContent, 'This app (Example App)');
  assert.equal(h.el('feedback-target-app').disabled, true);
  assert.equal(h.checked('platform'), 'true');
});

test('a rescued draft hands back the destination its author chose', () => {
  // The stored target is the person's own earlier pick, not a default —
  // re-asking would quietly lose a decision they already made.
  const h = makeHarness({
    appData: OPEN_APP,
    sessionDraft: {
      description: 'The board scrolls back to the top when I drag a card.',
      title: '', titleDirty: false, target: 'platform', savedAt: Date.now(),
    },
  });
  h.open();

  assert.equal(h.checked('platform'), 'true', 'their choice came back with their words');
  assert.equal(h.hintShown(), false);
  assert.equal(h.el('feedback-submit').disabled, false);
});

test('reopening after a choice asks again', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.el('feedback-target-app').fire('click');
  assert.equal(h.hintShown(), false);

  h.sandbox.Feedback._reset();
  h.open();

  assert.equal(h.checked('app'), 'false', 'the previous answer is not a new default');
  assert.equal(h.checked('platform'), 'false');
  assert.ok(h.hintShown());
  assert.equal(h.el('feedback-submit').disabled, true);
});

test('closing the dialog does not leave a dead Submit behind for the next open', () => {
  // _open clears the gate before enableSubmit(), so the one-destination
  // case that follows a two-destination one is not poisoned by it.
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  assert.equal(h.el('feedback-submit').disabled, true);

  h.sandbox.Feedback._reset();
  h.sandbox.AppView.appData = null;
  h.sandbox.App.currentApp = null;
  h.sandbox.App.currentTab = 'home';
  h.open();

  assert.equal(h.el('feedback-submit').disabled, false, 'Submit is live for the single option');
  assert.equal(h.hintShown(), false);
});
