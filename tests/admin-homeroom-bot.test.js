// #2684: the Homeroom bot's admin dashboard — routes and surface.
//
// The five endpoints under /api/admin/homeroom-bot against a mocked pool:
// the read is open to a view-only admin, the three writes are not; the
// settings route refuses `live` (this slice only triages); the rating and
// "run now" routes validate what they are given. #2726 added the fifth, the
// CSV export: write-gated like a mutation though it only reads, streamed,
// filtered by whatever the table is showing, and quoted against the
// spreadsheet formula trick. Then the surface pins: the section is
// registered in every place the console reads, the module stays inside the
// admin registry's rules, and dapp.json exercises it.
//
// Run with: node --test tests/admin-homeroom-bot.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// ── A stateful mock of what the service reads and writes ────────────────

const settings = new Map([['homeroom_bot_mode', 'off']]);
const writes = [];
// The ledger the runs query reads: one ordinary row, one carrying every
// shape the CSV has to survive (a comma, a quote, a newline, and a leading
// `=` a spreadsheet would otherwise run as a formula).
const runLedger = [
  {
    id: 41, issue_number: 12, verdict: 'question', app_slug: 'todo', app_name: 'Todo',
    repo_url: 'https://github.com/usernode-bot/todo', created_at: '2026-09-21T00:00:00Z',
    mode: 'shadow', determined: false, missing_fact: 'which screen', question: 'Which screen?',
    question_default: 'the board', model: 'z-ai/glm-5.3-flash', cost_usd: 0.01,
  },
  {
    id: 40, issue_number: 11, verdict: 'ready', app_slug: 'todo', app_name: 'Todo',
    repo_url: 'https://github.com/usernode-bot/todo.git', created_at: '2026-09-20T00:00:00Z',
    mode: 'shadow', determined: true, missing_fact: 'none',
    build_note: 'Edit a,b\nthen "c"', rating: 'yes', rated_by: 'admin',
    rating_note: '=SUM(A1)', cost_usd: 0.02,
  },
];
const exportPages = [];
// Every parameter list the runs query is called with, so a filter can be
// checked where it is applied rather than by reading the rows back.
const runsParams = [];
let runRow = { id: 41, rating: null, rating_note: null, rated_at: null };
// Whether the bot's users row exists yet: the dashboard creates it on load
// when it does not, so the cap box is never blank (#2684 follow-up).
let botExists = true;

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params) {
    const s = String(sql);
    if (/SELECT key, value FROM platform_settings/.test(s)) {
      return { rows: [...settings.entries()].map(([key, value]) => ({ key, value })) };
    }
    if (/INSERT INTO platform_settings/.test(s)) { settings.set(params[0], params[1]); writes.push(['setting', params[0], params[1]]); return { rows: [] }; }
    if (/UPDATE users SET weekly_limit_cents/.test(s)) { writes.push(['cap', params[0]]); return { rows: [] }; }
    if (/INSERT INTO users/.test(s)) { botExists = true; writes.push(['bot-user', params[0]]); return { rows: [] }; }
    if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
    if (/FROM users WHERE username = \$1/.test(s)) {
      return { rows: botExists ? [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] : [] };
    }
    if (/COUNT\(\*\)::int AS runs/.test(s)) return { rows: [{ runs: 3, questions: 1, ready: 1, person: 1, failed: 0, rated: 2, agreed: 1, suppressed: 0, cost_usd: 0.12 }] };
    if (/FROM homeroom_bot_queue q JOIN apps/.test(s)) return { rows: [] };
    if (/COUNT\(\*\)::int AS depth/.test(s)) return { rows: [{ depth: 4 }] };
    if (/FROM homeroom_bot_runs r/.test(s)) {
      runsParams.push(params);
      // [app, verdict, cursor, limit] — the export walks the cursor, so the
      // mock answers from a fixture ledger the way Postgres would.
      const [app, verdict, cursor, limit] = params;
      exportPages.push({ app, verdict, cursor, limit });
      const rows = runLedger
        .filter((r) => (!app || r.app_slug === app))
        .filter((r) => (!verdict || r.verdict === verdict))
        .filter((r) => (cursor == null || r.id < cursor))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return { rows };
    }
    if (/SELECT slug, name FROM apps/.test(s)) return { rows: [{ slug: 'todo', name: 'Todo' }] };
    if (/UPDATE homeroom_bot_runs/.test(s)) {
      if (params[0] !== 41) return { rows: [] };
      runRow = { ...runRow, rating: params[1], rating_note: params[3], rated_at: params[1] ? 'now' : null };
      writes.push(['rating', params[0], params[1], params[2]]);
      return { rows: [runRow] };
    }
    if (/SELECT id, slug FROM apps WHERE slug/.test(s)) {
      return { rows: params[0] === 'todo' ? [{ id: 9, slug: 'todo' }] : [] };
    }
    if (/INSERT INTO homeroom_bot_queue/.test(s)) {
      writes.push(['enqueue', params[0], params[1], params[2]]);
      return { rows: [{ id: 5, app_id: params[0], issue_number: params[1], priority: 0, reason: 'admin', enqueued_at: 'now' }] };
    }
    // limits.getWeeklySpentCents / usesIncludedKey and the like: nothing.
    return { rows: [] };
  },
});

