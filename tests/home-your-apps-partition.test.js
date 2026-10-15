// Homepage restructure: the "Your apps" partition and the client-side
// search matcher in frontend/src/features/home/home.js.
//
// "Your apps" = is_collaborator (app_collaborators membership — creator
// or accepted invite) OR is_favorited (manual add via the "…" menu).
// Ordering inside the section: explicit favorite_order first
// (ascending), NULLs after, preserving the server's activity order
// among un-ordered entries (stable sort). The search matcher is a
// case-insensitive substring test on name and slug; an empty /
// whitespace query matches everything.
//
// home.js declares `const Home = {…}` at top level; we load it into a vm
// context with stubbed globals and call the pure helpers directly — same
// harness as proposal-conflict-affordance.test.js. Its source comes from
// ./helpers/home-modules, which resolves the module's post-#1083 location and
// strips the one `import` line a vm context cannot parse.
//
// Run with: node --test tests/home-your-apps-partition.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { HOME_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { installAppCard } = require('./helpers/app-card');
const { installGridStore } = require('./helpers/home-grid-store');
const { englishPlatformI18n } = require('./lib/platform-i18n');

function makeHome(appOver) {
  const sandbox = {
    console,
    App: { user: { id: 1 }, ...appOver },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => {
        let t = '';
        return {
          set textContent(v) { t = String(v); },
          get innerHTML() {
            return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          },
        };
      },
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    confirm: () => true,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // home-layout.js is a plain script with no import; topRowApps (#4935)
  // resolves HomeLayout against it, so it loads wherever Home does.
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return sandbox.__Home;
}

const app = (over) => ({
  slug: 'some-app',
  name: 'Some App',
  is_collaborator: false,
  is_favorited: false,
  favorite_order: null,
  ...over,
});

// ── isYours ───────────────────────────────────────────────────────

test('isYours: membership OR favorite puts an app in "Your apps"', () => {
  const Home = makeHome();
  assert.equal(Home.isYours(app({ is_collaborator: true })), true, 'member-only');
  assert.equal(Home.isYours(app({ is_favorited: true })), true, 'favorited-only');
  assert.equal(Home.isYours(app({ is_collaborator: true, is_favorited: true })), true);
  assert.equal(Home.isYours(app()), false, 'neither');
  assert.equal(Home.isYours(null), false, 'null-safe');
});

test('isYours: your_apps_hidden suppresses the member pin (#618)', () => {
  const Home = makeHome();
  assert.equal(
    Home.isYours(app({ is_collaborator: true, your_apps_hidden: true })),
    false,
    'hidden member app is not yours'
  );
  assert.equal(
    Home.isYours(app({ is_collaborator: true, your_apps_hidden: false })),
    true,
    'un-hidden member app stays yours'
  );
  // Defensive: the server never serves this combination (a hidden row
  // reads as is_favorited=false), but an explicit favorite must win.
  assert.equal(
    Home.isYours(app({ is_collaborator: true, your_apps_hidden: true, is_favorited: true })),
    true,
    'explicit favorite wins over hidden'
  );
  assert.equal(
    Home.isYours(app({ your_apps_hidden: true })),
    false,
    'hidden non-member is unaffected'
  );
});

test('partitionApps: hidden member apps fall into rest (#618)', () => {
  const Home = makeHome();
  const pinned = app({ slug: 'pinned', is_collaborator: true });
  const hidden = app({ slug: 'hidden', is_collaborator: true, your_apps_hidden: true });
  const { yours, rest } = Home.partitionApps([pinned, hidden]);
  assert.deepEqual(yours.map((a) => a.slug), ['pinned']);
  assert.deepEqual(rest.map((a) => a.slug), ['hidden']);
});

// ── partitionApps ─────────────────────────────────────────────────

test('partitionApps: members and favorites land in yours, everything else in rest', () => {
  const Home = makeHome();
  const member = app({ slug: 'member', is_collaborator: true });
  const starred = app({ slug: 'starred', is_favorited: true });
  const both = app({ slug: 'both', is_collaborator: true, is_favorited: true });
  const other = app({ slug: 'other' });
  const { yours, rest } = Home.partitionApps([other, member, starred, both]);
  assert.deepEqual(yours.map((a) => a.slug).sort(), ['both', 'member', 'starred']);
  assert.deepEqual(rest.map((a) => a.slug), ['other']);
});

test('partitionApps: favorite_order sorts first (ascending), NULLs keep activity order after', () => {
  const Home = makeHome();
  // Server order (activity) is the array order: m1, m2, f2, f1.
  const m1 = app({ slug: 'member-1', is_collaborator: true });           // no order
  const m2 = app({ slug: 'member-2', is_collaborator: true });           // no order
  const f2 = app({ slug: 'fav-2', is_favorited: true, favorite_order: 1 });
  const f1 = app({ slug: 'fav-1', is_favorited: true, favorite_order: 0 });
  const { yours } = Home.partitionApps([m1, m2, f2, f1]);
  assert.deepEqual(
    yours.map((a) => a.slug),
    ['fav-1', 'fav-2', 'member-1', 'member-2'],
    'explicit order first, un-ordered members keep their stable server order after'
  );
});

test('partitionApps: empty and missing input are safe', () => {
  const Home = makeHome();
  // .length checks rather than deepEqual — vm-realm Arrays have a
  // foreign Array.prototype, which deepStrictEqual rejects.
  const empty = Home.partitionApps([]);
  assert.equal(empty.yours.length, 0);
  assert.equal(empty.rest.length, 0);
  const missing = Home.partitionApps(undefined);
  assert.equal(missing.yours.length, 0);
  assert.equal(missing.rest.length, 0);
});

// ── matchesQuery / filterApps ─────────────────────────────────────

test('matchesQuery: case-insensitive substring on name and slug', () => {
  const Home = makeHome();
  const a = app({ name: 'Chess Arena', slug: 'chess-arena-3f2a' });
  assert.equal(Home.matchesQuery(a, 'chess'), true);
  assert.equal(Home.matchesQuery(a, 'CHESS'), true, 'case-insensitive');
  assert.equal(Home.matchesQuery(a, 'ss are'), true, 'substring anywhere in the name');
  assert.equal(Home.matchesQuery(a, '3f2a'), true, 'slug matches too');
  assert.equal(Home.matchesQuery(a, 'checkers'), false);
});

test('matchesQuery: empty / whitespace-only query matches everything', () => {
  const Home = makeHome();
  const a = app({ name: 'Anything' });
  assert.equal(Home.matchesQuery(a, ''), true);
  assert.equal(Home.matchesQuery(a, '   '), true);
  assert.equal(Home.matchesQuery(a, null), true);
});

test('filterApps: returns only the matches, in input order', () => {
  const Home = makeHome();
  const apps = [
    app({ name: 'Chess Arena', slug: 'chess' }),
    app({ name: 'Puzzle Chain', slug: 'puzzle' }),
    app({ name: 'Word Garden', slug: 'word' }),
  ];
  assert.deepEqual(Home.filterApps(apps, 'zz').map((a) => a.slug), ['puzzle']);
  assert.deepEqual(Home.filterApps(apps, 'ar').map((a) => a.slug), ['chess', 'word']);
  assert.deepEqual(Home.filterApps(apps, '').map((a) => a.slug), ['chess', 'puzzle', 'word']);
  assert.deepEqual(Home.filterApps(apps, 'nope'), []);
});

test('filterApps: an exact name or slug match leads; the rest keep input order (#4793)', () => {
  const Home = makeHome();
  const apps = [
    app({ name: 'Chess Arena', slug: 'arena-1' }),
    app({ name: 'Chess Club', slug: 'club-2' }),
    app({ name: 'Speed Chess', slug: 'speed-3' }),
    app({ name: 'Chess', slug: 'chess-4' }),
    app({ name: 'Board Games', slug: 'chess' }),
  ];
  const slugs = (q) => Home.filterApps(apps, q).map((a) => a.slug);
  assert.deepEqual(slugs('chess'), ['chess-4', 'chess', 'arena-1', 'club-2', 'speed-3'],
    'name and slug exact matches lead, in input order among themselves');
  assert.deepEqual(slugs('  CHESS '), ['chess-4', 'chess', 'arena-1', 'club-2', 'speed-3'],
    'case and surrounding whitespace do not matter');
  assert.deepEqual(slugs('speed-3'), ['speed-3'], 'an exact slug match');
  assert.deepEqual(slugs('chess club'), ['club-2'], 'an exact name match');
  assert.deepEqual(slugs('ches'), ['arena-1', 'club-2', 'speed-3', 'chess-4', 'chess'],
    'no exact match: input order unchanged');
  assert.deepEqual(slugs(''), apps.map((a) => a.slug), 'empty query: everything, unchanged');
  assert.deepEqual(slugs('   '), apps.map((a) => a.slug), 'blank query: everything, unchanged');
});

test('isExactMatch: whole name or slug, trimmed, any case; never on an empty query', () => {
  const Home = makeHome();
  const a = app({ name: 'Chess Arena', slug: 'chess-arena-3f2a' });
  assert.equal(Home.isExactMatch(a, 'chess arena'), true);
  assert.equal(Home.isExactMatch(a, ' CHESS-ARENA-3F2A '), true);
  assert.equal(Home.isExactMatch(a, 'chess'), false, 'a substring is not exact');
  assert.equal(Home.isExactMatch(a, ''), false);
  assert.equal(Home.isExactMatch(a, null), false);
});

test('search: a composed and a decomposed accent are the same letter', () => {
  const Home = makeHome();
  const decomposed = 'Café';         // e + combining acute, as stored
  const composed = 'Café';            // é as one code point, as typed
  const a = app({ name: decomposed, slug: 'cafe-1' });
  assert.equal(Home.isExactMatch(a, composed), true, 'exact across forms');
  assert.equal(Home.isExactMatch(app({ name: composed }), decomposed), true, 'and the other way');
  assert.equal(Home.matchesQuery(app({ name: `Le ${decomposed} Bar` }), composed.toLowerCase()), true,
    'substring across forms');
  const apps = [app({ name: `${composed} Crawl`, slug: 'crawl' }), a];
  assert.deepEqual(Home.filterApps(apps, composed).map((x) => x.slug), ['cafe-1', 'crawl'],
    'the decomposed exact match leads');
});

// ── The home grid is "Your apps" only ─────────────────────────────
//
// Source pins for the home-screen split: the grid renders the `yours`
// half of the partition and nothing else — the "All Apps" section and
// its cards moved to the #apps browse screen (features/apps/browse.js).
// partitionApps still returns `rest` (browse and the featured row both
// need the full list), so only the RENDERER changed.

test('render: no "All Apps" section header anywhere in home.js', () => {
  assert.doesNotMatch(HOME_SRC, /All Apps</,
    'the All Apps section moved to the #apps browse screen');
});

test('render: the grid places the yours partition, never rest', () => {
  const render = HOME_SRC.slice(
    HOME_SRC.indexOf('\n  render() {'),
    HOME_SRC.indexOf('\n  appView(app) {')
  );
  assert.ok(render.length > 200, 'located render()');
  assert.match(render, /const \{ yours \} = Home\.partitionApps\(apps\)/);
  assert.doesNotMatch(render, /rest\.map\(/, 'no All Apps grid on home');
  // Search is scoped to the personal list; browse.js owns search-all.
  assert.match(render, /Home\.filterApps\(yours, query\)/);
  // The un-queried view no longer MAPS the partition into cards directly —
  // it renders the LAYOUT, and the partition feeds that (presentIds /
  // currentLayout) instead. Placing from the layout is what allows holes.
  assert.match(render, /HomeLayout\.canvasItems\(layout\)/);
  assert.match(HOME_SRC, /presentIds\(\) \{[\s\S]*?Home\.partitionApps/);
});

test('render: an empty home is the widgets, not an empty-state hero', () => {
  // The old "You haven't added any apps yet — pick one below" line is gone
  // with the sections it pointed at: with Discover and Create sitting in the
  // grid, an empty home already shows you what to do next.
  assert.doesNotMatch(HOME_SRC, /You haven&rsquo;t added any apps yet/);
  // The centered #empty-state block (and its permissions helper) stays gone.
  assert.doesNotMatch(HOME_SRC, /applyEmptyStateForPermissions/);
  assert.doesNotMatch(HOME_SRC, /getElementById\('empty-state'\)/);
});

// ── The newest app you created is pinned first ────────────────────
//
// After a create, the app you just made should be the first tile you
// see rather than buried by the server's 7-day-activity ordering (a
// brand-new app has no activity at all, so it sorts last). Exactly ONE
// row is hoisted: the most recently created app whose `created_by` is
// you. Everything else keeps the order it already had.
//
// This reorders the `yours` array, which feeds Home.presentIds →
// HomeLayout.deriveDefault — i.e. the DERIVED default grid. A user who
// has dragged their grid has a stored arrangement that wins in
// Home.currentLayout, and we deliberately do not shove their tiles
// around; their new app still lands in the first free cell via
// HomeLayout.repair.

test('partitionApps: my newest app is hoisted to the front of "Your apps"', () => {
  const Home = makeHome();
  const old = app({
    slug: 'old-mine', is_collaborator: true,
    created_by: 1, created_at: '2026-01-01T00:00:00Z',
  });
  const fresh = app({
    slug: 'fresh-mine', is_collaborator: true,
    created_by: 1, created_at: '2026-08-25T00:00:00Z',
  });
  const theirs = app({
    slug: 'theirs', is_collaborator: true,
    created_by: 2, created_at: '2026-08-26T00:00:00Z',
  });
  const { yours } = Home.partitionApps([old, theirs, fresh]);
  assert.deepEqual(
    yours.map((a) => a.slug),
    ['fresh-mine', 'old-mine', 'theirs'],
    'newest of mine first; the rest keep their relative order'
  );
});

test('partitionApps: only one row is hoisted, and it beats an explicit favorite_order', () => {
  const Home = makeHome();
  const pinned = app({
    slug: 'hand-pinned', is_favorited: true, favorite_order: 0,
    created_by: 2, created_at: '2026-01-01T00:00:00Z',
  });
  const mineOld = app({
    slug: 'mine-old', is_collaborator: true,
    created_by: 1, created_at: '2026-02-01T00:00:00Z',
  });
  const mineNew = app({
    slug: 'mine-new', is_collaborator: true,
    created_by: 1, created_at: '2026-08-25T00:00:00Z',
  });
  const { yours } = Home.partitionApps([pinned, mineOld, mineNew]);
  assert.deepEqual(
    yours.map((a) => a.slug),
    ['mine-new', 'hand-pinned', 'mine-old'],
    'exactly one hoist; the favorite_order run stays intact below it'
  );
});

test('partitionApps: nothing is hoisted when you own none of them', () => {
  const Home = makeHome();
  const a1 = app({ slug: 'a1', is_collaborator: true, created_by: 2, created_at: '2026-01-01T00:00:00Z' });
  const a2 = app({ slug: 'a2', is_collaborator: true, created_by: 3, created_at: '2026-08-01T00:00:00Z' });
  const { yours } = Home.partitionApps([a1, a2]);
  assert.deepEqual(yours.map((a) => a.slug), ['a1', 'a2'], 'server order untouched');
});

test('partitionApps: a signed-out viewer never hoists', () => {
  const Home = makeHome({ user: null });
  const mine = app({ slug: 'mine', is_collaborator: true, created_by: 1, created_at: '2026-08-25T00:00:00Z' });
  const other = app({ slug: 'other', is_collaborator: true, created_by: 2, created_at: '2026-01-01T00:00:00Z' });
  assert.deepEqual(
    Home.partitionApps([other, mine]).yours.map((a) => a.slug),
    ['other', 'mine'],
    'no signed-in user means no "mine" to hoist'
  );
});

test('partitionApps: a row with no created_at is not a hoist candidate', () => {
  const Home = makeHome();
  const other = app({ slug: 'other', is_collaborator: true, created_by: 2, created_at: '2026-01-01T00:00:00Z' });
  const undated = app({ slug: 'undated', is_collaborator: true, created_by: 1, created_at: null });
  assert.deepEqual(
    Home.partitionApps([other, undated]).yours.map((a) => a.slug),
    ['other', 'undated']
  );
  // Sanity: the same Home DOES hoist once the date is present, so the
  // assertion above is about the missing date and not a dead code path.
  const dated = app({ slug: 'dated', is_collaborator: true, created_by: 1, created_at: '2026-08-25T00:00:00Z' });
  assert.equal(Home.partitionApps([other, dated]).yours[0].slug, 'dated');
});

// ── The desktop strip's pinned part (#4935) ───────────────────────
//
// "Pinned" on the strip is the TOP ROW of My apps, in reading order, as
// the viewer arranged it on Home. Home names it to the nav bridge on
// every grid paint (topRowApps → UsernodeReact.nav.setPinnedApps); the
// strip's store and the drawing live in the nav feature and are pinned
// by tests/nav-tab-bar.test.js and tests/pinned-apps-store.test.js.

// A layout, as HomeLayout.toWire / a stored _layouts entry writes it.
const cell = (slug, col, row) => ({ type: 'app', slug, col, row });

test('topRowApps: row 0 only, in reading order, holes skipped', () => {
  const Home = makeHome();
  Home._apps = [
    app({ slug: 'left', name: 'Left', icon_url: 'https://sv.test/l.png', is_favorited: true }),
    app({ slug: 'right', name: 'Right', icon_emoji: '🎲', is_favorited: true }),
  ];
  // A hole at col 1, an app on row 1 (a second-row tile must never lead),
  // and a widget cell the overhaul no longer places but the model still
  // tolerates.
  const layout = [
    cell('left', 0, 0),
    { type: 'widget', widget: 'challenges', col: 1, row: 0 },
    cell('right', 2, 0),
    cell('left', 0, 1),
  ];
  const tops = Home.topRowApps(layout);
  // Spread before asserting: topRowApps returns a vm-realm array, whose
  // Array.prototype deepStrictEqual rejects against this file's own.
  assert.deepEqual([...tops].map((a) => a.slug), ['left', 'right'],
    'reading order left to right, the widget hole and row 1 dropped');
  assert.deepEqual(
    { ...tops[0] },
    { slug: 'left', name: 'Left', iconUrl: 'https://sv.test/l.png', iconEmoji: null },
    'display fields only: icon_url maps to iconUrl, a missing emoji is null'
  );
  assert.deepEqual(
    { ...tops[1] },
    { slug: 'right', name: 'Right', iconUrl: null, iconEmoji: '🎲' }
  );
});

test('topRowApps: a slug off My apps is dropped, demos included', () => {
  const Home = makeHome();
  // 'stranger' is neither a member nor a favourite; a demo tile is never
  // either, so the same guard covers it without a demo-specific check.
  Home._apps = [
    app({ slug: 'mine', is_favorited: true }),
    app({ slug: 'stranger' }),
  ];
  const tops = Home.topRowApps([cell('stranger', 0, 0), cell('gone', 1, 0), cell('mine', 2, 0)]);
  assert.deepEqual([...tops].map((a) => a.slug), ['mine'],
    'unknown and not-yours slugs leave no hole in the strip either');
});

test('topRowApps: no layout, or nothing of yours on row 0, is an empty list', () => {
  const Home = makeHome();
  Home._apps = [app({ slug: 'mine', is_collaborator: true })];
  assert.equal(Home.topRowApps(null).length, 0, 'null layout');
  assert.equal(Home.topRowApps([]).length, 0, 'empty layout');
  assert.equal(Home.topRowApps([cell('mine', 0, 3)]).length, 0, 'yours, but not on row 0');
});

// The publish side: a render of the GRID branch hands the top row to the
// nav bridge once; a search render (and, by the same branch, the offline
// and error states that share its shape) publishes nothing. The sandbox is
// the render-capable one from home-create-tile.test.js, with a recording
// bridge where the nav island would be.

function makePublishingHome() {
  const pins = [];
  const sandbox = {
    console,
    App: { user: { id: 1, canCreateApps: true } },
    PlatformUI: { toast: () => {} },
    innerWidth: 1280,
    document: {
      createElement: () => ({ style: {}, textContent: '', innerHTML: '' }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    location: { search: '', origin: 'https://sv.test' },
    URL,
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    UsernodeReact: {
      nav: {
        setPinnedApps: (apps) => { pins.push(JSON.parse(JSON.stringify(apps))); },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  installAppCard(sandbox);
  installGridStore(sandbox);
  sandbox.HomePanels = { render: () => {}, ensureLoaded: () => Promise.resolve() };
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, pins };
}

test('a grid render publishes the top row to the nav bridge once (#4935)', () => {
  const { Home, pins } = makePublishingHome();
  Home._apps = [
    app({ slug: 'first', name: 'First', is_favorited: true }),
    app({ slug: 'second', name: 'Second', is_collaborator: true }),
  ];
  Home._appsLoaded = true;
  Home._layouts = { 4: [cell('second', 0, 0), cell('first', 1, 0)] };
  Home.render();
  assert.equal(pins.length, 1, 'one publish per grid paint');
  assert.deepEqual(pins[0].map((a) => a.slug), ['second', 'first'],
    'the arrangement the viewer chose, reading order');
});

test('a search render publishes nothing (#4935)', () => {
  const { Home, pins } = makePublishingHome();
  Home._apps = [app({ slug: 'first', name: 'First', is_favorited: true })];
  Home._appsLoaded = true;
  Home._query = 'first';
  Home.render();
  assert.equal(pins.length, 0,
    'the search list is not the shelf: the strip keeps the last published top row');
});
