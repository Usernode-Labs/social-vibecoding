const { withLanguage } = require("./lib/platform-language");
// The Workshop's lists carry each proposal's FAILING checks and count the
// passing ones (src/services/list-test-results.js).
//
// Measured on production, a row per declared check made GET /promoted 1.9 MB
// for 8 open proposals and /merged 5.1 MB for its first 20 — 97% passing rows
// that no card reads. Pinned here:
//   - the helper keeps every non-passing row (the aggregate "N checks did not
//     finish" row included) and counts the rest;
//   - it is opt-in: without `?results=failing` every route answers exactly as
//     before, so the CLI, the connector and agents are untouched;
//   - the shell asks for it everywhere it reads these lists, by one spelling;
//   - the checks verdict renders the same count and summary from a list row as
//     from the item's full row, and never counts a pass twice once the full
//     row is merged over the list row.
//
// Run with: node --test tests/list-test-results.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { failingResultsOnly, forListing, wantsFailingResults } = require('../src/services/list-test-results');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const pass = (i) => ({ index: i, name: `check ${i}`, path: `/#r${i}`, status: 'pass', flakeRate: null });
const RESULTS = [
  ...Array.from({ length: 40 }, (_, i) => pass(i)),
  { index: 40, name: 'Feed renders', path: '/feed', status: 'fail', failureReason: 'timed out' },
  { index: -1, name: '3 checks did not finish in the run budget', path: '', status: 'fail', advisory: true, count: 3 },
];
const ROW = { id: 7, check_state: 'failing', test_results: RESULTS };

test('the list form keeps what did not pass and counts what did', () => {
  const out = failingResultsOnly(ROW);
  assert.equal(out.test_results.length, 2);
  assert.deepEqual(out.test_results.map((r) => r.status), ['fail', 'fail']);
  assert.equal(out.test_results[1].count, 3, 'the aggregate row keeps its weight');
  assert.equal(out.test_results_omitted, 40);
  assert.equal(ROW.test_results.length, 42, 'a copy: the stored row is never mutated');
  // Nothing to drop, nothing changes — no stray zero on rows with no passes.
  const none = { id: 8, test_results: [RESULTS[40]] };
  assert.equal(failingResultsOnly(none), none);
  assert.equal(failingResultsOnly({ id: 9 }).test_results_omitted, undefined);
  assert.equal(failingResultsOnly(null), null);
});

test('it is opt-in by ?results=failing and nothing else', () => {
  assert.equal(wantsFailingResults({ query: { results: 'failing' } }), true);
  assert.equal(wantsFailingResults({ query: {} }), false);
  assert.equal(wantsFailingResults({ query: { results: 'all' } }), false);
  const rows = [ROW];
  assert.equal(forListing({ query: {} }, rows), rows, 'without the flag the rows are answered as they are');
  assert.equal(forListing({ query: { results: 'failing' } }, rows)[0].test_results.length, 2);
});

test('every Workshop list route passes its rows through it', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /promoted: listTestResults\.forListing\(req, rows\)/);
  assert.match(votes, /merged: listTestResults\.forListing\(req, rows\)/);
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /sessions: listTestResults\.forListing\(req, sessions\),\s*totals, externalTasks/,
    '/api/me/active-sessions: the imported rows kept their raw results by contract');
  assert.match(sessions, /res\.json\(\{ sessions: listTestResults\.forListing\(req, sessions\) \}\)/,
    '/shared-sessions');
  // The Workshop reads its own sessions only for the archived ones.
  assert.match(sessions, /AND \(\$3::text IS NULL OR status = \$3\)/);
  assert.match(sessions, /req\.query\.status === 'archived' \? 'archived' : null/);
});

test('the shell asks for the list form, by one spelling', () => {
  const view = read('public/js/app-view.js');
  assert.match(view, /_withDemo\(query\) \{\s*return `\?\$\{query\}\$\{AppView\._demoQS\(\) \? '&demo=1' : ''\}`;/);
  assert.match(view, /want\('promoted'\) \? fetch\(`\/api\/apps\/\$\{slug\}\/promoted\$\{AppView\._withDemo\('results=failing'\)\}`\)/);
  assert.match(view, /fetch\(`\/api\/apps\/\$\{slug\}\/promoted\?results=failing`\),\s*fetch\(`\/api\/apps\/\$\{slug\}\/merged\?results=failing`\)/,
    'the chat tab\'s vote state');
  assert.match(view, /const params = \['results=failing'\];/, 'every page of /merged');
  assert.match(view, /const activeQs = AppView\._withDemo\('results=failing&include_imported=1'\);/);
  assert.match(view, /shared-sessions\$\{AppView\._withDemo\('results=failing'\)\}/);
  assert.match(view, /sessions\$\{AppView\._withDemo\('status=archived'\)\}/);
  assert.match(read('public/js/group-chat.js'), /\/promoted\?results=failing/);
  assert.match(read('frontend/src/features/dev-board/card/ref-typeahead.tsx'), /\/promoted\?results=failing/);
});

function loadAppView() {
  const sandbox = {
    console, relTime: () => 'just now', App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null, querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach() {} }), addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} }, hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(withLanguage(sandbox));
  vm.runInContext(
    `${read('public/js/merge-status.js')}\n${read('public/js/session-transcript.js')}\n`
    + `${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

test('the verdict reads the same from a list row as from the full row', () => {
  const AppView = loadAppView();
  const full = AppView._checksVerdictView(ROW);
  const list = AppView._checksVerdictView(failingResultsOnly(ROW));
  assert.equal(list.summary, full.summary);
  assert.equal(list.heading, full.heading);
  assert.equal(list.passCount, full.passCount);
  assert.equal(full.passCount, 40);
  assert.equal(list.foldPasses, full.foldPasses);
  assert.deepEqual(list.failures.map((r) => r.name), full.failures.map((r) => r.name));
  assert.equal(list.passes.length, 0, 'the names arrive with the item\'s own row');
  assert.equal(full.passes.length, 40);
});

test('a passing proposal still has a verdict from its list row', () => {
  const AppView = loadAppView();
  const green = { id: 3, check_state: 'passing', test_results: RESULTS.slice(0, 40) };
  const list = AppView._checksVerdictView(failingResultsOnly(green));
  assert.ok(list, 'not the null a row with no results gets');
  assert.equal(list.summary, AppView._checksVerdictView(green).summary);
});

test('the full row merged over a list row is not counted twice', () => {
  const AppView = loadAppView();
  // topic-head merges the item's own read OVER the cached list row, so the
  // list row's count survives beside the full list.
  const merged = { ...failingResultsOnly(ROW), ...ROW };
  assert.equal(merged.test_results_omitted, 40);
  const v = AppView._checksVerdictView(merged);
  assert.equal(v.passCount, 40);
  assert.equal(v.summary, AppView._checksVerdictView(ROW).summary);
});
