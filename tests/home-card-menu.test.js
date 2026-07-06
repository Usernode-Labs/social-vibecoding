// Homepage restructure: compact app cards + the "…" actions menu in
// public/js/home.js.
//
// Contract pinned here:
//   - renderAppCard emits exactly one `.card-menu-btn` trigger and none
//     of the old corner buttons (star / lock / delete / check-updates);
//   - the inline Retry button appears ONLY on errored cards, for the
//     creator or a full admin (canAdminWrite — view-only admins are
//     excluded, issue #311);
//   - menuItemsFor gates each item exactly like the old corner buttons
//     did: favorite-toggle for non-members (everyone gets ≥1 item),
//     check-updates/lock/delete behind canAdminWrite, retry behind
//     errored + creator-or-admin. Member apps get no favorite item
//     (membership isn't removable from the menu).
//
// home.js is a plain browser script (`const Home = {…}`); we load it
// into a vm context, stub the globals it reaches, and assert on the
// returned HTML / item lists — same harness as
// proposal-conflict-affordance.test.js.
//
// Run with: node --test tests/home-card-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'home.js'),
  'utf8'
);

function makeHome(user) {
  const sandbox = {
    console,
    App: { user },
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

const ME = 42;
const OTHER = 999;

const baseApp = (over) => ({
  id: 1,
  slug: 'demo-app',
  name: 'Demo App',
  status: 'running',
  created_by: OTHER,
  created_at: '2026-06-01T00:00:00Z',
  last_deploy_at: null,
  repo_url: 'https://github.com/o/r',
  self_hosted: false,
  locked: false,
  is_collaborator: false,
  is_favorited: false,
  active_users: '0',
  open_prs: 0,
  active_sessions: 0,
  open_issues: 0,
  ...over,
});

// ── Compact card markup ───────────────────────────────────────────

test('card: one "…" trigger, none of the old corner buttons', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const html = Home.renderAppCard(baseApp());
  assert.equal((html.match(/card-menu-btn/g) || []).length, 1, 'exactly one ⋯ trigger');
  assert.doesNotMatch(html, /star-btn/, 'no inline star');
  assert.doesNotMatch(html, /lock-btn/, 'no inline lock');
  assert.doesNotMatch(html, /delete-btn/, 'no inline delete');
  assert.doesNotMatch(html, /check-updates-btn/, 'no inline check-updates');
});

test('card: single collapsed meta line, no "Created" row', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ active_users: '3' }));
  assert.match(html, />3<\/span> active users · updated /, 'stats collapse onto one line');
  assert.doesNotMatch(html, /Created /, 'the Created row is gone');
  // The version-pill slot survives (Home.updateAppCardPill targets it).
  assert.match(html, /app-version-pill-slot/);
});

test('card: Retry renders inline only on errored cards, creator or full admin', () => {
  // Creator of an errored app → inline Retry.
  let Home = makeHome({ id: ME });
  assert.match(Home.renderAppCard(baseApp({ status: 'error', created_by: ME })), /retry-btn/);
  // Full admin, not creator → inline Retry.
  Home = makeHome({ id: ME, canAdminWrite: true });
  assert.match(Home.renderAppCard(baseApp({ status: 'error' })), /retry-btn/);
  // Bystander on an errored app → no Retry.
  Home = makeHome({ id: ME });
  assert.doesNotMatch(Home.renderAppCard(baseApp({ status: 'error' })), /retry-btn/);
  // Creator of a RUNNING app → no Retry.
  assert.doesNotMatch(Home.renderAppCard(baseApp({ created_by: ME })), /retry-btn/);
});

// ── Menu item gating ──────────────────────────────────────────────

// Copy into a host-realm array — vm-realm Arrays have a foreign
// Array.prototype, which deepStrictEqual rejects.
const keys = (items) => Array.from(items, (i) => i.key);

test('menu: plain user on a non-member app gets exactly the favorite toggle', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp());
  assert.deepEqual(keys(items), ['favorite'], 'nothing admin-gated leaks');
  assert.equal(items[0].label, 'Add to Your apps');
});

test('menu: favorited app flips the label to Remove', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp({ is_favorited: true }));
  assert.equal(items[0].label, 'Remove from Your apps');
});

test('menu: member apps get no favorite item (membership is not removable here)', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp({ is_collaborator: true }));
  assert.equal(items.find((i) => i.key === 'favorite'), undefined);
});

test('menu: full admin on a running repo app gets check-updates, lock and delete', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const items = Home.menuItemsFor(baseApp());
  assert.deepEqual(keys(items), ['favorite', 'check-updates', 'lock', 'delete']);
  assert.equal(items.find((i) => i.key === 'lock').label, 'Lock app');
  assert.equal(items.find((i) => i.key === 'delete').danger, true);
});

test('menu: locked app offers Unlock', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const items = Home.menuItemsFor(baseApp({ locked: true }));
  assert.equal(items.find((i) => i.key === 'lock').label, 'Unlock app');
});

test('menu: check-updates hidden without repo / when not running / when self-hosted', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const has = (over) =>
    keys(Home.menuItemsFor(baseApp(over))).includes('check-updates');
  assert.equal(has({}), true, 'baseline: admin + repo + running');
  assert.equal(has({ repo_url: null }), false, 'no repo');
  assert.equal(has({ status: 'error' }), false, 'not running');
  assert.equal(has({ self_hosted: true }), false, 'self-hosted');
});

test('menu: view-only admins (no canAdminWrite) get no mutating items (#311)', () => {
  const Home = makeHome({ id: ME, isAdmin: true, canAdminWrite: false });
  const items = Home.menuItemsFor(baseApp({ status: 'error' }));
  assert.deepEqual(keys(items), ['favorite'], 'no retry/check/lock/delete');
});

test('menu: errored app adds Retry for the creator', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp({ status: 'error', created_by: ME }));
  assert.deepEqual(keys(items), ['favorite', 'retry']);
});
