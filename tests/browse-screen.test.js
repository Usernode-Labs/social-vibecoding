// The #apps browse-all-apps screen (public/js/browse.js) — the directory
// half of the home-screen split.
//
// Home is "Your apps" only now, so this screen is the ONLY place the rest
// of the platform's apps are reachable from. It deliberately borrows Home's
// tile renderer ('browse' mode), added-state predicate (isYours), search
// matcher and add/remove write, so the two launcher grids can't drift; what
// it owns is the screen — its fetch, its always-visible search field, its
// ordering (featured first) and its empty states.
//
// Also pins the routing this screen needs from app.js: the #apps hash
// branch, the sibling hide-lists in every navigateTo*, and the zoom
// generalization (a tap here must not leave the browse grid painted behind
// the opened app).
//
// Run with: node --test tests/browse-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const HOME_SRC = read('public/js/home.js');
const BROWSE_SRC = read('public/js/browse.js');
const APP_SRC = read('public/js/app.js');
const INDEX = read('public/index.html');

// Load home.js + browse.js into one context (Browse leans on Home) with a
// minimal DOM: #browse-list / #browse-empty capture what render() writes.
function makeBrowse(opts = {}) {
  const nodes = {};
  const mkEl = (id) => {
    const el = {
      id,
      innerHTML: '',
      textContent: '',
      dataset: {},
      _classes: new Set(id === 'browse-empty' ? ['hidden'] : []),
      classList: {
        add: (c) => el._classes.add(c),
        remove: (c) => el._classes.delete(c),
        toggle: (c, on) => (on ? el._classes.add(c) : el._classes.delete(c)),
        contains: (c) => el._classes.has(c),
      },
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      offsetHeight: 52,
      scrollTop: 0,
      value: '',
      focus: () => {},
    };
    nodes[id] = el;
    return el;
  };
  ['browse-list', 'browse-empty', 'browse-search-input', 'browse-search-clear',
    'home-screen', 'home-search-bar', 'app-list', 'home-featured-list',
    'home-create-body'].forEach(mkEl);

  const fetchCalls = [];
  const sandbox = {
    console,
    App: { user: { id: 1 }, navigateToApp: () => {} },
    PlatformUI: { toast: () => {} },
    document: {
      getElementById: (id) => nodes[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
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
    fetch: async (url, init) => {
      fetchCalls.push({ url, method: init?.method || 'GET', body: init?.body && JSON.parse(init.body) });
      return {
        ok: opts.fetchOk !== false,
        status: opts.fetchOk === false ? 500 : 200,
        json: async () => ({ apps: opts.apps || [] }),
      };
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    requestAnimationFrame: (fn) => fn(),
    location: { search: opts.search || '', hash: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // home.js declares `const Home = {…}` at script top level, which lands
  // in the context's global LEXICAL scope (visible to browse.js, which is
  // the point) but never as a sandbox property — hence the explicit hoist.
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  vm.runInContext(BROWSE_SRC, sandbox);
  return { Browse: sandbox.Browse, Home: sandbox.__Home, nodes, fetchCalls };
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

const flush = () => new Promise((r) => setTimeout(r, 0));

// ── sortApps: featured first, then the server's activity order ────

test('sortApps: featured rows lead, ordered by featured_order', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'plain-1' }),
    app({ slug: 'feat-b', featured: true, featured_order: 1 }),
    app({ slug: 'plain-2' }),
    app({ slug: 'feat-a', featured: true, featured_order: 0 }),
  ];
  assert.deepEqual(
    Browse.sortApps(apps).map((a) => a.slug),
    ['feat-a', 'feat-b', 'plain-1', 'plain-2']
  );
});

test('sortApps: the non-featured tail keeps the server order exactly', () => {
  const { Browse } = makeBrowse();
  // /api/apps orders by activity; a stable sort must not disturb it.
  const apps = ['c', 'a', 'b'].map((slug) => app({ slug }));
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug), ['c', 'a', 'b']);
});

test('sortApps: a featured row with a NULL order still leads', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'plain' }),
    app({ slug: 'feat-null', featured: true, featured_order: null }),
  ];
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug), ['feat-null', 'plain']);
});

