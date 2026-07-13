// Home-card icons use one generated identity grammar: first letter plus
// deterministic name color. Legacy dapp.json icon metadata must not change it.
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
  assert.match(html, /style="--app-icon-bg:hsl\(\d+ 45% 22%\);--app-icon-fg:hsl\(\d+ 70% 70%\)"/);
  assert.match(html, />\s*D\s*</);
  assert.doesNotMatch(html, /<img/);
});

test('generated icon colors are deterministic and vary by name', () => {
  const Home = makeHome();
  assert.deepEqual(
    { ...Home.nameToColor('Demo App') },
    { ...Home.nameToColor('Demo App') }
  );
  assert.notEqual(Home.nameToHue('Demo App'), Home.nameToHue('Puzzle Orbit'));
});

test('declared emoji is ignored in favor of the generated letter tile', () => {
  const html = makeHome().renderAppCard(baseApp({ icon_emoji: '🎮' }));
  assert.match(html, /data-icon="letter"/);
  assert.match(html, />\s*D\s*</);
  assert.doesNotMatch(html, /🎮/);
  assert.doesNotMatch(html, /<img/);
});

test('declared image is ignored in favor of the generated letter tile', () => {
  const html = makeHome().renderAppCard(
    baseApp({ icon_emoji: '🎮', icon_url: '/app-icons/' + 'a'.repeat(32) })
  );
  assert.match(html, /data-icon="letter"/);
  assert.match(html, />\s*D\s*</);
  assert.doesNotMatch(html, /<img/);
});

test('legacy icon metadata is never interpolated into card markup', () => {
  const html = makeHome().renderAppCard(
    baseApp({ icon_url: '/x"><script>alert(1)</script>' })
  );
  assert.doesNotMatch(html, /icon_url|\/x/);
  assert.doesNotMatch(html, /<script>/);
});

test('legacy icon updates keep a mounted tile on the generated identity', () => {
  const Home = makeHome();
  const tile = { dataset: { icon: 'letter' }, innerHTML: 'D', style: { cssText: '' } };
  const card = {
    querySelector: (sel) => (sel === '[data-icon]' ? tile : { textContent: 'Demo App' }),
  };
  Home.__sandbox.document.querySelector = (sel) =>
    sel === '.app-card[data-slug="demo"]' ? card : null;
  Home._apps = [baseApp()];

  Home.updateAppCardIcon('demo', '🚀', null);
  assert.equal(tile.dataset.icon, 'letter');
  assert.equal(tile.innerHTML, 'D');
  assert.doesNotMatch(tile.innerHTML, /🚀/);

  Home.updateAppCardIcon('demo', null, '/app-icons/' + 'b'.repeat(32));
  assert.equal(tile.dataset.icon, 'letter');
  assert.equal(tile.innerHTML, 'D');

  // Cleared back to the letter fallback (derived from the cached name).
  Home.updateAppCardIcon('demo', null, null);
  assert.equal(tile.dataset.icon, 'letter');
  assert.equal(tile.innerHTML, 'D');
  assert.match(tile.style.cssText, /--app-icon-bg:hsl\(/);
});

test('rename refreshes the generated letter and deterministic color', () => {
  const Home = makeHome();
  const nameEl = { textContent: 'Demo App' };
  const tile = { dataset: { icon: 'letter' }, textContent: 'D', style: { cssText: '' } };
  const card = {
    querySelector: (sel) => sel === '.app-card-name' ? nameEl : tile,
  };
  Home.__sandbox.document.querySelector = () => card;
  Home._apps = [baseApp()];

  Home.updateAppCardName('demo', 'Puzzle Orbit');

  assert.equal(nameEl.textContent, 'Puzzle Orbit');
  assert.equal(tile.textContent, 'P');
  assert.match(tile.style.cssText, /--app-icon-bg:hsl\(/);
  assert.equal(Home._apps[0].name, 'Puzzle Orbit');
});

test('updateAppCardIcon is a safe no-op when the card is not mounted', () => {
  const Home = makeHome();
  Home._apps = [];
  assert.doesNotThrow(() => Home.updateAppCardIcon('ghost', '🎮', null));
});
