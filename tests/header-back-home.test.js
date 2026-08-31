// "Every page should have a back or a home button, except the Home screen."
//
// ── What the bar looked like before ────────────────────────────────────
//
// `mode` was a boolean wearing three names. Only 'arrow' drew anything;
// 'home' meant HIDDEN — a leftover from #1443, which retired the house glyph
// because the chip's menu carries a Home row an inch to its right. True, and
// the cost was five screens with nothing in the bar at all: the app itself,
// Profile, Settings, Admin and Messages. Two more drew a CHEVRON with no
// href, which resolved to home — the right destination behind the wrong
// glyph, promising a level above a root screen that has none.
//
// ── The three modes, and why 'home' was redefined rather than added to ──
//
//   'none'   hidden. Home only.
//   'home'   the house, to home. THE DEFAULT — `_showOnlyScreen` publishes it
//            on every screen swap, so a screen gets a way out by existing.
//   'arrow'  the chevron, one level UP to its own href.
//
// ~40 call sites already spelled the default 'home', and every one of them
// meant "no level above this" — which is exactly the screen that should offer
// home. So the meaning moved and the call sites did not, and the ones that
// had to change are the ones that must NOT offer it: Home itself.
//
// ── The bug this file exists to stop coming back ───────────────────────
//
// The bridge in features/header/mount.ts narrowed `mode` with
// `mode === 'arrow' ? 'arrow' : 'home'`. Correct while 'home' meant hidden,
// and a silent bug the moment it draws: setBackIcon('none') from Home arrived
// as 'home' and put a house on the one screen that must not have one. Every
// layer above was right — app.js computed 'none' and published 'none' — and
// one ternary turned it into its opposite. It took a browser to find; it
// takes one assertion to keep found.
//
// Run with: node --test tests/header-back-home.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runModules, makeStoreStub } = require('./helpers/bundle-module');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_JS = read('public/js/app.js');
const HEADER = read('frontend/src/features/header/platform-header.tsx');
const STORE = read('frontend/src/features/header/back-button-store.js');
const MOUNT = read('frontend/src/features/header/mount.ts');
const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');
const IMPROVE_CONTROLLER = read('frontend/src/features/improve/improve-controller.js');

// ── 1. The three modes exist end to end ────────────────────────────────

test('the store declares three modes and prerenders the hidden one', () => {
  assert.match(STORE, /'none'\|'home'\|'arrow'/,
    'the typedef names all three, so an editor and a reader agree');
  const initial = STORE.slice(STORE.indexOf('const INITIAL = {'));
  assert.match(initial.slice(0, initial.indexOf('};')), /mode: 'none'/,
    "INITIAL is 'none': the prerendered anchor ships hidden, and a first "
    + 'client render that disagrees with the document is a hydration '
    + 'mismatch — a console error, which fails proposal checks');
});

test('the bridge narrows to all THREE, not to two', () => {
  // THE REGRESSION. `mode === 'arrow' ? 'arrow' : 'home'` silently turned
  // Home's own 'none' into a house.
  const at = MOUNT.indexOf('bridge.backButton = {');
  assert.ok(at > 0, 'the backButton bridge must exist');
  const body = MOUNT.slice(at, MOUNT.indexOf('\n  };', at));
  assert.match(body, /mode === 'none' \? 'none' : 'home'/,
    "'none' must survive the narrowing — it is the one mode that HIDES the "
    + 'slot, and collapsing it into the default puts a house on Home');
  assert.match(body, /mode === 'arrow' \? 'arrow'/, "…and 'arrow' still wins first");
});

