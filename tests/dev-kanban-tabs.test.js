// #814, re-cut: THE BOARD'S ONE STRIP.
//
// The board used to carry two display controls for one question. A
// Kanban|Feed mode (a localStorage preference, last drawn as a pair of pills
// under the Improve panel's Board row) chose the LAYOUT, and inside kanban
// this strip chose the COLUMN — except CSS hid the strip above 640px, so on a
// desktop it did not exist and on a phone the layout pills governed a board
// you could only see one column of anyway.
//
// There is one strip now, at every width:
//
//     All · Issues · Underway · In review · Done
//
//   - `All` is the whole board drawn to fit: the four columns side by side
//     where there is room, the recency-ordered stream where there is not.
//     It marks NO column active, and carries no count (Done reports a
//     lifetime total, so any sum is either wrong or enormous).
//   - every other tab is that column alone, on a phone and on a desktop
//     alike — `#dev-kanban[data-kanban-active]` is what CSS reads, not a
//     media query.
//
// So these tests assert three things: the strip's markup (which now comes
// from board-tabs.tsx, a row of the FRAME — it has to outlive the body it
// switches), the columns' markup (still dev-kanban.tsx), and the resolution
// of a tab from `?col=`, the per-app sessionStorage value and the default.
//
// `?view=` survives as a deep-link/capture LAYOUT override with no control
// behind it: dapp.json shoots every check at 1280x800, where `All` is the
// columns, so without it the stream would have no end-to-end coverage.
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
const { kanbanHtml, boardTabsHtml, api } = require('./lib/dev-card-html');
const { renderToHtml, createElement } = require('./lib/render-tsx');

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
  // A seeded board is a LOADED board. `_kanbanView()` reports `loading` until
  // this is set, and the columns then draw placeholders with no counts — see
  // frontend/src/features/dev-board/card/skeleton.tsx.
  AppView._devDataReady = true;
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

const ALL_TABS = ['all', 'issues', 'inprogress', 'inreview', 'done'];

// ── Tab strip shape ────────────────────────────────────────────────────────

test('renders All plus one tab per column, in board order, in one tablist', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = boardTabsHtml(AppView);
  assert.deepEqual(tabKeys(html), ALL_TABS);
  assert.match(html, /id="dev-kanban-tabs"[^>]*role="tablist"/);
});

test('the strip is NOT hidden above 640px any more — it is the board control', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = boardTabsHtml(AppView);
  // `sm:hidden` is exactly what made this control phone-only, which is the
  // whole bug: above 640px the board had no way to pick a column and the
  // layout pills lived in another surface entirely.
  assert.doesNotMatch(html, /id="dev-kanban-tabs"[^>]*sm:hidden/);
});

test('the strip is a separate row from the board, so All can render the stream', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  // It used to be emitted inside the kanban's own markup, which put it
  // inside #dev-body — the host _repaintDevBody() replaces wholesale. A
  // control that deleted itself the first time you asked for the stream.
  assert.doesNotMatch(kanbanHtml(AppView), /id="dev-kanban-tabs"/);
  assert.match(boardTabsHtml(AppView), /id="dev-kanban-tabs"/);
  // The shipped dapp.json test asserts #dev-kanban — it must survive.
  assert.match(kanbanHtml(AppView), /<div id="dev-kanban" class="flex gap-3 overflow-x-auto pb-2"/);
});

test('each column tab is a real button wired to its column for assistive tech', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = boardTabsHtml(AppView);
  const cols = kanbanHtml(AppView);
  for (const key of ['issues', 'inprogress', 'inreview', 'done']) {
    assert.match(html, new RegExp(`role="tab" id="dev-kanban-tab-${key}"`));
    assert.match(html, new RegExp(`aria-controls="dev-kanban-col-${key}"`));
    assert.match(cols, new RegExp(`id="dev-kanban-col-${key}"`));
  }
  // `All` controls whichever surface is under the strip — on a narrow
  // viewport that is #dev-feed — so it names no single element.
  assert.match(html, /role="tab" id="dev-kanban-tab-all"/);
  const allTab = html.slice(html.indexOf('id="dev-kanban-tab-all"'), html.indexOf('</button>'));
  assert.doesNotMatch(allTab, /aria-controls=/);
  // Exactly one tab is selected at a time.
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
});

test('the strip renders nothing until the first publish, then skeleton counts', () => {
  // It ships in the FRAME, mounted before app-view.js has published anything,
  // so a cold board would otherwise paint five tabs with nothing behind them.
  // The store's initial `cols: []` is that moment.
  const m = api();
  m.devKanbanStore.set({ activeTab: 'all', cols: [], loading: true });
  assert.equal(renderToHtml(createElement(m.BoardTabs)), '');

  // Once the board publishes, the counts are placeholders rather than zeros
  // while the fetch is in flight — the same skeleton the columns draw, and
  // for the same reason: a confident `0` reads as an empty board.
  const AppView = makeAppView();
  seedBoard(AppView);
  AppView._devDataReady = false;
  const html = boardTabsHtml(AppView);
  assert.deepEqual(tabKeys(html), ALL_TABS);
  assert.doesNotMatch(html, /data-kanban-tab="issues"[\s\S]{0,400}?>2</);
});