const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

const NORMAL = { id: 2, username: 'pat', isAdmin: false, canAdminWrite: false };
const VIEW_ADMIN = { id: 3, username: 'viewer', isAdmin: true, canAdminWrite: false };
const FULL_ADMIN = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };

let server;
let base;
let who = FULL_ADMIN;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use(adminRoutes({ jwtSecret: 'test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const call = (method, url, body) => fetch(`${base}${url}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('GET /api/admin/homeroom-bot: a view-only admin reads the whole dashboard; a non-admin cannot', async () => {
  who = VIEW_ADMIN;
  const res = await call('GET', '/api/admin/homeroom-bot?app=todo&verdict=question');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.settings.mode, 'off');
  assert.deepEqual(data.modes, ['off', 'shadow', 'live']);
  assert.equal(data.bot.username, 'homeroom_bot');
  assert.equal(data.bot.weeklyLimitCents, 15000);
  assert.equal(data.bot.model, 'z-ai/glm-5.3-flash');
  assert.equal(data.totals.runs, 3);
  assert.equal(data.queue.depth, 4);
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].issueUrl, 'https://github.com/usernode-bot/todo/issues/12');
  assert.deepEqual(data.caps, { proposalsPerApp: 2, questionsPerAppPerDay: 10 });

  // adminMiddleware sends a non-admin back to the shell (a redirect, since
  // the mounted router sees a path without the /api prefix).
  who = NORMAL;
  const denied = await fetch(`${base}/api/admin/homeroom-bot`, { redirect: 'manual' });
  assert.ok(denied.status === 302 || denied.status === 403, `non-admin is turned away (${denied.status})`);
  who = FULL_ADMIN;
});

test('GET creates the bot user when it does not exist yet, so the cap is never blank', async () => {
  botExists = false;
  writes.length = 0;
  const res = await call('GET', '/api/admin/homeroom-bot');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(writes.some((w) => w[0] === 'bot-user' && w[1] === 'homeroom_bot'), 'the users row is created on load');
  assert.equal(data.bot.username, 'homeroom_bot');
  assert.equal(data.bot.weeklyLimitCents, 15000);
});

