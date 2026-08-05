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
// The "Create app" tile moved out of home.js: it is a home-screen WIDGET
// now (HomePanels.renderCreatePanel), so it is loaded here to keep it under
// the same shared-icon-treatment assertions the app tiles are.
const PANELS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'home-panels.js'),
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
    URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n${PANELS_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const Home = sandbox.__Home;
  Home.__sandbox = sandbox;
  Home.__HP = sandbox.HomePanels;
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
    Home.__HP.renderCreatePanel({ key: 'create' }),
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
  assert.match(Home.__HP.renderCreatePanel({ key: 'create' }), /app-icon-tile app-icon-tile--empty/);
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

// --border-light is inverted between the palettes (fainter than
// --border in light mode, BRIGHTER in dark mode), so a single token
// for the hairline gives dark-mode tiles the most contrasty ring on
// the page. Pin the per-mode pair so neither half drifts back.
test('the tile hairline steps down to --border in dark mode', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'),
    'utf8'
  );
  assert.match(
    css,
    /\.app-icon-tile \{[^}]*border: 1px solid var\(--border-light\);/,
    'light mode keeps the faint --border-light hairline'
  );
  assert.match(
    css,
    /\.dark \.app-icon-tile \{[^}]*border-color: var\(--border\);/,
    'dark mode steps the hairline down to --border'
  );
});

// The widget PNG is baked once per pinned tile and can't restyle
// itself, so both palettes have to live in the source and the scheme
// has to reach the staleness marker. Pin all three halves together:
// the palette table, the render-time lookup, and the generation bump —
// a rendering change without a bump never reaches a homescreen.
test('the widget PNG carries a light AND a dark palette', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'home.js'),
    'utf8'
  );
  // Light: unchanged from the original single-palette treatment.
  assert.match(
    src,
    /light: \{ face: '#ffffff', hairline: '#e4e4e7', letter: '#a1a1aa' \}/,
    'light palette matches the in-app light tile'
  );
  // Dark: --bg-secondary / --border / --text-faint under `.dark`.
  assert.match(
    src,
    /dark: \{ face: '#1a1a30', hairline: '#2e2e50', letter: '#9898b0' \}/,
    'dark palette matches the in-app dark tile'
  );
  // Emoji keep their own colour glyphs in BOTH palettes.
  assert.match(src, /app\.icon_emoji \? null : palette\.letter/);
  assert.match(src, /WIDGET_ICON_GEN: 5,/);
});

// The PNG lands on the iOS homescreen, which renders under the SYSTEM
// appearance — it cannot see SV's in-app Light/Dark/System override.
// Keying the palette off `.dark` / Theme.get() would paint a light
// widget onto a dark homescreen for anyone who forces SV to light.
test('the widget palette keys off the system scheme, not the .dark class', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'home.js'),
    'utf8'
  );
  const scheme = src.match(/_widgetScheme\(\) \{[\s\S]*?\n  \},/);
  assert.ok(scheme, '_widgetScheme is defined');
  assert.doesNotMatch(scheme[0], /classList/, 'does not read the .dark class');
  assert.doesNotMatch(scheme[0], /Theme/, 'does not read the in-app theme');
  assert.match(src, /_schemeQuery\(\) \{[\s\S]*?prefers-color-scheme: dark/);
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

// _desiredIconSrcFor calls _widgetScheme on every heal pass, so a throw
// where matchMedia is missing (old WebViews, this sandbox) would break
// icon healing outright rather than just the palette choice.
test('_widgetScheme falls back to light without matchMedia', () => {
  const Home = makeHome();
  assert.equal(Home.__sandbox.window.matchMedia, undefined, 'sandbox has no matchMedia');
  assert.equal(Home._widgetScheme(), 'light');
  assert.doesNotThrow(() => Home._desiredIconSrcFor(baseApp()));
});

test('_widgetScheme tracks the media query when matchMedia exists', () => {
  const Home = makeHome();
  let dark = false;
  Home.__sandbox.matchMedia = (q) => ({
    media: q,
    get matches() { return dark; },
    addEventListener: () => {},
  });
  assert.equal(Home._widgetScheme(), 'light');
  dark = true;
  assert.equal(Home._widgetScheme(), 'dark');
});

// The scheme rides in the canvas-tile marker (that's what makes a flip
// re-send), but NOT in the image-icon marker — an app's own icon URL
// looks the same in both schemes, so folding it in would re-send every
// image tile on each flip for no visual change.
test('the scheme is part of the canvas-tile marker only', () => {
  const Home = makeHome();
  let dark = false;
  Home.__sandbox.matchMedia = () => ({ get matches() { return dark; }, addEventListener: () => {} });

  const letter = baseApp();
  const emoji = baseApp({ icon_emoji: '🎮' });
  const image = baseApp({ icon_url: '/app-icons/' + 'a'.repeat(32) });

  assert.equal(Home._desiredIconSrcFor(letter), `tile:${Home.WIDGET_ICON_GEN}:light:`);
  assert.equal(Home._desiredIconSrcFor(emoji), `tile:${Home.WIDGET_ICON_GEN}:light:🎮`);
  const imageSrc = Home._desiredIconSrcFor(image);

  dark = true;
  assert.equal(Home._desiredIconSrcFor(letter), `tile:${Home.WIDGET_ICON_GEN}:dark:`);
  assert.equal(Home._desiredIconSrcFor(emoji), `tile:${Home.WIDGET_ICON_GEN}:dark:🎮`);
  assert.equal(
    Home._desiredIconSrcFor(image), imageSrc,
    'image icons keep one scheme-independent marker'
  );
});