// ── Counts match the column headers ────────────────────────────────────────

test('tab counts mirror the column header counts', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 2, merged: 3 });
  const html = boardTabsHtml(AppView);
  assert.equal(tabCount(html, 'issues'), '2');
  assert.equal(tabCount(html, 'inreview'), '1');
  assert.equal(tabCount(html, 'done'), '3');
  // Same numbers in the column headings.
  const cols = kanbanHtml(AppView);
  assert.match(cols, /Issues <span[^>]*>· 2<\/span>/);
  assert.match(cols, /Done <span[^>]*>· 3<\/span>/);
});

test('All carries no number — it is the absence of a filter, not a bucket', () => {
  // A fifth number in this strip would read as the sum of the other four and
  // could not be one: Done reports the true merged TOTAL rather than the rows
  // it has loaded (#433), so the honest sum is a lifetime figure that dwarfs
  // the rest of the strip.
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 2, merged: 3, total: 250 });
  assert.equal(tabCount(boardTabsHtml(AppView), 'all'), '');
});

test('Done tab shows the server total, not the loaded page length', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { merged: 3, total: 25 });
  assert.equal(tabCount(boardTabsHtml(AppView), 'done'), '25');
  assert.match(kanbanHtml(AppView), /Done <span[^>]*>· 25<\/span>/);
});

test('while filtering, the Done tab shows the matching count instead of the total', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { merged: 3, total: 25 });
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'PR 1' };
  assert.equal(tabCount(boardTabsHtml(AppView), 'done'), '1');
  assert.match(kanbanHtml(AppView), /Done <span[^>]*>· 1<\/span>/);
});

test('an empty column keeps its tab, showing 0 next to the in-column placeholder', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 0, merged: 0 });
  const html = boardTabsHtml(AppView);
  assert.deepEqual(tabKeys(html), ALL_TABS);
  assert.equal(tabCount(html, 'issues'), '0');
  assert.equal(tabCount(html, 'done'), '0');
  assert.match(kanbanHtml(AppView), /Nothing here yet/);
});

test('an emptied-by-filter column keeps its tab and says so in the column', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 2, merged: 2 });
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'zzz-no-match' };
  assert.equal(tabCount(boardTabsHtml(AppView), 'issues'), '0');
  assert.match(kanbanHtml(AppView), /No matching cards/);
});

// ── Active marking ─────────────────────────────────────────────────────────

test('All is the default, and marks NO column active', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  assert.match(boardTabsHtml(AppView), /id="dev-kanban-tab-all"[^>]*aria-selected="true"/);
  const cols = kanbanHtml(AppView);
  assert.deepEqual(activeCols(cols), []);
  // CSS reads this attribute, not a media query: `all` draws every column.
  assert.equal(activeAttr(cols), 'all');
});

test('a column tab marks exactly one column, agreeing with data-kanban-active', () => {
  const AppView = makeAppView();
  AppView._boardTab = 'inreview';
  seedBoard(AppView);
  assert.deepEqual(activeCols(kanbanHtml(AppView)), ['inreview']);
  assert.equal(activeAttr(kanbanHtml(AppView)), 'inreview');
  assert.match(boardTabsHtml(AppView), /id="dev-kanban-tab-inreview"[^>]*aria-selected="true"/);
});

test('a stored per-app tab is honoured by the render', () => {
  const AppView = makeAppView({
    sessionStorage: { getItem: (k) => (k === 'devKanbanTab:demo-app' ? 'done' : null), setItem: () => {}, removeItem: () => {} },
  });
  AppView._boardTab = AppView._loadBoardTab('demo-app');
  seedBoard(AppView);
  assert.deepEqual(activeCols(kanbanHtml(AppView)), ['done']);
  assert.equal(activeAttr(kanbanHtml(AppView)), 'done');
  assert.match(boardTabsHtml(AppView), /id="dev-kanban-tab-done"[^>]*aria-selected="true"/);
});

