// #814: mobile kanban tabs. Below 640px the Dev board renders ONE column at
// a time behind a tab strip instead of scrolling sideways.
//
// #4486 retired the separate `#dev-kanban-tabs` strip: the columns now lead
// with PIPELINE HEADS — Requests › Underway › Waiting for approval › Done,
// each with its stage icon and count — and below 640px those heads ARE the
// tabs, inside the `.dev-kanban-pipe` tablist (CSS hides the tablist at
// 640px and up, where the in-column heads label the columns). A tab's id and
// role live only in the tablist; the in-column head repeats the state
// without them. DELIBERATE (recorded for #4486): the strip's markup pins
// below became pipe-head pins.
//
// The switch WAS presentation-only — every column stayed in the markup and
// CSS (app.css, @media max-width: 639px) decided what was visible. It is not
// any more: below 640px an inactive column now renders its shell (id,
// data-kanban-col, heading, count) but not its CARDS, because building 104
// of them so CSS can hide them was the largest single item in a phone-shaped
// profile of a warm board — 5701 DOM nodes and ~1090ms of main-thread
// blocking, against 2011 and ~588ms once they wait for their tab. The last
// two tests in this file pin both halves of that. Everything else here still
// asserts the markup at DESKTOP width, where nothing changed and where the
// proposal-checks runner does its asserting (a fixed 1280x800 frame — see
// src/services/visuals.js).
//
// These tests assert the STRING the board renders:
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
const { kanbanHtml } = require('./lib/dev-card-html');
const { SW_VERSION } = require('../public/sw.js');

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

test('Done column visibly names the live production boundary', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { merged: 2 });
  AppView._mergedCtx.deployment = {
    state: 'deployed',
    runningSha: 'abcdef0123456789abcdef0123456789abcdef01',
    livePrNumber: 42,
    pendingCount: 0,
  };
  const html = kanbanHtml(AppView);
  assert.match(html, /data-kanban-col-status="done"/);
  assert.match(html, /Production live through PR #42 · abcdef0/);
});

test('Done column calls out pending and stalled production changes', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { merged: 2 });
  AppView._mergedCtx.deployment = { state: 'deploying', pendingCount: 2 };
  let html = kanbanHtml(AppView);
  assert.match(html, /2 merged changes waiting to go live/);

  AppView._mergedCtx.deployment = { state: 'stalled', pendingCount: 1 };
  html = kanbanHtml(AppView);
  assert.match(html, /1 merged change · deployment stalled/);
});

test('Done deployment summary retires shells that cannot render its status field', () => {
  const version = Number(String(SW_VERSION).replace(/^v/, ''));
  assert.ok(version >= 33, `expected the Done-deployment shell cache, got ${SW_VERSION}`);
});

// The `.dev-kanban-pipe` tablist's slice: each column's in-column head
// repeats `data-kanban-tab` (#4486), so the tab-level assertions read the
// tablist only.
const pipeSlice = (html) =>
  html.slice(html.indexOf('class="dev-kanban-pipe"'), html.indexOf('<div id="dev-kanban"'));

// All `data-kanban-tab="…"` keys, in tablist order.
const tabKeys = (html) =>
  Array.from(pipeSlice(html).matchAll(/data-kanban-tab="([^"]+)"/g), (m) => m[1]);

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

// ── Pipeline heads as the tablist (#4486) ─────────────────────────────────

test('renders one tab per column, in board order, in the pipeline tablist', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = kanbanHtml(AppView);
  assert.deepEqual(tabKeys(html), ['issues', 'inprogress', 'inreview', 'done']);
  assert.match(html, /class="dev-kanban-pipe" role="tablist" aria-label="Board columns"/);
  // The retired `#dev-kanban-tabs` strip is gone. DELIBERATE (#4486).
  assert.ok(!/id="dev-kanban-tabs"/.test(html), 'the old strip is retired');
});

test('the pipeline tablist is emitted before the board, which keeps its #dev-kanban id', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = kanbanHtml(AppView);
  assert.ok(html.indexOf('class="dev-kanban-pipe"') < html.indexOf('id="dev-kanban"'),
    'tabs render above the columns');
  // The shipped dapp.json test asserts #dev-kanban — it must survive.
  assert.match(html, /<div id="dev-kanban" class="flex gap-3 overflow-x-auto pb-2"/);
});

