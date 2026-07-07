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

test('card layout: big icon left, footer row carries meta + ⋯ (no corner pin)', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ active_users: '3' }));
  assert.match(html, /w-14 h-14/, 'large left icon');
  assert.doesNotMatch(html, /absolute top-2 right-2/, 'actions no longer corner-pinned');
  // The ⋯ trigger sits AFTER the meta line in the footer row (meta on
  // the left, actions to its right).
  const metaIdx = html.indexOf('active user');
  const menuIdx = html.indexOf('card-menu-btn');
  assert.ok(metaIdx !== -1 && menuIdx !== -1 && metaIdx < menuIdx,
    '⋯ renders to the right of the active-users meta line');
  // Pills row (when present) renders between the title and the footer.
  const withChips = Home.renderAppCard(baseApp({ open_prs: 2 }));
  const titleIdx = withChips.indexOf('Demo App');
  const chipIdx = withChips.indexOf('2 to vote');
  const footIdx = withChips.indexOf('card-menu-btn');
  assert.ok(titleIdx < chipIdx && chipIdx < footIdx, 'title → pills → footer order');
});

test('card: privacy badge renders inline in the pills row', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ view_visibility: 'private', open_prs: 1 }));
  assert.match(html, />\s*Private</, 'privacy chip present');
  // Same row container as the activity chips — the badge follows the
  // chips inside one flex-wrap row rather than its own <p> under the
  // title.
  assert.doesNotMatch(html, /<p><span[^>]*>[^<]*<\/span><\/p>/, 'no paragraph-wrapped badge');
  const chipIdx = html.indexOf('1 to vote');
  const visIdx = html.indexOf('Private<');
  assert.ok(chipIdx !== -1 && visIdx !== -1 && chipIdx < visIdx, 'badge after activity chips');
});

test('card: meta line is active-users only — no Created/updated rows, no version pill', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ active_users: '3' }));
  assert.match(html, />3<\/span> active users/, 'active-users count present');
  assert.doesNotMatch(html, /Created /, 'the Created row is gone');
  // "updated Xh ago" moved into the "…" menu header with the rest of
  // the build info.
  assert.doesNotMatch(html, /updated /, 'no updated segment on the card');
  // Build info moved into the "…" menu header — the card face carries
  // no commit pill / pill slot anymore.
  assert.doesNotMatch(html, /app-version-pill-slot/, 'no pill slot on the card');
});

// ── Missing-secrets chip ──────────────────────────────────────────

test('card: missing secrets render as a red chip, never the key names', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({
    missingSecrets: ['STRIPE_SECRET_KEY', 'SENDGRID_API_KEY'],
  }));
  assert.match(html, /activity-chip[^>]*bg-red-500\/10 text-red-500[^>]*>Missing secrets</,
    'red chip styled like the other activity chips');
  assert.doesNotMatch(html, /STRIPE_SECRET_KEY/, 'key names stay off the card');
  assert.doesNotMatch(html, /SENDGRID_API_KEY/, 'key names stay off the card');
  assert.doesNotMatch(html, /Missing secrets:/, 'old key-listing warning line is gone');
  // No deep-link target (the Secrets modal is not hash-routable) —
  // the chip is an inert span even on a clickable running card.
  assert.doesNotMatch(html, /<button[^>]*>Missing secrets</, 'chip is not a button');
});

test('card: awaiting-secrets keeps its status line, without the key list', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({
    status: 'awaiting_secrets',
    missingSecrets: ['STRIPE_SECRET_KEY'],
  }));
  assert.match(html, />Awaiting secrets</, 'status label stays');
  assert.doesNotMatch(html, /Awaiting secrets:/, 'no key suffix on the label');
  assert.doesNotMatch(html, /STRIPE_SECRET_KEY/, 'key names stay off the card');
  assert.match(html, />Missing secrets</, 'red chip flags the state');
});

test('card: no missing-secrets chip when nothing is missing', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ missingSecrets: null }));
  assert.doesNotMatch(html, /Missing secrets/);
});

// ── Menu build-info header ────────────────────────────────────────

