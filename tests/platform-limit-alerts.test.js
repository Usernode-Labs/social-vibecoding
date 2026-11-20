'use strict';

// Early warning for the server-wide caps (services/platform-limit-alerts.js).
//
// Three things are pinned here:
//
//   1. decide(), the whole policy, pure: which crossing notifies, which
//      only re-arms, and the margin that stops a count idling at a line
//      from paging every admin on each wobble.
//   2. evaluate(), against a recording pool: the count query is the one the
//      enforcing route runs, the level is read under a row lock and written
//      in the same transaction as the notifications, a preview records the
//      level but notifies nobody, and a second evaluation of the same
//      crossing is silent.
//   3. The wiring: the leader sweeps, the app-create routes nudge, and the
//      three copies of the detail-token format (service, push copy, drawer)
//      cannot drift apart.
//
// Run with: node --test tests/platform-limit-alerts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const limits = require('../src/services/platform-limit-alerts');
const githubBudget = require('../src/services/github-budget');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

// ─── 1. The policy ──────────────────────────────────────────────────────

test('the lines: warn at the percent (rounded up), full at the cap, none when off', () => {
  assert.deepEqual(limits.lines(50, 80), { warn: 40, full: 50 });
  assert.deepEqual(limits.lines(75, 80), { warn: 60, full: 75 });
  assert.deepEqual(limits.lines(7, 80), { warn: 6, full: 7 }, '5.6 rounds up to 6');
  assert.deepEqual(limits.lines(1, 80), { warn: 1, full: 1 });
  assert.equal(limits.lines(0, 80), null, 'MAX_APPS=0 turns the cap off');
  assert.equal(limits.lines(-5, 80), null);
  assert.equal(limits.lines(NaN, 80), null);
  assert.equal(limits.lines(undefined, 80), null);
});

test('a rise notifies the level reached; staying put notifies nothing', () => {
  const d = (used, level) => limits.decide({ used, cap: 50, percent: 80, level });
  assert.deepEqual(d(39, 'ok'), { level: 'ok', notify: null });
  assert.deepEqual(d(40, 'ok'), { level: 'warn', notify: 'warn' });
  assert.deepEqual(d(45, 'warn'), { level: 'warn', notify: null });
  assert.deepEqual(d(50, 'warn'), { level: 'full', notify: 'full' });
  assert.deepEqual(d(50, 'full'), { level: 'full', notify: null });
  assert.deepEqual(d(51, 'full'), { level: 'full', notify: null }, 'admins bypass the cap');
  // A jump straight past the warning line announces only where it landed.
  assert.deepEqual(d(50, 'ok'), { level: 'full', notify: 'full' });
});

test('a fall re-arms only once the count is 10% under the line it crossed', () => {
  const d = (used, level) => limits.decide({ used, cap: 50, percent: 80, level });
  // full re-arms under 45 (0.9 x 50); warn re-arms under 36 (0.9 x 40).
  assert.deepEqual(d(49, 'full'), { level: 'full', notify: null },
    'one app deleted and the next created must not repeat "full"');
  assert.deepEqual(d(45, 'full'), { level: 'full', notify: null });
  assert.deepEqual(d(44, 'full'), { level: 'warn', notify: null });
  assert.deepEqual(d(38, 'full'), { level: 'warn', notify: null });
  assert.deepEqual(d(35, 'full'), { level: 'ok', notify: null });
  assert.deepEqual(d(36, 'warn'), { level: 'warn', notify: null });
  assert.deepEqual(d(35, 'warn'), { level: 'ok', notify: null });
  assert.equal(limits.REARM_RATIO, 0.9);
});

test('a count idling at the line pages once, not on every wobble', () => {
  let level = 'ok';
  const notified = [];
  // 60/75 sessions is the warning line; the count wobbles around it all day.
  for (const used of [59, 60, 59, 60, 61, 58, 60, 59, 60]) {
    const out = limits.decide({ used, cap: 75, percent: 80, level });
    if (out.notify) notified.push(`${used}:${out.notify}`);
    level = out.level;
  }
  assert.deepEqual(notified, ['60:warn']);
  // It re-arms only after a real drop (under 54), and then pages again.
  for (const used of [53, 60]) {
    const out = limits.decide({ used, cap: 75, percent: 80, level });
    if (out.notify) notified.push(`${used}:${out.notify}`);
    level = out.level;
  }
  assert.deepEqual(notified, ['60:warn', '60:warn']);
});

test('raising the cap re-arms; turning it off resets; a lowered cap can jump to full', () => {
  // An admin raised MAX_APPS from 50 to 100 with 50 apps live.
  assert.deepEqual(limits.decide({ used: 50, cap: 100, percent: 80, level: 'full' }),
    { level: 'ok', notify: null });
  assert.deepEqual(limits.decide({ used: 90, cap: 0, percent: 80, level: 'full' }),
    { level: 'ok', notify: null }, 'a disabled cap never pages');
  assert.deepEqual(limits.decide({ used: 30, cap: 25, percent: 80, level: 'ok' }),
    { level: 'full', notify: 'full' });
});

