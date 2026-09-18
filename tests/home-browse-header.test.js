'use strict';

// #1569: the Home/Browse root header must not grow a back slot on navigation.
// Execute the actual router and Browse controller, then render the actual
// React header through their store bridges. Effects do not run under SSR;
// viewport geometry remains covered by header-height/title-centering tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const APP = read('public/js/app.js');
const BROWSE = read('frontend/src/features/apps/browse.js');
const ui = loadTsx('tests/fixtures/platform-header-api.ts');
const initialBack = { ...ui.backButtonStore.get() };
const initialTitle = { ...ui.headerTitleStore.get() };
const initialImprove = { ...ui.improveStore.get() };

function harness({ improveAvailable = true } = {}) {
  ui.backButtonStore.set(initialBack);
  ui.headerTitleStore.set(initialTitle);
  // Target availability is held steady, as it is on these two platform
  // screens. The authority/data-loading gates have their own coverage in
  // improve-target-leaving-app.test.js.
  ui.improveStore.set({
    ...initialImprove,
    target: improveAvailable ? 'platform' : null,
    slug: improveAvailable ? 'platform-app' : null,
    selfHosted: improveAvailable,
  });
  const writes = [];
  const transitions = [];
  const visible = new Map([['home-screen', true]]);
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, innerHTML: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
    });
    return nodes.get(id);
  }
  const sandbox = {
    console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { hash: '', search: '', pathname: '/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: node, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    addEventListener() {},
    PlatformUI: { transition: (fn, options) => transitions.push({ fn, options }) },
    Home: { _apps: [{ slug: 'notes', name: 'Notes' }], load() {}, publishImproveTarget() {} },
    AppView: { close() {}, _teardownDevRoots() {}, _unmountAppFrame() {} },
    UsernodeReact: {
      backButton: { set(mode, href) {
        writes.push({ mode, href });
        ui.backButtonStore.set({ mode, href });
      } },
      headerTitle: { set(text, subtitle) {
        writes.push({ text });
        ui.headerTitleStore.set({ text, subtitle: subtitle || '' });
      } },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP, sandbox);
  vm.runInContext(BROWSE, sandbox);
  const { App, Browse } = sandbox;
  App.user = { id: 1 };
  App._setScreenVisible = (id, value) => visible.set(id, value);
  App._isScreenVisible = (id) => visible.get(id) === true;
  App.setChromeless = () => {};
  App.updateHash = () => { sandbox.location.hash = ''; };
  Browse._load = () => {}; // No network needed to exercise screen/level chrome.
  const header = () => {
    // homeHref reads the browser bridge on a visible Home button. Supply the
    // same window to the renderer for this synchronous pass, then restore it.
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const previousWindow = globalThis.window;
    globalThis.window = sandbox;
    try {
      const html = renderToHtml(createElement(ui.PlatformHeader));
      const result = html.match(/<header\b[\s\S]*?<\/header>/);
      assert.ok(result, 'the real platform header renders');
      return result[0];
    } finally {
      if (hadWindow) globalThis.window = previousWindow;
      else delete globalThis.window;
    }
  };
  const flush = () => {
    const transition = transitions.shift();
    assert.ok(transition, 'one screen transition is pending');
    transition.fn();
    transition.options?.after?.();
  };
  return { App, Browse, header, writes, transitions, visible, flush };
}

// The chip is the ONE thing that may legitimately differ between the two root
// headers: it says where you are, and Home and Browse are different places.
// Two places carry that — the visible label, which is the logotype on Home
// (#1443 / the logged-out redesign) and the words "All apps" on Browse, and
// the name interpolated into the button's aria-label. Blanking exactly those
// two keeps the comparison below an EQUALITY over everything else — controls,
// classes, wrappers, attribute order — which is the whole value of this test.
// Each is then asserted on its own terms, rather than by substituting one
// string for the other, which is what stopped working when the visible half
// became a drawing and the spoken half stayed a word.
const LABEL = /<span id="app-switcher-name" class="min-w-0 truncate">[\s\S]*?<\/span>/;
const CHIP_NAME = /aria-label="[^"]*: open the menu"/;
const label = (html) => {
  const found = html.match(LABEL);
  assert.ok(found, 'the header carries the chip label slot');
  return found[0];
};
const chipName = (html) => {
  const found = html.match(CHIP_NAME);
  assert.ok(found, 'the chip still names itself to a screen reader');
  return found[0];
};
const maskChip = (html) => html
  .replace(label(html), '[chip label]')
  .replace(chipName(html), 'aria-label="[chip name]: open the menu"');

