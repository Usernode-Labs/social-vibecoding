'use strict';

// #platform-tabs — the shell's five sections as a permanent bar.
//
// Three things are checked here, and each one is a way the bar can be wrong
// while every structural test in the suite still passes:
//
//   1. THE MAP IS COMPLETE. Five tabs cover ten screen roots, so a root added
//      later falls through to "no tab" and the bar simply goes blank on it —
//      no throw, no failing selector, just a bar that stops answering where
//      you are. This asserts the map against App.SCREEN_IDS itself.
//   2. THE RENDER MATCHES THE PRERENDER. The bar is an island in a document
//      React hydrates, so a first client render that disagrees with the
//      prerendered markup console.errors, and a console error on any route
//      fails proposal checks. The initial store state has to produce exactly
//      the shipped markup: no `aria-current`, a hidden empty badge.
//   3. ONE PLACE DECIDES WHETHER IT IS THERE. Three unrelated code paths hide
//      it (a running app, chromeless, the signed-out shell) and they all go
//      through App._syncPlatformTabs. This runs the real function.
//
// The CSS reservation is checked too, because the bar is out of flow: nothing
// holds its band open automatically, and the rules that do are in a different
// file from the one that sets the bar's height.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const appSource = read('public/js/app.js');
const css = read('public/css/app.css');

// ── 1. The map ────────────────────────────────────────────────────────

test('every screen root but the app view belongs to a tab', () => {
  const { TAB_FOR_SCREEN } = loadTsx('frontend/src/features/nav/nav-store.js');
  const match = appSource.match(/SCREEN_IDS:\s*(\[[^\]]*\])/);
  assert.ok(match, 'App.SCREEN_IDS is an array literal in app.js');
  const roots = JSON.parse(match[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));

  const unmapped = roots.filter((id) => id !== 'app-view' && !TAB_FOR_SCREEN[id]);
  assert.deepEqual(unmapped, [],
    'screen roots with no tab — add them to TAB_FOR_SCREEN in features/nav/nav-store.js, '
    + 'or the bar goes blank on those routes: ' + unmapped.join(', '));

  // The other direction, so a root that is retired cannot leave a dead entry
  // pointing at nothing.
  const stale = Object.keys(TAB_FOR_SCREEN).filter((id) => !roots.includes(id));
  assert.deepEqual(stale, [], 'TAB_FOR_SCREEN names roots App.SCREEN_IDS does not');

  // #app-view is absent ON PURPOSE — the bar is hidden inside a running app —
  // and the assertion above would also pass if someone added it, so say it.
  assert.equal(TAB_FOR_SCREEN['app-view'], undefined,
    'the app view is not one of the platform\'s sections; the bar is hidden there');
});

test('the five tabs are the five the bar renders', () => {
  const { TAB_FOR_SCREEN } = loadTsx('frontend/src/features/nav/nav-store.js');
  const sections = [...new Set(Object.values(TAB_FOR_SCREEN))].sort();
  assert.deepEqual(sections, ['discover', 'home', 'me', 'messages', 'workshop']);
});

// ── 2. The render ─────────────────────────────────────────────────────

test('the initial render is the markup the prerender ships', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});

  for (const key of ['home', 'discover', 'messages', 'workshop', 'me']) {
    assert.match(html, new RegExp(`id="platform-tab-${key}"`), `#platform-tab-${key} renders`);
  }
  assert.match(html, /id="platform-tabs"/);

  // NO tab is lit before the router has said anything. The store's INITIAL is
  // `tab: null` precisely so this render and the prerendered document agree.
  assert.doesNotMatch(html, /aria-current/,
    'a lit tab in the first render is a hydration mismatch against the prerender');

  // The badge is STRUCTURAL — always in the markup, hidden until it has a
  // count — so a declared check can select it on a cold document.
  assert.match(html, /id="platform-tabs-badge"/);
  assert.match(html, /class="platform-tab-badge hidden"/,
    'the badge ships hidden, with `hidden` constant in the class string');
  assert.doesNotMatch(html, /platform-tab-badge hidden"[^>]*>\s*\d/,
    'the badge ships empty');
});

