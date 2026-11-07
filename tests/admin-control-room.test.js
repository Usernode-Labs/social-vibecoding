// The admin console's control room (#6454): the desktop rail of groups and
// its panel, the Overview dashboard that refreshes itself, Search or jump
// (⌘K / Ctrl+K), and the band's Production / Staging word.
//
// Front end only. What is pinned here:
//
//  - the rail is written into #admin-nav-desktop by _navItemsHtml, from the
//    same grouping the phone menu reads, with Overview first and "All
//    sections" last; the current group carries aria-current="true", and
//    every section row keeps data-admin-section so _wireSectionButtons and
//    the declared checks still find it;
//  - arriving at a section (route, open, jumpTo) clears the picked group, so
//    the rail follows the address; a rail press opens the group's first
//    section through setSection;
//  - the attention count is stuckApps + orphanWorkers from
//    /api/admin/overview, on Overview and Operations only, hidden at zero;
//  - the dashboard keeps the ids the checks select, polls every 30 s only
//    while mounted and visible, and destroy() clears the timer;
//  - the palette matches labels and synonyms, lists only _visibleSections(),
//    opens through the chassis, and its key listener lives only while the
//    console is open;
//  - the environment word comes from GET /api/version's `env` and is hidden
//    when it is unknown.
//
// Run with: node --test tests/admin-control-room.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ADMIN = path.join(root, 'frontend/src/features/admin');
const consoleJs = fs.readFileSync(path.join(ADMIN, 'admin-console.js'), 'utf8');
const islandTsx = fs.readFileSync(path.join(ADMIN, 'index.tsx'), 'utf8');
const overviewTsx = fs.readFileSync(path.join(ADMIN, 'admin-overview.tsx'), 'utf8');
const paletteTsx = fs.readFileSync(path.join(ADMIN, 'admin-palette.tsx'), 'utf8');
const sectionsTs = fs.readFileSync(path.join(ADMIN, 'sections.ts'), 'utf8');
const dapp = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// One member of the AdminConsole object, up to its own closing brace.
function method(src, head) {
  const at = src.indexOf(head);
  assert.ok(at > -1, `${head.trim()} exists`);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf('\n  },\n'));
}

