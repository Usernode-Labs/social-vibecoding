// Dev-board "App listing" editor (app-view.js): the card on the Dev
// card list and the #app/<slug>/dev/listing edit screen are
// collaborator-only (the server's PATCH gate is the authority — this
// pins the matching client UX), and the editor carries the specced
// copy: Category chips Game/Tool (single-select, clearable), the
// 80-char tagline with helper + live counter, and Save.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we
// load it into a vm context with stubbed DOM globals and assert on the
// innerHTML renderDevView / _renderListingView produce — same harness
// as card-action-layout.test.js.
//
// Run with: node --test tests/dev-listing-editor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// Generic element stub: enough surface for the render paths we drive
// (innerHTML capture, listener registration, class toggles, child
// queries that can safely come back empty).
function fakeEl() {
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    scrollTo: () => {},
  };
}

function makeAppView(appData) {
  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, fakeEl());
    return els.get(id);
  };
  const sandbox = {
    console,
    App: { user: { id: 1 }, currentApp: appData.slug, switchTab: () => {} },
    GroupChat: { unmountThread: () => {} },
    DevChat: {},
    Kudos: { renderButton: () => '' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: getEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => fakeEl(),
      body: { appendChild: () => {} },
    },
    window: null,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: () => ({ matches: false }),
    innerWidth: 800,
    location: { hash: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = appData;
  return { AppView, getEl };
}

const baseApp = (over) => ({
  id: 1,
  slug: 'demo-app',
  name: 'Demo App',
  status: 'running',
  self_hosted: false,
  is_collaborator: true,
  category: null,
  tagline: null,
  ...over,
});

// Drive renderDevView and hand back whatever landed in #app-content.
// The card-list path runs wiring we don't stub exhaustively — innerHTML
// is assigned before any of it, so a late stub gap can't hide the
// markup we assert on.
async function renderDev(AppView, getEl, subTab) {
  const content = getEl('app-content');
  content.innerHTML = '';
  try {
    await AppView.renderDevView(subTab);
  } catch { /* post-render wiring against stubs — markup already set */ }
  return content.innerHTML;
}

test('card list: collaborators get the App listing card with the specced copy', async () => {
  const { AppView, getEl } = makeAppView(baseApp());
  const html = await renderDev(AppView, getEl, 'forum');
  assert.match(html, /dev-listing-card/);
  assert.match(html, /App listing/);
  assert.match(html, /Edit the category and tagline people see when they find this app/);
});

test('card list: non-collaborators do not see the App listing card', async () => {
  const { AppView, getEl } = makeAppView(baseApp({ is_collaborator: false }));
  const html = await renderDev(AppView, getEl, 'forum');
  assert.match(html, /General chat/, 'card list rendered');
  assert.doesNotMatch(html, /dev-listing-card/);
  assert.doesNotMatch(html, /App listing/);
});

test('route: dev/listing renders the editor for collaborators', async () => {
  const { AppView, getEl } = makeAppView(baseApp({ category: 'game', tagline: 'Race friends' }));
  const html = await renderDev(AppView, getEl, 'listing');
  assert.match(html, /App listing/);
  assert.match(html, />Category</);
  assert.match(html, /data-listing-cat="game"[^>]*>Game</);
  assert.match(html, /data-listing-cat="tool"[^>]*>Tool</);
  assert.match(html, />Tagline</);
  assert.match(html, /One line saying what people do with this app. Up to 80 characters/);
  assert.match(html, /maxlength="80"/);
  assert.match(html, /id="listing-tagline"[^>]*value="Race friends"/);
  assert.match(html, /12\/80/, 'live counter seeds from the current tagline');
  assert.match(html, /id="listing-save"[^>]*>Save</);
});

test('route: dev/listing bounces non-collaborators to the card list', async () => {
  const { AppView, getEl } = makeAppView(baseApp({ is_collaborator: false }));
  const html = await renderDev(AppView, getEl, 'listing');
  assert.doesNotMatch(html, /listing-tagline/, 'no editor');
  assert.match(html, /General chat/, 'card list instead');
});

test('editor: the stored category chip renders selected (aria-pressed)', async () => {
  const { AppView, getEl } = makeAppView(baseApp({ category: 'tool' }));
  const html = await renderDev(AppView, getEl, 'listing');
  assert.match(html, /data-listing-cat="tool"[^>]*aria-pressed="true"/);
  assert.match(html, /data-listing-cat="game"[^>]*aria-pressed="false"/);
});

test('editor: tagline value is attribute-escaped', async () => {
  const { AppView, getEl } = makeAppView(baseApp({ tagline: '"quoted" <tag>' }));
  const html = await renderDev(AppView, getEl, 'listing');
  assert.doesNotMatch(html, /value=""quoted"/);
  assert.ok(html.includes('&quot;quoted&quot; &lt;tag&gt;'));
});

test('chip classes: selected vs idle come from one composer', () => {
  const { AppView } = makeAppView(baseApp());
  const active = AppView._listingChipCls(true);
  const idle = AppView._listingChipCls(false);
  assert.match(active, /border-violet-500/);
  assert.doesNotMatch(idle, /border-violet-500/);
  assert.match(idle, /border-zinc-200/);
});
