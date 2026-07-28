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
const consoleJs = fs.readFileSync(path.join(root, 'public/js/admin-console.js'), 'utf8');
const topoJs = fs.readFileSync(path.join(root, 'public/js/admin-topochain.js'), 'utf8');

// Built subsections only — the four documented gaps (challenge-kinds,
// terms-versions, token-allocation, mobile-logs) must NOT appear as a
// SUBS entry (no API exists for any of them; mobile-logs' one usable
// capability, accept_logs, is folded into the Users form instead).
const BUILT_SUBS = [
  'seasons', 'season-events', 'users', 'onchain-accounts', 'user-activities',
  'challenge-templates', 'settings', 'app-version', 'sql-console', 'api-tester',
];
const GAP_SUBS = ['challenge-kinds', 'terms-versions', 'token-allocation', 'mobile-logs'];

// ─── admin-console.js: the one SECTIONS entry + delegation ────────────────

test("AdminConsole.SECTIONS carries exactly one 'topochain' entry", () => {
  assert.match(consoleJs, /\{ key: 'topochain', label: 'Topochain' \}/,
    "SECTIONS has the single topochain entry the plan's decision #8 calls for");
  const matches = consoleJs.match(/key: 'topochain'/g) || [];
  assert.equal(matches.length, 1, 'topochain appears exactly once in SECTIONS (one section, own sub-nav)');
});

test('_renderSection dispatches the topochain case to renderTopochainSection', () => {
  assert.match(consoleJs, /case 'topochain': return AdminConsole\.renderTopochainSection\(host\);/,
    'the section switch has a topochain branch');
  const fn = consoleJs.slice(consoleJs.indexOf('  renderTopochainSection(host) {'));
  assert.ok(fn.length > 0, 'renderTopochainSection is defined');
  assert.match(fn.slice(0, 400), /AdminTopochain\.render\(host\)/,
    'renderTopochainSection delegates to AdminTopochain.render(host)');
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

// ─── index.html: script registration ──────────────────────────────────────

test('admin-topochain.js is registered in index.html, after admin-console.js and before app.js', () => {
  const topoTag = '<script src="/js/admin-topochain.js"></script>';
  assert.ok(html.includes(topoTag), 'admin-topochain.js is loaded by the shell');
  const consoleIdx = html.indexOf('<script src="/js/admin-console.js"></script>');
  const topoIdx = html.indexOf(topoTag);
  const appIdx = html.indexOf('<script src="/js/app.js"></script>');
  assert.ok(topoIdx > consoleIdx, 'admin-topochain.js loads after the module it extends');
  assert.ok(appIdx > topoIdx, 'admin-topochain.js loads before app.js');
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

test('the four documented API gaps are explained in the file header, not silently dropped', () => {
  const header = topoJs.slice(0, topoJs.indexOf("'use strict';"));
  for (const phrase of [
    'no /api/v4/admin/seasons resource',
    'no admin (or public) endpoint lists',
    'no admin CRUD/read routes',
    'no admin endpoint lists per-user log payloads',
  ]) {
    assert.ok(header.includes(phrase), `header documents the gap: "${phrase}"`);
  }
});

test('the seasons subsection is documented as read-only/derived in its own render function', () => {
  const fn = topoJs.slice(topoJs.indexOf('async renderSeasons(host)'), topoJs.indexOf('_renderSeasonsList('));
  assert.match(fn, /no dedicated Seasons API/i, 'the UI itself tells the admin why there is no create/edit/delete here');
  assert.ok(!/canWrite/.test(fn), 'seasons has no mutating controls to gate — it is read-only by construction');
});

// ─── Sub-nav hash handling ──────────────────────────────────────────────

test('AdminTopochain owns its own second hash level (#admin/topochain/<sub>)', () => {
  const subFromHash = topoJs.slice(topoJs.indexOf('  _subFromHash() {'), topoJs.indexOf('  setSub(sub) {'));
  assert.match(subFromHash, /#admin\\\/topochain\\\/\(\[\^\/\]\+\)/,
    '_subFromHash parses the sub-key straight off location.hash');

  const syncHash = topoJs.slice(topoJs.indexOf('  _syncHash() {'), topoJs.indexOf('  _renderShell() {'));
  assert.match(syncHash, /#admin\/topochain\/\$\{AdminTopochain\._sub\}/, 'builds the two-level hash target');
  assert.match(syncHash, /location\.hash\.startsWith\('#admin\/topochain'\)/,
    'only writes back while actually on a topochain admin hash');
  assert.match(syncHash, /history\.replaceState/, 'replaceState — sub-nav hops never pollute the back stack');
  assert.ok(!/history\.pushState/.test(topoJs), 'the module never pushes history entries itself');
});

test('render() reads the deep-linked sub-key from the hash rather than a passed argument', () => {
  const fn = topoJs.slice(topoJs.indexOf('  render(host) {'), topoJs.indexOf('  _subFromHash() {'));
  assert.match(fn, /AdminTopochain\._subFromHash\(\) \|\| AdminTopochain\._sub \|\| 'seasons'/,
    'falls back through the hash, then the last-visited sub, then seasons');
});

// ─── Security: esc()/safeHref() discipline ─────────────────────────────────

test('esc() mirrors the hardened topochain-seasons.js/topochain-leaderboard.js version, not the older admin-console.js one', () => {
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
  // topochain-seasons.js's _ctaHtml does.
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
  const fn = topoJs.slice(topoJs.indexOf('  _userDeleteConfirmRow(u, identifier) {'), topoJs.indexOf('  async _togglePodium('));
  assert.match(fn, /data-expect="\$\{esc\(identifier\)\}"/, 'the expected string is the row identifier, exactly');
  assert.match(fn, /disabled/, 'the confirm button starts disabled');
  assert.match(fn, /ANY platform user/i, 'the copy warns this is not scoped to topochain-only rows');
  const wireFn = topoJs.slice(topoJs.indexOf("data-typed-check"), topoJs.indexOf("data-typed-check") + 400);
  assert.match(wireFn, /inp\.value !== inp\.dataset\.expect/, 'the button only enables on an exact match');
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
