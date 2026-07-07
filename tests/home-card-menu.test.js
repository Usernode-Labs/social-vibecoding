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
  return makeHomeEnv(user).Home;
}

// Like makeHome, but also hands back the vm sandbox (=== window inside
// the script) so tests can stub `window.usernode` for bridge-call flows.
function makeHomeEnv(user) {
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
    URL,
    location: { search: '', origin: 'https://sv.test' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, sandbox };
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

test('card: one hamburger trigger, none of the old corner buttons', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const html = Home.renderAppCard(baseApp());
  assert.equal((html.match(/card-menu-btn/g) || []).length, 1, 'exactly one menu trigger');
  // The trigger is a hamburger SVG (three horizontal lines), not the
  // old "⋯" glyph.
  assert.match(html, /card-menu-btn[\s\S]*?M4 6h16M4 12h16M4 18h16/, 'hamburger icon path');
  assert.doesNotMatch(html, /⋯/, 'no ⋯ glyph anywhere on the card');
  assert.doesNotMatch(html, /star-btn/, 'no inline star');
  assert.doesNotMatch(html, /lock-btn/, 'no inline lock');
  assert.doesNotMatch(html, /delete-btn/, 'no inline delete');
  assert.doesNotMatch(html, /check-updates-btn/, 'no inline check-updates');
});

// ── Pills: menu-header-only builder ───────────────────────────────

test('renderAppPillsHtml: always display-only spans, ordered, self-trimming', () => {
  const Home = makeHome({ id: ME });
  const app = baseApp({ open_prs: 2, active_sessions: 1, open_issues: 3, missingSecrets: ['K'], view_visibility: 'private' });
  const html = Home.renderAppPillsHtml(app);
  assert.doesNotMatch(html, /<button/, 'no buttons — pills are informational');
  assert.match(html, /Missing secrets/);
  assert.match(html, /2 to vote/);
  assert.match(html, /1 in dev/);
  assert.match(html, /3 issues/);
  assert.match(html, /Private</, 'privacy chip last');
  const order = ['Missing secrets', '2 to vote', '1 in dev', '3 issues', 'Private']
    .map((s) => html.indexOf(s));
  assert.ok(order.every((idx, i) => idx !== -1 && (i === 0 || idx > order[i - 1])),
    'urgency-first ordering preserved');
  // Nothing to flag → empty string, so callers can self-trim.
  assert.equal(Home.renderAppPillsHtml(baseApp()), '');
});

test('menu header: always carries the app’s FULL pill set, inert', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderMenuHeaderHtml(baseApp({
    open_prs: 2, open_issues: 1, missingSecrets: ['K'], view_visibility: 'private',
  }));
  assert.match(html, /card-menu-pills/, 'pills block present');
  assert.match(html, /Missing secrets/);
  assert.match(html, /2 to vote/);
  assert.match(html, /1 issue/);
  assert.match(html, /Private</);
  assert.doesNotMatch(html, /<button/, 'header pills are display-only');
  // No flags → block omitted entirely.
  assert.doesNotMatch(Home.renderMenuHeaderHtml(baseApp()), /card-menu-pills/);
});

test('card layout: icon first with the hamburger badged on its corner, title below', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ active_users: '3' }));
  assert.match(html, /w-14 h-14/, 'large icon');
  // The hamburger badge lives inside the icon wrapper, overlapping its
  // top-right corner — so in markup order: icon initial → menu button
  // → title name.
  const iconIdx = html.indexOf('bg-violet-600/20');
  const menuIdx = html.indexOf('card-menu-btn');
  const nameIdx = html.indexOf('Demo App');
  assert.ok(iconIdx !== -1 && iconIdx < menuIdx && menuIdx < nameIdx,
    'icon → hamburger badge → title order');
  assert.match(html, /card-menu-btn[^"]*absolute -top-1\.5 -right-1\.5/,
    'badge overlaps the icon corner');
  assert.match(html, /card-menu-btn[^"]*rounded-full/, 'badge is round');
  // The old measured-slot machinery is gone from the markup.
  assert.doesNotMatch(html, /card-actions/, 'no floating actions block');
  assert.doesNotMatch(html, /card-footer/, 'no footer row');
  assert.doesNotMatch(html, /card-title-row/, 'no fit-pass title hooks');
});

test('card layout: centered launcher tile, no visible border, capped title width', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp());
  // Icon + title block center horizontally in the tile.
  assert.match(html, /app-card[^"]*flex flex-col items-center text-center/, 'centered column');
  assert.match(html, /flex items-center justify-center[^"]*max-w-full/, 'centered, width-capped title row');
  // Long names truncate with an ellipsis instead of stretching:
  // min-w-0 lets the flex item shrink, truncate clips it.
  assert.match(html, /font-medium text-sm truncate min-w-0/, 'name truncates');
  // The card element itself draws no border — hover tint (app.css) is
  // the affordance. (The hamburger badge keeps its own tiny border.)
  const cardCls = html.match(/class="(app-card [^"]*)"/)[1];
  assert.ok(!/\bborder\b|border-zinc|hover:border/.test(cardCls),
    `no border classes on the card element (got: ${cardCls})`);
});

test('card: Retry pins to the card corner on errored cards, outside the hamburger badge', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ status: 'error', created_by: ME }));
  assert.match(html, /retry-btn[^"]*absolute top-2 right-2/, 'Retry corner-pinned');
  assert.match(html, /card-menu-btn/, 'hamburger badge still present');
  // No Retry on a running card.
  assert.doesNotMatch(Home.renderAppCard(baseApp({ created_by: ME })), /retry-btn/);
});

