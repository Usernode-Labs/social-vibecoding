// The home screen's two hosts OUTSIDE the launcher canvas, after #1191 made
// them React's: `#home-apps-more` ("Show all N apps") and
// `#home-widget-strip-section` (the iOS widget-editing strip).
//
// ── What the conversion moved, and what these pin ──────────────────────
//
// Before, `Home.render()` built both as HTML strings, assigned them, and
// re-attached four listeners each time — Done, the ⓘ help toggle, every
// tile's ✕, and the expander button — because the assignment had just
// destroyed the nodes they were on. After, `Home.render()` pushes ONE plain
// view model (features/home/chrome-store.ts) and two components draw it.
//
// Three properties are worth pinning and none of them is a grep:
//
//   1. `Home.render()` publishes both halves on the same pass, and nothing in
//      home.js touches either host's DOM any more.
//   2. The INITIAL state renders exactly the empty, hidden markup the
//      prerendered document ships — the hydration contract (AGENTS.md), whose
//      failure mode is a console error on #home and therefore a failed
//      proposal check.
//   3. The four retired listeners still DO what they did. They are props now,
//      so they are executed here by calling the component as the plain
//      function it is and invoking the handler off the returned element tree
//      — renderToStaticMarkup drops handlers, and this coverage predates the
//      conversion by a long way.
//
// Run with: node --test tests/home-chrome-hosts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { HOME_SRC, HOME_RAW } = require('./helpers/home-modules');
const { installGridStore, INITIAL_CHROME } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const STRIP = 'frontend/src/features/home/widget-strip.tsx';
const MORE = 'frontend/src/features/home/apps-more.tsx';

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── a Home in a vm, with both stores bound ────────────────────────────

function makeHome() {
  const sandbox = {
    console,
    App: { user: { id: 1 }, _isScreenVisible: () => true },
    PlatformUI: { toast: () => {} },
    HomeLayout: null,
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installAppCard(sandbox);
  installGridStore(sandbox);
  vm.runInContext(
    `${read('frontend/src/features/home/home-layout.js')}\n;globalThis.HomeLayout = HomeLayout;`,
    sandbox,
  );
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, chromeStore: sandbox.chromeStore, sandbox };
}

const APP = {
  slug: 'demo-app',
  name: 'Demo App',
  status: 'running',
  created_by: 1,
  // `is_collaborator` is what puts an app in "Your apps" — the only section
  // the launcher grid holds.
  is_collaborator: true,
  icon_emoji: null,
  icon_url: null,
};

// ── 1. one render pass publishes both halves ──────────────────────────

test('Home.render() pushes the expander count and the strip together', () => {
  const { Home, chromeStore } = makeHome();
  // Cross-realm: the store lives in the vm context, so round-trip through
  // JSON rather than comparing prototypes.
  const chromeNow = () => JSON.parse(JSON.stringify(chromeStore.get()));
  assert.deepEqual(chromeNow(), INITIAL_CHROME, 'nothing published before a render');

  // Nine apps against a two-row, four-column default: one row is held back,
  // so the expander names all nine.
  Home._apps = Array.from({ length: 9 }, (_, i) => ({ ...APP, slug: `app-${i}`, name: `App ${i}` }));
  Home._layout = null;
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetSectionVisible = true;
  Home._widgetItems = [{ id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/app-0' }];
  Home.render();

  const chrome = chromeNow();
  assert.equal(chrome.moreCount, 9, 'the expander names every app, not just the hidden ones');
  assert.equal(chrome.strip.active, true, 'the strip rides the SAME push');
  assert.deepEqual(chrome.strip.tiles.map((t) => t.id), ['w1']);
});

test('a strip the platform cannot show publishes as inactive, not as absent', () => {
  const { Home, chromeStore } = makeHome();
  Home._apps = [APP];
  Home.render();
  const { strip } = JSON.parse(JSON.stringify(chromeStore.get()));
  assert.equal(strip.active, false, 'a plain browser never probes the bridge');
  assert.deepEqual(strip.tiles, []);
});

// ── 2. home.js is out of both hosts ───────────────────────────────────

test('home.js no longer writes either host', () => {
  // Comments first: the prose below explains what these ids USED to be, and
  // an assertion that trips over its own explanation is worse than no
  // assertion at all.
  const code = HOME_RAW
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  for (const id of ['home-apps-more', 'home-apps-more-btn', 'home-widget-strip-section']) {
    assert.doesNotMatch(code, new RegExp(id), `${id} is React's host now`);
  }
  // And the four listeners the paint used to re-attach are gone with it.
  // _wireWidgetStrip keeps ONLY the gesture, which attaches listeners to nodes
  // and writes no markup — the split AGENTS.md sanctions.
  const wire = code.slice(
    code.indexOf('_wireWidgetStrip(listEl) {'),
    code.indexOf('async _removeWidgetItem(id) {'),
  );
  assert.ok(wire.length > 200, 'found the function');
  for (const sel of ['widget-section-close', 'widget-section-help', 'widget-remove-btn']) {
    assert.doesNotMatch(wire, new RegExp(sel), `${sel} is a prop in widget-strip.tsx now`);
  }
  assert.match(wire, /attachReorder/, 'the gesture stays here');
});

// ── 3. the initial state is the shipped markup ────────────────────────

test('the initial chrome renders exactly what the prerendered shell ships', () => {
  const { WidgetStripBody } = loadTsx(STRIP);
  const { AppsMore } = loadTsx(MORE);
  assert.equal(
    renderToHtml(createElement(WidgetStripBody, { strip: INITIAL_CHROME.strip })),
    '',
    'an inactive strip draws nothing — this is what `return \'\'` meant',
  );
  assert.equal(
    renderToHtml(createElement(AppsMore, {})),
    '<div id="home-apps-more" class="hidden px-2 pb-1 sm:px-3"></div>',
    'the expander ships hidden and empty',
  );
  // The document the prerender wrote agrees, both ways round.
  const index = read('public/index.html');
  assert.match(index, /<div id="home-apps-more" class="hidden px-2 pb-1 sm:px-3"><\/div>/);
  assert.match(index, /<section id="home-widget-strip-section" class="hidden px-3 pt-2"><\/section>/);
});

// ── 4. the retired listeners, as props ────────────────────────────────

/**
 * Depth-first search of an element tree, descending THROUGH function
 * components by calling them. Every component reached this way is pure — the
 * two bodies and WidgetTile take props and return markup — so invoking one is
 * just evaluating the next level of the tree, which is what a renderer would
 * have done before dropping the handlers this searches for.
 */
function find(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, pred);
      if (hit) return hit;
    }
    return null;
  }
  if (pred(node)) return node;
  const inner = find(node.props && node.props.children, pred);
  if (inner) return inner;
  return typeof node.type === 'function' ? find(node.type(node.props), pred) : null;
}

