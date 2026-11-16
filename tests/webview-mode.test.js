'use strict';

// Webview mode (request #6701): on a phone, the Homeroom mark menu's "Webview
// mode" row hides Homeroom's header and tab bar on every route, the choice is
// remembered on the device, and the "Open in Homeroom" pill turns it off.
//
// Pinned here:
//   1. STATE, in public/js/app.js run in a vm: turning it on publishes the
//      header away, the pill up and the tab bar down, and stores the choice;
//      the router's setChromeless(false) on the next navigation does not
//      bring the bars back; a wide window keeps the choice and shows the
//      bars; turning it off restores everything and clears the stored key;
//      the side panel's document never takes part.
//   2. BOOT: a remembered choice takes the bars down as the file loads, and
//      the pill only from init, after hydration (it is markup the prerender
//      does not carry).
//   3. THE ROW: phone only, gated after mount, an action with no chevron.
//   4. THE PILL: turns the mode off, and leaves a route only on /full.
//   5. app.css: the status bar's band on Homeroom's own pages, the pill
//      clear of a page's message bar, and away while the keyboard is up.
//
// Run with: node --test tests/webview-mode.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { message } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const appSource = read('public/js/app.js');

const PHONE_QUERY = '(max-width: 767px) and (pointer: coarse)';

// A window whose phone query answers `phone` (and can be flipped), with a
// localStorage that keeps what is written. Every other media query says no.
function harness({ phone = true, stored = null, storage = true } = {}) {
  const store = new Map(stored == null ? [] : [['homeroom.webviewMode', stored]]);
  const attrs = new Set();
  const state = { phone };
  const listeners = [];
  const broadcasts = [];
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, console,
    document: {
      title: '',
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
      documentElement: {
        setAttribute: (name) => attrs.add(name),
        toggleAttribute: (name, on) => { if (on) attrs.add(name); else attrs.delete(name); },
      },
    },
    addEventListener() {},
    matchMedia: (query) => ({
      get matches() { return query === PHONE_QUERY ? state.phone : false; },
      addEventListener(type, fn) { if (query === PHONE_QUERY) listeners.push(fn); },
    }),
    localStorage: storage ? {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    } : {
      getItem() { throw new Error('refused'); },
      setItem() { throw new Error('refused'); },
      removeItem() { throw new Error('refused'); },
    },
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
    AppView: { scheduleSafeAreaBroadcast: () => broadcasts.push(1) },
  });
  context.window = context;
  vm.runInContext(appSource, context);
  const { App } = context;
  context.UsernodeReact = { nav: { setScreen() {} } };
  const read = (id) => App.Visibility.read(id);
  return {
    App, store, attrs, broadcasts,
    header: () => read('platform-header'),
    pill: () => read('chromeless-pill'),
    tabs: () => read('platform-tabs'),
    turn(toPhone) { state.phone = toPhone; for (const fn of listeners) fn({ matches: toPhone }); },
  };
}

// ── 1. State ──────────────────────────────────────────────────────────

test('the app.js harness keys on the shell\'s own phone query', () => {
  assert.ok(appSource.includes(`_WEBVIEW_QUERY: '${PHONE_QUERY}'`));
  assert.ok(read('frontend/src/lib/keyboard-open.ts').includes(`export const PHONE_QUERY = '${PHONE_QUERY}';`),
    'the same query the keyboard handling and the menu row read');
});

test('turning Webview mode on takes the header and the tab bar away and stores the choice', () => {
  const h = harness();
  h.App._syncPlatformTabs('home-screen');
  assert.equal(h.tabs(), true);
  h.App.setWebviewMode(true);
  assert.equal(h.App.webviewMode, true);
  assert.equal(h.header(), false);
  assert.equal(h.pill(), true, 'the pill is the way out, on every route');
  assert.equal(h.tabs(), false);
  assert.equal(h.store.get('homeroom.webviewMode'), '1');
  assert.ok(h.attrs.has('data-webview-mode'), 'app.css keys the status bar band off it');
  assert.ok(h.broadcasts.length > 0, 'a running app is handed its insets again');
});

test('the router clearing the full-screen route does not bring the bars back', () => {
  const h = harness();
  h.App.setWebviewMode(true);
  // Every navigate* path does this; `chromeless` is the route's flag only.
  h.App.setChromeless(false);
  h.App._syncPlatformTabs('messages-screen');
  assert.equal(h.header(), false);
  assert.equal(h.pill(), true);
  assert.equal(h.tabs(), false);
  // …and the full-screen route on top of it changes nothing visible.
  h.App.setChromeless(true);
  h.App.setChromeless(false);
  assert.equal(h.header(), false);
  assert.equal(h.pill(), true);
  assert.equal(h.App.chromeless, false, 'the route flag stays the route\'s');
});

test('turning it off restores the bars and clears the stored key', () => {
  const h = harness();
  h.App._syncPlatformTabs('home-screen');
  h.App.setWebviewMode(true);
  h.App.setWebviewMode(false);
  assert.equal(h.App.webviewMode, false);
  assert.equal(h.header(), true);
  assert.equal(h.pill(), false);
  assert.equal(h.tabs(), true);
  assert.equal(h.store.has('homeroom.webviewMode'), false);
  assert.equal(h.attrs.has('data-webview-mode'), false);
});