test('card: active users render as a compact badge beside the title', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ active_users: '12' }));
  assert.match(html, /users-badge[^>]*title="12 active users"[\s\S]*?>12</, 'count + tooltip');
  assert.doesNotMatch(html, /active user(s)?</, 'no spelled-out footer line');
  // Uniform signal: the badge renders at zero too.
  const zero = Home.renderAppCard(baseApp({ active_users: '0' }));
  assert.match(zero, /users-badge[^>]*title="0 active users"/);
  assert.doesNotMatch(zero, /No active users yet/, 'old empty-state line gone');
});

test('card: no pills/chips of any kind on the card face', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({
    open_prs: 2, active_sessions: 1, open_issues: 3,
    missingSecrets: ['STRIPE_SECRET_KEY'], view_visibility: 'private',
  }));
  assert.doesNotMatch(html, /activity-chip/, 'no activity chips');
  assert.doesNotMatch(html, /card-pills/, 'no pills row');
  assert.doesNotMatch(html, /to vote|in dev|issue/, 'no activity labels');
  assert.doesNotMatch(html, /Missing secrets/, 'no missing-secrets chip');
  assert.doesNotMatch(html, /Private</, 'no privacy badge');
  assert.doesNotMatch(html, /pill-overflow/, 'no overflow marker');
  // …but the SAME app's menu header carries the full set.
  const header = Home.renderMenuHeaderHtml(baseApp({
    open_prs: 2, active_sessions: 1, open_issues: 3,
    missingSecrets: ['STRIPE_SECRET_KEY'], view_visibility: 'private',
  }));
  assert.match(header, /Missing secrets/);
  assert.match(header, /2 to vote/);
  assert.match(header, /1 in dev/);
  assert.match(header, /3 issues/);
  assert.match(header, /Private</);
});

test('card: no Created/updated rows and no version pill on the card face', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ active_users: '3' }));
  assert.doesNotMatch(html, /Created /, 'the Created row is gone');
  // "updated Xh ago" lives in the hamburger menu header with the rest
  // of the build info.
  assert.doesNotMatch(html, /updated /, 'no updated segment on the card');
  assert.doesNotMatch(html, /app-version-pill-slot/, 'no pill slot on the card');
});

// ── Missing secrets ───────────────────────────────────────────────

test('missing secrets: key names never render; the chip lives in the menu header only', () => {
  const Home = makeHome({ id: ME });
  const app = baseApp({ missingSecrets: ['STRIPE_SECRET_KEY', 'SENDGRID_API_KEY'] });
  const card = Home.renderAppCard(app);
  assert.doesNotMatch(card, /Missing secrets/, 'no chip on the card face');
  assert.doesNotMatch(card, /STRIPE_SECRET_KEY|SENDGRID_API_KEY/, 'key names stay off the card');
  const header = Home.renderMenuHeaderHtml(app);
  assert.match(header, /bg-red-500\/10 text-red-500[^>]*>Missing secrets</, 'red chip in the header');
  assert.doesNotMatch(header, /STRIPE_SECRET_KEY|SENDGRID_API_KEY/, 'key names stay out of the header too');
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
});