test('menu header: full untruncated name, slug and deployed commit', () => {
  const Home = makeHome({ id: ME });
  const longName = 'A Very Long Application Name That The Card Face Truncates';
  const html = Home.renderMenuHeaderHtml(baseApp({
    name: longName,
    version: { sha: 'abc1234def', shortSha: 'abc1234' },
  }));
  assert.match(html, /card-menu-title/, 'title block present');
  assert.ok(html.includes(longName), 'full name, untruncated');
  assert.match(html, /card-menu-slug/, 'slug line present');
  assert.ok(html.includes('demo-app'), 'slug shown');
  assert.match(html, /card-menu-version/, 'version block present');
  // AppView is absent in this sandbox, so the fallback commit text
  // renders — it must carry the deployed shortSha.
  assert.ok(html.includes('abc1234'), 'deployed commit shown');
  // "Updated Xh ago" lives here now, not on the card face.
  assert.match(html, /card-menu-updated[^>]*>Updated /, 'updated line present');
});

test('menu header: no SHA yet falls back to the dev placeholder', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderMenuHeaderHtml(baseApp({ version: null }));
  assert.match(html, /·\s*dev/, 'placeholder when nothing is deployed');
});

test('menu header: app name is HTML-escaped', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderMenuHeaderHtml(baseApp({ name: 'Evil <img> & Co' }));
  assert.doesNotMatch(html, /<img>/, 'raw tag never lands in the markup');
  assert.ok(html.includes('Evil &lt;img&gt; &amp; Co'), 'escaped name present');
});

test('updateAppCardPill: refreshes the cached app so the menu header stays fresh', () => {
  const Home = makeHome({ id: ME });
  const app = baseApp({ version: { sha: 'abc1234def', shortSha: 'abc1234' } });
  Home._apps = [app];
  // Deploy-start event: deployProgress lands in the cache, the cached
  // SHA is preserved (the event deliberately carries version: null).
  Home.updateAppCardPill('demo-app', { deployProgress: { deploying: true }, version: null });
  assert.equal(app.deployProgress.deploying, true);
  assert.equal(app.version.shortSha, 'abc1234', 'cached SHA survives deploy start');
  // A version-carrying event replaces it.
  Home.updateAppCardPill('demo-app', { deployProgress: null, version: { shortSha: 'def5678' } });
  assert.equal(app.deployProgress, null);
  assert.equal(app.version.shortSha, 'def5678');
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

test('menu: member apps get a DISABLED "In Your apps" row, never a Remove', () => {
  // The entry must render for every app so the affordance is always
  // discoverable — a user who is a member of every app they open
  // (e.g. the creator of most apps on an instance) would otherwise
  // never see the selector anywhere. Membership isn't removable, so
  // the row is informational and inert.
  const Home = makeHome({ id: ME });
  const fav = Home.menuItemsFor(baseApp({ is_collaborator: true }))
    .find((i) => i.key === 'favorite');
  assert.ok(fav, 'favorite entry present on member apps');
  assert.equal(fav.disabled, true, 'but disabled (membership is not removable)');
  assert.match(fav.label, /In Your apps/);
  assert.doesNotMatch(fav.label, /Remove/, 'no Remove offered on member apps');
  assert.equal(fav.run, undefined, 'no action wired');
  // Even a favorited member app never offers Remove (removing the
  // favorite row would change nothing — membership keeps it in the
  // section).
  const favBoth = Home.menuItemsFor(baseApp({ is_collaborator: true, is_favorited: true }))
    .find((i) => i.key === 'favorite');
  assert.equal(favBoth.disabled, true);
  assert.doesNotMatch(favBoth.label, /Remove/);
});

test('menu: every app carries a favorite entry — no card menu omits it', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  for (const over of [
    {},
    { is_collaborator: true },
    { is_favorited: true },
    { status: 'error', created_by: ME },
    { self_hosted: true },
  ]) {
    const items = Home.menuItemsFor(baseApp(over));
    assert.equal(items[0].key, 'favorite', `favorite entry first for ${JSON.stringify(over)}`);
  }
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
