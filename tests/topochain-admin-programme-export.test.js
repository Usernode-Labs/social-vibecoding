// The programme CSV (src/routes/topochain/admin/programme-export.js): its
// file shape, its gate, and the Download CSV control on the Season events
// and Challenge templates screens.
//
// The rows themselves (which challenges, which rules, in what order) are the
// SQL's job and are checked against the real schema in
// tests/topochain-admin-programme-export-postgres.test.js. This file pins
// what the route does with rows once it has them, against a fake pool that
// hands back exactly what pg would: BIGINT and NUMERIC as strings, booleans,
// Date objects.
//
// Run with: node --test tests/topochain-admin-programme-export.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Install the getPool indirection BEFORE requiring any route module — each
// one destructures `getPool` at require time. Same idiom as
// tests/topochain-admin-seasons-api.test.js.
const poolMod = require('../src/db/pool');
let poolRows = [];
let poolQueries = [];
poolMod.getPool = () => ({
  async query(sql, params) {
    poolQueries.push({ sql, params });
    return { rows: poolRows };
  },
  async connect() { throw new Error('the export takes no client'); },
});

const {
  buildProgrammeCsv, programmeCsvFilename, PROGRAMME_CSV_COLUMNS, PROGRAMME_EXPORT_SQL,
} = require('../src/routes/topochain/admin/programme-export');
const { topochainAdminRoutes } = require('../src/routes/topochain/admin');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const ROUTE = '/api/v4/admin/programme/export.csv';

const HEADER = [
  'row_kind',
  'season_id', 'season', 'season_active',
  'event_id', 'event', 'event_type', 'event_internal', 'event_active',
  'event_starts_at', 'event_ends_at',
  'challenge_id', 'display_order', 'enabled', 'completed',
  'template_id', 'category',
  'title', 'task', 'template_reward', 'reward_override', 'cta_label', 'cta_link',
  'metric_type', 'metric_target',
  'schedule_start', 'schedule_end',
  'rule_id', 'rule_name', 'rule_measure', 'rule_bound_to', 'rule_target', 'rule_points',
  'rule_enabled', 'rule_interval_minutes',
];

// RFC 4180 reader: quoted fields may hold commas, doubled quotes, CR and LF;
// records end in CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i += 1;
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const START = new Date('2026-10-05T09:00:00Z');
const END = new Date('2026-10-19T09:00:00Z');

// One challenge row as pg returns it, with everything a column could hold.
function challengeRow(over = {}) {
  return {
    row_kind: 'challenge',
    season_id: '3', season: 'Season 2', season_active: true,
    event_id: '11', event: 'Week 1', event_type: 'regular',
    event_internal: false, event_active: true,
    event_starts_at: START, event_ends_at: END,
    challenge_id: '101', display_order: 2, enabled: true, completed: false,
    template_id: '7', category: 'ONBOARDING',
    title: 'Try 3 apps', task: 'Open three apps', template_reward: '500 pts', reward_override: null,
    cta_label: 'Open apps', cta_link: '/#discover',
    metric_type: 'apps_tried', metric_target: '3.0000',
    schedule_start: null, schedule_end: null,
    rule_id: '41', rule_name: 'Try apps', rule_measure: 'TRY_APPS', rule_bound_to: 'challenge',
    rule_target: null, rule_points: '250.00', rule_enabled: true, rule_interval_minutes: 10,
    sort_group: 0,
    ...over,
  };
}

function unusedRow(over = {}) {
  return {
    row_kind: 'unused_template',
    season_id: null, season: null, season_active: null,
    event_id: null, event: null, event_type: null, event_internal: null, event_active: null,
    event_starts_at: null, event_ends_at: null,
    challenge_id: null, display_order: null, enabled: null, completed: null,
    template_id: '9', category: 'BUILD',
    title: 'Ship a feature', task: 'Merge one proposal', template_reward: '1,000 pts', reward_override: null,
    cta_label: null, cta_link: null, metric_type: null, metric_target: null,
    schedule_start: null, schedule_end: null,
    rule_id: null, rule_name: null, rule_measure: null, rule_bound_to: null,
    rule_target: null, rule_points: null, rule_enabled: null, rule_interval_minutes: null,
    ...over,
  };
}

// ── The file ───────────────────────────────────────────────────────────

test('the columns are the documented ones, in order', () => {
  assert.deepEqual(PROGRAMME_CSV_COLUMNS.map((c) => c.name), HEADER);
});

