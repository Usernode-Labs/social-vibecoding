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
//     did: favorite-toggle on every app (everyone gets ≥1 item),
//     check-updates/lock/delete behind canAdminWrite, retry behind
//     errored + creator-or-admin. #618: member apps get a working
//     Remove/Add pair driven by the per-user your_apps_hidden flag
//     (display-only opt-out; membership/access untouched).
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
const { installAppCard } = require('./helpers/app-card');

const HOME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'home.js'),
  'utf8'
);

function makeHome(user) {
  return makeHomeEnv(user).Home;
}

// Fake 2D context for _widgetIconDataUrl — the vm sandbox has no real
// DOM. It draws a rounded-rect tile (face + hairline) before the glyph,
// so the stub has to answer the path/stroke calls too, not just
// fillRect/fillText.
//
// `paints` records the colour assigned at each fill()/stroke() call, so
// tests can assert WHICH palette was used without a real canvas: the
// tile face is the first fill, the hairline the first stroke, the glyph
// a later fill (emoji leave fillStyle at the face colour — they carry
// their own colour glyphs and are never recoloured).
function fakeCtx(paints) {
  const rec = (kind) => () => {
    if (paints) {
      paints.push({
        op: kind,
        color: kind === 'stroke' ? ctx.strokeStyle : ctx.fillStyle,
      });
    }
  };
  const ctx = {
    fillStyle: null,
    strokeStyle: null,
    beginPath() {}, closePath() {}, moveTo() {}, arcTo() {}, roundRect() {},
    fill: rec('fill'), stroke: rec('stroke'),
    fillRect: rec('fill'), fillText: rec('fill'),
  };
  return ctx;
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
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    })(),
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
  // home.js delegates iconTileFor / renderAppPillsHtml to window.AppCard
  // (frontend/src/features/apps/app-card.js) since #1083 chunk F.
  installAppCard(sandbox);
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