test('Home is the one tab addressed as a path, so a modified click opens a tab', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  assert.match(html, /id="platform-tab-home"[^>]*href="\/"/);
  for (const [key, href] of [
    ['discover', '#apps'], ['messages', '#messages'],
    ['workshop', '#workshop'], ['me', '#profile'],
  ]) {
    assert.match(html, new RegExp(`id="platform-tab-${key}"[^>]*href="${href.replace('#', '\\#')}"`));
  }
});

// ── 3. One place decides ──────────────────────────────────────────────

function harness() {
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, console,
    document: {
      title: '',
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
    },
    addEventListener() {},
    localStorage: { getItem: () => null },
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
  });
  context.window = context;
  vm.runInContext(appSource, context);
  const { App } = context;
  const lit = [];
  context.UsernodeReact = { nav: { setScreen: (id) => lit.push(id) } };
  return { App, context, lit, shown: () => App.Visibility.read('platform-tabs') };
}

test('loading app.js with no session hides the bar before React renders', () => {
  // `_applyBootScreen` runs at MODULE SCOPE — app.js is a classic script and
  // the React entry is a deferred module, so this is the last thing that
  // happens before hydration. The harness's document has no session, so the
  // resolver answers the landing screen and the bar is published away with
  // it. Nothing has to reset this for the tests below: they publish their own
  // answer by calling _syncPlatformTabs.
  const { shown } = harness();
  assert.equal(shown(), false);
});

test('the bar is up on a platform screen and down inside an app', () => {
  const { App, shown } = harness();
  App._syncPlatformTabs('messages-screen');
  assert.equal(shown(), true);
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), false);
});

test('chromeless takes the bar with the header', () => {
  const { App, shown } = harness();
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  App.setChromeless(true);
  assert.equal(shown(), false, 'setChromeless must re-decide, not only hide the header');
  App.setChromeless(false);
  assert.equal(shown(), true);
});

test('the signed-out shell has nothing to tab to', () => {
  const { App, context, shown } = harness();
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  context.AuthScreens = { _current: 'landing' };
  App._syncPlatformTabs();
  assert.equal(shown(), false);
  context.AuthScreens._current = null;
  App._syncPlatformTabs();
  assert.equal(shown(), true);
});

test('a plain "/" boot never swaps screens, and the bar is still up', () => {
  // `_revealedScreen` is null until the first swap, and restoreFromHash's
  // no-hash branch is already-on-home: it calls Home.load() without one. A
  // null read as "no section" would hide the bar on the most-visited route.
  const { App, shown, lit } = harness();
  assert.equal(App._revealedScreen, null);
  App._syncPlatformTabs();
  assert.equal(shown(), true);
  assert.equal(lit.at(-1), 'home-screen');
});

test('the section is published even when the bar is down', () => {
  // Otherwise the store keeps the last one and the bar returns lighting a tab
  // the viewer has since left.
  //
  // THE RAW SCREEN, not the tab, and not null for the app view: the bar has
  // no tab for #app-view and goes away there, but the HEADER reads the same
  // publication to know it is inside an app (its left slot becomes a close
  // button, the app's tile appears beside its name). features/nav/mount.ts
  // derives the tab from it; only the signed-out screens publish nothing.
  const { App, context, lit } = harness();
  App._syncPlatformTabs('workshop-screen');
  assert.equal(lit.at(-1), 'workshop-screen');
  App._syncPlatformTabs('app-view');
  assert.equal(lit.at(-1), 'app-view');
  assert.equal(App.Visibility.read('platform-tabs'), false, 'and the bar is still down');
  context.AuthScreens = { _current: 'landing' };
  App._syncPlatformTabs();
  assert.equal(lit.at(-1), null, 'the signed-out screens are the one nothing');
});

