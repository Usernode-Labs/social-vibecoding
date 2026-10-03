'use strict';

// #3624: joining the Homeroom bot's DM yourself, from Settings -> Experimental.
//
// The DM list (`homeroom_bot_dm_users`) was an admin's alone. The switch puts
// the person on that same list, or takes them off it, so everything the list
// already decides (who the bot talks to, whose projects are live, whose
// requests count against the weekly allowance) follows without a second
// source of truth. Four layers:
//   1. setDmMember against a stand-in platform_settings row: the person's
//      own name only, the cap, and a write that never loses somebody else's.
//   2. POST /api/me/homeroom-bot-dm against a stubbed pool.
//   3. /api/auth/me reports the result as `homeroomBotDm`.
//   4. The switch in Settings, and the DM's answer to somebody not on the
//      list, which says where the switch is.
//
// Run with: node --test tests/homeroom-bot-dm-optin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const KEY = 'homeroom_bot_dm_users';

// One platform_settings row, with the compare-and-swap UPDATE honoured the
// way Postgres would. `interleave` runs before an UPDATE is checked: that is
// another writer (an admin saving the list, somebody else joining) landing
// between this write's read and its own.
function settingsRow(value = '[]', { interleave = null } = {}) {
  const row = { value, updates: 0, interleave, queries: [] };
  row.query = async (sql, params = []) => {
    row.queries.push({ sql, params });
    if (/INSERT INTO platform_settings \(key, value\) VALUES \(\$1, '\[\]'\) ON CONFLICT \(key\) DO NOTHING/.test(sql)) {
      if (row.value == null) row.value = '[]';
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT value FROM platform_settings WHERE key = \$1/.test(sql)) {
      // /api/auth/me reads other settings the same way; they are not here.
      if (params[0] !== KEY) return { rows: [] };
      return { rows: row.value == null ? [] : [{ value: row.value }] };
    }
    if (/SELECT key, value FROM platform_settings WHERE key = ANY/.test(sql)) {
      return { rows: row.value == null ? [] : [{ key: KEY, value: row.value }] };
    }
    if (/UPDATE platform_settings SET value = \$2/.test(sql)) {
      assert.equal(params[0], KEY);
      if (row.interleave) row.interleave(row);
      if (params[3] !== row.value) return { rows: [], rowCount: 0 };
      row.value = params[1];
      row.updates += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return row;
}

// Stub the pool BEFORE requiring the routes, as the session-bridge test does.
const poolMod = require('../src/db/pool');
let row = settingsRow();
poolMod.getPool = () => ({ query: (sql, params) => row.query(sql, params) });

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const { authRoutes } = require('../src/routes/auth');

// ── 1. The list write ───────────────────────────────────────────────────

test('joining adds the lower-cased name and keeps everybody else', async () => {
  const r = settingsRow('["ada"]');
  assert.deepEqual(await bot.setDmMember(r, '@Evan', true, 7), { ok: true, joined: true, changed: true });
  assert.deepEqual(JSON.parse(r.value), ['ada', 'evan']);
  const write = r.queries.find((q) => /UPDATE platform_settings/.test(q.sql));
  assert.equal(write.params[2], 7, 'who wrote it is recorded, as an admin save is');
  assert.equal(write.params[3], '["ada"]', 'the write is conditional on the list it read');
});

test('asking for what is already so writes nothing and is not an error', async () => {
  const on = settingsRow('["evan"]');
  assert.deepEqual(await bot.setDmMember(on, 'evan', true), { ok: true, joined: true, changed: false });
  assert.equal(on.updates, 0);
  const off = settingsRow('["ada"]');
  assert.deepEqual(await bot.setDmMember(off, 'evan', false), { ok: true, joined: false, changed: false });
  assert.equal(off.updates, 0);
});

test('leaving takes off that person only', async () => {
  const r = settingsRow('["ada","evan","sam"]');
  assert.deepEqual(await bot.setDmMember(r, 'Evan', false), { ok: true, joined: false, changed: true });
  assert.deepEqual(JSON.parse(r.value), ['ada', 'sam']);
});

test('a full list refuses a join, and still lets anybody on it leave', async () => {
  const full = JSON.stringify(Array.from({ length: bot.MAX_DM_USERS }, (_, i) => `u${i}`));
  const r = settingsRow(full);
  assert.deepEqual(await bot.setDmMember(r, 'evan', true), { ok: false, error: 'full', max: bot.MAX_DM_USERS });
  assert.equal(r.value, full, 'nothing written');
  assert.deepEqual(await bot.setDmMember(r, 'u3', true), { ok: true, joined: true, changed: false },
    'somebody already on a full list is not refused');
  assert.equal((await bot.setDmMember(r, 'u3', false)).changed, true);
  assert.equal(JSON.parse(r.value).length, bot.MAX_DM_USERS - 1);
});

test('a write that lands between the read and the UPDATE is kept, not overwritten', async () => {
  let once = true;
  const r = settingsRow('["ada"]', {
    interleave: (row) => {
      if (!once) return;
      once = false;
      row.value = '["ada","sam"]';
    },
  });
  assert.equal((await bot.setDmMember(r, 'evan', true)).ok, true);
  assert.deepEqual(JSON.parse(r.value), ['ada', 'sam', 'evan'], 'sam, who joined meanwhile, is still there');
});

test('a list that keeps changing underneath it gives up rather than spinning', async () => {
  let n = 0;
  const r = settingsRow('[]', { interleave: (row) => { row.value = JSON.stringify([`x${n++}`]); } });
  assert.deepEqual(await bot.setDmMember(r, 'evan', true), { ok: false, error: 'busy' });
  assert.ok(!JSON.parse(r.value).includes('evan'));
});

test('a row that is not there yet is created first; a name the list cannot hold is refused before any query', async () => {
  const r = settingsRow(null);
  assert.equal((await bot.setDmMember(r, 'evan', true)).ok, true);
  assert.deepEqual(JSON.parse(r.value), ['evan']);
  const bad = settingsRow('[]');
  assert.deepEqual(await bot.setDmMember(bad, 'no spaces', true), { ok: false, error: 'invalid_username' });
  assert.equal(bad.queries.length, 0);
});

// ── 2. The route ────────────────────────────────────────────────────────

let server, base;
let user = null;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(authRoutes({ jwtSecret: 'test-secret' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  if (!server) return;
  // closeAllConnections first: undici keeps the sockets alive and a bare
  // close() would wait for them and hang the runner.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
});
test.beforeEach(() => {
  row = settingsRow('["ada"]');
  user = { id: 42, username: 'Tester', isAdmin: false, appQuota: 0, locale: null };
});

const post = (body, headers = {}) => fetch(`${base}/api/me/homeroom-bot-dm`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('401 when not authenticated, and the list is untouched', async () => {
  user = null;
  const r = await post({ enabled: true });
  assert.equal(r.status, 401);
  assert.equal(row.value, '["ada"]');
});

test('a non-boolean is a 400 that never reaches the list', async () => {
  for (const body of [{ enabled: 'true' }, { enabled: 1 }, { enabled: null }, {}]) {
    const r = await post(body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} must be refused`);
  }
  assert.equal(row.updates, 0);
});

test('joining and leaving write the signed-in person, never a name from the body', async () => {
  let r = await post({ enabled: true, username: 'ada2' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, enabled: true });
  assert.deepEqual(JSON.parse(row.value), ['ada', 'tester']);
  r = await post({ enabled: false, username: 'ada' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(row.value), ['ada'], 'ada stays: only the caller left');
});

test('a full list is a 409 that says so', async () => {
  row = settingsRow(JSON.stringify(Array.from({ length: bot.MAX_DM_USERS }, (_, i) => `u${i}`)));
  const r = await post({ enabled: true });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, new RegExp(`as many people as it can \\(${bot.MAX_DM_USERS}\\)`));
});

test('another site cannot sign a visitor up: the write is same-origin only', async () => {
  const r = await post({ enabled: true }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 403);
  assert.equal(row.updates, 0);
  assert.match(read('src/routes/auth.js'),
    /router\.post\('\/api\/me\/homeroom-bot-dm', sameOriginBrowserOnly, async/);
});

// ── 3. The round trip ───────────────────────────────────────────────────

test('/api/auth/me reports whether the person is on the list', async () => {
  const me = async () => (await (await fetch(`${base}/api/auth/me`)).json()).user || {};
  assert.equal((await me()).homeroomBotDm, false, 'off until they join');
  assert.equal((await post({ enabled: true })).status, 200);
  assert.equal((await me()).homeroomBotDm, true, 'on once they have');
  assert.equal(await dm.isEnabledFor(row, user), true, 'and the bot itself agrees');
});

// ── 4. The switch, and what the bot says to somebody not on the list ────

test('Settings -> Experimental has the switch, wired to the route, with a revert on failure', () => {
  const section = read('frontend/src/features/settings/sections/experimental.tsx');
  assert.match(section, /<SwitchRow id="homeroom-bot-dm-enabled">/, 'the switch');
  assert.match(section, /<StatusLine id="homeroom-bot-dm-status"/, 'and somewhere to say a join was refused');
  assert.match(section, /The platform pays for its work for you, up to a weekly limit\./,
    'it says who pays, and that there is a limit');

  const settings = read('frontend/src/features/settings/settings.js');
  assert.match(settings, /this\.state\.homeroomBotDm = !!j\.user\?\.homeroomBotDm;/, 'painted from /api/auth/me');
  assert.match(settings, /_saveHomeroomBotDm\(e\.target\.checked\)/, 'saved on change, not on close');
  const save = settings.match(/async _saveHomeroomBotDm\([\s\S]*?\n    \},/);
  assert.ok(save, '_saveHomeroomBotDm must exist');
  assert.match(save[0], /'\/api\/me\/homeroom-bot-dm'/, 'POSTs to the route');
  assert.match(save[0], /toggle\.checked = !!this\.state\.homeroomBotDm/,
    'a refused join puts the switch back rather than leaving it lying');
  assert.match(save[0], /return fail\(j\.error \|\| 'Failed to save\.'\)/, 'and shows the server\'s reason');
  // The create dialog asks for a project description from App.user, so the
  // live object has to move with the switch in this same page load.
  assert.match(save[0], /App\.user\.homeroomBotDm = !!enabled/);
  const render = settings.match(/_renderExperimentalSection\(\) \{[\s\S]*?\n    \},/);
  assert.match(render[0], /getElementById\('homeroom-bot-dm-enabled'\)/, 'every paint shows the stored value');

  const facade = read('frontend/src/features/settings/facade.js');
  assert.match(facade, /homeroomBotDm: false,/, 'the facade\'s state has the same default');
  assert.match(facade, /state\.homeroomBotDm = !!u\.homeroomBotDm;/);
});

test('the pane renders the switch inside its label, with its status line shipping hidden', () => {
  // Executed rather than grepped: settings.js binds the switch by id, and
  // the shell's SwitchRow is what makes the whole caption a tap target.
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { ExperimentalSection } = loadTsx('frontend/src/features/settings/sections/experimental.tsx', {
    stubs: { '../local-agents-list': { LocalAgentsList: () => null } },
  });
  const html = renderToHtml(createElement(ExperimentalSection));
  assert.match(html,
    /<label[^>]*><input id="homeroom-bot-dm-enabled" type="checkbox" class="un-switch"\/><span[^>]*>Homeroom bot \(build with it in Messages\)<\/span><\/label>/);
  assert.match(html, /<div id="homeroom-bot-dm-status" class="[^"]*\bhidden\b/);
  assert.ok(html.indexOf('id="session-bridge-status"') < html.indexOf('id="homeroom-bot-dm-enabled"'),
    'after the session bridge, inside the Experimental block');
  assert.ok(html.indexOf('id="homeroom-bot-dm-status"') < html.indexOf('id="settings-local-agents-section"'));
});

test('somebody not on the list is told where to turn it on, plainly', () => {
  assert.match(dm.NOT_ENABLED_TEXT, /turn on Homeroom bot in Settings, under Experimental/);
  assert.doesNotMatch(dm.NOT_ENABLED_TEXT, /—/);
  assert.match(read('frontend/src/features/settings/sections/experimental.tsx'),
    /Homeroom bot \(build with it in Messages\)/, 'and the switch goes by the name the bot gives it');
});
