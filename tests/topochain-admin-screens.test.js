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

// Built subsections only — the four documented gaps (challenge-kinds,
// terms-versions, token-allocation, mobile-logs) must NOT appear as a
// SUBS entry (no API exists for any of them; mobile-logs' one usable
// capability, accept_logs, is folded into the Users form instead).
const BUILT_SUBS = [
  'seasons', 'season-events', 'users', 'onchain-accounts', 'user-activities',
  'challenge-templates', 'settings', 'app-version', 'sql-console', 'api-tester',
];
const GAP_SUBS = ['challenge-kinds', 'terms-versions', 'token-allocation', 'mobile-logs'];

// Several bans below ("no window.prompt", "no matchMedia") are about what
// the module DOES, and this file's comments deliberately record what each
// call site replaced — prose that would otherwise trip the ban it exists
// to explain. Same line-comment strip the vocabulary test uses.
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');

// ─── admin-console.js: the one SECTIONS entry + delegation ────────────────

test("AdminConsole.SECTIONS carries exactly one 'seasons' entry, under its new name", () => {
  // #860 added a `group` field to every SECTIONS entry (the sidebar
  // headings); the decision-#8 shape — ONE top-level entry, its own sub-nav
  // — is unchanged. The KEY moved from 'topochain' to 'seasons' and the
  // label to the product name users actually recognise.
  assert.match(consoleJs, /\{ key: 'seasons', label: 'Seasons, Events & Challenges', group: '[^']+' \}/,
    "SECTIONS has the single renamed entry the plan's decision #8 calls for");
  const matches = consoleJs.match(/key: 'seasons'/g) || [];
  assert.equal(matches.length, 1, 'seasons appears exactly once in SECTIONS (one section, own sub-nav)');
  assert.doesNotMatch(consoleJs, /key: 'topochain'/,
    'the old key is gone from SECTIONS — it survives only as a legacy alias');
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

test('_renderSection dispatches seasons to AdminTopochain via SECTION_MODULES', () => {
  // #860 replaced the per-section render*Section methods for delegated
  // sections with the SECTION_MODULES map, so every module-backed section
  // (this one included) goes through one render/destroy code path. The
  // module's own name stays AdminTopochain: renaming the global and its
  // file would churn the service-worker precache list (public/sw.js) for
  // no user-visible gain.
  assert.match(consoleJs, /SECTION_MODULES: \{/, 'the module map exists');
  assert.match(consoleJs, /seasons: 'AdminTopochain'/,
    "SECTION_MODULES maps 'seasons' to the AdminTopochain global");
  const fn = consoleJs.slice(consoleJs.indexOf('  _renderSection() {'));
  assert.match(fn.slice(0, 1200), /mod\.render\(host\)/,
    'the dispatcher calls render(host) on the mapped module');
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

test('every built subsection key is present in SUBS, and no gap key is', () => {
  for (const key of BUILT_SUBS) {
    assert.match(topoJs, new RegExp(`key: '${key}'`), `SUBS carries the built '${key}' subsection`);
  }
  for (const key of GAP_SUBS) {
    assert.ok(!new RegExp(`key: '${key}'`).test(topoJs),
      `'${key}' has no API — must not appear as a SUBS entry (documented gap, not dead UI)`);
  }
});

test('every built subsection has a render function reachable from _renderSub', () => {
  const fn = topoJs.slice(topoJs.indexOf('  _renderSub() {'), topoJs.indexOf('  // ══'.repeat(1), topoJs.indexOf('  _renderSub() {')));
  const renderFns = [
    'renderSeasonEvents', 'renderUsers', 'renderOnchainAccounts', 'renderUserActivities',
    'renderChallengeTemplates', 'renderSettings', 'renderAppVersion', 'renderSqlConsole',
    'renderApiTester', 'renderSeasons',
  ];
  for (const name of renderFns) {
    assert.ok(fn.includes(name), `_renderSub dispatches to ${name}`);
    assert.match(topoJs, new RegExp(`\\b${name}\\(host\\) \\{|async ${name}\\(host\\) \\{`),
      `${name}(host) is defined`);
  }
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

test('the seasons subsection is full CRUD against the real /admin/seasons resource', () => {
  const fn = topoJs.slice(topoJs.indexOf('  renderSeasons(host) {'), topoJs.indexOf('  _se: {'));
  assert.ok(!/no dedicated Seasons API/i.test(fn),
    'the "there is no API" banner is gone — there is one');
  assert.match(fn, /\/api\/v4\/admin\/seasons/, 'the screen talks to the seasons resource directly');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.ok(fn.includes(`'${method}'`), `the screen can ${method}`);
  }
  // Same rule as every other CRUD screen in this file: the control is
  // not rendered for a view-only admin AND the handler refuses anyway.
  for (const handler of ['_openSeasonForm(id)', '_saveSeason()', '_deleteSeason(id)']) {
    const body = fn.slice(fn.indexOf(`async ${handler} {`));
    assert.match(body.slice(0, 200), /if \(!AdminTopochain\.canWrite\(\)\) return;/,
      `${handler} refuses a view-only admin even if the control were reachable`);
  }
});

test('the seasons list delete surfaces the 409 season_in_use message rather than a generic failure', () => {
  const fn = topoJs.slice(topoJs.indexOf('  async _deleteSeason(id) {'), topoJs.indexOf('  // ══════', topoJs.indexOf('  async _deleteSeason(id) {')));
  assert.match(fn, /res\.data && res\.data\.error/,
    "the API's own message (which names what still references the season) is what the admin sees");
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

// ─── Sub-nav hash handling ──────────────────────────────────────────────

test('AdminTopochain owns its own second hash level (#admin/seasons/<sub>)', () => {
  const subFromHash = topoJs.slice(topoJs.indexOf('  _subFromHash() {'), topoJs.indexOf('  setSub(sub) {'));
  // Reads BOTH prefixes: a deep link minted before the rename
  // (#admin/topochain/users) has to keep landing on its sub-tab, not just
  // on the section's default screen.
  assert.ok(subFromHash.includes('#admin\\/(?:seasons|topochain)\\/([^/]+)'),
    '_subFromHash parses the sub-key off either the canonical or the legacy prefix');

  const syncHash = topoJs.slice(topoJs.indexOf('  _syncHash() {'), topoJs.indexOf('  _renderShell() {'));
  assert.match(syncHash, /#admin\/seasons\/\$\{AdminTopochain\._sub\}/,
    'builds the CANONICAL two-level hash target — the legacy address self-heals on first render');
  assert.match(syncHash, /startsWith\('#admin\/seasons'\)/,
    'only writes back while actually on this admin section');
  assert.match(syncHash, /startsWith\('#admin\/topochain'\)/,
    '...including when the address is still the legacy one, which is exactly when the rewrite is needed');
  assert.match(syncHash, /history\.replaceState/, 'replaceState — sub-nav hops never pollute the back stack');
  assert.ok(!/history\.pushState/.test(topoJs), 'the module never pushes history entries itself');
});

test('app.js rewrites a legacy #admin/topochain address, sub-tab and all', () => {
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const branch = appJs.slice(appJs.indexOf("parts[0] === 'admin'"),
    appJs.indexOf("parts[0] === 'admin'") + 1400);
  assert.match(branch, /_adminSection === 'topochain'/, 'the legacy section key is recognised');
  assert.match(branch, /_adminSection = 'seasons';/, 'and mapped to the canonical one');
  // Everything from parts[2] on is owned by AdminTopochain — the sub-tab
  // AND the Season-events tail under it
  // (season-events/<eventId>/new-challenge/<templateId>). Keeping only
  // parts[2] would demote a deep bookmark to the tab's default screen;
  // dropping it entirely would demote it to the section's.
  assert.match(branch, /const tail = parts\.slice\(2\)\.join\('\/'\);/,
    'the whole tail below the section segment is carried over');
  assert.match(branch, /tail \? `#admin\/seasons\/\$\{tail\}` : `?'?#admin\/seasons/,
    'and spliced back under the canonical prefix');
  assert.match(branch, /history\.replaceState/, 'the address bar self-heals rather than keeping a dead path');
});

test('render() reads the deep-linked sub-key from the hash rather than a passed argument', () => {
  const fn = topoJs.slice(topoJs.indexOf('  render(host) {'), topoJs.indexOf('  _subFromHash() {'));
  assert.match(fn, /AdminTopochain\._subFromHash\(\) \|\| AdminTopochain\._sub \|\| 'seasons'/,
    'falls back through the hash, then the last-visited sub, then seasons');
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
  for (const field of [
    'ev.name', 'u.email', 'a.public_key', 't.category', 's.key', 'c.os',
    't.reward', 'a.tier',
  ]) {
    const re = new RegExp(`esc\\(${field.replace('.', '\\.')}`);
    assert.ok(re.test(topoJs), `${field} passes through esc() somewhere in admin-topochain.js`);
  }
});

// ─── canWrite() gates every mutating control ───────────────────────────────

test('every AdminTopochain.send(...) mutating call sits inside a canWrite()-guarded function', () => {
  const lines = topoJs.split('\n');
  const fnHeaderRe = /^\s{2}(async )?_?\w+\([^)]*\)\s*\{\s*$/;
  const sendCallLineIdxs = [];
  lines.forEach((line, i) => { if (line.includes('AdminTopochain.send(')) sendCallLineIdxs.push(i); });
  assert.ok(sendCallLineIdxs.length >= 15, `expected many send() call sites, found ${sendCallLineIdxs.length}`);

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
});

test('the one non-mutating POST (sql-query/execute) is explicitly NOT canWrite-gated, with a comment saying why', () => {
  const fn = topoJs.slice(topoJs.indexOf('  async _runSqlQuery() {'), topoJs.indexOf('  // ══', topoJs.indexOf('async _runSqlQuery')));
  assert.match(fn, /read-only by construction server-side/i,
    'the file explains that sql-query/execute is a read-only endpoint despite using POST');
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

test('the vocabulary is actually used: Event / User / Challenge template / Kind', () => {
  assert.match(topoJs, /label: 'Season events'/);
  assert.match(topoJs, /label: 'Users'/);
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

// ─── Grouped sub-nav: four clusters on desktop, two levels on mobile ──────

test('SUB_GROUPS partitions SUBS exactly — every screen in one and only one group', () => {
  // SUBS stays the key→label source of truth; SUB_GROUPS only says which
  // cluster a key belongs to. If the two ever drift, a screen either
  // vanishes from the nav entirely or appears twice, and neither failure
  // is visible anywhere except by opening the section.
  const groupsSrc = topoJs.slice(topoJs.indexOf('  SUB_GROUPS: ['), topoJs.indexOf('  SUB_GROUPS: [') + 900);
  const grouped = [...groupsSrc.matchAll(/subs: \[([^\]]+)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  const subsSrc = topoJs.slice(topoJs.indexOf('  SUBS: ['), topoJs.indexOf('  SUB_GROUPS: ['));
  const subKeys = [...subsSrc.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);

  assert.ok(subKeys.length >= 10, 'SUBS still lists every screen');
  assert.equal(new Set(grouped).size, grouped.length, 'no key appears in two groups');
  assert.deepEqual(grouped.slice().sort(), subKeys.slice().sort(),
    'SUB_GROUPS and SUBS must be a bijection');

  const labels = [...groupsSrc.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Programme', 'People', 'Activity', 'Platform'],
    'the four cluster headings the redesign specifies');
});

test('the sub-nav renders a desktop cluster strip and a two-level mobile list', () => {
  const desktop = topoJs.slice(topoJs.indexOf('  _desktopNavHtml() {'), topoJs.indexOf('  _mobileNavHtml() {'));
  assert.match(desktop, /hidden md:flex/, 'the cluster strip is md+ only');
  assert.match(desktop, /aria-current="page"/, 'the active screen is announced, not just coloured');
  assert.match(desktop, /SUB_GROUPS\.map/, 'it renders from the group definition, not a flat list');

  const mobile = topoJs.slice(topoJs.indexOf('  _mobileNavHtml() {'), topoJs.indexOf('  _renderShell() {'));
  assert.match(mobile, /md:hidden/, 'the two-level list is below-md only');
  assert.match(mobile, /_navLevel/, 'level 1 (groups) and level 2 (one group\'s screens)');
  assert.match(mobile, /admin-topo-nav-back/, 'level 2 offers a way back to the group list');
  assert.match(mobile, /min-h-\[44px\]/, 'drill-in rows meet the touch-target floor');
  // No matchMedia anywhere: the level only affects the md:hidden block, and
  // the content host is hidden md:block at level 1, so the desktop layout
  // is unaffected by mobile nav state and there is no breakpoint to sync.
  assert.ok(!/matchMedia/.test(stripComments(topoJs)), 'the responsive split is CSS-only');
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
  assert.ok((topoJs.match(/_skeleton\(\d\)/g) || []).length >= 10,
    'every async screen renders a skeleton while it fetches');

  // A failed fetch must be distinguishable from an empty result, and
  // recoverable without a full page reload.
  assert.ok((topoJs.match(/_error\(\{/g) || []).length >= 7,
    'every loader has an error branch');
  assert.ok((topoJs.match(/_wireRetry\(/g) || []).length >= 7,
    'every error block wires its own retry');
  assert.match(topoJs, /Couldn't reach the server\./,
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
    '_openUserImportForm', '_openUserExport', '_openAccountImportForm',
    '_openActivityForm', '_openActivityImportForm', '_openActivityTotals',
    '_openTemplateForm', '_openSettingForm', '_openAppVersionForm',
    '_moveChallenge',
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
    'renderSeasons', 'renderSeasonEvents', 'renderUsers', 'renderWaitlist',
    'renderOnchainAccounts', 'renderUserActivities', 'renderChallengeTemplates',
    'renderSettings', 'renderAppVersion', 'renderSqlConsole', 'renderApiTester',
  ];
  for (const fn of SCREENS) {
    const start = topoJs.search(new RegExp(`\\n  (?:async )?${fn}\\(host\\) \\{`));
    assert.ok(start > 0, `${fn} is defined`);
    const body = topoJs.slice(start, start + topoJs.slice(start).indexOf('\n  },'));
    assert.match(body, /_screenHeader\(\{/, `${fn} uses the shared screen header`);
  }
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
  assert.match(topoJs, /const BTN_BASE = /, 'one base class string for every button');
  assert.match(topoJs, /const FIELD_CLS = /, 'one class string for every text input and select');
  assert.match(topoJs, /const TEXTAREA_CLS = /, '...and one for every textarea');
  assert.match(topoJs, /const PANEL_CLS = /, '...and one panel/card surface');
  assert.match(topoJs, /touch-manipulation/, 'taps are not delayed by double-tap-zoom detection');
  assert.match(topoJs, /focus-visible:ring-2/, 'keyboard focus stays visible');
  // 44px is the tap target on a phone; the denser 36px only applies once
  // there is a pointer-sized viewport.
  assert.ok((topoJs.match(/min-h-\[44px\] sm:min-h-\[36px\]/g) || []).length >= 3,
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
  assert.ok((topoJs.match(/_formErrorSlot\(/g) || []).length >= 8,
    'every form panel carries one');
  // The save handlers toggle `hidden` on that element by id — the slot
  // must keep that contract rather than inventing a second mechanism.
  assert.ok((topoJs.match(/errEl\.classList\.remove\('hidden'\)/g) || []).length >= 5,
    'the existing show-the-error path still drives it');
});

test('the tool screens got the same treatment as the CRUD screens', () => {
  const sql = topoJs.slice(topoJs.indexOf('  renderSqlConsole(host) {'),
    topoJs.indexOf('  async _loadSqlTemplates()'));
  assert.match(sql, /grid-cols-1 gap-4 lg:grid-cols-\[260px_1fr\]/,
    'the SQL console is one column on a phone, sidebar + editor at lg:');
  assert.match(sql, /lg:order-2/,
    'the query editor comes first on a phone, and moves right at lg:');
  assert.ok((sql.match(/_panel\(\{/g) || []).length >= 3,
    'query, templates and schema each sit in a panel');
  assert.match(sql, /_skeleton\(3\)/, 'the reference lists show a skeleton while they load');

  const api = topoJs.slice(topoJs.indexOf('  renderApiTester(host) {'),
    topoJs.indexOf('  async _runApiTest()'));
  assert.match(api, /_panel\(\{/, 'the request builder is a panel');
  assert.match(api, /<label for="admin-topo-api-method"/, 'the method select is labelled');
  assert.match(api, /<label for="admin-topo-api-path"/, '...and so is the path input');
  assert.match(api, /\$\{FIELD_CLS\}/, 'its inputs use the shared field styling');
});

test('the SQL result and API response areas use the shared empty/panel treatment', () => {
  const run = topoJs.slice(topoJs.indexOf('  async _runSqlQuery()'),
    topoJs.indexOf('  // ══════════════════════════════════════════════════════════════════\n  // API tester'));
  assert.match(run, /_empty\(\{/, 'a query that matched nothing gets the empty-state card');
  assert.match(run, /role="status"/, 'running/failed states are announced');
  const apiRun = topoJs.slice(topoJs.indexOf('  async _runApiTest()'));
  assert.match(apiRun, /\$\{PANEL_CLS\}/, 'the response is framed like every other panel');
  assert.match(apiRun, /HTTP \$\{esc\(res\.status\)\}/, 'the status line survives, escaped');
});