test('the file opens with a UTF-8 BOM, then the header, and every record ends in CRLF', () => {
  const csv = buildProgrammeCsv([challengeRow()]);
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'BOM first, so Excel reads UTF-8');
  const body = csv.slice(1);
  assert.ok(body.startsWith(`${HEADER.join(',')}\r\n`), 'the header row, CRLF-terminated');
  assert.ok(body.endsWith('\r\n'), 'the last record is terminated too');
  assert.equal(body.split('\r\n').length, 3, 'header + one record + the trailing empty split');
  assert.ok(!/[^\r]\n/.test(body), 'no bare LF line endings');
  assert.equal(buildProgrammeCsv([]), `﻿${HEADER.join(',')}\r\n`, 'no rows is still a valid file');
});

test('values are written as a spreadsheet should read them', () => {
  const [header, rec] = parseCsv(buildProgrammeCsv([challengeRow()]).slice(1));
  const r = Object.fromEntries(header.map((h, i) => [h, rec[i]]));
  assert.equal(r.row_kind, 'challenge');
  assert.equal(r.season_id, '3');
  assert.equal(r.season_active, 'true');
  assert.equal(r.event_internal, 'false');
  assert.equal(r.event_starts_at, '2026-10-05T09:00:00.000+00:00', 'ISO, the same offset form the v4 API uses');
  assert.equal(r.event_ends_at, '2026-10-19T09:00:00.000+00:00');
  assert.equal(r.display_order, '2');
  assert.equal(r.metric_target, '3', 'NUMERIC(20,4) "3.0000" is the 3 the admin typed');
  assert.equal(r.rule_points, '250', 'and "250.00" is 250');
  assert.equal(r.reward_override, '', 'null is an empty field');
  assert.equal(r.schedule_start, '');
  assert.equal(r.rule_target, '', 'a rule with no target of its own');
  assert.equal(r.rule_interval_minutes, '10');
  assert.equal(r.cta_link, '/#discover');
  assert.ok(!('sort_group' in r), 'the sort keys are never written');
});

test('commas, quotes and line breaks are quoted per RFC 4180 and read back intact', () => {
  const tricky = challengeRow({
    title: 'Build, ship, repeat',
    task: 'Say "hello"\nthen say it again\r\nand once more',
    template_reward: 'Up to 2,000 pts',
    rule_name: 'Line\rbreak',
  });
  const csv = buildProgrammeCsv([tricky]);
  assert.ok(csv.includes(',"Build, ship, repeat",'), 'a comma forces quotes');
  assert.ok(csv.includes(',"Say ""hello""\nthen say it again\r\nand once more",'),
    'quotes are doubled and the line breaks stay inside the quotes');
  const [header, rec, ...rest] = parseCsv(csv.slice(1));
  assert.equal(rest.length, 0, 'the embedded newlines did not split the record');
  const r = Object.fromEntries(header.map((h, i) => [h, rec[i]]));
  assert.equal(r.title, 'Build, ship, repeat');
  assert.equal(r.task, 'Say "hello"\nthen say it again\r\nand once more');
  assert.equal(r.template_reward, 'Up to 2,000 pts');
  assert.equal(r.rule_name, 'Line\rbreak', 'a lone CR is quoted as well');
});

test('admin-typed text that a spreadsheet would run as a formula is neutralised', () => {
  const hostile = challengeRow({
    season: '=HYPERLINK("http://evil.example","x")',
    event: '+1+1',
    category: '-2+3',
    title: '@SUM(A1:A9)',
    task: '=cmd|\' /C calc\'!A0',
    template_reward: '-50 pts',
    cta_label: 'Open = later',
    cta_link: '=IMPORTXML("http://evil.example")',
    metric_type: '@type',
    rule_name: '+rule',
  });
  const [header, rec] = parseCsv(buildProgrammeCsv([hostile]).slice(1));
  const r = Object.fromEntries(header.map((h, i) => [h, rec[i]]));
  assert.equal(r.season, '\'=HYPERLINK("http://evil.example","x")');
  assert.equal(r.event, '\'+1+1');
  assert.equal(r.category, '\'-2+3');
  assert.equal(r.title, '\'@SUM(A1:A9)');
  assert.equal(r.task, '\'=cmd|\' /C calc\'!A0');
  assert.equal(r.template_reward, '\'-50 pts');
  assert.equal(r.cta_link, '\'=IMPORTXML("http://evil.example")');
  assert.equal(r.metric_type, '\'@type');
  assert.equal(r.rule_name, '\'+rule');
  assert.equal(r.cta_label, 'Open = later', 'only a LEADING trigger character is touched');
});