test('percent 100 has no separate warning; an unknown stored level reads as ok', () => {
  assert.deepEqual(limits.decide({ used: 49, cap: 50, percent: 100, level: 'ok' }),
    { level: 'ok', notify: null });
  assert.deepEqual(limits.decide({ used: 50, cap: 50, percent: 100, level: 'ok' }),
    { level: 'full', notify: 'full' });
  assert.deepEqual(limits.decide({ used: 40, cap: 50, percent: 80, level: 'bogus' }),
    { level: 'warn', notify: 'warn' });
  assert.deepEqual(limits.decide({ used: 40, cap: 50, percent: 80, level: null }),
    { level: 'warn', notify: 'warn' });
});

test('PLATFORM_LIMIT_WARN_PERCENT is read at call time and clamped to 1..100', (t) => {
  const prior = process.env.PLATFORM_LIMIT_WARN_PERCENT;
  t.after(() => {
    if (prior === undefined) delete process.env.PLATFORM_LIMIT_WARN_PERCENT;
    else process.env.PLATFORM_LIMIT_WARN_PERCENT = prior;
  });
  delete process.env.PLATFORM_LIMIT_WARN_PERCENT;
  assert.equal(limits.warnPercent(), 80);
  for (const [raw, want] of [['90', 90], ['1', 1], ['100', 100], ['0', 80], ['101', 80], ['abc', 80]]) {
    process.env.PLATFORM_LIMIT_WARN_PERCENT = raw;
    assert.equal(limits.warnPercent(), want, raw);
  }
});

test('the detail token round-trips and fits the 32-character column', () => {
  assert.equal(limits.detailToken('apps', 'warn', 40, 50), 'apps_warn:40:50');
  assert.deepEqual(limits.parseDetail('sessions_full:75:75'),
    { limit: 'sessions', level: 'full', used: 75, cap: 75 });
  const widest = limits.detailToken('sessions', 'full', 123456789, 987654321);
  assert.ok(widest.length <= 32, widest);
  assert.equal(widest, 'sessions_full:9999999:9999999', 'figures clamp to seven digits');
  assert.equal(limits.parseDetail(widest).cap, 9999999);
  for (const bad of ['', 'apps_warn', 'apps_ok:1:2', 'disk_warn:1:2', null, undefined]) {
    assert.equal(limits.parseDetail(bad), null, String(bad));
  }
});

// ─── 2. evaluate() against a recording pool ─────────────────────────────

function fakePool({ apps = 0, sessions = 0, connections = 10, level = 'ok', countError = null, setting = null, windowMs = null, refusalsSince = null } = {}) {
  const state = { level, windowMs, refusalsSince, queries: [], updates: [] };
  return {
    state,
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      state.queries.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM apps WHERE status <> 'error'/.test(sql)) {
        if (countError) throw countError;
        return { rows: [{ n: apps }] };
      }
      if (/FROM chat_sessions/.test(sql)) return { rows: [{ cnt: sessions }] };
      // The connections limit: its line, and the census's count.
      if (/superuser_reserved_connections/.test(sql)) return { rows: [{ cap: 97 }] };
      if (/FROM pg_stat_activity|homeroom_connection_counts/.test(sql)) {
        return { rows: /GROUP BY datname|WHERE datname/.test(sql) ? [] : [{ max: 100, used: connections, idle: 0 }] };
      }
      // services/app-limit.js: the admin's app limit, when one is stored.
      if (/FROM platform_settings s/.test(sql)) {
        return { rows: setting == null ? [] : [{ value: String(setting), updated_at: null, updated_by: 'ada' }] };
      }
      if (/^INSERT INTO platform_limit_alerts/.test(sql)) return { rows: [] };
      if (/^INSERT INTO platform_limit_refusals/.test(sql)) return { rows: [] };
      if (/^SELECT level, \(EXTRACT\(EPOCH FROM window_reset_at\) \* 1000\)::float8 AS window_ms FROM platform_limit_alerts .* FOR UPDATE$/.test(sql)) {
        return { rows: [{ level: state.level, window_ms: state.windowMs }] };
      }
      // #6901: the refusal flush's own reads. No alert row means no open
      // run, so the sweep's refusal pass does nothing here.
      if (/^SELECT refusals_since, refusals_notified_at, NOW\(\) AS now FROM platform_limit_alerts .* FOR UPDATE$/.test(sql)) {
        return { rows: [] };
      }
      if (/^SELECT COUNT\(DISTINCT user_id\)::int AS n FROM platform_limit_refusals/.test(sql)) {
        return { rows: [{ n: 0 }] };
      }
      if (/^UPDATE platform_limit_alerts SET refusals_(since|notified_at)/.test(sql)) return { rows: [] };
      if (/^UPDATE platform_limit_alerts/.test(sql)) {
        state.updates.push(params);
        if (/refusals_since = CASE/.test(sql)) {
          const used = params[2];
          const cap = params[3];
          if (cap == null || used < cap) state.refusalsSince = null;
        }
        state.level = params[1];
        if (params[5] != null) state.windowMs = params[5];
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function recorder() {
  const calls = { create: [], publish: [] };
  return {
    calls,
    deps: {
      staging: false,
      create: async (db, args) => {
        calls.create.push(args);
        return [{ id: 11, user_id: 1 }, { id: 12, user_id: 2 }];
      },
      publish: async (pool, row) => { calls.publish.push(row.id); },
    },
  };
}

const CONFIG = { maxApps: 50, maxGlobalSessions: 75 };

test('a crossing is recorded and announced in one transaction, then published', async () => {
  const pool = fakePool({ apps: 40 });
  const { calls, deps } = recorder();
  const out = await limits.evaluate(pool, CONFIG, 'apps', deps);

  assert.deepEqual(out, {
    key: 'apps', used: 40, cap: 50, level: 'warn', notified: 'warn', recipients: 2,
  });
  assert.deepEqual(calls.create, [{ detail: 'apps_warn:40:50' }]);
  assert.deepEqual(calls.publish, [11, 12], 'each row goes out live after the commit');
  const sqls = pool.state.queries.map((q) => q.sql);
  const begin = sqls.indexOf('BEGIN');
  const lock = sqls.findIndex((s) => /FOR UPDATE$/.test(s));
  const update = sqls.findIndex((s) => /^UPDATE platform_limit_alerts/.test(s));
  const commit = sqls.indexOf('COMMIT');
  assert.ok(begin >= 0 && begin < lock && lock < update && update < commit,
    'the level is read under a row lock and written before the commit');
  assert.deepEqual(pool.state.updates[0], ['apps', 'warn', 40, 50, true, null]);
});

test('the same crossing evaluated again is silent', async () => {
  const pool = fakePool({ apps: 41, level: 'warn' });
  const { calls, deps } = recorder();
  const out = await limits.evaluate(pool, CONFIG, 'apps', deps);
  assert.equal(out.notified, null);
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.publish, []);
  assert.deepEqual(pool.state.updates[0], ['apps', 'warn', 41, 50, false, null],
    'the figures are still refreshed');
});

test('a preview records the level but notifies nobody', async () => {
  const pool = fakePool({ sessions: 75 });
  const { calls, deps } = recorder();
  const out = await limits.evaluate(pool, CONFIG, 'sessions', { ...deps, staging: true });
  assert.equal(out.level, 'full');
  assert.equal(out.recipients, 0);
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.publish, []);
  assert.equal(pool.state.level, 'full');
});