test('PUT settings: refused for a view-only admin, refuses live, accepts shadow and a cap', async () => {
  who = VIEW_ADMIN;
  let res = await call('PUT', '/api/admin/homeroom-bot/settings', { mode: 'shadow' });
  assert.equal(res.status, 403);
  who = FULL_ADMIN;

  res = await call('PUT', '/api/admin/homeroom-bot/settings', { mode: 'live' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /shadow mode/);
  assert.equal(settings.get('homeroom_bot_mode'), 'off', 'a refused patch writes nothing');

  res = await call('PUT', '/api/admin/homeroom-bot/settings', { batchSize: 0 });
  assert.equal(res.status, 400);
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { batchSize: 501 });
  assert.equal(res.status, 400);
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { batchSize: 100 });
  assert.equal(res.status, 200, 'the default is 100 and the ceiling 500');

  // #2737: the per-turn budget is admin-settable and bounded.
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { turnSeconds: 5 });
  assert.equal(res.status, 400, 'a turn budget below the floor is refused');
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { turnInputTokens: 10 });
  assert.equal(res.status, 400, 'so is a token budget below the floor');
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { turnSeconds: 1200, turnInputTokens: 10_000_000 });
  assert.equal(res.status, 200);
  assert.ok(writes.some((w) => w[0] === 'setting' && w[1] === 'homeroom_bot_turn_seconds' && w[2] === '1200'));
  assert.ok(writes.some((w) => w[0] === 'setting' && w[1] === 'homeroom_bot_turn_input_tokens' && w[2] === '10000000'));
  res = await call('PUT', '/api/admin/homeroom-bot/settings', {});
  assert.equal(res.status, 400);

  writes.length = 0;
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { mode: 'shadow', weeklyLimitCents: 20000, pausedApps: ['todo'] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.settings.mode, 'shadow', 'the response is the refreshed dashboard');
  assert.deepEqual(data.settings.pausedApps, ['todo']);
  assert.ok(writes.some((w) => w[0] === 'setting' && w[1] === 'homeroom_bot_mode' && w[2] === 'shadow'));
  assert.ok(writes.some((w) => w[0] === 'cap' && w[1] === 20000), 'the cap lands on the bot users row');
});

test('POST rating: validates, 404s an unknown run, records yes/no and clears', async () => {
  who = VIEW_ADMIN;
  let res = await call('POST', '/api/admin/homeroom-bot/runs/41/rating', { rating: 'yes' });
  assert.equal(res.status, 403);
  who = FULL_ADMIN;

  res = await call('POST', '/api/admin/homeroom-bot/runs/41/rating', { rating: 'maybe' });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/admin/homeroom-bot/runs/abc/rating', { rating: 'yes' });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/admin/homeroom-bot/runs/999/rating', { rating: 'yes' });
  assert.equal(res.status, 404);

  writes.length = 0;
  res = await call('POST', '/api/admin/homeroom-bot/runs/41/rating', { rating: 'no', note: 'asked what the code already says' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).run.rating, 'no');
  assert.deepEqual(writes[0], ['rating', 41, 'no', 1], 'recorded with the rating admin');

  res = await call('POST', '/api/admin/homeroom-bot/runs/41/rating', { rating: null });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).run.rating, null);
});

test('POST run: validates the target, 404s an unknown app, and queues at the head', async () => {
  who = VIEW_ADMIN;
  let res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'todo', issueNumber: 12 });
  assert.equal(res.status, 403);
  who = FULL_ADMIN;

  res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'todo', issueNumber: 0 });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'Nope!', issueNumber: 1 });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'missing', issueNumber: 1 });
  assert.equal(res.status, 404);

  writes.length = 0;
  res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'todo', issueNumber: 12 });
  assert.equal(res.status, 202);
  const data = await res.json();
  assert.equal(data.item.priority, 0);
  assert.deepEqual(writes[0], ['enqueue', 9, 12, 1]);
});

// ── Surface pins ─────────────────────────────────────────────────────────

test('GET: verdict=budget selects the runs the bot stopped itself', async () => {
  who = FULL_ADMIN;
  runsParams.length = 0;
  let res = await call('GET', '/api/admin/homeroom-bot?verdict=budget');
  assert.equal(res.status, 200);
  assert.equal(runsParams.at(-1)[4], true, 'the budget-only flag is set');
  assert.equal(runsParams.at(-1)[1], null, 'and it is not passed off as a verdict');

  res = await call('GET', '/api/admin/homeroom-bot?verdict=failed');
  assert.equal(runsParams.at(-1)[4], false, 'an ordinary verdict leaves it off');
  assert.equal(runsParams.at(-1)[1], 'failed');

  res = await call('GET', '/api/admin/homeroom-bot?verdict=nonsense');
  assert.equal(runsParams.at(-1)[1], null, 'and an unknown one still selects everything');
  assert.equal(runsParams.at(-1)[4], false);
});

test('the CSV filename says when it holds only budget stops', async () => {
  who = FULL_ADMIN;
  const res = await call('GET', '/api/admin/homeroom-bot/export.csv?verdict=budget');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /homeroom-bot-verdicts-all-apps-budget-stops-/);
  assert.ok((await res.text()).split('\n')[0].split(',').includes('budget_stop'),
    'and the column is in the file');
});

