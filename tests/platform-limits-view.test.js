'use strict';
// The admin limits area's server half (services/platform-limits-view.js):
// which platform-wide limits get a row, in what state and order, and how a
// level change reaches an open sheet.
//
// Pinned here:
//
//   1. The pure rows: the counted limits use platform-limit-alerts' own
//      lines and margin, so a row comes at 80% and leaves only once the
//      count is back under its line by REARM_RATIO; the credit row's out,
//      low, urgent and could-not-check states; the connections line is
//      max_connections less the reserved blocks; worst first.
//   2. compute() against a pool that answers the real queries: the counts
//      and caps go through platform-limit-alerts.LIMITS (the enforcing
//      routes' own queries), the credit through openrouter-credit.status,
//      the connections through the census. A failed read is a "couldn't
//      check" row, never a thrown read. The answer is held, and a level
//      change drops what is held.
//   3. Nothing but a fix takes a row away: there is no dismiss, and reading
//      again with the same figures keeps every row.
//   4. The wiring: evaluate() and the credit sweep say when a level moved.
//
// Run with: node --test tests/platform-limits-view.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// changed() tells every admin socket through ws.broadcastToAdmins; stand in
// for it before anything requires it.
const wsPath = require.resolve('../src/services/ws');
const broadcasts = [];
require.cache[wsPath] = {
  id: wsPath, filename: wsPath, loaded: true,
  exports: { broadcastToAdmins: (payload) => { broadcasts.push(payload); return 0; } },
};

const view = require('../src/services/platform-limits-view');
const alerts = require('../src/services/platform-limit-alerts');
const credit = require('../src/services/openrouter-credit');

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();
const NOW = Date.parse('2026-11-20T12:00:00Z');

// ─── 1. The pure rows ───────────────────────────────────────────────────

test('a counted limit gets a row at 80%, and at and over read from the live count', () => {
  const row = (used, level = 'ok') => view.countedRow('apps', { used, cap: 300, percent: 80, level });
  assert.equal(row(239), null, 'under the warning line: no row');
  assert.deepEqual(
    { state: row(240).state, left: row(240).left, percent: row(240).percent, warnAt: row(240).warnAt },
    { state: 'near', left: 60, percent: 80, warnAt: 240 },
  );
  assert.equal(row(300).state, 'at');
  assert.equal(row(314, 'full').state, 'over', '214 of 210 on 20 Nov: admins went past it');
  assert.equal(row(314, 'full').percent, 100, 'the meter stops at full');
  assert.equal(view.countedRow('apps', { used: 50, cap: 0, percent: 80, level: 'full' }), null,
    'a limit that is switched off has no row');
});

test('a row leaves only once the count is back under its line by the margin', () => {
  const row = (used, level) => view.countedRow('sessions', { used, cap: 180, percent: 80, level });
  // The warning line is 144; it re-arms under 0.9 x 144 = 129.6.
  assert.equal(row(140, 'warn').state, 'near', 'just under the line, still near: no flicker');
  assert.equal(row(130, 'warn').state, 'near');
  assert.equal(row(129, 'warn'), null, 'back under the margin: the row goes');
  // Full re-arms under 0.9 x 180 = 162: until then it is still a row, said as near.
  assert.equal(row(170, 'full').state, 'near');
  assert.equal(row(161, 'full').state, 'near', 'down from full, still past the warning line');
  assert.equal(alerts.REARM_RATIO, 0.9, 'the same margin the alerts use');
});

test('raising a full limit with the count still near keeps the row, said as near', () => {
  // The 4 Nov case: raised from 50 to 210 with about 200 counted.
  const row = view.countedRow('apps', { used: 200, cap: 210, percent: 80, level: 'full' });
  assert.equal(row.state, 'near');
  assert.equal(row.left, 10);
});

