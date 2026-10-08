'use strict';

// The composer's + → Share item searches and filters with chips (#3937).
//
// The dialog was two dropdowns, Item type and App, the second one a long
// list of every app the viewer can see. Now:
//
//   - a search box leads the dialog and narrows the app list as you type,
//     by the app's name (or its short name), every word in any order;
//   - Item type is a row of chips, one per type the dropdown offered, App
//     chosen by default; it has no "All", because the type IS what is
//     attached;
//   - the app list is a list, with All / Your projects / Other projects
//     chips (the dropdown's two option groups) that combine with the search;
//   - nothing matching says so, Enter in the search box attaches nothing,
//     and the chips and rows keep a 44px tap target on a phone.
//
// Run with: node --test tests/messages-share-item-search.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const FILE = 'frontend/src/features/messages/share-dialog.tsx';
let cached = null;
const mod = () => (cached || (cached = loadTsx(FILE)));
const src = () => fs.readFileSync(path.join(__dirname, '..', FILE), 'utf8');

const APPS = [
  { id: 1, slug: 'recipe-box', name: 'Recipe Box', mine: false },
  { id: 2, slug: 'flat-4b-chores-e98ecd', name: 'Flat 4B Chores', mine: true },
  { id: 3, slug: 'plant-pal', name: 'Plant Pal', mine: false },
  { id: 4, slug: 'book-club', name: 'Book Club', mine: true },
];
const ids = (rows) => rows.map((row) => row.id);

test('the search narrows the apps by name or short name, every word in any order', () => {
  const { filterAppChoices } = mod();
  assert.deepEqual(ids(filterAppChoices(APPS)), [2, 4, 1, 3], 'nothing typed: every app, own projects first');
  assert.deepEqual(ids(filterAppChoices(APPS, { query: '' })), [2, 4, 1, 3]);
  assert.deepEqual(ids(filterAppChoices(APPS, { query: '   ' })), [2, 4, 1, 3], 'blank is nothing typed');
  assert.deepEqual(ids(filterAppChoices(APPS, { query: 'plant' })), [3]);
  assert.deepEqual(ids(filterAppChoices(APPS, { query: 'RECIPE' })), [1], 'in any case');
  assert.deepEqual(ids(filterAppChoices(APPS, { query: 'chores flat' })), [2], 'every word, in any order');
  assert.deepEqual(ids(filterAppChoices(APPS, { query: 'e98ecd' })), [2], 'by the short name too');
  assert.deepEqual(ids(filterAppChoices(APPS, { query: 'b' })), [2, 4, 1], 'in the list’s own order');
  assert.deepEqual(ids(filterAppChoices(APPS, { query: 'zebra' })), []);
});

test('the group chips filter the list, and combine with the search', () => {
  const { filterAppChoices, offersAppGroups, APP_GROUPS } = mod();
  assert.deepEqual(APP_GROUPS.map((g) => [g.value, g.label]), [
    ['all', 'All'], ['mine', 'Your projects'], ['others', 'Other projects'],
  ], 'All first, then the dropdown’s two option groups');
  assert.deepEqual(ids(filterAppChoices(APPS, { group: 'all' })), [2, 4, 1, 3]);
  assert.deepEqual(ids(filterAppChoices(APPS, { group: 'mine' })), [2, 4]);
  assert.deepEqual(ids(filterAppChoices(APPS, { group: 'others' })), [1, 3]);
  assert.deepEqual(ids(filterAppChoices(APPS, { group: 'others', query: 'b' })), [1], 'search AND chip');
  assert.deepEqual(ids(filterAppChoices(APPS, { group: 'mine', query: 'plant' })), [], 'a match outside the group is not shown');
  // Only offered when there are two groups to tell apart, as the dropdown
  // only drew its option groups then.
  assert.equal(offersAppGroups(APPS), true);
  assert.equal(offersAppGroups(APPS.filter((a) => a.mine)), false);
  assert.equal(offersAppGroups(APPS.filter((a) => !a.mine)), false);
  assert.equal(offersAppGroups([]), false);
});

test('the item types are the dropdown’s, as chips, App first', () => {
  const { SHARE_TYPES } = mod();
  assert.deepEqual(SHARE_TYPES.map((t) => t.value), ['app', 'issue', 'proposal', 'governance', 'spec']);
  assert.deepEqual(SHARE_TYPES.map((t) => t.label), ['App', 'GitHub issue', 'Code proposal', 'Governance proposal', 'Plan version']);
});

