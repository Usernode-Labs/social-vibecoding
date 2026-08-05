// "Featured apps" + "Create an app" — the two sections below the home
// screen's "Your apps" grid.
//
// All three sections share one shape: a .home-section-header, then the
// content. The width bound is on the FEED, not the boxes — #home-body is
// a 1024px-max, viewport-centred .home-column — so each section's card
// spans that column's full width and lines up with the "Your apps" grid
// above it.
//
// Featured apps' content is ONE contained card: the admin-curated tiles
// (the `featured` / `featured_order` flags GET /api/apps serializes from
// the featured_apps table) plus, as an attached footer row inside the same
// card, the way into the #apps browse screen. Create an app is the former
// in-grid "Build your own app" tile, now the page's last section.
//
// Run with: node --test tests/home-find-more.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const HOME_SRC = read('public/js/home.js');
const INDEX = read('public/index.html');
const PANELS_SRC = read('public/js/home-panels.js');
const CSS = read('public/css/app.css');
const ROUTE = read('src/routes/home-panels.js');

// A HomePanels in a vm sandbox, with the Home surface its renderers call
// into stubbed — the create widget asks Home.canCreate(), the discover
// widget asks Home.featuredApps().
function makePanels({ canCreate = true, featured = [] } = {}) {
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    Home: {
      canCreate: () => canCreate,
      featuredApps: () => featured,
      isYours: () => false,
      CREATE_DISABLED_HINT: 'Ask an admin to enable app creation for your account.',
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setTimeout, clearTimeout, URLSearchParams, Date,
    location: { search: '', hash: '' },
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  return { HP: sandbox.__HP, sandbox };
}
const SCHEMA = read('src/db/schema.sql');
const APPS_ROUTE = read('src/routes/apps.js');

// `search` drives the screenshot-state deep links the module reads off
// location (?shot=create-disabled, ?shot=discover-empty).
function makeHome({ search = '' } = {}) {
  const sandbox = {
    console,
    App: { user: { id: 1, canCreateApps: true } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      // escapeHtml() round-trips through textContent → innerHTML.
      createElement: () => {
        let t = '';
        return {
          classList: { add() {} },
          dataset: {},
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
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    location: { search },
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
  status: 'running',
  is_collaborator: false,
  is_favorited: false,
  favorite_order: null,
  featured: false,
  featured_order: null,
  ...over,
});

// ── featuredApps selection ────────────────────────────────────────

test('featuredApps: only featured rows, ordered by featured_order', () => {
  const Home = makeHome();
  const apps = [
    app({ slug: 'plain' }),
    app({ slug: 'third', featured: true, featured_order: 2 }),
    app({ slug: 'first', featured: true, featured_order: 0 }),
    app({ slug: 'second', featured: true, featured_order: 1 }),
  ];
  assert.deepEqual(
    Home.featuredApps(apps).map((a) => a.slug),
    ['first', 'second', 'third']
  );
});

test('featuredApps: apps already in "Your apps" are left out', () => {
  const Home = makeHome();
  const apps = [
    app({ slug: 'member', featured: true, featured_order: 0, is_collaborator: true }),
    app({ slug: 'added', featured: true, featured_order: 1, is_favorited: true }),
    app({ slug: 'fresh', featured: true, featured_order: 2 }),
  ];
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug), ['fresh'],
    'no point re-offering what the user already keeps');
});

test('featuredApps: a hidden member app IS offered again (#618)', () => {
  const Home = makeHome();
  // your_apps_hidden means they took it OFF their home screen, so it is
  // no longer "theirs" for this purpose — isYours() is the single source.
  const apps = [app({
    slug: 'hidden', featured: true, featured_order: 0,
    is_collaborator: true, your_apps_hidden: true,
  })];
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug), ['hidden']);
});

test('featuredApps: NULL featured_order sorts after explicit ones', () => {
  const Home = makeHome();
  const apps = [
    app({ slug: 'null-order', featured: true, featured_order: null }),
    app({ slug: 'zero', featured: true, featured_order: 0 }),
  ];
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug), ['zero', 'null-order']);
});