test('the credit row: out, low, urgent, could not check, and nothing to say', () => {
  // openrouter-credit.status(): `creditCents` is the account's credit.
  const at = new Date(NOW - 60_000).toISOString();
  const base = { warnCents: 50000, urgentCents: 20000, daysLeft: 2, at, creditAt: at, creditRead: true, creditSource: 'account', management: true };
  const row = (status) => view.creditRow({ ...base, ...status }, { now: NOW });
  assert.equal(row({ creditCents: 90000 }), null, 'above $500: no row');
  assert.deepEqual(
    (({ state, urgent, balanceCents }) => ({ state, urgent, balanceCents }))(row({ creditCents: 41200 })),
    { state: 'near', urgent: false, balanceCents: 41200 },
  );
  assert.equal(row({ creditCents: 18400 }).urgent, true, 'under $200');
  assert.equal(row({ creditCents: 0 }).state, 'out');
  // What is left of the bot's key is not credit: $1,923 in the account and
  // $500 of the week left is no row at all.
  assert.equal(row({ creditCents: 192386, accountCents: 192386, keyCents: 49996, keyReset: 'weekly' }), null);
  const out = row({ creditCents: 18400, outage: { since: '2026-11-19T14:02:00Z', cause: 'credit' } });
  assert.equal(out.state, 'out', 'a turn that found the credit gone outranks the figure');
  assert.equal(out.since, '2026-11-19T14:02:00Z');
  assert.equal(row({ creditCents: 192386, outage: { since: '2026-11-19T14:02:00Z', cause: 'budget' } }), null,
    'an outage whose cause is the weekly budget is the budget\'s row, not "credit: out"');
  const failed = row({ creditCents: 41200, creditRead: false });
  assert.deepEqual([failed.state, failed.reason, failed.balanceCents], ['unknown', 'no_answer', 41200]);
  const old = new Date(NOW - 2 * 3600_000).toISOString();
  const stale = row({ creditCents: 41200, at: old, creditAt: old });
  assert.deepEqual([stale.state, stale.reason], ['unknown', 'stale']);
  assert.equal(row({ creditCents: null }), null,
    'never read (an unlimited bot key, or an allowance): not a limit anybody can watch');
  assert.equal(row({ creditCents: 41200, creditRead: false, management: false }), null,
    'no management key: the account cannot be read, and no row says so for ever');
});

test('rows run worst first: over, at or out, near, could not check', () => {
  const rows = view.sortRows([
    { key: 'db_connections', state: 'near' },
    { key: 'sessions', state: 'unknown' },
    { key: 'apps', state: 'at' },
    { key: 'openrouter_credit', state: 'out' },
    { key: 'sessions', state: 'over' },
  ]);
  assert.deepEqual(rows.map((r) => `${r.key}:${r.state}`), [
    'sessions:over', 'apps:at', 'openrouter_credit:out', 'db_connections:near', 'sessions:unknown',
  ]);
});

// ─── 2. compute() against the real queries ──────────────────────────────