test('the prerendered dialog leads with the search box, then the type chips, and no dropdown', () => {
  const html = renderToHtml(createElement(mod().ShareItemDialog));
  assert.ok(!html.includes('<select'), 'no dropdown is left');
  const search = html.indexOf('type="search"');
  assert.ok(search > 0, 'a search box');
  assert.match(html, /<input type="search"[^>]*aria-label="Search apps"/);
  assert.ok(search < html.indexOf('aria-pressed'), 'the search box is the first control after the close button');
  const chips = [...html.matchAll(/<button type="button" aria-pressed="(true|false)" class="([^"]+)" data-share-type="([a-z]+)"/g)];
  assert.deepEqual(chips.map((m) => [m[3], m[1]]), [
    ['app', 'true'], ['issue', 'false'], ['proposal', 'false'], ['governance', 'false'], ['spec', 'false'],
  ], 'one chip per type, App chosen');
  for (const [, , cls] of chips) {
    assert.match(cls, /\bh-11\b/, 'a 44px tap target on a phone');
    assert.match(cls, /\bsm:h-9\b/, 'the bar size from sm up');
    assert.match(cls, /focus-visible:ring-2/, 'a visible focus for keyboard use');
  }
  // Chosen is the language's solid inversion; at rest a chip takes the
  // field fill, since the primitive's resting white is the card's own.
  assert.match(chips[0][2], /\bbg-zinc-900 text-white\b/);
  for (const [, , cls] of chips.slice(1)) {
    assert.match(cls, /\bbg-zinc-100\b/);
    assert.doesNotMatch(cls, /\bbg-white\b/);
  }
  // Closed, the list is an empty shell: no rows, no empty state, and no
  // group chips before any app has loaded.
  assert.match(html, /<div role="listbox" aria-label="Apps" data-share-apps="" class="[^"]*"><\/div>/);
  assert.ok(!html.includes('data-share-group'));
  assert.ok(!html.includes('No apps'));
});

test('the list draws a row per app, the chosen one marked, and says when nothing matches', () => {
  const { AppChoiceRows } = mod();
  const draw = (props) => renderToHtml(createElement(AppChoiceRows, {
    rows: APPS, appId: 3, open: true, loading: false, failed: false, searching: false, onChoose() {}, ...props,
  }));
  const html = draw({});
  const rows = [...html.matchAll(/<button type="button" role="option" aria-selected="(true|false)" data-share-app="([^"]+)" class="([^"]+)"/g)];
  assert.deepEqual(rows.map((m) => [m[2], m[1]]), [
    ['recipe-box', 'false'], ['flat-4b-chores-e98ecd', 'false'], ['plant-pal', 'true'], ['book-club', 'false'],
  ]);
  for (const [, , , cls] of rows) assert.match(cls, /\bmin-h-\[44px\] sm:min-h-\[36px\]/, 'a 44px tap target on a phone');
  assert.equal((html.match(/>Selected</g) || []).length, 1);
  assert.match(draw({ rows: [], searching: true }), />No apps match your search\.</);
  assert.match(draw({ rows: [] }), />No apps to share from yet\.</);
  assert.match(draw({ rows: [], loading: true }), />Loading apps…</);
  assert.equal(draw({ rows: [], failed: true }), '', 'the dialog’s alert says the list did not load');
  assert.equal(draw({ open: false }), '', 'nothing while closed');
});

test('Enter in the search box attaches nothing, and attaching is unchanged', () => {
  const source = src();
  assert.match(source, /onKeyDown=\{\(event\) => \{ if \(event\.key === 'Enter'\) event\.preventDefault\(\); \}\}/);
  assert.ok(!/<form\b/.test(source), 'no form for Enter to submit');
  assert.match(source, /<Button type="button" disabled=\{!canAttach\} onClick=\{attach\}>Attach item<\/Button>/,
    'Attach item stays the only way to attach');
  assert.match(source, /window\.dispatchEvent\(new CustomEvent\('usernode:messages-object-selected', \{ detail: reference \}\)\);/);
  // Pressing the chosen type again keeps the number already typed.
  assert.match(source, /onClick=\{\(\) => \{ if \(option\.value !== type\) \{ setType\(option\.value\); setItemId\(''\); setVersion\(''\); \} \}\}/);
  // Search and group start over on every open.
  assert.match(source, /setQuery\(''\); setGroup\('all'\);/);
  // The shell's own chip primitive, not a hand-drawn one.
  assert.match(source, /import \{ Chip, ChipRail \} from '@\/components\/ui\/chip';/);
});