test('card-menu shot retries after the initial empty home paint', () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const frames = [];
  const opened = [];
  sandbox.location.search = '?demo=1&shot=card-menu';
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.requestAnimationFrame = (fn) => { frames.push(fn); };
  Home.openCardMenu = (slug) => { opened.push(slug); };

  const empty = { offsetParent: {}, querySelector: () => null };
  Home._maybeOpenShotMenu(empty);
  assert.equal(Home._shotMenuPending, true);
  frames.shift()();
  assert.equal(Home._shotMenuPending, false);
  assert.equal(Home._shotMenuDone, false,
    'an empty pre-fetch paint must not consume the one-shot');

  const button = { dataset: { slug: 'demo-app' } };
  const populated = {
    offsetParent: {},
    querySelector: (selector) => (selector === '.card-menu-btn' ? button : null),
  };
  Home._apps = [baseApp()];
  Home._maybeOpenShotMenu(populated);
  frames.shift()();
  assert.equal(Home._shotMenuDone, true);
  assert.deepEqual(opened, ['demo-app']);
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
  const iconIdx = html.indexOf('app-icon-tile');
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
  // Long names wrap to two iOS-sized lines and ellipsise there (#951):
  // .app-card-title in app.css owns the size, the clamp and the fixed
  // two-line lane that keeps every tile the same height.
  assert.match(html, /<div class="app-card-title" title="[^"]*">/, 'clamped title lane');
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

// A launcher tile is an icon and a label. The active-users badge and the
// status dot that used to flank the name are both gone from the tile face:
// the count still shows in the Browse-all DIRECTORY (a ranked list, where
// popularity is the point), and every non-running status still says so in
// words right below the name.
test('card: the tile carries no users badge and no status dot', () => {
  const Home = makeHome({ id: ME });
  for (const users of ['12', '0']) {
    const html = Home.renderAppCard(baseApp({ active_users: users }));
    assert.doesNotMatch(html, /users-badge/, `users=${users}`);
    assert.doesNotMatch(html, /status-dot/, `users=${users}`);
    assert.doesNotMatch(html, /active user/, `users=${users}`);
  }
  // The word-form status signal survives — that is what makes dropping the
  // dot safe for every state except an in-flight redeploy of a RUNNING app,
  // which now shows only in the "…" menu's version pill.
  assert.match(Home.renderAppCard(baseApp({ status: 'creating' })), /Spinning up/);
  assert.match(Home.renderAppCard(baseApp({ status: 'awaiting_secrets' })), /Awaiting secrets/);
  assert.match(Home.renderAppCard(baseApp({ status: 'error' })), /Error/);
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

test('menu: plain user on a non-member app gets App details + the favorite toggle', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp());
  assert.deepEqual(keys(items), ['app-details', 'favorite'], 'nothing admin-gated leaks');
  assert.equal(items[1].label, 'Add to Your apps');
});

test('menu: favorited app flips the label to Remove', () => {
  const Home = makeHome({ id: ME });
  const fav = Home.menuItemsFor(baseApp({ is_favorited: true }))
    .find((i) => i.key === 'favorite');
  assert.equal(fav.label, 'Remove from Your apps');
});

test('menu: member apps get a WORKING Remove from Your apps item (#618)', () => {
  // The entry renders for every app so the affordance is always
  // discoverable. #618: membership no longer hard-pins the app —
  // members (creators included) get an active Remove that persists a
  // per-user hidden opt-out row, display-only, access untouched.
  const Home = makeHome({ id: ME });
  const fav = Home.menuItemsFor(baseApp({ is_collaborator: true }))
    .find((i) => i.key === 'favorite');
  assert.ok(fav, 'favorite entry present on member apps');
  assert.equal(fav.disabled, undefined, 'active, not the old inert row');
  assert.equal(fav.label, 'Remove from Your apps');
  assert.equal(typeof fav.run, 'function', 'action wired');
});

test('menu: hidden member apps flip to Add to Your apps (#618)', () => {
  const Home = makeHome({ id: ME });
  const fav = Home.menuItemsFor(baseApp({ is_collaborator: true, your_apps_hidden: true }))
    .find((i) => i.key === 'favorite');
  assert.equal(fav.label, 'Add to Your apps');
  assert.equal(typeof fav.run, 'function');
});

test('menu: member toggle sends the explicit desired value, not !is_favorited (#618)', () => {
  // A pinned member app usually has is_favorited=false, so deriving
  // the target from !is_favorited would send favorited=true (a no-op
  // add) instead of the hide. Pin the wiring by capturing the fetch.
  const Home = makeHome({ id: ME });
  const calls = [];
  Home._menuToggleFavorite = (app, desired) => { calls.push(desired); };
  Home.menuItemsFor(baseApp({ is_collaborator: true }))
    .find((i) => i.key === 'favorite').run();
  Home.menuItemsFor(baseApp({ is_collaborator: true, your_apps_hidden: true }))
    .find((i) => i.key === 'favorite').run();
  Home.menuItemsFor(baseApp({ is_favorited: true }))
    .find((i) => i.key === 'favorite').run();
  Home.menuItemsFor(baseApp())
    .find((i) => i.key === 'favorite').run();
  assert.deepEqual(
    calls,
    [false, true, false, true],
    'visible member → hide, hidden member → re-add, favorite → remove, plain → add'
  );
});

// ── App details ───────────────────────────────────────────────────
//
// The menu's way to the app's own page — the SAME destination a row in
// the browse-all-apps list opens (#apps/<slug>), so the two entry points
// share one screen. Browse.DETAIL_EXCLUDED_KEYS drops it again on that
// page (pinned in tests/browse-screen.test.js) so it can't link to
// itself.

test('menu: App details leads the list, on every app and for every viewer', () => {
  for (const user of [
    { id: ME },
    { id: ME, isAdmin: true, canAdminWrite: false },
    { id: ME, canAdminWrite: true },
  ]) {
    const Home = makeHome(user);
    for (const over of [
      {},
      { is_collaborator: true },
      { is_favorited: true },
      { status: 'error', created_by: ME },
      { self_hosted: true },
      { locked: true },
    ]) {
      const items = Home.menuItemsFor(baseApp(over));
      assert.equal(items[0].key, 'app-details',
        `first for ${JSON.stringify(over)} / ${JSON.stringify(user)}`);
      assert.equal(items[0].label, 'App details');
    }
  }
});

test('menu: App details routes through the hash, like a browse row tap', () => {
  // Assigning location.hash (rather than calling a navigate helper) is
  // what keeps the browser/OS back gesture working.
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  Home.menuItemsFor(baseApp({ slug: 'chess-arena' }))
    .find((i) => i.key === 'app-details').run();
  assert.equal(sandbox.location.hash, '#apps/chess-arena');
});

test('menu: App details escapes the slug into the hash', () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  Home.menuItemsFor(baseApp({ slug: 'a b&c' }))
    .find((i) => i.key === 'app-details').run();
  assert.equal(sandbox.location.hash, `#apps/${encodeURIComponent('a b&c')}`);
});