// The chip's own pill, verbatim. `h-7` in it is the 28px content row
// (tests/header-height-parity.test.js) and the three brand tokens are what
// re-ink it per theme and app tone; neither may move when the label does.
const CHIP_CLASS = 'pointer-events-auto inline-flex items-center gap-1 max-w-full h-7 '
  + 'pl-3.5 pr-2.5 rounded-full align-middle un-touch-target font-bold '
  + 'border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)] '
  + 'text-[color:var(--brand-ink)]';

for (const improveAvailable of [true, false]) {
  test(`Home and Browse render identical header controls with Improve ${improveAvailable ? 'available' : 'unavailable'}`, () => {
    const h = harness({ improveAvailable });
    h.App._showOnlyScreen('home-screen');
    h.App.setHeaderTitle('Homeroom');
    const home = h.header();
    h.writes.length = 0;

    h.App.navigateToBrowse();
    assert.deepEqual(h.writes, [], 'no incoming chrome before the outgoing snapshot');
    assert.equal(h.header(), home);
    h.flush();
    const browse = h.header();
    assert.equal(maskChip(browse), maskChip(home),
      'only what the chip says changes, not controls, classes, or wrappers');
    assert.match(label(home), /<svg[^>]*\bfill="currentColor"/,
      'Home names the platform with the logotype');
    assert.doesNotMatch(label(home), /Homeroom/,
      'and draws it INSTEAD of the word, not beside it');
    assert.equal(chipName(home), 'aria-label="Homeroom: open the menu"',
      'while the accessible name still says it in words — the graphic is aria-hidden');
    assert.equal(label(browse),
      '<span id="app-switcher-name" class="min-w-0 truncate">All apps</span>',
      'Browse names the destination in words, in the same slot');
    assert.equal(chipName(browse), 'aria-label="All apps: open the menu"');
    assert.ok(h.writes.some((entry) => entry.mode === 'none'));
    assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'),
      'not even an intermediate publish inserts a Home icon');

    h.writes.length = 0;
    h.App.navigateHome();
    assert.deepEqual(h.writes, [], 'return navigation also defers its header writes');
    assert.equal(h.header(), browse);
    h.flush();
    assert.equal(h.header(), home);
    assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'));
  });
}

// Nothing asserted what the chip's label IS until now — only that the slot
// existed. It is a drawing on the platform's own screens and a word everywhere
// else, so both halves of that switch get a pin here.
test('the chip draws the logotype when it names the platform', () => {
  const h = harness();
  h.App._showOnlyScreen('home-screen');
  h.App.setHeaderTitle('Homeroom');
  const header = h.header();
  const mark = label(header);

  assert.match(mark, /<svg\b/, 'the platform is named by the drawing, not the word');
  assert.doesNotMatch(mark, /Homeroom/, 'and the word is not set beside it');
  assert.match(mark, /<svg[^>]*\bfill="currentColor"/,
    'the mark takes the chip ink, so --brand-ink re-inks it across theme and app tone');
  assert.doesNotMatch(mark, /\bdark:/,
    'no hand-written dark variant — currentColor already covers all four combinations');
  assert.match(mark, /<svg[^>]*\baria-hidden="true"/,
    'the mark is decorative: the button aria-label is what names this control');
  assert.doesNotMatch(mark, /role="img"|<title>/,
    'so it must not announce the word a second time');

  // h-5 is one of the three heights that belong in a header bar; `text-xl` is
  // the same 20px expressed as type and is banned BY NAME in
  // tests/header-height-parity.test.js, which is why the mark is sized as a box.
  assert.match(mark, /<svg[^>]*\bclass="h-5 w-\[77\.5px\]"/,
    'the mark is 20px tall, with the logotype aspect written out as a literal');
  for (const banned of ['h-8', 'h-9', 'h-10', 'h-12', 'py-2', 'py-3', 'py-4',
    'text-xl', 'text-2xl', 'text-3xl']) {
    assert.ok(!new RegExp(`\\b(?:sm:|md:|lg:)?${banned}\\b`).test(mark),
      `the chip label carries no ${banned} — the content row is still 28px`);
  }

  // Everything AROUND the label is untouched.
  assert.ok(header.includes(`class="${CHIP_CLASS}"`),
    'the chip keeps its h-7 pill and its brand tokens, verbatim');
  assert.match(header, /aria-label="Homeroom: open the menu"/,
    'the accessible name is unchanged — aria-label overrides the contents either way');
  assert.match(header, /id="app-switcher-name" class="min-w-0 truncate"/,
    'the named slot and its truncation stay, whatever is inside them');
  assert.doesNotMatch(header, /id="app-switcher-subtitle"/, 'Home publishes no subtitle');
});

