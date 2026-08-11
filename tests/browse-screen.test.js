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
      // Mostly a null stub — the detail page wires its Open / Add / action
      // rows by querying its own host and nothing here needs the elements
      // back. The ONE selector that must really resolve is the shot deep
      // link's first-real-row lookup, so answer that from the rendered
      // markup: find the first `.browse-row` div that carries no
      // data-demo attribute and hand back just its slug.
      querySelector: (sel) => {
        if (id !== 'browse-list' || !/browse-row/.test(String(sel))) return null;
        for (const tag of el.innerHTML.match(/<div class="browse-row[^>]*>/g) || []) {
          if (/data-demo="true"/.test(tag)) continue;
          const m = tag.match(/data-slug="([^"]*)"/);
          if (m) return { dataset: { slug: m[1] } };
        }
        return null;
      },
      querySelectorAll: () => ({ forEach: () => {} }),
      offsetHeight: 52,
      scrollTop: 0,
      value: '',
      focus: () => {},
    };
    nodes[id] = el;
    return el;
  };
  ['browse-list', 'browse-empty', 'browse-list-level', 'browse-detail',
    'browse-search-bar', 'browse-search-input', 'browse-search-clear',
    'home-screen', 'home-search-bar', 'app-list', 'home-featured-list',
    'home-create-body'].forEach(mkEl);
  // The chrome _syncLevel drives, recorded so the level tests can assert it.
  const chrome = { backIcon: null, title: null, transitions: [] };
  // The shot deep link aligns the URL with replaceState — record the URLs.
  const history = { calls: [], replaceState: (_a, _b, url) => history.calls.push(url) };

  const fetchCalls = [];
  const sandbox = {
    console,
    App: {
      user: opts.user || { id: 1 },
      navigateToApp: () => {},
      setBackIcon: (m) => { chrome.backIcon = m; },
      setHeaderTitle: (t) => { chrome.title = t; },
      navigateHome: () => { chrome.wentHome = (chrome.wentHome || 0) + 1; },
    },
    PlatformUI: {
      toast: () => {},
      // The kit wrapper runs fn directly when the kit is absent; do the
      // same and record the animation type the level change asked for.
      transition: (fn, o) => { chrome.transitions.push(o?.type); fn(); },
    },
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
    // Dispatches on the URL so each endpoint answers its REAL envelope —
    // notably GET /api/apps/:slug, which responds `{ app: … }` (a bare app
    // object here is what let the _fetchDetail envelope bug hide), and the
    // contributors read, which the detail page now also fires.
    fetch: async (url, init) => {
      fetchCalls.push({ url, method: init?.method || 'GET', body: init?.body && JSON.parse(init.body) });
      const ok = opts.fetchOk !== false;
      const json = async () => {
        if (/\/contributors/.test(url)) {
          const items = opts.contributors || [];
          return { slug: 'x', total: opts.contribTotal ?? items.length, contributors: items };
        }
        if (/^\/api\/apps\/[^/?]+$/.test(url)) return { app: opts.coldApp || null };
        return { apps: opts.apps || [] };
      };
      return { ok, status: ok ? 200 : 500, json };
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    history,
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
  return {
    Browse: sandbox.Browse, Home: sandbox.__Home,
    nodes, fetchCalls, chrome, history, location: sandbox.location,
  };
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

test('sortApps: the non-featured tail is ordered by users, most first', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'few', active_users: 2 }),
    app({ slug: 'many', active_users: 40 }),
    app({ slug: 'none' }),
    app({ slug: 'some', active_users: 9 }),
  ];
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug),
    ['many', 'some', 'few', 'none']);
});

test('sortApps: equal user counts fall back to the server order', () => {
  const { Browse } = makeBrowse();
  // /api/apps already ranks by activity; a stable sort must not disturb
  // that among apps the user count can't separate.
  const apps = ['c', 'a', 'b'].map((slug) => app({ slug, active_users: 5 }));
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug), ['c', 'a', 'b']);
});

test('sortApps: user count never reorders the admin-curated featured list', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'feat-second', featured: true, featured_order: 1, active_users: 99 }),
    app({ slug: 'feat-first', featured: true, featured_order: 0, active_users: 0 }),
    app({ slug: 'popular', active_users: 50 }),
  ];
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug),
    ['feat-first', 'feat-second', 'popular'],
    'curation is a choice — users must not silently override it');
});

test('sortApps: a non-numeric user count is treated as zero', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'junk', active_users: null }),
    app({ slug: 'real', active_users: 1 }),
  ];
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug), ['real', 'junk']);
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