test('a cold boot into an app or the signed-out shell never paints the bar', () => {
  for (const [hash, pathname, signedIn] of [
    ['#app/some-app', '/', true],
    ['#login', '/', false],
    ['', '/app/some-app', true],
  ]) {
    const { App, shown } = harness();
    // The real resolver decides; only the DOM half of the reveal is stubbed,
    // because this harness has no elements for it to toggle.
    const target = App._bootScreenFor(hash, pathname, signedIn);
    assert.ok(target === 'app-view' || target.startsWith('auth-'),
      `${pathname}${hash} resolves to ${target}`);
    App._revealBootScreen = () => {};
    App._bootScreenFor = () => target;
    App._applyBootScreen();
    assert.equal(shown(), false, `${pathname}${hash} painted the bar before the router ran`);
  }

  // ...and a cold boot onto a platform screen leaves the store ALONE, so the
  // bar paints with the document rather than a frame later. Nothing published
  // means "whatever the markup shipped", which is visible.
  const { App, context, shown } = harness();
  delete context.__usernodeVisibility.visible['platform-tabs'];
  App._revealBootScreen = () => {};
  App._bootScreenFor = () => 'workshop-screen';
  App._applyBootScreen();
  assert.equal(shown(), undefined);
});

// ── The band the bar covers ───────────────────────────────────────────

test('the bar spends the home-indicator inset exactly once', () => {
  // The bar is fused to the bottom edge, so its own lower padding covers the
  // strip and `--platform-tabs-h` counts it. Every consumer then takes
  // `max()` of the two rather than adding them — adding is the #4149 bug
  // (`--ws-bar`'s comment above documents the same trap from the other side).
  assert.match(css, /\.platform-tabs\s*\{[^}]*padding-bottom:\s*var\(--platform-safe-bottom\)/,
    '.platform-tabs spends the inset itself');
  assert.match(css, /--platform-tabs-h:\s*calc\(56px \+ var\(--platform-safe-bottom, 0px\)\)/,
    'the token is the bar\'s FULL outer height, inset included');

  for (const rule of ['.platform-safe-scroll', '.platform-safe-bar', '.home-body-fill']) {
    const block = css.slice(css.indexOf(`${rule} {`));
    const decl = block.slice(0, block.indexOf('}'));
    assert.match(decl, /max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom\)\)/,
      `${rule} must clear the bar and the inset with max(), never both stacked`);
  }
});