test('menu: the inert ?demo=1 tiles get no App details row', () => {
  // Their slugs 404 on GET /api/apps/:slug, so the page would open on an
  // inline "not available" state — same reason a demo row doesn't drill in.
  const Home = makeHome({ id: ME });
  assert.ok(!keys(Home.menuItemsFor(baseApp({ demo: true }))).includes('app-details'));
  // …and a slugless row can't be addressed at all.
  assert.ok(!keys(Home.menuItemsFor(baseApp({ slug: null }))).includes('app-details'));
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
    assert.ok(keys(items).includes('favorite'),
      `favorite entry present for ${JSON.stringify(over)}`);
  }
});

test('menu: full admin on a running repo app gets check-updates, lock and delete', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const items = Home.menuItemsFor(baseApp());
  assert.deepEqual(keys(items), ['app-details', 'favorite', 'check-updates', 'lock', 'delete']);
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
  // App details is navigation, not a mutation, so it survives the gate.
  assert.deepEqual(keys(items), ['app-details', 'favorite'],
    'no retry/check/lock/delete');
});

test('menu: errored app adds Retry + View build log for the creator (#416)', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp({ status: 'error', created_by: ME }));
  assert.deepEqual(keys(items), ['app-details', 'favorite', 'retry', 'build-log']);
});

// ── "View build log" gating (#416) ────────────────────────────────
//
// Errored apps: item for involved users (creator / collaborator /
// full admin). Running apps: only when the last recorded failure
// post-dates the last successful deploy (a failed rebuild) — and the
// last_failure_* fields only reach the client when the server-side
// involved-user gate passed, so outsiders never have the timestamps.

test('menu: build-log hidden from outsiders and view-only admins on errored apps (#416)', () => {
  const outsider = makeHome({ id: ME });
  assert.ok(!keys(outsider.menuItemsFor(baseApp({ status: 'error' }))).includes('build-log'));
  const viewOnlyAdmin = makeHome({ id: ME, isAdmin: true, canAdminWrite: false });
  assert.ok(!keys(viewOnlyAdmin.menuItemsFor(baseApp({ status: 'error' }))).includes('build-log'));
});

test('menu: build-log shows for collaborators on errored apps (#416)', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp({ status: 'error', is_collaborator: true }));
  assert.ok(keys(items).includes('build-log'));
});