test('the write gates are on the three mutations and off the read', () => {
  const admin = read('src/routes/admin.js');
  assert.match(admin, /router\.get\('\/api\/admin\/homeroom-bot', async/);
  assert.match(admin, /router\.put\('\/api\/admin\/homeroom-bot\/settings', requireAdminWrite,/);
  assert.match(admin, /router\.post\('\/api\/admin\/homeroom-bot\/runs\/:id\/rating', requireAdminWrite,/);
  assert.match(admin, /router\.post\('\/api\/admin\/homeroom-bot\/run', requireAdminWrite, drainGuard,/);
  assert.match(admin, /router\.get\('\/api\/admin\/homeroom-bot\/export\.csv', requireAdminWrite,/,
    'the bulk download sits with the mutations, not with the page read');
});

// ── The CSV export (#2726) ────────────────────────

test('GET export.csv: a view-only admin is refused; a full admin gets the whole ledger', async () => {
  who = VIEW_ADMIN;
  let res = await call('GET', '/api/admin/homeroom-bot/export.csv');
  assert.equal(res.status, 403, 'a bulk download is a full-admin artifact');

  who = FULL_ADMIN;
  exportPages.length = 0;
  res = await call('GET', '/api/admin/homeroom-bot/export.csv');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(res.headers.get('content-disposition'),
    /attachment; filename="homeroom-bot-verdicts-all-apps-all-verdicts-\d{4}-\d{2}-\d{2}\.csv"/,
    'the filename says what is in the file and when it was taken');

  const lines = (await res.text()).split('\n');
  const header = lines[0].split(',');
  assert.equal(header[0], 'id');
  assert.ok(header.includes('issue_url'), 'the derived issue link travels with the row');
  assert.ok(header.includes('build_note') && header.includes('rating_note') && header.includes('cost_usd'),
    'the verdict, the rating and the cost are all in the file');
  assert.ok(!header.includes('repo_url'), 'issue_url already carries it');

  // Newest first, the same order as the table.
  assert.match(lines[1], /^41,/);
  assert.match(lines[1], /https:\/\/github\.com\/usernode-bot\/todo\/issues\/12/);
  // The `.git` suffix is trimmed the way the dashboard trims it.
  assert.match(lines[2], /https:\/\/github\.com\/usernode-bot\/todo\/issues\/11/);
  assert.ok(!/todo\.git/.test(lines[2]));
});

test('export.csv quotes what a spreadsheet would otherwise eat', async () => {
  who = FULL_ADMIN;
  const body = await (await call('GET', '/api/admin/homeroom-bot/export.csv')).text();
  assert.ok(body.includes('"Edit a,b\nthen ""c""'),
    'a comma and a newline keep the field quoted, and the inner quote is doubled');
  assert.ok(body.includes("'=SUM(A1)"),
    'a leading = is defused: an admin note must never run as a formula');
  const records = body.split('\n').filter((l) => /^\d+,/.test(l));
  assert.equal(records.length, 2, 'two runs');
  assert.ok(body.split('\n').length > records.length + 2,
    'and the newline inside the quoted field stayed inside it, not a third record');
});

test('export.csv carries the filters the table is showing', async () => {
  who = FULL_ADMIN;
  exportPages.length = 0;
  const res = await call('GET', '/api/admin/homeroom-bot/export.csv?app=todo&verdict=ready');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /homeroom-bot-verdicts-todo-ready-/);
  // Counted by RECORD, not by physical line: a quoted field may hold a
  // newline of its own, which is the point of the quoting.
  const ids = (await res.text()).split('\n')
    .filter((l) => /^\d+,/.test(l))
    .map((l) => l.slice(0, l.indexOf(',')));
  assert.deepEqual(ids, ['40'], 'only the run matching both filters');
  assert.equal(exportPages[0].cursor, null, 'the first page starts at the top');
  assert.equal(exportPages[0].app, 'todo');
  assert.equal(exportPages[0].verdict, 'ready');
});

test('export.csv walks every page: a full chunk is followed by the next cursor', async () => {
  exportPages.length = 0;
  const bot = require('../src/services/homeroom-bot');
  const seen = [];
  // A chunk size of 1 forces the paging this small fixture would not.
  for await (const chunk of bot.iterateRunsForExport(poolMod.getPool(), { chunk: 1 })) {
    seen.push(chunk.map((r) => r.id));
  }
  assert.deepEqual(seen, [[41], [40]], 'one row per page, newest first');
  assert.deepEqual(exportPages.map((p) => p.cursor), [null, 41, 40],
    'each page asks for rows below the last id it saw, so none is skipped or repeated');
});

test('the section is registered everywhere the console reads, inside the registry rules', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  const sectionBlock = consoleJs.slice(consoleJs.indexOf('SECTIONS: ['), consoleJs.indexOf('isOpen()'));
  assert.match(sectionBlock, /\{ key: 'homeroom-bot', label: 'Homeroom bot', group: 'Platform' \}/);
  assert.match(consoleJs, /'homeroom-bot': 'AdminHomeroomBot'/);
  const sections = read('frontend/src/features/admin/sections.ts');
  assert.ok(sections.includes("import './admin-homeroom-bot.tsx';"), 'the barrel imports the module');

  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.ok(!/from '@\/components\/ui\//.test(tsx), 'the console never reaches for the shell primitives');
  assert.match(tsx, /window as any\)\.AdminHomeroomBot = AdminHomeroomBot/);
  assert.match(tsx, /canWrite\(\)/, 'the writes are gated in the UI too');
  assert.ok(!/target="_blank"/.test(tsx), 'nothing in the console opens a new tab');
  assert.match(tsx, /<option value="live" disabled>/, 'live is shown but not offered');

  // #2726. The declared-check manifest is on its 20-slot floor, so the export
  // control is pinned from source here rather than spending a dapp.json slot.
  assert.match(tsx, /id="admin-homeroom-bot-export"/, 'the Verdicts card offers the export');
  assert.match(tsx, /href=\{exportHref\}/, 'a plain link, so the browser receives the stream');
  assert.match(tsx, /\/api\/admin\/homeroom-bot\/export\.csv/);
  assert.match(tsx, /canWrite \? \(\s*<a/, 'and only a full admin sees it');
  assert.ok(!/new Blob\(/.test(tsx), 'the ledger is never assembled in page memory');

  // #2737. The budget is settable from the screen, the fourth verdict is
  // filterable, and a backed-off app says so rather than looking idle.
  assert.match(tsx, /id="admin-homeroom-bot-turn-minutes"/);
  assert.match(tsx, /id="admin-homeroom-bot-turn-tokens"/);
  assert.match(tsx, /id="admin-homeroom-bot-refusals"/);

  // #2742: a budget stop is findable without expanding rows or exporting.
  // The tiles take their id as an argument rather than writing it inline.
  assert.match(tsx, /'admin-homeroom-bot-tile-budget'/, 'a tile counts them');
  assert.match(tsx, /totals\?\.budgetStopped/, 'from its own total, not the failure count');
  assert.match(tsx, /<option value="budget">Stopped on budget<\/option>/, 'the filter finds them');
  assert.match(tsx, /run\.budget_stop \? `Stopped: \$\{run\.budget_stop\}`/, 'and the row says so unexpanded');
  assert.match(tsx, /<option value="empty">Nothing to build<\/option>/);
  assert.match(tsx, /empty: 'Nothing to build'/, 'and the verdict has a label of its own');
});

test('dapp.json exercises the dashboard on ids the module renders', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const ours = dapp.tests.filter((t) => t.path === '/#admin/homeroom-bot');
  assert.ok(ours.length >= 2, 'at least two checks on the section');
  for (const t of ours) {
    const id = (t.expectSelector.match(/#([a-z0-9-]+)/) || [])[1];
    assert.ok(id && tsx.includes(`id="${id}"`), `${t.expectSelector} is rendered by the module`);
  }
});

test('every verdict opens to its own detail, and only a real failure shows the failure line (#3144)', () => {
  // `empty` got a label and a badge but no branch in VerdictBody, so opening
  // one fell through to "The run failed before it produced a verdict." The
  // verdicts are read from VERDICT_LABEL, the table a new verdict has to be
  // added to anyway, so the next one cannot fall through the same way.
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const table = tsx.slice(tsx.indexOf('const VERDICT_LABEL'), tsx.indexOf('};', tsx.indexOf('const VERDICT_LABEL')));
  const verdicts = [...table.matchAll(/^\s+(\w+): '/gm)].map((m) => m[1]);
  assert.ok(verdicts.includes('empty') && verdicts.includes('failed'), 'the table was read');
  const body = tsx.slice(tsx.indexOf('function VerdictBody'), tsx.indexOf('\n}\n', tsx.indexOf('function VerdictBody')));
  for (const verdict of verdicts.filter((v) => v !== 'failed')) {
    assert.match(body, new RegExp(`if \\(run\\.verdict === '${verdict}'\\)`),
      `${verdict} has its own branch rather than falling through to the failure line`);
  }
  const empty = body.slice(body.indexOf("if (run.verdict === 'empty')"));
  assert.match(empty.slice(0, 200), /run\.reason/, 'and an empty verdict shows the reason the bot gave');
});

test('the live list is set from the dashboard, and a proposal the bot opened is one click away (#3146)', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /id="admin-homeroom-bot-live-apps"/);
  // #3152: one row per app, picked from the running apps, and an explicit
  // Save through the same settings route as every other knob.
  assert.match(tsx, /id=\{`admin-homeroom-bot-live-app-\$\{i\}`\}/);
  assert.match(tsx, /id="admin-homeroom-bot-live-apps-add"/);
  assert.match(tsx, /id="admin-homeroom-bot-live-apps-save"/);
  assert.match(tsx, /disabled=\{!liveDirty \|\| !!busy\}/, 'Save is live only when the list differs from what is saved');
  assert.match(tsx, /write\('\/api\/admin\/homeroom-bot\/settings', 'PUT', \{ liveApps: liveChosen \}/);
  // The rows are the SAVED list until someone edits them, so a refresh shows
  // what the bot will act on, and the 30-second poll never wipes an edit.
  assert.match(tsx, /const liveRows = liveDraft \?\? savedLive;/);
  assert.match(tsx, /const savedLive = payload\?\.settings\.liveApps \|\| \[\];/);
  assert.match(tsx, /setLiveDraft\(null\);\s*apply\(data as Payload\);/, 'a successful save goes back to showing the saved list');
  assert.match(tsx, /id="admin-homeroom-bot-live-apps-state"/);
  assert.match(tsx, /id="admin-homeroom-bot-live-apps-note"/);
  assert.match(tsx, /a staging copy never acts/);
  // The link is built from the run's own app slug and session id, never
  // from a URL the API handed over.
  assert.match(tsx, /href=\{`#app\/\$\{encodeURIComponent\(run\.app_slug\)\}\/dev\/proposals\/\$\{Number\(run\.proposal_session_id\)\}`\}/);
  assert.match(tsx, /className=\{AdminUI\.btn\.link\}/);
});

test('the ledger, the dashboard and the filter agree on every verdict, follow-ups included (#3264)', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const table = tsx.slice(tsx.indexOf('const VERDICT_LABEL'), tsx.indexOf('};', tsx.indexOf('const VERDICT_LABEL')));
  const labelled = [...table.matchAll(/^\s+(\w+): '/gm)].map((m) => m[1]).sort();
  const schema = read('src/db/schema.sql');
  const checks = [...schema.matchAll(/CHECK \(verdict IN \(([^)]*)\)\)/g)].map((m) => m[1]);
  assert.equal(checks.length, 2, 'the CREATE TABLE and the widening on boot');
  for (const list of checks) {
    const allowed = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(allowed, labelled, 'a verdict the ledger can hold is one the dashboard can show');
  }
  for (const v of ['answer', 'revise']) {
    assert.match(tsx, new RegExp(`<option value="${v}">`), `${v} can be filtered to`);
  }
  const admin = read('src/routes/admin.js');
  assert.match(admin, /\['question', 'ready', 'person', 'empty', 'failed', 'answer', 'revise'\]\.includes\(q\.verdict\)/);
  assert.match(tsx, /isFollowUp\(run\) \? <span className=\{`\$\{AdminUI\.badge\.outline\} ml-1`\}>follow-up<\/span>/);
});