test('featuredApps: capped at FEATURED_LIMIT', () => {
  const Home = makeHome();
  const apps = Array.from({ length: 20 }, (_, i) => app({
    slug: `f${i}`, featured: true, featured_order: i,
  }));
  assert.equal(Home.FEATURED_LIMIT, 6);
  assert.equal(Home.featuredApps(apps).length, 6);
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug),
    ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'], 'takes the top of the admin order');
});

test('featuredApps: empty / missing input is safe', () => {
  const Home = makeHome();
  assert.equal(Home.featuredApps([]).length, 0);
  assert.equal(Home.featuredApps(undefined).length, 0);
  assert.equal(Home.featuredApps([app()]).length, 0, 'nothing featured');
});

// The screenshot-state deep link for the compact "nothing featured" state
// (#949). Without it that rendering — what a viewer sees once they have
// added the featured apps — is unreachable by URL, so the before/after
// screenshots and every declared check would show the populated widget.
test('featuredApps: ?shot=discover-empty forces the empty state', () => {
  const apps = [app({ slug: 'f', featured: true, featured_order: 0 })];
  assert.equal(makeHome().featuredApps(apps).length, 1, 'normally populated');
  const shot = makeHome({ search: '?shot=discover-empty' });
  assert.equal(shot.featuredApps(apps).length, 0, 'the deep link empties it');
  // Paint-only: a DIFFERENT shot value must not touch this list.
  assert.equal(makeHome({ search: '?shot=create-disabled' }).featuredApps(apps).length, 1);
});

// ── popularApps selection (#949) ──────────────────────────────────
//
// The desktop widget's second lane: what everyone else is using, from the
// `active_users` count GET /api/apps already serves. The ranking mirrors
// Browse.sortApps' non-featured tail so the widget and the directory can't
// disagree about what is popular.

const pop = (over) => app({ active_users: 3, ...over });

test('popularApps: ranks non-featured apps by active users, most first', () => {
  const Home = makeHome();
  const apps = [
    pop({ slug: 'few', active_users: 2 }),
    pop({ slug: 'most', active_users: 11 }),
    pop({ slug: 'some', active_users: 5 }),
  ];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['most', 'some', 'few']);
});

test('popularApps: the count is coerced — the API sends it as a string', () => {
  const Home = makeHome();
  // Postgres COUNT(*) is a bigint, so the serializer hands the client "9",
  // not 9. A lexicographic sort would rank "9" above "10".
  const apps = [pop({ slug: 'nine', active_users: '9' }), pop({ slug: 'ten', active_users: '10' })];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['ten', 'nine']);
  assert.deepEqual(Home.popularApps([pop({ slug: 'n', active_users: 4 })]).map((a) => a.slug),
    ['n'], 'and a real number works too');
});

test('popularApps: ties keep the order the server returned', () => {
  const Home = makeHome();
  const apps = ['a', 'b', 'c'].map((slug) => pop({ slug, active_users: 4 }));
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['a', 'b', 'c']);
});

test('popularApps: excludes featured, yours, errored, self-hosted and unused apps', () => {
  const Home = makeHome();
  const apps = [
    pop({ slug: 'keep', active_users: 9 }),
    pop({ slug: 'featured', featured: true, active_users: 20 }),
    pop({ slug: 'mine', is_favorited: true, active_users: 20 }),
    pop({ slug: 'broken', status: 'error', active_users: 20 }),
    pop({ slug: 'platform', self_hosted: true, active_users: 20 }),
    pop({ slug: 'unused', active_users: 0 }),
    pop({ slug: 'never-counted', active_users: null }),
  ];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['keep']);
});

