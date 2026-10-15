'use strict';

// The Homeroom bot works for everyone, on every project but a paused one.
//
// It was given out one person at a time first: a DM list an admin kept, a
// Settings -> Experimental switch that put you on it, a list of live apps,
// then an admin's switch to everyone and a box for the platform's own
// project. All of that is gone, and this pins that it stays gone:
//   1. the settings carry no list, no audience and no platform switch, and
//      a patch naming them changes nothing;
//   2. who has the bot is who may use the platform, and where it acts for
//      real is every app but a paused one, the platform's own included;
//   3. the Settings switch and its route are gone, and /api/auth/me still
//      reports `homeroomBotDm` from platform access;
//   4. schema.sql retires the rows and the trigger, and writes the moment
//      it went on for everyone once.
//
// Run with: node --test tests/homeroom-bot-for-everyone.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Stub the pool BEFORE requiring the routes, as the session-bridge test does.
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({ query: async () => ({ rows: [], rowCount: 0 }) });

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const live = require('../src/services/homeroom-bot-live');
const { authRoutes } = require('../src/routes/auth');

// ── 1. The settings ─────────────────────────────────────────────────────

test('the settings carry no list, no audience and no platform switch', () => {
  const s = bot.parseSettings([
    { key: 'homeroom_bot_mode', value: 'shadow' },
    { key: 'homeroom_bot_audience', value: 'list' },
    { key: 'homeroom_bot_dm_users', value: '["ada"]' },
    { key: 'homeroom_bot_live_apps', value: '["plant-pal"]' },
    { key: 'homeroom_bot_live_platform', value: 'off' },
    { key: 'homeroom_bot_audience_since', value: '2026-10-10T09:00:00.000Z' },
  ]);
  for (const key of ['audience', 'dmUsers', 'liveApps', 'livePlatform', 'firstVersionApps', 'platformSlugs', 'audienceSince']) {
    assert.equal(Object.hasOwn(s, key), false, `${key} is gone`);
  }
  assert.equal(s.everyoneSince, '2026-10-10T09:00:00.000Z', 'the moment it went on for everyone is kept');
  for (const patch of [{ audience: 'list' }, { livePlatform: false }, { dmUsers: ['ada'] }, { liveApps: ['plant-pal'] }]) {
    assert.deepEqual(bot.validateSettingsPatch(patch), { ok: false, error: 'Nothing to update' }, JSON.stringify(patch));
  }
  for (const name of ['AUDIENCES', 'KEY_AUDIENCE', 'KEY_LIVE_PLATFORM', 'KEY_LIVE_APPS', 'setDmMember', 'MAX_DM_USERS']) {
    assert.equal(bot[name], undefined, `${name} is gone`);
  }
  assert.equal(bot.KEY_EVERYONE_SINCE, 'homeroom_bot_audience_since', 'the key the switch wrote, so its moment stands');
  for (const name of ['isDmUser', 'notEnabledText', 'NOT_ENABLED_EVERYONE_TEXT', 'projectsMadeFor', 'firstVersionAppSlugs']) {
    assert.equal(dm[name], undefined, `${name} is gone`);
  }
});

test('the automatic proposal ceiling is the everyone one', () => {
  assert.equal(bot.botProposalCeiling({}), bot.EVERYONE_PROPOSAL_CEILING);
  assert.equal(bot.botProposalCeiling({ proposalCeiling: 7 }), 7, 'an admin\'s number still wins');
});

test('a database without the moment counts from now, never from no time at all', async () => {
  const before = Date.now();
  const s = await bot.readSettings({ query: async () => ({ rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }] }) });
  assert.ok(Date.parse(s.everyoneSince) >= before);
});

// ── 2. Who has it, and where it acts ─────────────────────────────────────

test('who has the bot is who may use the platform', () => {
  const s = bot.parseSettings([]);
  assert.equal(dm.hasBot(s, { username: 'ada', hasPlatformAccess: true }), true);
  assert.equal(dm.hasBot(s, { username: 'ada', privateMember: true }), true, 'a private member');
  assert.equal(dm.hasBot(s, { username: 'ada', isAdmin: true }), true);
  assert.equal(dm.hasBot(s, { username: 'ada' }), false, 'not let in yet');
  assert.equal(dm.hasBot(s, { username: 'capture', hasPlatformAccess: true, isSynthetic: true }), false, 'never a synthetic account');
  assert.equal(dm.hasBot(null, { username: 'ada', hasPlatformAccess: true }), false);
  assert.match(dm.NOT_ENABLED_TEXT, /as soon as Homeroom lets your account in/);
  assert.doesNotMatch(dm.NOT_ENABLED_TEXT, /Settings|Experimental|switch|—/);
});