test('the chip writes a name in words for an app, and whenever there is a subtitle', () => {
  const h = harness();
  h.App.setHeaderTitle('Notes', 'Board');
  const header = h.header();
  assert.equal(label(header),
    '<span id="app-switcher-name" class="min-w-0 truncate">Notes</span>',
    'an app is named in words, in the same slot');
  assert.doesNotMatch(label(header), /<svg/, 'and nothing is drawn in its place');
  assert.match(header, /id="app-switcher-subtitle" class="shrink-0/,
    'the subtitle still does not shrink — the name is what truncates');
  assert.match(header, /id="app-switcher-subtitle"[\s\S]*?>Board</,
    'and it still says which part of the app you are in');
  assert.match(header, /aria-label="Notes, Board: open the menu"/);

  // The self-hosted platform app is ITSELF named "Homeroom", so the title
  // string alone is true inside it too. The mark is suppressed there: it has
  // no text baseline for the `items-baseline` line it would share with the
  // subtitle, and no design board covers those screens.
  h.App.setHeaderTitle('Homeroom', 'Workshop');
  const subtitled = h.header();
  assert.equal(label(subtitled),
    '<span id="app-switcher-name" class="min-w-0 truncate">Homeroom</span>',
    'a subtitled screen keeps the word, even when the word is the platform name');
  assert.match(subtitled, />Workshop</, 'beside the subtitle it shares the line with');
});

test('a cold Browse entry and a repeated route never insert the Home icon', () => {
  const h = harness();
  h.App.navigateToBrowse();
  assert.deepEqual(h.writes, []);
  h.flush();
  assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'));
  const header = h.header();
  h.writes.length = 0;
  h.App.navigateToBrowse();
  assert.equal(h.transitions.length, 0, 'duplicate dispatch does not start another transition');
  assert.deepEqual(h.writes, []);
  assert.equal(h.header(), header);
});

test('Browse details retain the arrow to the list, which restores the root header', () => {
  const h = harness();
  h.App.navigateToBrowse();
  h.flush();
  const listHeader = h.header();
  h.App.navigateToBrowse('notes');
  assert.equal(h.header(), listHeader, 'detail chrome is deferred until the level transition');
  h.flush();
  assert.equal(ui.backButtonStore.get().mode, 'arrow');
  assert.equal(ui.backButtonStore.get().href, '#apps');
  assert.match(h.header(), /id="back-btn"[^>]*aria-label="Back"[^>]*href="#apps"/);

  h.App.navigateToBrowse();
  h.flush();
  assert.equal(h.header(), listHeader);
});

test('a detail opened directly from a Home card still offers Home', () => {
  const h = harness();
  h.Browse.noteDetailOrigin('home');
  h.App.navigateToBrowse('notes');
  h.flush();
  assert.equal(ui.backButtonStore.get().mode, 'home');
  assert.equal(ui.backButtonStore.get().href, '/');
  assert.match(h.header(), /id="back-btn"[^>]*aria-label="Home"/);
});

test('secondary screens keep their Home button instead of inheriting the root state', () => {
  const h = harness();
  for (const screen of ['app-view', 'settings-screen', 'profile-screen', 'messages-screen', 'admin-screen', 'leaderboard-screen']) {
    h.App._showOnlyScreen('browse-screen');
    h.App._showOnlyScreen(screen);
    assert.equal(ui.backButtonStore.get().mode, 'home', `${screen} keeps its way out`);
  }
});

test('the shared navigation menu still has reachable Home and Discover destinations', () => {
  const menu = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(menu, /label="Home"[\s\S]{0,500}App\?\.navigateHome\?\.\(\)/);
  assert.match(menu, /href="#apps"\s+icon=\{<SearchIcon \/>\}\s+label="Discover"/);
});
