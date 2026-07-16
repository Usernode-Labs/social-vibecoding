// Frontend tests for issue #645: the Dev "+" menu absorbs the hamburger
// drawer's "Members & visibility" entry, and the intermediate "App
// settings" sub-page is dissolved into direct "App display name" /
// "App secrets" items.
//
// We load the real app-view.js / app.js into a vm context (so the tests
// can't drift from shipped code), render the dev card list against stub
// DOM elements, and assert on the produced header markup:
//   - data-plus="members" renders exactly when the old drawer-row gate
//     held (creator/admin, or collaborator of an invite-only app; never
//     for the self-app).
//   - data-plus="rename" / data-plus="secrets" render for every
//     non-read-only viewer; data-plus="settings" is gone.
//   - Read-only viewers still get only "Fork this app".
//   - Old #app/<slug>/dev/settings deep links normalize to the card list.
//
// Run with: node --test tests/dev-plus-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);
const APP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'),
  'utf8'
);
const HTML_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

// Minimal DOM element stub — enough for renderDevView's card-list branch
// to set innerHTML and for the wiring helpers to no-op past it.
function makeEl() {
  return {
    dataset: {},
    style: {},
    textContent: '',
    className: '',
    innerHTML: '',
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => false,
    },
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    setAttribute: () => {},
    scrollTop: 0,
  };
}