const byId = (id) => (n) => n.props && n.props.id === id;

const ACTIVE = {
  active: true,
  helpVisible: false,
  tiles: [{ id: 'w1', slug: 'demo-app', name: 'Demo App', icon: { kind: 'letter', letter: 'D' } }],
};

function stripTree(strip) {
  const { WidgetStripBody } = loadTsx(STRIP);
  return WidgetStripBody({ strip });
}

function withHome(fn) {
  const home = {
    _widgetSectionVisible: true,
    _widgetHelpVisible: false,
    _appsExpanded: false,
    renders: 0,
    removed: [],
    render() { home.renders += 1; },
    _removeWidgetItem(id) { home.removed.push(id); },
  };
  const prev = global.window;
  global.window = { Home: home };
  try { fn(home); } finally {
    if (prev === undefined) delete global.window; else global.window = prev;
  }
}

const fakeEvent = () => ({ stopPropagation() {} });

test('Done hides the section and the help panel, then repaints', () => {
  withHome((home) => {
    const btn = find(stripTree(ACTIVE), byId('widget-section-close'));
    assert.ok(btn, 'the Done button is in the tree');
    home._widgetHelpVisible = true;
    btn.props.onClick(fakeEvent());
    assert.equal(home._widgetSectionVisible, false, 'Done closes the section');
    assert.equal(home._widgetHelpVisible, false, 'and resets the help panel with it');
    assert.equal(home.renders, 1, 'one repaint, from the flag it just wrote');
  });
});

test('the ⓘ button toggles the help panel both ways', () => {
  withHome((home) => {
    find(stripTree(ACTIVE), byId('widget-section-help')).props.onClick(fakeEvent());
    assert.equal(home._widgetHelpVisible, true);
    // …and the next render draws it, which is the half a source grep misses.
    const shown = { ...ACTIVE, helpVisible: true };
    assert.match(renderToHtml(createElement(() => stripTree(shown))), /id="widget-help-panel"/);
    find(stripTree(shown), byId('widget-section-help')).props.onClick(fakeEvent());
    assert.equal(home._widgetHelpVisible, false, 'the same button closes it again');
  });
});

test('a tile ✕ removes that tile, and only that tile', () => {
  withHome((home) => {
    const tree = stripTree({
      ...ACTIVE,
      tiles: [
        ACTIVE.tiles[0],
        { id: 'w2', slug: null, name: 'Other Dapp', icon: { kind: 'letter', letter: 'O' } },
      ],
    });
    const btn = find(tree, (n) => n.props
      && typeof n.props.className === 'string'
      && n.props.className.startsWith('widget-remove-btn')
      && n.props['data-wid'] === 'w2');
    assert.ok(btn, 'the second tile has its own remove button');
    btn.props.onClick(fakeEvent());
    assert.deepEqual(home.removed, ['w2']);
  });
});

test('"Show all N apps" expands the grid and repaints', () => {
  withHome((home) => {
    const { AppsMoreBody } = loadTsx(MORE);
    assert.equal(
      renderToHtml(createElement(AppsMoreBody, { moreCount: 0 })),
      '<div id="home-apps-more" class="hidden px-2 pb-1 sm:px-3"></div>',
      'a zero count is the hidden, empty host — not a button saying "Show all 0 apps"',
    );
    const html = renderToHtml(createElement(AppsMoreBody, { moreCount: 9 }));
    assert.match(html, /Show all 9 apps/);
    assert.doesNotMatch(html, /class="hidden/);

    const btn = find(AppsMoreBody({ moreCount: 9 }), byId('home-apps-more-btn'));
    assert.ok(btn, 'the expander button is in the tree');
    btn.props.onClick();
    assert.equal(home._appsExpanded, true, 'the click lifts the two-row cap');
    assert.equal(home.renders, 1, 'and repaints from it');
  });
});
