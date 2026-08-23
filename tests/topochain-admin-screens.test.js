// Topochain admin console screens (Task 15) — static source assertions,
// mirroring tests/admin-console-page.test.js and tests/topochain-screens.js
// in style: no server boot, no DB, just source-level checks that the
// wiring, security discipline (esc()/safeHref()/canWrite()) and vocabulary
// rules from the task brief actually landed in the code.
//
// Run with: node --test tests/topochain-admin-screens.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const consoleJs = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
const topoJs = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-topochain.js'), 'utf8');
// The eleven screens are converting to React one at a time (#1120 slice 24).
// A converted screen leaves admin-topochain.js for ./topochain/, so the rules
// about ITS markup follow it there; everything about the module's shell,
// routing and remaining screens still reads topoJs.
const apiTesterTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/admin/topochain/api-tester.tsx'), 'utf8');
const topoUiTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/admin/topochain/ui.tsx'), 'utf8');
const topoTokens = fs.readFileSync(
  path.join(root, 'frontend/src/features/admin/topochain/tokens.ts'), 'utf8');

// Built screens only — the four documented gaps (challenge-kinds,
// terms-versions, token-allocation, mobile-logs) must NOT appear as a
// SUBS entry (no API exists for any of them; mobile-logs' one usable
// capability, accept_logs, is folded into the Users form instead).
// Since #1179 every SUBS key is also a first-class AdminConsole SECTIONS
// key; the programme Users screen is the deliberate exception — it has no
// section of its own, the console's Users section embeds renderUsers.
const BUILT_SUBS = [
  'seasons', 'season-events', 'challenge-templates', 'waitlist',
  'onchain-accounts', 'user-activities', 'delegations',
  'settings', 'app-version', 'sql-console', 'api-tester',
];
const GAP_SUBS = ['challenge-kinds', 'terms-versions', 'token-allocation', 'mobile-logs'];

// Several bans below ("no window.prompt", "no matchMedia") are about what
// the module DOES, and this file's comments deliberately record what each
// call site replaced — prose that would otherwise trip the ban it exists
// to explain. Same line-comment strip the vocabulary test uses.
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');

// The converted screens' prose lives in BOTH comment forms — a `.tsx` header
// is `//` lines, but an explanation inside JSX has to be a `{/* … */}` block.
// The "no raw HTML" checks below are about what the file DOES, so they strip
// both; several of those comments name `innerHTML` to say what the conversion
// replaced.
const stripAllComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ─── admin-console.js: the promoted sections + delegation ─────────────────

test('AdminConsole.SECTIONS promotes every programme screen under the #1179 groups', () => {
  // #1179 retired the single "Seasons, Events & Challenges" entry and its
  // horizontal sub-nav: each screen is a first-class section in the main
  // menu now, grouped Programme / People / Platform, and each entry
  // navigates straight to its screen.
  assert.doesNotMatch(consoleJs, /label: 'Seasons, Events & Challenges'/,
    'the umbrella entry is gone from the menu');
  const EXPECT = {
    'seasons': ['Seasons', 'Programme'],
    'season-events': ['Season events', 'Programme'],
    'challenge-templates': ['Challenge templates', 'Programme'],
    'waitlist': ['Waitlist', 'People'],
    'onchain-accounts': ['Onchain accounts', 'People'],
    'user-activities': ['User activities', 'People'],
    'delegations': ['Delegations', 'People'],
    'settings': ['Settings', 'Platform'],
    'app-version': ['App version', 'Platform'],
    'sql-console': ['SQL console', 'Platform'],
    'api-tester': ['API tester', 'Platform'],
  };
  for (const [key, [label, group]] of Object.entries(EXPECT)) {
    assert.match(consoleJs, new RegExp(`\\{ key: '${key}', label: '${label}', group: '${group}' \\}`),
      `SECTIONS carries '${key}' as "${label}" under ${group}`);
  }
  // The existing platform-accounts Users entry survives the merge — one
  // Users menu entry, both surfaces (see the renderUsersSection test below).
  assert.match(consoleJs, /\{ key: 'users', label: 'Users', group: 'People' \}/,
    'the existing Users entry is kept');
  const matches = consoleJs.match(/key: 'seasons'/g) || [];
  assert.equal(matches.length, 1, "'seasons' appears exactly once in SECTIONS (the Seasons screen itself)");
  assert.doesNotMatch(consoleJs, /key: 'topochain'/,
    'the old key is gone from SECTIONS — it survives only as a legacy alias');
});

test('the console Users section embeds the programme users screen (merged, #1179)', () => {
  // The section moved out of the chassis into its own module in #1120 slice
  // 22. The arrangement is unchanged: a host rendered by the section, the
  // stale-response guard armed before the render, and both surfaces coexisting.
  const fn = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/admin/admin-users.tsx'), 'utf8');
  assert.match(fn, /id="admin-users-programme"/,
    'the section renders a host for the programme users card');
  assert.match(fn, /topochain\._sub = 'users';/,
    "the module's stale-response guard is armed before the render");
  assert.match(fn, /topochain\.renderUsers\(programme\.current\)/,
    'and the programme users screen renders into it');
  // Armed BEFORE, not after — the loaders read `_sub` to decide whether their
  // response is still wanted, so the order is the whole point.
  assert.ok(fn.indexOf("topochain._sub = 'users';") < fn.indexOf('topochain.renderUsers('),
    'the guard is set before renderUsers is called');
  // The platform-accounts card is untouched — both surfaces coexist.
  assert.match(fn, /id="admin-user-list"/, 'the platform accounts list is still there');
});