test('numbers stay numbers — a negative value is not mistaken for a formula', () => {
  const neg = challengeRow({ rule_points: '-25.50', metric_target: '-1.0000', display_order: -3 });
  const [header, rec] = parseCsv(buildProgrammeCsv([neg]).slice(1));
  const r = Object.fromEntries(header.map((h, i) => [h, rec[i]]));
  assert.equal(r.rule_points, '-25.5');
  assert.equal(r.metric_target, '-1');
  assert.equal(r.display_order, '-3');
  // A numeric column only skips the guard for a value that IS a plain
  // decimal; anything else is text and gets the full treatment.
  const odd = challengeRow({ metric_target: '=1+1', rule_points: '-1+1' });
  const [, rec2] = parseCsv(buildProgrammeCsv([odd]).slice(1));
  const r2 = Object.fromEntries(header.map((h, i) => [h, rec2[i]]));
  assert.equal(r2.metric_target, '\'=1+1');
  assert.equal(r2.rule_points, '\'-1+1');
});

test('a challenge with two rules is two records; unused templates follow the challenges', () => {
  // The query already returns one row per (challenge, rule) in file order;
  // the writer keeps every one of them, in that order.
  const rows = [
    challengeRow({ rule_id: '41', rule_bound_to: 'challenge' }),
    challengeRow({ rule_id: '42', rule_name: 'Template rule', rule_bound_to: 'template' }),
    challengeRow({ challenge_id: '102', rule_id: null, rule_name: null, rule_measure: null,
      rule_bound_to: null, rule_points: null, rule_enabled: null, rule_interval_minutes: null }),
    unusedRow(),
  ];
  const [header, ...recs] = parseCsv(buildProgrammeCsv(rows).slice(1));
  const objs = recs.map((rec) => Object.fromEntries(header.map((h, i) => [h, rec[i]])));
  assert.deepEqual(objs.map((o) => [o.row_kind, o.challenge_id, o.rule_id, o.rule_bound_to]), [
    ['challenge', '101', '41', 'challenge'],
    ['challenge', '101', '42', 'template'],
    ['challenge', '102', '', ''],
    ['unused_template', '', '', ''],
  ]);
  const unused = objs[3];
  assert.equal(unused.template_id, '9');
  assert.equal(unused.template_reward, '1,000 pts');
  assert.equal(unused.season, '');
  assert.equal(unused.enabled, '', 'a template has no enabled flag of its own');
});

test('the SQL keeps the order and the bindings the file promises', () => {
  const sql = PROGRAMME_EXPORT_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /ORDER BY sort_group ASC, sort_season ASC NULLS LAST, sort_starts ASC NULLS LAST, sort_event ASC NULLS LAST, sort_category ASC, sort_order ASC NULLS LAST, sort_id ASC, sort_binding ASC, sort_rule ASC NULLS LAST/);
  assert.match(sql, /UPPER\(TRIM\(ct\.category\)\) AS sort_category/);
  assert.match(sql, /ON r\.challenge_id = c\.id OR r\.challenge_template_id = c\.challenge_template_id/,
    'both bindings, the same join the scorer pays by');
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM challenges c WHERE c\.challenge_template_id = ct\.id\)/);
  assert.doesNotMatch(sql, /internal\s*=\s*FALSE/i, 'internal events are exported, not filtered out');
});

test('the file is named for the day it was taken', () => {
  assert.equal(programmeCsvFilename(new Date('2026-10-01T23:59:00Z')), 'programme-2026-10-01.csv');
});

// ── The route and its gate ─────────────────────────────────────────────

function userMiddleware(role) {
  return (req, _res, next) => {
    if (role === 'user') req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false };
    if (role === 'readonly') req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false };
    if (role === 'admin') req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

async function get(role, url = ROUTE) {
  const app = express();
  app.use(userMiddleware(role));
  app.use(topochainAdminRoutes({}));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf, text: buf.toString('utf8') };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a full admin downloads the file with CSV headers and a dated attachment name', async () => {
  poolRows = [challengeRow(), unusedRow()];
  poolQueries = [];
  const { res, buf, text } = await get('admin');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(res.headers.get('content-disposition'),
    /^attachment; filename="programme-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'the BOM is UTF-8 encoded on the wire');
  assert.equal(text, buildProgrammeCsv(poolRows), 'the body is exactly the built file');
  assert.equal(poolQueries.length, 1, 'one statement, one snapshot');
  assert.equal(poolQueries[0].sql, PROGRAMME_EXPORT_SQL);
});