test('each cap counts exactly what its enforcing route counts', async () => {
  const pool = fakePool({ sessions: 10 });
  await limits.evaluate(pool, CONFIG, 'sessions', recorder().deps);
  const count = pool.state.queries.find((q) => /FROM chat_sessions/.test(q.sql)).sql;
  // The one count every start, resume and reopen asks (session-caps.js),
  // not a copy of it.
  assert.equal(count, collapse(require('../src/services/session-caps').GLOBAL_SESSIONS_SQL));
  assert.match(count, /status IN \('active', 'promoted'\)/);
  assert.match(count, /source IS DISTINCT FROM 'imported'/);
  assert.doesNotMatch(count, /is_synthetic/, 'synthetic users\' sessions count');
  assert.match(read('src/services/session-lifecycle.js'), /const \{ countGlobalSessions \} = require\('\.\/session-caps'\);/,
    'the gate the routes pass counts the same way');
  const apps = collapse(read('src/routes/apps.js'));
  assert.ok(apps.includes("SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'"),
    'the apps route still counts the same way');
});

test('the apps cap is the admin\'s setting when one is stored, as the create route enforces', async () => {
  // MAX_APPS says 50, the admin raised it to 80: 45 live apps is nowhere
  // near the line any more, and the alert must agree with the refusal.
  const raised = fakePool({ apps: 45, setting: 80 });
  const out = await limits.evaluate(raised, CONFIG, 'apps', recorder().deps);
  assert.equal(out.cap, 80);
  assert.equal(out.level, 'ok');
  // ...and a lowered one alerts on the lowered line.
  const lowered = fakePool({ apps: 20, setting: 20 });
  const { calls, deps } = recorder();
  const down = await limits.evaluate(lowered, CONFIG, 'apps', deps);
  assert.equal(down.notified, 'full');
  assert.deepEqual(calls.create, [{ detail: 'apps_full:20:20' }]);
});

test('MAX_APPS=0 switches the apps cap off, the admin\'s setting included', async () => {
  const pool = fakePool({ apps: 900, setting: 10 });
  const out = await limits.evaluate(pool, { maxApps: 0 }, 'apps', recorder().deps);
  assert.equal(out.level, 'ok');
  assert.equal(out.cap, 0);
  assert.ok(!pool.state.queries.some((q) => /platform_settings/.test(q.sql)),
    'the setting is not even read when the deploy switched the cap off');
});

test('a cap that is off records ok and pages nobody', async () => {
  const pool = fakePool({ apps: 900, level: 'full' });
  const { calls, deps } = recorder();
  const out = await limits.evaluate(pool, { maxApps: 0 }, 'apps', deps);
  assert.equal(out.level, 'ok');
  assert.deepEqual(calls.create, []);
  assert.deepEqual(pool.state.updates[0], ['apps', 'ok', 900, null, false, null]);
  assert.equal(out.cap, 0);
});