// Load app-view.js in a vm sandbox and return its AppView (off window,
// same as the browser handlers see it).
function makeViewHarness(els = {}) {
  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    Date,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    resolveDevHost: (u) => u,
    App: { user: { id: 1 }, currentApp: 'x', switchTab: () => {} },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: (id) => (id in els ? els[id] : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  return sandbox.window.AppView;
}

// Render the dev card list for the given appData and capture the HTML
// renderDevView writes into #app-content. Wiring code after the innerHTML
// assignment may throw against the stub DOM — that's fine, the markup is
// already captured.
async function renderCardListHtml(appData) {
  const captured = { html: '' };
  const content = makeEl();
  Object.defineProperty(content, 'innerHTML', {
    get: () => captured.html,
    set: (v) => { captured.html = v; },
  });
  const AppView = makeViewHarness({ 'app-content': content });
  AppView.appData = appData;
  try {
    await AppView.renderDevView('forum', null);
  } catch {
    // Post-render wiring hit a stubbed-out element — markup already captured.
  }
  assert.ok(captured.html.includes('dev-plus-menu'), 'card list rendered its "+" menu');
  return captured.html;
}

const BASE_APP = {
  slug: 'x',
  name: 'X',
  status: 'running',
  self_hosted: false,
  collab_visibility: 'public',
  view_visibility: 'public',
  can_manage: false,
  can_collaborate: true,
};

// ── the members item obeys the old drawer-row gate ───────────────────────

test('creator/admin (can_manage) sees Members & visibility in the "+" menu', async () => {
  const html = await renderCardListHtml({ ...BASE_APP, can_manage: true });
  assert.ok(html.includes('data-plus="members"'), 'members item present');
  assert.ok(html.includes('Members &amp; visibility'), 'members label present');
});

test('collaborator of an invite-only app sees the members item', async () => {
  const html = await renderCardListHtml({ ...BASE_APP, collab_visibility: 'private' });
  assert.ok(html.includes('data-plus="members"'), 'members item present');
});

test('public non-managed app hides the members item (rename/secrets stay)', async () => {
  const html = await renderCardListHtml({ ...BASE_APP });
  assert.ok(!html.includes('data-plus="members"'), 'members item absent');
  assert.ok(html.includes('data-plus="rename"'), 'rename item still present');
  assert.ok(html.includes('data-plus="secrets"'), 'secrets item still present');
});

test('self-hosted app never shows the members item', async () => {
  const html = await renderCardListHtml({ ...BASE_APP, self_hosted: true, can_manage: true });
  assert.ok(!html.includes('data-plus="members"'), 'members item absent for self-app');
});

test('_plusMenuShowsMembers mirrors the old drawer-row predicate', () => {
  const AppView = makeViewHarness();
  const cases = [
    [{ ...BASE_APP, can_manage: true }, true],
    [{ ...BASE_APP, collab_visibility: 'private' }, true],
    [{ ...BASE_APP }, false],
    [{ ...BASE_APP, self_hosted: true, can_manage: true }, false],
    [null, false],
  ];
  for (const [appData, expected] of cases) {
    AppView.appData = appData;
    assert.equal(AppView._plusMenuShowsMembers(), expected,
      `gate for ${JSON.stringify(appData && { m: appData.can_manage, v: appData.collab_visibility, s: appData.self_hosted })}`);
  }
});

// ── the App settings nesting is gone; rename/secrets are direct items ────

test('"+" menu has direct rename and secrets items, no App settings entry', async () => {
  const html = await renderCardListHtml({ ...BASE_APP, can_manage: true });
  assert.ok(!html.includes('data-plus="settings"'), 'nested App settings entry removed');
  assert.ok(html.includes('data-plus="rename"'), 'rename item present');
  assert.ok(html.includes('App display name'), 'rename label present');
  assert.ok(html.includes('data-plus="secrets"'), 'secrets item present');
  assert.ok(html.includes('dc-secrets-state'),
    'secrets item carries the missing-required state slot for refreshDevChatSecretsState');
  // Fork stays last in the menu.
  assert.ok(html.indexOf('data-plus="secrets"') < html.indexOf('data-plus="fork"'),
    'fork renders after secrets');
});

test('read-only viewers get only Fork in the "+" menu', async () => {
  const html = await renderCardListHtml({ ...BASE_APP, can_collaborate: false });
  for (const item of ['proposal', 'issue', 'members', 'rename', 'secrets']) {
    assert.ok(!html.includes(`data-plus="${item}"`), `${item} item absent for read-only viewer`);
  }
  assert.ok(html.includes('data-plus="fork"'), 'fork item still present');
});

// ── the settings sub-page and its routing are gone ───────────────────────

test('old dev/settings deep links normalize to the dev card list', () => {
  const sandbox = {
    console,
    URLSearchParams,
    location: { search: '', hash: '', pathname: '/' },
    document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => ({ forEach: () => {} }) },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox);
  const App = sandbox.window.App;
  // Field-by-field (the vm realm's Object.prototype differs, so
  // deepStrictEqual would reject an otherwise-identical object).
  const norm = App._normalizeTab('dev', null, 'settings');
  assert.equal(norm.tab, 'dev', 'stays on the dev tab');
  assert.equal(norm.subTab, 'forum', 'dev/settings falls through to the card list');
  assert.equal(norm.ref, null, 'no deep-link payload');
});

test('app.js no longer parses, writes, or screens the dev/settings hash', () => {
  assert.ok(!APP_SRC.includes("sec === 'settings'"), 'hash parse branch removed');
  assert.ok(!APP_SRC.includes('dev/settings`'), 'updateHash never emits dev/settings');
  const subScreens = APP_SRC.match(/const SUB_SCREENS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(subScreens, 'SUB_SCREENS set still declared');
  assert.ok(!subScreens[1].includes("'settings'"), "SUB_SCREENS no longer lists 'settings'");
});

test('the settings sub-page renderer is gone from app-view.js', () => {
  assert.ok(!VIEW_SRC.includes('_renderSettingsView'), 'renderer removed');
  assert.ok(!VIEW_SRC.includes("subTab === 'settings'"), 'renderDevView settings branch removed');
});

// ── the hamburger drawer row is fully removed ────────────────────────────

test('index.html has no Members & visibility drawer row', () => {
  assert.ok(!HTML_SRC.includes('id="drawer-row-members"'), 'drawer row markup removed');
});

test('app.js no longer wires or gates the drawer members row', () => {
  assert.ok(!APP_SRC.includes("getElementById('drawer-row-members')"), 'all drawer-row-members lookups removed');
});