test('menu: build-log on a RUNNING app only when the failure post-dates the deploy (#416)', () => {
  const Home = makeHome({ id: ME });
  const failedRebuild = baseApp({
    created_by: ME,
    last_deploy_at: '2026-07-01T00:00:00Z',
    last_failure_at: '2026-07-02T00:00:00Z',
    last_failure_reason: 'Build failed: failed to read dockerfile',
  });
  assert.ok(keys(Home.menuItemsFor(failedRebuild)).includes('build-log'));

  const staleFailure = baseApp({
    created_by: ME,
    last_deploy_at: '2026-07-03T00:00:00Z',
    last_failure_at: '2026-07-02T00:00:00Z',
  });
  assert.ok(!keys(Home.menuItemsFor(staleFailure)).includes('build-log'));

  const noFailure = baseApp({ created_by: ME });
  assert.ok(!keys(Home.menuItemsFor(noFailure)).includes('build-log'));
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
  assert.deepEqual(keys(items), ['app-details', 'favorite', 'add-to-homescreen']);
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
  // #618: a member app hidden from "Your apps" is no longer "yours",
  // so the widget item disappears until it's added back.
  assert.equal(
    keys(Home.menuItemsFor(baseApp({ is_collaborator: true, your_apps_hidden: true })))
      .includes('add-to-homescreen'),
    false,
    'hidden member apps lose the widget item'
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
  // The hint names "Your apps" as the drag source now: the home grid holds
  // that one section (every other app moved to the #apps browse screen).
  assert.match(empty, /Drag a card from Your apps here/);
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
    getContext: () => fakeCtx(),
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

test('icon heal: has_icon:false entries are silently re-added once', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
        { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true },
        { id: 'w3', name: 'Foreign', url: 'https://elsewhere.test/x', has_icon: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  // 'Iconed' has a real image icon whose recorded source is current, so
  // with has_icon:true nothing re-sends it.
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  sandbox.localStorage.setItem(
    'sv:widget_icon_src',
    JSON.stringify({ w2: 'https://sv.test/icons/x.png' })
  );
  await Home._refreshWidgetItems();
  // Only the SV app missing its icon is re-added; the healthy entry and
  // the foreign shortcut are left alone. The re-add is marked silent so
  // the app skips the add-the-widget walkthrough.
  assert.equal(added.length, 1);
  assert.match(added[0].url, /#app\/demo-app/);
  assert.equal(added[0].silent, true);
  // Second refresh: already tried — no repeat even though the mock
  // still reports has_icon:false.
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'one heal attempt per id per page load');
});

test('icon heal: retries entries skipped while apps were still loading', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = []; // probe ran before /api/apps resolved
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'nothing healable without app objects');
  Home._apps = [baseApp()];
  await Home._healWidgetIcons();
  assert.equal(added.length, 1, 'healed once the apps list landed');
});

test('icon heal: unknown last-sent source re-sends once, then settles', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
        { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  // Fresh env: no recorded sources → both re-sent once (the recorded
  // source is unknown, so the stored PNG can't be trusted).
  await Home._refreshWidgetItems();
  assert.equal(added.length, 2, 'both entries refreshed when sources are unknown');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(
    srcMap.w1,
    `tile:${Home.WIDGET_ICON_GEN}:${Home._widgetScheme()}:`,
    'canvas tile source recorded, keyed by generation + colour scheme'
  );
  assert.equal(srcMap.w2, 'https://sv.test/icons/x.png', 'image icon source recorded');
  // Sources now recorded → later refreshes send nothing.
  Home._iconHealTried = null; // even across a fresh page load
  await Home._refreshWidgetItems();
  assert.equal(added.length, 2, 'no repeat once sources are recorded');
});

test('icon heal: app gaining an icon after pinning re-sends the new icon', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  // Pinned as a canvas letter tile — recorded source matches, so the
  // first pass sends nothing.
  Home._apps = [baseApp()];
  sandbox.localStorage.setItem(
    'sv:widget_icon_src',
    JSON.stringify({ w1: `tile:${Home.WIDGET_ICON_GEN}:${Home._widgetScheme()}:` })
  );
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'up-to-date tile is left alone');
  // An icon proposal passes: the app now has an icon_url. The widget
  // PNG (still the letter tile) is stale even though has_icon:true.
  Home._apps = [baseApp({ icon_url: '/icons/new.png' })];
  Home._iconHealTried = null; // fresh page load
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'stale tile re-sent after the app gained an icon');
  assert.equal(added[0].icon_url, 'https://sv.test/icons/new.png');
  assert.equal(added[0].silent, true);
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, 'https://sv.test/icons/new.png', 'new source recorded');
});

