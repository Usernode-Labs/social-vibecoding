// Seasons, Events & Challenges — and its SQL-schema explorer — through the
// React seam (#1082 chunk E, step 3).
//
// admin-topochain.js is the largest module the console has (~230 KB, eleven
// screens under its own second hash level) and the one that forced chunk E's
// shape: it reads AdminUI.card at module-EVALUATION time, and
// /shell/assets/shell.js is a `type="module"` script that evaluates after every
// classic <script>, so admin-console.js could not move into the bundle on its
// own without leaving this file reading an undefined global. All ten moved
// together for that reason. This file pins what that buys and what it must not
// have cost.
//
// What is NOT here: the import ordering and the window publication
// (tests/topochain-admin-screens.test.js), the module's eleven screens, its
// canWrite() gating and its escaping (same file, 40-odd tests), and the SQL
// console's server-side validator (tests/topochain-db-tools.test.js, which is
// where "can this query read a credential column" is decided). This file covers
// the four things the MOVE could plausibly break, plus the schema explorer's
// client half, which until now had no coverage at all.
//
// Run with: node --test tests/admin-seasons-island.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const topo = read('frontend/src/features/admin/admin-topochain.js');
const islandTsx = read('frontend/src/features/admin/index.tsx');
const consoleJs = read('frontend/src/features/admin/admin-console.js');
const manifest = JSON.parse(read('dapp.json'));

// Everything above the AdminTopochain object literal — i.e. the part that runs
// when the module is merely IMPORTED, in the browser and in Node alike.
const moduleScope = topo.slice(0, topo.indexOf('const AdminTopochain = {'));

// ── 1. Why the cluster had to move together ─────────────────────────────

