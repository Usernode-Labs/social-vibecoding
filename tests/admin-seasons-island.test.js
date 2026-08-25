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
// The eleven screens are converting to React one at a time (#1120 slice 24).
// A converted screen's markup lives under frontend/src/features/admin/topochain/,
// so the id inventory below reads BOTH — a declared check must resolve against
// whichever renderer currently produces its anchor.
const topoDir = 'frontend/src/features/admin/topochain';
const topoReact = fs.readdirSync(path.join(root, topoDir))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => read(`${topoDir}/${f}`))
  .join('\n');
const tokens = read(`${topoDir}/tokens.ts`);
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
  // The read moved to topochain/tokens.ts with the rest of the control tokens
  // (#1120 slice 24) and is still an evaluation-time one — the module scope
  // below imports that file, so importing admin-topochain.js still evaluates
  // AdminUI.card. Nothing about the clustering argument changed; only which
  // file holds the line.
  assert.match(tokens, /^export const PANEL_CLS = AdminUI\.card;/m,
    'topochain/tokens.ts reads AdminUI.card while its module body evaluates');
  assert.match(tokens, /^import \{ AdminUI \} from '\.\.\/admin-console\.js';$/m,
    'and it must get it from an import, not from <script> order');
  assert.match(moduleScope, /^\} from '\.\/topochain\/tokens\.ts';$/m,
    'and admin-topochain.js pulls the tokens in at evaluation time too');
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
// A converted screen writes `id="admin-topo-…"` in JSX rather than in a
// template string, which the same two patterns already match; `data-*` in JSX
// is `data-x={…}` as often as `data-x="…"`, so that pattern accepts both.
const topoAll = `${topo}\n${topoReact}`;
const producedIds = new Set([
  ...[...topoAll.matchAll(/id=["'`]([\w-]+)["'`]/g)].map((m) => m[1]),
  ...[...topoAll.matchAll(/["'`](admin-topo-[\w-]+)["'`]/g)].map((m) => m[1]),
]);
const producedAttrs = new Set([...topoAll.matchAll(/\b(data-[\w-]+)[={]/g)].map((m) => m[1]));

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
  const detail = read(`${topoDir}/challenges.tsx`);
  const heroAt = detail.indexOf('id="admin-topo-se-detail-hero"');
  const tableAt = detail.indexOf('id="admin-topo-ch-table"');
  assert.ok(heroAt > 0 && tableAt > 0, 'both the detail hero and the challenge table must render');
  assert.ok(heroAt < tableAt, 'the hero must precede the challenge table, as the ~ selector requires');
  // They are siblings in one component, so the relationship is now
  // structural rather than a property of two separate innerHTML writes.
  assert.ok(!/<\w+[^>]*>\s*<div id="admin-topo-ch-table"/.test(detail),
    'nothing wraps the challenge table, which would break the ~ selector');
});

// ── 5. The SQL-schema explorer, client half ─────────────────────────────

// The SQL console is React since #1120 slice 25. The same five properties
// hold; each is expressed in the renderer it uses now, and three of them got
// stronger in the move because React removed the thing they were guarding.
const sqlTsx = read(`${topoDir}/sql-console.tsx`);

test('the schema explorer renders its three declared anchors', () => {
  // Named by the brief, and selected by three declared checks on
  // /#admin/sql-console.
  assert.match(sqlTsx, /id="admin-topo-sql-schema-filter"\n\s*type="search"/,
    'a search input filters the table list');
  assert.match(sqlTsx, /id="admin-topo-sql-schema-count"[\s\S]{0,200}?role="status"/,
    'the count is a live region, so a filter change is announced');
  assert.match(sqlTsx, /id="admin-topo-sql-schema" className="[^"]*overflow-y-auto"/,
    'the list itself scrolls within the panel rather than the page');
});

test('filtering the ~110-table schema is client-side over the fetched list', () => {
  // One request, then keystroke-local filtering. A request per keystroke would
  // be ~110 tables of schema re-fetched per character against the admin API.
  assert.match(sqlTsx, /fetchJson\('\/api\/v4\/admin\/sql-query\/schema'\)/,
    'the schema is fetched once');
  // The whole fetch lives in a mount-only effect — `[]` deps, so nothing the
  // operator types can re-run it. That is a stronger statement than the
  // "the re-render must not call fetchJson" the innerHTML version could make:
  // there is no re-render function left to check.
  const load = sqlTsx.slice(sqlTsx.indexOf('  useEffect(() => {\n    (async () => {'),
    sqlTsx.indexOf('  const tables ='));
  assert.ok(load.length > 300, 'the loading effect has a body');
  assert.match(load, /\}, \[\]\);\s*$/, 'and runs once on mount, not on any state change');
  assert.match(sqlTsx, /const shown = useMemo\(/, 'the filtered view is derived, not refetched');
  assert.match(sqlTsx, /t\.name\.toLowerCase\(\)\.includes\(needle\)/,
    'filtering is a substring match on the table name');
  assert.match(sqlTsx, /`\$\{shown\.length\} of \$\{tables\.length\} tables`/,
    'a narrowed list says how much of the schema it is showing');
});

test('a table button drafts an explicit-column SELECT, never a bare wildcard', () => {
  // Not cosmetic: the server-side validator REJECTS bare wildcards outright
  // (topochain-db-tools.test.js), so a drafted `SELECT *` would be a query the
  // console hands you and then refuses to run. Listing t.columns also keeps the
  // draft inside the redaction the server already applied to that list.
  assert.match(sqlTsx,
    /setQuery\(`SELECT \$\{t\.columns\.map\(\(c\) => c\.name\)\.join\(', '\)\} FROM \$\{t\.name\} LIMIT 100`\);/,
    'the draft lists the columns the server disclosed, bounded by a LIMIT');
  // The index-into-the-cache indirection is gone from the CLICK path: a button
  // closes over its own table, so there is no filtered-view position to
  // resolve against. `data-table` survives as an ATTRIBUTE because two
  // declared checks select on it — it is part of the screen's contract, not
  // part of its wiring any more.
  assert.match(sqlTsx, /onClick=\{\(\) => draft\(t\)\}/,
    'each button carries its own table rather than a position to re-resolve');
  assert.match(sqlTsx, /data-table=\{i\}/,
    "and still carries the index dapp.json's declared checks select on");
  // Comments stripped: the code is commented with "Never `SELECT *`", which is
  // the intent, not a violation of it.
  const code = sqlTsx.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/SELECT \*/.test(code), 'no bare wildcard may be drafted');
});

test('the schema list renders every server-supplied string as data, never markup', () => {
  // Table names and comments come from the database over the admin API — data,
  // never markup. The innerHTML version put both through the module's hardened
  // esc(); React escapes text children, so what has to hold now is that the
  // screen never opts back out. That covers the query RESULT grid too, which
  // renders arbitrary column values from an operator-written query.
  assert.match(sqlTsx, /title=\{t\.comment \|\| ''\}/, 'the tooltip is a prop, not interpolated markup');
  assert.match(sqlTsx, /<span className="truncate">\{t\.name\}<\/span>/, 'so is the table name');
  const code = sqlTsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(code),
    'the screen renders no raw HTML at all');
});

test('the console island is what loads all of this', () => {
  assert.ok(islandTsx.includes("import './admin-topochain.js';"),
    'the island must import the Seasons module');
  assert.ok(!read('public/index.html').includes('/js/admin-topochain.js'),
    'and the retired <script> tag must be gone from the generated shell');
  assert.ok(!read('public/sw.js').includes('/js/admin-topochain.js'),
    'and gone from the service worker precache list');
});
