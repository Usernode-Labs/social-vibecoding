// Home-card icon tile states (dapp.json `icon` block): renderAppCard
// must render exactly one of three tile kinds — a custom image
// (icon_url), an emoji (icon_emoji), or the first-letter fallback —
// tagged with data-icon so the WS rename handler (app.js) can tell a
// custom icon from the letter placeholder, and updateAppCardIcon must
// patch a mounted tile in place across all three states.
//
// home.js is a plain browser script (`const Home = {…}`); we load it
// into a vm context, stub the globals it reaches, and assert on the
// returned HTML strings — same harness as card-action-layout.test.js.
//
// Run with: node --test tests/home-card-icon.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'home.js'),
  'utf8'
);

// Minimal functional stand-in for the DOM bits home.js's escapeHtml
// leans on (createElement + textContent/innerHTML round-trip).
function fakeElement() {
  let text = '';
  return {
    style: {},
    set textContent(v) { text = String(v); },
    get textContent() { return text; },
    get innerHTML() {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  };
}

function makeHome() {
  const sandbox = {
    console,
    App: { user: null },
    document: {
      createElement: fakeElement,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    location: { search: '' },
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__Home = Home;`, sandbox);
  const Home = sandbox.__Home;
  Home.__sandbox = sandbox;
  return Home;
}

function baseApp(overrides = {}) {
  return {
    slug: 'demo',
    name: 'Demo App',
    status: 'running',
    active_users: 0,
    locked: false,
    icon_emoji: null,
    icon_url: null,
    ...overrides,
  };
}

test('letter fallback renders when no icon is declared', () => {
  const html = makeHome().renderAppCard(baseApp());
  assert.match(html, /data-icon="letter"/);
  assert.match(html, />\s*D\s*</);
  assert.doesNotMatch(html, /<img/);
});

test('emoji icon renders on the tile', () => {
  const html = makeHome().renderAppCard(baseApp({ icon_emoji: '🎮' }));
  assert.match(html, /data-icon="emoji"/);
  assert.ok(html.includes('🎮'));
  assert.doesNotMatch(html, /<img/);
});

test('image icon renders an <img> and wins over emoji', () => {
  const html = makeHome().renderAppCard(
    baseApp({ icon_emoji: '🎮', icon_url: '/app-icons/' + 'a'.repeat(32) })
  );
  assert.match(html, /data-icon="image"/);
  assert.match(html, /<img src="\/app-icons\/a{32}"/);
  assert.match(html, /object-cover/);
});

// The tile treatment itself (app.css `.app-icon-tile`): a white face
// with a faint grey hairline and a dark-grey glyph. Every tile call
// site routes its colours through that one class, so no tile may carry
// its own violet bg-*/text-* classes any more.
test('every icon tile carries .app-icon-tile and no violet colouring', () => {
  const Home = makeHome();
  const variants = [
    Home.renderAppCard(baseApp()),
    Home.renderAppCard(baseApp({ icon_emoji: '🎮' })),
    Home.renderAppCard(baseApp({ icon_url: '/app-icons/' + 'a'.repeat(32) })),
    Home.renderCreateTile(),
    Home.renderWidgetTile({ id: 'w1', name: 'Demo App', slug: 'demo' }),
  ];
  for (const html of variants) {
    const tile = html.match(/class="app-icon-tile[^"]*"/);
    assert.ok(tile, 'tile uses the shared class');
    // Scoped to the tile's own class list: the surrounding create-tile
    // chrome (dashed violet card outline, violet "Create new app" pill)
    // is deliberately untouched.
    assert.doesNotMatch(tile[0], /bg-violet/, 'no violet tile background');
    assert.doesNotMatch(tile[0], /text-violet/, 'no violet glyph colour');
  }
  // The create-tile placeholder keeps its "empty slot" variant.
  assert.match(Home.renderCreateTile(), /app-icon-tile app-icon-tile--empty/);
});

test('image icons fill the tile inside its hairline (w-full/h-full)', () => {
  const Home = makeHome();
  const html = Home.renderAppCard(
    baseApp({ icon_url: '/app-icons/' + 'a'.repeat(32) })
  );
  assert.match(html, /<img[^>]*class="w-full h-full rounded-xl object-cover"/);
  assert.doesNotMatch(html, /<img[^>]*w-14 h-14/,
    'a fixed 56px image would be cropped by the 1px border box');
});

test('icon_url is HTML-escaped', () => {
  const html = makeHome().renderAppCard(
    baseApp({ icon_url: '/x"><script>alert(1)</script>' })
  );
  assert.doesNotMatch(html, /<script>/);
});

test('updateAppCardIcon patches a mounted tile across states', () => {
  const Home = makeHome();
  const tile = { dataset: { icon: 'letter' }, innerHTML: 'D' };
  const card = {
    querySelector: (sel) => (sel === '[data-icon]' ? tile : { textContent: 'Demo App' }),
  };
  Home.__sandbox.document.querySelector = (sel) =>
    sel === '.app-card[data-slug="demo"]' ? card : null;
  Home._apps = [baseApp()];

  Home.updateAppCardIcon('demo', '🚀', null);
  assert.equal(tile.dataset.icon, 'emoji');
  assert.ok(tile.innerHTML.includes('🚀'));
  assert.equal(Home._apps[0].icon_emoji, '🚀');

  Home.updateAppCardIcon('demo', null, '/app-icons/' + 'b'.repeat(32));
  assert.equal(tile.dataset.icon, 'image');
  assert.match(tile.innerHTML, /<img/);

  // Cleared back to the letter fallback (derived from the cached name).
  Home.updateAppCardIcon('demo', null, null);
  assert.equal(tile.dataset.icon, 'letter');
  assert.equal(tile.innerHTML, 'D');
  assert.equal(Home._apps[0].icon_url, null);
});

test('updateAppCardIcon is a safe no-op when the card is not mounted', () => {
  const Home = makeHome();
  Home._apps = [];
  assert.doesNotThrow(() => Home.updateAppCardIcon('ghost', '🎮', null));
});
