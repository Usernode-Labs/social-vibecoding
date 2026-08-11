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
    // Varargs like the real DOM API — _setImportPrBusy adds/removes two
    // classes in one call (#846).
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
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
    // #846: the in-flight progress row + the now-freezable Cancel button.
    'import-pr-cancel': makeEl(),
    'import-pr-progress': makeEl(),
    'import-pr-progress-text': makeEl(),
    'import-pr-progress-slow': makeEl(),
  };
  const toasts = [];
  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    Date,
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escapeAttr: (s) => String(s).replace(/"/g, '&quot;'),
    App: { switchTab: (...a) => { switchCalls.push(a); } },
    PlatformUI: { toast: (m) => { toasts.push(m); } },
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
  return { AppView, els, switchCalls, toasts };
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

// #1084 chunk G: the "+" menu is a React component now
// (frontend/src/features/dev-board/board-frame.tsx), so there is no innerHTML
// string on #app-content to capture. These tests run with no
// frontend/node_modules — the root install never touches that workspace — so
// the markup is asserted against the component source and the GATE is asserted
// against the module that still evaluates it, the same split
// tests/dev-plus-menu.test.js and tests/standings-screen.test.js use.
const FRAME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'board-frame.tsx'),
  'utf8'
);

test('import-pr item renders for a collaborator', () => {
  const start = FRAME_SRC.indexOf('{canCollaborate ? (');
  assert.ok(start !== -1, 'the import-pr row is gated on the canCollaborate prop');
  const end = FRAME_SRC.indexOf(') : null}', start);
  const gated = FRAME_SRC.slice(start, end);
  assert.ok(gated.includes('data-plus="import-pr"'), 'import-pr item present');
  assert.ok(gated.includes('Import Feature from a PR'), 'label present');
  // Sits directly under "Propose a change".
  assert.ok(FRAME_SRC.indexOf('data-plus="proposal"') < FRAME_SRC.indexOf('data-plus="import-pr"'),
    'import-pr renders after the proposal item');
  assert.ok(FRAME_SRC.indexOf('data-plus="import-pr"') < FRAME_SRC.indexOf('data-plus="issue"'),
    'import-pr renders before the issue item');
  // …and the prop is fed from appData.can_collaborate, read in the module.
  assert.match(
    VIEW_SRC,
    /canCollaborate:\s*!!AppView\.appData\?\.can_collaborate/,
    'renderDevView passes appData.can_collaborate as the canCollaborate prop'
  );
});

test('import-pr item hidden for a non-collaborator', () => {
  // The row exists ONLY inside the canCollaborate branch — nowhere else in the
  // component — so a falsey prop is the whole gate.
  const hits = FRAME_SRC.split('data-plus="import-pr"').length - 1;
  assert.equal(hits, 1, 'exactly one import-pr row, inside the gate');
});

test('import-pr item hidden in read-only mode (can_collaborate === false)', async () => {
  // AppView.readOnly is derived: !!appData && can_collaborate === false. The
  // import-pr item sits inside the !readOnly block AND is gated on
  // can_collaborate, so a read-only viewer never sees it — only Fork. The
  // derivation is still the module's, so it is still checked there.
  const { AppView } = makeRenderHarness();
  AppView.appData = { ...BASE_APP, can_collaborate: false };
  assert.equal(AppView.readOnly, true, 'viewer is read-only');

  const roStart = FRAME_SRC.indexOf('{readOnly ? null : (');
  const roEnd = FRAME_SRC.indexOf('{selfHosted ? null : (', roStart);
  assert.ok(roStart !== -1 && roEnd !== -1, 'the writeable block is gated on readOnly');
  const gated = FRAME_SRC.slice(roStart, roEnd);
  assert.ok(gated.includes('data-plus="import-pr"'), 'read-only hides import-pr');
  assert.ok(FRAME_SRC.slice(roEnd).includes('data-plus="fork"'),
    'read-only viewer still gets Fork');
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

// #866: fork provenance. A fork-headed PR's branch lives in someone else's
// repo — the preview is built from refs/pull/<N>/head and the code is an
// outside contributor's — so the picker says so BEFORE the import, not after.
test('openImportPrModal labels fork-headed candidates and leaves same-repo ones bare', async () => {
  const forked = {
    number: 9403, title: '[Mock] add a keyboard shortcut', author: 'octo-forker',
    headBranch: 'mock/fork-shortcut', baseBranch: 'main',
    htmlUrl: 'https://github.com/o/r/pull/9403',
    fromFork: true, headRepo: 'octo-forker/usernode-mock-fork',
  };
  const { AppView, els } = makeHarness({
    fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [...CANDIDATES, forked] }) }),
  });
  await AppView.openImportPrModal();
  const list = els['import-pr-list'].innerHTML;
  assert.equal((list.match(/from a fork/g) || []).length, 1,
    'exactly the one fork-headed row is labelled');
  assert.ok(list.includes('octo-forker/usernode-mock-fork'), 'names the fork it comes from');
  // The label sits inside the fork row, after its own PR number.
  assert.ok(list.indexOf('#9403') < list.indexOf('from a fork'),
    'the label belongs to #9403, not to a row above it');
  assert.ok(list.includes('#9401') && list.includes('#9402'), 'same-repo rows still listed');
});

