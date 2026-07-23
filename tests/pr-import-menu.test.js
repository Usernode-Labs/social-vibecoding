// #687 — frontend tests for the "Import Feature from a PR" "+" menu entry
// and its picker modal. Loads the real public/js/app-view.js into a vm
// context (so the tests can't drift from shipped code) and exercises:
//   - the menu item renders only when can_collaborate && !readOnly;
//   - openImportPrModal() fetches candidates and renders one row per PR,
//     escaping titles/authors;
//   - the empty and GitHub-off (non-OK / 404) responses render their
//     respective friendly messages;
//   - submitImportPr() POSTs { pr } and navigates to the returned
//     sessionId via App.switchTab('dev', id, 'sessions');
//   - a 409/404 on import shows the inline error and keeps the list open.
//
// Run with: node --test tests/pr-import-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// ── shared element stub ──────────────────────────────────────────────────
function makeEl() {
  const el = {
    dataset: {},
    style: {},
    textContent: '',
    className: '',
    disabled: false,
    _html: '',
    _classes: new Set(['hidden']),
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    setAttribute: () => {},
    scrollTop: 0,
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
    toggle: () => false,
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => { el._html = v; },
  });
  return el;
}

// Build a harness with a configurable fetch and captured App.switchTab calls.
function makeHarness({ fetchImpl } = {}) {
  const switchCalls = [];
  const els = {
    'import-pr-modal': makeEl(),
    'import-pr-list': makeEl(),
    'import-pr-error': makeEl(),
    'import-pr-submit': makeEl(),
  };
  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    Date,
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escapeAttr: (s) => String(s).replace(/"/g, '&quot;'),
    App: { switchTab: (...a) => { switchCalls.push(a); } },
    document: {
      getElementById: (id) => (id in els ? els[id] : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    },
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ candidates: [] }) })),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  const AppView = sandbox.window.AppView;
  AppView.appData = { slug: 'x', name: 'X' };
  return { AppView, els, switchCalls };
}

const CANDIDATES = [
  { number: 9401, title: '[Mock] add a <b>widget</b>', author: 'octo-mock', headBranch: 'mock/importable-widget', baseBranch: 'main', htmlUrl: 'https://github.com/o/r/pull/9401' },
  { number: 9402, title: '[Mock] fix a typo', author: 'octo-mock', headBranch: 'mock/importable-typo', baseBranch: 'main', htmlUrl: 'https://github.com/o/r/pull/9402' },
];

// ── the menu-item render gate ────────────────────────────────────────────

// Minimal render harness reused from the dev "+" menu tests: capture the
// HTML renderDevView writes into #app-content.
function makeRenderHarness() {
  const content = makeEl();
  const captured = { get html() { return content.innerHTML; } };
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
      getElementById: (id) => (id === 'app-content' ? content : null),
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
  return { AppView: sandbox.window.AppView, captured };
}

const BASE_APP = {
  slug: 'x', name: 'X', status: 'running', self_hosted: false,
  collab_visibility: 'public', view_visibility: 'public',
  can_manage: false, can_collaborate: true,
};

async function renderCardListHtml(appData) {
  const { AppView, captured } = makeRenderHarness();
  AppView.appData = appData;
  try { await AppView.renderDevView('forum', null); } catch { /* wiring hit stub DOM */ }
  return captured.html;
}

test('import-pr item renders for a collaborator', async () => {
  const html = await renderCardListHtml({ ...BASE_APP });
  assert.ok(html.includes('data-plus="import-pr"'), 'import-pr item present');
  assert.ok(html.includes('Import Feature from a PR'), 'label present');
  // Sits directly under "Propose a change".
  assert.ok(html.indexOf('data-plus="proposal"') < html.indexOf('data-plus="import-pr"'),
    'import-pr renders after the proposal item');
  assert.ok(html.indexOf('data-plus="import-pr"') < html.indexOf('data-plus="issue"'),
    'import-pr renders before the issue item');
});

test('import-pr item hidden for a non-collaborator', async () => {
  const html = await renderCardListHtml({ ...BASE_APP, can_collaborate: false });
  assert.ok(!html.includes('data-plus="import-pr"'), 'no import-pr item without collab');
});

