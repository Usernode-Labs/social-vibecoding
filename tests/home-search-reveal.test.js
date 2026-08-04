// Hidden-until-pulled home search bar.
//
// The bar is the FIRST child inside #home-screen and is NOT sticky, so it
// occupies real scroll space above the content. Home._searchReveal parks
// the scroller at scrollTop = <bar height>, which hides it; a slight pull
// down (a scroll up on desktop) reveals it. Past that the scroller sits at
// 0 and the kit's attachPullToRefresh — which only engages from a resting
// scrollTop of 0 (public/usernode-native/v1/native.js onTouchStart) —
// arms the refresh. That composition is the whole design: no new gesture
// recognizer exists, and these tests hold the pieces it depends on in
// place.
//
// Run with: node --test tests/home-search-reveal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const HOME_SRC = read('public/js/home.js');
const INDEX = read('public/index.html');

// A #home-screen / #home-search-bar pair with settable scrollTop and a
// measurable bar height — the two things the reveal controller reads.
function makeHome(opts = {}) {
  const barHeight = opts.barHeight == null ? 52 : opts.barHeight;
  const bar = {
    offsetHeight: barHeight,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
  };
  const screen = {
    scrollTop: opts.scrollTop == null ? 0 : opts.scrollTop,
    addEventListener() { screen._scrollWired = true; },
    _scrollWired: false,
  };
  const els = { 'home-screen': screen, 'home-search-bar': bar };
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => ({ classList: { add() {} }, dataset: {} }),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    requestAnimationFrame: (fn) => fn(),
    location: { search: opts.search || '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, screen, bar };
}

// ── index.html structure ──────────────────────────────────────────

test('the bar is inside the home scroller, before the content body', () => {
  const main = INDEX.slice(
    INDEX.indexOf('<main id="home-screen"'),
    INDEX.indexOf('<main id="browse-screen"')
  );
  assert.ok(main.includes('id="home-search-bar"'), 'bar lives inside #home-screen');
  assert.ok(
    main.indexOf('id="home-search-bar"') < main.indexOf('id="home-body"'),
    'bar precedes the content, so scrolling down hides it'
  );
});

test('the bar is neither sticky nor class-hidden any more', () => {
  const barTag = INDEX.match(/<div id="home-search-bar"[^>]*>/)[0];
  assert.doesNotMatch(barTag, /\bsticky\b/,
    'a sticky bar could never scroll out of view');
  assert.doesNotMatch(barTag, /\bhidden\b/,
    'visibility is a scroll position now, not a class');
  assert.match(barTag, /data-revealed="false"/, 'ships with the state stamped');
});

test('the content body guarantees the scroller can always scroll', () => {
  // Without this, a short "Your apps" list makes the page unscrollable
  // and the bar is stuck on screen permanently. The min-height now lives
  // in .home-body-fill (which also makes the body the flex column that
  // bottom-anchors the trailing sections) rather than an inline style.
  const body = INDEX.match(/<div id="home-body"[^>]*>/)[0];
  assert.match(body, /class="[^"]*\bhome-body-fill\b/);
  const rule = read('public/css/app.css').match(/\.home-body-fill \{[^}]*\}/)[0];
  assert.match(rule, /min-height:\s*100%/);
});

// ── sync(): park the scroller past the bar ────────────────────────

test('sync tucks the bar away by exactly its measured height', () => {
  const { Home, screen, bar } = makeHome({ barHeight: 52, scrollTop: 0 });
  Home._searchReveal.sync();
  assert.equal(screen.scrollTop, 52, 'measured, never hard-coded');
  assert.equal(bar.dataset.revealed, 'false');
});

test('sync never yanks a user who has scrolled further down', () => {
  const { Home, screen } = makeHome({ barHeight: 52, scrollTop: 800 });
  Home._searchReveal.sync();
  assert.equal(screen.scrollTop, 800,
    'a WS-driven re-render must not scroll the page under the user');
});