test('menu header: no missing-secrets chip when nothing is missing', () => {
  const Home = makeHome({ id: ME });
  assert.doesNotMatch(Home.renderMenuHeaderHtml(baseApp({ missingSecrets: null })), /Missing secrets/);
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

// ── Native homescreen-shortcut item ───────────────────────────────
//
// The item is gated on Home._shortcutSupport, populated by the bridge
// probe (_probeShortcutSupport). Null (plain browser, probe not run,
// old app build → bridge resolves unsupported) must hide it — pinned
// by every exact-key assertion above running with the default null.

test('menu: shortcut item hidden by default (no support probed)', () => {
  const Home = makeHome({ id: ME });
  assert.equal(Home._shortcutSupport, null, 'probe cache starts null');
  assert.doesNotMatch(
    JSON.stringify(keys(Home.menuItemsFor(baseApp()))),
    /add-to-homescreen/
  );
});

test('menu: shortcut item renders when the bridge reports support', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'pinned-shortcut' };
  // "Your apps" only — favorited (or collaborator) apps get the item.
  const items = Home.menuItemsFor(baseApp({ is_favorited: true }));
  assert.deepEqual(keys(items), ['favorite', 'add-to-homescreen']);
  assert.equal(
    items.find((i) => i.key === 'add-to-homescreen').label,
    'Add to phone home screen'
  );
  // iOS widget mechanism counts as supported too, and names the widget
  // as the destination.
  Home._shortcutSupport = { mechanism: 'widget', widgetInstalled: false };
  const widgetItems = Home.menuItemsFor(baseApp({ is_collaborator: true }));
  const shortcutItem = widgetItems.find((i) => i.key === 'add-to-homescreen');
  assert.ok(shortcutItem, 'item present for widget mechanism');
  assert.equal(shortcutItem.label, 'Add to Usernode widget');
  assert.ok(!shortcutItem.disabled, 'actionable when not yet in the widget');
});

test('menu: shortcut item only offered on "Your apps"', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'widget', widgetInstalled: true };
  // Not favorited, not a collaborator → no item even with support.
  assert.equal(
    keys(Home.menuItemsFor(baseApp())).includes('add-to-homescreen'), false,
    'directory apps do not get the widget item'
  );
  assert.ok(
    keys(Home.menuItemsFor(baseApp({ is_favorited: true }))).includes('add-to-homescreen')
  );
  assert.ok(
    keys(Home.menuItemsFor(baseApp({ is_collaborator: true }))).includes('add-to-homescreen')
  );
});

test('menu: shortcut item becomes "Edit in Usernode widget" once added', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'widget', widgetInstalled: true };
  Home._widgetItems = [
    { id: 'abc', name: 'Demo App', url: 'https://sv.test/#app/demo-app' },
  ];
  // The flip is data-based: it must apply even while the widget section
  // itself is still hidden (_widgetSectionVisible false).
  assert.equal(Home._widgetSectionVisible, false);
  const item = Home.menuItemsFor(baseApp({ is_favorited: true }))
    .find((i) => i.key === 'add-to-homescreen');
  assert.ok(item, 'item still renders');
  assert.equal(item.label, 'Edit in Usernode widget');
  assert.ok(!item.disabled, 'stays actionable — it opens the section');
  // Running it reveals the management section.
  item.run();
  assert.equal(Home._widgetSectionVisible, true, 'edit opens the widget section');
  // An app not yet in the widget keeps the add label.
  const other = Home.menuItemsFor(baseApp({ slug: 'other-app', is_favorited: true }))
    .find((i) => i.key === 'add-to-homescreen');
  assert.equal(other.label, 'Add to Usernode widget');
});

// ── Usernode widget section ───────────────────────────────────────
//
// renderWidgetSection is the iOS-only strip above "Your apps". It must
// render nothing unless BOTH the bridge reported mechanism 'widget' AND
// the registry fetch succeeded (_widgetItems is an array) — old app
// builds time out to null and plain browsers never probe, so the
// section (and its management calls) can't appear where they'd fail.

