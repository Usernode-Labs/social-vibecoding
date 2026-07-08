// Homepage restructure: the "Your apps" partition and the client-side
// search matcher in public/js/home.js.
//
// "Your apps" = is_collaborator (app_collaborators membership — creator
// or accepted invite) OR is_favorited (manual add via the "…" menu).
// Ordering inside the section: explicit favorite_order first
// (ascending), NULLs after, preserving the server's activity order
// among un-ordered entries (stable sort). The search matcher is a
// case-insensitive substring test on name and slug; an empty /
// whitespace query matches everything.
//
// home.js is a plain browser script (`const Home = {…}`); we load it
// into a vm context with stubbed globals and call the pure helpers
// directly — same harness as proposal-conflict-affordance.test.js.
//
// Run with: node --test tests/home-your-apps-partition.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'home.js'),
  'utf8'
);

function makeHome() {
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => {
        let t = '';
        return {
          set textContent(v) { t = String(v); },
          get innerHTML() {
            return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          },
        };
      },
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    confirm: () => true,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return sandbox.__Home;
}

const app = (over) => ({
  slug: 'some-app',
  name: 'Some App',
  is_collaborator: false,
  is_favorited: false,
  favorite_order: null,
  ...over,
});

// ── isYours ───────────────────────────────────────────────────────

test('isYours: membership OR favorite puts an app in "Your apps"', () => {
  const Home = makeHome();
  assert.equal(Home.isYours(app({ is_collaborator: true })), true, 'member-only');
  assert.equal(Home.isYours(app({ is_favorited: true })), true, 'favorited-only');
  assert.equal(Home.isYours(app({ is_collaborator: true, is_favorited: true })), true);
  assert.equal(Home.isYours(app()), false, 'neither');
  assert.equal(Home.isYours(null), false, 'null-safe');
});

// ── partitionApps ─────────────────────────────────────────────────

test('partitionApps: members and favorites land in yours, everything else in rest', () => {
  const Home = makeHome();
  const member = app({ slug: 'member', is_collaborator: true });
  const starred = app({ slug: 'starred', is_favorited: true });
  const both = app({ slug: 'both', is_collaborator: true, is_favorited: true });
  const other = app({ slug: 'other' });
  const { yours, rest } = Home.partitionApps([other, member, starred, both]);
  assert.deepEqual(yours.map((a) => a.slug).sort(), ['both', 'member', 'starred']);
  assert.deepEqual(rest.map((a) => a.slug), ['other']);
});

test('partitionApps: favorite_order sorts first (ascending), NULLs keep activity order after', () => {
  const Home = makeHome();
  // Server order (activity) is the array order: m1, m2, f2, f1.
  const m1 = app({ slug: 'member-1', is_collaborator: true });           // no order
  const m2 = app({ slug: 'member-2', is_collaborator: true });           // no order
  const f2 = app({ slug: 'fav-2', is_favorited: true, favorite_order: 1 });
  const f1 = app({ slug: 'fav-1', is_favorited: true, favorite_order: 0 });
  const { yours } = Home.partitionApps([m1, m2, f2, f1]);
  assert.deepEqual(
    yours.map((a) => a.slug),
    ['fav-1', 'fav-2', 'member-1', 'member-2'],
    'explicit order first, un-ordered members keep their stable server order after'
  );
});

test('partitionApps: empty and missing input are safe', () => {
  const Home = makeHome();
  // .length checks rather than deepEqual — vm-realm Arrays have a
  // foreign Array.prototype, which deepStrictEqual rejects.
  const empty = Home.partitionApps([]);
  assert.equal(empty.yours.length, 0);
  assert.equal(empty.rest.length, 0);
  const missing = Home.partitionApps(undefined);
  assert.equal(missing.yours.length, 0);
  assert.equal(missing.rest.length, 0);
});

// ── matchesQuery / filterApps ─────────────────────────────────────

test('matchesQuery: case-insensitive substring on name and slug', () => {
  const Home = makeHome();
  const a = app({ name: 'Chess Arena', slug: 'chess-arena-3f2a' });
  assert.equal(Home.matchesQuery(a, 'chess'), true);
  assert.equal(Home.matchesQuery(a, 'CHESS'), true, 'case-insensitive');
  assert.equal(Home.matchesQuery(a, 'ss are'), true, 'substring anywhere in the name');
  assert.equal(Home.matchesQuery(a, '3f2a'), true, 'slug matches too');
  assert.equal(Home.matchesQuery(a, 'checkers'), false);
});

test('matchesQuery: empty / whitespace-only query matches everything', () => {
  const Home = makeHome();
  const a = app({ name: 'Anything' });
  assert.equal(Home.matchesQuery(a, ''), true);
  assert.equal(Home.matchesQuery(a, '   '), true);
  assert.equal(Home.matchesQuery(a, null), true);
});

test('filterApps: returns only the matches, in input order', () => {
  const Home = makeHome();
  const apps = [
    app({ name: 'Chess Arena', slug: 'chess' }),
    app({ name: 'Puzzle Chain', slug: 'puzzle' }),
    app({ name: 'Word Garden', slug: 'word' }),
  ];
  assert.deepEqual(Home.filterApps(apps, 'zz').map((a) => a.slug), ['puzzle']);
  assert.deepEqual(Home.filterApps(apps, 'ar').map((a) => a.slug), ['chess', 'word']);
  assert.deepEqual(Home.filterApps(apps, '').map((a) => a.slug), ['chess', 'puzzle', 'word']);
  assert.deepEqual(Home.filterApps(apps, 'nope'), []);
});