test('setBackIcon maps the three modes and toggles both glyphs', () => {
  const at = APP_JS.indexOf('  setBackIcon(mode, href) {');
  assert.ok(at > 0, 'setBackIcon must exist');
  const body = APP_JS.slice(at, APP_JS.indexOf('\n  },', at));
  assert.match(body, /const slot = arrow \? 'arrow' : \(mode === 'none' \? 'none' : 'home'\)/,
    'one expression owns the mapping, and anything unrecognised falls to '
    + "'home' rather than 'none' — an unknown mode should leave a way OFF "
    + 'the screen, not remove one');
  assert.match(body, /backButton\?\.set\?\.\(slot, target\)/,
    'and the SAME value is what gets published');
  // The pre-hydration fallback has three nodes to keep in step again.
  assert.match(body, /toggle\('hidden', slot === 'none'\)/, 'the anchor hides on none');
  assert.match(body, /back-icon-arrow'\)\?\.classList\.toggle\('hidden', !arrow\)/);
  assert.match(body, /back-icon-home'\)\?\.classList\.toggle\('hidden', arrow\)/);
});

// ── 2. Home is the only screen with nothing ────────────────────────────

test("BOTH ways into Home publish 'none' — a cold boot is one of them", () => {
  // navigateHome is the obvious one. The other is the unrecognised-hash
  // branch of restoreFromHash, and it is not an edge case: an EMPTY hash is
  // an unrecognised one, so `/` takes it on every cold boot. Miss it and the
  // most-visited screen in the product is the one with the bug.
  const calls = [...APP_JS.matchAll(/App\.setBackIcon\('none'\)/g)];
  assert.equal(calls.length, 2,
    `expected exactly two 'none' publishes (navigateHome and the cold-boot / `
    + `unrecognised-hash branch); found ${calls.length}`);

  for (const [label, anchor] of [
    ['navigateHome', "App._showOnlyScreen('home-screen', ['app-view']);"],
    ['the cold-boot branch', "App._showOnlyScreen('home-screen');"],
  ]) {
    const at = APP_JS.indexOf(anchor);
    assert.ok(at > 0, `${label} must reveal the home screen`);
    assert.match(APP_JS.slice(at, at + 900), /App\.setBackIcon\('none'\)/,
      `${label} must publish 'none' AFTER the reveal — _showOnlyScreen `
      + "publishes the 'home' default, which would draw a house on Home");
  }

  // And neither writes the class by hand any more: #back-btn's className is
  // React's, so a classList write there is undone on the island's next
  // render — and it cannot express three states regardless.
  assert.ok(!/back-btn'\)\.classList\.add\('hidden'\)/.test(APP_JS),
    'no raw classList write into the React-owned anchor');
});

// ── 3. The glyphs ──────────────────────────────────────────────────────

test('the anchor renders both glyphs and hides exactly one', () => {
  assert.match(HEADER, /id="back-icon-arrow"\n\s+className=\{backArrow \? 'w-5 h-5' : 'hidden w-5 h-5'\}/,
    'the chevron shows on arrow');
  assert.match(HEADER, /id="back-icon-home"\n\s+className=\{backArrow \? 'hidden w-5 h-5' : 'w-5 h-5'\}/,
    'the house shows otherwise — the two are complements of one flag, so '
    + 'they cannot both be on');
  // Both in the COLD DOCUMENT. Rendering only the active one would take an
  // id out of the shipped inventory whenever the initial mode is the other,
  // and that inventory is a contract (tests/shell-id-inventory.test.js).
  assert.match(HEADER, /className=\{BACK_BTN_CLASS \+ \(mode === 'none' \? ' hidden' : ''\)\}/,
    "the anchor itself hides only on 'none'");
  assert.match(HEADER, /aria-label=\{backArrow \? 'Back' : 'Home'\}/,
    'and the accessible name follows the glyph — two meanings, two names');
});

// ── 4. The ladder inside an app ────────────────────────────────────────

test('the route decides where UP is, inside an app', () => {
  const at = HEADER.indexOf('function appRouteUpHref(');
  assert.ok(at > 0, 'the derivation must exist');
  const body = HEADER.slice(at, HEADER.indexOf('\n}', at));
  assert.match(body, /if \(!slug \|\| tab !== 'dev'\) return null;/,
    'the app tab itself has no level above it inside the app — it gets the '
    + 'house, like every other root');
  assert.match(body, /subTab === 'sessions'\) return sessionOrigin \|\| `#app\/\$\{slug\}\/board`/,
    'a session goes where it was opened from, falling back to the Board');
  assert.match(body, /subTab === 'chat' \|\| subTab === 'topic'\) return `#app\/\$\{slug\}\/board`/,
    'the general chat and a topic card are reached FROM the board');
  assert.match(body, /subTab === 'forum'\) return selfHosted \? null : `#app\/\$\{slug\}\/app`/,
    'and the Board/Activity go up to the app itself — except on the '
    + "platform's own app, which HAS no app tab (App.switchTab coerces a "
    + 'request for one back to the dev forum), so up there would bounce '
    + 'straight back to the board it just left');
});

