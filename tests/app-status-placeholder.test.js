// The App tab's five placeholder states: what `renderAppTab` publishes when
// there is no running app to frame, and what draws it.
//
// tests/app-frame-identity.test.js already pins WHICH branch each app status
// lands in — that harness holds the real store and reads the view back. This
// file is the other half: the view's CONTENT (the dot, the detail line, who
// gets a button) and the markup
// frontend/src/features/app-frame/app-status.tsx renders from it. Between
// them the branch and its output are both covered; before the conversion
// neither was.
//
// Run with: node --test tests/app-status-placeholder.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/app-status-api.ts')));

function makeAppView() {
  const opened = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 } },
    Secrets: { open: (slug) => opened.push(['secrets', slug]) },
    BuildLog: { open: (slug) => opened.push(['buildLog', slug]) },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, opened, sandbox };
}

const view = (AppView, appData) => JSON.parse(JSON.stringify(AppView._appStatusView(appData)));

function html(v) {
  const m = mod();
  m.appStatusStore.set({ view: v });
  return renderToHtml(createElement(m.AppStatus));
}

test('spinning up: the amber dot and nothing to act on', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, { status: 'creating', slug: 'recipebot' });
  assert.deepEqual(v, { dot: 'creating', message: 'App is spinning up...', detail: null, action: null });
  const out = html(v);
  assert.match(out, /class="status-dot creating"/);
  assert.match(out, /App is spinning up\.\.\./);
  assert.doesNotMatch(out, /<button/);
});

test('awaiting secrets: the missing names, and a way to set them', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, {
    status: 'awaiting_secrets', slug: 'recipebot',
    missingSecrets: ['STRIPE_KEY', 'MAIL_TOKEN'],
  });
  assert.equal(v.detail, 'STRIPE_KEY, MAIL_TOKEN');
  assert.deepEqual(v.action, { key: 'secrets', label: 'Configure secrets', slug: 'recipebot' });
  const out = html(v);
  assert.match(out, /deploy is blocked/);
  assert.match(out, /font-mono text-red-500[^>]*>STRIPE_KEY, MAIL_TOKEN/);
  assert.match(out, /id="awaiting-open-secrets"/);
});

test('awaiting secrets with none listed still offers the panel', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, { status: 'awaiting_secrets', slug: 'recipebot' });
  assert.equal(v.detail, null);
  assert.ok(v.action, 'the button is what makes this state actionable');
  assert.doesNotMatch(html(v), /font-mono/);
});

test('failed to start: the reason line, clipped, and the log button for involved users', () => {
  const { AppView } = makeAppView();
  const long = 'x'.repeat(400);
  const v = view(AppView, {
    status: 'error', slug: 'recipebot',
    lastFailure: { reason: long },
  });
  assert.equal(v.dot, 'error');
  assert.equal(v.detail.length, 280, 'the reason is clipped before it reaches the card');
  assert.deepEqual(v.action, { key: 'buildLog', label: 'View build log', slug: 'recipebot' });
  const out = html(v);
  assert.match(out, /class="status-dot error"/);
  assert.match(out, /App failed to start/);
  assert.match(out, /id="app-error-build-log"/);
});

test('#416: an outsider gets the bare failure, with no build log to open', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, { status: 'error', slug: 'recipebot', errorReason: 'exit 1' });
  assert.equal(v.detail, 'exit 1', 'the live WS reason still shows');
  assert.equal(v.action, null, 'but the log is collaborator-gated');
  assert.doesNotMatch(html(v), /<button/);
});

test('anything else is "App not available", with no dot at all', () => {
  const { AppView } = makeAppView();
  for (const appData of [null, undefined, { status: 'stopped' }, {}]) {
    const v = view(AppView, appData);
    assert.deepEqual(v, { dot: null, message: 'App not available', detail: null, action: null });
  }
  assert.doesNotMatch(html(view(makeAppView().AppView, null)), /status-dot/);
});

test('the two buttons dispatch by name into the openers', () => {
  const { AppView, opened } = makeAppView();
  AppView.openAwaitingSecrets('recipebot');
  AppView.openAppBuildLog('recipebot');
  assert.deepEqual(opened, [['secrets', 'recipebot'], ['buildLog', 'recipebot']]);
  // A slug-less call is a no-op rather than an `open(undefined)`.
  AppView.openAwaitingSecrets(null);
  AppView.openAppBuildLog('');
  assert.equal(opened.length, 2);
});

test('the placeholder is the primary button, not a hand-written violet fill', () => {
  const SRC_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'app-frame', 'app-status.tsx'), 'utf8'
  );
  assert.doesNotMatch(SRC_TSX, /bg-violet-600/, 'routed through <Button>');
  const { AppView } = makeAppView();
  const out = html(view(AppView, { status: 'awaiting_secrets', slug: 'x' }));
  assert.match(out, /bg-violet-600 hover:bg-violet-500/, 'and still renders the same fill');
});

test('an empty view renders nothing, so a swept host stays empty', () => {
  assert.equal(html(null), '');
});