test("the retired 'topochain' key still resolves, at ONE choke point", () => {
  // Links, bookmarks and the odd hand-typed hash minted before the rename
  // must not 404 into the fallback section. The alias is resolved at the
  // two entry points BEFORE visibility, module lookup, nav highlighting or
  // hash writing see the key — so the rest of admin-console.js only ever
  // handles canonical keys and no third code path can forget the mapping.
  assert.match(consoleJs, /LEGACY_SECTION_KEYS: \{[\s\S]*?topochain: 'seasons',[\s\S]*?\}/,
    'the retired key maps to the canonical one');
  assert.match(consoleJs, /_canonicalSection\(key\) \{/, 'one resolver');
  const open = consoleJs.slice(consoleJs.indexOf('  open(section, opts'));
  assert.match(open.slice(0, 600), /section = AdminConsole\._canonicalSection\(section\);/,
    'open() canonicalises before it resolves visibility');
  const setSection = consoleJs.slice(consoleJs.indexOf('  setSection(key, opts'));
  assert.match(setSection.slice(0, 400), /key = AdminConsole\._canonicalSection\(key\);/,
    'setSection() canonicalises as its first statement');
});

test('_renderSection dispatches every promoted screen to AdminTopochain via SECTION_MODULES', () => {
  // #860 replaced the per-section render*Section methods for delegated
  // sections with the SECTION_MODULES map, so every module-backed section
  // goes through one render/destroy code path. The
  // module's own name stays AdminTopochain: renaming the global and its
  // file would churn the service-worker precache list (public/sw.js) for
  // no user-visible gain.
  assert.match(consoleJs, /SECTION_MODULES: \{/, 'the module map exists');
  const modules = consoleJs.slice(consoleJs.indexOf('SECTION_MODULES: {'),
    consoleJs.indexOf('_teardownActiveSection() {'));
  for (const key of BUILT_SUBS) {
    assert.match(modules, new RegExp(`'?${key}'?: 'AdminTopochain'`),
      `SECTION_MODULES maps '${key}' to the AdminTopochain global`);
  }
  // The dispatch body moved into `_renderModule` in #1120 slice 16, when
  // `overview` became a module and the switch's `default:` arm had to reach
  // the same code path. Same single choke point, one function further down.
  const fn = consoleJs.slice(consoleJs.indexOf('  _renderSection() {'));
  assert.match(fn.slice(0, 1200), /_renderModule\(host, modName, key\)/,
    'the dispatcher hands the host to the mapped module');
  const dispatch = consoleJs.slice(consoleJs.indexOf('  _renderModule(host, modName, key) {'));
  assert.match(dispatch.slice(0, 600), /mod\.render\(host\)/,
    'and _renderModule calls render(host) on it');
  assert.match(consoleJs, /_teardownActiveSection\(\)/,
    'and tears the outgoing section down first');
});

test('admin-console.js needed no changes to its single-level hash handling', () => {
  // The task brief allows extending admin-console.js's hash handling if it
  // only supports one level, but the minimal-and-safe path taken here is
  // that AdminTopochain owns its OWN second hash level entirely (reads
  // location.hash directly, writes it back itself) — so setSection/open/
  // _writeHash in admin-console.js are untouched single-level logic.
  assert.match(consoleJs, /setSection\(key, opts\) \{/, 'setSection signature unchanged');
  assert.match(consoleJs, /_writeHash\(key\) \{/, '_writeHash signature unchanged (no sub-key parameter added)');
});

// ─── module registration ──────────────────────────────────────────────────

test('admin-topochain.js is imported by the console island, after admin-console.js', () => {
  // Until #1082 chunk E this was a <script> tag in the shell, ordered after
  // admin-console.js's tag and before app.js's. Both modules are in the React
  // bundle now, so the ordering that matters is the island's import order —
  // and the console must still come first, because admin-topochain.js reads
  // AdminUI.card at module-evaluation time.
  const island = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/index.tsx'), 'utf8'
  );
  const order = [...island.matchAll(/from '\.\/(admin-[a-z]+)\.js'|import '\.\/(admin-[a-z]+)\.js'/g)]
    .map((m) => m[1] || m[2]);
  assert.ok(order.includes('admin-topochain'), 'admin-topochain.js is imported by the island');
  assert.ok(order.indexOf('admin-topochain') > order.indexOf('admin-console'),
    'admin-topochain.js is imported after the module it extends');
  assert.ok(!html.includes('/js/admin-topochain.js'),
    'the retired script tag is gone from the shell');
});

// ─── AdminTopochain: surface + sub-nav ─────────────────────────────────────

test('AdminTopochain is defined and mirrored onto window', () => {
  assert.match(topoJs, /const AdminTopochain = \{/, 'the global object literal is defined');
  assert.match(topoJs, /window\.AdminTopochain = AdminTopochain;/, 'mirrored onto window');
});

test('AdminTopochain defines the core surface the brief calls for', () => {
  for (const member of [
    'render(host)', 'setSub(sub)', 'esc(s)', 'safeHref(url)', 'canWrite()',
    'async fetchJson(url, opts)', 'async send(method, url, body)',
    '_subFromHash()', '_syncHash()', '_renderShell()', '_renderSub()',
  ]) {
    assert.ok(topoJs.includes(member), `AdminTopochain defines ${member}`);
  }
});

test('every built screen key is present in SUBS, no gap key is, and each is a real console section', () => {
  for (const key of BUILT_SUBS) {
    assert.match(topoJs, new RegExp(`key: '${key}'`), `SUBS carries the built '${key}' screen`);
    assert.match(consoleJs, new RegExp(`key: '${key}'`),
      `'${key}' is a first-class AdminConsole SECTIONS key (#1179)`);
  }
  for (const key of GAP_SUBS) {
    assert.ok(!new RegExp(`key: '${key}'`).test(topoJs),
      `'${key}' has no API — must not appear as a SUBS entry (documented gap, not dead UI)`);
  }
  // The programme Users screen is deliberately NOT a SUBS key: it is
  // merged into the console's Users section instead (#1179).
  const subsSrc = topoJs.slice(topoJs.indexOf('  SUBS: ['), topoJs.indexOf('  // ── Shared helpers'));
  assert.ok(!/key: 'users'/.test(subsSrc), "SUBS carries no 'users' screen — it merged into the console's Users section");
});

test('every built screen has a render function reachable from _renderSub', () => {
  const fn = topoJs.slice(topoJs.indexOf('  _renderSub() {'), topoJs.indexOf('  // ══'.repeat(1), topoJs.indexOf('  _renderSub() {')));
  const renderFns = ['renderSeasonEvents'];
  for (const name of renderFns) {
    assert.ok(fn.includes(name), `_renderSub dispatches to ${name}`);
    assert.match(topoJs, new RegExp(`\\b${name}\\(host\\) \\{|async ${name}\\(host\\) \\{`),
      `${name}(host) is defined`);
  }
  // A converted screen is reached through the React registry instead of a
  // `case`, and its renderer is gone from this file entirely. Both halves
  // matter: a leftover `case` would keep dispatching the deleted renderer.
  assert.match(fn, /const react = TOPO_REACT_SCREENS\[AdminTopochain\._sub\];/,
    '_renderSub tries the React registry before its own switch');
  const screens = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/screens.tsx'), 'utf8');
  const code = topoJs.replace(/^\s*\/\/.*$/gm, '');
  for (const [key, component] of [
    ['api-tester', 'ApiTesterScreen'],
    ['sql-console', 'SqlConsoleScreen'],
    ['settings', 'SettingsScreen'],
    ['app-version', 'AppVersionScreen'],
    ['waitlist', 'WaitlistScreen'],
    ['onchain-accounts', 'OnchainAccountsScreen'],
    ['user-activities', 'UserActivitiesScreen'],
    ['delegations', 'DelegationsScreen'],
    ['challenge-templates', 'ChallengeTemplatesScreen'],
    ['seasons', 'SeasonsScreen'],
  ]) {
    assert.ok(!new RegExp(`case '${key}':`).test(fn), `${key} left the switch`);
    const renderer = `render${component.replace('Screen', '')}`;
    assert.ok(!new RegExp(renderer).test(code), `and ${renderer} is gone from this module`);
    // A key with a hyphen has to be quoted; one without normally is not.
    const prop = /^[a-z][a-z0-9]*$/.test(key) ? key : `'${key}'`;
    assert.ok(
      screens.includes(`${prop}: { mount(host) { mountLegacyPortal(host, <${component} />); } },`),
      `the registry mounts ${key} through the portal seam`,
    );
  }
  // renderUsers is rendered by the console's Users section, not _renderSub.
  assert.ok(!fn.includes('renderUsers('), '_renderSub no longer dispatches renderUsers');
  assert.match(topoJs, /\brenderUsers\(host\) \{/, 'renderUsers(host) is still defined for the merged section');
});

test('the three documented API gaps are explained in the file header, not silently dropped', () => {
  const header = topoJs.slice(0, topoJs.indexOf("'use strict';"));
  for (const phrase of [
    'no admin (or public) endpoint lists',
    'no admin CRUD/read routes',
    'no admin endpoint lists per-user log payloads',
  ]) {
    assert.ok(header.includes(phrase), `header documents the gap: "${phrase}"`);
  }
  // Seasons used to be a fourth gap. The resource exists now, so the
  // header must not still be telling admins it doesn't — a stale
  // "there is no API for this" is worse than no note at all.
  assert.ok(!header.includes('no /api/v4/admin/seasons resource'),
    'the seasons gap is retired, not left in the header');
});

// The Seasons screen is React since #1120 slice 33.
const seasonsTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/admin/topochain/seasons.tsx'), 'utf8');

test('the seasons subsection is full CRUD against the real /admin/seasons resource', () => {
  assert.ok(!/no dedicated Seasons API/i.test(seasonsTsx),
    'the "there is no API" banner is gone — there is one');
  assert.match(seasonsTsx, /\/api\/v4\/admin\/seasons/,
    'the screen talks to the seasons resource directly');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.ok(seasonsTsx.includes(`'${method}'`), `the screen can ${method}`);
  }
  // Same rule as every other CRUD screen: the control is not rendered for a
  // view-only admin AND the handler refuses anyway. The render half is
  // stronger here than the string version could state — a `write ? … : null`
  // means the button does not exist, not that its markup was skipped.
  for (const handler of ['const save = useCallback', 'const remove = useCallback']) {
    const body = seasonsTsx.slice(seasonsTsx.indexOf(handler));
    assert.match(body.slice(0, 300), /if \(!canWrite\(\)\) return;/,
      `${handler} refuses a view-only admin even if the control were reachable`);
  }
  assert.match(seasonsTsx, /\{write \? \(\n\s*<button\n\s*id="admin-topo-sn-new"/,
    'and New season is not rendered for one');
});

test('the seasons list delete surfaces the 409 season_in_use message rather than a generic failure', () => {
  const fn = seasonsTsx.slice(seasonsTsx.indexOf('const remove = useCallback'),
    seasonsTsx.indexOf('const columns:'));
  assert.ok(fn.length > 300, 'the delete handler has a body');
  assert.match(fn, /res\.data && res\.data\.error/,
    "the API's own message (which names what still references the season) is what the admin sees");
  assert.ok(!/Delete failed\.'\);\n\s*\}\);$/.test(fn.trim()),
    'the generic string is only the fallback, never the whole branch');
});

test('the season events screen links to seasons by name and can filter by one', () => {
  const screen = topoJs.slice(topoJs.indexOf('  renderSeasonEvents(host) {'), topoJs.indexOf('  async _openSeasonEventForm(id) {'));
  assert.match(screen, /admin-topo-se-season-filter/, 'a season filter control exists');
  assert.match(screen, /params\.set\('season_id', s\.seasonFilter\)/,
    'the filter is sent to the API, not applied client-side over one page of results');
  assert.match(screen, /ev\.season\?\.name/, 'the Season column shows the name, not the raw id');
  assert.match(screen, /— No season —/, 'the unassigned bucket is selectable');

  const form = topoJs.slice(topoJs.indexOf('  async _openSeasonEventForm(id) {'), topoJs.indexOf('  async _saveSeasonEvent() {'));
  assert.match(form, /sel\('admin-topo-se-f-season_id'/,
    'the event form picks a season from a dropdown instead of asking for a numeric id');
});

// ─── Hash handling: canonical single-level + permanent legacy aliases ─────

test('AdminTopochain writes the canonical single-level address and heals legacy ones', () => {
  const subFromHash = topoJs.slice(topoJs.indexOf('  _subFromHash() {'), topoJs.indexOf('  _readSeasonEventsDeepLink(sub) {'));
  // Reads BOTH retired prefixes: a deep link minted before #1179
  // (#admin/seasons/sql-console) or before the rename before it
  // (#admin/topochain/sql-console) has to keep landing on its screen even
  // when it reaches this module without app.js's rewrite.
  assert.ok(subFromHash.includes('#admin\\/(?:seasons|topochain)\\/([^/]+)'),
    '_subFromHash parses the screen key off either legacy prefix');

  const syncHash = topoJs.slice(topoJs.indexOf('  _syncHash() {'), topoJs.indexOf('  _renderShell() {'));
  assert.match(syncHash, /#admin\/\$\{AdminTopochain\._sub\}/,
    'builds the CANONICAL single-level hash target (#admin/<screen>) — a legacy address self-heals on first render');
  assert.ok(syncHash.includes('/^#admin\\/(?:seasons|topochain)\\//'),
    'the legacy two-level prefixes are recognised as this module\'s own address, which is exactly when the rewrite is needed');
  assert.match(syncHash, /history\.replaceState/, 'replaceState — address healing never pollutes the back stack');
  assert.ok(!/history\.pushState/.test(topoJs), 'the module never pushes history entries itself');
});

test('app.js promotes a legacy two-level address to its section, tail and all', () => {
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const branch = appJs.slice(appJs.indexOf("parts[0] === 'admin'"),
    appJs.indexOf("parts[0] === 'admin'") + 2200);
  assert.match(branch, /_adminSection === 'topochain' \|\| _adminSection === 'seasons'/,
    'both legacy section keys are recognised');
  // Everything below the screen segment is owned by AdminTopochain — the
  // Season-events tail (season-events/<eventId>/new-challenge/<templateId>).
  // Dropping it would demote a deep bookmark to the screen's default view.
  assert.match(branch, /const rest = parts\.slice\(2\);/,
    'the whole tail below the legacy section segment is read');
  assert.match(branch, /if \(rest\[0\] === 'seasons'\) rest\.shift\(\);/,
    "the old sub-nav's own seasons tab collapses onto the Seasons section");
  assert.match(branch, /`#admin\/\$\{_adminSection\}\/\$\{tail\}`/,
    'the tail is spliced back under the promoted section segment');
  assert.match(branch, /history\.replaceState/, 'the address bar self-heals rather than keeping a dead path');
});

test('render() takes the screen from the active console section, with a legacy-hash fallback', () => {
  const fn = topoJs.slice(topoJs.indexOf('  render(host) {'), topoJs.indexOf('  destroy() {'));
  assert.match(fn, /AdminConsole\._section/,
    'the section key IS the screen key — the console already routed');
  assert.match(fn, /AdminTopochain\._subFromHash\(\) \|\| AdminTopochain\._sub \|\| 'seasons'/,
    'falls back through the legacy hash, then the last-visited screen, then seasons');
});

// ─── Security: esc()/safeHref() discipline ─────────────────────────────────

test('esc() mirrors the hardened topochain-challenges.js/topochain-leaderboard.js version, not the older admin-console.js one', () => {
  const fn = topoJs.slice(topoJs.indexOf('esc(s) {'), topoJs.indexOf('esc(s) {') + 300);
  assert.ok(fn.includes(".replace(/&/g, '&amp;')"), 'esc() escapes &');
  assert.ok(fn.includes(".replace(/</g, '&lt;')"), 'esc() escapes <');
  assert.ok(fn.includes(".replace(/>/g, '&gt;')"), 'esc() escapes >');
  assert.ok(fn.includes('.replace(/"/g, \'&quot;\')'), 'esc() escapes double quotes (attribute-value breakout)');
  assert.ok(fn.includes(".replace(/'/g, '&#39;')"), 'esc() escapes single quotes too');
});

test('safeHref validates an http(s)-only scheme', () => {
  const fn = topoJs.slice(topoJs.indexOf('safeHref(url) {'), topoJs.indexOf('canWrite() {'));
  assert.ok(fn.length > 0, 'safeHref is defined');
  assert.ok(fn.includes('/^https?:\\/\\//i.test(url)'), 'safeHref checks the URL scheme with an http(s)-only regex');
});

test('no admin/API-supplied URL is ever interpolated into a raw href attribute', () => {
  // This module deliberately never renders update_url/cta_link/mobile_cta_link
  // etc. as clickable anchors (they're shown as escaped text in form
  // fields instead) — so there should be no interpolated href="${...}" at
  // all. If a future change adds one, it must go through safeHref() like
  // topochain-challenges.js's _ctaHtml does.
  const hrefSites = (topoJs.match(/href="\$\{/g) || []).length;
  assert.equal(hrefSites, 0, 'no interpolated href exists in admin-topochain.js');
});

// The helper functions that build every <input>/<textarea>/<option> in
// this file all funnel through esc() internally — spot-check the three
// helpers rather than every call site (there are dozens).
test('the shared _inputHtml/_textareaHtml/_selectHtml builders escape their values', () => {
  const inputFn = topoJs.slice(topoJs.indexOf('  _inputHtml(id, opts = {}) {'), topoJs.indexOf('  _textareaHtml('));
  assert.match(inputFn, /esc\(val\)/, '_inputHtml escapes the value attribute');
  const textareaFn = topoJs.slice(topoJs.indexOf('  _textareaHtml(id, value, rows) {'), topoJs.indexOf('  _selectHtml('));
  assert.match(textareaFn, /esc\(value\)/, '_textareaHtml escapes its content');
  const selectFn = topoJs.slice(topoJs.indexOf('  _selectHtml(id, options, selected, opts = {}) {'), topoJs.indexOf('  _isoToLocalInput('));
  assert.match(selectFn, /esc\(val\)/, '_selectHtml escapes option values');
  assert.match(selectFn, /esc\(label\)/, '_selectHtml escapes option labels');
});

// Spot-check a sampling of fields rendered directly (not through the
// shared input builders) actually pass through esc(...).
test('table-rendered API fields pass through esc()', () => {
  for (const field of ['ev.name', 'u.email']) {
    const re = new RegExp(`esc\\(${field.replace('.', '\\.')}`);
    assert.ok(re.test(topoJs), `${field} passes through esc() somewhere in admin-topochain.js`);
  }
  // `s.key` and `c.os` were the other two, on the Settings and App version
  // screens. Both are React since #1120 slices 26/27, where a cell is a text
  // child and React does the escaping. The stronger statement for a converted
  // screen is that it never opts back out — and it covers every value the
  // screen renders, not the one field a spot-check happened to name.
  for (const [file, cell] of [
    ['settings.tsx', /cell: \(s\) => s\.key/],
    ['app-version.tsx', /cell: \(c\) => c\.os/],
    ['onchain-accounts.tsx', /\{a\.public_key\}/],
    ['challenge-templates.tsx', /cell: \(t\) => t\.category/],
  ]) {
    const src = fs.readFileSync(
      path.join(root, 'frontend/src/features/admin/topochain', file), 'utf8');
    assert.match(src, cell, `${file} still renders that cell`);
    assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(stripAllComments(src)),
      `${file} renders no raw HTML`);
  }
});

// ─── canWrite() gates every mutating control ───────────────────────────────

test('every AdminTopochain.send(...) mutating call sits inside a canWrite()-guarded function', () => {
  const lines = topoJs.split('\n');
  const fnHeaderRe = /^\s{2}(async )?_?\w+\([^)]*\)\s*\{\s*$/;
  const sendCallLineIdxs = [];
  lines.forEach((line, i) => { if (line.includes('AdminTopochain.send(')) sendCallLineIdxs.push(i); });
  assert.ok(sendCallLineIdxs.length >= 8,
    `expected many send() call sites, found ${sendCallLineIdxs.length}`);

  for (const callIdx of sendCallLineIdxs) {
    // Walk upward to the nearest enclosing top-level (2-space indented)
    // function header, then confirm a canWrite() guard appears somewhere
    // between that header and the call (covers both a same-function guard
    // and a guard on an enclosing arrow-function callback, e.g. the
    // refresh-totals button handler).
    let fnStart = -1;
    for (let i = callIdx; i >= 0; i--) {
      if (fnHeaderRe.test(lines[i])) { fnStart = i; break; }
    }
    assert.ok(fnStart >= 0, `send() call at line ${callIdx + 1} has an enclosing function`);
    const scope = lines.slice(fnStart, callIdx + 1).join('\n');
    assert.match(scope, /canWrite\(\)\) return;/,
      `send() call at line ${callIdx + 1} is guarded by an early canWrite() return in its scope:\n${scope.slice(0, 200)}`);
  }

  // The same rule on the converted screens, where `send` is an imported
  // function rather than a method. Every call site must sit under a
  // `if (!canWrite()) return;` in its own handler — the count only falls in
  // admin-topochain.js because the screens moved, not because the rule did.
  const reactDir = path.join(root, 'frontend/src/features/admin/topochain');
  let reactSends = 0;
  for (const file of fs.readdirSync(reactDir).filter((f) => f.endsWith('.tsx'))) {
    const src = fs.readFileSync(path.join(reactDir, file), 'utf8');
    const srcLines = src.split('\n');
    srcLines.forEach((line, i) => {
      if (!/\bawait send\(/.test(line)) return;
      reactSends += 1;
      // Walk up to the nearest handler head (a useCallback or a plain
      // async arrow assigned to a const) and require the guard between.
      let start = -1;
      for (let j = i; j >= 0; j -= 1) {
        if (/^\s*const \w+ = (useCallback\(async|async)/.test(srcLines[j])) { start = j; break; }
      }
      assert.ok(start >= 0, `${file}:${i + 1} send() has an enclosing handler`);
      const scope = srcLines.slice(start, i + 1).join('\n');
      assert.match(scope, /if \(!canWrite\(\)\) return;/,
        `${file}:${i + 1} send() is guarded by an early canWrite() return:\n${scope.slice(0, 200)}`);
    });
  }
  assert.ok(reactSends >= 8,
    `expected the converted screens to carry their share of the writes, found ${reactSends}`);
});

test('the one non-mutating POST (sql-query/execute) is explicitly NOT canWrite-gated, with a comment saying why', () => {
  // The screen is React since #1120 slice 25; the explanation moved with it.
  const sqlTsx = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/sql-console.tsx'), 'utf8');
  const fn = sqlTsx.slice(sqlTsx.indexOf('  const run = useCallback'),
    sqlTsx.indexOf('  const draft = useCallback'));
  assert.ok(fn.length > 400, 'the run handler has a body');
  assert.match(fn, /read-only by construction server-side/i,
    'the handler explains that sql-query/execute is a read-only endpoint despite using POST');
  assert.ok(!/canWrite/.test(stripComments(fn)),
    'and does not gate on write access — the comment saying so is not the gate');
  // The header carries the full reasoning, since the handler comment is one
  // line: this is the ONE mutating-looking control in the console that is not
  // a write, and a future reader must not "fix" it by adding a gate.
  assert.match(sqlTsx, /BEGIN TRANSACTION READ ONLY/,
    'the header names the server-side mechanism that makes it read-only');
});

test('rendered mutating buttons (Edit/Delete/Reset/New/Import/Move/Toggle) are wrapped in a canWrite() ternary', () => {
  const guardedButtonCount = (topoJs.match(/canWrite\s*(&&[^?]*)?\?\s*`<button/g) || []).length;
  assert.ok(guardedButtonCount >= 15,
    `expected at least 15 canWrite()-gated buttons in rendered markup, found ${guardedButtonCount}`);
});

// ─── Vocabulary (SPEC §5.4's rename table) ─────────────────────────────────

test("no user-facing 'Phase' or 'Participant' label — Event/User/Challenge template/Kind only", () => {
  // Strip // comments first: the file's own header comment legitimately
  // NAMES the banned words (to document the rule). Word-boundary matching
  // keeps snake_case API field-name references out of scope (an
  // underscore is a word character, so `_phase_` never hits `\bphase\b`
  // — there is no legitimate "phase" reference of any kind left in this
  // file, unlike "participants").
  const code = topoJs.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bphase\b/i.test(code), 'no whole-word "phase" outside comments');

  // "participant" is trickier: the users import-csv API's own required
  // JSON body field is literally named `participants` (users.js's
  // contract), so the bare identifier/object-key reference to that wire
  // field is legitimate and must stay. What must NEVER appear is the word
  // as DISPLAYED text — a label, button, or message the admin reads.
  // Assert the specific fixes directly rather than a blanket word-boundary
  // ban that would misfire on the required field name.
  for (const banned of [
    'Participants', 'a topochain\n          participant', 'least one participant',
    "'Phase", 'Phase "', 'Activity type', 'Sub-category',
  ]) {
    assert.ok(!code.includes(banned), `admin-topochain.js must not display "${banned}"`);
  }
  // Confirm the identifier itself is still there (sanity check that this
  // test isn't just vacuously passing because the feature was deleted).
  assert.match(code, /const participants = /, 'the import payload still builds its `participants` field');
});

// The screen is React since #1120 slice 31.
const dlgTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/admin/topochain/delegations.tsx'), 'utf8');

test('Delegations screen: stat strip, season/event scoping, and a per-account history timeline', () => {
  // The summary strip renders account-level tallies from /delegations/stats
  // into its own host, above the table.
  assert.match(dlgTsx, /id="admin-topo-dlg-stats"/, 'the stat-strip host exists');
  assert.match(dlgTsx, /\/api\/v4\/admin\/delegations\/stats/, 'from the stats endpoint');
  // Loaded separately from the list, and — the property that matters — NOT
  // re-fetched when a list filter changes: it answers "how is delegation
  // doing overall", not "show me these accounts".
  const statsEffect = dlgTsx.slice(dlgTsx.indexOf("fetchJson('/api/v4/admin/delegations/stats')"));
  assert.match(statsEffect.slice(0, 400), /\}, \[\]\);/,
    'the stats effect has empty deps, so a filter change cannot re-run it');

  // Season/event filters, same picker idiom as the accounts screen.
  assert.match(dlgTsx, /admin-topo-dlg-season-filter/, 'season filter select');
  assert.match(dlgTsx, /admin-topo-dlg-event-filter/, 'event filter select');

  // History: a Periods column plus an expandable per-account timeline
  // fetched from /:account/history — the schema keeps every period now.
  assert.match(dlgTsx, /label: 'Periods'/, 'the period-count column');
  assert.match(dlgTsx, /data-dlg-history=\{d\.account\}/, 'the history toggle action');
  assert.match(dlgTsx, /\/history`/, 'fetching the account history endpoint');
  assert.ok(!dlgTsx.includes('re-delegating overwrites the previous one'),
    'the old single-row caveat is gone from the copy — it is no longer true');
  // One expanded account at a time: `expanded` is a single value, and the
  // toggle replaces it rather than adding to a set.
  assert.match(dlgTsx, /setExpanded\(\(c\) => \(c === d\.account \? null : d\.account\)\)/,
    'expanding one account collapses whichever was open');
});

// This screen is READ-ONLY by design: the mobile app is the delegation actor
// and reconciles its local state against the backend flag, so an admin write
// here would desync phones. The rule is easy to erode one convenience button
// at a time, so it is asserted as an absence.
test('Delegations screen carries no mutation control at all', () => {
  const code = stripAllComments(dlgTsx);
  assert.ok(!/\bsend\(/.test(code), 'no POST/PUT/PATCH/DELETE helper is even imported');
  assert.ok(!/canWrite/.test(code),
    'and no write gate, because there is nothing to gate');
});

// The cross-screen jump. "View account" opens the dialog the ONCHAIN ACCOUNTS
// screen owns — a second copy here would duplicate a static id — so it
// depends on a seam between two modules that convert on different days. It
// broke exactly that way once: the jump called AdminTopochain._openAccountDetail,
// which left the module when Onchain accounts became React in slice 29, and
// the button threw. Both ends are pinned here.
test('Delegations "View account" reaches the Onchain accounts dialog', () => {
  const oa = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/onchain-accounts.tsx'), 'utf8');
  assert.match(oa, /export function openAccountDetail\(id: number\) \{/,
    'Onchain accounts exports the opener');
  assert.match(dlgTsx, /^import \{ openAccountDetail \} from '\.\/onchain-accounts\.tsx';$/m,
    'and Delegations imports it — a bare global read is what broke last time');
  assert.match(dlgTsx, /console_\.setSection\('onchain-accounts'\);\n\s*openAccountDetail\(id\);/,
    'the section switch comes first, then the request for the dialog');
  // Both arrival orders: already-mounted takes it live, just-switched parks
  // it for the mount effect. Losing either is a silently dead button.
  assert.match(oa, /if \(live\) live\(id\);\n\s*else pending = id;/,
    'the opener handles a screen that is not mounted yet');
  assert.match(oa, /live = setDetailId;\n\s*if \(pending != null\) \{ setDetailId\(pending\); pending = null; \}/,
    'and the mount effect picks up whatever was parked');
});

test('Onchain accounts: delegation is visible and filterable, list and detail', () => {
  // The screen is React since #1120 slice 29.
  const oa = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/onchain-accounts.tsx'), 'utf8');
  assert.match(oa, /admin-topo-oa-delegated-filter/, 'the delegated filter select');
  assert.match(oa, /params\.set\('delegated'/, 'wired into the index query');
  assert.match(oa, /label: 'Delegation'/, 'the list column');
  assert.match(oa, /<DetailRow label="Delegation">/, 'and the detail dialog row');
});

// The show route is the ONE place the API serves `secret_key`, and only to a
// full admin. How the client HOLDS it is therefore load-bearing, and the rule
// predates the conversion: never in an attribute, never written as markup.
test('Onchain accounts: the secret key is state, never an attribute or markup', () => {
  const oa = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/onchain-accounts.tsx'), 'utf8');
  const fn = oa.slice(oa.indexOf('function SecretKey('), oa.indexOf('function AccountDetail('));
  assert.ok(fn.length > 200, 'the reveal control has a body');
  assert.match(fn, /const \[shown, setShown\] = useState\(false\)/,
    'it starts masked and the toggle is component state');
  assert.match(fn, /\{shown \? secret : MASK\}/,
    'the secret is a text child, rendered only while revealed');
  // The two ways it could leak: an attribute (data-*, title, value) or a raw
  // HTML write. Neither may appear anywhere in the screen.
  assert.ok(!/(data-[\w-]+|title|value)=\{[^}]*secret/.test(fn),
    'the secret never lands in an attribute');
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(stripAllComments(oa)),
    'and the screen renders no raw HTML at all');
  assert.match(fn, /Hidden for view-only admins\./,
    'a view-only admin is told why there is nothing to reveal');
});

test('the vocabulary is actually used: Event / User / Challenge template / Kind', () => {
  assert.match(topoJs, /label: 'Season events'/);
  assert.match(topoJs, /title: 'Programme users'/);
  assert.match(topoJs, /label: 'Challenge templates'/);
  assert.match(topoJs, /'Kind'/);
});

// ─── Users delete: strong confirm (can delete ANY platform user) ──────────

test('deleting a user requires typing the exact identifier before the button enables', () => {
  // Renamed from _userDeleteConfirmRow: the shared list renderer draws the
  // same item as a table row AND as a card, so the confirm markup has to be
  // layout-neutral (a <div>, not a <tr>) to work in both.
  const fn = topoJs.slice(topoJs.indexOf('  _userDeleteConfirmBlock(u, identifier) {'), topoJs.indexOf('  async _togglePodium('));
  assert.ok(fn.length > 0, 'the confirm block is defined');
  assert.ok(!/<tr\b/.test(fn), 'layout-neutral: no <tr>, so the same markup renders inside a card');
  assert.match(fn, /data-expect="\$\{esc\(identifier\)\}"/, 'the expected string is the row identifier, exactly');
  assert.match(fn, /disabled/, 'the confirm button starts disabled');
  assert.match(fn, /ANY platform user/i, 'the copy warns this is not scoped to this programme’s rows');
  const wireFn = topoJs.slice(topoJs.indexOf("data-typed-check"), topoJs.indexOf("data-typed-check") + 700);
  assert.match(wireFn, /inp\.value === inp\.dataset\.expect/, 'the button only enables on an exact match');
  // Both layouts render the hook, so a querySelector would only ever reach
  // one of the two copies and the visible button could stay disabled.
  assert.match(wireFn, /querySelectorAll/, 'every copy of the confirm control is wired, not just the first');
});

// ─── Challenges live inside the season-event detail view ──────────────────

test('challenges are managed nested under a season-event detail view, not a top-level tab', () => {
  assert.ok(!/key: 'challenges'/.test(topoJs), 'no standalone top-level "challenges" SUBS entry');
  assert.match(topoJs, /_renderSeasonEventDetail\(host\)/, 'season-events has a nested detail renderer');
  assert.match(topoJs, /season-events\/\$\{encodeURIComponent\(eventId\)\}\/challenges/,
    'the nested challenges list is fetched under the event');
  for (const action of ['toggle-enabled', 'toggle-completed', 'move', 'update-display-orders']) {
    assert.ok(topoJs.includes(action), `the nested challenge view wires ${action}`);
  }
});

// ─── No second-level nav: the console's own menu names every screen ───────

test('the horizontal sub-nav is gone — the shell hosts only the screen content (#1179)', () => {
  // The old SUB_GROUPS cluster strip (md+) and two-level mobile list are
  // retired: the console's main menu carries every screen directly, so a
  // second navigation layer inside the section would be dead weight.
  assert.ok(!topoJs.includes('SUB_GROUPS'), 'the SUB_GROUPS cluster definition is gone');
  assert.ok(!topoJs.includes('_desktopNavHtml'), 'no desktop cluster strip');
  assert.ok(!topoJs.includes('_mobileNavHtml'), 'no two-level mobile nav');
  assert.ok(!topoJs.includes('data-topo-sub'), 'no sub-tab buttons rendered at all');
  assert.ok(!topoJs.includes('admin-topo-nav-back'), 'no nav back control either');

  const shell = topoJs.slice(topoJs.indexOf('  _renderShell() {'), topoJs.indexOf('  _renderSub() {'));
  assert.match(shell, /admin-topo-content/,
    'the content host node survives (every screen renderer looks it up by id)');
  assert.ok(!/matchMedia/.test(stripComments(topoJs)), 'still no breakpoint state to sync');

  // Cross-screen jumps (a season's "View events") go through the console
  // so the sidebar's active row follows the navigation.
  assert.match(topoJs, /_gotoSub\(sub\) \{/, 'the cross-screen jump helper exists');
  assert.match(topoJs, /AdminConsole\.setSection\(sub\)/,
    'and it routes through AdminConsole.setSection');
  // The two call sites are the Seasons screen's "View events" and its
  // unassigned-events panel; both are React since slice 33 and reach the
  // helper through the published global, which is the same jump.
  assert.match(seasonsTsx, /t\._gotoSub\('season-events'\);/,
    "the seasons screen's event links use it");
  assert.ok((seasonsTsx.match(/gotoSeasonEvents\(/g) || []).length >= 3,
    'both links plus its definition');
  // And they hand over an EXACT filter rather than a free-text search:
  // season_id is a filter the API applies itself.
  assert.match(seasonsTsx, /t\._se\.seasonFilter = seasonFilter;/);
  assert.match(seasonsTsx, /gotoSeasonEvents\('none'\)/,
    'the unassigned panel uses the API\'s own "no season" bucket');
});

// ─── No window.prompt(): both flows are inline panels now ─────────────────

test('neither the challenge move nor the CSV export uses window.prompt()', () => {
  // prompt() is unstyled, untranslatable, unvalidatable and outright
  // blocked in some embedded webviews — and both flows here needed a
  // CHOICE from a known list, which a free-text box cannot express.
  // Comments stripped: both call sites document what they replaced, and
  // that prose is the record of the decision, not a leftover call.
  assert.ok(!/window\.prompt\(/.test(stripComments(topoJs)), 'no window.prompt( anywhere in the module');
  assert.ok(!/[^.\w]prompt\(/.test(stripComments(topoJs)), 'not via a bare prompt( either');

  // Both replacements are event pickers rendered inline, so the admin sees
  // the events that actually exist instead of guessing an id.
  assert.match(topoJs, /id="admin-topo-ch-move-target"/, 'the move flow offers a target <select>');
  assert.match(topoJs, /_submitChallengeMove\(eventId, challengeId, targetId\)/,
    'the move PATCH is a named handler taking the picked id');
  assert.match(topoJs, /id="admin-topo-u-exp-event"/, 'the export flow offers an event <select>');
  assert.match(topoJs, /if \(!Number\.isInteger\(id\) \|\| id <= 0\) return;/,
    'the picked export id is validated before it reaches the URL');
  assert.match(topoJs, /export-csv\/\$\{encodeURIComponent\(id\)\}/,
    '...and encoded on the way in');
});

// ─── Shared loading / empty / error treatment across every screen ─────────

test('the shared list, skeleton, empty and error helpers exist and are used everywhere', () => {
  for (const helper of ['_list(opts) {', '_skeleton(rows) {', '_empty({', '_error({', '_wireRetry(']) {
    assert.ok(topoJs.includes(helper), `the shared ${helper.split('(')[0]} helper is defined`);
  }
  // One column definition renders both layouts, so a screen can't drift
  // between its table and its cards.
  assert.match(topoJs, /hidden md:block/, '_list renders a table at md+');
  assert.match(topoJs, /md:hidden space-y-2/, '...and a card stack below it');

  // Every screen that loads asynchronously shows the skeleton rather than
  // the bare word "Loading…", which read as a stuck screen. The ONE
  // surviving occurrence is the skeleton's own sr-only status line — the
  // pulsing bars say nothing to a screen reader on their own.
  assert.equal((topoJs.match(/>Loading&hellip;</g) || []).length, 1,
    'the only Loading… left is the skeleton\'s sr-only status');
  const skeleton = topoJs.slice(topoJs.indexOf('  _skeleton(rows) {'),
    topoJs.indexOf('  _skeleton(rows) {') + 700);
  assert.match(skeleton, /sr-only" role="status">Loading&hellip;/,
    '...and it lives inside _skeleton, announced as a status');
  assert.match(skeleton, /animate-pulse/, 'sighted users get the pulsing placeholder bars');
  // The three counts below span BOTH renderers, and have to: this file's
  // screens are converting one at a time (#1120), so counting only the
  // innerHTML module would report a falling number as the property it
  // measures stayed exactly as true. A converted screen uses the components
  // in topochain/ui.tsx, which render the same markup from the same tokens.
  const reactScreens = fs.readdirSync(path.join(root, 'frontend/src/features/admin/topochain'))
    .filter((f) => f.endsWith('.tsx') && !['ui.tsx', 'screens.tsx'].includes(f))
    .map((f) => fs.readFileSync(path.join(root, 'frontend/src/features/admin/topochain', f), 'utf8'));
  assert.ok(reactScreens.length >= 5, 'the converted screens are being read');
  const across = (re) => (topoJs.match(re[0]) || []).length
    + reactScreens.reduce((n, src) => n + (src.match(re[1]) || []).length, 0);

  assert.ok(across([/_skeleton\(\d\)/g, /<Skeleton\b/g]) >= 10,
    'every async screen renders a skeleton while it fetches');

  // A failed fetch must be distinguishable from an empty result, and
  // recoverable without a full page reload.
  assert.ok(across([/_error\(\{/g, /<ErrorState\b/g]) >= 7,
    'every loader has an error branch');
  // The retry wiring is a PROP on the React side — the string helper needed
  // a separate _wireRetry pass only because its button did not exist until
  // the markup had been written.
  assert.ok(across([/_wireRetry\(/g, /onRetry=\{/g]) >= 7,
    'every error block offers its own retry');
  const errorText = "Couldn't reach the server.";
  assert.ok(topoJs.includes(errorText) || reactScreens.some((src) => src.includes(errorText))
    || fs.readFileSync(path.join(root, 'frontend/src/features/admin/topochain/ui.tsx'), 'utf8')
      .includes(errorText),
    'status 0 is reported as a connectivity problem, not as a server error');
});

// ─── Second pass: the same modern chrome on EVERY sub-tab, not just lists ─
//
// The first pass modernised the list screens only, so the forms, detail
// panels and the four tool screens (Settings, App version, SQL console,
// API tester) were still on the old flat markup. These tests pin the
// shared chrome — panel, screen header, form grid, form actions, error
// slot — and the tap-target/wrapping rules, so a new screen can't be
// added on the old idiom without failing here.

test('the shared panel/header/form helpers exist', () => {
  for (const helper of [
    '_panel(opts) {', '_screenHeader(opts) {', '_formGrid(innerHtml, cols) {',
    '_formActions(saveId, cancelId, saveLabel) {', '_formErrorSlot(id) {',
    '_checkField(id, label, checked, help) {',
  ]) {
    assert.ok(topoJs.includes(helper), `the shared ${helper.split('(')[0]} helper is defined`);
  }
});

test('a panel header sticks to the top and carries a visible dismiss control', () => {
  const panel = topoJs.slice(topoJs.indexOf('  _panel(opts) {'),
    topoJs.indexOf('  _panel(opts) {') + 2000);
  assert.match(panel, /sticky top-0/,
    'a long form scrolls under its own title rather than losing it');
  assert.match(panel, /aria-label="\$\{esc\(closeLabel\)\}"/,
    'the ✕ is labelled for a screen reader, not a bare glyph');
  assert.match(panel, /<svg[^>]*aria-hidden="true"/,
    '...and its icon is hidden from the accessibility tree');
  assert.match(panel, /flex flex-wrap items-center gap-2 border-t/,
    'the footer action bar wraps instead of overflowing on a phone');
});

test('every open-a-form entry point renders through _panel with a wired close control', () => {
  const FORMS = [
    '_openSeasonEventForm', '_openChallengeForm', '_openUserForm',
    '_openUserImportForm', '_openUserExport', '_moveChallenge',
  ];
  for (const fn of FORMS) {
    const start = topoJs.indexOf(`  async ${fn}(`);
    assert.ok(start > 0, `${fn} is defined`);
    const body = topoJs.slice(start, start + topoJs.slice(start).indexOf('\n  },'));
    assert.match(body, /_panel\(\{/, `${fn} renders inside a _panel`);
    const closeIds = [...body.matchAll(/closeId: '([^']+)'/g)].map((m) => m[1]);
    assert.ok(closeIds.length >= 1, `${fn} gives its panel a close control`);
    for (const id of new Set(closeIds)) {
      assert.ok(body.includes(`document.getElementById('${id}').addEventListener('click'`),
        `${fn} wires its '${id}' close control (a ✕ that does nothing is worse than none)`);
    }
  }
  // _openSettingForm and _openAppVersionForm were two of the thirteen until
  // #1120 slices 26/27 made those screens React. The same property holds and
  // is no longer splittable: the ✕ IS its handler, so a panel with a close
  // control that does nothing is not expressible.
  for (const [file, label] of [
    ['settings.tsx', 'Close the setting form'],
    ['app-version.tsx', 'Close the app version form'],
    ['onchain-accounts.tsx', 'Close the import panel'],
    ['user-activities.tsx', 'Close the activity form'],
    ['user-activities.tsx', 'Close the import panel'],
    ['user-activities.tsx', 'Close the totals panel'],
    ['challenge-templates.tsx', 'Close the template form'],
  ]) {
    const src = fs.readFileSync(
      path.join(root, 'frontend/src/features/admin/topochain', file), 'utf8');
    assert.match(src, /<Panel\n/, `${file} renders its form inside a Panel`);
    assert.ok(src.includes(`onClose={onClose}`), `${file} wires the panel's close control`);
    assert.ok(src.includes(`closeLabel="${label}"`),
      `${file}'s ✕ is labelled for a screen reader`);
  }
});

test('no two static admin-topo-* element ids collide', () => {
  // The move panel and the CSV export panel each used to render two
  // different bodies under ONE id, so which control you got depended on
  // which branch ran. Every literal id in the file must be unique.
  const ids = [...topoJs.matchAll(/id="(admin-topo-[a-z0-9-]+)"/g)].map((m) => m[1]);
  const seen = new Map();
  for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, [], 'duplicate static ids');
});

test('every screen opens with the shared _screenHeader, toolbar and all', () => {
  const SCREENS = [
    'renderSeasonEvents', 'renderUsers',
  ];
  for (const fn of SCREENS) {
    const start = topoJs.search(new RegExp(`\\n  (?:async )?${fn}\\(host\\) \\{`));
    assert.ok(start > 0, `${fn} is defined`);
    const body = topoJs.slice(start, start + topoJs.slice(start).indexOf('\n  },'));
    assert.match(body, /_screenHeader\(\{/, `${fn} uses the shared screen header`);
  }
  // A converted screen uses the <ScreenHeader> component, which renders the
  // same strip from the same classes. Waitlist is the interesting case: it
  // opens TWO, one per queue.
  const waitlist = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/waitlist.tsx'), 'utf8');
  assert.ok((waitlist.match(/<ScreenHeader\n/g) || []).length >= 1,
    'the waitlist screen opens with the shared header');
  const topoUi = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/ui.tsx'), 'utf8');
  const reactHeader = topoUi.slice(topoUi.indexOf('export function ScreenHeader('),
    topoUi.indexOf('export function Panel('));
  assert.match(reactHeader, /flex flex-col gap-3 sm:flex-row/,
    'the component stacks title and toolbar the same way the string helper does');
  assert.match(reactHeader, /flex flex-wrap items-center gap-2/,
    'and wraps its toolbar the same way');

  const header = topoJs.slice(topoJs.indexOf('  _screenHeader(opts) {'),
    topoJs.indexOf('  _screenHeader(opts) {') + 900);
  assert.match(header, /flex flex-col gap-3 sm:flex-row/,
    'title and toolbar stack on a phone and sit side by side from sm: up');
  assert.match(header, /flex flex-wrap items-center gap-2/,
    'a three-button toolbar wraps rather than overflowing');
});

test('form fields stack on a phone and go multi-column from md: up', () => {
  const grid = topoJs.slice(topoJs.indexOf('  _formGrid(innerHtml, cols) {'),
    topoJs.indexOf('  _formGrid(innerHtml, cols) {') + 500);
  assert.match(grid, /grid-cols-1 md:grid-cols-2 lg:grid-cols-3/, 'cols: 3 opts into a third column');
  assert.match(grid, /grid-cols-1 md:grid-cols-2/, 'the default is one column then two');
  assert.ok((topoJs.match(/_formGrid\(/g) || []).length >= 8,
    'every multi-field form is laid out through it');
  // No screen may go back to the old sm:-breakpoint two-column form grid.
  assert.doesNotMatch(stripComments(topoJs), /grid grid-cols-1 sm:grid-cols-2 gap-3/,
    'the pre-second-pass form grid is gone');
});

test('buttons and fields are one consistent, tap-friendly set of tokens', () => {
  // The declarations moved to topochain/tokens.ts in #1120 slice 24 so the
  // React screens build from the same strings. There must be exactly ONE copy:
  // a second would show up as two different buttons in one sub-nav while the
  // conversion runs, which is the whole reason the move happened.
  assert.match(topoTokens, /export const BTN_BASE = /, 'one base class string for every button');
  assert.match(topoTokens, /export const FIELD_CLS = /, 'one class string for every text input and select');
  assert.match(topoTokens, /export const TEXTAREA_CLS = /, '...and one for every textarea');
  assert.match(topoTokens, /export const PANEL_CLS = /, '...and one panel/card surface');
  assert.match(topoJs, /from '\.\/topochain\/tokens\.ts'/, 'the innerHTML screens import them');
  assert.match(topoUiTsx, /from '\.\/tokens\.ts'/, '...and so does the React chrome');
  for (const name of ['BTN_BASE', 'FIELD_CLS', 'TEXTAREA_CLS', 'PANEL_CLS']) {
    assert.ok(!new RegExp(`^const ${name} = `, 'm').test(topoJs),
      `admin-topochain.js must not keep its own ${name}`);
  }
  assert.match(topoTokens, /touch-manipulation/, 'taps are not delayed by double-tap-zoom detection');
  assert.match(topoTokens, /focus-visible:ring-2/, 'keyboard focus stays visible');
  // 44px is the tap target on a phone; the denser 36px only applies once
  // there is a pointer-sized viewport.
  assert.ok((topoTokens.match(/min-h-\[44px\] sm:min-h-\[36px\]/g) || []).length >= 3,
    'controls are 44px tall on a phone');

  // The tokens must stay class-string CONSTANTS interpolated into markup,
  // not a helper that returns a whole <button>: Tailwind's extractor only
  // sees whole literals, and the canWrite() ternary test above counts the
  // literal `canWrite ? `<button` shape.
  assert.doesNotMatch(topoJs, /_btn\(/, 'no button-building function');
  const legacy = [
    'text-xs text-zinc-500 hover:text-violet-400',
    'text-xs text-red-500 hover:text-red-400',
    'rounded-lg bg-violet-600 hover:bg-violet-500 px-',
  ];
  for (const cls of legacy) {
    assert.ok(!topoJs.includes(cls), `the hand-rolled "${cls}" button styling is gone`);
  }
  // Row actions are chips inside a wrapping group in BOTH _list layouts.
  assert.match(topoJs, /flex flex-wrap items-center justify-end gap-1/, 'table action cell wraps');
  assert.match(topoJs, /mt-2 flex flex-wrap gap-1 border-t/, 'card action footer wraps');
});

test('every form reports failures through the shared inline error slot', () => {
  const slot = topoJs.slice(topoJs.indexOf('  _formErrorSlot(id) {'),
    topoJs.indexOf('  _formErrorSlot(id) {') + 500);
  assert.match(slot, /class="hidden /, 'rendered hidden, revealed by the save handler');
  assert.match(slot, /role="alert"/, 'a validation failure is announced, not just coloured red');
  // Spans both renderers: a converted screen renders <FormError message=…/>,
  // which is the same slot seen from the other side — it renders nothing when
  // there is nothing to say, instead of an empty paragraph toggled by class.
  const reactDir = path.join(root, 'frontend/src/features/admin/topochain');
  const reactSlots = fs.readdirSync(reactDir).filter((f) => f.endsWith('.tsx'))
    .reduce((n, f) => n + ((fs.readFileSync(path.join(reactDir, f), 'utf8')
      .match(/<FormError message=/g) || []).length), 0);
  assert.ok((topoJs.match(/_formErrorSlot\(/g) || []).length + reactSlots >= 8,
    'every form panel carries one');
  const uiTsx = fs.readFileSync(path.join(reactDir, 'ui.tsx'), 'utf8');
  const reactSlot = uiTsx.slice(uiTsx.indexOf('export function FormError('),
    uiTsx.indexOf('export function FormActions('));
  assert.match(reactSlot, /if \(!message\) return null;/,
    'the React slot is absent rather than hidden');
  assert.match(reactSlot, /role="alert"/,
    'and a validation failure is still announced, not just coloured red');
  // The save handlers toggle `hidden` on that element by id — the slot
  // must keep that contract rather than inventing a second mechanism.
  assert.ok((topoJs.match(/errEl\.classList\.remove\('hidden'\)/g) || []).length >= 5,
    'the existing show-the-error path still drives it');
});

test('the tool screens got the same treatment as the CRUD screens', () => {
  // The SQL console is React since #1120 slice 25; the four layout properties
  // are unchanged, expressed in the renderer it uses now.
  const sql = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/sql-console.tsx'), 'utf8');
  assert.match(sql, /grid-cols-1 gap-4 lg:grid-cols-\[260px_1fr\]/,
    'the SQL console is one column on a phone, sidebar + editor at lg:');
  assert.match(sql, /lg:order-2/,
    'the query editor comes first on a phone, and moves right at lg:');
  assert.ok((sql.match(/<Panel\b/g) || []).length >= 3,
    'query, templates and schema each sit in a panel');
  assert.ok((sql.match(/<Skeleton rows=\{3\} \/>/g) || []).length >= 2,
    'both reference lists show a skeleton while they load');

  // The API tester is React since #1120 slice 24. The same four properties
  // hold, expressed in the renderer it uses now — and the field styling one
  // is stronger: the screen may not hand-write FIELD_CLS at all, it goes
  // through the <Input>/<Select>/<Textarea> wrappers that own it, so the two
  // renderers cannot drift.
  assert.match(apiTesterTsx, /<Panel\n/, 'the request builder is a panel');
  assert.match(apiTesterTsx, /htmlFor="admin-topo-api-method"/, 'the method select is labelled');
  assert.match(apiTesterTsx, /htmlFor="admin-topo-api-path"/, '...and so is the path input');
  assert.ok(!/FIELD_CLS/.test(apiTesterTsx),
    'the screen never writes the field class itself');
  assert.match(topoUiTsx, /className=\{className \? `\$\{FIELD_CLS\} \$\{className\}` : FIELD_CLS\}/,
    'the shared controls do, from the same tokens the innerHTML screens import');
  // Both renderers must build from ONE copy of the tokens — two would show up
  // as two different buttons in one sub-nav while the conversion runs.
  assert.match(topoJs, /from '\.\/topochain\/tokens\.ts'/,
    'admin-topochain.js imports the shared tokens rather than declaring them');
  assert.ok(!/^const BTN = \{/m.test(topoJs), 'and does not keep a second copy');
});

test('the SQL result and API response areas use the shared empty/panel treatment', () => {
  const sqlTsx = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/sql-console.tsx'), 'utf8');
  assert.match(sqlTsx, /<EmptyState title="No rows"/,
    'a query that matched nothing gets the empty-state card');
  assert.match(sqlTsx, /role="status"/, 'running/failed states are announced');
  // The 503 branch is the one an operator hits when the console is switched
  // off server-side, and it must say the server's own reason rather than
  // "Query failed".
  assert.match(sqlTsx, /if \(status === 503\)/, 'the unavailable state is handled on its own');
  assert.match(sqlTsx, /'The SQL console is not available right now\.'/);
  assert.match(apiTesterTsx, /\$\{PANEL_CLS\} overflow-hidden/,
    'the response is framed like every other panel');
  assert.match(apiTesterTsx, /`HTTP \$\{result\.status\} \$\{result\.statusText\}`/,
    'the status line survives');
  // Stronger than the `esc(...)` it replaced: React escapes text children, so
  // the property to hold is that the screen never opts back out. A response
  // body is arbitrary server output rendered verbatim — this is the one screen
  // where that matters most.
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(stripComments(apiTesterTsx)),
    'the screen renders no raw HTML — the response body is a text child');
});
