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

  // TWO TOKENS, NOT ONE (#2718 review). `--platform-rail-full` is how wide
  // the rail IS and never changes; `--platform-rail-w` is how much width it
  // RESERVES, and goes to 0 while it is folded or peeking. One number for
  // both drew a 17px sliver — padding and a border around a zero-width
  // column — the first time the rail was peeked over a folded desktop.
  assert.match(css, /--platform-rail-full: 224px;/, 'the rail has a width');
  assert.match(block, /--platform-rail-w: var\(--platform-rail-full\);/,
    'and reserves it while it is up');
  assert.match(block, /--platform-tabs-h: var\(--platform-safe-bottom\);/,
    'and the band at the foot is the home-indicator inset and nothing else');
  assert.match(block, /width: var\(--platform-rail-full\);/,
    'the bar is DRAWN at the full width, never at the reserved one');
  assert.match(block, /grid-template-columns: none;/,
    'and stops being five equal columns');
  assert.match(block, /align-content: start;/,
    'five rows spread over 800px of rail is the bar\'s own mistake on its side');
  // A GUTTER AFTER THE RAIL, MIRRORED ON THE FAR EDGE (#2718 review). The
  // rail's hairline was the content's left margin, so a card began where the
  // rail ended while the page had air on the right and none on the left — a
  // centred column inside then centred a gutter's width left of the window's
  // middle. Spending the same figure on both sides is what fixes that, and
  // 1.5rem is the shell's own outer gutter rather than a number for this edge.
  assert.match(block, /padding-left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/,
    'the screens move over by PADDING, so nothing about the flex chain moves');
  assert.match(block, /padding-right: var\(--platform-gutter\);/,
    'and the same figure is spent on the far edge');
  assert.match(block, /--platform-gutter: 1\.5rem;/);
  // …and the app view is NOT one of the roots in that list: an app covers the
  // rail, which is what "the app is the whole window" means. The prose above
  // the rule says so, so the check is on the selector itself.
  const roots = block.slice(block.indexOf('  :is(#home-screen'), block.indexOf('padding-left: calc('));
  assert.doesNotMatch(roots, /#app-view/, 'an app covers the rail');
  assert.match(roots, /#messages-screen/, 'every platform root does move over');
  // IT MOVES OVER ANYWAY WHILE ITS RAIL IS UP (#2718 review), through a rule
  // of its own keyed off the bar rather than off the screen id — because
  // `#app-view` is two screens behind one id, and only one of them covers the
  // rail. Keyed off the bar and not off the tab, because the bar is already
  // the answer to that question.
  assert.match(block,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\):not\(\.platform-tabs-folded\)\) #app-view \{\s*padding-left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/);
  // The parked strip is the rail's footer, and its pill becomes a caption
  // because four things do not fit across 224px.
  assert.match(block, /\.platform-parked \{[\s\S]{0,300}width: var\(--platform-rail-full\);/);
  assert.match(block, /\.platform-parked-pill \{[\s\S]{0,200}order: -1;/);
});

test('the rail peeks back over an open app, and reserves nothing while it does', () => {
  // An app covers the rail, which is what makes it feel like a program
  // rather than a page, and on a laptop the pointer is already at the left
  // edge half the time. The navigation comes back on hover and stops
  // spending width while you work.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /id="platform-rail-peek"/, 'a hot zone starts it');
  // TWO WAYS TO HAVE NO RAIL, and the zone answers both (#2718 review): the
  // ROUTE can say there is none (an app) and the VIEWER can fold the one
  // there is (#sidebar-toggle). `!railOpen` rather than the `collapsed` the
  // class toggle below uses, deliberately — `collapsed` is also true on the
  // chromeless and signed-out shells, where a strip that peeked a rail in
  // would be conjuring navigation out of nothing.
  assert.match(bar, /screen === 'app-view' \|\| !railOpen \? \(/,
    'and it exists where the rail is out of the way, by either route');
  // THE PEEK IS NOT THE BAR'S VISIBILITY. The router still says hidden, the
  // screens reserve no band, and the app is full width; this is an overlay
  // on top of that answer.
  assert.match(bar, /useHiddenClass\(barRef, !visible && !peek\);/);
  assert.match(bar, /const collapsed = !visible \|\| !railOpen;/);
  assert.match(bar, /useClassToggle\(barRef, 'platform-tabs-peek', collapsed && peek\);/);
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

test('every screen change clears the peek, and nothing else does', () => {
  // That is what a peek is FOR: you reveal the rail over an app to leave it,
  // and the thing you tapped has now happened. Leaving it set would hand the
  // next screen an overlay rail on top of its own.
  const mount = read('frontend/src/features/nav/mount.ts');
  assert.match(mount,
    /setScreen\(screenId: string \| null, tabOverride\?: string \| null\) \{[\s\S]{0,1400}peek: false/);
  // THE OVERRIDE IS FOR ONE SCREEN (#2718 review): `#app-view` is the running
  // app, which lights nothing, AND the platform's Workshop for that app,
  // which lights Workshop. TAB_FOR_SCREEN cannot say so — a screen in that
  // map is a tab ROOT, and tests/header-back-home.test.js derives "shows no
  // back control" from being in it, which the app view's ✕ contradicts.
  assert.match(mount, /tab: tabOverride \|\| \(screen \? tabForScreen\(screen\) : null\),/);
  assert.match(read('public/js/app.js'),
    /screen === 'app-view' && !inApp \? 'workshop' : null,/,
    'and app.js is the one place that decides which of the two it is');
  // ON A CHANGE, not on every call. Re-asserting the screen you are already
  // on is not navigation, and clearing there yanks the rail out from under
  // the pointer that summoned it — measured with a harness that re-asserted
  // the current screen on a 100ms timer, which made the rail strobe at
  // exactly that rate. Nothing in the shipped router does that today; the
  // guard is here so that nothing ever can.
  assert.match(mount, /const changed = navStore\.get\(\)\.screen !== screen;/);
  assert.match(mount, /\.\.\.\(changed \? \{ peek: false \} : null\),/);
});

test('the desktop rail folds by hand, and a phone can never lose its bar', () => {
  // #2718 review: "the sidebar toggle button is missing on desktop". Every
  // host in the study that draws a persistent rail also draws a way to fold
  // it, in the window's top-left corner.
  const toggle = read('frontend/src/features/nav/sidebar-toggle.tsx');
  const navStoreSrc = read('frontend/src/features/nav/nav-store.js');
  const header = read('frontend/src/features/header/platform-header.tsx');

  // THE STATE SHIPS OPEN, which is what makes it safe to hold in the nav
  // store at all: the prerendered document carries a visible bar, so the
  // first client render agrees with it and hydration is silent.
  assert.match(navStoreSrc, /railOpen: true,/);
  assert.match(toggle, /aria-pressed=\{railOpen \? 'true' : 'false'\}/,
    'the state is on the control, so the label can stay the ACTION');
  assert.match(toggle, /aria-label=\{railOpen \? 'Hide sidebar' : 'Show sidebar'\}/);
  assert.match(toggle, /aria-controls="platform-tabs"/);

  // IT RENDERS NOTHING WHERE THE ROUTE HAS NO RAIL — inside an app,
  // chromeless, signed out. A toggle for a thing that is not there is a dead
  // control, and an app's rail comes back by pointing at the window's edge.
  assert.match(toggle, /const hasRail = useVisibility\('platform-tabs', true\);/);
  assert.match(toggle, /if \(!hasRail\) return null;/);

  // IT LIVES IN THE MEASURED LEFT GROUP, so use-header-layout.ts counts it
  // without being told: that hook decides whether the title can centre from
  // the group's inner edge, and a control outside the group is 28px of room
  // it would hand to the title.
  assert.match(header, /<SidebarToggle \/>/);
  assert.match(header, /const hasRail = useVisibility\('platform-tabs', true\);/);
  assert.match(header,
    /\+ \(mode !== 'none' \? '' : hasRail \? ' platform-header-left-desktop' : ' hidden'\)/,
    'three states: content at every width, desktop-only, or gone');

  // A PHONE'S BAR IS AT THE FOOT OF THE SCREEN and is the only navigation
  // there is. Folding must never reach it — so the fold is a CLASS that
  // app.css acts on inside the desktop media query and nowhere else, rather
  // than the `hidden` the router uses. A desktop window narrowed to a phone
  // gets its bar back with no store watching the viewport.
  assert.match(read('frontend/src/features/nav/tab-bar.tsx'),
    /useClassToggle\(barRef, 'platform-tabs-folded', !railOpen\);/);
  const folded = css.indexOf('.platform-tabs.platform-tabs-folded:not(.platform-tabs-peek)');
  assert.ok(folded > 0, 'a folded rail is not drawn');
  assert.ok(css.lastIndexOf('@media (min-width: 768px) {', folded) > 0);
  // …and it is not drawn only while it is not peeking, which is what makes
  // the hot zone at the window's edge the way back from folded.
  assert.match(css.slice(folded, folded + 120), /:not\(\.platform-tabs-peek\) \{\s*display: none;/);
  // The toggle itself is desktop-only by the same mechanism, and the group
  // that holds it goes with it when the back slot is empty — an
  // empty-but-present flex item still reserves the header's own `gap-4`,
  // which put the wordmark 16px in from the edge of every root screen the
  // first time this was tried. The id beats Tailwind's own `.flex`, which
  // wins equal-specificity conflicts because app.css loads first.
  assert.match(css, /\.platform-sidebar-toggle \{\n  display: none;\n\}/);
  assert.match(css,
    /@media \(max-width: 767px\) \{[\s\S]{0,600}#platform-header \.platform-header-left-desktop \{\s*display: none;/);
  // FOLDED RESERVES NOTHING, and only on the desktop layout.
  const zero = css.indexOf('body:has(#platform-tabs.platform-tabs-folded)');
  assert.ok(zero > 0);
  assert.ok(css.lastIndexOf('@media (min-width: 768px) {', zero) > 0,
    'the zeroing rule is inside the desktop block, so a phone never sees it');
  assert.match(css.slice(zero, zero + 120), /\{\s*--platform-rail-w: 0px;/);
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
  assert.match(css, /--platform-rail-w: 0px;\n  --platform-gutter: 0px;\n\}/,
    'and the rail costs a phone no width at all, nor the gutter beside it');
  assert.match(css,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\):has\(#platform-parked:not\(\.hidden\)\) \{\s*--platform-tabs-h: calc\(52px \+ 56px \+ var\(--platform-safe-bottom, 0px\)\);/,
    'the strip adds its own band, and only while the bar is there to sit on '
    + 'for real rather than peeking over an app');
  assert.match(css, /\.platform-parked \{[^}]*bottom: var\(--platform-bar-h, 0px\);/,
    'and it rests ON the bar, so neither reserves the home-indicator twice');
  assert.match(css, /html\.un-kb #platform-tabs \{\s*display: none;/,
    'the keyboard takes the bar with it');
});