test('the sweep checks every cap and one failure does not stop the others', async () => {
  githubBudget._resetForTests();
  const pool = fakePool({ countError: new Error('db down'), sessions: 60 });
  const { calls, deps } = recorder();
  const out = await limits.sweep(pool, CONFIG, deps);
  assert.deepEqual(out.errors, ['apps: db down']);
  assert.deepEqual(out.results.map((r) => r.key), ['sessions', 'connections', 'github_app']);
  // A process that has not heard from GitHub yet records nothing: "ok"
  // would re-arm a crossing already told (each new leader used to).
  assert.deepEqual(out.results.slice(2).map((r) => [r.level, r.unknown]), [[null, true]],
    'nothing known about GitHub records nothing');
  assert.ok(!pool.state.queries.some((q) => /platform_limit_alerts/.test(q.sql) && /github/.test(JSON.stringify(q.params))),
    'no GitHub level is written');
  assert.deepEqual(calls.create, [{ detail: 'sessions_warn:60:75' }]);
});

// ─── GitHub's hourly budget (services/github-budget.js) ─────────────────

function githubWindow(remaining, { limit = 5000, resetMin = 30, credential = 'installation:a' } = {}) {
  githubBudget.record(credential, {
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + resetMin * 60),
  });
}

test('the App warns at a fifth left and again when used up, once per window', async () => {
  githubBudget._resetForTests();
  const pool = fakePool();
  const { calls, deps } = recorder();
  const run = () => limits.evaluate(pool, CONFIG, 'github_app', deps);

  githubWindow(1001);
  assert.equal((await run()).level, 'ok', '1,001 left is still over a fifth');
  githubWindow(1000);
  const warn = await run();
  assert.deepEqual([warn.used, warn.cap, warn.level, warn.notified], [4000, 5000, 'warn', 'warn']);
  assert.equal((await run()).notified, null, 'the same window does not page twice');
  githubWindow(0);
  const full = await run();
  assert.deepEqual([full.level, full.notified], ['full', 'full']);
  assert.equal((await run()).notified, null);
  assert.deepEqual(calls.create, [{ detail: 'github_app_warn:4000:5000' }, { detail: 'github_app_full:5000:5000' }]);

  // The next hour: a fresh window re-arms both lines, and its own crossing
  // pages again.
  githubWindow(4990, { resetMin: 90 });
  assert.equal((await run()).level, 'ok');
  githubWindow(900, { resetMin: 90 });
  assert.equal((await run()).notified, 'warn');
  assert.equal(calls.create.length, 3);
});

test('a GitHub level is its quota window\'s: it only rises within it, an older window\'s answer is not recorded, a new one decides afresh', async () => {
  // The platform-limits clock runs on whichever process runs the workflow,
  // and each knows GitHub's figures from its own last answer, about the
  // window GitHub named (its reset).
  githubBudget._resetForTests();
  const pool = fakePool();
  const { calls, deps } = recorder();
  const run = () => limits.evaluate(pool, CONFIG, 'github_app', deps);
  githubWindow(900, { resetMin: 30 });
  assert.equal((await run()).notified, 'warn');
  const window = pool.state.windowMs;
  assert.ok(window > Date.now(), 'the level records its window');

  // The same window read lower (another process's older answer in it): held.
  githubWindow(4000, { resetMin: 30 });
  githubBudget.record('installation:a', { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(Math.floor(window / 1000)) });
  assert.equal((await run()).level, 'warn', 'held within its window');

  // Another process recorded a later window; this one's answer is about the
  // window before it: nothing recorded.
  pool.state.windowMs = window + 60 * 60 * 1000;
  const stale = await run();
  assert.equal(stale.stale, true);
  assert.equal(pool.state.level, 'warn');
  pool.state.windowMs = window;

  // The next window, barely used: re-armed, and its own crossing told.
  githubWindow(4990, { resetMin: 90 });
  assert.equal((await run()).level, 'ok');
  githubWindow(900, { resetMin: 90 });
  assert.equal((await run()).notified, 'warn');
  assert.deepEqual(calls.create.map((c) => c.detail), ['github_app_warn:4100:5000', 'github_app_warn:4100:5000']);

  // A new window whose first reading is already used up: told, though the
  // last window ended full too.
  githubWindow(0, { resetMin: 150 });
  assert.equal((await run()).notified, 'full');
  githubWindow(0, { resetMin: 210 });
  assert.equal((await run()).notified, 'full', 'and the next window\'s again');
});

test('the warning line is GitHub\'s own, not PLATFORM_LIMIT_WARN_PERCENT', async (t) => {
  githubBudget._resetForTests();
  const prior = process.env.PLATFORM_LIMIT_WARN_PERCENT;
  t.after(() => {
    if (prior === undefined) delete process.env.PLATFORM_LIMIT_WARN_PERCENT;
    else process.env.PLATFORM_LIMIT_WARN_PERCENT = prior;
  });
  process.env.PLATFORM_LIMIT_WARN_PERCENT = '95';
  githubWindow(1000);
  const out = await limits.evaluate(fakePool(), CONFIG, 'github_app', recorder().deps);
  assert.equal(out.notified, 'warn');
});

