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
  // The section moved out of the chassis in #1120 slice 22, and slice 35 made
  // the programme card a React component too — so the arrangement is no
  // longer a host plus a stale-response guard, it is a child component. Both
  // surfaces still coexist under one Users menu entry.
  const fn = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/admin/admin-users.tsx'), 'utf8');
  assert.match(fn, /id="admin-users-programme"/,
    'the section still renders the programme card, under its own id');
  assert.match(fn, /<ProgrammeUsers \/>/, 'as a child component');
  assert.match(fn, /^import \{ ProgrammeUsers \} from '\.\/topochain\/programme-users\.tsx';$/m,
    'imported rather than read off the AdminTopochain global');
  // The `_sub = 'users'` guard and the renderUsers() call are gone with the
  // innerHTML card: a component that unmounts needs no stale-response flag.
  assert.ok(!/topochain\._sub/.test(fn), 'no stale-response flag is armed any more');
  assert.ok(!/renderUsers/.test(fn), 'and nothing calls into the module to draw it');
  // The platform-accounts card is untouched — both surfaces coexist.
  assert.match(fn, /id="admin-user-list"/, 'the platform users list is still there');
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
  // esc(s) and safeHref(url) left with the markup in #1120 slice 35 — this
  // module builds none. What remains is a router plus the three helpers the
  // screens defer to.
  for (const member of [
    'render(host)', 'setSub(sub)', 'canWrite()',
    'async fetchJson(url, opts)', 'async send(method, url, body)',
    '_subFromHash()', '_syncHash()', '_renderShell()', '_renderSub()',
  ]) {
    assert.ok(topoJs.includes(member), `AdminTopochain defines ${member}`);
  }
  for (const gone of ['esc(s) {', 'safeHref(url) {', '_list(opts) {', '_panel(opts) {']) {
    assert.ok(!topoJs.includes(gone),
      `${gone} left with the screens — a second copy here would be the one that drifts`);
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
  // Every screen is a React one since #1120 slice 34, so _renderSub has no
  // `switch` left at all: the registry, then Seasons as the fallback.
  assert.ok(!/switch \(/.test(fn), 'the innerHTML dispatch switch is gone');
  assert.match(fn, /return AdminTopochain\._mountReactScreen\(c, TOPO_REACT_SCREENS\.seasons\);/,
    'an address this build does not know about lands on Seasons');
  // SUBS and the registry must agree, or a menu entry would silently open
  // Seasons instead of its own screen.
  const registry = fs.readFileSync(path.join(REACT_DIR, 'screens.tsx'), 'utf8');
  const subsBlock = topoJs.slice(topoJs.indexOf('  SUBS: ['), topoJs.indexOf('  // ── Shared helpers'));
  const subKeys = [...subsBlock.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(subKeys.length, 11, 'all eleven screens are still listed');
  for (const key of subKeys) {
    assert.ok(new RegExp(`(^|\\s)'?${key}'?: \\{ mount`, 'm').test(registry),
      `SUBS key '${key}' has a screen in the React registry`);
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
    ['season-events', 'SeasonEventsScreen'],
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
  // The programme users card is a child component of the console's Users
  // section since #1120 slice 35, not a host this module fills — so
  // renderUsers is gone from here entirely, not merely off the dispatch.
  assert.ok(!/renderUsers\(/.test(stripComments(topoJs)),
    'renderUsers left with the card it drew');
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

// Season events and its nested Challenges detail are React since #1120
// slice 34 — the eleventh and last of this module's screens.
const seTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/admin/topochain/season-events.tsx'), 'utf8');
const chTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/admin/topochain/challenges.tsx'), 'utf8');
// Every converted screen, for the rules that are about the WHOLE console
// rather than one screen. Read once; the list grows by itself.
const REACT_DIR = path.join(root, 'frontend/src/features/admin/topochain');
const REACT_SCREEN_FILES = fs.readdirSync(REACT_DIR)
  .filter((f) => f.endsWith('.tsx') && !['ui.tsx', 'screens.tsx'].includes(f));
const REACT_SCREENS = REACT_SCREEN_FILES
  .map((f) => fs.readFileSync(path.join(REACT_DIR, f), 'utf8'));
const allScreens = REACT_SCREENS.join('\n');

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
  assert.match(seTsx, /admin-topo-se-season-filter/, 'a season filter control exists');
  assert.match(seTsx, /params\.set\('season_id', seasonFilter\)/,
    'the filter is sent to the API, not applied client-side over one page of results');
  assert.match(seTsx, /ev\.season\?\.name/, 'the Season column shows the name, not the raw id');
  assert.match(seTsx, /— No season —/, 'the unassigned bucket is selectable');
  assert.match(seTsx, /<Select\n\s*id=\{fid\('season_id'\)\}/,
    'the event form picks a season from a dropdown instead of asking for a numeric id');
  // The Seasons screen writes the filter before jumping here; losing the
  // seed would open the unfiltered list and silently ignore the jump.
  assert.match(seTsx, /useState<string>\(\(\) => topo\(\)\?\._se\?\.seasonFilter \|\| ''\)/,
    'and the screen seeds it from the router state the Seasons screen wrote');
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

test('every value a screen renders is a text child, never spliced into markup', () => {
  // What esc() used to guarantee, stated as the property React gives for
  // free — and stated over EVERY screen rather than over the three builders
  // that happened to funnel values. The XSS this rule exists for was a value
  // interpolated into an attribute; there is no interpolation left to get
  // wrong.
  for (const [i, src] of REACT_SCREENS.entries()) {
    assert.ok(!/dangerouslySetInnerHTML/.test(stripAllComments(src)),
      `${REACT_SCREEN_FILES[i]} must not opt out of React's escaping`);
    assert.ok(!/\.innerHTML\s*=/.test(stripAllComments(src)),
      `${REACT_SCREEN_FILES[i]} must not write markup directly either`);
  }
  const ui = fs.readFileSync(path.join(REACT_DIR, 'ui.tsx'), 'utf8');
  assert.ok(!/dangerouslySetInnerHTML/.test(stripAllComments(ui)),
    'nor may the shared chrome they all render through');
});

test('no admin- or API-supplied URL is ever rendered as a clickable anchor', () => {
  // safeHref()'s rule, which esc() could not express: escaping stops
  // attribute breakout but not a `javascript:` scheme, which executes on
  // click with no markup injection at all. The screens' answer is stronger —
  // they render no anchor from server data whatsoever.
  //
  // The fields this is about: app-version-configs' update_url,
  // challenge-templates' cta_link / mobile_cta_link, and a waitlist signup's
  // made_url, which is the least trusted of the four (a public join form) and
  // has its own executed test against a hostile payload.
  for (const [i, src] of REACT_SCREENS.entries()) {
    for (const [, expr] of stripAllComments(src).matchAll(/href=\{([^}]*)\}/g)) {
      assert.fail(`${REACT_SCREEN_FILES[i]} renders a computed href (${expr.trim()}) — `
        + 'admin data must be shown as text, not as a link');
    }
  }
  const waitlist = fs.readFileSync(path.join(REACT_DIR, 'waitlist.tsx'), 'utf8');
  assert.match(waitlist, /<span className="select-all break-all">\{a\.made_url\}<\/span>/,
    'the submitted URL is selectable text so an admin can still copy it out');
  assert.ok(fs.existsSync(path.join(root, 'tests/topochain-waitlist-survey.test.js')),
    'and the executed test for it exists');
  // The Signals column reports what a signup DID and carries no score:
  // weighting those facts decides who gets in first, which is still an open
  // product decision. If a score ever appears it must be a deliberate change
  // to services/waitlist-signals.js, not something that leaks in through a
  // column that started computing its own total.
  assert.match(waitlist, /label: 'Signals'/,
    'the waitlist list surfaces the per-signup signals');
  assert.doesNotMatch(waitlist, /s\.score|signals\.score|\.total\b/,
    'the Signals column must not compute or render a score');
  // Comments stripped first: that module's comments explain at length WHY it
  // computes no score, so a naive search for the word matches the very
  // documentation of the rule.
  const signals = stripAllComments(
    fs.readFileSync(path.join(root, 'src/services/waitlist-signals.js'), 'utf8'),
  );
  assert.doesNotMatch(signals, /score|weight/i,
    'services/waitlist-signals.js reports facts only — no scoring, by design');
  // The one outbound navigation left is the CSV export, which builds a
  // same-origin path from a numeric id the client fetched itself.
  const programme = fs.readFileSync(path.join(REACT_DIR, 'programme-users.tsx'), 'utf8');
  assert.match(programme, /if \(!Number\.isInteger\(id\) \|\| id <= 0\) return;/,
    'the export id is validated before it reaches the URL');
  assert.match(programme, /window\.location\.href = `\/api\/v4\/admin\/users\/export-csv\/\$\{encodeURIComponent\(id\)\}`;/,
    'and the path is same-origin and server-generated');
});


// Spot-check a sampling of fields rendered directly (not through the
// shared input builders) actually pass through esc(...).
test('every screen renders its API fields as text children', () => {
  // Was a spot-check that eight named fields went through esc(). Every screen
  // is React now, so the property is stated once and covers every value each
  // one renders rather than the eight a sampling happened to name. The
  // renderers are checked for the two ways out of it above; this pins that
  // the fields the sampling named are still RENDERED, so the check cannot
  // pass by the column quietly disappearing.
  for (const [file, cell] of [
    ['season-events.tsx', /cell: \(ev\) => ev\.name/],
    ['programme-users.tsx', /cell: \(u\) => u\.email \|\| '—'/],
    ['onchain-accounts.tsx', /\{a\.public_key\}/],
    ['onchain-accounts.tsx', /cell: \(a\) => a\.tier/],
    ['challenge-templates.tsx', /cell: \(t\) => t\.category/],
    ['challenge-templates.tsx', /cell: \(t\) => t\.reward/],
    ['settings.tsx', /cell: \(s\) => s\.key/],
    ['app-version.tsx', /cell: \(c\) => c\.os/],
  ]) {
    const src = fs.readFileSync(path.join(REACT_DIR, file), 'utf8');
    assert.match(src, cell, `${file} still renders that cell`);
  }
});

// ─── canWrite() gates every mutating control ───────────────────────────────

test('every AdminTopochain.send(...) mutating call sits inside a canWrite()-guarded function', () => {
  const lines = topoJs.split('\n');
  const fnHeaderRe = /^\s{2}(async )?_?\w+\([^)]*\)\s*\{\s*$/;
  const sendCallLineIdxs = [];
  lines.forEach((line, i) => { if (line.includes('AdminTopochain.send(')) sendCallLineIdxs.push(i); });
  // admin-topochain.js has no screens left (#1120 slice 34), so its own
  // count is now zero and the whole weight of this rule sits on the React
  // half below. The loop stays because the module could grow one again.

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
      // `if (!canWrite()) return;` or a compound guard that OPENS with it —
      // what must not happen is the write check coming after some other
      // condition that could return first for a different reason.
      assert.match(scope, /if \(!canWrite\(\)(\s*\|\|[^)]*)?\) return;/,
        `${file}:${i + 1} send() is guarded by an early canWrite() return:\n${scope.slice(0, 200)}`);
    });
  }
  assert.ok(reactSends >= 20,
    `expected the converted screens to carry every write, found ${reactSends}`);
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
  // Both renderers. The React form is `{write ? <button…> : null}`, which is
  // a stronger statement than the string version's: the element does not
  // exist for a view-only admin rather than its markup being skipped.
  const stringGated = (topoJs.match(/canWrite\s*(&&[^?]*)?\?\s*`<button/g) || []).length;
  const reactGated = (allScreens.match(/\{write \? \(?\s*<(button|>)/g) || []).length
    + (allScreens.match(/actions=\{write \?/g) || []).length;
  assert.ok(stringGated + reactGated >= 15,
    `expected at least 15 canWrite()-gated buttons in rendered markup, found ${stringGated + reactGated}`);
  // And the gate is always the console's own, never a local re-derivation.
  // Every screen that HAS a write gate derives it from the console's own,
  // never from a local re-derivation of the user object. (Delegations and
  // the two tool screens have none: they perform no writes at all.)
  for (const [i, src] of REACT_SCREENS.entries()) {
    if (!/\bcanWrite\(\)/.test(stripAllComments(src))) continue;
    assert.match(src, /const canWrite = \(\) => !!topo\(\)\?\.canWrite\(\);/,
      `${REACT_SCREEN_FILES[i]} derives write access from AdminTopochain.canWrite(), `
      + 'which defers to AdminConsole');
  }
});

// ─── Vocabulary (SPEC §5.4's rename table) ─────────────────────────────────

test("no user-facing 'Phase' or 'Participant' label — Event/User/Challenge template/Kind only", () => {
  // Strip // comments first: the file's own header comment legitimately
  // NAMES the banned words (to document the rule). Word-boundary matching
  // keeps snake_case API field-name references out of scope (an
  // underscore is a word character, so `_phase_` never hits `\bphase\b`
  // — there is no legitimate "phase" reference of any kind left in this
  // file, unlike "participants").
  // Both the module and every screen: the rule is about what an admin READS,
  // and the copy moved with the screens.
  const code = stripComments(`${topoJs}\n${allScreens}`);
  assert.ok(!/\bphase\b/i.test(code.replace(/\w_phase_?\w*|_phase_count/g, '')),
    'no whole-word "phase" outside comments');

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
  // test isn't just vacuously passing because the feature was deleted). It
  // moved to the programme users card with the import panel that builds it.
  assert.match(allScreens, /const participants = /,
    'the import payload still builds its `participants` field');
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
  // SUBS labels stay in the module; the screen copy moved with the screens.
  assert.match(topoJs, /label: 'Season events'/);
  assert.match(topoJs, /label: 'Challenge templates'/);
  assert.match(allScreens, /title="Programme users"/);
  assert.match(allScreens, /'Kind'/);
});

// ─── Users delete: strong confirm (can delete ANY platform user) ──────────

test('deleting a user requires typing the exact identifier before the button enables', () => {
  // The confirm markup has to be layout-neutral (a <div>, not a <tr>): the
  // shared list draws the same item as a table row AND as a card, and this
  // rides along as the row's `extra` block in both.
  const src = fs.readFileSync(path.join(REACT_DIR, 'programme-users.tsx'), 'utf8');
  const fn = src.slice(src.indexOf('function DeleteConfirm('), src.indexOf('function UserForm('));
  assert.ok(fn.length > 400, 'the confirm block is defined');
  assert.ok(!/<tr\b/.test(fn), 'layout-neutral: no <tr>, so the same markup renders inside a card');
  assert.match(fn, /data-expect=\{expected\}/, 'the expected string is the row identifier, exactly');
  assert.match(fn, /disabled=\{typed !== expected\}/,
    'the confirm button is enabled by an exact match and by nothing else');
  assert.match(fn, /ANY platform user/i, 'the copy warns this is not scoped to this programme’s rows');
  // The old shape needed a querySelectorAll pass because both layouts render
  // the hook and a querySelector would only ever reach one — leaving the
  // VISIBLE button disabled. Each copy owns its own state now, so there is
  // nothing to keep in step.
  assert.match(src, /const \[typed, setTyped\] = useState\(''\)/,
    'the typed value is the block\'s own state, so both copies work');
  assert.ok(!/querySelectorAll/.test(src), 'and no cross-copy wiring pass is needed');
});

// ─── Challenges live inside the season-event detail view ──────────────────

test('challenges are managed nested under a season-event detail view, not a top-level tab', () => {
  assert.ok(!/key: 'challenges'/.test(topoJs), 'no standalone top-level "challenges" SUBS entry');
  // The detail view is a branch of the Season events screen, not a screen of
  // its own — the same either/or renderSeasonEvents opened with.
  assert.match(seTsx, /if \(detailId != null\) \{\n\s*return \(\n\s*<EventDetail/,
    'season-events renders its nested detail instead of the list');
  assert.match(chTsx, /season-events\/\$\{encodeURIComponent\(eventId\)\}\/challenges/,
    'the nested challenges list is fetched under the event');
  for (const action of ['toggle-enabled', 'toggle-completed', 'move', 'update-display-orders']) {
    assert.ok(chTsx.includes(action), `the nested challenge view wires ${action}`);
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
  // The ban covers the module AND every converted screen: a prompt() that
  // reappeared on one of them would be the same bug in a new file.
  for (const [name, src] of [['admin-topochain.js', topoJs], ...REACT_SCREEN_FILES.map(
    (f, i) => [f, REACT_SCREENS[i]])]) {
    assert.ok(!/window\.prompt\(/.test(stripAllComments(src)), `no window.prompt( in ${name}`);
    assert.ok(!/[^.\w]prompt\(/.test(stripAllComments(src)), `not via a bare prompt( in ${name} either`);
  }

  // Both replacements are event pickers rendered inline, so the admin sees
  // the events that actually exist instead of guessing an id.
  assert.match(chTsx, /id="admin-topo-ch-move-target"/, 'the move flow offers a target <select>');
  assert.match(chTsx, /target_season_event_id: targetId/,
    'the move PATCH is sent with the picked id');
  assert.match(chTsx, /if \(!Number\.isInteger\(targetId\)\) return;/,
    'and a non-numeric pick never reaches the request');
  const programme = fs.readFileSync(path.join(REACT_DIR, 'programme-users.tsx'), 'utf8');
  assert.match(programme, /id="admin-topo-u-exp-event"/, 'the export flow offers an event <select>');
  assert.match(programme, /if \(!Number\.isInteger\(id\) \|\| id <= 0\) return;/,
    'the picked export id is validated before it reaches the URL');
  assert.match(programme, /export-csv\/\$\{encodeURIComponent\(id\)\}/,
    '...and encoded on the way in');
});

// ─── Shared loading / empty / error treatment across every screen ─────────

test('the shared list, skeleton, empty and error helpers exist and are used everywhere', () => {
  // The whole family is components in topochain/ui.tsx since #1120 slice 35 —
  // admin-topochain.js builds no markup at all. Same guarantees, same class
  // strings, one definition each.
  const uiTsx = fs.readFileSync(path.join(REACT_DIR, 'ui.tsx'), 'utf8');
  for (const helper of [
    'export function List<T>(', 'export function Skeleton(', 'export function EmptyState(',
    'export function ErrorState(', 'export function Pager(',
  ]) {
    assert.ok(uiTsx.includes(helper), `the shared ${helper.split('(')[0].split(' ').pop()} is defined`);
  }
  // One column definition renders both layouts, so a screen can't drift
  // between its table and its cards.
  assert.match(uiTsx, /hidden md:block/, 'the list renders a table at md+');
  assert.match(uiTsx, /md:hidden space-y-2/, '...and a card stack below it');

  // Every screen that loads asynchronously shows the skeleton rather than the
  // bare word "Loading…", which read as a stuck screen. The ONE surviving
  // occurrence is the skeleton's own sr-only status line — the pulsing bars
  // say nothing to a screen reader on their own.
  assert.equal((`${uiTsx}\n${allScreens}`.match(/>Loading…</g) || []).length, 1,
    "the only Loading… left is the skeleton's sr-only status");
  const skeleton = uiTsx.slice(uiTsx.indexOf('export function Skeleton('),
    uiTsx.indexOf('export function EmptyState('));
  assert.match(skeleton, /className="sr-only" role="status">Loading…/,
    '...and it lives inside Skeleton, announced as a status');
  assert.match(skeleton, /animate-pulse/, 'sighted users get the pulsing placeholder bars');
  assert.ok((allScreens.match(/<Skeleton\b/g) || []).length >= 10,
    'every async screen renders a skeleton while it fetches');

  // A failed fetch must be distinguishable from an empty result, and
  // recoverable without a full page reload.
  assert.ok((allScreens.match(/<ErrorState\b/g) || []).length >= 7,
    'every loader has an error branch');
  // The retry is a PROP now — the string helper needed a separate _wireRetry
  // pass only because its button did not exist until the markup was written.
  assert.ok((allScreens.match(/onRetry=\{/g) || []).length >= 7,
    'every error block offers its own retry');
  assert.match(uiTsx, /Couldn't reach the server\./,
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
  const uiTsx = fs.readFileSync(path.join(REACT_DIR, 'ui.tsx'), 'utf8');
  for (const helper of [
    'export function Panel(', 'export function ScreenHeader(', 'export function FormGrid(',
    'export function FormActions(', 'export function FormError(', 'export function CheckField(',
  ]) {
    assert.ok(uiTsx.includes(helper), `the shared ${helper.split('(')[0].split(' ').pop()} is defined`);
  }
  // And nothing re-implements one: a screen that hand-rolled a panel would
  // drift from the other ten the first time the chrome changed.
  for (const [i, src] of REACT_SCREENS.entries()) {
    assert.ok(!/sticky top-0 z-10 flex items-start/.test(src),
      `${REACT_SCREEN_FILES[i]} renders its panels through <Panel>, not a copy of its header`);
  }
});

test('a panel header sticks to the top and carries a visible dismiss control', () => {
  const uiTsx = fs.readFileSync(path.join(REACT_DIR, 'ui.tsx'), 'utf8');
  const panel = uiTsx.slice(uiTsx.indexOf('export function Panel('),
    uiTsx.indexOf('export function Input('));
  assert.match(panel, /sticky top-0/,
    'a long form scrolls under its own title rather than losing it');
  assert.match(panel, /<CloseButton label=\{label\} onClick=\{onClose\} \/>/,
    'the dismiss control is the shared one');
  const close = uiTsx.slice(uiTsx.indexOf('export function CloseButton('),
    uiTsx.indexOf('export function Panel('));
  assert.match(close, /aria-label=\{label\}/,
    'the ✕ is labelled for a screen reader, not a bare glyph');
  assert.match(close, /<svg[^>]*aria-hidden="true"/,
    '...and its icon is hidden from the accessibility tree');
  assert.match(panel, /flex flex-wrap items-center gap-2 border-t/,
    'the footer action bar wraps instead of overflowing on a phone');
  // Every panel that can be dismissed labels its ✕ for what it closes — a
  // bare "Close" on eight different panels is no help in a screen reader.
  const labels = [...allScreens.matchAll(/closeLabel="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 8, `expected many labelled dismiss controls, saw ${labels.length}`);
  for (const label of labels) {
    assert.match(label, /^Close the .+/, `"${label}" names what it closes`);
  }
});

test('every open-a-form entry point renders through a Panel with a wired close control', () => {
  // Was an inventory of thirteen `_open*Form` methods in admin-topochain.js.
  // None are left — every form is a React component — and the property is no
  // longer splittable: the ✕ IS its handler, so a panel with a dismiss
  // control that does nothing is not expressible.
  assert.ok(!/_open\w*Form/.test(topoJs), 'no form opener is left in the module');
  const FORMS = [
    ['settings.tsx', 'Close the setting form'],
    ['app-version.tsx', 'Close the app version form'],
    ['onchain-accounts.tsx', 'Close the import panel'],
    ['user-activities.tsx', 'Close the activity form'],
    ['user-activities.tsx', 'Close the import panel'],
    ['user-activities.tsx', 'Close the totals panel'],
    ['challenge-templates.tsx', 'Close the template form'],
    ['season-events.tsx', 'Close the event form'],
    ['challenges.tsx', 'Close the challenge form'],
    ['challenges.tsx', 'Close the move panel'],
    ['programme-users.tsx', 'Close the user form'],
    ['programme-users.tsx', 'Close the import panel'],
    ['programme-users.tsx', 'Close the export panel'],
  ];
  assert.ok(FORMS.length >= 13, 'the inventory did not shrink in the move');
  for (const [file, label] of FORMS) {
    const src = fs.readFileSync(path.join(REACT_DIR, file), 'utf8');
    assert.match(src, /<Panel\n/, `${file} renders its form inside a Panel`);
    assert.ok(src.includes('onClose={onClose}'), `${file} wires the panel's close control`);
    assert.ok(src.includes(`closeLabel="${label}"`), `${file} carries the "${label}" dismiss`);
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

test('every screen opens with the shared screen header, toolbar and all', () => {
  // All eleven screens plus the programme users card, none of them in the
  // module any more. Each opens with <ScreenHeader>; the waitlist opens two,
  // one per queue.
  const withHeader = REACT_SCREEN_FILES.filter(
    (f, i) => /<ScreenHeader\n/.test(REACT_SCREENS[i]));
  assert.ok(withHeader.length >= 10,
    `expected every screen to open with the shared header, saw ${withHeader.length}`);
  const uiTsx = fs.readFileSync(path.join(REACT_DIR, 'ui.tsx'), 'utf8');
  const header = uiTsx.slice(uiTsx.indexOf('export function ScreenHeader('),
    uiTsx.indexOf('export function CloseButton('));
  assert.match(header, /flex flex-col gap-3 sm:flex-row/,
    'title and toolbar stack on a phone and sit side by side from sm: up');
  assert.match(header, /flex flex-wrap items-center gap-2/,
    'a three-button toolbar wraps rather than overflowing');
});

test('form fields stack on a phone and go multi-column from md: up', () => {
  // The grid is a component since #1120; the two class strings are the same.
  const uiSrc = fs.readFileSync(path.join(REACT_DIR, 'ui.tsx'), 'utf8');
  const grid = uiSrc.slice(uiSrc.indexOf('export function FormGrid('),
    uiSrc.indexOf('export function FormError('));
  assert.match(grid, /grid-cols-1 md:grid-cols-2 lg:grid-cols-3/, 'cols={3} opts into a third column');
  assert.match(grid, /grid-cols-1 md:grid-cols-2/, 'the default is one column then two');
  assert.ok((allScreens.match(/<FormGrid\b/g) || []).length >= 8,
    'every multi-field form is laid out through it');
  // No screen may go back to the old sm:-breakpoint two-column form grid.
  assert.doesNotMatch(stripAllComments(`${topoJs}\n${allScreens}`),
    /grid grid-cols-1 sm:grid-cols-2 gap-3/,
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
  assert.doesNotMatch(`${topoJs}\n${allScreens}`, /_btn\(/, 'no button-building function');
  const legacy = [
    'text-xs text-zinc-500 hover:text-violet-400',
    'text-xs text-red-500 hover:text-red-400',
    'rounded-lg bg-violet-600 hover:bg-violet-500 px-',
  ];
  for (const cls of legacy) {
    assert.ok(!`${topoJs}\n${allScreens}`.includes(cls),
      `the hand-rolled "${cls}" button styling is gone`);
  }
  // Row actions are chips inside a wrapping group in BOTH list layouts.
  const listUi = fs.readFileSync(path.join(REACT_DIR, 'ui.tsx'), 'utf8');
  assert.match(listUi, /flex flex-wrap items-center justify-end gap-1/, 'table action cell wraps');
  assert.match(listUi, /mt-2 flex flex-wrap gap-1 border-t/, 'card action footer wraps');
});

test('every form reports failures through the shared inline error slot', () => {
  const uiTsx = fs.readFileSync(path.join(REACT_DIR, 'ui.tsx'), 'utf8');
  const slot = uiTsx.slice(uiTsx.indexOf('export function FormError('),
    uiTsx.indexOf('export function FormActions('));
  assert.match(slot, /if \(!message\) return null;/,
    'the slot is ABSENT rather than an empty paragraph toggled by a class');
  assert.match(slot, /role="alert"/, 'a validation failure is announced, not just coloured red');
  assert.ok((allScreens.match(/<FormError message=/g) || []).length >= 8,
    'every form panel carries one');
  // And no screen invents a second mechanism for the same job.
  for (const [i, src] of REACT_SCREENS.entries()) {
    if (!/<FormError/.test(src)) continue;
    assert.ok(!/classList\.(add|remove)\('hidden'\)/.test(src),
      `${REACT_SCREEN_FILES[i]} drives its error through the slot, not by toggling a class`);
  }
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