// ── Widget tile palette follows the system appearance ────────────────
//
// The widget PNG is baked once and can't restyle itself on the
// homescreen, so the palette is picked at render time from
// prefers-color-scheme and the scheme rides in the source marker. A
// light↔dark flip therefore has to (a) paint the other palette and
// (b) actually re-send every pinned canvas tile.

// Installs a settable prefers-color-scheme query on the sandbox and
// returns a setter that fires the registered change listeners, so a
// test can flip the system appearance the way the OS would.
function stubScheme(sandbox, initialDark) {
  let dark = !!initialDark;
  const listeners = [];
  sandbox.matchMedia = (media) => ({
    media,
    get matches() { return dark; },
    addEventListener: (_type, fn) => listeners.push(fn),
    removeEventListener: () => {},
  });
  return (next) => {
    dark = !!next;
    listeners.forEach((fn) => fn({ matches: dark }));
  };
}

test('widget tile PNG paints the light palette in light appearance', () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubScheme(sandbox, false);
  const paints = [];
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(paints),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  Home._widgetIconDataUrl(baseApp());
  const face = paints.find((p) => p.op === 'fill');
  const hairline = paints.find((p) => p.op === 'stroke');
  const glyph = paints.filter((p) => p.op === 'fill').pop();
  assert.equal(face.color, '#ffffff', 'white face');
  assert.equal(hairline.color, '#e4e4e7', 'faint light-grey hairline');
  assert.equal(glyph.color, '#a1a1aa', 'faint grey letter (--text-faint)');
});

test('widget tile PNG paints the dark palette in dark appearance', () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubScheme(sandbox, true);
  const paints = [];
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(paints),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  Home._widgetIconDataUrl(baseApp());
  const face = paints.find((p) => p.op === 'fill');
  const hairline = paints.find((p) => p.op === 'stroke');
  const glyph = paints.filter((p) => p.op === 'fill').pop();
  assert.equal(face.color, '#1a1a30', 'dark face (--bg-secondary)');
  assert.equal(hairline.color, '#2e2e50', 'hairline kept, stepped to --border');
  assert.equal(glyph.color, '#9898b0', 'faint letter (--text-faint, dark)');
  // The hairline is what keeps the tile legible against iOS's own dark
  // widget material — a dark face with no ring would vanish.
  assert.notEqual(hairline.color, face.color);
});

test('widget tile PNG never recolours an emoji glyph', () => {
  for (const dark of [false, true]) {
    const { Home, sandbox } = makeHomeEnv({ id: ME });
    stubScheme(sandbox, dark);
    const paints = [];
    sandbox.document.createElement = () => ({
      getContext: () => fakeCtx(paints),
      toDataURL: () => 'data:image/png;base64,FAKE',
    });
    Home._widgetIconDataUrl(baseApp({ icon_emoji: '\u{1F3AF}' }));
    const palette = Home.WIDGET_TILE_PALETTE[dark ? 'dark' : 'light'];
    const glyph = paints.filter((p) => p.op === 'fill').pop();
    assert.notEqual(glyph.color, palette.letter, 'emoji keep their own colours');
  }
});