test('the App is measured on its most-used installation', async () => {
  githubBudget._resetForTests();
  githubWindow(12000, { limit: 12500, credential: 'installation:a' });
  githubWindow(0, { limit: 12500, credential: 'installation:b' });
  const { calls, deps } = recorder();
  const out = await limits.evaluate(fakePool(), CONFIG, 'github_app', deps);
  assert.deepEqual([out.used, out.cap, out.notified], [12500, 12500, 'full']);
  assert.deepEqual(calls.create, [{ detail: 'github_app_full:12500:12500' }]);
  assert.deepEqual(limits.parseDetail('github_app_full:12500:12500'),
    { limit: 'github_app', level: 'full', used: 12500, cap: 12500 });
  // The bot token's line is gone with the token; what it sent still reads.
  assert.deepEqual(limits.parseDetail('github_warn:4000:5000'),
    { limit: 'github', level: 'warn', used: 4000, cap: 5000 });
  githubBudget._resetForTests();
});

test('the bot token has no line: nothing measures a budget the platform no longer has', async () => {
  assert.equal(limits.LIMITS.some((l) => l.key === 'github' || l.envKey === 'GITHUB_BOT_TOKEN'), false);
  await assert.rejects(limits.evaluate(fakePool(), CONFIG, 'github', {}), /unknown platform limit: github/);
});

test('an unknown cap is refused, and a nudge for a cap that is off does nothing', async () => {
  await assert.rejects(limits.evaluate(fakePool(), CONFIG, 'disk', {}), /unknown platform limit/);
  const pool = fakePool({ apps: 100 });
  limits.nudge(pool, { maxApps: 0 }, 'apps');
  limits.nudge(pool, CONFIG, 'disk');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.state.queries.length, 0, 'route tests mounted with maxApps: 0 never see it');
});

// ─── 2b. Refusals at the app limit (#6901) ──────────────────────────────

