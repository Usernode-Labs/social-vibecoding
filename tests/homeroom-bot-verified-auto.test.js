'use strict';

// Homeroom bot's automatic switch to "Verified accounts only"
// (services/homeroom-bot-verified-auto.js). Pinned here, with no database:
//   1. the decision: either threshold fires it, the larger overshoot names
//      it, nothing fires while disarmed or already verified, a failed read
//      counts for nothing, the 80% notice is said once and re-armed under 70%;
//   2. the latch: firing disarms in the console's own write (worksFor
//      'verified', so verifiedSince is recorded as a manual switch records
//      it), and an admin's switch back to everyone is not overridden;
//   3. the alerts: full admins are told, never from staging, in tokens the
//      notifications table holds;
//   4. the settings: the three fields' validation, read back, and the
//      connector's lists;
//   5. the figures: one definition for the dashboard and the trigger;
//   6. the admin card: what Save sends, and the lines beside the thresholds.
//
// Run with: node --test tests/homeroom-bot-verified-auto.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const bot = require('../src/services/homeroom-bot');
const auto = require('../src/services/homeroom-bot-verified-auto');
const figuresSvc = require('../src/services/analytics-figures');

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const armed = (over = {}) => ({
  ...bot.parseSettings([{ key: 'homeroom_bot_verified_auto', value: 'on' }]),
  ...over,
});

// ── 1. The decision ──────────────────────────────────────────────────────

test('armed and for everyone: either threshold fires it, at or over', () => {
  const s = armed();
  assert.equal(s.verifiedAuto, true);
  assert.equal(s.worksFor, 'everyone');
  const byUsers = auto.decide(s, { activeUsers: 500, aiSpendCents: 1000 }, null, { now: NOW });
  assert.deepEqual(byUsers.fire, { figure: 'activeUsers', value: 500, threshold: 500, at: new Date(NOW).toISOString() });
  assert.deepEqual(byUsers.events, [{ type: 'fired', figure: 'activeUsers', value: 500, threshold: 500 }]);
  assert.deepEqual(byUsers.state.fired, byUsers.fire, 'when and why it fired is recorded');
  const bySpend = auto.decide(s, { activeUsers: 12, aiSpendCents: 512000 }, null, { now: NOW });
  assert.equal(bySpend.fire.figure, 'aiSpend');
  assert.equal(bySpend.fire.value, 512000);
  assert.equal(bySpend.fire.threshold, 500000);
  const neither = auto.decide(s, { activeUsers: 499, aiSpendCents: 499999 }, null, { now: NOW });
  assert.equal(neither.fire, null);
});

test('both over: the one furthest past its threshold names the firing', () => {
  const d = auto.decide(armed(), { activeUsers: 510, aiSpendCents: 900000 }, null, { now: NOW });
  assert.equal(d.fire.figure, 'aiSpend');
  assert.equal(d.events.length, 1, 'one firing, one alert');
});

test('never while disarmed, and never while the bot already works for verified accounts only', () => {
  const over = { activeUsers: 9000, aiSpendCents: 9_000_000 };
  const off = auto.decide(bot.parseSettings([]), over, null, { now: NOW });
  assert.equal(off.fire, null);
  assert.deepEqual(off.events, []);
  assert.deepEqual(off.state.figures, { ...over, at: new Date(NOW).toISOString() }, 'the figures are still kept for the card');
  const verified = auto.decide(armed({ worksFor: 'verified' }), over, null, { now: NOW });
  assert.equal(verified.fire, null);
  assert.deepEqual(verified.events, []);
});

test('a figure that could not be read counts for nothing; the other still decides', () => {
  assert.equal(auto.decide(armed(), { activeUsers: null, aiSpendCents: null }, null, { now: NOW }).fire, null);
  assert.equal(auto.decide(armed(), { activeUsers: null, aiSpendCents: 600000 }, null, { now: NOW }).fire.figure, 'aiSpend');
});

