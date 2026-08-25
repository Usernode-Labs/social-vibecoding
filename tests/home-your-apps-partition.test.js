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

const { HOME_SRC } = require('./helpers/home-modules');

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
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
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
