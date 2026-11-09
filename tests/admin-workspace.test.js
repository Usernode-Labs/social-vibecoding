// The admin console as a workspace (#6456): on a desktop a top bar of group
// menus replaces the sidebar, opened sections stay open as tabs, Home is the
// Overview section grown into a page, and ⌘K / Ctrl+K searches the sections.
//
// Pinned here:
//  - the rules in features/admin/admin-workspace.js, executed: the tab list
//    (append, keep, cap at eight dropping the oldest that is not on screen,
//    close to the neighbour, Home never stored), the stored list pruned of
//    junk and unknown keys, the search's synonyms, the home sentence and the
//    pinned shortcuts filtered to what the viewer can see;
//  - the chassis wiring in admin-console.js: the bar and strip drawn into the
//    #admin-nav-desktop host, every section button carrying
//    data-admin-section and routed through _wireSectionButtons, the menus'
//    keyboard and outside-press handling, the strip wrapping rather than
//    scrolling sideways, storage wrapped and versioned, the search key bound
//    only while the console is open and searching only _visibleSections(),
//    the environment label read from /api/version's `env`;
//  - the home page in admin-overview.tsx keeps the ids declared checks
//    select, and navigates only through the chassis;
//  - the two declared checks that replaced the sidebar's (#1152).
//
// Run with: node --test tests/admin-workspace.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const consoleJs = read('frontend/src/features/admin/admin-console.js');
const overviewTsx = read('frontend/src/features/admin/admin-overview.tsx');
const islandTsx = read('frontend/src/features/admin/index.tsx');
const dapp = JSON.parse(read('dapp.json'));

const ws = loadTsx('frontend/src/features/admin/admin-workspace.js');

function method(src, head) {
  const at = src.indexOf(head);
  assert.ok(at > -1, `${head.trim()} exists`);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf('\n  },\n'));
}

