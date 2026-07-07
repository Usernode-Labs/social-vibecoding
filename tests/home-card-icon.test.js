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