test('it acts for real on every app but a paused one, the platform\'s own included', () => {
  const env = process.env.USERNODE_ENV;
  delete process.env.USERNODE_ENV;
  try {
    const on = { mode: 'shadow', pausedApps: ['quiet-app'] };
    assert.deepEqual(live.liveScope(on), { all: true, slugs: [], except: ['quiet-app'] });
    assert.equal(live.isLiveFor(on, { slug: 'usernode-2d5619' }), true, 'Homeroom itself');
    assert.equal(live.isLiveFor(on, { slug: 'plant-pal' }), true);
    assert.equal(live.isLiveFor(on, { slug: 'quiet-app' }), false, 'paused');
    assert.equal(live.scopeIsEmpty(live.liveScope({ mode: 'off' })), true, 'Off is nothing');
    assert.deepEqual(live.appsScope({ mode: 'off', pausedApps: [] }), { all: true, slugs: [], except: [] },
      'what a request is measured against, on or off');
    process.env.USERNODE_ENV = 'staging';
    assert.equal(live.scopeIsEmpty(live.liveScope(on)), true, 'a staging copy never acts');
  } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  }
});

// ── 3. The switch and its route ─────────────────────────────────────────

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

test('the Settings route that joined the list is gone', async () => {
  user = { id: 42, username: 'Tester', isAdmin: false, appQuota: 0, locale: null, hasPlatformAccess: true };
  const r = await fetch(`${base}/api/me/homeroom-bot-dm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(r.status, 404);
  assert.doesNotMatch(read('src/routes/auth.js'), /\/api\/me\/homeroom-bot-dm|setDmMember|homeroomBotForEveryone/);
});

test('/api/auth/me says the bot works for somebody let in, and not for somebody waiting', async () => {
  const me = async () => (await (await fetch(`${base}/api/auth/me`)).json()).user || {};
  user = { id: 42, username: 'Tester', isAdmin: false, appQuota: 0, locale: null, hasPlatformAccess: true };
  const inside = await me();
  assert.equal(inside.homeroomBotDm, true);
  assert.equal(Object.hasOwn(inside, 'homeroomBotForEveryone'), false);
  user = { ...user, hasPlatformAccess: false };
  assert.equal((await me()).homeroomBotDm, false);
});

test('Settings -> Experimental has no Homeroom bot switch, and nothing wires one', () => {
  const pane = read('frontend/src/features/settings/sections/experimental.tsx');
  assert.doesNotMatch(pane, /homeroom-bot-dm-enabled|homeroom-bot-dm-status|build with it in Messages/);
  const settings = read('frontend/src/features/settings/settings.js');
  assert.doesNotMatch(settings, /homeroom-bot-dm|_saveHomeroomBotDm|homeroomBotForEveryone/);
  assert.doesNotMatch(read('frontend/src/features/settings/facade.js'), /homeroomBotForEveryone/);
});

test('the dashboard has no audience card, no DM list and no Shadow choice per app', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.doesNotMatch(tsx, /admin-homeroom-bot-audience|admin-homeroom-bot-live-platform|admin-homeroom-bot-dm-users|DmPeople|homeroom-bot\/people/);
  assert.match(tsx, /const APP_MODES: \{ key: AppMode; label: string \}\[\] = \[\n  \{ key: 'live', label: 'Live' \},\n  \{ key: 'paused', label: 'Paused' \},\n\];/);
  assert.doesNotMatch(read('src/routes/admin.js'), /homeroom-bot\/people/);
});

// ── 4. The schema ───────────────────────────────────────────────────────

test('schema.sql retires the list rows and the rename trigger, and writes the moment once', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /DELETE FROM platform_settings\n WHERE key IN \('homeroom_bot_live_apps', 'homeroom_bot_dm_users', 'homeroom_bot_audience', 'homeroom_bot_live_platform'\);/);
  assert.match(schema, /INSERT INTO platform_settings \(key, value\)\nVALUES \('homeroom_bot_audience_since', to_char\(NOW\(\) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)\)\nON CONFLICT \(key\) DO NOTHING;/);
  assert.match(schema, /DROP TRIGGER IF EXISTS users_carry_homeroom_bot_dm_member ON users;\nDROP FUNCTION IF EXISTS carry_homeroom_bot_dm_member\(\);/);
  assert.doesNotMatch(schema, /\('homeroom_bot_dm_users', '\[\]'\)|\('homeroom_bot_live_apps', '\[\]'\)/, 'never seeded again');
  assert.doesNotMatch(read('src/services/account-deletion.js'), /homeroom_bot_dm_users/);
  assert.doesNotMatch(read('src/services/test-accounts.js'), /homeroom_bot_dm_users|setDmMember|homeroomBotDm/);
});