test('icon heal: a system light→dark flip re-sends every canvas tile once', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const setDark = stubScheme(sandbox, false);
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
        { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  // Both already pinned with current sources → the first pass is quiet.
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:light:`,
    w2: 'https://sv.test/icons/x.png',
  }));
  Home._watchWidgetScheme();
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'nothing to do while the scheme is unchanged');

  // The phone switches to dark appearance.
  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 1, 'exactly the canvas tile re-sends');
  assert.match(added[0].url, /#app\/demo-app/);
  assert.equal(added[0].silent, true, 're-send stays silent — no walkthrough');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:dark:`, 'dark source recorded');
  assert.equal(srcMap.w2, 'https://sv.test/icons/x.png', 'image tile untouched');

  // A second event at the SAME scheme must not re-send anything: the
  // equality guard is what stops a spurious media event from replaying
  // the whole grid.
  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 1, 'no re-send when the scheme did not move');

  // …and flipping back re-sends once more, in the light palette.
  setDark(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 2, 'flipping back re-sends once');
  const back = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(back.w1, `tile:${Home.WIDGET_ICON_GEN}:light:`);
});

// _iconHealTried caps sends to one attempt per shortcut id per page
// load. A scheme flip marks every canvas tile stale, so without
// clearing that Set the flip would find the work and then skip it —
// the re-send would silently never happen.
test('icon heal: a scheme flip clears the per-load heal-tried set', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const setDark = stubScheme(sandbox, false);
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  Home._watchWidgetScheme();
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'healed once on load');
  assert.ok(Home._iconHealTried && Home._iconHealTried.has('w1'), 'id marked tried');

  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 2, 'the flip re-sends despite the earlier attempt');
});

test('scheme watching is inert without the widget mechanism', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const setDark = stubScheme(sandbox, false);
  const added = [];
  sandbox.usernode = {
    isNative: false,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
  };
  // Plain browser / Android: the probe never reports the widget grid.
  Home._shortcutSupport = null;
  Home._apps = [baseApp()];
  Home._watchWidgetScheme();
  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 0, 'no bridge traffic off the widget path');
});

// ── Dual-icon sender half (#948) ─────────────────────────────────────
//
// Where the shell advertises homeScreenShortcutDarkIcon, SV sends BOTH
// faces and the widget picks per system appearance — natively, with SV
// closed, which is the only way a pinned tile can follow a flip. Where
// it doesn't, every assertion above still holds: the gen-5 single-face
// path is untouched.

// Installs a NativeChrome answering the capability probe. `capable`
// false still installs one, so the "shell exists but lacks the flag"
// case is covered as well as the plain-browser no-NativeChrome case.
function stubCapability(sandbox, capable) {
  sandbox.NativeChrome = {
    has: async (cap) => capable === true && cap === 'homeScreenShortcutDarkIcon',
  };
}

function stubCanvas(sandbox, paints) {
  let n = 0;
  sandbox.document.createElement = () => {
    const mine = ++n;
    return {
      getContext: () => fakeCtx(paints),
      // Distinct bytes per render, so a test can prove the payload
      // carries two DIFFERENT images rather than the same one twice.
      toDataURL: () => `data:image/png;base64,FAKE${mine}`,
    };
  };
}

test('payload: capable shell gets both faces, light first', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, true); // system dark — must not shift the pair
  const paints = [];
  stubCanvas(sandbox, paints);
  await Home._ensureDarkIconCapability();

  const payload = Home._shortcutPayloadFor(baseApp());
  assert.ok(payload.icon_url, 'light asset present');
  assert.ok(payload.icon_url_dark, 'dark asset present');
  assert.notEqual(payload.icon_url, payload.icon_url_dark, 'two distinct images');
  // Face fills, in render order: light tile first, then the dark one.
  const faces = paints.filter((p) => p.op === 'fill').map((p) => p.color);
  assert.ok(faces.includes('#ffffff'), 'light face painted');
  assert.ok(faces.includes('#1a1a30'), 'dark face painted');
  assert.ok(faces.indexOf('#ffffff') < faces.indexOf('#1a1a30'),
    'icon_url is the LIGHT asset — a shell that renders only it stays sane');
});