test('a fork label with no repo name still renders (never blank)', async () => {
  const { AppView, els } = makeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ candidates: [{ ...CANDIDATES[0], fromFork: true, headRepo: null }] }),
    }),
  });
  await AppView.openImportPrModal();
  const list = els['import-pr-list'].innerHTML;
  assert.ok(list.includes('from a fork'), 'the caution is the point, the repo name is detail');
  assert.ok(list.includes('unknown fork'), 'missing metadata reads as unknown, not empty');
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

// #846: the destination is the proposal's DISCUSSION page (subTab 'topic'),
// never the dev-chat session view — an imported PR has no dev session.
test('submitImportPr POSTs { pr } and navigates to the new proposal\'s discussion page', async () => {
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
  assert.equal(switchCalls.length, 1, 'navigated exactly once');
  // Field-wise, not deepEqual: the ref object is built inside the vm context,
  // so its prototype differs from this realm's and deepStrictEqual rejects it.
  const [tab, ref, subTab] = switchCalls[0];
  assert.equal(tab, 'dev');
  assert.equal(subTab, 'topic', 'proposal topic view, not the dev chat');
  assert.equal(ref.kind, 'proposal');
  assert.equal(ref.id, 555);
  assert.ok(els['import-pr-progress']._classes.has('hidden'), 'progress row cleared');
});

// #846: the dialog stays put while the POST is in flight, with progress.
test('submitImportPr freezes the dialog and shows progress while importing', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { AppView, els, switchCalls } = makeHarness({
    fetchImpl: async () => {
      await gate;
      return { ok: true, json: async () => ({ ok: true, sessionId: 777, prNumber: 9402 }) };
    },
  });
  els['import-pr-modal'].classList.remove('hidden');
  AppView._importPrSelected = 9402;
  const pending = AppView.submitImportPr();

  assert.equal(AppView._importPrBusy, true, 'busy flag set while in flight');
  assert.ok(!els['import-pr-progress']._classes.has('hidden'), 'progress row shown');
  assert.match(els['import-pr-progress-text'].textContent, /Importing PR #9402/);
  assert.equal(els['import-pr-submit'].disabled, true, 'submit disabled');
  assert.equal(els['import-pr-cancel'].disabled, true, 'cancel disabled');
  assert.ok(els['import-pr-list']._classes.has('pointer-events-none'), 'list inert');
  assert.ok(els['import-pr-list']._classes.has('opacity-50'), 'list dimmed');
  assert.ok(!els['import-pr-modal']._classes.has('hidden'), 'modal still open mid-import');
  assert.equal(switchCalls.length, 0, 'no navigation before the server confirms');

  // A dismiss attempt mid-flight must not close it.
  AppView.closeImportPrModal();
  assert.ok(!els['import-pr-modal']._classes.has('hidden'), 'close refused while busy');

  // A second submit mid-flight must not fire a second POST.
  await AppView.submitImportPr();
  assert.equal(switchCalls.length, 0, 'double submit ignored');

  release();
  await pending;
  assert.equal(AppView._importPrBusy, false, 'busy flag cleared');
  assert.ok(els['import-pr-modal']._classes.has('hidden'), 'modal closed after navigation');
  assert.equal(switchCalls.length, 1, 'navigated exactly once');
  assert.ok(!els['import-pr-list']._classes.has('pointer-events-none'), 'list interactive again');
  assert.equal(els['import-pr-cancel'].disabled, false, 'cancel re-enabled');
});