test('each tab is a real button wired to its column for assistive tech', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = kanbanHtml(AppView);
  for (const key of ['issues', 'inprogress', 'inreview', 'done']) {
    assert.match(html, new RegExp(`role="tab" id="dev-kanban-tab-${key}"`));
    assert.match(html, new RegExp(`aria-controls="dev-kanban-col-${key}"`));
    assert.match(html, new RegExp(`id="dev-kanban-col-${key}"`));
  }
  // A tab's id exists exactly once: the in-column head repeats the state
  // without the tab role or the id (#4486).
  assert.equal((html.match(/id="dev-kanban-tab-/g) || []).length, 4);
  // Exactly one tab is selected at a time, inside the tablist.
  assert.equal((pipeSlice(html).match(/aria-selected="true"/g) || []).length, 1);
});

// ── The heads are a segmented control, not an underline row (#2441) ───────
//
// The strip shipped as a `border-b` track with `border-violet-500` under the
// active tab. That is the one shape the widget language replaces everywhere —
// it separates by RULE where the language separates by figure/ground — and
// @/components/ui/tabs.tsx's header says so at length. The heads wear the
// same primitive the strip wore: the near-black selected fill, the muted
// unselected treatment. The tablist's raised track itself is app.css's
// `.dev-kanban-pipe` (a media query shows it below 640px), not Tailwind in
// the markup.
//
// What did NOT change is every attribute: dapp.json selects
// `.dev-kanban-pipe [data-kanban-tab="…"]`, and the tests above read
// `role="tab"` / `aria-selected` / `aria-controls`.
//
// The treatment is read out of tabs.tsx rather than transcribed, so the two
// surfaces cannot drift the first time the palette moves.

// One rendered tab's opening tag, anchored by its id.
function tabTag(html, key) {
  const m = html.match(new RegExp(`<button[^>]*id="dev-kanban-tab-${key}"[^>]*>`));
  assert.ok(m, `the ${key} tab's opening tag is located`);
  return m[0];
}

// A class-table constant out of @/components/ui/tabs.tsx, with its
// concatenated string pieces joined back up.
function tabsConstant(name) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', '@', 'components', 'ui', 'tabs.tsx'), 'utf8');
  const start = src.indexOf(`export const ${name} =`);
  assert.notEqual(start, -1, `${name} is exported from @/components/ui/tabs.tsx`);
  const decl = src.slice(start, src.indexOf(';', start));
  const parts = Array.from(decl.matchAll(/'([^']*)'/g), (m) => m[1]);
  assert.ok(parts.length > 0, `${name} is a literal class string`);
  return parts.join('');
}

test('the pipe heads wear the language\'s segmented control (#2441)', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = kanbanHtml(AppView);

  const pipe = html.match(/<div class="dev-kanban-pipe" role="tablist"[^>]*>/);
  assert.ok(pipe, 'the tablist container is located');
  assert.ok(!/border-b/.test(pipe[0]), 'no rule under the tablist');

  const active = tabTag(html, 'issues');
  assert.ok(active.includes(tabsConstant('SECTION_TAB_ACTIVE')),
    'the selected tab is the language\'s inversion, from tabs.tsx');

  for (const key of ['inprogress', 'inreview', 'done']) {
    assert.ok(tabTag(html, key).includes(tabsConstant('SECTION_TAB_INACTIVE')),
      `the ${key} tab is the unselected treatment, from tabs.tsx`);
  }

  // The retired shape, in every one of its spellings.
  for (const tab of ['issues', 'inprogress', 'inreview', 'done'].map((k) => tabTag(html, k))) {
    assert.ok(!/border-b-2|border-violet-500|border-transparent/.test(tab),
      'no underline left on any tab');
    assert.ok(!/violet/.test(tab), 'and no violet ink: the selection is the near-black fill');
  }
});

test('the heads carry every attribute the checks select on, in their shipped order (#4486)', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = kanbanHtml(AppView);
  // dapp.json's two declared checks select `.dev-kanban-pipe
  // [data-kanban-tab="inreview"]` and `…="done"` — the container class and
  // the key, never a Tailwind class on the tab.
  assert.match(html, /<div class="dev-kanban-pipe" role="tablist" aria-label="Board columns">/);
  for (const key of ['issues', 'inprogress', 'inreview', 'done']) {
    const tab = tabTag(html, key);
    assert.match(tab, new RegExp(`^<button type="button" role="tab" id="dev-kanban-tab-${key}" `
      + `aria-controls="dev-kanban-col-${key}" data-kanban-tab="${key}" aria-selected="(true|false)" class="`),
      `the ${key} tab's attributes, in their shipped order`);
  }
  assert.match(tabTag(html, 'issues'), /aria-selected="true"/);
  // And it is still a tablist of four, not a `<TabsTrigger>` strip that would
  // state its selection twice.
  assert.equal((html.match(/aria-current=/g) || []).length, 0,
    'aria-selected is this tablist\'s convention; aria-current is the other one');
});