function fakePool({
  apps = 0, appLimit = null, sessions = 0, levels = {}, creditState = null,
  census = { max: 100, used: 10 }, reserved = { superuser_reserved: 3, reserved: 0 },
  failApps = false, refusals = null,
} = {}) {
  const queries = [];
  return {
    queries,
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      queries.push(sql);
      if (/FROM platform_limit_alerts WHERE limit_key = ANY/.test(sql)) {
        // A level alone, or (the cluster's limits) the whole stored row.
        return { rows: Object.entries(levels).map(([limit_key, v]) => (typeof v === 'string'
          ? { limit_key, level: v } : { limit_key, ...v })) };
      }
      if (/FROM apps WHERE status <> 'error'/.test(sql)) {
        if (failApps) throw new Error('connection terminated');
        return { rows: [{ n: apps }] };
      }
      if (/FROM chat_sessions/.test(sql)) return { rows: [{ cnt: sessions }] };
      if (/FROM platform_settings s/.test(sql)) {
        const key = params[0];
        if (key === 'max_apps' && appLimit != null) return { rows: [{ value: String(appLimit), updated_at: null, updated_by: 'ada' }] };
        return { rows: [] };
      }
      if (/^SELECT key, value FROM platform_settings WHERE key = ANY/.test(sql)) {
        return { rows: creditState ? [{ key: credit.KEY_STATE, value: JSON.stringify(creditState) }] : [] };
      }
      // platform-limit-alerts' `connections` limit: its line, then the census.
      if (/superuser_reserved_connections/.test(sql)) {
        return { rows: [{ cap: census.max - reserved.superuser_reserved - reserved.reserved }] };
      }
      if (/current_setting\('max_connections'\)/.test(sql)) return { rows: [{ max: census.max, used: census.used, idle: 0 }] };
      if (/GROUP BY datname|homeroom_connection_counts\(\) WHERE datname/.test(sql)) return { rows: [] };
      // #6901's count of people turned away at the app limit.
      if (/FROM platform_limit_alerts a WHERE a\.limit_key = \$1/.test(sql)) {
        return { rows: refusals ? [{ refusals_since: refusals.since, n: refusals.n }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const CONFIG = { maxApps: 50, maxGlobalSessions: 180 };

test('compute reads every limit through the code that enforces it', async () => {
  view.resetForTests();
  const pool = fakePool({
    apps: 214, appLimit: 210, sessions: 150, levels: { apps: 'full', sessions: 'warn' },
    creditState: { balanceCents: 18400, accountCents: 18400, keyCents: null, at: new Date().toISOString() },
    census: { max: 100, used: 20 },
  });
  const out = await view.compute(pool, CONFIG);
  assert.deepEqual(out.rows.map((r) => `${r.key}:${r.state}`), ['apps:over', 'openrouter_credit:near', 'sessions:near']);
  assert.equal(out.broken, true, 'over the app limit: the bell shows its dot');
  const apps = out.rows[0];
  assert.deepEqual([apps.used, apps.cap], [214, 210], 'the admin setting is the cap, as the create route reads it');
  assert.ok(pool.queries.some((q) => q === "SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'"),
    'the very count POST /api/apps refuses on');
  assert.ok(!pool.queries.some((q) => /^(INSERT|UPDATE|DELETE)/.test(q)), 'reading the area writes nothing');
});

test('nothing near: no rows and no dot', async () => {
  view.resetForTests();
  const out = await view.compute(fakePool({ apps: 20, sessions: 10 }), CONFIG);
  assert.deepEqual(out.rows, []);
  assert.equal(out.broken, false);
});

test('a read that fails is a could-not-check row, never a thrown read', async () => {
  view.resetForTests();
  const out = await view.compute(fakePool({ failApps: true, sessions: 10 }), CONFIG);
  assert.deepEqual(out.rows.map((r) => `${r.key}:${r.state}`), ['apps:unknown']);
  assert.equal(out.broken, false, 'not knowing is not the same as refusing');
});

test('the connections row is platform-limit-alerts\' own limit: the census against max_connections less the reserved blocks', async () => {
  view.resetForTests();
  const over = await view.compute(fakePool({ census: { max: 100, used: 90 }, reserved: { superuser_reserved: 3, reserved: 12 } }), CONFIG);
  const row = over.rows.find((r) => r.key === 'db_connections');
  assert.deepEqual([row.state, row.used, row.cap], ['over', 90, 85]);
  const near = await view.compute(fakePool({ census: { max: 100, used: 70 }, reserved: { superuser_reserved: 3, reserved: 12 } }), CONFIG);
  assert.equal(near.rows.find((r) => r.key === 'db_connections').state, 'near', '70 of 85 is past 80%');
  // The stored level holds it with the alerts' margin, as for apps and sessions.
  const held = await view.compute(fakePool({ census: { max: 100, used: 62 }, reserved: { superuser_reserved: 3, reserved: 12 }, levels: { connections: 'warn' } }), CONFIG);
  assert.equal(held.rows.find((r) => r.key === 'db_connections').state, 'near', 'just under the line, still a row');
  const fine = await view.compute(fakePool({ census: { max: 100, used: 40 }, reserved: { superuser_reserved: 3, reserved: 12 }, levels: { connections: 'warn' } }), CONFIG);
  assert.equal(fine.rows.find((r) => r.key === 'db_connections'), undefined);
});

test('the apps row carries #6901\'s count of people turned away, only while it is full', async () => {
  view.resetForTests();
  const since = '2026-11-20T09:00:00.000Z';
  const full = await view.compute(fakePool({ apps: 300, appLimit: 300, levels: { apps: 'full' }, refusals: { since, n: 4 } }), CONFIG);
  const apps = full.rows.find((r) => r.key === 'apps');
  assert.deepEqual([apps.state, apps.turnedAway, apps.turnedAwaySince], ['at', 4, since]);
  const near = await view.compute(fakePool({ apps: 260, appLimit: 300, levels: { apps: 'warn' }, refusals: { since, n: 4 } }), CONFIG);
  assert.equal(near.rows.find((r) => r.key === 'apps').turnedAway, undefined, 'nobody is refused while there is room');
});

test('the answer is held, and a level change drops what is held and tells the admins', async () => {
  view.resetForTests();
  const pool = fakePool({ apps: 45, levels: { apps: 'warn' } });
  const first = await view.read(pool, CONFIG);
  const seen = pool.queries.length;
  const again = await view.read(pool, CONFIG);
  assert.equal(again, first, 'held: opening the sheet twice does not read twice');
  assert.equal(pool.queries.length, seen);
  broadcasts.length = 0;
  view.changed();
  assert.deepEqual(broadcasts, [{ type: 'platform_limits_changed' }], 'a ping with no figures in it');
  await view.read(pool, CONFIG);
  assert.ok(pool.queries.length > seen, 'read again after a level moved');
});

// ─── 3. No dismiss ──────────────────────────────────────────────────────

test('nothing but a fix removes a row', async () => {
  view.resetForTests();
  assert.deepEqual(Object.keys(view).filter((k) => /dismiss|hide|snooze|mute|ack/i.test(k)), [],
    'the service has no way to take a row away');
  const pool = () => fakePool({ apps: 46, levels: { apps: 'warn' } });
  const a = await view.compute(pool(), CONFIG);
  const b = await view.compute(pool(), CONFIG);
  assert.deepEqual(b.rows.map((r) => r.key), a.rows.map((r) => r.key), 'the same figures, the same rows');
  // The count falls, but not under the margin: the row stays.
  const c = await view.compute(fakePool({ apps: 37, levels: { apps: 'warn' } }), CONFIG);
  assert.deepEqual(c.rows.map((r) => r.key), ['apps']);
  // Fixed: back under 0.9 x the line (36 for a limit of 50).
  const d = await view.compute(fakePool({ apps: 35, levels: { apps: 'warn' } }), CONFIG);
  assert.deepEqual(d.rows, []);
});

// ─── 4. The wiring ──────────────────────────────────────────────────────

function evaluatePool({ apps, level }) {
  const state = { level };
  return {
    state,
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM apps WHERE status <> 'error'/.test(sql)) return { rows: [{ n: apps }] };
      if (/FROM platform_settings s/.test(sql)) return { rows: [] };
      if (/^INSERT INTO platform_limit_alerts/.test(sql)) return { rows: [] };
      if (/FROM platform_limit_alerts WHERE limit_key = \$1 FOR UPDATE/.test(sql)) return { rows: [{ level: state.level, window_ms: null }] };
      if (/^UPDATE platform_limit_alerts/.test(sql)) { state.level = params[1]; return { rows: [] }; }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('evaluate says when a level moved, and only then', async () => {
  const changes = [];
  const deps = { staging: true, limitsChanged: () => changes.push('changed') };
  const pool = evaluatePool({ apps: 45, level: 'ok' });
  await alerts.evaluate(pool, { maxApps: 50 }, 'apps', deps);
  assert.deepEqual(changes, ['changed'], 'ok to warn: the area gains a row');
  await alerts.evaluate(pool, { maxApps: 50 }, 'apps', deps);
  assert.deepEqual(changes, ['changed'], 'still warn: nothing to say');
});

test('the credit sweep says when the credit row would change', async () => {
  const moves = [];
  const settings = { warnCents: 50000, urgentCents: 20000 };
  const at = new Date().toISOString();
  assert.equal(view.creditMoved({ balanceCents: 90000, accountCents: 90000, at }, { balanceCents: 41200, accountCents: 41200, at }, settings), true);
  assert.equal(view.creditMoved({ balanceCents: 41200, accountCents: 41200, at }, { balanceCents: 40000, accountCents: 40000, at }, settings), false,
    'still low: no ping for every cent');
  const pool = {
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      if (/^SELECT key, value FROM platform_settings WHERE key = ANY/.test(sql)) {
        return { rows: [{ key: credit.KEY_STATE, value: JSON.stringify({ balanceCents: 90000, accountCents: 90000, at }) }] };
      }
      if (/^INSERT INTO platform_settings/.test(sql)) return { rows: [] };
      if (/FROM users WHERE username = \$1 AND is_synthetic/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await credit.sweep(pool, {}, {
    staging: true,
    readBalance: async () => ({ accountCents: 41200, keyCents: null, at: new Date().toISOString() }),
    creditMoved: (before, after) => moves.push([before.accountCents, after.creditCents]),
  });
  assert.deepEqual(moves, [[90000, 41200]], 'the sweep hands its before and after to the area');
  // An outage that turns out to be the weekly budget changes the credit row too.
  const out = { accountCents: 192386, creditCents: 192386, creditAt: at, at, outage: { since: at, cause: 'credit' } };
  assert.equal(view.creditMoved(out, { ...out, outage: { since: at, cause: 'budget' } }, settings), true);
});

test('the route, the socket frame and both islands are wired', () => {
  const fs = require('node:fs');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(read('src/routes/admin.js'), /router\.use\(adminPlatformLimitsRoutes\(pool, config\)\)/);
  assert.match(read('public/js/app.js'), /case 'platform_limits_changed':\s*\/\/[\s\S]*?window\.UsernodeReact\?\.platformLimits\?\.refresh\?\.\(\);/);
  assert.match(read('frontend/src/features/notifications/notifications-sheet.tsx'), /<PlatformLimitsArea open=\{!!open\} \/>/);
  assert.match(read('frontend/src/features/header/platform-header.tsx'), /<PlatformLimitsDot \/>\s*<\/a>/);
});

// ─── 3. The cluster's own limits (services/platform-capacity.js) ─────────

const CLUSTER = {
  ...CONFIG,
  appRuntime: 'kubernetes',
  databaseUrl: 'postgres://u:p@social-postgres-rw.social-data.svc.cluster.local:5432/social',
  kubernetes: {
    appNamespace: 'social-apps', workerNamespace: 'social-workers', buildNamespace: 'social-builds',
    checkPoolMetricsUrl: 'http://prometheus.monitoring.svc:9090',
  },
};

test('a cluster row comes from what the sweep stored: its level, its figure, and what it was about', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const fresh = new Date(now - 4 * 60 * 1000).toISOString();
  assert.equal(view.capacityRow('node_pool', null, { percent: 80, now }), null, 'never measured here: no row');
  assert.equal(view.capacityRow('node_pool', { level: 'ok', used: 10, cap: 100, measured_at: fresh }, { percent: 80, now }), null);
  const near = view.capacityRow('quota_workers', {
    level: 'warn', used: 917, cap: 1000, measured_at: fresh,
    detail: { namespace: 'social-workers', resource: 'cpu', used: '44', hard: '48' },
  }, { percent: 80, now });
  assert.deepEqual([near.key, near.state, near.percent], ['quota_workers', 'near', 92]);
  assert.deepEqual(near.detail, { namespace: 'social-workers', resource: 'cpu', used: '44', hard: '48' });
  assert.equal(near.measuredAt, fresh);
  const full = view.capacityRow('db_disk', { level: 'full', used: 51200, cap: 51200, measured_at: fresh }, { percent: 80, now });
  assert.equal(full.state, 'at');
  // Held by the margin, as the counted rows are: 75% after a crossing at 80%.
  assert.equal(view.capacityRow('db_disk', { level: 'warn', used: 750, cap: 1000, measured_at: fresh }, { percent: 80, now }).state, 'near');
  const old = new Date(now - view.CAPACITY_STALE_MS - 1000).toISOString();
  assert.deepEqual(view.capacityRow('db_disk', { level: 'warn', used: 900, cap: 1000, measured_at: old }, { percent: 80, now }),
    { key: 'db_disk', state: 'unknown', reason: 'stale', measuredAt: old }, 'four missed sweeps: could not check');
});

test('compute shows the cluster rows it has figures for, and never reads the cluster itself', async () => {
  view.resetForTests();
  const capacity = require('../src/services/platform-capacity');
  const measure = capacity.measure;
  capacity.measure = () => { throw new Error('the area must not measure'); };
  try {
    const at = new Date().toISOString();
    const pool = fakePool({ levels: {
      quota_workers: { level: 'warn', used: 917, cap: 1000, measured_at: at,
        detail: { namespace: 'social-workers', resource: 'cpu', used: '44', hard: '48' } },
      db_disk: { level: 'full', used: 51200, cap: 51200, measured_at: at, detail: { volume: 'social-postgres-1' } },
      quota_apps: { level: 'ok', used: 300, cap: 1000, measured_at: at },
    } });
    const out = await view.compute(pool, CLUSTER);
    assert.deepEqual(out.rows.map((r) => `${r.key}:${r.state}`), ['db_disk:at', 'quota_workers:near']);
    assert.equal(out.broken, true, 'a full disk shows the dot');
    // Off Kubernetes, the same stored rows say nothing.
    view.resetForTests();
    const off = await view.compute(pool, CONFIG);
    assert.deepEqual(off.rows, []);
  } finally {
    capacity.measure = measure;
  }
});

// ─── 4. Homeroom bot's weekly budget (openrouter-credit.js budget) ───────

test('the weekly budget is a stored row beside the credit row, and a budget outage is its row, not "credit: out"', async () => {
  view.resetForTests();
  const at = new Date().toISOString();
  const pool = fakePool({
    levels: {
      bot_budget: {
        level: 'full', used: 80000, cap: 80000, measured_at: at,
        detail: { usedCents: 79960, capCents: 80000, source: 'openrouter', resetsAt: '2026-11-23T00:00:00.000Z', refused: true },
      },
    },
    creditState: {
      accountCents: 192386, keyCents: 40, keyLimitCents: 80000, keyReset: 'weekly', management: true,
      creditCents: 192386, creditAt: at, creditSource: 'account', spendableCents: 40, at,
      outage: { since: at, words: '402', cause: 'budget', causeFrom: 'figures' },
    },
  });
  const out = await view.compute(pool, CONFIG);
  assert.deepEqual(out.rows.map((r) => `${r.key}:${r.state}`), ['bot_budget:at'], 'no credit row: the account has $1,923.86');
  assert.equal(out.broken, true, 'the bot has stopped: the bell shows its dot');
  assert.equal(out.rows[0].detail.usedCents, 79960);
  // The same stored state with the cause credit is the credit row.
  view.resetForTests();
  const credited = fakePool({ creditState: { accountCents: 12, creditCents: 12, creditAt: at, at, management: true, outage: { since: at, words: '402', cause: 'credit' } } });
  assert.deepEqual((await view.compute(credited, CONFIG)).rows.map((r) => `${r.key}:${r.state}`), ['openrouter_credit:out']);
});

test('the state production held on 20 Nov reads as no credit row from the first request after the deploy, before any sweep', async () => {
  view.resetForTests();
  // Stored by the old sweep: the lower of the two figures as `balanceCents`.
  const at = new Date().toISOString();
  const pool = fakePool({ creditState: {
    balanceCents: 49996, accountCents: 192386, keyCents: 49996, dailyCents: 4021, at, armed: { low: false, urgent: true }, outage: null,
  } });
  assert.deepEqual((await view.compute(pool, CONFIG)).rows, [], 'the account has $1,923.86: nothing is low');
  const status = await credit.status(pool);
  assert.deepEqual([status.creditCents, status.creditSource, status.keyReset], [192386, 'account', null],
    'credit is the account\'s figure, and a key whose cadence was never read is not treated as prepaid');
});