test('payload: the pair does not move with the system appearance', async () => {
  const shots = [];
  for (const dark of [false, true]) {
    const { Home, sandbox } = makeHomeEnv({ id: ME });
    stubCapability(sandbox, true);
    stubScheme(sandbox, dark);
    const paints = [];
    stubCanvas(sandbox, paints);
    await Home._ensureDarkIconCapability();
    Home._shortcutPayloadFor(baseApp());
    shots.push(paints.filter((p) => p.op === 'fill' || p.op === 'stroke')
      .map((p) => p.color).join(','));
  }
  assert.equal(shots[0], shots[1],
    'identical paints in light and dark — nothing to re-send on a flip');
});

test('payload: non-capable shell keeps the single per-appearance face', async () => {
  for (const [dark, face] of [[false, '#ffffff'], [true, '#1a1a30']]) {
    const { Home, sandbox } = makeHomeEnv({ id: ME });
    stubCapability(sandbox, false);
    stubScheme(sandbox, dark);
    const paints = [];
    stubCanvas(sandbox, paints);
    await Home._ensureDarkIconCapability();

    const payload = Home._shortcutPayloadFor(baseApp());
    assert.ok(payload.icon_url, 'the one asset is sent');
    assert.ok(!('icon_url_dark' in payload),
      'the key is OMITTED, not null — byte-identical to the pre-change payload');
    assert.equal(paints.find((p) => p.op === 'fill').color, face,
      'the face matches the current system appearance');
  }
});

test('payload: no NativeChrome at all behaves exactly like not-capable', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  assert.equal(sandbox.NativeChrome, undefined);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  await Home._ensureDarkIconCapability();
  const payload = Home._shortcutPayloadFor(baseApp());
  assert.ok(!('icon_url_dark' in payload));
});

test('payload: image icons never get a dark twin', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  await Home._ensureDarkIconCapability();

  const payload = Home._shortcutPayloadFor(baseApp({ icon_url: '/icons/x.png' }));
  assert.equal(payload.icon_url, 'https://sv.test/icons/x.png');
  assert.ok(!('icon_url_dark' in payload),
    "the author's artwork is appearance-independent — a second copy is pure waste");
});

// The capable path's whole point: a flip is a non-event, because both
// faces are already on the device and the widget picks between them.
test('icon heal: on a capable shell a light↔dark flip re-sends nothing', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  const setDark = stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true, has_icon_dark: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  await Home._ensureDarkIconCapability();
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:dual:`,
  }));
  Home._watchWidgetScheme();
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'nothing stale to begin with');

  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  setDark(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 0, 'the appearance is not an input on this path');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:dual:`, 'marker unmoved');
});

// Installing a capable shell is the one transition that costs a
// re-send: the stored single face has to become a pair.
test('icon heal: gaining the capability re-sends each canvas tile once', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true, has_icon_dark: true },
        { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true, has_icon_dark: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  // Pinned by a pre-capability build: single light face, image URL.
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:light:`,
    w2: 'https://sv.test/icons/x.png',
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'exactly the canvas tile upgrades');
  assert.ok(added[0].icon_url_dark, 'and it now carries both faces');
  assert.equal(added[0].silent, true, 'silently — no walkthrough, order kept');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:dual:`);
  assert.equal(srcMap.w2, 'https://sv.test/icons/x.png', 'image tile untouched');

  Home._iconHealTried = null; // a later page load
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'and then settles');
});

// The guarantee for everyone on a shell without the flag: this whole
// change is a no-op for them. Same marker, same payload, no churn.
test('icon heal: a non-capable shell sends nothing for a gen-5 entry', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, false);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:light:`,
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'zero churn for the shells people actually have');
});

// has_icon_dark is what catches an entry whose marker already matches
// but whose second asset never landed.
test('icon heal: has_icon_dark:false re-sends a canvas tile once', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true, has_icon_dark: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  await Home._ensureDarkIconCapability();
  // Marker already current — only the flag betrays the missing asset.
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:dual:`,
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'the missing dark asset is re-sent');
  assert.ok(added[0].icon_url_dark);
});