test('80%: told once per figure, again only after it fell back under 70%; disarming forgets it', () => {
  const s = armed();
  const first = auto.decide(s, { activeUsers: 400, aiSpendCents: 0 }, null, { now: NOW });
  assert.deepEqual(first.events, [{ type: 'near', figure: 'activeUsers', value: 400, threshold: 500 }]);
  const again = auto.decide(s, { activeUsers: 420, aiSpendCents: 0 }, first.state, { now: NOW });
  assert.deepEqual(again.events, [], 'not twice');
  const dip = auto.decide(s, { activeUsers: 360, aiSpendCents: 0 }, again.state, { now: NOW });
  assert.deepEqual(dip.events, []);
  assert.equal(dip.state.near.activeUsers, true, 'between 70% and 80% it stays said');
  const low = auto.decide(s, { activeUsers: 340, aiSpendCents: 0 }, dip.state, { now: NOW });
  assert.equal(low.state.near.activeUsers, undefined, 're-armed under 70%');
  assert.equal(auto.decide(s, { activeUsers: 400, aiSpendCents: 0 }, low.state, { now: NOW }).events.length, 1);
  const off = auto.decide(bot.parseSettings([]), { activeUsers: 400, aiSpendCents: 0 }, first.state, { now: NOW });
  assert.deepEqual(off.state.near, {});
});

// ── 2. The latch, through the console's own write ────────────────────────