test('sortApps: does not mutate the input array', () => {
  const { Browse } = makeBrowse();
  const apps = [app({ slug: 'x' }), app({ slug: 'f', featured: true, featured_order: 0 })];
  Browse.sortApps(apps);
  assert.deepEqual(apps.map((a) => a.slug), ['x', 'f']);
});

// ── Search covers EVERY visible app (home's is scoped to yours) ────

test('visibleApps: filters on Home.matchesQuery over the whole list', () => {
  const { Browse } = makeBrowse();
  Browse._apps = [
    app({ slug: 'chess-1a2b', name: 'Chess Arena' }),
    app({ slug: 'puzzle-3c4d', name: 'Puzzle Chain' }),
    app({ slug: 'word-5e6f', name: 'Word Garden', is_collaborator: true }),
  ];
  Browse._query = 'chain';
  assert.deepEqual(Browse.visibleApps().map((a) => a.slug), ['puzzle-3c4d']);
  Browse._query = '5e6f';
  assert.deepEqual(Browse.visibleApps().map((a) => a.slug), ['word-5e6f'], 'slug matches');
  Browse._query = '';
  assert.equal(Browse.visibleApps().length, 3, 'no query = everything, yours included');
});

// ── render ───────────────────────────────────────────────────────

test('render: tiles carry BOTH the add badge and the "…" actions menu', () => {
  const { Browse, nodes } = makeBrowse();
  Browse._apps = [app({ slug: 'fresh' }), app({ slug: 'mine', is_favorited: true })];
  Browse.render();
  const html = nodes['browse-list'].innerHTML;
  assert.match(html, /card-add-btn/, 'the add badge stays the primary affordance');
  assert.match(html, /card-menu-btn/, 'same "…" menu the home cards have');
  // Added apps show the ✓ state, fresh ones the + state.
  assert.match(html, /data-slug="mine" data-added="true"|data-added="true"/);
  assert.match(html, /data-added="false"/);
});

test('render: the two corner controls take opposite corners', () => {
  const { Browse, nodes } = makeBrowse();
  Browse._apps = [app({ slug: 'fresh' })];
  Browse.render();
  const html = nodes['browse-list'].innerHTML;
  // Add badge keeps top-right (primary); the menu moves to top-left so
  // they can't overlap on a 56px tile. The fork tag owns bottom-left.
  const add = html.match(/class="card-add-btn[^"]*"/)[0];
  const menu = html.match(/class="card-menu-btn[^"]*"/)[0];
  assert.match(add, /-top-1\.5 -right-1\.5/);
  assert.match(menu, /-top-1\.5 -left-1\.5/);
});

test('render: staging demo tiles get NO menu (their slugs have no DB row)', () => {
  const { Browse, nodes } = makeBrowse();
  Browse._apps = [app({ slug: 'staging-demo-featured', demo: true })];
  Browse.render();
  const html = nodes['browse-list'].innerHTML;
  assert.doesNotMatch(html, /card-menu-btn/, 'every action would 404');
  assert.match(html, /card-add-btn/, 'the (inert) add badge still renders');
});

test('the menu button routes to Home.openCardMenu with the button as anchor', () => {
  // Wired by the shared discovery-card wiring, not a reimplementation:
  // openCardMenu resolves the app from Home._apps (which Browse keeps in
  // step) and PlatformUI.menu picks the touch/desktop idiom.
  const wiring = HOME_SRC.slice(
    HOME_SRC.indexOf('_wireDiscoveryCards(listEl, onChange)'),
    HOME_SRC.indexOf('async toggleAdded(')
  );
  assert.ok(wiring.length > 200, 'located _wireDiscoveryCards');
  assert.match(wiring, /querySelectorAll\('\.card-menu-btn'\)/);
  assert.match(wiring, /Home\.openCardMenu\(btn\.dataset\.slug, btn\)/);
  assert.match(wiring, /e\.stopPropagation\(\)/);
  // A tap on either corner control must not also open the app.
  assert.match(wiring, /closest\('\.card-add-btn'\) \|\| e\.target\.closest\('\.card-menu-btn'\)/);
});