test('renderAppRow: an app-store row — icon, name, meta, Add button', () => {
  const { Browse, nodes } = makeBrowse();
  Browse._apps = [
    app({ slug: 'fresh', name: 'Fresh App', active_users: 3 }),
    app({ slug: 'mine', name: 'My App', is_favorited: true }),
  ];
  Browse.render();
  const html = nodes['browse-list'].innerHTML;
  assert.match(html, /class="browse-row/, 'rows, not launcher tiles');
  assert.match(html, /data-slug="fresh"/);
  assert.match(html, /app-icon-tile/, 'reuses the shared icon tile');
  assert.match(html, /Fresh App/);
  assert.match(html, /3 users/, 'the derived meta line');
  assert.match(html, /browse-add-btn/);
  // Added rows read "Added", fresh ones "Add".
  assert.match(html, /data-added="true"[\s\S]*?Added/);
  assert.match(html, /data-added="false"/);
  // The "…" menu is gone from this screen — the detail page absorbed it.
  assert.doesNotMatch(html, /card-menu-btn/);
  assert.doesNotMatch(html, /card-add-btn/, 'the corner badge is a real button now');
});

test('renderAppRow: the layout switch is pure CSS on the container', () => {
  // Narrow: a hairline-divided vertical list. md+: a 2/3-column grid whose
  // rows pick up a box treatment from .browse-row in app.css. No
  // matchMedia, so nothing re-renders on resize.
  const listTag = INDEX.match(/<div id="browse-list"[^>]*>/)[0];
  assert.match(listTag, /md:grid/);
  assert.match(listTag, /md:grid-cols-2/);
  assert.match(listTag, /lg:grid-cols-3/);
  assert.doesNotMatch(BROWSE_SRC, /matchMedia\(/, 'the breakpoint is CSS, not JS');

  // NO divide-* utility on the container. Tailwind's divide-y sets
  // border-bottom-width: 0 (and md:divide-y-0 zeroes the top too) via
  // `.divide-y-0 > :not([hidden]) ~ :not([hidden])`, which is (0,3,0) and
  // beat the (0,1,0) .browse-row box rule — every desktop box but the
  // FIRST lost its top and bottom edge. Both borders live in one cascade
  // now; putting a divide utility back here reopens that bug.
  assert.doesNotMatch(listTag, /divide-/,
    'the phone hairline is .browse-row + .browse-row in app.css');

  const css = read('public/css/app.css');
  assert.match(css, /\.browse-row \+ \.browse-row \{ border-top: 1px solid/,
    'phone: a hairline between consecutive rows');
  // The md block re-states the sibling selector so the full box wins at
  // equal specificity instead of relying on source order alone.
  const mdBlock = css.slice(css.indexOf('@media (min-width: 768px)'));
  const box = mdBlock.slice(0, mdBlock.indexOf('}\n}') + 3);
  assert.match(box, /\.browse-row,\s*\n\s*\.browse-row \+ \.browse-row \{/);
  assert.match(box, /border: 1px solid var\(--browse-border\)/);
  assert.match(box, /border-radius/);
  // One theme token instead of `.dark` variants, which would out-specify
  // the sibling and hover rules.
  assert.match(css, /\.dark \.browse-row \{ --browse-border/);
});

test('renderAppRow: status pills and the status word ride the row', () => {
  const { Browse, nodes } = makeBrowse();
  Browse._apps = [app({
    slug: 'busy', status: 'awaiting_secrets', open_prs: 2, open_issues: 1,
    missingSecrets: ['API_KEY'], view_visibility: 'private',
  })];
  Browse.render();
  const html = nodes['browse-list'].innerHTML;
  assert.match(html, /Awaiting secrets/, 'non-running status in the meta line');
  assert.match(html, /2 to vote/, 'reuses Home.renderAppPillsHtml');
  assert.match(html, /1 issue/);
  assert.match(html, /Private/);
});

test('metaLine: users · updated · status, pluralised, missing bits skipped', () => {
  const { Browse } = makeBrowse();
  assert.match(Browse.metaLine(app({ active_users: 1 })), /^1 user\b/);
  assert.match(Browse.metaLine(app({ active_users: 0 })), /^0 users\b/);
  const running = Browse.metaLine(app({ active_users: 4, status: 'running' }));
  assert.doesNotMatch(running, /running/, 'a healthy app needs no status word');
  assert.match(Browse.metaLine(app({ status: 'error' })), /Error/);
  assert.match(Browse.metaLine(app({ status: 'creating' })), /Spinning up/);
  // No timestamps at all still yields a usable line, and null is safe.
  assert.equal(Browse.metaLine(null), '');
  assert.match(Browse.metaLine({ status: 'running' }), /^0 users$/);
});

test('renderAppRow: staging demo rows are inert (no detail page to open)', () => {
  const { Browse, nodes } = makeBrowse();
  Browse._apps = [app({ slug: 'staging-demo-featured', demo: true })];
  Browse.render();
  const html = nodes['browse-list'].innerHTML;
  assert.match(html, /data-demo="true"/);
  assert.match(html, /cursor-default/, 'not presented as tappable');
  assert.doesNotMatch(html, /cursor-pointer/);
  assert.match(html, /browse-add-btn/, 'the (inert) Add button still renders');
});

test('syncFrom adopts an externally-fetched payload and repaints', () => {
  // Home.load() is where every detail-page action settles (add/remove,
  // retry, lock, delete), so this is how those land on this screen.
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

test('the browse rows no longer touch the home card menu at all', () => {
  assert.doesNotMatch(BROWSE_SRC, /openCardMenu/);
  assert.doesNotMatch(BROWSE_SRC, /closeCardMenu/);
  assert.doesNotMatch(BROWSE_SRC, /_maybeOpenShotMenu/);
  // ?shot=card-menu stays a HOME-only deep link.
  assert.match(HOME_SRC, /_maybeOpenShotMenu\(listEl\)/);
});

// ── Level 2: the app detail page ──────────────────────────────────

test('detailActionsFor: filters favorite + add-to-homescreen + app-details', () => {
  const { Browse, Home } = makeBrowse();
  // Stub the menu so this test pins the FILTER, not the (separately
  // tested) permission gates inside menuItemsFor.
  Home.menuItemsFor = () => ([
    { key: 'app-details', label: 'App details', run: () => {} },
    { key: 'favorite', label: 'Add to Your apps', run: () => {} },
    { key: 'add-to-homescreen', label: 'Add to Usernode widget', run: () => {} },
    { key: 'retry', label: 'Retry', run: () => {} },
    { key: 'build-log', label: 'View build log', run: () => {} },
    { key: 'check-updates', label: 'Check for updates', keepOpen: true, run: () => {} },
    { key: 'fork', label: 'Fork this app', run: () => {} },
    { key: 'lock', label: 'Lock app', run: () => {} },
    { key: 'delete', label: 'Delete app', danger: true, run: () => {} },
  ]);
  const keys = Browse.detailActionsFor(app({ slug: 'x' })).map((i) => i.key);
  // Favorite is the dedicated Add/Remove button; the widget item is
  // "Your apps" only and belongs on home; app-details IS this page, so a
  // row for it would set the hash it's already on and appear dead.
  assert.deepEqual(keys, ['retry', 'build-log', 'check-updates', 'fork', 'lock', 'delete'],
    'order preserved, only the three excluded keys dropped');
  const actions = Browse.detailActionsFor(app({ slug: 'x' }));
  assert.equal(actions.find((a) => a.key === 'delete').danger, true, 'flags survive');
  assert.equal(actions.find((a) => a.key === 'check-updates').keepOpen, true);
  assert.deepEqual([...Browse.DETAIL_EXCLUDED_KEYS],
    ['favorite', 'add-to-homescreen', 'app-details']);
  assert.equal(Browse.detailActionsFor(null).length, 0, 'null-safe');
});

test('detailActionsFor: derives from Home.menuItemsFor, never re-derived', () => {
  // The whole point: one place owns the permission gates, so a new menu
  // item appears here for free unless it is explicitly excluded.
  const src = BROWSE_SRC.slice(BROWSE_SRC.indexOf('detailActionsFor(app) {'));
  assert.match(src.slice(0, 400), /Home\.menuItemsFor\(app\)/);
  // No re-implemented gating in this file.
  assert.doesNotMatch(BROWSE_SRC, /canAdminWrite/);
  assert.doesNotMatch(BROWSE_SRC, /is_collaborator/);
});

test('the detail page renders Open, Add/Remove and the action rows', () => {
  const { Browse, Home, nodes } = makeBrowse();
  Home.menuItemsFor = () => ([
    { key: 'favorite', label: 'Add to Your apps', run: () => {} },
    { key: 'fork', label: 'Fork this app', run: () => {} },
    { key: 'delete', label: 'Delete app', danger: true, run: () => {} },
  ]);
  Browse._apps = [app({ slug: 'detail-me', name: 'Detail Me', status: 'running' })];
  Browse.showDetail('detail-me');
  const html = nodes['browse-detail'].innerHTML;
  assert.match(html, /Detail Me/, 'full untruncated name');
  assert.match(html, /detail-me/, 'the slug');
  assert.match(html, /id="browse-detail-open"[\s\S]*?Open/, 'Open is the primary action');
  assert.match(html, /id="browse-detail-fav"/);
  assert.match(html, /Add to Your apps/);
  assert.match(html, /browse-detail-action[\s\S]*?Fork this app/);
  assert.match(html, /Delete app/);
  assert.match(html, /text-red-500/, 'the danger row is tinted');
  // Favorite is NOT duplicated as an action row.
  assert.equal((html.match(/browse-detail-action/g) || []).length, 2);
});

test('the detail page disables Open when the app cannot be opened', () => {
  const { Browse, Home, nodes } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'broken', status: 'error' })];
  Browse.showDetail('broken');
  const html = nodes['browse-detail'].innerHTML;
  assert.match(html, /id="browse-detail-open"[^>]*disabled/);
  assert.match(html, /Not running/);
  // awaiting_secrets IS openable (the user goes there to fill them in).
  Browse._apps = [app({ slug: 'secrets', status: 'awaiting_secrets' })];
  Browse.showDetail('secrets');
  assert.doesNotMatch(nodes['browse-detail'].innerHTML, /disabled/);
});

test('showDetail / showList toggle both containers plus the search bar', () => {
  const { Browse, Home, nodes, chrome } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a', name: 'App A' })];

  Browse.showDetail('a');
  assert.equal(nodes['browse-detail'].classList.contains('hidden'), false);
  assert.equal(nodes['browse-list-level'].classList.contains('hidden'), true);
  assert.equal(nodes['browse-search-bar'].classList.contains('hidden'), true,
    'searching a list nobody can see is meaningless');
  assert.equal(chrome.backIcon, 'arrow', 'a drill-in borrows the back chevron');
  assert.equal(chrome.title, 'App A');

  Browse.showList();
  assert.equal(nodes['browse-detail'].classList.contains('hidden'), true);
  assert.equal(nodes['browse-list-level'].classList.contains('hidden'), false);
  assert.equal(nodes['browse-search-bar'].classList.contains('hidden'), false);
  assert.equal(chrome.backIcon, 'home');
  assert.equal(chrome.title, 'All apps');
});

test('handleBack claims the header button only on the detail level', () => {
  const { Browse, Home, location } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' })];
  assert.equal(Browse.handleBack(), false, 'on the list, back means Home');
  Browse.noteDetailOrigin('list');
  Browse.showDetail('a');
  assert.equal(Browse.handleBack(), true);
  assert.equal(location.hash, '#apps',
    'routed through the hash so the OS back gesture agrees');
});

// Back has to land where the user came IN from. A detail page opened from a
// home card's "App details" menu never showed the list, so backing out to
// it strands the user on a screen they never visited (the reported bug).
test('handleBack goes HOME when the detail page was entered from home', () => {
  const { Browse, Home, location, chrome } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' })];
  Browse.noteDetailOrigin('home');
  Browse.showDetail('a');
  assert.equal(Browse._detailOrigin, 'home');
  assert.equal(Browse.handleBack(), true, 'still claims the button');
  assert.equal(chrome.wentHome, 1, 'leaves the screen instead of showing the list');
  assert.equal(location.hash, '',
    'no #apps write — navigateHome owns the URL from here');
});

test('the origin defaults to the list for a deep link, and never leaks', () => {
  const { Browse, Home, location } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' }), app({ slug: 'b' })];
  // No note at all (a cold #apps/<slug> deep link or ?shot=browse-detail):
  // the enclosing screen is the list, which is the only answer available.
  Browse.showDetail('a');
  assert.equal(Browse._detailOrigin, 'list');
  // A home-entered page followed by a list-entered one must not stay 'home'.
  Browse.noteDetailOrigin('home');
  Browse.showDetail('a');
  assert.equal(Browse._detailOrigin, 'home');
  Browse.showList();
  Browse.showDetail('b');
  assert.equal(Browse._detailOrigin, 'list', 'the note is consumed, not sticky');
  Browse.handleBack();
  assert.equal(location.hash, '#apps');
  // Leaving the screen retires it too.
  Browse.noteDetailOrigin('home');
  Browse.close();
  assert.equal(Browse._detailOrigin, 'list');
  assert.equal(Browse._pendingOrigin, null);
});

test('a browse row tap declares the list as its origin; the home menu declares home', () => {
  // Both call sites note the origin BEFORE writing the hash — the
  // hashchange lands in a later task, so the note is always in place.
  const rows = BROWSE_SRC.slice(BROWSE_SRC.indexOf('_wireRows(listEl) {'));
  // Wide enough for the #1036 hrefFor guard block that now sits above the
  // plain-click handler as well as the handler itself.
  const tap = rows.slice(0, 1400);
  assert.match(tap, /noteDetailOrigin\('list'\)/);
  assert.ok(tap.indexOf("noteDetailOrigin('list')") < tap.indexOf('location.hash'));

  const home = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'home.js'), 'utf8'
  );
  const item = home.slice(home.indexOf("key: 'app-details'"));
  const run = item.slice(0, 400);
  assert.match(run, /Browse\?\.noteDetailOrigin\?\.\('home'\)/);
  assert.ok(run.indexOf("noteDetailOrigin?.('home')") < run.indexOf('location.hash'));
});

test('route animates a drill-in as a push and the way back as a pop', () => {
  const { Browse, Home, chrome } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' })];
  Browse.route('a');
  assert.deepEqual(chrome.transitions, ['push']);
  Browse.route(null);
  assert.deepEqual(chrome.transitions, ['push', 'pop']);
  // A repeat hash write for the level already showing must not re-animate.
  Browse.route(null);
  assert.deepEqual(chrome.transitions, ['push', 'pop']);
});

test('a cold deep link falls back to GET /api/apps/:slug', async () => {
  const { Browse, Home, nodes, fetchCalls } = makeBrowse({ apps: [] });
  Home.menuItemsFor = () => [];
  // Nothing cached — the detail level has to read the one app itself.
  Browse._slug = 'cold-app';
  Browse.render();
  assert.match(nodes['browse-detail'].innerHTML, /Loading/);
  await flush();
  await flush();
  assert.ok(fetchCalls.some((c) => c.url === '/api/apps/cold-app'),
    'fetched the single app');
});

test('a deep link to a missing app renders the not-available state', async () => {
  const { Browse, Home, nodes } = makeBrowse({ fetchOk: false });
  Home.menuItemsFor = () => [];
  Browse._slug = 'ghost';
  Browse.render();
  await flush();
  await flush();
  assert.match(nodes['browse-detail'].innerHTML, /isn&rsquo;t available|isn't available/);
  assert.match(nodes['browse-detail'].innerHTML, /Back to all apps/);
});

test('syncFrom drops to the list when the open app is deleted away', () => {
  const { Browse, Home, location } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'doomed' })];
  Browse.showDetail('doomed');
  location.hash = '#apps/doomed';
  Browse.syncFrom([app({ slug: 'survivor' })]);
  assert.equal(location.hash, '#apps', 'no page left to show');
});