test('an unknown stored tab falls back to All rather than hiding every column', () => {
  const AppView = makeAppView({
    sessionStorage: { getItem: () => 'backlog', setItem: () => {}, removeItem: () => {} },
  });
  assert.equal(AppView._loadBoardTab('demo-app'), 'all');
  AppView._boardTab = 'backlog';
  seedBoard(AppView);
  // The render never trusts the field blindly either.
  assert.equal(activeAttr(kanbanHtml(AppView)), 'all');
  assert.deepEqual(activeCols(kanbanHtml(AppView)), []);
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
  AppView._boardTab = 'inreview';
  AppView._saveBoardTab('demo-app');
  assert.equal(writes['devKanbanTab:demo-app'], 'inreview');
  // `all` is the default now, so IT is the one that leaves no residue —
  // `issues` is an ordinary stored choice.
  AppView._boardTab = 'all';
  AppView._saveBoardTab('demo-app');
  assert.deepEqual(removed, ['devKanbanTab:demo-app']);
  AppView._boardTab = 'issues';
  AppView._saveBoardTab('demo-app');
  assert.equal(writes['devKanbanTab:demo-app'], 'issues');
});

// ── ?col= override ─────────────────────────────────────────────────────────

test('?col= seeds the active tab and beats the stored value', () => {
  const AppView = makeAppView({
    search: '?demo=1&col=inreview',
    sessionStorage: { getItem: () => 'done', setItem: () => {}, removeItem: () => {} },
  });
  AppView._boardTab = AppView._loadBoardTab('demo-app');
  seedBoard(AppView);
  assert.deepEqual(activeCols(kanbanHtml(AppView)), ['inreview']);
  assert.equal(activeAttr(kanbanHtml(AppView)), 'inreview');
});

test('?col=all is valid and means the whole board', () => {
  const AppView = makeAppView({
    search: '?col=all',
    sessionStorage: { getItem: () => 'done', setItem: () => {}, removeItem: () => {} },
  });
  assert.equal(AppView._loadBoardTab('demo-app'), 'all');
});

test('a garbage ?col= is ignored in favour of the stored tab', () => {
  const AppView = makeAppView({
    search: '?col=nonsense',
    sessionStorage: { getItem: () => 'done', setItem: () => {}, removeItem: () => {} },
  });
  assert.equal(AppView._loadBoardTab('demo-app'), 'done');
});

test('no ?col= and no stored value → All', () => {
  const AppView = makeAppView({ search: '?demo=1' });
  assert.equal(AppView._loadBoardTab('demo-app'), 'all');
});

// ── The layout: a consequence of the tab and the viewport ──────────────────

test('All is the columns where there is room and the stream where there is not', () => {
  const wide = makeAppView({ search: '', matchMedia: () => ({ matches: true }) });
  assert.equal(wide._boardLayout(), 'columns');
  const narrow = makeAppView({ search: '', matchMedia: () => ({ matches: false }) });
  assert.equal(narrow._boardLayout(), 'stream');
});

test('a named column is ALWAYS the columns — there is no single-column stream', () => {
  const narrow = makeAppView({ search: '', matchMedia: () => ({ matches: false }) });
  narrow._boardTab = 'done';
  assert.equal(narrow._boardLayout(), 'columns');
});

test('no matchMedia in the environment → the stream (guarded fallback)', () => {
  const AppView = makeAppView({ search: '', matchMedia: undefined });
  assert.equal(AppView._boardLayout(), 'stream');
});

test('the viewport is resolved once per page load, not per read', () => {
  // The two paired reads inside async flows like loadMoreMerged must not
  // disagree because the window crossed 640px between them.
  let calls = 0;
  const AppView = makeAppView({
    search: '',
    matchMedia: () => { calls += 1; return { matches: true }; },
  });
  AppView._boardLayout();
  AppView._boardLayout();
  AppView._boardLayout();
  assert.equal(calls, 1);
});

// ── ?view= as a deep-link layout override ──────────────────────────────────

test('?view=feed forces the stream on a wide viewport', () => {
  // The capture container shoots at 1280x800, where `All` is the columns.
  // Without this the stream — a real surface every phone sees — would have no
  // end-to-end coverage at all.
  const AppView = makeAppView({ search: '?view=feed', matchMedia: () => ({ matches: true }) });
  assert.equal(AppView._boardLayout(), 'stream');
});

test('?view=kanban forces the columns on a narrow viewport', () => {
  const AppView = makeAppView({ search: '?view=kanban', matchMedia: () => ({ matches: false }) });
  assert.equal(AppView._boardLayout(), 'columns');
});

test('?view=list still resolves — the alias is migrated, not just validated', () => {
  // `?view=list` is in the wild: capture routes, bookmarks and the dapp.json
  // checks all carry it. Rejecting it would silently fall back to the
  // viewport, which at a desktop width is the OTHER layout.
  const AppView = makeAppView({ search: '?view=list', matchMedia: () => ({ matches: true }) });
  assert.equal(AppView._boardLayout(), 'stream');
});

test('the retired board-shaped names resolve to the columns', () => {
  for (const name of ['pm', 'report']) {
    const AppView = makeAppView({ search: `?view=${name}`, matchMedia: () => ({ matches: false }) });
    assert.equal(AppView._boardLayout(), 'columns', `?view=${name}`);
  }
});