test('a re-render dismisses a menu anchored to a button it is replacing', () => {
  const src = BROWSE_SRC.slice(BROWSE_SRC.indexOf('render() {'));
  assert.match(src, /Home\.closeCardMenu\(\)/,
    'otherwise the popover hangs anchored to a detached node');
});

test('syncFrom adopts an externally-fetched payload and repaints', () => {
  // Home.load() is where every card-menu action settles (add/remove,
  // retry, lock, delete), so this is how those land on the browse grid.
  const { Browse, nodes } = makeBrowse();
  Browse._apps = [app({ slug: 'before' })];
  Browse.render();
  assert.match(nodes['browse-list'].innerHTML, /data-slug="before"/);
  Browse.syncFrom([app({ slug: 'after' })]);
  assert.match(nodes['browse-list'].innerHTML, /data-slug="after"/);
  assert.doesNotMatch(nodes['browse-list'].innerHTML, /data-slug="before"/);
  Browse.syncFrom(undefined);
  assert.match(nodes['browse-list'].innerHTML, /data-slug="after"/, 'garbage is ignored');
});

test('Home.load hands its fresh payload to an open browse screen', () => {
  const load = HOME_SRC.slice(
    HOME_SRC.indexOf('async load() {'),
    HOME_SRC.indexOf('// ===== Rendering')
  );
  assert.ok(load.length > 200, 'located Home.load');
  assert.match(load, /window\.Browse\?\.isOpen\?\.\(\) \) *\?|window\.Browse\?\.isOpen\?\.\(\)/);
  assert.match(load, /Browse\.syncFrom\(apps\)/);
});

test('?shot=card-menu opens the menu on whichever grid is visible', () => {
  // The captures can't click, so the OPEN menu needs a URL. The helper is
  // shared with home's grid; the offsetParent guard is what stops a hidden
  // #app-list from burning the once-only flag during boot on /#apps.
  const helper = HOME_SRC.slice(
    HOME_SRC.indexOf('_maybeOpenShotMenu(listEl) {'),
    HOME_SRC.indexOf('_assertMenuOpaque()')
  );
  assert.ok(helper.length > 200, 'located _maybeOpenShotMenu');
  assert.match(helper, /listEl\.offsetParent === null\) return/);
  // The flag is claimed only AFTER the visibility check.
  assert.ok(
    helper.indexOf('offsetParent === null') < helper.indexOf('_shotMenuDone = true'),
    'visibility check precedes the once-only claim'
  );
  assert.match(BROWSE_SRC, /Home\._maybeOpenShotMenu\(listEl\)/);
});

test('render: empty result explains itself, with the query when there is one', () => {
  const { Browse, nodes } = makeBrowse();
  Browse._apps = [app({ slug: 'chess', name: 'Chess' })];
  Browse._query = 'nothing-matches';
  Browse.render();
  assert.equal(nodes['browse-empty'].classList.contains('hidden'), false);
  assert.match(nodes['browse-empty'].textContent, /No apps match/);
  Browse._query = '';
  Browse.render();
  assert.equal(nodes['browse-empty'].classList.contains('hidden'), true,
    'a populated grid hides the empty note');
});

// ── Data flow ────────────────────────────────────────────────────

test('_load fetches /api/apps and shares the payload with Home', async () => {
  const rows = [app({ slug: 'a' }), app({ slug: 'b' })];
  const { Browse, Home, fetchCalls } = makeBrowse({ apps: rows });
  await Browse._load();
  assert.deepEqual(fetchCalls.map((c) => c.url), ['/api/apps']);
  assert.deepEqual(Browse._apps.map((a) => a.slug), ['a', 'b']);
  assert.deepEqual(Home._apps.map((a) => a.slug), ['a', 'b'],
    'returning home shows adds made here');
});

test('_load forwards ?demo=1 so staging demo tiles show up here too', async () => {
  const { Browse, fetchCalls } = makeBrowse({ search: '?demo=1' });
  await Browse._load();
  assert.deepEqual(fetchCalls.map((c) => c.url), ['/api/apps?demo=1']);
});