test('popularApps: capped at POPULAR_LIMIT; empty / missing input is safe', () => {
  const Home = makeHome();
  assert.equal(Home.POPULAR_LIMIT, 6);
  const many = Array.from({ length: 20 }, (_, i) => pop({
    slug: `p${i}`, active_users: 100 - i,
  }));
  assert.deepEqual(Home.popularApps(many).map((a) => a.slug),
    ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], 'the six most-used');
  assert.equal(Home.popularApps([]).length, 0);
  assert.equal(Home.popularApps(undefined).length, 0);
});

// ── The row hides itself when there is nothing to show ───────────

test('the Discover widget swaps its tile row for a note, never an empty box', () => {
  const src = PANELS_SRC.slice(
    PANELS_SRC.indexOf('renderDiscoverPanel(panel) {'),
    PANELS_SRC.indexOf('renderDiscoverTile(app) {'));
  assert.ok(src.length > 200, 'located renderDiscoverPanel');
  // Tiles OR a one-line note — never a bare bar over an empty lane.
  assert.match(src, /featured\.length/);
  assert.match(src, /Nothing featured right now/);
  // The browse control always renders: it is THE discovery path, so it must
  // not depend on curation existing. It lives in the title bar now (#949),
  // not in a footer — see the block test below.
  assert.match(src, /home-browse-btn/);
  assert.match(src, /Browse all apps/);
  // ...and the widget derives its tiles from the SAME per-viewer flags the
  // old row did, rather than issuing a second query.
  assert.match(src, /Home\.featuredApps\(/);
});

// ── Card mode: discovery tiles carry an add badge, not a "…" menu ──

test('renderAppCard: discovery mode leads with the add badge', () => {
  const Home = makeHome();
  const fresh = app({ slug: 'fresh', name: 'Fresh App' });
  const html = Home.renderAppCard(fresh, { mode: 'featured' });
  assert.match(html, /card-add-btn/);
  assert.match(html, /data-added="false"/);
  // The "…" menu is opt-in per grid (`opts.menu`). The browse screen sets
  // it; the home featured row currently doesn't, so a featured tile keeps
  // the single-badge look.
  assert.doesNotMatch(html, /card-menu-btn/, 'featured row is badge-only');
  const withMenu = Home.renderAppCard(fresh, { mode: 'browse', menu: true });
  assert.match(withMenu, /card-menu-btn/, 'browse opts in');
});

test('Discover tiles are the compact treatment, wired like the old row', () => {
  const src = PANELS_SRC.slice(
    PANELS_SRC.indexOf('renderDiscoverTile(app) {'),
    PANELS_SRC.indexOf('renderCreatePanel(panel) {'));
  // The block is ~366px wide on a phone across six tracks — a 56px launcher
  // card does not fit, so the widget uses the 40px widget-strip tile. The
  // size lives in CSS now (#949): the icon fills its track up to that same
  // 40px, because the narrowest 5-column lane gives it only ~32px and a
  // fixed box there would overflow and be clipped.
  assert.match(src, /class="app-icon-tile home-discover-icon/);
  assert.doesNotMatch(src, /w-14 h-14/);
  // The cap sits on the wrapper, whose width is definite; see the sizing
  // note in app.css and the budget test in home-panels-render.test.js.
  assert.match(CSS, /\.home-discover-icon-wrap \{[^}]*max-width: 2\.5rem/);
  // It still carries .app-card + data-slug, which is what lets it reuse
  // Home._wireDiscoveryCards wholesale (tap opens, badge toggles) so the
  // widget cannot drift from the row it replaced.
  assert.match(src, /class="app-card home-discover-tile/);
  assert.match(src, /card-add-btn/);
  assert.match(PANELS_SRC, /Home\._wireDiscoveryCards\(tiles\)/);
});

test('renderAppCard: an already-added app renders the ✓ state', () => {
  const Home = makeHome();
  const added = app({ slug: 'mine', is_favorited: true });
  const html = Home.renderAppCard(added, { mode: 'browse' });
  assert.match(html, /data-added="true"/);
  assert.match(html, /Remove mine from Your apps|Remove Some App from Your apps/);
});

test('renderAppCard: home mode is unchanged (default, menu badge)', () => {
  const Home = makeHome();
  const html = Home.renderAppCard(app({ slug: 'mine', is_collaborator: true }));
  assert.match(html, /card-menu-btn/);
  assert.doesNotMatch(html, /card-add-btn/);
});

// ── index.html section shells ────────────────────────────────────

test('index.html retires the two trailing sections for in-grid widgets', () => {
  // Both are widgets now — placeable anywhere in the grid rather than
  // pinned below everything — so their section shells are gone.
  for (const id of ['home-find-more', 'home-create-section',
    'home-featured-list', 'home-featured-empty', 'home-create-body']) {
    assert.equal(INDEX.indexOf(`id="${id}"`), -1, `#${id} should be gone`);
  }
  // The grid and the fallback widget host remain, in that order.
  const grid = INDEX.indexOf('id="app-list"');
  const panels = INDEX.indexOf('id="home-panels"');
  assert.ok(grid > 0 && panels > grid);
  // And the iOS widget-editing strip moved ABOVE the grid: a full-width
  // flow item cannot coexist with explicit cell placement.
  const strip = INDEX.indexOf('id="home-widget-strip-section"');
  assert.ok(strip > 0 && strip < grid);
});

test('Discover is one bordered block: lanes under a bar that carries the browse link', () => {
  // Same shell as every other widget, so the three read as one family and
  // the drag handle is in the same place — but Discover passes NO footer
  // (#949). A .home-panel-footer is 27px, which on a phone is the whole
  // difference between a tile lane that fits its one cell and one that
  // clips.
  assert.match(PANELS_SRC,
    /renderDiscoverPanel\(panel\) \{[\s\S]*?_panelShell\(panel\.key, titleHtml, featuredHtml \+ popularHtml, null,/);
  const src = PANELS_SRC.slice(
    PANELS_SRC.indexOf('renderDiscoverPanel(panel) {'),
    PANELS_SRC.indexOf('renderDiscoverTile(app) {'));
  assert.doesNotMatch(src, /home-panel-footer/, 'no footer of its own');
  // The browse control rides in the TITLE BAR instead, and it is still the
  // same #home-browse-btn the old footer carried.
  assert.match(src, /titleHtml = `[\s\S]*?id="home-browse-btn"[\s\S]*?`;/);
  assert.match(src, /home-panel-browse/);
  // The second lane is separated by a hairline, so it reads as part of the
  // same block rather than a second card.
  assert.match(src, /home-discover-divider[^`]*border-t/);
});

// The width bound is on the FEED, not on each box: #home-body is a
// 1024px-max, viewport-centred column, so both trailing cards span it
// edge to edge (inside the section's own px-3 gutter) and share their
// left edge with the "Your apps" grid above. The heading stays a plain
// sibling above the card.
test('every widget is one bordered block, sized by the cells it occupies', () => {
  // The widget's box fills whatever rectangle the layout gave it, rather
  // than sitting at its natural height in the top-left of a 2x2 block.
  assert.match(CSS, /\.home-panel-slot \{[^}]*display: flex/);
  assert.match(CSS, /\.home-panel-slot > \.home-panel,[\s\S]*?width: 100%/);
  // Footprints come from the server registry, per column count.
  assert.match(ROUTE, /sizes: \{ 4: \[4, 2\], 5: \[2, 2\] \}/);   // challenges
  // Discover is ASYMMETRIC (#949): one row on a phone where it is full
  // width, its original two on desktop where the second is the Popular lane.
  assert.match(ROUTE, /sizes: \{ 4: \[4, 1\], 5: \[2, 2\] \}/);
  assert.match(ROUTE, /sizes: \{ 4: \[1, 1\], 5: \[1, 1\] \}/);   // create
});

// Short feed on a tall screen: the trailing sections sit at the BOTTOM of
// the visible page instead of hugging the "Your apps" grid. Pure CSS —
// #home-body is a min-height:100% flex column and the first trailing
// section carries margin-top:auto, which also means a feed taller than the
// viewport has no free space to absorb and the sections flow normally right
// below the grid (no gap, no clipping, no measurement, no media query).
test('the feed column survives the sections it used to bottom-anchor', () => {
  // .home-body-fill still guarantees the scroller can be pulled by at least
  // the hidden search bar's height — that is why it outlives the two
  // anchored sections it was introduced alongside.
  assert.match(CSS, /\.home-body-fill \{[^}]*min-height: 100%/);
  assert.match(INDEX, /id="home-body" class="home-column home-body-fill"/);
  // Nothing is bottom-anchored any more: the grid is the whole feed. Matched
  // as a class ATTRIBUTE, so the comment explaining why it went doesn't
  // count as a use.
  assert.doesNotMatch(INDEX, /class="[^"]*home-bottom-anchor/);
  assert.doesNotMatch(CSS, /^\.home-bottom-anchor \{/m);
});

// The column itself: 1024px max, centred, and applied BOTH to the content
// body and to the search bar's inner content — the bar's own background
// stays full-bleed, so only its content is capped.
test('the home feed is a 1024px centred column', () => {
  const body = INDEX.match(/<div id="home-body"[^>]*>/)[0];
  assert.match(body, /class="[^"]*\bhome-column\b/, '#home-body is the column');

  const main = INDEX.slice(
    INDEX.indexOf('<main id="home-screen"'),
    INDEX.indexOf('<main id="browse-screen"')
  );
  const bar = main.slice(main.indexOf('id="home-search-bar"'), main.indexOf('id="home-body"'));
  assert.match(bar, /home-column/, "the search bar's content sits in the same column");
  // The gutter moved onto that inner column so its content edges match
  // #home-body's; the bar element itself must stay full-bleed for its bg.
  assert.match(bar, /home-column[^"]*px-3/, 'the gutter is on the inner column');
  assert.doesNotMatch(INDEX.match(/<div id="home-search-bar"[^>]*>/)[0], /px-3/);

  const css = read('public/css/app.css');
  const rule = css.match(/\.home-column \{[^}]*\}/)[0];
  assert.match(rule, /max-width:\s*64rem/, '64rem = 1024px');
  assert.match(rule, /margin-left:\s*auto/);
  assert.match(rule, /margin-right:\s*auto/);
  // The old per-box bound is gone for good.
  assert.doesNotMatch(css, /\.home-section-block\b/);
  assert.doesNotMatch(HOME_SRC, /alignSections|--home-section-indent/,
    'the measured icon indent went away with the centred column');
});

test('the browse action routes through the hash for a real history entry', () => {
  // The OS/browser back gesture has to return to home, so this navigates by
  // hash rather than calling the router directly.
  assert.match(PANELS_SRC, /home-panel-browse[\s\S]*?location\.hash = '#apps'/);
  // ...and it is reachable from the widget's ⋮ menu too.
  assert.match(PANELS_SRC, /label: 'Browse all apps'/);
});

test('the create widget renders in both states, and only one is tappable', () => {
  const { HP, sandbox } = makePanels();

  sandbox.Home.canCreate = () => true;
  const on = HP.renderCreatePanel({ key: 'create' });
  assert.match(on, /data-create-enabled="true"/);
  assert.match(on, /home-create-btn/, 'wireCreateButtons keys off this class');
  assert.match(on, /Create app/);
  assert.doesNotMatch(on, /aria-disabled/);

  sandbox.Home.canCreate = () => false;
  const off = HP.renderCreatePanel({ key: 'create' });
  // Still a real widget in a real cell — dimmed, not absent.
  assert.ok(off.length > 100, 'the widget renders for a viewer with no quota');
  assert.match(off, /data-create-enabled="false"/);
  assert.match(off, /home-create-widget--disabled/);
  assert.match(off, /aria-disabled="true"/);
  assert.match(off, /Ask an admin to enable app creation/, 'the hint is its tooltip');
  // NOT the disabled ATTRIBUTE: that swallows pointer events, which would
  // kill the explanatory toast AND the widget's own drag.
  assert.doesNotMatch(off, /<button[^>]*\sdisabled/);
});

test('the create widget IS in the grid, for every account', () => {
  // The inverse of the old assertion: it used to be banished from the grid
  // into a trailing section, and it is a first-class grid item again.
  assert.match(PANELS_SRC, /renderCreatePanel\(panel\) \{/);
  assert.match(HOME_SRC, /data-panel-slot="\$\{escapeHtml\(item\.key\)\}"/);
  // The server places it unconditionally: no viewer argument reaches the
  // registry, so app quota can never decide whether it exists.
  const registry = ROUTE.match(/const PANEL_REGISTRY = \[[\s\S]*?\n\];/)[0];
  assert.match(registry, /key: 'create'/);
  assert.doesNotMatch(registry, /canCreateApps|quota/i);
});

test('a viewer with no quota gets the hint on tap, not a dead tile', () => {
  // One constant, three surfaces: the tooltip, the toast, and the inert
  // note in the widget's ⋮ menu.
  assert.match(HOME_SRC, /CREATE_DISABLED_HINT: 'Ask an admin to enable app creation for your account\.'/);
  const wire = PANELS_SRC.match(/_wire\(section\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(wire, /createEnabled === 'true'/);
  assert.match(wire, /wireCreateButtons\(\)/, 'the enabled tile opens the create modal');
  assert.match(wire, /PlatformUI\.toast\(hint\)/, 'the disabled one explains itself');
  // The menu carries the same sentence as an inert row.
  assert.match(PANELS_SRC, /key === 'create' && window\.Home[\s\S]*?CREATE_DISABLED_HINT/);
});

// ── Server side: the featured flags this row is built from ────────

test('schema declares featured_apps with a cascading app FK', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS featured_apps/);
  const block = SCHEMA.slice(
    SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS featured_apps'),
    SCHEMA.indexOf('CREATE INDEX IF NOT EXISTS idx_featured_apps_order')
  );
  assert.match(block, /app_id\s+INTEGER PRIMARY KEY REFERENCES apps\(id\) ON DELETE CASCADE/);
  assert.match(block, /sort_order\s+INTEGER NOT NULL/);
  assert.match(block, /created_by\s+INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
  // Curation is public information — it is on every user's home screen.
  assert.doesNotMatch(block, /staging:private/);
});

test('GET /api/apps joins featured_apps and serializes both flags', () => {
  assert.match(APPS_ROUTE, /LEFT JOIN featured_apps fa ON fa\.app_id = a\.id/);
  assert.match(APPS_ROUTE, /\(fa\.app_id IS NOT NULL\) AS featured/);
  assert.match(APPS_ROUTE, /fa\.sort_order AS featured_order/);
  assert.match(APPS_ROUTE, /featured: !!a\.featured/);
  assert.match(APPS_ROUTE, /featured_order: a\.featured_order \?\? null/);
});

test('staging seeds featured rows both ways (boot seed + ?demo=1 tiles)', () => {
  // featured_apps is new, so a prod-cloned staging DB has no rows: the
  // home row, the browse ordering and the admin list would all be empty
  // in every PR preview without these.
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /async function seedStagingFeaturedApps\(pool\)/);
  assert.match(migrate, /await seedStagingFeaturedApps\(pool\)/);
  const seed = migrate.slice(
    migrate.indexOf('async function seedStagingFeaturedApps(pool)'),
    migrate.indexOf('// Per-user app-quota fixtures')
  );
  assert.match(seed, /USERNODE_ENV !== 'staging'/, 'no-op outside staging');
  assert.match(seed, /INSERT INTO featured_apps/);
  assert.match(seed, /ON CONFLICT \(app_id\) DO NOTHING/, 'idempotent across rebuilds');
  assert.match(seed, /NULL/, 'created_by never references a real user');
  // Request-time demo tiles for the ?demo=1 path.
  assert.match(APPS_ROUTE, /staging-demo-featured/);
  assert.match(APPS_ROUTE, /featured: true/);
});
