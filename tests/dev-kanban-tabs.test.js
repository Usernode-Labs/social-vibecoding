// #814: mobile kanban tabs. Below 1024px the Dev board renders ONE column at
// a time behind a tab strip instead of scrolling sideways. The switch is
// presentation-only — every column stays in the markup and CSS (app.css,
// @media max-width: 1023px) decides what's visible — so these tests assert
// the STRING _renderKanbanInner() produces:
//
//   - one tab per column, in board order, labelled with the same count the
//     column header shows (Done = the server total, or the matching count
//     while filtering)
//   - exactly one column carries `dev-kanban-col-active`, agreeing with
//     #dev-kanban's data-kanban-active
//   - the active tab comes from the per-app sessionStorage value or the
//     `?col=` URL override, and anything unrecognized falls back to Issues
//
// Plus the `?view=` override on _getViewMode() (the screenshot/deep-link
// escape hatch that lets a fresh 390px browser land on the board at all).
//
// Same vm-sandbox approach as tests/dev-kanban-buckets.test.js: app-view.js
// is loaded into a context with just enough globals, and the render helpers
// are called directly. Note the sandbox deliberately omits `sessionStorage`
// and `location` in most cases — the render path must stay callable without
// them.
//
// Run with: node --test tests/dev-kanban-tabs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeCtx(over) {
  const o = over || {};
  const sandbox = {
    matchMedia: o.matchMedia,
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentApp: o.currentApp || 'demo-app', currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: o.document || {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: o.localStorage || { getItem: () => null, setItem: () => {} },
    URLSearchParams,
  };
  // Only present when a test asks for them — the production code must
  // tolerate their absence (older browsers, and this very sandbox).
  if (o.sessionStorage) sandbox.sessionStorage = o.sessionStorage;
  if (o.search !== undefined) sandbox.location = { search: o.search };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox;
}

const makeAppView = (over) => makeCtx(over).__AppView;

