'use strict';

// #4417: THE SECTION COLUMN, beside the desktop strip.
//
// The 224px rail is a 76px strip of sections (tests/nav-tab-bar.test.js),
// and beside it a 264px column belongs to the section on screen: a project's
// places in Communities, the conversation list in Messages, none on Home and
// Discover. On a phone there is no column: the places are the tray behind
// the project page's place bar (tests/project-places.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const COLUMN = 'frontend/src/features/nav/section-column.tsx';
const css = read('public/css/app.css');
const desktop = (() => {
  const at = css.indexOf('@media (min-width: 768px) {\n  /* THE BAND AT THE FOOT GOES AWAY');
  return css.slice(at, css.indexOf('\n}\n', css.indexOf('.platform-parked-pill {', at)));
})();

test('264px beside the 76px strip, reserved only while it is drawn', () => {
  assert.match(css, /--platform-rail-full: 76px;/);
  assert.match(css, /--platform-column-full: 264px;/);
  const { SECTION_COLUMN_W } = loadTsx(COLUMN);
  assert.equal(SECTION_COLUMN_W, 264);
  // On a phone it is never drawn, whatever its class says.
  assert.match(css, /\n\.platform-section-column \{\n  display: none;\n\}/);
  // On a desktop: fixed beside the strip, under the header to the floor, and
  // only while the strip is docked (not folded, not peeking).
  const rule = desktop.match(/body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\):not\(\.platform-tabs-folded\)\) \.platform-section-column:not\(\.hidden\) \{[^}]*\}/);
  assert.ok(rule, 'drawn while the strip is docked');
  assert.match(rule[0], /position: fixed;/);
  assert.match(rule[0], /left: var\(--platform-rail-full\);/);
  assert.match(rule[0], /width: var\(--platform-column-full\);/);
  assert.match(rule[0], /background: var\(--dc-sheet-fill\);/, 'the strip\'s own glass over the wallpaper (#4624)');
  assert.match(rule[0], /box-shadow: inset -1px 0 0 var\(--app-sheet-line\);/, 'the strip\'s hairline at its edge');
  // The page moves over by it as it moves over by the strip.
  assert.match(desktop, /:has\(#platform-section-column:not\(\.hidden\)\) \{\s*--platform-column-w: var\(--platform-column-full\);\s*\}/);
  assert.match(desktop, /:has\(#platform-section-column:not\(\.hidden\)\) #app-view \{\s*padding-left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-column-w, 0px\) \+ var\(--platform-gutter\)\);/);
  // Beside the column the list is there: the page's bar is its title, and
  // its tray's button goes, unless the strip is folded (the column with it).
  assert.match(desktop, /:not\(\.platform-tabs-folded\)\):has\(#platform-section-column:not\(\.hidden\)\) \.dev-ws-places-btn \{\s*display: none;/);
});

test('which column: a project\'s places under Communities, none anywhere else', () => {
  const { columnFor } = loadTsx(COLUMN);
  assert.equal(columnFor({ screen: 'app-view', tab: 'workshop', placeSlug: 'notes' }), 'places', 'a project\'s page');
  assert.equal(columnFor({ screen: 'app-view', tab: 'workshop', placeSlug: null }), null, 'before the page has said where it is');
  assert.equal(columnFor({ screen: 'app-view', tab: null, placeSlug: 'notes' }), null, 'a running app');
  assert.equal(columnFor({ screen: 'workshop-screen', tab: 'workshop', placeSlug: null }), null, 'All communities');
  assert.equal(columnFor({ screen: 'home-screen', tab: 'home', placeSlug: 'notes' }), null, 'Home');
  assert.equal(columnFor({ screen: 'browse-screen', tab: 'discover', placeSlug: 'notes' }), null, 'Discover');
  // Messages' column is its own list (below), not this element.
  assert.equal(columnFor({ screen: 'messages-screen', tab: 'messages', placeSlug: 'notes' }), null);
  // An item's page open beside the list: the column steps aside for it,
  // the strip, the column, the list and the panel not fitting under 1024px.
  const page = { screen: 'app-view', tab: 'workshop', placeSlug: 'notes' };
  assert.equal(columnFor({ ...page, side: true }), null, 'a panel open');
  assert.equal(columnFor({ ...page, side: false }), 'places', 'no panel open');
  // v3: from 1024px the sidebar of rows nests the places, and there is no column.
  assert.equal(columnFor({ ...page, sidebarRows: true }), null, 'the sidebar of rows');
});

test('the column steps aside for the side panel, told by the page, and for the sidebar of rows', () => {
  const src = read(COLUMN);
  assert.doesNotMatch(src, /COLUMN_BESIDE_SIDE_QUERY|roomBesideSide/, 'from 1024px there is no column to keep beside the panel');
  assert.match(src, /const sidebarRows = useSidebarRows\(\);\s*const column = columnFor\(\{ screen, tab, placeSlug: place\.slug, side: place\.side, sidebarRows \}\);/);
  const { placeStore, publishPlace, publishSide, clearPlace } = loadTsx('frontend/src/features/dev-board/workshop/place-store.ts');
  publishPlace('notes', 'all', 0);
  assert.equal(placeStore.get().side, false);
  publishSide('other', true);
  assert.equal(placeStore.get().side, false, 'another project\'s page says nothing here');
  publishSide('notes', true);
  assert.equal(placeStore.get().side, true);
  publishPlace('notes', 'all', 2);
  assert.equal(placeStore.get().side, true, 'a new count keeps it');
  clearPlace('notes');
  // #4703 added unread and tray to the state, for the merged header's button.
  assert.deepEqual(placeStore.get(),
    { slug: null, place: 'status', owed: 0, side: false, unread: 0, tray: false });
});

test('the places column is the page\'s list, and a press there moves the page in place', () => {
  const src = read(COLUMN);
  assert.match(src, /<ProjectPlaces\s+slug=\{slug\}[\s\S]*?place=\{place\.place\}\s*owed=\{place\.owed\}\s*places=\{community\?\.places\}/);
  assert.match(src, /onPlace=\{\(key\) => \{ openPlace\(slug, key\); \}\}/);
  assert.match(src, /useHiddenClass\(ref, column === null\);/);
  // Ships hidden and empty, exactly as the first client render draws it.
  const html = renderComponent(COLUMN, 'SectionColumn', {});
  assert.equal(html, '<aside id="platform-section-column" class="platform-section-column hidden" aria-label="Places"></aside>');
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="PlatformTabs"><PlatformTabs \/><\/Island>\s*\{\/\*[\s\S]*?\*\/\}\s*<Island name="SectionColumn"><SectionColumn \/><\/Island>/);
  // The page publishes where it is and how to move it (place-store.ts).
  const store = read('frontend/src/features/dev-board/workshop/place-store.ts');
  assert.match(store, /export function openPlace\(slug: string, key: PlaceKey, opts: \{ replace\?: boolean \} = \{\}\): boolean \{\s*if \(opener && opener\.slug === slug && placeStore\.get\(\)\.slug === slug\) \{\s*opener\.open\(key\);/);
});

test('Messages has no column: on a desktop the sidebar nests the conversations and the list is a page (v3)', () => {
  assert.doesNotMatch(desktop, /#messages-screen > \.messages-layout > \.messages-list-pane \{[^}]*--platform-column-full/,
    'the list no longer takes the column\'s width beside the strip');
  // It stays where its checks find it.
  assert.match(read('frontend/src/features/messages/index.tsx'), /<section className=\{`messages-list-pane /);
  assert.match(read('frontend/src/features/messages/index.tsx'), /const railClass = sidebarRows && !drawer\.on \? \(discussionOpen \? ' messages-list-in-rail' : ' messages-list-page'\) : '';/);
});

test('Home and Discover have no column; the strip is all the navigation there', () => {
  // No rule draws one for those screens: the element is hidden by React,
  // and Home and Discover move over by the strip alone.
  assert.match(desktop, /:is\(#home-screen, #browse-screen, #workshop-screen,[^)]*\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?padding-left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/);
  assert.doesNotMatch(desktop, /#(?:home|browse)-screen[^{]*\{[^}]*--platform-column-w/);
});

// #5308: with the strip folded on a project page, the peek brings the places
// list back beside it — the same one peek state (features/nav/rail-peek.ts)
// driving both elements, as the parked strip is already a follower of it.
test('the peeked column rides the peeked rail: one peek state, two elements', () => {
  const src = read(COLUMN);
  // The same shared pair the strip, the hot zone, the toggle and the parked
  // strip use, so the pointer crossing from the strip onto the column keeps
  // one grace timer.
  assert.match(src, /import \{ enterPeekByMouse, leavePeekByMouse \} from '\.\/rail-peek';/);
  // Both classes go through useClassToggle, like `hidden` does: the class
  // string the aside renders stays a constant.
  assert.match(src, /const peeking = column !== null && !railOpen && peek;/);
  assert.match(src, /useClassToggle\(ref, 'platform-section-column-peek', peeking\);/);
  assert.match(src, /useClassToggle\(ref, 'platform-section-column-peek-out', peeking && peekOut\);/);
  // A follower, never a starter: bound only while a peek is up.
  assert.match(src, /onPointerEnter=\{peek \? enterPeekByMouse : undefined\}/);
  assert.match(src, /onPointerLeave=\{peek \? leavePeekByMouse : undefined\}/);
  // The prerendered markup is unchanged — the empty hidden aside of the test
  // above still pins it exactly.

  // The peek rule sits inside the desktop media query, at the docked
  // column's geometry with the peeked rail's surface.
  const peek = css.match(/body:has\(#platform-tabs\.platform-tabs-peek\) \.platform-section-column\.platform-section-column-peek:not\(\.hidden\) \{[^}]*\}/);
  assert.ok(peek, 'the peek rule is there');
  const at = css.indexOf(peek[0]);
  assert.ok(css.lastIndexOf('@media (min-width: 768px)', at) !== -1, 'inside the desktop media query');
  assert.match(peek[0], /position: fixed;/);
  assert.match(peek[0], /top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\)/);
  assert.match(peek[0], /left: var\(--platform-rail-full\);/);
  assert.match(peek[0], /width: var\(--platform-column-full\);/);
  assert.match(peek[0], /display: flex;/, 'the base `display: none` stands aside, as the docked rule\'s does');
  assert.match(peek[0], /z-index: 40;/, 'level with the peeked rail');
  assert.match(peek[0], /background-color: var\(--dc-sheet-solid\);/, 'the peeked rail\'s surface, not the docked glass');
  assert.match(peek[0], /border-right: 1px solid var\(--app-sheet-line\);/);
  assert.match(peek[0], /box-shadow: 0 8px 32px rgba\(0, 0, 0, 0\.18\);/);
  assert.match(peek[0], /animation: platform-rail-peek-in 140ms ease-out;/);
  assert.match(peek[0], /transition: opacity 200ms ease-in;/);
  // It fades out with the rail.
  const out = css.match(/\.platform-section-column-peek\.platform-section-column-peek-out \{\s*opacity: 0;\s*\}/);
  assert.ok(out, 'the fade-out rule is there');
  // No reserved width anywhere mentions the peek: the page does not reflow.
  assert.doesNotMatch(css, /--platform-column-w:[^;]*platform-section-column-peek/);
  assert.doesNotMatch(css, /:has\(#platform-tabs\.platform-tabs-peek\)[^{]*\{[^}]*--platform-column-w:/);
  // Reduced motion stills it with the rail and the parked strip.
  assert.match(css, /body:has\(#platform-tabs\.platform-tabs-peek\) \.platform-section-column\.platform-section-column-peek \{ animation: none; \}/);
  assert.match(css, /body:has\(#platform-tabs\.platform-tabs-peek\) \.platform-section-column\.platform-section-column-peek \{ transition: none; \}/);
  // The dark tone's light face covers the column too (the id wins over the
  // peek rule's classes, exactly as the peeked rail's does).
  assert.match(css, /\.dark\[data-app-tone="light"\] #platform-section-column\.platform-section-column-peek \{[^}]*background-color: #faf9f2;/);
});