test('_load failure renders an inline error, never throws', async () => {
  const { Browse, nodes } = makeBrowse({ fetchOk: false });
  await Browse._load();
  assert.match(nodes['browse-list'].innerHTML, /Failed to load apps/);
});

test('open seeds first paint from Home._apps, then refetches', async () => {
  const { Browse, Home, nodes, fetchCalls } = makeBrowse({ apps: [] });
  Home._apps = [app({ slug: 'cached', name: 'Cached App' })];
  Browse.open();
  assert.match(nodes['browse-list'].innerHTML, /data-slug="cached"/,
    'instant paint from the home cache');
  await flush();
  assert.equal(fetchCalls.length, 1, 'still reconciles with the server');
  assert.equal(Browse.isOpen(), true);
  Browse.close();
  assert.equal(Browse.isOpen(), false);
});

// ── Add / remove writes (Home.toggleAdded, shared with the featured row) ──

test('toggleAdded posts { favorited } and flips the cached flags', async () => {
  const { Browse, Home, fetchCalls } = makeBrowse();
  const fresh = app({ slug: 'fresh' });
  Home._apps = [fresh];
  Browse._apps = [fresh];
  await Home.toggleAdded('fresh', true, () => {});
  assert.equal(fresh.is_favorited, true);
  assert.deepEqual(fetchCalls[0], {
    url: '/api/apps/fresh/favorite', method: 'POST', body: { favorited: true },
  });
});

test('toggleAdded on a member app writes the hidden opt-out, not a delete (#618)', async () => {
  const { Home } = makeBrowse();
  const member = app({ slug: 'mine', is_collaborator: true });
  Home._apps = [member];
  await Home.toggleAdded('mine', false, () => {});
  assert.equal(member.is_favorited, false);
  assert.equal(member.your_apps_hidden, true,
    'membership and access are untouched — display only');
});

test('toggleAdded reverts the optimistic flip when the write fails', async () => {
  const { Home, nodes } = makeBrowse({ fetchOk: false });
  const fresh = app({ slug: 'fresh' });
  Home._apps = [fresh];
  let reloaded = 0;
  Home.load = async () => { reloaded += 1; };
  await Home.toggleAdded('fresh', true, () => {});
  assert.equal(fresh.is_favorited, false, 'reverted');
  assert.equal(reloaded, 1, 'and re-synced with server truth');
  assert.ok(nodes);
});

test('toggleAdded ignores staging demo tiles (their slugs have no DB row)', async () => {
  const { Home, fetchCalls } = makeBrowse();
  Home._apps = [app({ slug: 'staging-demo-featured', demo: true })];
  await Home.toggleAdded('staging-demo-featured', true, () => {});
  assert.equal(fetchCalls.length, 0, 'a POST would 404');
});

// ── index.html shell ─────────────────────────────────────────────

test('index.html hosts #browse-screen with its own search field and grid', () => {
  assert.match(INDEX, /<main id="browse-screen" class="hidden flex-1 overflow-y-auto"/);
  const main = INDEX.slice(
    INDEX.indexOf('<main id="browse-screen"'),
    INDEX.indexOf('</main>', INDEX.indexOf('<main id="browse-screen"'))
  );
  assert.ok(main.includes('id="browse-search-input"'));
  assert.ok(main.includes('id="browse-list"'));
  assert.ok(main.includes('id="browse-empty"'));
  // Always visible here — the hidden-until-pulled treatment is home's.
  assert.match(main, /id="browse-search-bar"[^>]*sticky/);
});

test('browse.js is loaded after home.js and precached by the service worker', () => {
  const homeAt = INDEX.indexOf('/js/home.js');
  const browseAt = INDEX.indexOf('/js/browse.js');
  assert.ok(homeAt > 0 && browseAt > homeAt, 'Browse depends on Home');
  assert.match(read('public/sw.js'), /'\/js\/browse\.js'/);
});

// ── app.js routing ───────────────────────────────────────────────