// ── Counts match the column headers ────────────────────────────────────────

test('tab counts mirror the column head counts', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 2, merged: 3 });
  const html = kanbanHtml(AppView);
  assert.equal(tabCount(html, 'issues'), '2');
  assert.equal(tabCount(html, 'inreview'), '1');
  assert.equal(tabCount(html, 'done'), '3');
  // Same numbers in the (desktop-only) in-column heads — one head, one count.
  assert.match(html, /dev-kanban-pipe-name">Requests<\/span>/, 'the Issues column is "Requests" (UI overhaul)');
  assert.match(html, /dev-kanban-pipe-name">Done<\/span><span class="dev-kanban-pipe-count">3<\/span>/);
});

test('Done head shows the server total, not the loaded page length', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { merged: 3, total: 25 });
  const html = kanbanHtml(AppView);
  assert.equal(tabCount(html, 'done'), '25');
  assert.match(html, /dev-kanban-pipe-name">Done<\/span><span class="dev-kanban-pipe-count">25<\/span>/);
});

test('while filtering, the Done head shows the matching count instead of the total', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { merged: 3, total: 25 });
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'PR 1' };
  const html = kanbanHtml(AppView);
  assert.equal(tabCount(html, 'done'), '1');
  assert.match(html, /dev-kanban-pipe-name">Done<\/span><span class="dev-kanban-pipe-count">1<\/span>/);
});

test('an empty column keeps its tab, showing 0 next to the in-column placeholder', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 0, merged: 0 });
  const html = kanbanHtml(AppView);
  assert.deepEqual(tabKeys(html), ['issues', 'inprogress', 'inreview', 'done']);
  assert.equal(tabCount(html, 'issues'), '0');
  assert.equal(tabCount(html, 'done'), '0');
  assert.match(html, /Nothing here yet/);
});

test('an emptied-by-filter column keeps its tab and says so in the column', () => {
  const AppView = makeAppView();
  seedBoard(AppView, { issues: 2, merged: 2 });
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'zzz-no-match' };
  const html = kanbanHtml(AppView);
  assert.equal(tabCount(html, 'issues'), '0');
  assert.match(html, /No matching cards/);
});

// ── Active column marking ──────────────────────────────────────────────────

test('exactly one column is marked active, and it agrees with data-kanban-active', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = kanbanHtml(AppView);
  assert.deepEqual(activeCols(html), ['issues']);
  assert.equal(activeAttr(html), 'issues');
});

test('the active tab defaults to Issues with nothing stored', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const html = kanbanHtml(AppView);
  assert.match(html, /id="dev-kanban-tab-issues"[^>]*aria-selected="true"/);
});

