'use strict';

// The overnight UI audit's desktop and tablet findings (1 Nov 2026, batch 6):
// the rules each fix rests on, where a screenshot is the only other witness.
// The layout itself is checked at 800, 1024, 1440 and 1920 by
// `npm run audit:layout -- --profiles desktop-800,desktop-1024,...`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS = read('public/css/app.css');
const SCREEN = read('frontend/src/features/apps/browse-screen.tsx');

test('W02: Discover sits in the page column Home, Settings and Challenges share', () => {
  assert.match(SCREEN, /const PAGE_COLUMN = 'max-w-5xl mx-auto';/);
  assert.match(SCREEN, /id="browse-list-level" className=\{onDetail \? `hidden \$\{PAGE_COLUMN\}` : PAGE_COLUMN\}/);
  assert.match(read('frontend/src/features/settings/index.tsx'), /id="settings-root" className="max-w-5xl mx-auto/);
  assert.match(read('frontend/src/features/leaderboard/index.tsx'), /className="max-w-5xl mx-auto px-4 pt-5 pb-4 w-full"/);
  const home = CSS.slice(CSS.indexOf('\n.home-column {'));
  assert.match(home.slice(0, 200), /max-width: 64rem;/, 'Home\'s column is the same 64rem (max-w-5xl)');
});

test('W04 / I9: the search, the view switch and the type row end where the boxes do', () => {
  assert.match(SCREEN, /const CONTROL_COLUMN = 'max-w-\[62\.5rem\] mx-auto';/);
  assert.equal((SCREEN.match(/\$\{CONTROL_COLUMN\}/g) || []).length, 3);
  assert.doesNotMatch(SCREEN, /className=[^\n]*max-w-xl/, 'none of them stops at 576px any more');
  // inline-flex beat flex in the cascade and left the strip an inline box.
  assert.match(SCREEN, /SECTION_TABS_LIST_BASE\.replace\('inline-flex', 'flex'\)/);
});

test('W03: the box grid counts its columns from its own width', () => {
  assert.match(read('frontend/src/features/apps/browse-list.tsx'),
    /export const BOX_COLUMNS = 'md:grid-cols-\[repeat\(auto-fill,minmax\(20rem,1fr\)\)\]';/);
  assert.match(SCREEN, /className=\{`browse-pane-body md:grid \$\{BOX_COLUMNS\} md:gap-3 md:p-3`\}/);
});

test('W06: My apps keeps four columns but stops growing at 40rem; Home\'s search clears the bar', () => {
  assert.match(read('frontend/src/features/home/app-grid.tsx'), /id="app-list"\s*\n(?:.*\n)*?\s*className="grid grid-cols-4 [^"]* md:max-w-\[40rem\]"/);
  assert.match(read('frontend/src/features/home/index.tsx'), /<div className="home-column px-3 pt-3 md:pt-5 pb-2">/);
});

test('W07: an empty Challenges tab is the card Home draws, on the tabs\' edge', () => {
  const src = read('frontend/src/features/leaderboard/challenges-pane.tsx');
  assert.match(src, /<GroupedList className="mx-0 mt-4" data-challenges-empty="">\s*<ListRow\s*chevron=\{false\}\s*title=\{t\('leaderboard:challenges\.empty'\)\}\s*subtitle=\{t\('leaderboard:challenges\.emptyHint'\)\}/);
  assert.equal(message('leaderboard:challenges.empty'), 'No challenges right now');
  assert.equal(message('leaderboard:challenges.emptyHint'), 'New ones will show up here.');
  assert.equal(message('leaderboard:challenges.empty'), message('home:challenges.none.title'), 'the same words as Home');
  assert.equal(message('leaderboard:challenges.emptyHint'), message('home:challenges.none.text'));
});

test('D12: on By stage the place title widens with the board', () => {
  assert.match(CSS, /@media \(min-width: 768px\) \{\s*#dev-workshop\.dev-ws-has-board > \.dev-ws > \.dev-ws-placebar \{ max-width: none; \}/);
});

test('W05: "Find a setting" is the shell\'s search pill, with its glyph', () => {
  const html = renderComponent('frontend/src/features/settings/settings-nav.tsx', 'SettingsNavDesktop', {});
  assert.ok(typeof html === 'string');
  const src = read('frontend/src/features/settings/settings-nav.tsx');
  assert.match(src, /<div className="messages-search settings-filter">\s*<SearchIcon className="messages-search-glyph w-5 h-5" aria-hidden="true" \/>\s*<input/);
  assert.doesNotMatch(src, /from '@\/components\/ui\/input'/);
});