test('import-pr item hidden in read-only mode (can_collaborate === false)', async () => {
  // AppView.readOnly is derived: !!appData && can_collaborate === false. The
  // import-pr item sits inside the !readOnly block AND is gated on
  // can_collaborate, so a read-only viewer never sees it — only Fork.
  const { AppView, captured } = makeRenderHarness();
  AppView.appData = { ...BASE_APP, can_collaborate: false };
  assert.equal(AppView.readOnly, true, 'viewer is read-only');
  try { await AppView.renderDevView('forum', null); } catch { /* wiring */ }
  assert.ok(!captured.html.includes('data-plus="import-pr"'), 'read-only hides import-pr');
  assert.ok(captured.html.includes('data-plus="fork"'), 'read-only viewer still gets Fork');
});

// ── openImportPrModal ────────────────────────────────────────────────────

test('openImportPrModal lists one row per candidate and escapes titles', async () => {
  const { AppView, els } = makeHarness({
    fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: CANDIDATES }) }),
  });
  await AppView.openImportPrModal();
  const list = els['import-pr-list'].innerHTML;
  assert.ok(!els['import-pr-modal']._classes.has('hidden'), 'modal revealed');
  assert.ok(list.includes('#9401'), 'PR number rendered');
  assert.ok(list.includes('octo-mock'), 'author rendered');
  assert.ok(list.includes('mock/importable-widget → main'), 'branches rendered');
  assert.ok(list.includes('&lt;b&gt;widget&lt;/b&gt;'), 'title HTML-escaped');
  assert.ok(!list.includes('<b>widget</b>'), 'raw title HTML not injected');
  assert.equal((list.match(/name="import-pr-choice"/g) || []).length, 2, 'one radio per candidate');
});

test('openImportPrModal shows the empty message when no candidates', async () => {
  const { AppView, els } = makeHarness({
    fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [] }) }),
  });
  await AppView.openImportPrModal();
  assert.ok(/No open pull requests are available/i.test(els['import-pr-list'].innerHTML));
});

test('openImportPrModal shows the GitHub-off message on a non-OK (404) response', async () => {
  const { AppView, els } = makeHarness({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }),
  });
  await AppView.openImportPrModal();
  assert.ok(/GitHub isn.t configured/i.test(els['import-pr-list'].innerHTML));
});

// ── submitImportPr ───────────────────────────────────────────────────────

test('submitImportPr POSTs { pr } and navigates to the new proposal', async () => {
  const posted = {};
  const { AppView, els, switchCalls } = makeHarness({
    fetchImpl: async (url, opts) => {
      posted.url = url; posted.opts = opts;
      return { ok: true, json: async () => ({ ok: true, sessionId: 555, prNumber: 9401 }) };
    },
  });
  AppView._importPrSelected = 9401;
  await AppView.submitImportPr();
  assert.equal(posted.url, '/api/apps/x/pr-import');
  assert.equal(posted.opts.method, 'POST');
  assert.deepEqual(JSON.parse(posted.opts.body), { pr: 9401 });
  assert.ok(els['import-pr-modal']._classes.has('hidden'), 'modal closed on success');
  assert.deepEqual(switchCalls[0], ['dev', 555, 'sessions'], 'navigated to the new proposal');
});

test('submitImportPr shows the inline error and keeps the list open on 409', async () => {
  const { AppView, els, switchCalls } = makeHarness({
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'PR #9401 has already been imported.' }) }),
  });
  els['import-pr-modal'].classList.remove('hidden'); // modal is open before submit
  AppView._importPrSelected = 9401;
  await AppView.submitImportPr();
  const err = els['import-pr-error'];
  assert.equal(err.textContent, 'PR #9401 has already been imported.');
  assert.ok(!err._classes.has('hidden'), 'error region shown');
  assert.ok(!els['import-pr-modal']._classes.has('hidden'), 'modal stays open');
  assert.equal(switchCalls.length, 0, 'no navigation on failure');
  assert.equal(els['import-pr-submit'].disabled, false, 'submit re-enabled in finally');
});

test('submitImportPr no-ops with no selection', async () => {
  const { AppView, switchCalls } = makeHarness();
  AppView._importPrSelected = null;
  await AppView.submitImportPr();
  assert.equal(switchCalls.length, 0, 'nothing submitted without a chosen PR');
});