const at = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00Z`;

// A board with something in every column, so counts are distinguishable.
function seedBoard(AppView, { issues = 2, merged = 3, total = null } = {}) {
  AppView._ghIssues = Array.from({ length: issues }, (_, i) => ({
    number: i + 1, title: `Issue ${i + 1}`, updatedAt: at(1), lastMessageAt: at(1), headless: null,
  }));
  AppView._proposals = [{
    id: 5, pr_number: 50, pr_title: 'PR 50', username: 'me', user_id: 1,
    status: 'promoted', linked_issues: [], created_at: at(1), promoted_at: at(1), last_message_at: at(1),
  }];
  AppView._govProposals = [];
  AppView._merged = Array.from({ length: merged }, (_, i) => ({
    id: i + 1, pr_number: (i + 1) * 10, pr_title: `PR ${i + 1}`, username: 'me',
    created_at: at(i + 1), status: 'merged',
  }));
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = total == null ? merged : total;
  AppView._mergedHasMore = false;
  AppView._mergedLoadingMore = false;
  AppView._mySessions = [];
  AppView._sharedSessions = [];
}

// All `data-kanban-tab="…"` keys, in document order.
const tabKeys = (html) =>
  Array.from(html.matchAll(/data-kanban-tab="([^"]+)"/g), (m) => m[1]);

// The rendered count inside one tab button (the second <span>).
function tabCount(html, key) {
  const start = html.indexOf(`data-kanban-tab="${key}"`);
  assert.notEqual(start, -1, `tab ${key} present`);
  const end = html.indexOf('</button>', start);
  const spans = Array.from(html.slice(start, end).matchAll(/<span[^>]*>([^<]*)<\/span>/g), (m) => m[1].trim());
  return spans[spans.length - 1];
}

// Columns carrying the active marker.
const activeCols = (html) =>
  Array.from(html.matchAll(/data-kanban-col="([^"]+)"\s+class="dev-kanban-col dev-kanban-col-active/g), (m) => m[1]);

const activeAttr = (html) => (html.match(/data-kanban-active="([^"]+)"/) || [])[1];

// ── Tab strip shape ────────────────────────────────────────────────────────

test('renders one tab per column, in board order, inside a hidden-at-lg tablist', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = AppView._renderKanbanInner();
  assert.deepEqual(tabKeys(html), ['issues', 'inprogress', 'inreview', 'done']);
  assert.match(html, /id="dev-kanban-tabs"[^>]*role="tablist"/);
  // Desktop keeps every column: the strip is the only thing hidden there.
  assert.match(html, /id="dev-kanban-tabs"[^>]*class="lg:hidden/);
});

test('the tab strip is emitted before the board, which keeps its #dev-kanban id', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = AppView._renderKanbanInner();
  assert.ok(html.indexOf('id="dev-kanban-tabs"') < html.indexOf('id="dev-kanban"'),
    'tabs render above the columns');
  // The shipped dapp.json test asserts #dev-kanban — it must survive.
  assert.match(html, /<div id="dev-kanban" class="flex gap-3 overflow-x-auto pb-2"/);
});

test('each tab is a real button wired to its column for assistive tech', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = AppView._renderKanbanInner();
  for (const key of ['issues', 'inprogress', 'inreview', 'done']) {
    assert.match(html, new RegExp(`role="tab" id="dev-kanban-tab-${key}"`));
    assert.match(html, new RegExp(`aria-controls="dev-kanban-col-${key}"`));
    assert.match(html, new RegExp(`id="dev-kanban-col-${key}"`));
  }
  // Exactly one tab is selected at a time.
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
});

// ── Counts match the column headers ────────────────────────────────────────

test('tab counts mirror the column header counts', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 2, merged: 3 });
  const html = AppView._renderKanbanInner();
  assert.equal(tabCount(html, 'issues'), '2');
  assert.equal(tabCount(html, 'inreview'), '1');
  assert.equal(tabCount(html, 'done'), '3');
  // Same numbers in the (desktop-only) column headings.
  assert.match(html, /Issues <span[^>]*>· 2<\/span>/);
  assert.match(html, /Done <span[^>]*>· 3<\/span>/);
});

test('Done tab shows the server total, not the loaded page length', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { merged: 3, total: 25 });
  const html = AppView._renderKanbanInner();
  assert.equal(tabCount(html, 'done'), '25');
  assert.match(html, /Done <span[^>]*>· 25<\/span>/);
});

test('while filtering, the Done tab shows the matching count instead of the total', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { merged: 3, total: 25 });
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'PR 1' };
  const html = AppView._renderKanbanInner();
  assert.equal(tabCount(html, 'done'), '1');
  assert.match(html, /Done <span[^>]*>· 1<\/span>/);
});

test('an empty column keeps its tab, showing 0 next to the in-column placeholder', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 0, merged: 0 });
  const html = AppView._renderKanbanInner();
  assert.deepEqual(tabKeys(html), ['issues', 'inprogress', 'inreview', 'done']);
  assert.equal(tabCount(html, 'issues'), '0');
  assert.equal(tabCount(html, 'done'), '0');
  assert.match(html, /Nothing here yet/);
});

test('an emptied-by-filter column keeps its tab and says so in the column', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 2, merged: 2 });
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'zzz-no-match' };
  const html = AppView._renderKanbanInner();
  assert.equal(tabCount(html, 'issues'), '0');
  assert.match(html, /No matching cards/);
});

// ── Active column marking ──────────────────────────────────────────────────

test('exactly one column is marked active, and it agrees with data-kanban-active', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = AppView._renderKanbanInner();
  assert.deepEqual(activeCols(html), ['issues']);
  assert.equal(activeAttr(html), 'issues');
});

test('the active tab defaults to Issues with nothing stored', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = AppView._renderKanbanInner();
  assert.match(html, /id="dev-kanban-tab-issues"[^>]*aria-selected="true"/);
});

test('a stored per-app tab is honoured by the render', () => {
  const AppView = makeAppView({
    sessionStorage: { getItem: (k) => (k === 'devKanbanTab:demo-app' ? 'done' : null), setItem: () => {}, removeItem: () => {} },
  });
  AppView._kanbanTab = AppView._loadKanbanTab('demo-app');
  seedBoard(AppView);
  const html = AppView._renderKanbanInner();
  assert.deepEqual(activeCols(html), ['done']);
  assert.equal(activeAttr(html), 'done');
  assert.match(html, /id="dev-kanban-tab-done"[^>]*aria-selected="true"/);
});

test('an unknown stored tab falls back to Issues rather than hiding every column', () => {
  const AppView = makeAppView({
    sessionStorage: { getItem: () => 'backlog', setItem: () => {}, removeItem: () => {} },
  });
  assert.equal(AppView._loadKanbanTab('demo-app'), 'issues');
  AppView._kanbanTab = 'backlog';
  seedBoard(AppView);
  const html = AppView._renderKanbanInner();
  assert.deepEqual(activeCols(html), ['issues']);
  assert.equal(activeAttr(html), 'issues');
});

test('the default tab is stored as absence, a non-default tab is persisted', () => {
  const writes = {};
  const removed = [];
  const AppView = makeAppView({
    sessionStorage: {
      getItem: () => null,
      setItem: (k, v) => { writes[k] = v; },
      removeItem: (k) => { removed.push(k); },
    },
  });
  AppView._kanbanTab = 'inreview';
  AppView._saveKanbanTab('demo-app');
  assert.equal(writes['devKanbanTab:demo-app'], 'inreview');
  AppView._kanbanTab = 'issues';
  AppView._saveKanbanTab('demo-app');
  assert.deepEqual(removed, ['devKanbanTab:demo-app']);
});

// ── ?col= override ─────────────────────────────────────────────────────────

test('?col= seeds the active tab and beats the stored value', () => {
  const AppView = makeAppView({
    search: '?demo=1&col=inreview',
    sessionStorage: { getItem: () => 'done', setItem: () => {}, removeItem: () => {} },
  });
  AppView._kanbanTab = AppView._loadKanbanTab('demo-app');
  seedBoard(AppView);
  const html = AppView._renderKanbanInner();
  assert.deepEqual(activeCols(html), ['inreview']);
  assert.equal(activeAttr(html), 'inreview');
});

test('a garbage ?col= is ignored in favour of the stored tab', () => {
  const AppView = makeAppView({
    search: '?col=nonsense',
    sessionStorage: { getItem: () => 'done', setItem: () => {}, removeItem: () => {} },
  });
  assert.equal(AppView._loadKanbanTab('demo-app'), 'done');
});

test('no ?col= and no stored value → Issues', () => {
  const AppView = makeAppView({ search: '?demo=1' });
  assert.equal(AppView._loadKanbanTab('demo-app'), 'issues');
});

// ── ?view= override on the view mode ───────────────────────────────────────

test('?view=kanban wins over the narrow-viewport list default', () => {
  const AppView = makeAppView({
    search: '?view=kanban',
    matchMedia: () => ({ matches: false }), // phone frame
  });
  assert.equal(AppView._getViewMode(), 'kanban');
});

test('?view=list wins over a stored kanban preference', () => {
  const AppView = makeAppView({
    search: '?view=list',
    matchMedia: () => ({ matches: true }),
    localStorage: { getItem: () => 'kanban', setItem: () => {} },
  });
  assert.equal(AppView._getViewMode(), 'list');
});

test('an unrecognized ?view= leaves the existing resolution untouched', () => {
  const AppView = makeAppView({
    search: '?view=sideways',
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(AppView._getViewMode(), 'kanban'); // width default, unchanged
});

test('toggling the view mode retires the ?view= override so the click sticks', () => {
  const store = { devViewMode: 'kanban' };
  const AppView = makeAppView({
    search: '?view=kanban',
    matchMedia: () => ({ matches: false }),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
  });
  assert.equal(AppView._getViewMode(), 'kanban');
  AppView._setViewMode('list');
  assert.equal(AppView._getViewMode(), 'list', 'the explicit choice wins over the URL');
});

test('no ?view= at all keeps the #462 width default', () => {
  const wide = makeAppView({ search: '', matchMedia: () => ({ matches: true }) });
  assert.equal(wide._getViewMode(), 'kanban');
  const narrow = makeAppView({ search: '', matchMedia: () => ({ matches: false }) });
  assert.equal(narrow._getViewMode(), 'list');
});

// ── Environment tolerance ──────────────────────────────────────────────────

test('rendering works with neither sessionStorage nor location present', () => {
  const AppView = makeAppView(); // no sessionStorage, no location
  seedBoard(AppView);
  let html;
  assert.doesNotThrow(() => { html = AppView._renderKanbanInner(); });
  assert.deepEqual(tabKeys(html), ['issues', 'inprogress', 'inreview', 'done']);
  assert.equal(activeAttr(html), 'issues');
  assert.doesNotThrow(() => AppView._saveKanbanTab('demo-app'));
  assert.equal(AppView._loadKanbanTab('demo-app'), 'issues');
});