test('the derived answer outranks the imperative one, and only inside an app', () => {
  assert.match(HEADER, /const mode = routeUp \? 'arrow' : backMode;/,
    'an app route with a level above it wins; everything else keeps what '
    + 'setBackIcon published');
  assert.match(HEADER, /const resolvedBackHref = routeUp\n\s+\|\| \(mode === 'home' \? homeHref\(\) : backHref\);/,
    "and 'home' resolves its own href rather than relying on a caller to "
    + 'pass one');
});

// ── 5. The session origin, actually executed ───────────────────────────

function loadImprove(initial) {
  const store = makeStoreStub({
    slug: null, tab: 'app', subTab: null, selfHosted: false,
    sessionOrigin: null, ...initial,
  });
  const sandbox = {
    console, Promise, setTimeout, clearTimeout,
    location: { search: '', hash: '' },
    URLSearchParams,
    document: { getElementById: () => null, addEventListener: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  runModules(sandbox, [['improve-controller.js', IMPROVE_CONTROLLER]], {
    imports: {
      '../apps/app-card.js': { iconViewFor: () => ({}) },
      '../../lib/kit-surface': { adoptKitSurface: () => null },
      '../../lib/sheet-controller.js': { dismissRegisteredSheets() {} },
      './improve-store.js': { improveStore: store },
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
    },
    tail: 'window.__improve = Improve;',
  });
  return { Improve: sandbox.__improve, store, sandbox };
}

test('the first routing pass of a page load captures no origin', () => {
  // A COLD DEEP LINK has no previous screen, and the store cannot say so by
  // itself: its INITIAL is `tab: 'app'`, indistinguishable from having been
  // on the app tab. Reading it as one sent a shared session link's back arrow
  // to a screen the tab had never shown — and on the platform's own app, to
  // one that does not exist.
  const { Improve, store } = loadImprove({ slug: 'demo-app' });
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, null,
    'nothing to go back to, so the header falls back to the Board');
});

test('entering a session serialises the route being left', () => {
  for (const [label, from, expected] of [
    ['the app tab', { tab: 'app', subTab: null }, '#app/demo-app/app'],
    ['the Board', { tab: 'dev', subTab: 'forum' }, '#app/demo-app/board'],
    ['the general chat', { tab: 'dev', subTab: 'chat' }, '#app/demo-app/dev/chat'],
  ]) {
    const { Improve, store } = loadImprove({ slug: 'demo-app' });
    // The first call is the page's own first routing pass; the second is the
    // navigation being measured.
    Improve.setTab(from.tab, from.subTab);
    Improve.setTab('dev', 'sessions');
    assert.equal(store.state.sessionOrigin, expected,
      `a session opened from ${label} goes back to it`);
  }
});

test('Activity and Board are one screen in two layouts, and back knows which', () => {
  // The layout IS the route (see the alias block in app.js's
  // restoreFromHash), so an origin that always said "board" would drop the
  // viewer into the other layout of the screen they had just been reading.
  const { Improve, store, sandbox } = loadImprove({ slug: 'demo-app' });
  sandbox.AppView = { _getViewMode: () => 'feed' };
  Improve.setTab('dev', 'forum');
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, '#app/demo-app/activity');
});