// A pool that records refusals the way the table does: one row per account
// per day, one run of refusals, and a clock the test moves.
function refusalPool({ runSince = null, notifiedAt = null, people = [], now = '2026-11-20T12:00:00.000Z', alerts = true, cap = 210 } = {}) {
  const state = {
    refusalsSince: runSince ? new Date(runSince) : null,
    notifiedAt: notifiedAt ? new Date(notifiedAt) : null,
    people: people.map((p) => ({ userId: p.userId, at: new Date(p.at) })),
    now: new Date(now),
    cap,
    inserts: 0,
    queries: [],
  };
  return {
    state,
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      state.queries.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM platform_settings s/.test(sql)) return { rows: [] };
      if (/^INSERT INTO platform_limit_refusals/.test(sql)) {
        // PRIMARY KEY (limit_key, user_id, day): a retry that day inserts
        // nothing, which the fake models as one row per account.
        if (!state.people.some((p) => p.userId === params[1])) {
          state.people.push({ userId: params[1], at: state.now });
          state.inserts += 1;
        }
        return { rows: [] };
      }
      if (/^INSERT INTO platform_limit_alerts/.test(sql)) return { rows: [] };
      if (/^SELECT refusals_since, refusals_notified_at, NOW\(\) AS now FROM platform_limit_alerts .* FOR UPDATE$/.test(sql)) {
        return {
          rows: alerts ? [{
            refusals_since: state.refusalsSince,
            refusals_notified_at: state.notifiedAt,
            now: state.now,
          }] : [],
        };
      }
      if (/^UPDATE platform_limit_alerts SET refusals_since = \$2, refusals_notified_at = \$2/.test(sql)) {
        state.refusalsSince = new Date(params[1]);
        state.notifiedAt = new Date(params[1]);
        return { rows: [] };
      }
      if (/^UPDATE platform_limit_alerts SET refusals_notified_at = \$2/.test(sql)) {
        state.notifiedAt = new Date(params[1]);
        return { rows: [] };
      }
      if (/^SELECT COUNT\(DISTINCT user_id\)::int AS n FROM platform_limit_refusals/.test(sql)) {
        const since = new Date(params[1]);
        const n = new Set(state.people.filter((p) => p.at > since).map((p) => p.userId)).size;
        return { rows: [{ n }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('the case that failed: full, raised above the re-arm line, full again, then a refusal tells the admins', async () => {
  // 13 Nov: 210 of 210, level "full". The cap is raised to 300 with 290 live,
  // which is still over REARM_RATIO x 300 (270), so the level STAYS "full".
  // 20 Nov: it fills again at 300. evaluate() has nothing new to say.
  const state = fakePool({ apps: 300, level: 'full', setting: 300 });
  const quiet = recorder();
  const refill = await limits.evaluate(state, { maxApps: 50 }, 'apps', quiet.deps);
  assert.deepEqual([refill.level, refill.notified], ['full', null],
    'the level was already full, so the crossing path is silent');
  assert.deepEqual(quiet.calls.create, [], 'and that is exactly the bug');

  // A person is refused. The refusal path notifies whatever the level says.
  const pool = refusalPool({ now: '2026-11-20T09:00:00.000Z' });
  const { calls, deps } = recorder();
  const out = await limits.recordRefusal(pool, { maxApps: 300 }, 'apps', 7, deps);
  assert.equal(out.notified, 'apps_away:1:300:0');
  assert.deepEqual(calls.create, [{ detail: 'apps_away:1:300:0', repeatable: true }],
    'the first refusal of a run is told at once');
  assert.deepEqual(calls.publish, [11, 12], 'published after the commit, like a crossing');
  assert.equal(pool.state.refusalsSince.toISOString(), '2026-11-20T09:00:00.000Z');
  assert.equal(pool.state.notifiedAt.toISOString(), '2026-11-20T09:00:00.000Z');
  // It runs inside one transaction, with the alert row locked.
  const sqls = pool.state.queries.map((q) => q.sql);
  const begin = sqls.indexOf('BEGIN');
  const lock = sqls.findIndex((s) => /FOR UPDATE$/.test(s));
  const commit = sqls.indexOf('COMMIT');
  assert.ok(begin >= 0 && begin < lock && lock < commit);
});

test('one person retrying in a day counts once, and no second notice inside the interval', async () => {
  const pool = refusalPool({ now: '2026-11-20T09:00:00.000Z' });
  const { calls, deps } = recorder();
  await limits.recordRefusal(pool, { maxApps: 210 }, 'apps', 7, deps);
  const retry = await limits.recordRefusal(pool, { maxApps: 210 }, 'apps', 7, deps);
  assert.equal(retry.notified, null, 'the same day, inside three hours');
  assert.equal(pool.state.inserts, 1, 'ON CONFLICT leaves one row for the account');
  assert.equal(pool.state.people.length, 1);
  assert.equal(calls.create.length, 1, 'only the first notice');
});

test('after three hours the people refused since then are reported as one count', async () => {
  const pool = refusalPool({ now: '2026-11-20T09:00:00.000Z' });
  const { calls, deps } = recorder();
  await limits.recordRefusal(pool, { maxApps: 210 }, 'apps', 7, deps);
  // Two more people are refused over the next hours; the next notice carries
  // them, and the person already reported is not counted again.
  pool.state.now = new Date('2026-11-20T13:00:00.000Z');
  pool.state.people.push(
    { userId: 8, at: new Date('2026-11-20T10:00:00.000Z') },
    { userId: 9, at: new Date('2026-11-20T11:30:00.000Z') },
  );
  const out = await limits.recordRefusal(pool, { maxApps: 210 }, 'apps', 10, deps);
  assert.equal(out.notified, 'apps_away:3:210:240', 'three people, four hours after the run began');
  assert.equal(out.recipients, 2);
  assert.deepEqual(calls.create.map((c) => c.detail), [
    'apps_away:1:210:0',
    'apps_away:3:210:240',
  ]);
  assert.equal(pool.state.notifiedAt.toISOString(), '2026-11-20T13:00:00.000Z');
});

test('the sweep reports refusals that stopped, once, and does nothing with none pending', async () => {
  const since = '2026-11-20T09:00:00.000Z';
  const pending = refusalPool({
    runSince: since, notifiedAt: since, now: '2026-11-20T10:00:00.000Z',
    people: [{ userId: 7, at: '2026-11-20T09:10:00.000Z' }],
  });
  const early = recorder();
  assert.equal(await limits.sweepRefusals(pending, { maxApps: 210 }, 'apps', early.deps), null,
    'inside the interval nothing goes out');
  assert.deepEqual(early.calls.create, []);

  pending.state.now = new Date('2026-11-20T13:00:00.000Z');
  const { calls, deps } = recorder();
  assert.equal(await limits.sweepRefusals(pending, { maxApps: 210 }, 'apps', deps), 'apps_away:1:210:240');
  assert.deepEqual(calls.create, [{ detail: 'apps_away:1:210:240', repeatable: true }]);

  // Nobody waiting to be reported: the interval passing sends nothing.
  const empty = refusalPool({ runSince: since, notifiedAt: since, now: '2026-11-20T14:00:00.000Z' });
  assert.equal(await limits.sweepRefusals(empty, { maxApps: 210 }, 'apps', recorder().deps), null);

  // No run open at all (the server had room): nothing either.
  const idle = refusalPool({ now: '2026-11-20T14:00:00.000Z' });
  assert.equal(await limits.sweepRefusals(idle, { maxApps: 210 }, 'apps', recorder().deps), null);
});

test('a preview records the refusal and notifies nobody; a cap that is off records nothing', async () => {
  const pool = refusalPool({ now: '2026-11-20T09:00:00.000Z' });
  const { calls, deps } = recorder();
  const out = await limits.recordRefusal(pool, { maxApps: 210 }, 'apps', 7, { ...deps, staging: true });
  assert.equal(out.recipients, 0);
  assert.deepEqual(calls.create, []);
  assert.equal(pool.state.inserts, 1, 'the row is still recorded');

  const off = refusalPool({ now: '2026-11-20T09:00:00.000Z' });
  const offOut = await limits.recordRefusal(off, { maxApps: 0 }, 'apps', 7, deps);
  assert.equal(offOut.notified, null);
  assert.equal(off.state.queries.length, 0, 'no database read when the cap is off');
});

test('evaluate clears the run when the server has room again, so the next refusal tells at once', async () => {
  const pool = fakePool({ apps: 5, level: 'full', refusalsSince: new Date() });
  await limits.evaluate(pool, { maxApps: 50 }, 'apps', recorder().deps);
  const update = pool.state.queries.find((q) => /^UPDATE platform_limit_alerts/.test(q.sql));
  assert.match(update.sql, /refusals_since = CASE WHEN \$4::int IS NULL OR \$3::int < \$4::int THEN NULL EL/,
    'used < cap (or a cap that is off) ends the run');
  assert.equal(pool.state.refusalsSince, null);

  // And a full server keeps it.
  const full = fakePool({ apps: 50, level: 'full', refusalsSince: new Date() });
  await limits.evaluate(full, { maxApps: 50 }, 'apps', recorder().deps);
  assert.ok(full.state.refusalsSince instanceof Date);
});

test('two refusals racing claim one "just" notice: the row lock decides', async () => {
  // The second caller sees refusals_since already set, and the interval not
  // passed, so it only records.
  const pool = refusalPool({ now: '2026-11-20T09:00:00.000Z' });
  const { calls, deps } = recorder();
  await limits.recordRefusal(pool, { maxApps: 210 }, 'apps', 7, deps);
  const other = await limits.recordRefusal(pool, { maxApps: 210 }, 'apps', 8, deps);
  assert.equal(other.notified, null);
  assert.equal(calls.create.length, 1);
});

test('the refusal token round-trips, fits 32 characters, and parses only its own shape', () => {
  assert.equal(limits.refusalToken(3, 210, 180), 'apps_away:3:210:180');
  assert.deepEqual(limits.parseRefusalDetail('apps_away:3:210:180'),
    { people: 3, cap: 210, agoMinutes: 180 });
  assert.deepEqual(limits.parseRefusalDetail('apps_away:1:9999999:9999'),
    { people: 1, cap: 9999999, agoMinutes: 9999 });
  const widest = limits.refusalToken(999999999, 999999999, 999999);
  assert.ok(widest.length <= 32, widest);
  assert.equal(widest, 'apps_away:99999:9999999:9999');
  for (const bad of ['', 'apps_away', 'apps_away:1:2', 'apps_away:1:2:3:4', 'apps_warn:1:2', null, undefined]) {
    assert.equal(limits.parseRefusalDetail(bad), null, String(bad));
  }
  assert.equal(limits.REFUSAL_NOTICE_INTERVAL_MS, 3 * 60 * 60 * 1000);
});

// ─── 3. Wiring ──────────────────────────────────────────────────────────

test('the sweep is a scheduled job of the workflow, not the leader\'s', () => {
  // A clock (src/workflow/clock/services.ts): every five minutes wherever the
  // workflow runs, one run at a time.
  assert.match(read('src/workflow/clock/services.ts'),
    /name: 'platform-limits', everyMs: 5 \* MIN,\n\s*run: \(_ctx: WorkContext, \{ pool, config \}: JobDeps\) => legacy\('services\/platform-limit-alerts'\)\.sweep\(pool, config\),/);
  assert.ok(!read('server.js').includes('startPlatformLimitSweeper'));
});

test('both app-create routes nudge the apps check on success and on refusal, and record both refusals', () => {
  const src = read('src/routes/apps.js');
  const nudges = src.match(/platformLimits\.nudge\(pool, config, 'apps'\);/g) || [];
  assert.equal(nudges.length, 4, 'create 201, create 429, fork 201, fork 429');
  const refusals = src.match(/platformLimits\.noteRefusal\(pool, config, 'apps', req\.user\.id\);/g) || [];
  assert.equal(refusals.length, 2, 'create 429 and fork 429, never a success');
});

test('the refusal format is spelled identically wherever it is parsed', () => {
  const literal = String.raw`/^apps_away:(\d{1,5}):(\d{1,7}):(\d{1,4})$/`;
  for (const rel of [
    'src/services/platform-limit-alerts.js',
    'src/services/mobile-push-policy.js',
    'frontend/src/features/notifications/notifications.js',
  ]) {
    assert.ok(read(rel).includes(literal), `${rel} parses the same token`);
  }
});

// ─── 4. The refusal rows and queries against PostgreSQL ─────────────────
//
// The fake pools above pin the flow; this runs the real SQL against the
// generated schema, in a database of its own. It skips when no database is
// reachable, like the repository's other postgres tests, unless
// TEST_DATABASE_URL insists on one.

test('refusals are recorded once a day and reported, against a real database', { timeout: 120000 }, async (t) => {
  const { Pool } = require('pg');
  const crypto = require('node:crypto');
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `platform_refusals_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [adminUser] } = await pool.query(
    `INSERT INTO users (username, password, is_admin)
     VALUES ('limit_admin', 'x', TRUE) RETURNING id`);
  const { rows: [ada] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id`);
  const { rows: [grace] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('grace', 'x') RETURNING id`);
  const config = { maxApps: 2 };
  const deps = { publish: async () => {} };

  // The server is full: two live apps against a cap of two.
  await pool.query(`INSERT INTO apps (name, slug, status) VALUES ('One', 'one', 'running'), ('Two', 'two', 'running')`);

  // Ada is refused: one "just" notice, in the same transaction.
  const first = await limits.recordRefusal(pool, config, 'apps', ada.id, deps);
  assert.equal(first.notified, 'apps_away:1:2:0');
  let { rows } = await pool.query(
    `SELECT user_id, detail FROM notifications WHERE kind = 'platform_limit' ORDER BY id`);
  assert.deepEqual(rows, [{ user_id: adminUser.id, detail: 'apps_away:1:2:0' }]);
  ({ rows } = await pool.query(
    `SELECT user_id::int FROM platform_limit_refusals WHERE limit_key = 'apps'`));
  assert.deepEqual(rows.map((r) => r.user_id), [ada.id], 'one row for the first refusal');

  // Grace retries? No: Ada retries the same day. No new row, no notice.
  const retry = await limits.recordRefusal(pool, config, 'apps', ada.id, deps);
  assert.equal(retry.notified, null);
  ({ rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM platform_limit_refusals`));
  assert.equal(rows[0].n, 1, 'the primary key counts a retry once');

  // Four hours on (the run began five hours ago, its last notice four),
  // Grace is refused: one count notice for everybody reported since then.
  await pool.query(
    `UPDATE platform_limit_alerts
        SET refusals_since = NOW() - interval '5 hours',
            refusals_notified_at = NOW() - interval '4 hours'
      WHERE limit_key = 'apps'`);
  await pool.query(
    `UPDATE platform_limit_refusals SET refused_at = NOW() - interval '5 hours'
      WHERE user_id = $1`, [ada.id]);
  const second = await limits.recordRefusal(pool, config, 'apps', grace.id, deps);
  assert.match(second.notified, /^apps_away:1:2:24\d$/, 'about four hours after the run was last reported');
  ({ rows } = await pool.query(
    `SELECT detail FROM notifications WHERE kind = 'platform_limit' ORDER BY id`));
  assert.equal(rows.length, 2);
  assert.match(rows[1].detail, /^apps_away:1:2:24\d$/);

  // adminPayload's figures: both people since the run began.
  const summary = await limits.refusalSummary(pool, 'apps');
  assert.equal(summary.turnedAway, 2);
  assert.ok(summary.since && !Number.isNaN(new Date(summary.since).getTime()));

  // The server has room again (a cap of 3 with two apps): evaluate clears
  // the run, so the next refusal tells at once.
  await limits.evaluate(pool, { maxApps: 3 }, 'apps', deps);
  ({ rows } = await pool.query(
    `SELECT refusals_since FROM platform_limit_alerts WHERE limit_key = 'apps'`));
  assert.equal(rows[0].refusals_since, null);
  assert.deepEqual(await limits.refusalSummary(pool, 'apps'), { turnedAway: 0, since: null });
  const again = await limits.recordRefusal(pool, config, 'apps', ada.id, deps);
  assert.match(again.notified, /^apps_away:1:2:0$/, 'a new run starts with a "just" notice');
});

test('the detail format is spelled identically wherever it is parsed', () => {
  const literal = String.raw`/^(apps|sessions|connections|github|github_app)_(warn|full):(\d{1,7}):(\d{1,7})$/`;
  for (const rel of [
    'src/services/platform-limit-alerts.js',
    'src/services/mobile-push-policy.js',
    'frontend/src/features/notifications/notifications.js',
  ]) {
    assert.ok(read(rel).includes(literal), `${rel} parses the same token`);
  }
  assert.deepEqual(limits.LIMITS.map((l) => l.key), ['apps', 'sessions', 'connections', 'github_app'],
    'a new cap must be added to the token pattern in all three places');
});

test('both tunables are declared so the Platform variables panel lists them', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const keys = new Map(manifest.platform_env.map((entry) => [entry.key, entry]));
  assert.equal(keys.get('MAX_APPS')?.default, '50', 'matches src/config.js');
  assert.equal(keys.get('PLATFORM_LIMIT_WARN_PERCENT')?.default, String(limits.DEFAULT_WARN_PERCENT));
  assert.match(read('src/config.js'), /maxApps: parseInt\(process\.env\.MAX_APPS \|\| '50', 10\)/);
});

test('database connections cross like the other limits: one notice per crossing, with the margin', async () => {
  const pool = fakePool({ connections: 80 });
  const { calls, deps } = recorder();
  const warn = await limits.evaluate(pool, CONFIG, 'connections', deps);
  assert.deepEqual([warn.level, warn.used, warn.cap], ['warn', 80, 97], 'the line is max_connections less the reserved blocks');
  assert.deepEqual(calls.create, [{ detail: 'connections_warn:80:97' }]);
  await limits.evaluate(pool, CONFIG, 'connections', deps);
  assert.equal(calls.create.length, 1, 'still near: no second notice');
  const full = await limits.evaluate(fakePool({ connections: 97, level: pool.state.level }), CONFIG, 'connections', deps);
  assert.equal(full.level, 'full');
  assert.deepEqual(calls.create[1], { detail: 'connections_full:97:97' });
  assert.ok('connections_full:9999999:9999999'.length <= 32, 'the widest token fits every creator');
  assert.deepEqual(limits.parseDetail('connections_warn:80:97'), { limit: 'connections', level: 'warn', used: 80, cap: 97 });
});