test('the full-screen route still works alone, and survives Webview mode going off', () => {
  const h = harness();
  h.App._syncPlatformTabs('home-screen');
  h.App.setChromeless(true);
  assert.equal(h.header(), false);
  assert.equal(h.pill(), true);
  assert.equal(h.tabs(), false);
  assert.equal(h.attrs.has('data-webview-mode'), false, 'the attribute is Webview mode\'s alone');
  h.App.setWebviewMode(true);
  h.App.setWebviewMode(false);
  assert.equal(h.header(), false, 'the route still says full screen');
  h.App.setChromeless(false);
  assert.equal(h.header(), true);
  assert.equal(h.pill(), false);
});

test('a wide window keeps the choice and shows the bars; a phone-sized one hides them again', () => {
  const h = harness();
  h.App._syncPlatformTabs('home-screen');
  h.App.setWebviewMode(true);
  h.turn(false);
  assert.equal(h.header(), true);
  assert.equal(h.pill(), false);
  assert.equal(h.tabs(), true);
  assert.equal(h.attrs.has('data-webview-mode'), false);
  assert.equal(h.App.webviewMode, true, 'the choice is kept');
  assert.equal(h.store.get('homeroom.webviewMode'), '1');
  h.turn(true);
  assert.equal(h.header(), false);
  assert.equal(h.pill(), true);
  assert.equal(h.tabs(), false);
});

test('off a phone the stored choice does nothing', () => {
  const h = harness({ phone: false, stored: '1' });
  h.App._syncPlatformTabs('home-screen');
  assert.equal(h.App.webviewMode, true);
  assert.equal(h.App._webviewActive(), false);
  assert.notEqual(h.header(), false);
  assert.notEqual(h.pill(), true);
  assert.equal(h.tabs(), true);
});

test('where storage is refused the mode holds for this load', () => {
  const h = harness({ storage: false });
  assert.equal(h.App.webviewMode, false, 'a refused read is off');
  h.App.setWebviewMode(true);
  assert.equal(h.header(), false);
  assert.equal(h.pill(), true);
});

test('the side panel\'s own document never takes part', () => {
  const h = harness({ stored: '1' });
  assert.equal(h.App.webviewOffered(), true, 'a phone is offered the row');
  h.App.embeddedPanel = true;
  assert.equal(h.App.webviewOffered(), false);
  assert.equal(h.App._webviewActive(), false);
  assert.equal(h.App._chromeHidden(), false);
});

test('the row is offered by the screen, not by what is stored', () => {
  assert.equal(harness({ phone: false }).App.webviewOffered(), false);
  assert.equal(harness({ phone: true }).App.webviewOffered(), true);
});

// ── 2. Boot ───────────────────────────────────────────────────────────

test('a remembered choice takes the bars down as app.js loads, and the pill waits for init', () => {
  const h = harness({ stored: '1' });
  assert.equal(h.App.webviewMode, true);
  assert.equal(h.header(), false);
  assert.equal(h.tabs(), false);
  assert.ok(h.attrs.has('data-webview-mode'));
  // Published before hydration, the pill would be a first render the
  // prerender does not have (React #418 on every route).
  assert.equal(h.pill(), undefined);
  const boot = appSource.slice(appSource.indexOf('  _bootWebviewMode() {'));
  assert.doesNotMatch(boot.slice(0, boot.indexOf('\n  },')), /chromeless-pill/);
  const init = appSource.slice(appSource.indexOf('  async init() {'));
  assert.match(init.slice(0, init.indexOf('Screenshot-state deep links')),
    /if \(App\._webviewActive\?\.\(\)\) App\.Visibility\.publish\('chromeless-pill', true\);/);
  assert.match(appSource, /try \{ App\._bootWebviewMode\(\); \} catch/,
    'guarded: a dozen suites load this file into a stub window');
});

test('nothing stored boots with the bars as they were', () => {
  const h = harness();
  assert.equal(h.App.webviewMode, false);
  assert.equal(h.header(), undefined);
  assert.equal(h.pill(), undefined);
  assert.equal(h.attrs.size, 0);
});

test('what is about the route keeps reading the route flag', () => {
  // The tab bar is the one reader that moved to the combined answer.
  assert.match(appSource, /!!screen && !App\._chromeHidden\(\) && \(!inApp \|\| railPinned\)/);
  // The Communities tab's scope, the side panel beside an app, the Workshop's
  // remembered view and the address switchTab writes are the route's.
  assert.match(appSource, /\(railPinned \|\| \(inApp && App\._sideStripUp\(\)\)\) && !App\.chromeless\) App\._scopeToRunningApp\(\);/);
  assert.match(appSource, /appPresence\?\.\(\(inApp \|\| screen === 'ai-screen'\) && !App\.chromeless\);/);
  assert.match(appSource, /App\.currentTab !== 'dev' \|\| App\.chromeless\) return;/);
});

// ── 3. The row ────────────────────────────────────────────────────────