test('a view-only admin may download it: it is a read, behind the read gate only', async () => {
  poolRows = [challengeRow()];
  const { res, text } = await get('readonly');
  assert.equal(res.status, 200);
  assert.ok(text.includes('Try 3 apps'));
});

test('a non-admin and a signed-out caller get the v4 403, and no query runs', async () => {
  for (const role of ['user', 'anon']) {
    poolQueries = [];
    const { res, text } = await get(role);
    assert.equal(res.status, 403, role);
    assert.deepEqual(JSON.parse(text), { success: false, error: 'Unauthorized. Admin access required.' });
    assert.equal(poolQueries.length, 0, `${role}: the gate stops it before the database`);
  }
  // Express matches case-insensitively, so the gate has to as well. (The
  // platform middleware answers a non-/api/ spelling with its redirect home,
  // which is why this is not the JSON 403 — what matters is that it is not
  // the file.)
  poolQueries = [];
  const { res } = await get('user', ROUTE.toUpperCase());
  assert.notEqual(res.status, 200, 'a case-variant spelling is gated too');
  assert.equal(poolQueries.length, 0, 'and never reaches the database');
});

test('a database failure is the v4 500 envelope, not a half-written file', async () => {
  const prev = poolMod.getPool;
  poolMod.getPool = () => ({ async query() { throw new Error('boom'); } });
  try {
    // The router captured the pool at construction, so build a fresh one.
    delete require.cache[require.resolve('../src/routes/topochain/admin/programme-export')];
    const { programmeExportAdminRoutes } = require('../src/routes/topochain/admin/programme-export');
    const app = express();
    app.use(userMiddleware('admin'));
    app.use(programmeExportAdminRoutes({}));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${ROUTE}`);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { success: false, error: 'Internal server error.' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    poolMod.getPool = prev;
  }
});

// ── The control on both screens ────────────────────────────────────────

const UI = 'frontend/src/features/admin/topochain/ui.tsx';
const SCREENS = [
  ['frontend/src/features/admin/topochain/season-events.tsx', 'SeasonEventsScreen', 'admin-topo-se-export'],
  ['frontend/src/features/admin/topochain/challenge-templates.tsx', 'ChallengeTemplatesScreen', 'admin-topo-tpl-export'],
];

// The screens read AdminTopochain off window for canWrite() and the router
// state; the console is not loaded under the static renderer.
function renderScreen(entry, name, canWrite) {
  const mod = loadTsx(entry);
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { AdminTopochain: { canWrite: () => canWrite, _se: {} } };
  try {
    return renderToHtml(createElement(mod[name]));
  } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

test('both screens offer Download CSV, to a view-only admin as well', () => {
  for (const [entry, name, id] of SCREENS) {
    for (const canWrite of [true, false]) {
      const html = renderScreen(entry, name, canWrite);
      const link = new RegExp(`<a id="${id}" href="${ROUTE.replace(/\./g, '\\.')}" download="" class="[^"]+" title="[^"]+">Download CSV</a>`);
      assert.match(html, link, `${name} (canWrite ${canWrite}) renders the download link`);
    }
  }
});

test('the link is a fixed literal to the route the server mounts — never a URL from data', () => {
  const ui = fs.readFileSync(path.join(ROOT, UI), 'utf8');
  assert.match(ui, /href="\/api\/v4\/admin\/programme\/export\.csv"\n\s*download\n/,
    'a string literal href with the download attribute');
  const fn = ui.slice(ui.indexOf('export function ProgrammeCsvLink'));
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}\n')), /href=\{/, 'not a computed href');
  assert.match(ui, /className=\{BTN\.secondarySm\}\n\s*title="Every challenge/,
    'drawn with the console\'s own toolbar button token');
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/topochain/admin/programme-export.js'), 'utf8');
  assert.ok(route.includes(`router.get('${ROUTE}', async`), 'the server answers that exact path');
  for (const [entry, , id] of SCREENS) {
    const src = fs.readFileSync(path.join(ROOT, entry), 'utf8');
    assert.ok(src.includes(`<ProgrammeCsvLink id="${id}" />`), `${entry} uses the shared control`);
  }
});
