const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'home.js'), 'utf8');

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle: (name, force) => force ? values.add(name) : values.delete(name),
    contains: (name) => values.has(name),
  };
}

function makeHome(user = { id: 1, canCreateApps: true }) {
  const list = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const empty = { classList: classList() };
  const search = { classList: classList() };
  const elements = { 'app-list': list, 'empty-state': empty, 'home-search-bar': search };
  const sandbox = {
    console,
    App: { user, navigateToApp: () => {}, showCreateModal: () => {} },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => {
        let text = '';
        return {
          set textContent(value) { text = String(value); },
          get innerHTML() {
            return text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
          },
        };
      },
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    location: { search: '' },
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    alert: () => {}, confirm: () => true,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, list };
}

function app(slug, overrides = {}) {
  return {
    slug,
    name: slug,
    status: 'running',
    active_users: 4,
    category: null,
    tagline: null,
    is_collaborator: false,
    is_favorited: false,
    favorite_order: null,
    ...overrides,
  };
}

test('home renders create, Favorites, category rails, then uncategorized apps', () => {
  const { Home, list } = makeHome();
  Home._apps = [
    app('saved', { is_favorited: true, category: 'game', tagline: 'Open quickly' }),
    app('puzzle', { category: 'game', tagline: 'Solve with friends' }),
    app('notes', { category: 'tool', tagline: 'Keep a shared list' }),
    app('legacy'),
  ];
  Home.render();

  const html = list.innerHTML;
  const create = html.indexOf('Create an app');
  const favorites = html.indexOf('Favorites');
  const games = html.indexOf('Games');
  const tools = html.indexOf('Tools');
  const all = html.indexOf('All apps');
  assert.ok(create < favorites && favorites < games && games < tools && tools < all);
  assert.match(html, /home-category-rail/);
  assert.match(html, /data-slug="saved"[^>]*data-destination="app"/);
  assert.match(html, /data-slug="puzzle"[^>]*data-destination="app"/);
  assert.match(html, /data-slug="notes"[^>]*data-destination="app"/);
});

test('active search flattens results and shows the specified empty state', () => {
  const { Home, list } = makeHome();
  Home._apps = [app('chess', { category: 'game', tagline: 'Play a quick match' })];
  Home._query = 'quick';
  Home.render();
  assert.match(list.innerHTML, /1 result/);
  assert.doesNotMatch(list.innerHTML, /Favorites|Games/);
  assert.match(list.innerHTML, /data-destination="app"/);

  Home._query = 'wallet';
  Home.render();
  assert.match(list.innerHTML, /No matches\. Try a category like games or tools/);
});