test('the origin survives hops inside the session and dies on the way out', () => {
  const { Improve, store } = loadImprove({ slug: 'demo-app' });
  Improve.setTab('app');
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, '#app/demo-app/app');
  // A re-publish while still on the session (a preview opening, a lifecycle
  // change) must not overwrite the origin with the session itself.
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, '#app/demo-app/app', 'kept');
  // …and leaving clears it, so it cannot outlive the session it belonged to.
  Improve.setTab('dev', 'forum');
  assert.equal(store.state.sessionOrigin, null, 'cleared on the way out');
});

test("the platform's own app can never be an origin's app tab", () => {
  const { Improve, store } = loadImprove({ slug: 'usernode-x', selfHosted: true });
  Improve.setTab('app');
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, null,
    'it has no app tab to go back to, so the Board fallback is the answer');
});

// ── 6. The click path agrees with the href ─────────────────────────────

test('leaving a session follows the same origin the arrow shows', () => {
  // A control whose href says one thing and whose handler does another is
  // exactly the bug that made this bar's href "decorative" once before.
  // leaveSession() unconditionally ran App.switchTab('dev') — the Board.
  const at = DEV_CHAT.indexOf('  leaveSession() {');
  assert.ok(at > 0, 'leaveSession must exist');
  const body = DEV_CHAT.slice(at, DEV_CHAT.indexOf('\n  },', at));
  assert.match(body, /const origin = window\.Improve\?\.sessionOrigin\?\.\(\);/,
    'it reads the captured origin through the window bridge — dev-chat.js is '
    + 'loaded as a SCRIPT by a dozen vm harnesses, where a top-level import '
    + 'is a syntax error');
  assert.match(body, /if \(origin[\s\S]{0,80}?location\.hash = origin;/,
    'and goes there');
  assert.match(body, /App\.switchTab\('dev'\)/,
    'with the Board still the fallback when there is no origin');
  // Compared on the CODE, not the prose: the comment above this branch names
  // `App.switchTab('dev')` as what it replaced, and an indexOf over the raw
  // body finds that first.
  const code = body.replace(/\/\/.*$/gm, '');
  assert.ok(code.indexOf('location.hash = origin') < code.indexOf("App.switchTab('dev')"),
    'the origin is preferred over the fallback, not the other way round');
});

test('the accessor the click path reads is published on the controller', () => {
  const { Improve, store } = loadImprove({ slug: 'demo-app' });
  Improve.setTab('app');
  Improve.setTab('dev', 'sessions');
  assert.equal(typeof Improve.sessionOrigin, 'function');
  assert.equal(Improve.sessionOrigin(), store.state.sessionOrigin,
    'one source of truth for the href and the click');
});

// ── 7. The order of the right group ────────────────────────────────────

test('the bell renders BEFORE Improve, to its left', () => {
  // The bell was moved to the far right for a round, on the argument that a
  // standing alert wants a fixed address and Improve's width (which clears
  // entirely on a screen with no target) moves it. The arrangement was
  // preferred as it had always been: the alert reads inward from the edge and
  // the ACTION owns the corner. Both are defensible, which is exactly why the
  // one we ship is pinned — an order nobody asserts is an order that drifts.
  const group = HEADER.slice(HEADER.indexOf('<div ref={rightGroupRef}'));
  const body = group.slice(0, group.indexOf('</div>\n      </header>'));
  const bell = body.indexOf('id="notifications-btn"');
  const improve = body.indexOf('<ImproveButton />');
  assert.ok(bell > 0 && improve > 0, 'both controls are in the right group');
  assert.ok(bell < improve,
    'the bell first, then Improve — DOM order is visual order in this flex row');

  // The bell must stay INSIDE this group. rightGroupRef is what
  // use-header-layout.ts measures as the title's right-hand clearance, so a
  // control moved out of it stops counting toward the centring decision and
  // the title can overlap it.
  assert.ok(HEADER.indexOf('id="notifications-btn"') > HEADER.indexOf('<div ref={rightGroupRef}'),
    'the bell is inside the measured right group');
});