test('?shot=browse-detail drills into the first real row, once', () => {
  // The captures can never click, so the detail page needs a URL that
  // doesn't hard-code a slug (seed data moves).
  const { Browse, Home, nodes, history } = makeBrowse({ search: '?shot=browse-detail' });
  Home.menuItemsFor = () => [];
  Browse._apps = [
    app({ slug: 'demo-row', demo: true }),
    app({ slug: 'real-row', name: 'Real Row' }),
  ];
  Browse.render();
  assert.equal(Browse._slug, 'real-row', 'skips the inert demo row');
  assert.match(nodes['browse-detail'].innerHTML, /Real Row/);
  // The URL is aligned with replaceState — NOT by assigning location.hash,
  // which would fire a hashchange that races the rest of boot and loses.
  assert.deepEqual(history.calls, ['?shot=browse-detail#apps/real-row']);
  assert.doesNotMatch(BROWSE_SRC, /location\.hash = `#apps\/\$\{encodeURIComponent\(row/);
  // Latched: a later re-render must not yank the user back to a detail.
  Browse.showList();
  Browse.render();
  assert.equal(Browse._slug, null);
});

test('no ?shot=browse-detail means no drill-in', () => {
  const { Browse, history } = makeBrowse();
  Browse._apps = [app({ slug: 'real-row' })];
  Browse.render();
  assert.equal(Browse._slug, null);
  assert.equal(history.calls.length, 0);
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
  // Ships hidden, and is the flex-child scroller its siblings are. Matched
  // per-class rather than as one closed string so an added utility (e.g.
  // `platform-safe-scroll`, which reserves the home-indicator strip for
  // the last row) doesn't fail this on a substring.
  const openTag = /<main id="browse-screen"[^>]*>/.exec(INDEX);
  assert.ok(openTag, '#browse-screen is missing from index.html');
  for (const cls of ['hidden', 'flex-1', 'overflow-y-auto']) {
    assert.match(openTag[0], new RegExp(`(?:class="|\\s)${cls}(?:\\s|")`),
      `#browse-screen must keep the ${cls} utility`);
  }
  const main = INDEX.slice(
    INDEX.indexOf('<main id="browse-screen"'),
    INDEX.indexOf('</main>', INDEX.indexOf('<main id="browse-screen"'))
  );
  assert.ok(main.includes('id="browse-search-input"'));
  assert.ok(main.includes('id="browse-list"'));
  assert.ok(main.includes('id="browse-empty"'));
  // Always visible here — the hidden-until-pulled treatment is home's.
  assert.match(main, /id="browse-search-bar"[^>]*sticky/);
  // Two levels in ONE <main>: the list wrapper and the detail page. Keeping
  // the detail inside this screen is what leaves _exitBrowse, the PTR
  // wiring and every sibling hide-list untouched.
  assert.ok(main.includes('id="browse-list-level"'));
  assert.match(main, /id="browse-detail" class="hidden/);
});

test('browse.js is loaded after home.js and precached by the service worker', () => {
  const homeAt = INDEX.indexOf('/js/home.js');
  const browseAt = INDEX.indexOf('/js/browse.js');
  assert.ok(homeAt > 0 && browseAt > homeAt, 'Browse depends on Home');
  assert.match(read('public/sw.js'), /'\/js\/browse\.js'/);
});

// ── app.js routing ───────────────────────────────────────────────

test('#apps and #apps/<slug> both route to navigateToBrowse', () => {
  assert.match(APP_SRC, /parts\[0\] === 'apps'/);
  const branch = APP_SRC.slice(APP_SRC.indexOf("parts[0] === 'apps'"));
  // The optional second segment is the detail page's deep link, decoded on
  // the way in (the hash round-trip isn't guaranteed to be byte-identical).
  assert.match(branch.slice(0, 700),
    /App\.navigateToBrowse\(parts\[1\] \? decodeURIComponent\(parts\[1\]\) : null\)/);
});

test('navigateToBrowse / _exitBrowse follow the screen pattern', () => {
  assert.match(APP_SRC, /navigateToBrowse\(slug\) \{/);
  assert.match(APP_SRC, /_exitBrowse\(\) \{/);
  const nav = APP_SRC.slice(
    APP_SRC.indexOf('navigateToBrowse(slug) {'),
    APP_SRC.indexOf('_exitBrowse() {')
  );
  assert.match(nav, /setHeaderTitle\('All apps'\)/);
  assert.match(nav, /App\._inBrowse = true/);
  assert.match(nav, /Browse\.open\(slug \|\| null, \{ chrome: false \}\)/);
  assert.match(nav, /App\._showOnlyScreen\('browse-screen'\)/);
  // Already mounted -> an in-screen LEVEL change, not a screen entry:
  // re-running the swap would replay the entry animation on a drill-in.
  assert.match(nav, /App\._inBrowse && window\.Browse\?\.isOpen\?\.\(\)/);
  assert.match(nav, /Browse\.route\(slug \|\| null\)/);
  // #979: the entry's visible mutations live inside the transition
  // callback, so the outgoing page is snapshotted as it looked. Browse's
  // own level chrome is deferred with it.
  const preTransition = nav.slice(0, nav.indexOf('PlatformUI.transition('));
  for (const forbidden of ['setHeaderTitle', 'setBackIcon', 'classList']) {
    assert.ok(!preTransition.includes(forbidden),
      `no ${forbidden} before the transition (it would land in the outgoing snapshot)`);
  }
  assert.match(nav, /Browse\.syncChrome\(\)/,
    'the deferred level chrome is applied inside the callback');
  // Leaving the screen is state-only now — the back chevron is handed back
  // by the next screen's _showOnlyScreen.
  const exit = APP_SRC.slice(APP_SRC.indexOf('_exitBrowse() {'));
  const exitBody = exit.slice(0, exit.indexOf('\n  },'));
  assert.ok(!exitBody.includes('setBackIcon'),
    '_exitBrowse no longer touches the back icon (#979)');
  assert.ok(!exitBody.includes('classList'),
    '_exitBrowse no longer hides the screen (#979)');
  assert.match(exitBody, /Browse\.close\(\)/);
});

test('the header back button consults Browse.handleBack', () => {
  const handler = APP_SRC.slice(APP_SRC.indexOf("getElementById('back-btn').addEventListener"));
  const body = handler.slice(0, 700);
  assert.match(body, /App\._inBrowse && window\.Browse\?\.handleBack\?\.\(\)/);
  // Ordered after the admin/settings hooks and before navigateHome.
  assert.ok(body.indexOf('Browse?.handleBack') < body.indexOf('App.navigateHome()'));
});

test('every sibling screen hides #browse-screen and exits the flag', () => {
  // One list of screen roots, hidden through one primitive (#979) — the
  // per-navigation hand-rolled hide lists are gone, so what this test
  // pins is (a) browse is in that list, (b) every sibling entry calls the
  // primitive, and (c) the flag is still exited.
  assert.match(APP_SRC, /SCREEN_IDS: \[[^\]]*'browse-screen'/,
    '#browse-screen is one of the mutually exclusive screen roots');
  for (const fn of ['navigateToProfile', 'navigateToAdminConsole', 'navigateToSettings',
    'navigateToLeaderboard']) {
    // Anchor on the DEFINITION (two-space indent), not the many comment
    // references to these names earlier in the file.
    const start = APP_SRC.indexOf(`\n  ${fn}(`);
    assert.ok(start > 0, `${fn} exists`);
    const body = APP_SRC.slice(start, start + 2600);
    assert.match(body, /App\._inBrowse\) App\._exitBrowse\(\)/, `${fn} exits browse`);
    assert.match(body, /App\._showOnlyScreen\('[a-z-]+'\)/,
      `${fn} hides every other root through _showOnlyScreen`);
  }
  // navigateHome must exit it too, or the grid stays mounted.
  const home = APP_SRC.slice(APP_SRC.indexOf('navigateHome() {'));
  assert.match(home.slice(0, 1200), /App\._inBrowse\) App\._exitBrowse\(\)/);
  assert.match(home.slice(0, 2600), /App\._showOnlyScreen\('home-screen', \['app-view'\]\)/,
    'going home reveals home and hides every root but the shrinking app card');
  // Bare "/" with the browse screen up resolves back home.
  assert.match(APP_SRC, /else if \(App\._inBrowse\) App\.navigateHome\(\);/);
});

test('the app-view zoom departs from whichever screen was on top', () => {
  // Hard-coding #home-screen here left the browse grid painted behind the
  // opened app. Since the _exitX helpers became state-only (#979) the
  // settings / admin / profile / leaderboard roots are live at this point
  // too, so the answer is read off the DOM rather than off _inBrowse.
  assert.match(APP_SRC, /_departingScreen\(\) \{/);
  const dep = APP_SRC.slice(APP_SRC.indexOf('_departingScreen() {'));
  const depBody = dep.slice(0, dep.indexOf('\n  },'));
  assert.match(depBody, /for \(const id of App\.SCREEN_IDS\)/,
    'it scans every screen root');
  // Through the visibility seam (#1078), not a raw classList read: a root
  // React owns publishes its state into the store instead of carrying
  // `.hidden`, so reading the class directly would answer "visible" for a
  // React screen that is actually down.
  assert.match(depBody, /App\._isScreenVisible\(id\)/,
    'and returns the one that is actually visible');
  assert.match(depBody, /return document\.getElementById\('home-screen'\)/,
    'home is the fallback');
  const nav = APP_SRC.slice(APP_SRC.indexOf('async navigateToApp('));
  const zoom = nav.slice(0, nav.indexOf('await AppView.open('));
  assert.match(zoom, /const departing = App\._departingScreen\(\)/);
  assert.ok(zoom.indexOf('const departing') < zoom.indexOf('App._exitLeaderboard()'),
    'resolved before the _exitX flags are cleared');
  assert.match(zoom, /outEl: departing/);
  assert.match(zoom, /after: \(\) => \{ App\._showOnlyScreen\('app-view'\); \}/,
    'the conceal hook hides EVERY other root, not just `departing`');
});

test('_tileFor resolves tiles in the two grids that still HAVE tiles', () => {
  const fn = APP_SRC.slice(APP_SRC.indexOf('_tileFor(slug) {'));
  const body = fn.slice(0, fn.indexOf('_departingScreen'));
  assert.match(body, /#app-list \.app-card/);
  assert.match(body, /#home-featured-list \.app-card/);
  // Browse renders app-store ROWS now, not icon tiles, so there is no tile
  // rect to zoom out of there — the kit falls back to a push.
  assert.doesNotMatch(body, /#browse-list/);
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

// ── Contributors section (#919) ────────────────────────────────────────
//
// The card is rendered by a PURE function of (cache entry, expanded flag),
// so every state is pinned here without a DOM or a fetch — the same
// discipline sortApps / metaLine / renderAppRow already follow.

const contrib = (over) => ({
  user_id: 10,
  username: 'alice',
  merged_count: 7,
  votes_count: 12,
  is_creator: false,
  is_member: false,
  ...over,
});

const ready = (items, total) => ({
  state: 'ready',
  items,
  total: total == null ? items.length : total,
});

test('contributors: the heading paints while loading so the page cannot jump', () => {
  const { Browse } = makeBrowse();
  const html = Browse.contributorsSectionHtml({ state: 'loading', items: [], total: 0 }, {});
  assert.match(html, /id="browse-detail-contributors"/);
  assert.match(html, /Contributors/);
  assert.match(html, /Loading contributors/);
  // No count chip until there is a real number to show.
  assert.doesNotMatch(html, /·\s*0/);
  assert.doesNotMatch(html, /browse-contrib-row/);
});

test('contributors: a ready row carries rank, avatar, @username, meta and the merged pill', () => {
  const { Browse } = makeBrowse();
  const html = Browse.contributorsSectionHtml(
    ready([contrib({ username: 'alice', merged_count: 12, votes_count: 30, is_creator: true })]),
    {}
  );
  assert.match(html, /Contributors<span[^>]*>\s*·\s*1<\/span>/, 'the total rides the heading');
  assert.match(html, /browse-contrib-row[^>]*data-username="alice"/);
  assert.match(html, />1<\/div>/, 'rank number');
  assert.match(html, /rounded-full[^>]*>A</, 'initial-avatar circle');
  assert.match(html, /@alice/);
  assert.match(html, /Creator · 30 votes/, 'role then vote count');
  assert.match(html, /12 merged/);
  assert.match(html, /violet/, 'a non-zero count gets the violet pill');
});

test('contributors: creator wins over member on the role label', () => {
  const { Browse } = makeBrowse();
  const html = Browse.contributorsSectionHtml(
    ready([contrib({ is_creator: true, is_member: true, votes_count: 0 })]), {}
  );
  assert.match(html, /Creator/);
  assert.doesNotMatch(html, /Member/, 'the creator is always a member too — saying both is noise');
});

test('contributors: a zero-merge row keeps a muted pill, and zero votes drop the meta line', () => {
  const { Browse } = makeBrowse();
  const html = Browse.contributorsSectionHtml(
    ready([contrib({ username: 'lurker', merged_count: 0, votes_count: 0 })]), {}
  );
  assert.match(html, /0 merged/, 'the row still shows a count so the column stays aligned');
  assert.match(html, /bg-zinc-100/, 'muted rather than violet at zero');
  assert.doesNotMatch(html, /votes/, 'no vote fragment at zero');
  // A votes-only contributor DOES get the fragment.
  const votesOnly = Browse.contributorsSectionHtml(
    ready([contrib({ merged_count: 0, votes_count: 19 })]), {}
  );
  assert.match(votesOnly, /19 votes/);
  assert.match(votesOnly, /0 merged/);
});

test('contributors: one vote is singular', () => {
  const { Browse } = makeBrowse();
  const html = Browse.contributorsSectionHtml(ready([contrib({ votes_count: 1 })]), {});
  assert.match(html, /1 vote(?!s)/);
});

test('contributors: the list folds at 5 with a Show-all toggle, and expands in place', () => {
  const { Browse } = makeBrowse();
  const seven = Array.from({ length: 7 }, (_, i) =>
    contrib({ user_id: i, username: `u${i}`, merged_count: 7 - i }));

  const folded = Browse.contributorsSectionHtml(ready(seven), {});
  assert.equal((folded.match(/browse-contrib-row/g) || []).length, 5, 'top 5 only');
  assert.match(folded, /id="browse-contrib-toggle"[\s\S]*?Show all 7 contributors/);
  assert.doesNotMatch(folded, /data-username="u5"/);

  const open = Browse.contributorsSectionHtml(ready(seven), { expanded: true });
  assert.equal((open.match(/browse-contrib-row/g) || []).length, 7);
  assert.match(open, /Show fewer/);
  assert.match(open, /data-username="u6"/);
});

test('contributors: exactly 5 rows need no toggle', () => {
  const { Browse } = makeBrowse();
  const five = Array.from({ length: 5 }, (_, i) => contrib({ user_id: i, username: `u${i}` }));
  const html = Browse.contributorsSectionHtml(ready(five), {});
  assert.equal((html.match(/browse-contrib-row/g) || []).length, 5);
  assert.doesNotMatch(html, /browse-contrib-toggle/);
});

test('contributors: a server-capped list quotes the true total but cannot reveal more locally', () => {
  const { Browse } = makeBrowse();
  // 6 rows arrived, the app really has 40 — the label says 40, and the
  // toggle can still only unfold what is in hand.
  const six = Array.from({ length: 6 }, (_, i) => contrib({ user_id: i, username: `u${i}` }));
  const html = Browse.contributorsSectionHtml(ready(six, 40), { expanded: true });
  assert.match(html, /·\s*40<\/span>/);
  assert.equal((html.match(/browse-contrib-row/g) || []).length, 6);
});

test('contributors: empty and error states each render their own copy', () => {
  const { Browse } = makeBrowse();
  const empty = Browse.contributorsSectionHtml(ready([]), {});
  assert.match(empty, /No contributors yet/);
  assert.match(empty, /id="browse-detail-contributors"/, 'the card is kept, not hidden');
  assert.doesNotMatch(empty, /browse-contrib-row/);

  const errored = Browse.contributorsSectionHtml({ state: 'error', items: [], total: 0 }, {});
  assert.match(errored, /load contributors/);
  assert.doesNotMatch(errored, /browse-contrib-row/);
});

test('contributors: a username is escaped in both text and attribute position', () => {
  const { Browse } = makeBrowse();
  const html = Browse.contributorsSectionHtml(
    ready([contrib({ username: '"><img src=x>&' })]), {}
  );
  assert.doesNotMatch(html, /<img/, 'no injected markup');
  assert.match(html, /&quot;/, 'the quote cannot break out of data-username');
  assert.match(html, /&amp;/);
});

test('contributors: a missing entry renders the loading card, never a crash', () => {
  const { Browse } = makeBrowse();
  assert.match(Browse.contributorsSectionHtml(undefined, {}), /Loading contributors/);
  assert.match(Browse.contributorsSectionHtml({ state: 'ready' }, {}), /No contributors yet/);
});

test('the detail page mounts the contributors card BELOW the action rows', async () => {
  const { Browse, Home, nodes } = makeBrowse({
    contributors: [contrib({ username: 'alice' })],
  });
  Home.menuItemsFor = () => ([{ key: 'fork', label: 'Fork this app', run: () => {} }]);
  Browse._apps = [app({ slug: 'detail-me', name: 'Detail Me' })];
  Browse.showDetail('detail-me');
  let html = nodes['browse-detail'].innerHTML;
  assert.match(html, /Loading contributors/, 'first paint is the loading card');
  assert.match(html, /Fork this app/, 'the rest of the page is untouched');
  await flush(); await flush();
  html = nodes['browse-detail'].innerHTML;
  assert.match(html, /@alice/);
  assert.ok(html.indexOf('browse-detail-action') < html.indexOf('browse-detail-contributors'),
    'the action rows stay above — the page’s primary navigation is not pushed down');
  assert.ok(html.indexOf('browse-detail-open') < html.indexOf('browse-detail-contributors'));
});

test('the detail page reads contributors once, and a repaint does NOT refetch', async () => {
  const { Browse, Home, fetchCalls } = makeBrowse({ contributors: [contrib()] });
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'once' })];
  Browse.showDetail('once');
  await flush(); await flush();
  const url = '/api/apps/once/contributors';
  assert.equal(fetchCalls.filter((c) => c.url === url).length, 1);
  // syncFrom repaints on every /api/apps refresh, and the fold toggle
  // repaints too — neither may re-read.
  Browse.syncFrom([app({ slug: 'once' })]);
  Browse.render();
  await flush();
  assert.equal(fetchCalls.filter((c) => c.url === url).length, 1, 'served from the cache');
});

test('the contributors read carries the ?demo=1 passthrough', async () => {
  const { Browse, Home, fetchCalls } = makeBrowse({ search: '?demo=1' });
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'demoed' })];
  Browse.showDetail('demoed');
  await flush(); await flush();
  assert.ok(fetchCalls.some((c) => c.url === '/api/apps/demoed/contributors?demo=1'),
    'staging demo rows have to reach the detail page too');
});

test('a failed contributors read degrades to the error card, not a broken page', async () => {
  const { Browse, Home, nodes } = makeBrowse({ fetchOk: false });
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'sad' })];
  Browse.showDetail('sad');
  await flush(); await flush();
  const html = nodes['browse-detail'].innerHTML;
  assert.match(html, /load contributors/);
  assert.match(html, /id="browse-detail-open"/, 'the rest of the detail page still renders');
});