test('the mark menu offers the row on a phone, after mount, as an action', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const offer = sheet.slice(sheet.indexOf('const webviewOffer = useMemo('));
  assert.match(offer.slice(0, 400), /if \(!mounted \|\| newcomer \|\| walkOwed\) return false;/,
    'never in the prerender or the hydrating render, and not over the newcomer\'s walk');
  assert.match(offer.slice(0, 400), /return !!\(window as any\)\.App\?\.webviewOffered\?\.\(\);/,
    'app.js answers from the mode\'s own query; the panel measures nothing');
  const row = sheet.slice(sheet.indexOf('{webviewOffer ? ('), sheet.indexOf('{homeroomOffer ? ('));
  assert.ok(row.length > 0, 'after About, before Add Homeroom');
  assert.ok(sheet.indexOf('id="app-menu-row-about"') < sheet.indexOf('id="app-menu-row-webview"'));
  assert.match(row, /id="app-menu-row-webview"/);
  assert.match(row, /type="button"/);
  assert.match(row, /AppContext\.dismissForNav\(\)\.then\(\(\) => \{\s*\(window as any\)\.App\?\.setWebviewMode\?\.\(true\);/,
    'the menu closes first, then the bars go');
  assert.match(row, /label=\{t\('agent:appContext\.row\.webview'\)\}/);
  assert.match(row, /t\('agent:appContext\.row\.webviewSub'\)/);
  assert.match(row, /\n\s+action\n/, 'no chevron: it opens no page');
  assert.match(sheet, /\{action \? null : external \? <ExternalMark \/> : \(/);
  assert.equal(message('agent:appContext.row.webview'), 'Webview mode');
  assert.equal(message('agent:appContext.row.webviewSub'), "Hide Homeroom's bars on this phone");
});

test('the prerendered shell carries no Webview row and no pill', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('id="app-menu-row-about"'));
  assert.ok(!html.includes('app-menu-row-webview'));
  assert.ok(!html.includes('id="chromeless-pill"'));
});

// ── 4. The pill ───────────────────────────────────────────────────────

test('the pill turns Webview mode off, and leaves a route only on the full-screen one', () => {
  const pill = read('frontend/src/features/header/chromeless-pill.tsx');
  const click = pill.slice(pill.indexOf('onClick={(ev) => {'), pill.indexOf('<span>{t('));
  assert.match(click, /const wasWebview = !!window\.App\?\.webviewMode;\s*if \(wasWebview\) window\.App\?\.setWebviewMode\?\.\(false\);/);
  assert.match(click, /if \(slug && \(window\.App\?\.chromeless \|\| !wasWebview\)\) \{/,
    'on a Homeroom page (no app) the tap only brings the bars back');
  assert.ok(click.indexOf('setWebviewMode') < click.indexOf('openAppTab'));
  assert.ok(pill.includes("useVisibility('webview-mode', false)"));
  assert.equal(message('core:chromeless.open'), 'Open in Homeroom');
  assert.equal(message('core:chromeless.openWebviewLabel'), "Open in Homeroom: show Homeroom's bars again");
});

test('the swipe back keeps the hidden header\'s destination on Homeroom\'s own pages', () => {
  const header = read('frontend/src/features/header/platform-header.tsx');
  assert.ok(header.includes("const webview = useVisibility('webview-mode', false);"));
  assert.ok(header.includes('visible: visible || webview, mode, href: resolvedBackHref'));
});

// ── 5. app.css ────────────────────────────────────────────────────────

test('app.css keeps the status bar band, zeroes the header height and moves the pill', () => {
  const css = read('public/css/app.css');
  const block = css.slice(css.indexOf('/* ── WEBVIEW MODE (request #6701)'));
  assert.ok(block.length > 0);
  const platformPage = 'html[data-webview-mode] body:not(:has(#app-view:not(.hidden)[data-app-surface="app"]))';
  assert.match(block, /html\[data-webview-mode\] :is\(#platform-header, #platform-tabs, #platform-parked\) \{\s*display: none !important;/);
  const band = block.slice(block.indexOf(`${platformPage} #platform-header#platform-header {`));
  assert.match(band.slice(0, band.indexOf('}')), /visibility: hidden;[\s\S]*height: calc\(var\(--platform-safe-top\) \+ 0\.5rem\);/);
  assert.match(block, /html\[data-webview-mode\],\s*html\[data-webview-mode\]\[data-webview-mode\] body \{\s*--platform-header-h: 0px;/);
  assert.ok(css.indexOf('/* ── WEBVIEW MODE (request #6701)') < css.indexOf('/* looks:begin'),
    'ahead of the looks, whose sections are scoped to their own flags');
  const lifted = block.slice(block.indexOf(`${platformPage} #chromeless-pill {`));
  assert.match(lifted.slice(0, lifted.indexOf('}')), /bottom: calc\(104px \+ var\(--platform-safe-bottom\)\) !important;/);
  assert.match(block, /html\[data-webview-mode\]:is\(\.platform-kb-open, \.un-kb\) #chromeless-pill \{\s*display: none !important;/);
});
