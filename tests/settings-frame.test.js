// Settings in the one frame. The 2026-11-06 screen tour draws every section
// of Settings as the frame's page (s57 to s73): the section under its title
// in the content column, the other sections as a list in the context column
// beside it. The product already has both parts (features/settings/
// index.tsx: the section's sheet and the section list), the other way round
// and in one centred sheet, so under a look they are laid as the kit's page
// by app.css alone, for all its sections at once. On a phone the product's
// own two levels are the tour's: the list, then a section.
//
// Run with: node --test tests/settings-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const css = read('public/css/app.css');
const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
const ANY = 'html\\[data-skin\\]:where\\(:not\\(\\[data-skin="brand"\\]\\)\\)';

test('on a wide window the section comes first at the kit\'s 720px, the list of sections 320px after it', () => {
  const wide = hand.slice(hand.indexOf('SETTINGS (features/settings/index.tsx)'));
  assert.match(wide, new RegExp(`@media \\(min-width: 1024px\\) \\{\\s+${ANY} #settings-root \\{ max-width: 1136px; padding: 32px 32px 48px; \\}`));
  assert.match(wide, new RegExp(`${ANY} #settings-content-col \\{ order: 1; flex: 0 1 720px; \\}`));
  assert.match(wide, new RegExp(`${ANY} #settings-sidebar-col \\{ order: 2; flex: 0 0 320px; width: 320px; \\}`));
});

test('the section\'s sheet is put away so its groups sit on the page, and its title is the kit\'s', () => {
  assert.match(hand, new RegExp(`${ANY} #settings-section-content\\.settings-sheet \\{[^}]*background: none; box-shadow: none;`));
  assert.match(hand, new RegExp(`${ANY} #settings-section-content\\.settings-sheet \\{[^}]*border-radius: 0; border-top: 0;`), 'the sheet\'s top hairline goes with its fill and shadow: alone it drew a line across the page over the title');
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.match(looks.wear.roots.title.to, /\.settings-page-title/, 'each look\'s own title rule reaches it');
  assert.match(css, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) :is\(\.settings-page-title,#first-session-make-title,[^{]*\)\{font-size:28px;/);
});

test('the screen\'s own markup is untouched: the same ids the standard look and the declared checks read', () => {
  const src = read('frontend/src/features/settings/index.tsx');
  for (const id of ['settings-root', 'settings-sidebar-col', 'settings-content-col', 'settings-section-content']) {
    assert.match(src, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(src, /isFrameSkin|useLiveSkin/, 'laid out by the stylesheet alone');
});

// The sections' own rows (the tour's s57 to s69): under a look a section's
// grouped lists wear the kit's card and row, its parts' headings are the
// kit's small-caps labels, and the page's title carries one sentence saying
// what the page is for.
test('the grouped list and its row carry stable names, so a look can dress them where a screen asks', () => {
  const src = read('frontend/@/components/ui/grouped-list.tsx');
  assert.match(src, /const groupedList = cva\('ui-glist mx-4 overflow-hidden rounded-\[20px\]/);
  assert.match(src, /'ui-lrow relative flex w-full items-center gap-4 px-4 py-3\.5 text-start',/);
  assert.match(src, /<div className=\{cn\('ui-lrow-tx min-w-0 flex-1', contentClassName\)\}>/);
  assert.match(src, /'ui-lrow-t truncate text-\[0\.9375rem\] font-\[650\] leading-5 text-zinc-900 dark:text-zinc-100',/);
  assert.match(src, /cn\('ui-lrow-s mt-0\.5 truncate text-\[0\.8125rem\] leading-\[1\.125rem\] text-zinc-500 dark:text-zinc-400', subtitleClassName\)/);
  assert.match(src, /<ChevronRightIcon className="ui-lrow-go h-5 w-5 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden="true" \/>/);
  const field = read('frontend/@/components/ui/field.tsx');
  assert.match(field, /<h3 className=\{cn\('ui-sechead text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1', className\)\}>/);
  assert.match(field, /<p className=\{cn\('ui-secblurb text-xs text-zinc-500 dark:text-zinc-500 mb-3', blurbClassName\)\}>/);
});

test('in Settings the lists wear the kit\'s card and row, and nothing else does', () => {
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.match(looks.wear.roots.card.to, /\.ui-glist:where\(#settings-section-content \*\)/, 'scoped inside the compound, so a rule naming the card twice stays one selector');
  assert.deepEqual(looks.wear.roots.row, {
    to: '.ui-lrow:where(#settings-section-content *)',
    parts: { tx: '.ui-lrow-tx', t: '.ui-lrow-t', s: '.ui-lrow-s', go: '.ui-lrow-go' },
  });
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\] \.fr-row\+\.fr-row,html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.ui-lrow:where\(#settings-section-content \*\)\+\.ui-lrow:where\(#settings-section-content \*\)\{border-top:1px solid var\(--fr-line2\)\}/);
  assert.match(css, /html\[data-skin\] \.fr-row \.fr-t,html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.ui-lrow:where\(#settings-section-content \*\) \.ui-lrow-t\{font-weight:650;/);
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\] #settings-section-content \.ui-lrow::after \{ display: none; \}/, 'the kit\'s line between rows, not the list\'s own hairline as well');
  assert.match(hand, /html\[data-skin\]\.dark #settings-section-content \.ui-glist \{ background: var\(--fr-surface\); \}/, 'the look\'s surface over the dark card the utilities paint last');
  assert.match(hand, new RegExp(`${ANY} #settings-section-content \\.ui-sechead \\{ font-size: 12px; font-weight: 700; letter-spacing: \\.06em; text-transform: uppercase; color: var\\(--fr-mut\\); margin: 0 0 8px; padding: 0 4px; \\}`));
  assert.match(hand, new RegExp(`${ANY} #settings-section-content \\.ui-secblurb \\{ font-size: 13px; color: var\\(--fr-mut\\); margin: -4px 0 12px; padding: 0 4px; \\}`));
});

test('under a look every page is named once at its head, with one sentence saying what it is for', () => {
  const src = read('frontend/src/features/settings/settings-nav.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(src, /const purpose = frame \? pagePurpose\(key\) : null;/);
  assert.match(src, /<p className="settings-page-purpose" data-settings-page-purpose="">\{purpose\}<\/p>/);
  const { loadTsx } = require('./lib/render-tsx');
  const { pagePurpose } = loadTsx('frontend/src/features/settings/settings-nav.tsx', { cache: false });
  assert.equal(pagePurpose('account'), 'Your profile and how you sign in.');
  assert.equal(pagePurpose('theme'), 'How Homeroom looks on this browser.');
  assert.equal(pagePurpose('nope'), null, 'a page without a sentence has none');
  const css = read('public/css/app.css');
  assert.match(css, /@media \(min-width: 1024px\) \{\s*html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.settings-page-title \{ display: block; margin: 0 0 24px; \}\s*html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.settings-page-purpose \{ margin: -16px 0 24px; \}/, 'a one-part page too, where the standard look lets the part name it; the sentence draws up under the name');
  assert.match(css, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.settings-page-purpose \{ display: block; font-size: 15px; color: var\(--fr-mut\); margin: 0 0 20px; max-width: 60ch; \}/, 'on a phone the bar names the page and the sentence opens it');
  assert.match(css, /\.settings-page-purpose \{ display: none; \}/, 'the standard look has no sentence');
});