test('the class registry is read at module-evaluation time, from an import', () => {
  // This single line is the whole reason ten modules retired in one commit
  // instead of one at a time. If it ever stops being an evaluation-time read,
  // say so in the commit that changes it rather than discovering later that the
  // clustering was unnecessary.
  assert.match(moduleScope, /^const PANEL_CLS = AdminUI\.card;/m,
    'admin-topochain.js reads AdminUI.card while its module body evaluates');
  assert.match(moduleScope, /^import \{ AdminUI \} from '\.\/admin-console\.js';$/m,
    'and it must get it from an import, not from <script> order');
  assert.match(consoleJs, /^export const AdminUI = Object\.freeze\(\{$/m,
    'admin-console.js must export the registry rather than only publishing it');
});

test('nothing else in this module touches a browser API at import time', () => {
  // The bundle is evaluated in Node by the SSG prerender pass, so an
  // evaluation-time `location` / `localStorage` / `document` read is a build
  // failure, not a runtime one. Comments are stripped first: the file header
  // discusses location.hash at length, and the point here is what EXECUTES.
  const code = moduleScope
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const api of ['localStorage', 'sessionStorage', 'document.', 'location.',
    'navigator.', 'matchMedia', 'URLSearchParams']) {
    assert.ok(!code.includes(api),
      `admin-topochain.js reads ${api} at module-evaluation time, which the `
      + 'prerender pass performs in Node — guard it with typeof window, or move it '
      + 'inside render()');
  }
  // And the publication itself is guarded, for the same reason.
  assert.match(topo, /if \(typeof window !== 'undefined'\) window\.AdminTopochain = AdminTopochain;/,
    'the window publication must be guarded for the prerender pass');
});

// ── 2. topochain-events.js is deliberately NOT retired ──────────────────

test('topochain-events.js stays a classic script, on all four registers', () => {
  // It serves the PUBLIC Leaderboard screen as well as the admin console, so it
  // is not this chunk's to move: retiring it would drag a public screen's
  // dependency into an admin island. Named explicitly in the brief.
  assert.ok(fs.existsSync(path.join(root, 'public/js/topochain-events.js')),
    'public/js/topochain-events.js must still exist');
  assert.match(read('frontend/src/Shell.tsx'), /<script src="\/js\/topochain-events\.js" \/>/,
    'Shell.tsx must still render its <script> tag');
  assert.ok(read('public/index.html').includes('/js/topochain-events.js'),
    'the generated shell must still carry it');
  assert.ok(read('public/sw.js').includes("'/js/topochain-events.js'"),
    'it must stay precached in SHELL_ASSETS');
  // The retirement map is the audit trail; it must not name this file.
  const order = read('tests/shell-script-order.test.js');
  const mapAt = order.indexOf('const RETIRED_SCRIPTS = {');
  assert.ok(mapAt > 0, 'shell-script-order.test.js must still keep a RETIRED_SCRIPTS map');
  const retired = order.slice(mapAt, order.indexOf('\n};', mapAt));
  assert.ok(!retired.includes('/js/topochain-events.js'),
    'topochain-events.js must not appear in RETIRED_SCRIPTS');
  assert.ok(retired.includes('/js/admin-topochain.js'),
    'admin-topochain.js must appear in RETIRED_SCRIPTS — it is the one that moved');
});

// ── 3. Lifecycle and the React boundary ─────────────────────────────────

test('the section honours render(host) / destroy(), and destroy() has nothing to clear', () => {
  assert.match(topo, /\n  render\(host\) \{/, 'render(host) is the console\'s entry point');
  assert.match(topo, /\n  destroy\(\) \{/, 'destroy() is the other half of the #860 contract');
  // destroy() drops the host reference and nothing else, and that is only
  // correct while the module holds no timers. Pinning the absence means adding
  // one later fails here and forces destroy() to grow with it, instead of
  // leaking a poll for the life of the tab the way #860 fixed for status/node.
  const starts = (topo.match(/setInterval\(/g) || []).length;
  assert.equal(starts, 0,
    `admin-topochain.js now starts ${starts} interval(s); destroy() clears none. `
    + 'Either clear them there or stop starting them.');
  const destroy = topo.slice(topo.indexOf('  destroy() {'));
  assert.match(destroy.slice(0, 200), /AdminTopochain\._host = null;/,
    'destroy() must release the detached host so the tree is not retained');
});

test('the section never reaches into the React-owned chassis', () => {
  // #admin-root, the sidebar host, the view-only banner and the temp-password
  // dialog are React's since chunk E1. Comments may DISCUSS the host — the
  // file header does — so this checks executable lines only.
  const code = topo.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const id of ['admin-root', 'admin-nav-desktop', 'admin-view-only-banner',
    'admin-temp-pw-modal', 'admin-section-content']) {
    assert.ok(!code.includes(id),
      `admin-topochain.js references #${id}, which is chassis React owns — the `
      + 'section gets its root as render()\'s argument');
  }
  assert.match(topo, /render\(host\) \{\n\s*AdminTopochain\._host = host;/,
    'the host argument is where the section roots itself');
});

// ── 4. Every declared #admin/seasons anchor is still produced ───────────

// Ids appear in this module three ways: literally in markup, as the first
// argument to the shared _inputHtml/_textareaHtml/_selectHtml builders, and as
// a getElementById lookup. Any quoted occurrence counts as "the module knows
// this id" — the builders are covered by their own escaping tests.
const producedIds = new Set([
  ...[...topo.matchAll(/id=["'`]([\w-]+)["'`]/g)].map((m) => m[1]),
  ...[...topo.matchAll(/["'`](admin-topo-[\w-]+)["'`]/g)].map((m) => m[1]),
]);
const producedAttrs = new Set([...topo.matchAll(/\b(data-[\w-]+)=/g)].map((m) => m[1]));

test('every id and data-* a declared programme-screen check selects on is produced', () => {
  // The screens are first-class sections since #1179, so the declared
  // checks address them at #admin/<screen> (legacy #admin/seasons/... and
  // #admin/topochain/... aliases included).
  const declared = (manifest.tests || []).filter((t) => new RegExp(
    '#admin/(seasons|topochain|season-events|challenge-templates|waitlist|'
    + 'onchain-accounts|user-activities|settings|app-version|sql-console|api-tester)'
  ).test(t.path || ''));
  assert.ok(declared.length >= 10,
    `expected the programme screens' declared checks to still be there, saw ${declared.length}`);

  let checked = 0;
  for (const t of declared) {
    if (!t.expectSelector) continue;
    for (const [, id] of t.expectSelector.matchAll(/#([A-Za-z_][-\w]*)/g)) {
      // The chassis ids are React's and are pinned by shell-id-inventory.
      if (['admin-screen', 'admin-root', 'admin-section-content'].includes(id)) continue;
      assert.ok(producedIds.has(id),
        `dapp.json's ${t.path} check selects #${id}, which admin-topochain.js no longer produces`);
      checked += 1;
    }
    for (const [, attr] of t.expectSelector.matchAll(/\[(data-[\w-]+)/g)) {
      assert.ok(producedAttrs.has(attr),
        `dapp.json's ${t.path} check selects [${attr}], which admin-topochain.js no longer renders`);
      checked += 1;
    }
  }
  // Guards against a selector-parsing slip turning the loop into a no-op.
  assert.ok(checked >= 9, `expected to have checked at least 9 anchors, checked ${checked}`);
});

test('the deep-linked Season-events screens the brief names still resolve', () => {
  // #admin/seasons/season-events/<id>[/new-challenge[/<templateId>]] — the two
  // nested screens whose whole point is being addressable. Their anchors are
  // asserted above from dapp.json; this pins the sibling relationship one of
  // those selectors depends on (`#…-se-detail-hero ~ #…-ch-table`), which an
  // innocent-looking wrapper <div> around either one would break.
  const heroAt = topo.indexOf('id="admin-topo-se-detail-hero"');
  const tableAt = topo.indexOf('id="admin-topo-ch-table"');
  assert.ok(heroAt > 0 && tableAt > 0, 'both the detail hero and the challenge table must render');
  assert.ok(heroAt < tableAt, 'the hero must precede the challenge table, as the ~ selector requires');
});

// ── 5. The SQL-schema explorer, client half ─────────────────────────────

test('the schema explorer renders its three declared anchors', () => {
  // Named by the brief, and selected by three declared checks on
  // /#admin/seasons/sql-console.
  assert.match(topo, /<input id="admin-topo-sql-schema-filter" type="search"/,
    'a search input filters the table list');
  assert.match(topo, /<p id="admin-topo-sql-schema-count"[^>]*role="status"/,
    'the count is a live region, so a filter change is announced');
  assert.match(topo, /<div id="admin-topo-sql-schema" class="[^"]*overflow-y-auto"/,
    'the list itself scrolls within the panel rather than the page');
});

test('filtering the ~90-table schema is client-side over the fetched list', () => {
  // One request, then keystroke-local filtering. A request per keystroke would
  // be ~90 tables of schema re-fetched per character against the admin API.
  const load = topo.slice(topo.indexOf('async _loadSqlSchema()'), topo.indexOf('_renderSqlSchemaList(term)'));
  assert.match(load, /fetchJson\('\/api\/v4\/admin\/sql-query\/schema'\)/,
    'the schema is fetched once');
  assert.match(load, /AdminTopochain\._sql\.schema = data\.data;/, 'and cached');
  assert.match(load, /filter\.addEventListener\('input', \(\) => AdminTopochain\._renderSqlSchemaList\(filter\.value\)\)/,
    'input re-renders from the cache — it must not re-fetch');
  const render = topo.slice(topo.indexOf('_renderSqlSchemaList(term)'), topo.indexOf('async _runSqlQuery()'));
  assert.ok(!render.includes('fetchJson'), 'the filtered re-render must not hit the network');
  assert.match(render, /includes\(needle\)/, 'filtering is a substring match on the table name');
  assert.match(render, /\$\{shown\.length\} of \$\{all\.length\} tables/,
    'a narrowed list says how much of the schema it is showing');
});

test('a table button drafts an explicit-column SELECT, never a bare wildcard', () => {
  // Not cosmetic: the server-side validator REJECTS bare wildcards outright
  // (topochain-db-tools.test.js), so a drafted `SELECT *` would be a query the
  // console hands you and then refuses to run. Listing t.columns also keeps the
  // draft inside the redaction the server already applied to that list.
  const render = topo.slice(topo.indexOf('_renderSqlSchemaList(term)'), topo.indexOf('async _runSqlQuery()'));
  assert.match(render, /data-table="\$\{i\}"/,
    'each button carries its index into the cached schema, not a name to re-resolve');
  assert.match(render, /const cols = t\.columns\.map\(\(c\) => c\.name\)\.join\(', '\);/,
    'the draft lists the columns the server disclosed');
  assert.match(render, /`SELECT \$\{cols\} FROM \$\{t\.name\} LIMIT 100`/,
    'and bounds the draft with a LIMIT');
  // Comments stripped: the code above is commented with "Never `SELECT *`",
  // which is the intent, not a violation of it.
  const code = render.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/SELECT \*/.test(code), 'no bare wildcard may be drafted');
});

test('the schema list escapes every server-supplied string it renders', () => {
  // Table names and comments come from the database over the admin API — data,
  // never markup. Both go through the module's hardened esc().
  const render = topo.slice(topo.indexOf('_renderSqlSchemaList(term)'), topo.indexOf('async _runSqlQuery()'));
  assert.match(render, /title="\$\{esc\(t\.comment \|\| ''\)\}"/, 'the tooltip is escaped');
  assert.match(render, /<span class="truncate">\$\{esc\(t\.name\)\}<\/span>/, 'the table name is escaped');
});

test('the console island is what loads all of this', () => {
  assert.ok(islandTsx.includes("import './admin-topochain.js';"),
    'the island must import the Seasons module');
  assert.ok(!read('public/index.html').includes('/js/admin-topochain.js'),
    'and the retired <script> tag must be gone from the generated shell');
  assert.ok(!read('public/sw.js').includes('/js/admin-topochain.js'),
    'and gone from the service worker precache list');
});