test('icon heal: an absent has_icon_dark key never triggers a send', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    // An older shell reports neither key.
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  await Home._ensureDarkIconCapability();
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:dual:`,
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'undefined is not false — no send');
});

// Image-icon entries are dark-assetless forever by design, so without
// the !app.icon_url clause they would look stale on every single pass.
test('icon heal: an image-icon entry with has_icon_dark:false is left alone', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true, has_icon_dark: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' })];
  await Home._ensureDarkIconCapability();
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: 'https://sv.test/icons/x.png',
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'no per-pass re-send loop for image icons');
});

// ── Foreground re-heal + pass serialisation ──────────────────────────
//
// The shell can restore the webview without a page load, so neither
// Home.load() nor the probe necessarily re-runs on reopen. This is also
// how a freshly installed capable shell gets picked up.

// Settable document.visibilityState plus a real listener registry, so a
// test can background and foreground the app the way the shell would.
function stubForeground(sandbox) {
  const listeners = [];
  sandbox.document.visibilityState = 'visible';
  sandbox.document.addEventListener = (type, fn) => {
    if (type === 'visibilitychange') listeners.push(fn);
  };
  return async (state) => {
    sandbox.document.visibilityState = state;
    listeners.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
  };
}

test('icon heal: a foreground re-runs the pass despite an earlier attempt', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, false);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const foreground = stubForeground(sandbox);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  Home._watchWidgetForeground();
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'healed once on load');
  assert.ok(Home._iconHealTried?.has('w1'), 'id marked tried');

  // The registry still reports has_icon:false — the send didn't stick.
  Home._widgetForegroundHealedAt = 0; // an app switch later than the throttle
  await foreground('hidden');
  await foreground('visible');
  assert.equal(added.length, 2, 'the foreground retries despite the earlier attempt');
  assert.equal(added[1].silent, true, 'and stays silent');

  // …but an immediate second foreground is throttled, so rapid app
  // switching can't hammer the bridge with a persistently failing icon.
  await foreground('hidden');
  await foreground('visible');
  assert.equal(added.length, 2, 'throttled — no send on a rapid re-foreground');
});

test('foreground healing is inert without the widget mechanism', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const foreground = stubForeground(sandbox);
  const added = [];
  sandbox.usernode = {
    isNative: false,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = null; // plain browser / Android
  Home._apps = [baseApp()];
  Home._watchWidgetForeground();
  await foreground('hidden');
  await foreground('visible');
  assert.equal(added.length, 0, 'no bridge traffic off the widget path');
  assert.equal(Home._widgetForegroundHealedAt, 0, 'the throttle never even armed');
});

// Two overlapping passes would each write a srcMap snapshot taken
// before the other's sends, so the last writer drops the other's
// records and those tiles re-send on the next load.
test('icon heal: concurrent passes send once per id and keep both records', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, false);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => {
      // Yield, so a second pass would interleave if it were allowed to.
      await new Promise((r) => setTimeout(r, 0));
      added.push(opts);
      return { added: true };
    },
    getHomeScreenShortcuts: async () => ({ items: Home._widgetItems }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetItems = [
    { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
    { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: false },
  ];
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  await Promise.all([Home._healWidgetIcons(), Home._healWidgetIcons()]);
  assert.equal(added.length, 2, 'exactly one send per stale id');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:light:`, 'canvas record survives');
  assert.equal(srcMap.w2, 'https://sv.test/icons/x.png', 'image record survives');
  assert.equal(Home._healInFlight, null, 'the guard clears when the pass settles');
});


test('icon heal: unpinned shortcut records are pruned from the source map', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  sandbox.localStorage.setItem(
    'sv:widget_icon_src',
    JSON.stringify({ gone: 'https://sv.test/icons/old.png' })
  );
  await Home._refreshWidgetItems();
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.deepEqual(srcMap, {}, 'record for the unpinned shortcut dropped');
  assert.equal(added.length, 0);
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