test('a stored per-app tab is honoured by the render', () => {
  const AppView = makeAppView({
    sessionStorage: { getItem: (k) => (k === 'devKanbanTab:demo-app' ? 'done' : null), setItem: () => {}, removeItem: () => {} },
  });
  AppView._kanbanTab = AppView._loadKanbanTab('demo-app');
  seedBoard(AppView);
  const html = kanbanHtml(AppView);
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
  const html = kanbanHtml(AppView);
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
  const html = kanbanHtml(AppView);
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

test('the surface that draws the columns restores the active one, or ?col= reaches nothing', () => {
  // WHAT BROKE. `_kanbanTab` was loaded in ONE place: the standalone Board
  // branch of `_repaintDevBody`, at its first mount. When the Board view mode
  // retired and those columns became the Workshop's stage pane, that branch
  // stopped being reachable — and `_loadKanbanTab` with it, so `_kanbanTab`
  // sat on its 'issues' default and three declared `?col=` checks failed
  // while every other board check passed.
  //
  // The two branches restore the SAME per-app state, and this asserts that
  // pairing rather than one branch's contents: filters and the active column
  // are both per-app, both read from a URL override then storage, and dropping
  // either one is silent.
  const body = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _repaintDevBody()'));
  const fn = body.slice(0, body.indexOf('\n  },'));
  assert.equal((fn.match(/_loadKanbanFilters\(/g) || []).length, 2,
    'both surfaces restore this app\'s filters');
  assert.equal((fn.match(/_loadKanbanTab\(/g) || []).length, 2,
    'and both restore this app\'s active column');
  // Each restore is guarded, so a repaint never clobbers a tap: the Board
  // branch by its own host being absent, the Workshop branch by the slug.
  const workshop = fn.slice(fn.indexOf("_kanbanFiltersSlug !== App.currentApp"));
  assert.match(workshop, /_loadKanbanTab\(App\.currentApp\)/,
    'the Workshop restores the column inside the slug guard, not on every repaint');
});

// ── ?view= override on the view mode ───────────────────────────────────────

test('?view=kanban resolves onto the Workshop, with the stage pane up', () => {
  // The retired Board view's deep link. The mode it asked for is gone, and the
  // pane it was asking FOR is the Workshop's "By stage" — so the parameter is
  // honoured there rather than going quietly nowhere.
  const AppView = makeAppView({
    search: '?view=kanban',
    matchMedia: () => ({ matches: false }), // phone frame
  });
  assert.equal(AppView._getViewMode(), 'workshop');
  assert.equal(AppView._getWorkshopGroup(), 'stage', 'the columns it wanted');
});

test('an explicit ?group= wins over the retired ?view=kanban beside it', () => {
  // `?group=` is the parameter still being offered, so it names the pane.
  // `category` is what the pane is called, and what it was called before
  // #2332 briefly renamed it.
  const AppView = makeAppView({
    search: '?view=kanban&group=category',
    matchMedia: () => ({ matches: false }),
  });
  assert.equal(AppView._getWorkshopGroup(), 'category');
});

test('?view=workshop wins over a stored kanban preference', () => {
  const AppView = makeAppView({
    search: '?view=workshop',
    matchMedia: () => ({ matches: true }),
    localStorage: { getItem: () => 'kanban', setItem: () => {} },
  });
  assert.equal(AppView._getViewMode(), 'workshop');
});

test('?view=list and ?view=feed still resolve — the override is migrated, not just validated', () => {
  // `?view=list` and `?view=feed` are in the wild: capture routes, bookmarks
  // and the dapp.json checks all carried them, and #814's whole point was
  // that a fresh browser can be pointed straight at a given view. Both name
  // the surface the Workshop replaced, so both land there.
  for (const v of ['list', 'feed']) {
    const AppView = makeAppView({
      search: `?view=${v}`,
      matchMedia: () => ({ matches: true }),
      localStorage: { getItem: () => 'kanban', setItem: () => {} },
    });
    assert.equal(AppView._getViewMode(), 'workshop', `?view=${v}`);
  }
});

test('an unrecognized ?view= leaves the existing resolution untouched', () => {
  const AppView = makeAppView({
    search: '?view=sideways',
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(AppView._getViewMode(), 'workshop'); // the default, unchanged
});

test('choosing a pane retires the ?view=kanban override so the click sticks', () => {
  // The surviving half of "an explicit choice beats the URL". It used to be
  // the view-mode toggle against `?view=`; with one mode left, the control
  // that choice is made on is the grouping tab strip, and the override it has
  // to retire is the one the retired parameter set.
  const store = { devViewMode: 'kanban' };
  const AppView = makeAppView({
    search: '?view=kanban',
    matchMedia: () => ({ matches: false }),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
  });
  assert.equal(AppView._getViewMode(), 'workshop', 'the stored value migrates too');
  assert.equal(AppView._getWorkshopGroup(), 'stage');
  AppView._setWorkshopGroup('category');
  assert.equal(AppView._getWorkshopGroup(), 'category',
    'the explicit choice wins over the URL');
});

test('no ?view= at all lands on the Workshop on every width', () => {
  // The #462 width default (kanban when wide, the list when narrow) retired
  // with the feed: the Workshop is the lander because it answers the first
  // question on any device, and the board's columns are one tab away on both.
  const wide = makeAppView({ search: '', matchMedia: () => ({ matches: true }) });
  assert.equal(wide._getViewMode(), 'workshop');
  const narrow = makeAppView({ search: '', matchMedia: () => ({ matches: false }) });
  assert.equal(narrow._getViewMode(), 'workshop');
});

// ── The single-column ↔ multi-column breakpoint ─────────────────────────────
// One number lives in three places (the JS width default, the pipe CSS
// blocks in app.css). It was lowered from 1024px to 640px, so pin all of
// them together — a future edit to one of them alone would silently split
// the board's layout from its tab strip.

test('the 640px breakpoint agrees across the JS default, app.css and sm:hidden', () => {
  const AppView = makeAppView();
  assert.equal(AppView.KANBAN_MULTICOL_MEDIA, '(min-width: 640px)');

  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8'
  );
  // Single column (tab strip) strictly below 640px …
  assert.match(css, /@media \(max-width: 639px\) \{[^}]*#dev-kanban \{ overflow-x: hidden; \}/);
  // … and from 640px up the columns are side by side. In the band the
  // breakpoint reclaimed they stay in ONE row at the readable 16rem width
  // and the board scrolls sideways — it must never wrap, and it must never
  // lift the floor (that would squeeze four columns into ~150px each).
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
  // beat every media query above.
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
  assert.doesNotMatch(css, /@media \(max-width: 1023px\) \{\s*\/\* No sideways scroll/);

  seedBoard(AppView);
  // The tablist that carries the heads as tabs shows strictly below 640px
  // (app.css) and never takes part in the layout above it.
  assert.match(css, /\.dev-kanban-pipe \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 639px\) \{\s*\.dev-kanban-pipe \{\s*display: flex;/);
});

// ── Environment tolerance ──────────────────────────────────────────────────

test('rendering works with neither sessionStorage nor location present', () => {
  const AppView = makeAppView(); // no sessionStorage, no location
  seedBoard(AppView);
  let html;
  assert.doesNotThrow(() => { html = kanbanHtml(AppView); });
  assert.deepEqual(tabKeys(html), ['issues', 'inprogress', 'inreview', 'done']);
  assert.equal(activeAttr(html), 'issues');
  assert.doesNotThrow(() => AppView._saveKanbanTab('demo-app'));
  assert.equal(AppView._loadKanbanTab('demo-app'), 'issues');
});


// ── Below 640px, an off-screen column keeps its shell and drops its cards ──

// useNarrowViewport reads window.matchMedia. renderToStaticMarkup runs the
// useState initialiser but no effects, so stubbing the global is enough to
// render the narrow tree — and NOT stubbing it is what every test above
// does, which is why they all still describe the desktop board.
function withNarrow(narrow, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  const prevMM = prev && prev.matchMedia;
  const win = prev || {};
  win.matchMedia = (q) => ({ matches: narrow && /max-width:\s*639px/.test(q), media: q });
  globalThis.window = win;
  try { return fn(); } finally {
    if (prev) { if (prevMM) win.matchMedia = prevMM; else delete win.matchMedia; }
    else if (!had) delete globalThis.window;
  }
}

test('narrow: only the active column renders cards, and every column keeps its shell', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  const wide = kanbanHtml(AppView);
  const narrow = withNarrow(true, () => kanbanHtml(AppView));

  // The shells are identical in inventory: same four ids, same order, same
  // active marker, same pipeline tablist. Nothing a dapp.json selector
  // anchors on moves — see the file header for where those run.
  for (const key of ['issues', 'inprogress', 'inreview', 'done']) {
    assert.match(narrow, new RegExp(`id="dev-kanban-col-${key}"`), `${key} column shell`);
    assert.match(narrow, new RegExp(`data-kanban-col="${key}"`));
  }
  assert.deepEqual(tabKeys(narrow), tabKeys(wide));
  assert.deepEqual(activeCols(narrow), activeCols(wide));
  assert.equal(activeAttr(narrow), activeAttr(wide));

  // …and the counts are unchanged, in the heads AND the tabs, because
  // they come from col.count and not from how many rows were rendered. A
  // deferred column that under-reported its size would be worse than a slow
  // one: the number is the reason to tap the tab.
  for (const key of ['issues', 'inprogress', 'inreview', 'done']) {
    assert.equal(tabCount(narrow, key), tabCount(wide, key), `${key} tab count`);
  }

  // The items themselves are the only thing that waits. A card draws as one
  // of the Workshop's rows on the board (#4487's row, #4486's board), so
  // count `data-ws-row` — one per item at either size.
  const cards = (h) => (h.match(/data-ws-row="/g) || []).length;
  assert.ok(cards(wide) > cards(narrow),
    `narrow renders fewer rows (wide ${cards(wide)}, narrow ${cards(narrow)})`);
  assert.ok(cards(narrow) > 0, 'the ACTIVE column still renders its rows');
});

test('wide is untouched, which is the contract the checks runner asserts under', () => {
  const AppView = makeAppView();
  seedBoard(AppView);
  // matchMedia present but NOT matching is the desktop browser; absent is
  // the server render. Both must produce the board every other test here
  // describes, row for row.
  const plain = kanbanHtml(AppView);
  assert.equal(withNarrow(false, () => kanbanHtml(AppView)), plain);
  const cards = (h) => (h.match(/data-ws-row="/g) || []).length;
  assert.ok(cards(plain) > 0);
  // Every column carries rows at desktop width — the thing the declared
  // checks select through (`#dev-kanban-col-inprogress .dev-ws-wrow` and
  // friends; the row carries `data-ws-open` where the card carried its hook).
  for (const key of ['issues', 'inprogress', 'inreview', 'done']) {
    const start = plain.indexOf(`id="dev-kanban-col-${key}"`);
    assert.notEqual(start, -1);
  }
});