// ── A runnable copy of the chassis, for the rail's behaviour ─────────────
//
// admin-console.js is an ES module that reaches for window/document, so the
// object literal is evaluated in a sandbox with just enough of both.
function loadConsole({ section = 'overview', publicMode = false } = {}) {
  const vm = require('node:vm');
  const src = consoleJs
    .replace(/^export const AdminUI/m, 'const AdminUI')
    .replace(/import\('\.\/sections\.ts'\)/g, 'Promise.resolve()');
  const store = {};
  const sandbox = {
    window: {},
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    location: { hash: '#admin' },
    history: { replaceState() {} },
    console,
  };
  sandbox.window.addEventListener = () => {};
  sandbox.window.App = { user: { isAdmin: !publicMode } };
  sandbox.App = sandbox.window.App;
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;globalThis.__AC = AdminConsole;`, sandbox);
  const AC = sandbox.__AC;
  AC._section = section;
  AC._public = publicMode;
  return AC;
}

test('the rail lists Overview first, then the groups, then All sections', () => {
  const AC = loadConsole();
  const names = [...AC._railGroups().map((g) => g.name)];
  assert.deepEqual(names, ['Overview', 'Operations', 'Programme', 'People', 'Insights', 'Platform']);
  assert.ok(!AC._railGroups().find((g) => g.name === 'Operations').items.some((s) => s.key === 'overview'),
    'Overview is its own rail group, not the first row of Operations');
  const html = AC._navItemsHtml();
  const rail = [...html.matchAll(/data-admin-rail-group="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rail, [...names, 'All'], 'All sections sits at the foot of the rail');
  assert.match(html, /data-admin-rail-group="Overview" aria-current="true"/,
    'the group of the section on screen is the highlighted one');
  assert.match(html, /data-admin-rail role="group" aria-label="Section groups"/);
});

test('the panel lists the selected group, and All lists every group with headings', () => {
  const AC = loadConsole({ section: 'users' });
  let html = AC._navItemsHtml();
  assert.match(html, /data-admin-rail-group="People" aria-current="true"/,
    'a section selects its own group by arriving');
  assert.match(html, /data-admin-panel="People"/);
  assert.match(html, /aria-current="page"\s+data-admin-section="users"/,
    'the row keeps data-admin-section and is the current page');
  assert.ok(!html.includes('data-admin-section="seasons"'), 'other groups are not in the panel');
  assert.ok(!/role="tab"|aria-selected/.test(html), 'rows are links of the nav, never tabs');

  AC._railGroup = AC.RAIL_ALL;
  html = AC._navItemsHtml();
  assert.match(html, /data-admin-panel="All"/);
  for (const key of AC.SECTIONS.map((s) => s.key)) {
    assert.ok(html.includes(`data-admin-section="${key}"`), `All lists ${key}`);
  }
  for (const g of ['Operations', 'Programme', 'People', 'Insights', 'Platform']) {
    assert.ok(html.includes(`>${g}</p>`), `All carries the ${g} heading`);
  }
});

test('public mode narrows the rail to the public sections', () => {
  const AC = loadConsole({ section: 'status', publicMode: true });
  assert.deepEqual([...AC._railGroups().map((g) => g.name)], ['Operations']);
  const html = AC._navItemsHtml();
  assert.ok(html.includes('data-admin-section="status"') && html.includes('data-admin-section="node"'));
  assert.ok(!html.includes('data-admin-section="overview"'), 'no Overview for a non-admin');
  AC._railGroup = AC.RAIL_ALL;
  assert.ok(!AC._navItemsHtml().includes('data-admin-section="users"'), 'All is narrowed too');
});

test('the attention badge is on Overview and Operations only, hidden at zero', () => {
  const AC = loadConsole();
  let html = AC._navItemsHtml();
  const badges = html.match(/data-admin-rail-badge/g) || [];
  assert.equal(badges.length, 2, 'two badges: Overview and Operations');
  assert.match(html, /leading-\[18px\] text-white hidden">0</, 'zero says nothing');
  AC._attention = 3;
  html = AC._navItemsHtml();
  assert.match(html, /text-white">3</);
  assert.match(html, /aria-label="Operations, 3 need attention"/, 'the count is in words for a screen reader');

  const load = method(consoleJs, '  async _loadAttention() {');
  assert.match(load, /fetchJson\('\/api\/admin\/overview'\)/, 'read from the overview endpoint only');
  assert.match(load, /stuckApps[\s\S]*orphanWorkers/);
  assert.match(load, /if \(AdminConsole\._publicMode\(\)\) return;/, 'never for a non-admin');
});

test('arriving selects the group; a rail press opens the first section', () => {
  for (const head of ['  open(section, opts) {', '  jumpTo(key) {']) {
    assert.match(method(consoleJs, head), /AdminConsole\._railGroup = null;/,
      `${head.trim()} lets the arriving section pick the group`);
  }
  const route = method(consoleJs, '  route(section, opts) {');
  assert.match(route, /AdminConsole\._railGroup = null;\s*\n\s*AdminConsole\.setSection\(targetSection/,
    'a desktop address change selects its group');
  const wire = method(consoleJs, '  _wireRail(root) {');
  assert.match(wire, /AdminConsole\.setSection\(group\.items\[0\]\.key\)/, 'opens the group\'s first section');
  assert.match(wire, /\.focus\(\)/, 'focus returns to the rail after the repaint');
  const shell = method(consoleJs, '  _renderShell() {');
  assert.match(shell, /_wireSectionButtons\(sideHost\)/, 'rows still route through the shared wiring');
  assert.match(shell, /_wireRail\(sideHost\)/);
});

test('the dashboard keeps its checked ids and refreshes only while mounted', () => {
  for (const id of ['admin-overview-stuck', 'admin-overview-llm', 'admin-overview-orphan',
    'admin-refresh-overview', 'admin-overview-attention', 'admin-overview-spenders']) {
    assert.ok(overviewTsx.includes(`id="${id}"`), `#${id} is rendered`);
  }
  assert.match(overviewTsx, /const REFRESH_MS = 30000;/);
  assert.match(overviewTsx, /document\.visibilityState === 'visible'/, 'a hidden tab skips the tick');
  assert.match(overviewTsx, /return \(\) => \{\s*\n\s*stopTimer\(\);/, 'the effect cleanup clears the timer');
  const destroy = overviewTsx.slice(overviewTsx.indexOf('destroy() {'));
  assert.ok(destroy.indexOf('stopTimer()') > -1 && destroy.indexOf('stopTimer()') < destroy.indexOf('unmountLegacyPortal('),
    'destroy() clears the timer before the portal goes');
  assert.match(overviewTsx, /fetchJson\('\/api\/admin\/overview'\)/, 'the same one read as before');
  assert.match(overviewTsx, /jump\('status'\)/, 'a worker opens Health & status');
  assert.match(overviewTsx, /jump\('apps'\)/, 'an app opens Apps & usage');
  assert.match(overviewTsx, /jump\('model-costs'\)/, 'spenders open Model costs');
  assert.match(overviewTsx, /\.slice\(0, 5\)/, 'top five spenders');
  assert.match(overviewTsx, /All clear: no stuck apps and no orphan workers right now\./);
  assert.ok(!/<a\s/.test(overviewTsx), 'no anchors: nothing API-supplied becomes a link');
  assert.ok(!/method: '(POST|PUT|PATCH|DELETE)'/.test(overviewTsx), 'the dashboard writes nothing');
});