// A pool holding platform_settings in a Map, answering the reads and writes
// homeroom-bot.js writeSettings and the sweep make.
function settingsPool(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const queries = [];
  return {
    rows,
    queries,
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      if (/SELECT key, value FROM platform_settings WHERE key = ANY/.test(sql)) {
        return { rows: [...rows].filter(([k]) => params[0].includes(k)).map(([key, value]) => ({ key, value })) };
      }
      if (/SELECT value FROM platform_settings WHERE key = \$1/.test(sql)) {
        return { rows: rows.has(params[0]) ? [{ value: rows.get(params[0]) }] : [] };
      }
      if (/INSERT INTO platform_settings/.test(sql)) {
        if (/DO NOTHING/.test(sql)) { if (!rows.has(params[0])) rows.set(params[0], params[1]); } else rows.set(params[0], params[1]);
        return { rows: [] };
      }
      if (/DELETE FROM platform_settings WHERE key = \$1/.test(sql)) { rows.delete(params[0]); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

function fakeNotifications() {
  const told = [];
  return {
    told,
    deps: () => ({
      async createPlatformIncidentNotifications(_pool, args) { told.push(args); return [{ id: told.length }]; },
      async hydrateAndPush() {},
    }),
  };
}

test('the sweep switches the bot as Save would: verified, verifiedSince recorded, disarmed, admins told', async () => {
  const pool = settingsPool({
    homeroom_bot_verified_auto: 'on',
    homeroom_bot_verified_signals: JSON.stringify(['phone', 'x', 'github']),
  });
  const n = fakeNotifications();
  const out = await auto.sweep(pool, {}, {
    figures: async () => ({ activeUsers: 512, aiSpendCents: 1000 }),
    notifications: n.deps, staging: false, now: () => NOW,
  });
  assert.equal(out.fired.figure, 'activeUsers');
  const s = await bot.readSettings(pool);
  assert.equal(s.worksFor, 'verified');
  assert.equal(s.verifiedAuto, false, 'firing disarms it');
  assert.ok(s.verifiedSince, 'the rule\'s moment is recorded, so earlier members keep the bot');
  assert.deepEqual(s.verifiedSignals, ['phone', 'x', 'github'], 'the signals are left as the admin set them');
  assert.equal(s.verifiedGrandfather, true, 'the grandfathering too');
  const sinceWrite = pool.queries.find((q) => /DO NOTHING/.test(q.sql));
  assert.equal(sinceWrite.params[0], 'homeroom_bot_verified_since', 'through writeSettings\' own once-only write');
  assert.deepEqual(n.told.map((t) => t.detail), ['verify:on:u:512:500']);
  const status = await auto.status(pool);
  assert.equal(status.fired.figure, 'activeUsers');
  assert.equal(status.fired.value, 512);
  assert.equal(status.figures.activeUsers, 512);
});

test('an admin who switches back to everyone afterwards is not overridden, until someone arms it again', async () => {
  const pool = settingsPool({ homeroom_bot_verified_auto: 'on' });
  const n = fakeNotifications();
  const over = { figures: async () => ({ activeUsers: 9000, aiSpendCents: 9_000_000 }), notifications: n.deps, staging: false, now: () => NOW };
  await auto.sweep(pool, {}, over);
  assert.equal((await bot.readSettings(pool)).worksFor, 'verified');
  // The admin switches back by hand.
  assert.equal((await bot.writeSettings(pool, { worksFor: 'everyone' }, 7)).ok, true);
  assert.equal(pool.rows.has('homeroom_bot_verified_since'), false);
  const later = await auto.sweep(pool, {}, over);
  assert.equal(later.fired, null, 'it stays disarmed');
  assert.equal((await bot.readSettings(pool)).worksFor, 'everyone');
  assert.equal(n.told.length, 1, 'and says nothing more');
  // Armed again while a figure is over its threshold: the next sweep fires.
  assert.equal((await bot.writeSettings(pool, { verifiedAuto: true }, 7)).ok, true);
  const rearmed = await auto.sweep(pool, {}, over);
  assert.ok(rearmed.fired);
  assert.equal((await bot.readSettings(pool)).worksFor, 'verified');
});

test('it never switches the bot back to everyone', () => {
  const src = read('src/services/homeroom-bot-verified-auto.js');
  assert.doesNotMatch(src, /worksFor: 'everyone'/);
  assert.match(src, /writeSettings\(pool, \{ worksFor: 'verified', verifiedAuto: false \}, null, config\)/);
});

test('staging switches, but tells nobody; a refused write records nothing', async () => {
  const pool = settingsPool({ homeroom_bot_verified_auto: 'on' });
  const n = fakeNotifications();
  const out = await auto.sweep(pool, {}, {
    figures: async () => ({ activeUsers: 1, aiSpendCents: 600000 }), notifications: n.deps, staging: true, now: () => NOW,
  });
  assert.equal(out.fired.figure, 'aiSpend');
  assert.deepEqual(n.told, []);

  const refused = settingsPool({ homeroom_bot_verified_auto: 'on' });
  const stub = {
    readSettings: (p) => bot.readSettings(p),
    writeSettings: async () => ({ ok: false, error: 'no' }),
  };
  const r = await auto.sweep(refused, {}, {
    bot: stub, figures: async () => ({ activeUsers: 9000, aiSpendCents: 0 }), notifications: n.deps, staging: false, now: () => NOW,
  });
  assert.equal(r.fired, null);
  assert.equal(refused.rows.has(auto.KEY_STATE), false, 'tried again at the next sweep');
  assert.deepEqual(n.told, []);
});

test('the sweep never throws', async () => {
  const out = await auto.sweep({ query: async () => { throw new Error('down'); } }, {}, { figures: async () => ({}) });
  assert.equal(out.fired, null);
});

// ── 3. The alerts ────────────────────────────────────────────────────────

test('alert tokens fit the notifications table at the settings\' ceilings', () => {
  assert.equal(auto.detailToken({ type: 'fired', figure: 'aiSpend', value: 512345, threshold: 500000 }), 'verify:on:s:5123:5000');
  assert.equal(auto.detailToken({ type: 'near', figure: 'activeUsers', value: 410, threshold: 500 }), 'verify:near:u:410:500');
  const longest = auto.detailToken({ type: 'near', figure: 'activeUsers', value: 99_999_999, threshold: 10_000_000 });
  assert.ok(longest.length <= 32, longest);
  const re = /^verify:(on|near):(u|s):(\d{1,8}):(\d{1,8})$/;
  assert.match(longest, re);
  for (const file of ['src/services/mobile-push-policy.js', 'frontend/src/features/notifications/notifications.js']) {
    assert.ok(read(file).includes('/^verify:(on|near):(u|s):(\\d{1,8}):(\\d{1,8})$/'), `${file} reads the same token`);
  }
});

// ── 4. The settings ──────────────────────────────────────────────────────

test('the three fields: validated as the console\'s Save is, and read back', () => {
  const ok = bot.validateSettingsPatch({ verifiedAuto: true, verifiedAutoUsers: 750, verifiedAutoSpendCents: 250000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.updates, [
    ['homeroom_bot_verified_auto', 'on'],
    ['homeroom_bot_verified_auto_users', '750'],
    ['homeroom_bot_verified_auto_spend_cents', '250000'],
  ]);
  for (const bad of [
    { verifiedAuto: 'yes' }, { verifiedAutoUsers: 0 }, { verifiedAutoUsers: 2.5 }, { verifiedAutoUsers: 10_000_001 },
    { verifiedAutoSpendCents: 99 }, { verifiedAutoSpendCents: 1_000_000_001 },
  ]) {
    assert.equal(bot.validateSettingsPatch(bad).ok, false, JSON.stringify(bad));
  }
  const s = bot.parseSettings([
    { key: 'homeroom_bot_verified_auto', value: 'on' },
    { key: 'homeroom_bot_verified_auto_users', value: '750' },
    { key: 'homeroom_bot_verified_auto_spend_cents', value: 'junk' },
  ]);
  assert.deepEqual([s.verifiedAuto, s.verifiedAutoUsers, s.verifiedAutoSpendCents], [true, 750, 500000]);
  const d = bot.parseSettings([]);
  assert.deepEqual([d.verifiedAuto, d.verifiedAutoUsers, d.verifiedAutoSpendCents, d.worksFor], [false, 500, 500000, 'everyone'],
    'off by default, the bot for everyone as before');
});

test('the connector carries the fields with the console\'s ranges, and the record of firing is read-only', () => {
  const data = require('../src/services/bench/connector-data');
  for (const f of ['verifiedAuto', 'verifiedAutoUsers', 'verifiedAutoSpendCents']) assert.ok(data.SETTINGS_FIELDS.includes(f), f);
  assert.ok(!data.SETTINGS_FIELDS.includes('verifiedAutoFired'));
  const tools = read('src/services/mcp-tools.js');
  assert.match(tools, /verifiedAuto: botSwitch,\s*verifiedAutoUsers: z\.number\(\)\.int\(\)\.min\(1\)\.max\(10_000_000\)\.optional\(\),\s*verifiedAutoSpendCents: z\.number\(\)\.int\(\)\.min\(100\)\.max\(1_000_000_000\)\.optional\(\),/);
  const out = data.settingsOf({
    settings: { verifiedAuto: true, verifiedAutoUsers: 500, verifiedAutoSpendCents: 500000 },
    verifiedAuto: { figures: { activeUsers: 12, aiSpendCents: 3400, at: 'x' }, fired: { at: 'y', figure: 'aiSpend', value: 1, threshold: 2 } },
  });
  assert.equal(out.verifiedAuto, true);
  assert.deepEqual(out.verifiedAutoFigures, { activeUsers: 12, aiSpendCents: 3400, at: 'x' });
  assert.deepEqual(out.verifiedAutoFired, { at: 'y', figure: 'aiSpend', value: 1, threshold: 2 });
});

test('the clock runs the sweep every 15 minutes, beside the credit sweep', () => {
  const { JOBS } = require('../src/workflow/clock/services.ts');
  const job = JOBS.find((j) => j.name === 'bot-verified-auto');
  assert.ok(job);
  assert.equal(job.everyMs, 15 * 60 * 1000);
});

// ── 5. The figures ───────────────────────────────────────────────────────

test('one definition: the dashboard\'s MAU and spend chart are the trigger\'s figures', async () => {
  const route = read('src/routes/dashboard.js');
  assert.match(route, /require\('\.\.\/services\/analytics-figures'\)/);
  assert.match(route, /pool\.query\(activeUsersSql\(includeAdmins\)\)/, 'the overview\'s MAU');
  assert.match(route, /pool\.query\(dailySpendSql\(includeAdmins\)\)/, 'the spend chart');
  assert.doesNotMatch(route, /function activityDaysSql/, 'not a second copy');
  // What the platform paid: its key and system tokens, a person's own key left out.
  assert.equal(figuresSvc.platformSpendCents([
    { platform_cents: 100.5, user_key_cents: 9999, system_cents: 20 },
    { platform_cents: 0, user_key_cents: 1, system_cents: 0.25 },
  ]), 120.75);
  const seen = [];
  const pool = {
    async query(sql) {
      seen.push(sql);
      if (/AS mau/.test(sql)) return { rows: [{ wau: 3, mau: 7 }] };
      return { rows: [{ platform_cents: 300, user_key_cents: 50, system_cents: 25 }] };
    },
  };
  assert.deepEqual(await figuresSvc.trailingFigures(pool), { activeUsers: 7, aiSpendCents: 325 });
  assert.deepEqual(seen, [figuresSvc.activeUsersSql(false), figuresSvc.dailySpendSql(false)], 'admins left out, as the dashboard shows by default');
  assert.doesNotMatch(figuresSvc.adminFilter('x', false, 'AND', { keepSynthetic: true }), /is_synthetic/, 'the bot\'s own spend counts');
  const half = await figuresSvc.trailingFigures({ async query(sql) { if (/AS mau/.test(sql)) throw new Error('down'); return { rows: [] }; } });
  assert.deepEqual(half, { activeUsers: null, aiSpendCents: 0 });
});

// ── 6. The admin card ────────────────────────────────────────────────────

test('the card arms the switch and sets its thresholds through Save', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  for (const id of ['admin-homeroom-bot-verified-auto', 'admin-homeroom-bot-verified-auto-on', 'admin-homeroom-bot-verified-auto-users',
    'admin-homeroom-bot-verified-auto-spend', 'admin-homeroom-bot-verified-auto-note']) {
    assert.ok(tsx.includes(`"${id}"`), id);
  }
  const admin = loadTsx('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const saved = admin.savedForm({ settings: { mode: 'shadow' }, bot: null });
  assert.deepEqual([saved.verifiedAuto, saved.verifiedAutoUsers, saved.verifiedAutoSpend], [false, '500', '5000']);
  const form = { ...saved, verifiedAuto: true, verifiedAutoUsers: '800', verifiedAutoSpend: '2500' };
  const dirty = admin.dirtyFields({ verifiedAuto: true, verifiedAutoUsers: '800', verifiedAutoSpend: '2500' }, saved);
  const out = admin.buildPatch(form, saved, dirty);
  assert.deepEqual(out, { patch: { verifiedAuto: true, verifiedAutoUsers: 800, verifiedAutoSpendCents: 250000 }, error: null });
  assert.equal(bot.validateSettingsPatch(out.patch).ok, true, 'what Save sends is what the route takes');
  assert.match(admin.buildPatch({ ...form, verifiedAutoUsers: '0' }, saved, ['verifiedAutoUsers']).error, /People active in the last 30 days/);
  assert.match(admin.buildPatch({ ...form, verifiedSignals: [] }, saved, ['verifiedAuto']).error, /Tick at least one signal/);
});

test('the card shows each figure beside its threshold, and when and why it fired', () => {
  const admin = loadTsx('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.equal(admin.autoFigureLine('activeUsers', 312, 500), 'Now: 312 people (62% of the threshold).');
  assert.equal(admin.autoFigureLine('aiSpend', 123456, 500000), 'Now: $1,235 (24% of the threshold).');
  assert.equal(admin.autoFigureLine('aiSpend', null, 500000), 'Not read yet.');
  assert.match(admin.autoNote({ verifiedAuto: false, worksFor: 'everyone' }, null), /^Off/);
  assert.match(admin.autoNote({ verifiedAuto: true, worksFor: 'everyone' }, null), /already over its threshold, that happens at the next read/);
  assert.match(admin.autoNote({ verifiedAuto: true, worksFor: 'verified' }, null), /nothing to switch/);
  const fired = admin.autoNote({ verifiedAuto: false, worksFor: 'verified' },
    { figures: null, fired: { at: '2026-11-23T12:00:00.000Z', figure: 'aiSpend', value: 512000, threshold: 500000 } });
  assert.match(fired, /^Switched the bot to verified accounts only automatically on .+: AI spend over the last 30 days reached \$5,120, its threshold \$5,000\. Off/);
});