test('every level change resets the expanded fold', () => {
  const { Browse, Home } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' }), app({ slug: 'b' })];
  for (const enter of [
    () => Browse.showDetail('b'),
    () => { Browse._slug = null; Browse.route('b'); },
    () => Browse.showList(),
    () => Browse.open('b'),
  ]) {
    Browse._contribExpanded = true;
    enter();
    assert.equal(Browse._contribExpanded, false,
      'a new page must never inherit the previous one’s fold state');
  }
});

test('leaving the screen drops the contributor cache so counts are re-read', async () => {
  const { Browse, Home, fetchCalls } = makeBrowse({ contributors: [contrib()] });
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'again' })];
  Browse.showDetail('again');
  await flush(); await flush();
  Browse.close();
  assert.equal(Browse._contrib.size, 0);
  Browse._open = true;
  Browse._apps = [app({ slug: 'again' })];
  Browse.showDetail('again');
  await flush(); await flush();
  assert.equal(fetchCalls.filter((c) => c.url === '/api/apps/again/contributors').length, 2,
    'merges land while the user is away — a fresh visit re-reads');
});

test('a contributor row routes to the existing leaderboard profile hash', () => {
  // The row is a hash link, so this screen owns no profile rendering; the
  // route is the one app.js already handles (#leaderboard/users/<name>).
  const fn = BROWSE_SRC.slice(BROWSE_SRC.indexOf('browse-contrib-row\')'));
  assert.match(fn, /#leaderboard\/users\/\$\{encodeURIComponent\(who\)\}/);
  assert.match(APP_SRC, /parts\[1\] === 'users' && parts\[2\]/,
    'app.js still routes the third segment as a profile username');
});

test('the cold deep-link fetch unwraps the { app } envelope the route sends', async () => {
  // Regression: reading the response as a BARE app row made every cold
  // deep link fall through to the "isn't available" state whenever the
  // concurrent /api/apps list didn't happen to carry the slug.
  const { Browse, Home, nodes } = makeBrowse({
    apps: [],
    coldApp: { slug: 'cold-app', name: 'Cold App', status: 'running' },
  });
  Home.menuItemsFor = () => [];
  Browse._slug = 'cold-app';
  Browse.render();
  await flush(); await flush(); await flush();
  assert.match(nodes['browse-detail'].innerHTML, /Cold App/, 'the app painted');
  assert.doesNotMatch(nodes['browse-detail'].innerHTML, /isn&rsquo;t available/);
  assert.equal(Browse._detailMissing, false);
});