test('widget section: hidden unless revealed + widget mechanism + registry', () => {
  const Home = makeHome({ id: ME });
  assert.equal(Home.renderWidgetSection(), '', 'no probe → nothing');
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetItems = [
    { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app' },
  ];
  // Everything supported and fetched, but the user hasn't clicked
  // "Add to Usernode widget" yet → still hidden by default.
  assert.equal(Home.renderWidgetSection(), '', 'hidden until revealed');
  Home._widgetSectionVisible = true;
  assert.match(Home.renderWidgetSection(), /id="widget-strip"/, 'revealed');
  Home._widgetItems = null;
  assert.equal(Home.renderWidgetSection(), '', 'no registry fetched → nothing');
  Home._shortcutSupport = { mechanism: 'pinned-shortcut' };
  Home._widgetItems = [];
  assert.equal(Home.renderWidgetSection(), '', 'Android pins → no section');
});

test('menu click: reveals the section and auto-adds when there is room', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetItems = [];
  assert.equal(Home._widgetSectionVisible, false, 'hidden before the click');
  await Home._menuAddShortcut(baseApp({ is_favorited: true }));
  assert.equal(Home._widgetSectionVisible, true, 'click reveals the section');
  assert.equal(added.length, 1, 'app auto-added when the widget has room');
  assert.match(added[0].url, /#app\/demo-app/);
});

test('menu click: full widget shakes instead of adding', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetItems = Array.from({ length: Home.WIDGET_CAPACITY }, (_, i) => (
    { id: `w${i}`, name: `Dapp ${i}`, url: `https://elsewhere.test/${i}` }
  ));
  let shook = false;
  Home._shakeWidgetStrip = () => { shook = true; };
  await Home._menuAddShortcut(baseApp({ is_favorited: true }));
  assert.equal(Home._widgetSectionVisible, true, 'section still revealed');
  assert.equal(added.length, 0, 'nothing added past capacity');
  assert.equal(shook, true, 'the widget strip shakes');
});

test('widget section: tiles in registry order, each with a remove button', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetSectionVisible = true;
  Home._apps = [baseApp()];
  Home._widgetItems = [
    { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app' },
    { id: 'w2', name: 'Other Dapp', url: 'https://elsewhere.test/thing' },
  ];
  const html = Home.renderWidgetSection();
  assert.match(html, /Usernode widget/, 'section header');
  assert.match(html, /id="widget-section-close"/, 'header has a Done/close button');
  assert.match(html, /id="widget-strip"/);
  assert.equal((html.match(/class="widget-tile /g) || []).length, 2);
  assert.equal((html.match(/widget-remove-btn/g) || []).length, 2);
  assert.ok(
    html.indexOf('data-wid="w1"') < html.indexOf('data-wid="w2"'),
    'tiles follow registry order'
  );
  // The SV-app tile resolves its slug; the foreign-dapp tile doesn't.
  assert.match(html, /data-wslug="demo-app"/);
  assert.doesNotMatch(html, /data-wslug="other/i);
  // Empty registry still renders the strip as a drop target.
  Home._widgetItems = [];
  const empty = Home.renderWidgetSection();
  assert.match(empty, /id="widget-strip"/);
  assert.doesNotMatch(empty, /widget-tile /);
  assert.match(empty, /Drag an app card here/);
});

test('widget section: help icon toggles the add-widget instructions', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetSectionVisible = true;
  Home._widgetItems = [];
  let html = Home.renderWidgetSection();
  assert.match(html, /id="widget-section-help"/, 'header has the info button');
  assert.doesNotMatch(html, /widget-help-panel/, 'panel hidden by default');
  Home._widgetHelpVisible = true;
  html = Home.renderWidgetSection();
  assert.match(html, /id="widget-help-panel"/, 'panel shown after toggle');
  assert.match(html, /Add Widget/, 'panel explains the iOS add-widget flow');
});

test('shortcut icons: emoji/letter apps get a canvas data URI, image apps a URL', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  // Fake 2D canvas — the vm sandbox has no real DOM.
  sandbox.document.createElement = () => ({
    getContext: () => ({ fillRect() {}, fillText() {} }),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  await Home._addShortcutForApp(baseApp({ icon_emoji: '\u{1F3AF}' }));
  assert.equal(added[0].icon_url, 'data:image/png;base64,FAKE', 'emoji tile rendered to data URI');
  await Home._addShortcutForApp(baseApp({ icon_url: '/icons/x.png' }));
  assert.equal(added[1].icon_url, 'https://sv.test/icons/x.png', 'real icons pass through as absolute URLs');
});

test('menu: shortcut item hidden when unsupported or app not running', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'unsupported' };
  assert.equal(
    keys(Home.menuItemsFor(baseApp())).includes('add-to-homescreen'), false,
    'explicit unsupported hides it'
  );
  Home._shortcutSupport = { mechanism: 'pinned-shortcut' };
  for (const status of ['error', 'creating', 'awaiting_secrets']) {
    assert.equal(
      keys(Home.menuItemsFor(baseApp({ status }))).includes('add-to-homescreen'),
      false,
      `hidden on ${status} apps`
    );
  }
});
