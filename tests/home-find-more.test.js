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
const SCHEMA = read('src/db/schema.sql');
const APPS_ROUTE = read('src/routes/apps.js');

function makeHome() {
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

// ── The row hides itself when there is nothing to show ───────────

test('renderFindMore swaps the tile row for a note, never an empty card', () => {
  const src = HOME_SRC.slice(
    HOME_SRC.indexOf('renderFindMore(apps) {'),
    HOME_SRC.indexOf('renderCreateSection(canCreate) {')
  );
  assert.ok(src.length > 200, 'located renderFindMore');
  assert.match(src, /listEl\.classList\.toggle\('hidden', featured\.length === 0\)/);
  // The two toggles are complements: exactly one of the grid and the note
  // shows, so the card never collapses to a heading on top of a button.
  assert.match(src, /home-featured-empty/);
  assert.match(src, /emptyEl\.classList\.toggle\('hidden', featured\.length > 0\)/);
  // The footer is static markup and always present — it is the discovery
  // path, so it must not depend on curation existing.
  assert.match(src, /home-browse-btn/);
  assert.match(src, /location\.hash = '#apps'/);
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

test('renderFindMore renders featured tiles without opting into the menu', () => {
  const src = HOME_SRC.slice(
    HOME_SRC.indexOf('renderFindMore(apps) {'),
    HOME_SRC.indexOf('renderCreateSection(canCreate) {')
  );
  assert.match(src, /\{ mode: 'featured' \}/);
  assert.doesNotMatch(src, /menu: true/);
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

test('index.html carries the two new sections inside the home scroller', () => {
  const main = INDEX.slice(
    INDEX.indexOf('<main id="home-screen"'),
    INDEX.indexOf('<main id="browse-screen"')
  );
  assert.ok(main.includes('id="home-find-more"'));
  assert.ok(main.includes('>Featured apps<'), 'the section names itself explicitly');
  assert.doesNotMatch(main, />Find more apps</, 'the vaguer old heading is gone');
  assert.ok(main.includes('id="home-featured-list"'));
  assert.ok(main.includes('id="home-featured-empty"'));
  assert.ok(main.includes('Browse all apps'));
  assert.ok(main.includes('id="home-create-section"'));
  assert.ok(main.includes('>Create an app<'));
  assert.ok(main.includes('id="home-create-body"'));
});

test('the featured tiles + browse action are ONE contained card', () => {
  const section = INDEX.slice(
    INDEX.indexOf('<section id="home-find-more"'),
    INDEX.indexOf('<section id="home-create-section"')
  );
  const card = section.match(/<div class="home-find-more-card[^"]*"/);
  assert.ok(card, 'the card wrapper exists');
  // A rounded surface with its own border/background is what visually
  // separates this unit from the user's own grid above it.
  assert.match(card[0], /rounded-xl/);
  assert.match(card[0], /border/);
  assert.match(card[0], /bg-zinc-50\/70|bg-zinc/);
  // Tiles and footer live INSIDE that wrapper. Sliced from the wrapper
  // onward so the explanatory comment above it can't satisfy these.
  const inner = section.slice(section.indexOf('home-find-more-card'));
  for (const inside of ['home-featured-list', 'home-featured-empty', 'home-browse-btn']) {
    assert.ok(inner.includes(inside), `${inside} is inside the card`);
  }
  // The HEADING is outside it, so the section matches Your apps / Create
  // an app rather than burying its label in the card.
  assert.ok(!inner.includes('>Featured apps<'), 'the heading labels the card from outside');
  assert.ok(section.indexOf('>Featured apps<') < section.indexOf('home-find-more-card'));
});

// The width bound is on the FEED, not on each box: #home-body is a
// 1024px-max, viewport-centred column, so both trailing cards span it
// edge to edge (inside the section's own px-3 gutter) and share their
// left edge with the "Your apps" grid above. The heading stays a plain
// sibling above the card.
test('both trailing sections share the section shape, full-width in the column', () => {
  const main = INDEX.slice(
    INDEX.indexOf('<main id="home-screen"'),
    INDEX.indexOf('<main id="browse-screen"')
  );
  for (const id of ['home-find-more', 'home-create-section']) {
    const section = main.slice(main.indexOf(`<section id="${id}"`));
    const head = section.slice(0, section.indexOf('</section>'));
    assert.match(head, /class="home-section-header"/, `${id} uses the shared heading`);
    // No per-box width bound any more — that was the narrower, icon-indented
    // block this replaced. The column is the only cap.
    assert.doesNotMatch(head, /home-section-block/,
      `${id}'s box is full width inside the column, not separately bounded`);
  }
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

test('the browse action is an attached footer row of that card', () => {
  const section = INDEX.slice(
    INDEX.indexOf('<section id="home-find-more"'),
    INDEX.indexOf('<section id="home-create-section"')
  );
  const btn = section.match(/<button type="button" id="home-browse-btn"[^>]*>/);
  assert.ok(btn, 'the browse button exists');
  // Full-width row divided by a hairline — the treatment that makes it read
  // as part of the card rather than a separate pill floating below it.
  assert.match(btn[0], /w-full/);
  assert.match(btn[0], /border-t/);
  assert.doesNotMatch(btn[0], /rounded-full/, 'no longer a detached pill');
  // The card clips it so the footer's corners follow the card's radius.
  assert.match(section, /home-find-more-card[^"]*overflow-hidden/);
});

test('the create tile invites you to build your own app', () => {
  const Home = makeHome();
  const tile = Home.renderCreateTile();
  assert.match(tile, /Build your own app/);
  assert.doesNotMatch(tile, /Your app here/, 'old placeholder copy is gone');
  // The button itself is unchanged — wireCreateButtons keys off this class.
  assert.match(tile, /home-create-btn/);
  assert.match(tile, /Create new app/);
});

test('the create tile is no longer rendered inside #app-list', () => {
  const render = HOME_SRC.slice(
    HOME_SRC.indexOf('\n  render() {'),
    HOME_SRC.indexOf('\n  renderFindMore(')
  );
  assert.doesNotMatch(render, /renderCreateTile/,
    'the create tile lives in its own section now');
  // It is still rendered — just from the section renderer.
  assert.match(HOME_SRC, /host\.innerHTML = Home\.renderCreateTile\(\)/);
});

test('non-creators get the ask-an-admin hint in the create section', () => {
  const src = HOME_SRC.slice(HOME_SRC.indexOf('renderCreateSection(canCreate) {'));
  assert.match(src, /CREATE_DISABLED_HINT/);
  assert.match(HOME_SRC, /Ask an admin to enable app creation/);
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
