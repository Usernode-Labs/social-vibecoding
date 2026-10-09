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
  assert.match(css, /\.platform-strip-apps,\n\.platform-section-column \{\n  display: none;\n\}/);
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
  // An item's page open beside the list: the column steps aside for it
  // where the window has no room for both, and stays where it has.
  const page = { screen: 'app-view', tab: 'workshop', placeSlug: 'notes' };
  assert.equal(columnFor({ ...page, side: true, roomBesideSide: false }), null, 'under 1296px');
  assert.equal(columnFor({ ...page, side: true, roomBesideSide: true }), 'places', 'from 1296px');
  assert.equal(columnFor({ ...page, side: false, roomBesideSide: false }), 'places', 'no panel open');
});

test('the column steps aside for the side panel under 1296px, told by the page', () => {
  const src = read(COLUMN);
  assert.match(src, /export const COLUMN_BESIDE_SIDE_QUERY = '\(min-width: 1296px\)';/);
  assert.match(src, /const roomBesideSide = useMatches\(COLUMN_BESIDE_SIDE_QUERY\);\s*const column = columnFor\(\{ screen, tab, placeSlug: place\.slug, side: place\.side, roomBesideSide \}\);/);
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
  assert.deepEqual(placeStore.get(), { slug: null, place: 'status', owed: 0, side: false });
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

test('Messages\' column is its conversation list, flush with the strip; the conversation fills the page', () => {
  assert.match(desktop, /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\):not\(\.platform-tabs-folded\)\) #messages-screen \{\s*padding-left: var\(--platform-rail-w, 0px\);\s*\}/,
    'no gutter between the strip and the list');
  const list = desktop.match(/#messages-screen > \.messages-layout > \.messages-list-pane \{[^}]*\}/);
  assert.ok(list, 'the inbox\'s own list pane is the column');
  assert.match(list[0], /flex: 0 0 var\(--platform-column-full\);/);
  assert.match(list[0], /width: var\(--platform-column-full\);/);
  assert.match(list[0], /background: var\(--dc-sheet-fill\);/, 'the same glass as the section column (#4624)');
  assert.match(list[0], /box-shadow: inset -1px 0 0 var\(--app-sheet-line\);/);
  // It stays where its checks find it.
  assert.match(read('frontend/src/features/messages/index.tsx'), /<section className=\{`messages-list-pane /);
});

test('Home and Discover have no column; the strip is all the navigation there', () => {
  // No rule draws one for those screens: the element is hidden by React,
  // and Home and Discover move over by the strip alone.
  assert.match(desktop, /:is\(#home-screen, #browse-screen, #workshop-screen,[^)]*\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?padding-left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/);
  assert.doesNotMatch(desktop, /#(?:home|browse)-screen[^{]*\{[^}]*--platform-column-w/);
});