// The section keys, read from SECTIONS rather than restated.
const SECTION_KEYS = [...consoleJs.slice(consoleJs.indexOf('SECTIONS: ['), consoleJs.indexOf('LEGACY_SECTION_KEYS'))
  .matchAll(/\{ key: '([^']+)', label: '([^']+)', group: '([^']+)'/g)]
  .map((m) => ({ key: m[1], label: m[2], group: m[3] }));

test('SECTIONS parses, so the rest of this file tests the real list', () => {
  assert.ok(SECTION_KEYS.length >= 40, `read ${SECTION_KEYS.length} sections`);
  assert.equal(SECTION_KEYS[0].key, 'overview');
});

// ── Tabs ────────────────────────────────────────────────────────────────

test('opening a section appends a tab, once, and never one for Home', () => {
  let tabs = [];
  tabs = ws.addTab(tabs, 'users');
  tabs = ws.addTab(tabs, 'support');
  tabs = ws.addTab(tabs, 'users');
  tabs = ws.addTab(tabs, 'overview');
  assert.deepEqual(tabs, ['users', 'support']);
});

test('the strip holds eight; a ninth drops the oldest that is not on screen', () => {
  assert.equal(ws.MAX_TABS, 8);
  const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.deepEqual(ws.addTab(eight, 'i'), ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  // Re-opening one already there keeps all eight in place.
  assert.deepEqual(ws.addTab(eight, 'a'), eight);
});

test('closing the active tab opens its right neighbour, else its left, else Home', () => {
  assert.deepEqual(ws.closeTab(['a', 'b', 'c'], 'b', 'b'), { tabs: ['a', 'c'], next: 'c' });
  assert.deepEqual(ws.closeTab(['a', 'b', 'c'], 'c', 'c'), { tabs: ['a', 'b'], next: 'b' });
  assert.deepEqual(ws.closeTab(['a'], 'a', 'a'), { tabs: [], next: 'overview' });
  // Closing a tab that is not on screen changes nothing else.
  assert.deepEqual(ws.closeTab(['a', 'b'], 'a', 'b'), { tabs: ['b'], next: null });
  assert.deepEqual(ws.closeTab(['a'], 'zzz', 'a'), { tabs: ['a'], next: null });
});

test('the stored list is cleaned: junk, unknown keys, Home and repeats go; legacy keys resolve', () => {
  const known = SECTION_KEYS.map((s) => s.key);
  const canonical = (k) => ({ topochain: 'seasons', 'bot-configs': 'homeroom-bot' }[k] || k);
  assert.deepEqual(ws.parseStoredTabs(null, known, canonical), []);
  assert.deepEqual(ws.parseStoredTabs('{not json', known, canonical), []);
  assert.deepEqual(ws.parseStoredTabs('{"a":1}', known, canonical), []);
  assert.deepEqual(
    ws.parseStoredTabs(JSON.stringify(['users', 42, 'gone-section', 'overview', 'topochain', 'users', 'mail']), known, canonical),
    ['users', 'seasons', 'mail']);
  const many = JSON.stringify(known.slice(1, 15));
  assert.equal(ws.parseStoredTabs(many, known, canonical).length, 8, 'never more than the strip holds');
});

// ── Search ──────────────────────────────────────────────────────────────

test('search finds a section by its label and by the words people use for it', () => {
  const first = (q) => (ws.searchSections(SECTION_KEYS, q)[0] || {}).key;
  assert.equal(first('users'), 'users');
  assert.equal(first('health'), 'status');
  for (const q of ['spend', 'llm', 'budget']) assert.ok(ws.searchSections(SECTION_KEYS, q).some((s) => s.key === 'model-costs'), `${q} finds Model costs`);
  assert.equal(first('budget'), 'model-costs');
  assert.equal(first('bounce'), 'mail');
  assert.equal(first('bounces'), 'mail', 'a longer word still finds its synonym');
  assert.ok(ws.searchSections(SECTION_KEYS, 'mail').slice(0, 2).some((s) => s.key === 'mail'));
  assert.equal(first('errors'), 'incidents');
  assert.equal(first('abuse'), 'reports');
  assert.equal(first('reports'), 'reports');
  assert.equal(first('backup'), 'db-export');
  assert.deepEqual(ws.searchSections(SECTION_KEYS, 'xyzzy'), []);
  assert.equal(ws.searchSections(SECTION_KEYS, '  ').length, SECTION_KEYS.length, 'an empty query lists everything');
});

test('search offers only what it is given: the viewer\'s visible sections', () => {
  const publicOnly = SECTION_KEYS.filter((s) => ['status', 'node'].includes(s.key));
  assert.deepEqual(ws.searchSections(publicOnly, 'users'), []);
  assert.deepEqual(ws.searchSections(publicOnly, '').map((s) => s.key), ['status', 'node']);
  const open = method(consoleJs, '  openSearch() {');
  assert.match(open, /searchSections\(AdminConsole\._visibleSections\(\), input\.value\)/);
});

// ── Home ────────────────────────────────────────────────────────────────

test('the home sentence counts what needs a person', () => {
  assert.equal(ws.needsYouSentence(null), null);
  assert.equal(ws.needsYouSentence({ stuckApps: [], orphanWorkers: [] }), 'Nothing needs you right now');
  assert.equal(ws.needsYouSentence({ stuckApps: [{}], orphanWorkers: [] }), '1 thing needs you');
  assert.equal(ws.needsYouSentence({ stuckApps: [{}], orphanWorkers: [{}] }), '2 things need you');
});

test('Pinned is the six most used sections, only those the viewer can open', () => {
  assert.deepEqual([...ws.PINNED_KEYS], ['support', 'users', 'reports', 'status', 'model-costs', 'mail']);
  assert.deepEqual(ws.pinnedSections(SECTION_KEYS).map((s) => s.key), [...ws.PINNED_KEYS]);
  const publicOnly = SECTION_KEYS.filter((s) => ['status', 'node'].includes(s.key));
  assert.deepEqual(ws.pinnedSections(publicOnly).map((s) => s.key), ['status']);
});

test('the home page keeps the ids declared checks select, and goes through the chassis', () => {
  for (const id of ['admin-overview-stuck', 'admin-overview-llm', 'admin-overview-orphan', 'admin-refresh-overview']) {
    assert.ok(overviewTsx.includes(`id="${id}"`), `#${id} is still rendered`);
  }
  assert.match(overviewTsx, />Admin home</);
  assert.match(overviewTsx, /needsYouSentence\(data\)/, 'the sentence comes from /api/admin/overview');
  assert.match(overviewTsx, /pinnedSections\(visible\)/);
  assert.match(overviewTsx, /_visibleSections\?\.\(\)/, 'only the viewer\'s sections');
  assert.match(overviewTsx, /_groupedSections\?\.\(\)/, 'All sections is grouped as the bar is');
  assert.match(overviewTsx, /AdminConsole\?\.goTo\?\.\(section\.key\)/, 'a card navigates through the chassis');
  assert.match(overviewTsx, /data-admin-section=\{section\.key\}/);
  assert.match(overviewTsx, /NAV_ICONS\?\.\[section\.key\]/, 'the glyph is the chassis\'s own static icon');
  assert.doesNotMatch(overviewTsx, /<a\s/, 'no anchors: nothing a server sent becomes a link');
  // A phone's level 1 keeps the tiles alone above the chassis's own menu.
  assert.match(overviewTsx, /compact=\{el\.id === 'admin-mobile-overview'\}/);
  assert.match(overviewTsx, /if \(compact\) return ops;/);
});

// ── The chassis ─────────────────────────────────────────────────────────

test('the bar and the strip are drawn into the desktop host and wired from it', () => {
  const shell = method(consoleJs, '  _renderShell() {');
  assert.match(shell, /sideHost\.innerHTML = AdminConsole\._topBarHtml\(\) \+ AdminConsole\._tabStripHtml\(\);/);
  assert.match(shell, /_wireSectionButtons\(sideHost\)/, 'every section button routes through the chassis');
  assert.match(shell, /_wireTopBar\(sideHost\)/);
  assert.match(islandTsx, /<div\s+id="admin-nav-desktop"\s+className="hidden md:block shrink-0"\s*>\s*<\/div>/,
    'the host still ships empty, and only from md up');
  assert.match(islandTsx, /md:flex md:flex-col md:gap-8/, 'stacked, not side by side');
});

test('the bar: Home, a menu per group with the current one marked, Search and the environment', () => {
  const bar = method(consoleJs, '  _topBarHtml() {');
  assert.match(bar, /data-admin-section="overview" data-admin-topnav-home=""/);
  assert.match(bar, /data-admin-topnav-group="\$\{AdminConsole\.esc\(g\.name\)\}"/);
  assert.match(bar, /aria-haspopup="menu" aria-expanded="false" aria-controls="\$\{menuId\}"/);
  assert.match(bar, /isCurrent \? ' aria-current="true"' : ''/);
  assert.match(bar, /role="menuitem" tabindex="-1" data-admin-section="\$\{s\.key\}"/);
  assert.match(bar, /data-admin-search-open=""/);
  assert.match(bar, /_envLabelHtml\(\)/);
  assert.match(bar, /_groupedSections\(\)/, 'grouped by the helper the phone menu uses');
});

test('the menus answer the keyboard and close on a press outside', () => {
  const wire = method(consoleJs, '  _wireTopBar(host) {');
  for (const key of ["'ArrowDown'", "'ArrowUp'", "'Enter'", "' '", "'Escape'", "'Home'", "'End'", "'ArrowRight'", "'ArrowLeft'"]) {
    assert.ok(new RegExp(`e\\.key [!=]== ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(wire), `handles ${key}`);
  }
  const open = method(consoleJs, '  _openTopMenu(button, focusIndex) {');
  assert.match(open, /document\.addEventListener\('pointerdown', onOutside, true\)/);
  const close = method(consoleJs, '  _closeTopMenu(refocus) {');
  assert.match(close, /document\.removeEventListener\('pointerdown', m\.onOutside, true\)/,
    'the outside listener lives only while a menu is open');
  assert.match(close, /if \(refocus && m\.button\.isConnected\) m\.button\.focus\(\)/, 'Esc gives focus back');
});

test('the strip: Home first and unclosable, tabs closable by × and middle-click, wrapping', () => {
  const strip = method(consoleJs, '  _tabStripHtml() {');
  assert.match(strip, /parts\.push\(tab\(byKey\.get\('overview'\), false\)\)/, 'Home first, no close');
  assert.match(strip, /data-admin-tab-close="\$\{s\.key\}"/);
  assert.match(strip, /data-admin-tab="\$\{s\.key\}"\$\{on \? ' aria-current="page"' : ''\}/);
  assert.match(strip, /flex flex-wrap/, 'the strip wraps');
  assert.doesNotMatch(consoleJs, /overflow-x-(auto|scroll)/, 'nothing scrolls sideways');
  const wire = method(consoleJs, '  _wireTopBar(host) {');
  assert.match(wire, /addEventListener\('auxclick'/);
  assert.match(wire, /e\.button !== 1/);
  const close = method(consoleJs, '  _closeTab(key) {');
  assert.match(close, /if \(next\) AdminConsole\.setSection\(next\);/);
});

test('tabs persist per browser under a versioned key, wrapped, and never for public mode', () => {
  assert.equal(ws.TABS_KEY, 'admin_open_tabs_v1');
  const load = method(consoleJs, '  _loadTabs() {');
  assert.match(load, /localStorage\.getItem\(TABS_KEY\)/);
  assert.match(load, /try \{/);
  assert.match(load, /if \(typeof window === 'undefined'\) return;/);
  const save = method(consoleJs, '  _saveTabs() {');
  assert.match(save, /localStorage\.setItem\(TABS_KEY/);
  assert.match(save, /\} catch \{/);
  assert.match(save, /if \(AdminConsole\._publicMode\(\)\) return;/);
  const set = method(consoleJs, '  setSection(key, opts) {');
  assert.ok(set.indexOf('_noteTab(key)') > -1 && set.indexOf('_noteTab(key)') < set.indexOf('_renderShell()'),
    'a section opens its tab before the strip is drawn');
});

test('⌘K / Ctrl+K listens only while the console is open', () => {
  const open = method(consoleJs, '  open(section, opts) {');
  assert.match(open, /AdminConsole\._bindSearchKey\(\);/);
  const close = method(consoleJs, '  close() {');
  assert.match(close, /AdminConsole\._unbindSearchKey\(\);/);
  assert.match(close, /AdminConsole\.closeSearch\(\{ refocus: false \}\);/);
  const key = method(consoleJs, '  _onSearchKey(e) {');
  assert.match(key, /if \(!AdminConsole\._open \|\| e\.defaultPrevented/);
  assert.match(key, /\(e\.metaKey \|\| e\.ctrlKey\)/);
  const pick = method(consoleJs, '  _pickSearch(key) {');
  assert.match(pick, /AdminConsole\.goTo\(key\)/);
  const goTo = method(consoleJs, '  goTo(key) {');
  assert.match(goTo, /if \(AdminConsole\._isMobile\(\)\) AdminConsole\._openSection\(key\);\s*else AdminConsole\.setSection\(key\);/,
    'a drill-in on a phone, an in-place switch on a desktop');
  const dlg = method(consoleJs, '  closeSearch(opts) {');
  assert.match(dlg, /s\.root\.remove\(\)/);
  assert.match(dlg, /s\.returnFocus\.focus\(\)/, 'focus returns where it was');
});

test('the environment label reads /api/version\'s env and hides when unknown', () => {
  const load = method(consoleJs, '  _loadEnv() {');
  assert.match(load, /fetchJson\('\/api\/version'\)/);
  assert.match(load, /App\._lastVersionInfo/);
  const label = method(consoleJs, '  _envLabelHtml() {');
  assert.match(label, />Production</);
  assert.match(label, />Staging</);
  assert.match(label, /class="hidden"/);
});

test('the declared checks pin the bar and the tabs instead of the sidebar', () => {
  const tests = dapp.tests || [];
  const home = tests.find((t) => t.path === '/#admin' && /data-admin-topnav-home/.test(t.expectSelector || ''));
  assert.ok(home, 'a check on /#admin selects the bar with Home lit');
  assert.match(home.expectSelector, /\[data-admin-search-open\]/);
  assert.match(home.expectSelector, /\[data-admin-tab="overview"\]/);
  const users = tests.find((t) => t.path === '/#admin/users' && /data-admin-topnav-group="People"/.test(t.expectSelector || ''));
  assert.ok(users, 'a check on /#admin/users marks People as the current group');
  assert.match(users.expectSelector, /\[data-admin-topnav-group="People"\]\[aria-current="true"\]/);
  assert.match(users.expectSelector, /\[data-admin-tab="users"\]\[aria-current="page"\]/);
});