test('the same five tabs stand up at desktop, and the band goes away', () => {
  // A bottom bar is a PHONE shape: at 1280px its five tabs sit 250px apart
  // along the foot of the window, which is a row of unrelated buttons rather
  // than a set of places. Slack, Discord, Teams and Telegram Desktop all turn
  // the same bar into a left rail, and so does this.
  const at = css.indexOf('@media (min-width: 768px) {\n  /* THE BAND AT THE FOOT GOES AWAY');
  assert.ok(at > 0, 'the desktop block must exist, at the shell\'s own md breakpoint');
  const block = css.slice(at, css.indexOf('\n}\n', css.indexOf('.platform-parked-pill {', at)));

  assert.match(block, /--platform-rail-w: 224px;/, 'the rail has a width');
  assert.match(block, /--platform-tabs-h: var\(--platform-safe-bottom\);/,
    'and the band at the foot is the home-indicator inset and nothing else');
  assert.match(block, /width: var\(--platform-rail-w\);/, 'the bar takes that width');
  assert.match(block, /grid-template-columns: none;/,
    'and stops being five equal columns');
  assert.match(block, /align-content: start;/,
    'five rows spread over 800px of rail is the bar\'s own mistake on its side');
  assert.match(block, /padding-left: var\(--platform-rail-w, 0px\);/,
    'the screens move over by PADDING, so nothing about the flex chain moves');
  // …and the app view is NOT one of the roots that move over: an app covers
  // the rail, which is what "the app is the whole window" means. The prose
  // above the rule says so, so the check is on the selector itself.
  const roots = block.slice(block.indexOf('  :is(#home-screen'), block.indexOf('padding-left: var('));
  assert.doesNotMatch(roots, /#app-view/, 'an app covers the rail');
  assert.match(roots, /#messages-screen/, 'every platform root does move over');
  // The parked strip is the rail's footer, and its pill becomes a caption
  // because four things do not fit across 224px.
  assert.match(block, /\.platform-parked \{[\s\S]{0,300}width: var\(--platform-rail-w\);/);
  assert.match(block, /\.platform-parked-pill \{[\s\S]{0,200}order: -1;/);
});

test('the rail peeks back over an open app, and reserves nothing while it does', () => {
  // An app covers the rail, which is what makes it feel like a program
  // rather than a page, and on a laptop the pointer is already at the left
  // edge half the time. The navigation comes back on hover and stops
  // spending width while you work.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /id="platform-rail-peek"/, 'a hot zone starts it');
  assert.match(bar, /screen === 'app-view' \? \(/,
    'and it exists only inside an app — everywhere else the rail is there');
  // THE PEEK IS NOT THE BAR'S VISIBILITY. The router still says hidden, the
  // screens reserve no band, and the app is full width; this is an overlay
  // on top of that answer.
  assert.match(bar, /useHiddenClass\(barRef, !visible && !peek\);/);
  assert.match(bar, /useClassToggle\(barRef, 'platform-tabs-peek', !visible && peek\);/);
  assert.match(css, /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\)/,
    'a peeking bar reserves nothing — reflowing the app under the pointer '
    + 'that revealed it is the bug this excludes');
  // A phone has no pointer to hover with, and an invisible strip down the
  // left edge of a touch screen eats the swipe that goes back.
  assert.match(css, /@media \(max-width: 767px\) \{\s*\.platform-rail-peek \{ display: none; \}/);
  // A fade, not a slide: a rail that slides in races the pointer that
  // summoned it and arrives under it.
  assert.match(css, /animation: platform-rail-peek-in 140ms ease-out;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}animation: none;/);
});

test('every screen change clears the peek', () => {
  // That is what a peek is FOR: you reveal the rail over an app to leave it,
  // and the thing you tapped has now happened. Leaving it set would hand the
  // next screen an overlay rail on top of its own.
  const mount = read('frontend/src/features/nav/mount.ts');
  assert.match(mount, /setScreen\(screenId: string \| null\) \{[\s\S]{0,600}peek: false,/);
});

test('the reservation is keyed off the bar\'s own hidden class', () => {
  // No second flag to keep in step: the island publishes `hidden` and the
  // screens read it, the same shape the wallpaper's route test uses.
  assert.match(css, /html:not\(\.un-kb\) body:has\(#platform-tabs:not\(\.hidden\)\)/);
  // Declared on `body` in BOTH branches. A custom property's var()s are
  // substituted on the element it is declared on, so a `:root` declaration
  // would bake in `:root`'s value and never see the override — which is also
  // why the parked strip's rule spells both terms out rather than adding 52px
  // to `--platform-bar-h`.
  assert.match(css, /\nbody \{\n(?:  \/\*[^]*?\*\/\n)?  --platform-bar-h: 0px;/);
  assert.match(css, /--platform-tabs-h: 0px;/);
  assert.match(css, /--platform-rail-w: 0px;\n\}/,
    'and the rail costs a phone no width at all');
  assert.match(css,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\):has\(#platform-parked:not\(\.hidden\)\) \{\s*--platform-tabs-h: calc\(52px \+ 56px \+ var\(--platform-safe-bottom, 0px\)\);/,
    'the strip adds its own band, and only while the bar is there to sit on '
    + 'for real rather than peeking over an app');
  assert.match(css, /\.platform-parked \{[^}]*bottom: var\(--platform-bar-h, 0px\);/,
    'and it rests ON the bar, so neither reserves the home-indicator twice');
  assert.match(css, /html\.un-kb #platform-tabs \{\s*display: none;/,
    'the keyboard takes the bar with it');
});