test('submitImportPr shows the inline error and keeps the list open on 409', async () => {
  const calls = [];
  const { AppView, els, switchCalls } = makeHarness({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/pr-import/candidates')) {
        return { ok: true, json: async () => ({ candidates: [CANDIDATES[1]] }) };
      }
      return { ok: false, status: 409, json: async () => ({ error: 'PR #9401 has already been imported.' }) };
    },
  });
  els['import-pr-modal'].classList.remove('hidden'); // modal is open before submit
  AppView._importPrSelected = 9401;
  await AppView.submitImportPr();
  const err = els['import-pr-error'];
  assert.equal(err.textContent, 'PR #9401 has already been imported.');
  assert.ok(!err._classes.has('hidden'), 'error region shown');
  assert.ok(!els['import-pr-modal']._classes.has('hidden'), 'modal stays open');
  assert.equal(switchCalls.length, 0, 'no navigation on failure');
  assert.equal(AppView._importPrBusy, false, 'dialog unfrozen');
  assert.ok(!els['import-pr-list']._classes.has('opacity-50'), 'list interactive again');
  assert.ok(els['import-pr-progress']._classes.has('hidden'), 'progress row hidden');
  // #846: an already-imported 409 means the list is stale — it reloads so the
  // row the user just tried disappears.
  assert.ok(calls.some((u) => u.includes('/pr-import/candidates')),
    'candidates reloaded after an already-imported 409');
  assert.ok(els['import-pr-list'].innerHTML.includes('#9402'), 'refreshed list rendered');
});

// #846: each failure names its own cause instead of "Import failed (HTTP N)".
test('submitImportPr maps failure statuses to specific copy', async () => {
  const cases = [
    { status: 404, body: { error: 'PR #9401 not found on GitHub' }, expect: /not found on GitHub/i },
    { status: 404, body: {}, expect: /wasn.t found on GitHub/i },
    { status: 409, body: { error: 'PR #9401 is not open.' }, expect: /is not open/i },
    { status: 409, body: { error: 'GitHub is not configured for this app' }, expect: /GitHub is not configured/i },
    { status: 503, body: {}, expect: /platform is restarting/i },
    { status: 500, body: {}, expect: /Something went wrong importing this PR/i },
  ];
  for (const c of cases) {
    const { AppView, els, switchCalls } = makeHarness({
      fetchImpl: async () => ({ ok: false, status: c.status, json: async () => c.body }),
    });
    els['import-pr-modal'].classList.remove('hidden');
    AppView._importPrSelected = 9401;
    await AppView.submitImportPr();
    assert.match(els['import-pr-error'].textContent, c.expect,
      `status ${c.status} (${JSON.stringify(c.body)}) copy`);
    assert.ok(!els['import-pr-modal']._classes.has('hidden'), `status ${c.status} keeps modal open`);
    assert.equal(switchCalls.length, 0, `status ${c.status} does not navigate`);
    assert.equal(els['import-pr-cancel'].disabled, false, `status ${c.status} re-enables cancel`);
  }
});

test('submitImportPr surfaces a network error without navigating', async () => {
  const { AppView, els, switchCalls } = makeHarness({
    fetchImpl: async () => { throw new Error('offline'); },
  });
  els['import-pr-modal'].classList.remove('hidden');
  AppView._importPrSelected = 9401;
  await AppView.submitImportPr();
  assert.match(els['import-pr-error'].textContent, /Network error/i);
  assert.ok(!els['import-pr-modal']._classes.has('hidden'), 'modal stays open');
  assert.equal(switchCalls.length, 0, 'no navigation');
  assert.equal(AppView._importPrBusy, false, 'dialog unfrozen');
});

// The import succeeded server-side even if the navigation blew up, so the
// user is told where to find it rather than left staring at a frozen dialog.
test('submitImportPr closes the dialog and toasts when navigation throws', async () => {
  const { AppView, els, toasts } = makeHarness({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, sessionId: 42, prNumber: 9401 }) }),
  });
  els['import-pr-modal'].classList.remove('hidden');
  AppView._importPrSelected = 9401;
  AppView.openTopic = () => { throw new Error('app data gone'); };
  await AppView.submitImportPr();
  assert.ok(els['import-pr-modal']._classes.has('hidden'), 'modal closed anyway');
  assert.equal(toasts.length, 1, 'told the user the import landed');
  assert.match(toasts[0], /PR #9401 was imported/);
});

test('submitImportPr no-ops with no selection', async () => {
  const { AppView, switchCalls } = makeHarness();
  AppView._importPrSelected = null;
  await AppView.submitImportPr();
  assert.equal(switchCalls.length, 0, 'nothing submitted without a chosen PR');
});
