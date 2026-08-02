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
    // An origin so _widgetSlugFor can resolve a widget item's URL back
    // to an SV slug (widget tiles key their icon off the matched app).
    location: { search: '', origin: 'https://sv.test' },
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
// with a faint grey hairline, and the first-letter fallback a step
// fainter still. Every tile call site routes its colours through that
// one class, so no tile may carry its own violet colour utilities.
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

// The fainter letter is CSS-side: the tile tags its kind with
// data-icon and app.css steps ONLY the letter kind down to
// --text-faint. Pin both halves — the markup tag on every tile call
// site, and the stylesheet rule that keys off it — so neither can drift
// away from the other and silently restore the darker letter.
test('letter tiles are tagged data-icon="letter" on every call site', () => {
  const Home = makeHome();
  const widgetItem = { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo' };
  assert.match(Home.renderAppCard(baseApp()), /class="app-icon-tile[^"]*"[^>]*data-icon="letter"/);
  Home._apps = [baseApp()];
  assert.match(
    Home.renderWidgetTile(widgetItem),
    /class="app-icon-tile[^"]*"[^>]*data-icon="letter"/
  );
  // …and the other two kinds keep their own tags, so the letter rule
  // can never catch an emoji or image tile.
  assert.match(Home.renderAppCard(baseApp({ icon_emoji: '🎮' })), /data-icon="emoji"/);
  Home._apps = [baseApp({ icon_emoji: '🎮' })];
  assert.match(Home.renderWidgetTile(widgetItem), /data-icon="emoji"/);
  Home._apps = [baseApp({ icon_url: '/app-icons/' + 'a'.repeat(32) })];
  assert.match(Home.renderWidgetTile(widgetItem), /data-icon="image"/);
});

test('app.css steps the letter glyph down to the faint token', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'),
    'utf8'
  );
  assert.match(
    css,
    /\.app-icon-tile\[data-icon="letter"\]\s*\{\s*color:\s*var\(--text-faint\);/,
    'letter tiles use --text-faint, one step fainter than the base glyph'
  );
  // The base tile colour stays where it is — only the letter steps down.
  assert.match(css, /\.app-icon-tile \{[^}]*color: var\(--text-secondary\);/);
});

test('the widget PNG letter matches the faint in-app letter', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'home.js'),
    'utf8'
  );
  // #a1a1aa is --text-faint; emoji stay null (their own colour glyphs).
  assert.match(src, /app\.icon_emoji \? null : '#a1a1aa'/);
  // Pinned tiles only re-send when the generation moves, so a change to
  // the rendering above without a bump would never reach a homescreen.
  assert.match(src, /WIDGET_ICON_GEN: 4,/);
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