test('the palette matches labels and synonyms', async () => {
  // A tiny transpile: strip the TS-only syntax matchSections uses.
  const src = paletteTsx.slice(paletteTsx.indexOf('export const SYNONYMS'), paletteTsx.indexOf('const OPTION ='))
    .replace(/export /g, '')
    .replace(/: Readonly<Record<string, readonly string\[\]>>/, '')
    .replace(/\(sections: PaletteSection\[\], query: string\): PaletteSection\[\]/, '(sections, query)')
    .replace(/const scored: Array<\{ s: PaletteSection; score: number; i: number \}> = \[\];/, 'const scored = [];');
  const vm = require('node:vm');
  const box = {};
  vm.runInNewContext(`${src}\n;this.matchSections = matchSections;`, box);
  const AC = loadConsole();
  const all = AC._visibleSections().map((s) => ({ key: s.key, label: s.label, group: AC._railGroupOf(s.key) }));
  const first = (q) => box.matchSections(all, q)[0]?.key;
  assert.equal(first('spend'), 'model-costs');
  assert.equal(first('llm'), 'model-costs');
  assert.equal(first('budget'), 'model-costs');
  assert.equal(first('bounce'), 'mail');
  assert.equal(first('errors'), 'incidents');
  assert.ok(box.matchSections(all, 'abuse').some((s) => s.key === 'reports'));
  assert.equal(first('backup'), 'db-export');
  assert.equal(first('users'), 'users', 'a label start ranks first');
  assert.equal(box.matchSections(all, '').length, all.length, 'an empty query lists everything');
  assert.equal(box.matchSections(all, 'zzzz').length, 0);
});

test('the palette lists visible sections, opens through the chassis, and listens only while open', () => {
  const open = method(consoleJs, '  openPalette() {');
  assert.match(open, /AdminConsole\._visibleSections\(\)/, 'only what this viewer may see');
  assert.match(open, /AdminConsole\.jumpTo\(key\)/);
  const jump = method(consoleJs, '  jumpTo(key) {');
  assert.match(jump, /if \(AdminConsole\._isMobile\(\)\) AdminConsole\._openSection\(key\);\s*\n\s*else AdminConsole\.setSection\(key\);/);

  const bind = method(consoleJs, '  _bindShortcut() {');
  assert.match(bind, /e\.metaKey \|\| e\.ctrlKey/);
  assert.match(bind, /document\.addEventListener\('keydown', AdminConsole\._onKeydown\)/);
  assert.match(method(consoleJs, '  open(section, opts) {'), /AdminConsole\._bindShortcut\(\);/);
  assert.match(method(consoleJs, '  close() {'), /AdminConsole\._unbindShortcut\(\);/);
  assert.match(method(consoleJs, '  _unbindShortcut() {'), /document\.removeEventListener\('keydown'/);

  assert.match(paletteTsx, /e\.key === 'ArrowDown'/);
  assert.match(paletteTsx, /e\.key === 'ArrowUp'/);
  assert.match(paletteTsx, /e\.key === 'Enter'/);
  assert.match(paletteTsx, /e\.key === 'Escape'/);
  assert.match(paletteTsx, /returnFocus = document\.activeElement/, 'focus is remembered…');
  assert.match(paletteTsx, /back\.focus\(\)/, '…and restored on close');
  assert.match(paletteTsx, /getElementById\('admin-palette-host'\)/);
  assert.match(sectionsTs, /import '\.\/admin-palette\.tsx';/, 'it rides in the lazy section chunk');
  assert.match(islandTsx, /<div id="admin-palette-host"><\/div>/, 'its host ships empty');
  assert.match(islandTsx, /id="admin-search-open"/, 'the band has a visible Search or jump button');
  assert.match(islandTsx, /Search or jump…/);
});

test('the band names the environment from /api/version, hidden when unknown', () => {
  assert.match(islandTsx, /data-admin-env="production" className="hidden /);
  assert.match(islandTsx, /data-admin-env="staging" className="hidden /);
  const load = method(consoleJs, '  _loadEnv() {');
  assert.match(load, /App\._lastVersionInfo/, 'reuses the shell\'s own /api/version answer when it has one');
  assert.match(load, /fetchJson\('\/api\/version'\)/);
  assert.match(load, /data && data\.env \? String\(data\.env\) : null/);
  const paint = method(consoleJs, '  _paintEnv() {');
  assert.match(paint, /classList\.toggle\('hidden', el\.getAttribute\('data-admin-env'\) !== env\)/,
    'only the word naming this build shows; null shows neither');
});

test('dapp.json checks the rail and panel in place of the #1152 toggles', () => {
  const tests = dapp.tests || [];
  const rail = tests.find((t) => t.path === '/#admin/users'
    && /\[data-admin-rail-group="People"\]\[aria-current="true"\]/.test(t.expectSelector || ''));
  assert.ok(rail, 'a check deep-links Users and finds People lit on the rail');
  assert.match(rail.expectSelector, /\[data-admin-panel="People"\] \[data-admin-section="users"\]/);
  const dash = tests.find((t) => t.path === '/#admin' && /#admin-overview-attention/.test(t.expectSelector || ''));
  assert.ok(dash, 'a check finds the dashboard on /#admin');
  assert.match(dash.expectSelector, /\[data-admin-rail-group="Overview"\]\[aria-current="true"\]/);
});