test('#apps routes to navigateToBrowse', () => {
  assert.match(APP_SRC, /parts\[0\] === 'apps'/);
  const branch = APP_SRC.slice(APP_SRC.indexOf("parts[0] === 'apps'"));
  assert.match(branch.slice(0, 400), /App\.navigateToBrowse\(\)/);
});

test('navigateToBrowse / _exitBrowse follow the screen pattern', () => {
  assert.match(APP_SRC, /navigateToBrowse\(\) \{/);
  assert.match(APP_SRC, /_exitBrowse\(\) \{/);
  const nav = APP_SRC.slice(
    APP_SRC.indexOf('navigateToBrowse() {'),
    APP_SRC.indexOf('_exitBrowse() {')
  );
  assert.match(nav, /setHeaderTitle\('All apps'\)/);
  assert.match(nav, /App\._inBrowse = true/);
  assert.match(nav, /Browse\.open\(\)/);
  assert.match(nav, /getElementById\('home-screen'\)\.classList\.add\('hidden'\)/);
});

test('every sibling screen hides #browse-screen and exits the flag', () => {
  for (const fn of ['navigateToProfile', 'navigateToAdminConsole', 'navigateToSettings',
    'navigateToLeaderboard']) {
    // Anchor on the DEFINITION (two-space indent), not the many comment
    // references to these names earlier in the file.
    const start = APP_SRC.indexOf(`\n  ${fn}(`);
    assert.ok(start > 0, `${fn} exists`);
    const body = APP_SRC.slice(start, start + 2600);
    assert.match(body, /App\._inBrowse\) App\._exitBrowse\(\)/, `${fn} exits browse`);
    assert.match(body, /getElementById\('browse-screen'\)/, `${fn} hides browse-screen`);
  }
  // navigateHome must exit it too, or the grid stays mounted.
  const home = APP_SRC.slice(APP_SRC.indexOf('navigateHome() {'));
  assert.match(home.slice(0, 1200), /App\._inBrowse\) App\._exitBrowse\(\)/);
  // Bare "/" with the browse screen up resolves back home.
  assert.match(APP_SRC, /else if \(App\._inBrowse\) App\.navigateHome\(\);/);
});

test('the app-view zoom departs from whichever grid was tapped', () => {
  // Hard-coding #home-screen here left the browse grid painted behind the
  // opened app.
  assert.match(APP_SRC, /_departingScreen\(\) \{/);
  assert.match(APP_SRC, /App\._inBrowse \? 'browse-screen' : 'home-screen'/);
  const nav = APP_SRC.slice(APP_SRC.indexOf('async navigateToApp('));
  const zoom = nav.slice(0, nav.indexOf("document.getElementById('back-btn')"));
  assert.match(zoom, /const departing = App\._departingScreen\(\)/);
  assert.match(zoom, /outEl: departing/);
  assert.match(zoom, /after: \(\) => \{ if \(departing\) departing\.classList\.add\('hidden'\); \}/);
});

test('_tileFor resolves tiles in all three authed launcher grids', () => {
  const fn = APP_SRC.slice(APP_SRC.indexOf('_tileFor(slug) {'));
  const body = fn.slice(0, fn.indexOf('_departingScreen'));
  assert.match(body, /#app-list \.app-card/);
  assert.match(body, /#home-featured-list \.app-card/);
  assert.match(body, /#browse-list \.app-card/);
  // The anonymous landing directory must stay excluded.
  assert.doesNotMatch(body, /#landing-apps/);
});

test('the browse scroller gets its own pull-to-refresh', () => {
  const fn = APP_SRC.slice(
    APP_SRC.indexOf('_wirePullToRefresh() {'),
    APP_SRC.indexOf('bindEvents() {')
  );
  assert.match(fn, /getElementById\('browse-screen'\)/);
  assert.match(fn, /pullToRefresh\(browse,/);
  // Routed through _refreshOrReload like every other screen, so a pull
  // also recovers from a platform redeploy.
  assert.match(fn, /App\._refreshOrReload\(\(\) => \(window\.Browse \? Browse\._load\(\)/);
});