test('an unrecognized ?view= leaves the viewport to decide', () => {
  const AppView = makeAppView({ search: '?view=sideways', matchMedia: () => ({ matches: true }) });
  assert.equal(AppView._boardLayout(), 'columns');
});

test('?col= wins over ?view= — one column is a narrower instruction', () => {
  const AppView = makeAppView({ search: '?view=feed&col=done', matchMedia: () => ({ matches: true }) });
  AppView._boardTab = AppView._loadBoardTab('demo-app');
  assert.equal(AppView._boardTab, 'done');
  assert.equal(AppView._boardLayout(), 'columns');
});

test('there is no stored layout preference left to read or write', () => {
  // The Kanban|Feed pills wrote localStorage `devViewMode`. Nothing reads it
  // now, and a value an older build left there is inert rather than migrated:
  // both modes it can name resolve to what `All` already shows.
  // Comments still name them, deliberately — the retirement is the thing a
  // future editor needs to find. This is about live code.
  const code = APP_VIEW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /devViewMode/);
  assert.doesNotMatch(code, /_getViewMode|_setViewMode|_selectViewMode/);
});

// ── The single-column ↔ multi-column breakpoint ─────────────────────────────
// One number lives in two places now (the JS viewport check and the
// 640-1023px CSS band). It used to live in three — the third was `sm:hidden`
// on the strip, which is what made the control phone-only.

test('the 640px breakpoint agrees between the JS check and app.css', () => {
  const AppView = makeAppView();
  assert.equal(AppView.KANBAN_MULTICOL_MEDIA, '(min-width: 640px)');

  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8'
  );
  // WHICH columns show is an attribute, at every width — not a media query.
  assert.match(css, /#dev-kanban:not\(\[data-kanban-active="all"\]\) \{ overflow-x: hidden; \}/);
  assert.match(css, /#dev-kanban:not\(\[data-kanban-active="all"\]\) \.dev-kanban-col \{\s*display: none;/);
  assert.match(css, /#dev-kanban:not\(\[data-kanban-active="all"\]\) \.dev-kanban-col\.dev-kanban-col-active \{\s*display: block;/);
  assert.doesNotMatch(css, /@media \(max-width: 639px\) \{[^}]*#dev-kanban \{ overflow-x: hidden; \}/,
    'the phone-only block is gone — a column is pickable at every width');

  // From 640px up the columns are side by side. In the band the breakpoint
  // reclaimed they stay in ONE row at the readable 16rem width and the board
  // scrolls sideways — it must never wrap, and it must never lift the floor
  // (that would squeeze four columns into ~150px each).
  const band = css.match(
    /@media \(min-width: 640px\) and \(max-width: 1023px\) \{([\s\S]*?)\n\}/
  );
  assert.ok(band, 'the 640-1023px band has its own block');
  assert.match(band[1], /flex-wrap: nowrap;/);
  assert.match(band[1], /overflow-x: auto;/);
  assert.doesNotMatch(band[1], /flex-wrap: wrap/);
  assert.doesNotMatch(band[1], /min-width: 0/);
  // The floor and the flex sizing must live in app.css, not as Tailwind
  // utilities in the markup — those land later in the cascade and would
  // beat every rule above.
  assert.match(css, /\.dev-kanban-col \{\s*flex: 1 1 0;\s*min-width: 16rem;\s*\}/);
  // From 1024px up the four columns fit in one row with NO sideways scroll,
  // which needs a floor low enough for the bottom of that range: four 16rem
  // columns plus three gap-3 gaps overflow a 1024px window's ~1000px of
  // content width, four 14rem ones don't.
  const wide = css.match(/@media \(min-width: 1024px\) \{\s*\.dev-kanban-col \{ min-width: (\d+(?:\.\d+)?)rem; \}/);
  assert.ok(wide, 'the >=1024px range sets its own column floor');
  const floorPx = parseFloat(wide[1]) * 16;
  assert.ok(floorPx * 4 + 12 * 3 <= 1000,
    `four ${floorPx}px columns + gaps must fit a 1024px window without scrolling`);
});

// ── Environment tolerance ──────────────────────────────────────────────────

test('rendering works with neither sessionStorage nor location present', () => {
  const AppView = makeAppView(); // no sessionStorage, no location
  seedBoard(AppView);
  let tabs;
  assert.doesNotThrow(() => { tabs = boardTabsHtml(AppView); });
  assert.deepEqual(tabKeys(tabs), ALL_TABS);
  assert.equal(activeAttr(kanbanHtml(AppView)), 'all');
  assert.doesNotThrow(() => AppView._saveBoardTab('demo-app'));
  assert.equal(AppView._loadBoardTab('demo-app'), 'all');
  assert.doesNotThrow(() => AppView._boardLayout());
});