test('sync wires the scroll listener that stamps data-revealed', () => {
  const { Home, screen } = makeHome();
  Home._searchReveal.sync();
  assert.equal(screen._scrollWired, true);
});

test('mark: data-revealed flips with the scroll position', () => {
  const { Home, screen, bar } = makeHome({ barHeight: 52, scrollTop: 0 });
  Home._searchReveal.mark();
  assert.equal(bar.dataset.revealed, 'true', 'at rest at the top = revealed');
  screen.scrollTop = 52;
  Home._searchReveal.mark();
  assert.equal(bar.dataset.revealed, 'false', 'parked past the bar = hidden');
  screen.scrollTop = 10;
  Home._searchReveal.mark();
  assert.equal(bar.dataset.revealed, 'true', 'mostly showing counts as revealed');
});

// ── Pinning: focus, a live query, the shot deep link ──────────────

test('a focused bar is pinned — sync leaves it alone', () => {
  const { Home, screen } = makeHome({ barHeight: 52, scrollTop: 0 });
  Home._searchReveal.pin();
  assert.equal(Home._searchReveal.isPinned(), true);
  Home._searchReveal.sync();
  assert.equal(screen.scrollTop, 0, 'never scrolls the focused field away');
});

test('a non-empty query pins the bar even without focus', () => {
  const { Home, screen } = makeHome({ barHeight: 52, scrollTop: 0 });
  Home._query = 'chess';
  assert.equal(Home._searchReveal.isPinned(), true);
  Home._searchReveal.sync();
  assert.equal(screen.scrollTop, 0);
});

test('unpin re-tucks the bar (blur on an empty field)', () => {
  const { Home, screen } = makeHome({ barHeight: 52, scrollTop: 0 });
  Home._searchReveal.pin();
  Home._searchReveal.sync();
  assert.equal(screen.scrollTop, 0);
  Home._searchReveal.unpin();
  assert.equal(screen.scrollTop, 52, 'unpin syncs immediately');
});

test('?shot=home-search leaves the bar revealed for screenshots', () => {
  const { Home, screen, bar } = makeHome({
    barHeight: 52, scrollTop: 0, search: '?shot=home-search',
  });
  assert.equal(Home._searchReveal.shotRevealed(), true);
  Home._searchReveal.sync();
  assert.equal(screen.scrollTop, 0, 'the revealed bar is URL-reachable');
  assert.equal(bar.dataset.revealed, 'true');
});

test('an unrelated ?shot value does not pin the bar', () => {
  const { Home, screen } = makeHome({
    barHeight: 52, scrollTop: 0, search: '?shot=card-menu',
  });
  assert.equal(Home._searchReveal.shotRevealed(), false);
  Home._searchReveal.sync();
  assert.equal(screen.scrollTop, 52);
});

// ── Wiring pins ──────────────────────────────────────────────────

test('render ends by syncing the reveal state', () => {
  assert.match(HOME_SRC, /Home\._searchReveal\.sync\(\);/,
    'every render re-parks the scroller');
});

test('the search input pins on focus/input and releases on empty blur', () => {
  const start = HOME_SRC.indexOf('_wireSearch() {');
  const wire = HOME_SRC.slice(start, HOME_SRC.indexOf('_wireDiscoveryCards(listEl, onChange)', start));
  assert.ok(wire.length > 200, 'located _wireSearch');
  assert.match(wire, /addEventListener\('focus', \(\) => Home\._searchReveal\.pin\(\)\)/);
  assert.match(wire, /Home\._searchReveal\.pin\(\)/);
  assert.match(wire, /if \(!input\.value\) Home\._searchReveal\.unpin\(\)/);
});

test('home PTR is still element-mode on #home-screen (the second stage)', () => {
  // The kit only engages from scrollTop 0, which is exactly what makes
  // "pull once for search, keep pulling for refresh" work.
  const app = read('public/js/app.js');
  assert.match(app, /pullToRefresh\(home,/);
  assert.match(app, /const home = document\.getElementById\('home-screen'\)/);
});
