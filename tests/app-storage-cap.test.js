'use strict';

// #2253: the per-app database storage cap (services/app-storage-cap.js).
//
// Three things carry the weight here:
//
//   1. decide() is the state machine, and its HYSTERESIS is what keeps an
//      app hovering at the cap from flapping between writable and read-only
//      every sweep: freeze at the cap, thaw only under 95% of it, warn once
//      per crossing.
//   2. sweep() must touch a Postgres role only for a real app's own
//      database: never for a staging clone, a staging template, the
//      platform's self-hosted row, or a database no app row names; and in
//      a staging preview never at all, because the preview shares the
//      server with production's app databases.
//   3. A freeze is durable even when telling people about it fails, and
//      one app's failure does not stop the sweep for the others.
//
// Run with: node --test tests/app-storage-cap.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Quiet logger: every transition logs, and the output is noise here.
const logId = require.resolve('../src/services/logger');
require.cache[logId] = {
  id: logId, filename: logId, loaded: true, paths: [],
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

const cap = require('../src/services/app-storage-cap');
const dbManager = require('../src/services/db-manager');

const GIB = 1024 * 1024 * 1024;
const NOW = new Date('2026-09-15T12:00:00.000Z');
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// An in-memory `apps` table that answers the queries the service makes,
// applying each UPDATE to the row so successive sweeps see the state the
// previous one left behind.
function fakePool(apps) {
  const calls = [];
  const bySlug = (slug) => apps.find((a) => a.slug === slug && !a.self_hosted);
  const byId = (id) => apps.find((a) => a.id === id);
  return {
    apps,
    calls,
    async query(sql, params) {
      const q = norm(sql);
      calls.push({ sql: q, params });
      if (/^SELECT .* FROM apps WHERE NOT self_hosted$/.test(q)) {
        return { rows: apps.filter((a) => !a.self_hosted).map((a) => ({ ...a })) };
      }
      if (/^SELECT .* FROM apps WHERE slug = \$1 AND NOT self_hosted$/.test(q)) {
        const a = bySlug(params[0]);
        return { rows: a ? [{ ...a }] : [] };
      }
      if (/^UPDATE apps SET db_storage_grace_until = \$1 WHERE slug = \$2/.test(q)) {
        const a = bySlug(params[1]);
        if (!a) return { rows: [] };
        a.db_storage_grace_until = params[0];
        return { rows: [{ id: a.id, slug: a.slug, db_storage_frozen_at: a.db_storage_frozen_at }] };
      }
      if (/^UPDATE apps SET db_storage_cap_bytes = \$1 WHERE slug = \$2/.test(q)) {
        const a = bySlug(params[1]);
        if (!a) return { rows: [] };
        a.db_storage_cap_bytes = params[0];
        return { rows: [{ id: a.id }] };
      }
      if (/^UPDATE apps SET db_size_bytes = \$1, db_size_measured_at = \$2 WHERE id = \$3$/.test(q)) {
        const a = byId(params[2]);
        a.db_size_bytes = params[0];
        a.db_size_measured_at = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE apps SET db_storage_frozen_at = \$1, db_storage_warned_at = COALESCE\(db_storage_warned_at, \$1\) WHERE id = \$2$/.test(q)) {
        const a = byId(params[1]);
        a.db_storage_frozen_at = params[0];
        if (!a.db_storage_warned_at) a.db_storage_warned_at = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE apps SET db_storage_frozen_at = NULL WHERE id = \$1$/.test(q)) {
        byId(params[0]).db_storage_frozen_at = null;
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE apps SET db_storage_warned_at = \$1 WHERE id = \$2$/.test(q)) {
        byId(params[1]).db_storage_warned_at = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE apps SET db_storage_warned_at = NULL WHERE id = \$1$/.test(q)) {
        byId(params[0]).db_storage_warned_at = null;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fakePool: unexpected query ${q}`);
    },
  };
}

function app(id, slug, extra = {}) {
  return {
    id, slug, name: slug.replace(/-/g, ' '), self_hosted: false,
    db_size_bytes: null, db_size_measured_at: null, db_storage_cap_bytes: null,
    db_storage_frozen_at: null, db_storage_grace_until: null, db_storage_warned_at: null,
    ...extra,
  };
}

// A psql stand-in: answers the measurement query with `sizes`, records
// everything else (the role statements), and can be told to fail.
function fakeExecute(sizes, { failOn } = {}) {
  const calls = [];
  const execute = async (sql, opts) => {
    calls.push({ sql, opts });
    if (failOn && failOn.test(sql)) throw new Error(`psql: refused ${sql.slice(0, 20)}`);
    if (/pg_database_size/.test(sql)) {
      // pg_database_size is an integer; `2.8 * GIB` in a fixture is not.
      return sizes.map(([db, bytes]) => `${db}|${Math.floor(bytes)}`).join('\n');
    }
    return '';
  };
  execute.calls = calls;
  execute.roleCalls = () => calls.filter((c) => /ALTER ROLE|pg_terminate_backend/.test(c.sql)).map((c) => c.sql);
  return execute;
}

function fakeNotify() {
  const calls = [];
  const notify = async (pool, args) => { calls.push(args); return [{ id: calls.length }]; };
  notify.calls = calls;
  return notify;
}

const ENV_KEYS = ['APP_DB_STORAGE_CAP_BYTES', 'APP_DB_STORAGE_WARN_PERCENT', 'APP_DB_STORAGE_SWEEP_INTERVAL_MS', 'USERNODE_ENV'];
test.beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  cap._resetForTest();
});

// ── config ───────────────────────────────────────────────────────────────

test('config() reads the three tunables with the declared defaults', () => {
  assert.deepEqual(cap.config(), { capBytes: 3221225472, warnPercent: 80, sweepIntervalMs: 900000 });
  process.env.APP_DB_STORAGE_CAP_BYTES = String(5 * GIB);
  process.env.APP_DB_STORAGE_WARN_PERCENT = '90';
  process.env.APP_DB_STORAGE_SWEEP_INTERVAL_MS = '60000';
  assert.deepEqual(cap.config(), { capBytes: 5 * GIB, warnPercent: 90, sweepIntervalMs: 60000 });
  // Garbage falls back rather than producing a cap of NaN bytes.
  process.env.APP_DB_STORAGE_CAP_BYTES = 'lots';
  process.env.APP_DB_STORAGE_WARN_PERCENT = '250';
  process.env.APP_DB_STORAGE_SWEEP_INTERVAL_MS = '-1';
  assert.deepEqual(cap.config(), { capBytes: 3221225472, warnPercent: 80, sweepIntervalMs: 900000 });
});

// ── decide ───────────────────────────────────────────────────────────────

const base = { capBytes: 1000, warnPercent: 80, frozenAt: null, graceUntil: null, warnedAt: null, now: NOW };
const later = new Date(NOW.getTime() + 60 * 60 * 1000);
const earlier = new Date(NOW.getTime() - 60 * 60 * 1000);

test('decide: nothing happens under the warning line', () => {
  assert.deepEqual(cap.decide({ ...base, bytes: 0 }), { transition: 'none', frozen: false, warned: false, graceOpen: false });
  assert.deepEqual(cap.decide({ ...base, bytes: 799 }).transition, 'none');
});

test('decide: crossing the warning line warns once, and re-arms only under it', () => {
  assert.equal(cap.decide({ ...base, bytes: 800 }).transition, 'warn');
  assert.equal(cap.decide({ ...base, bytes: 800, warnedAt: earlier }).transition, 'none', 'already warned: no repeat');
  assert.equal(cap.decide({ ...base, bytes: 950, warnedAt: earlier }).transition, 'none', 'still over, still one warning');
  assert.equal(cap.decide({ ...base, bytes: 799, warnedAt: earlier }).transition, 'clear_warning');
  assert.equal(cap.decide({ ...base, bytes: 800, warnedAt: null }).transition, 'warn', 'the next crossing warns again');
});

test('decide: at the cap it freezes, and the freeze counts as the warning', () => {
  const d = cap.decide({ ...base, bytes: 1000 });
  assert.deepEqual(d, { transition: 'freeze', frozen: true, warned: true, graceOpen: false });
  assert.equal(cap.decide({ ...base, bytes: 1000, warnedAt: earlier }).transition, 'freeze', 'warned first, then frozen');
  assert.equal(cap.decide({ ...base, bytes: 5000 }).transition, 'freeze');
});

test('decide: a frozen app thaws only under 95% of the cap (hysteresis)', () => {
  const frozen = { ...base, frozenAt: earlier, warnedAt: earlier };
  assert.equal(cap.decide({ ...frozen, bytes: 1000 }).transition, 'none');
  assert.equal(cap.decide({ ...frozen, bytes: 990 }).transition, 'none', 'just under the cap is not enough');
  assert.equal(cap.decide({ ...frozen, bytes: 950 }).transition, 'none', 'exactly 95% is still frozen');
  const thaw = cap.decide({ ...frozen, bytes: 949 });
  assert.deepEqual(thaw, { transition: 'unfreeze', frozen: false, warned: true, graceOpen: false },
    'thaws and stays warned: it is still over the warning line');
  // One transition per sweep: a big drop thaws now and re-arms next time.
  assert.equal(cap.decide({ ...frozen, bytes: 10 }).transition, 'unfreeze');
  assert.equal(cap.decide({ ...base, bytes: 10, warnedAt: earlier }).transition, 'clear_warning');
});

test('decide: an open grace window keeps the app writable whatever its size', () => {
  assert.equal(cap.decide({ ...base, bytes: 5000, graceUntil: later }).transition, 'warn',
    'over the cap but not frozen; the warning still fires');
  assert.equal(cap.decide({ ...base, bytes: 5000, graceUntil: later, warnedAt: earlier }).transition, 'none');
  const thaw = cap.decide({ ...base, bytes: 5000, graceUntil: later, frozenAt: earlier, warnedAt: earlier });
  assert.equal(thaw.transition, 'unfreeze', 'a frozen app thaws for the window');
  assert.equal(thaw.graceOpen, true);
  // A lapsed window changes nothing.
  assert.equal(cap.decide({ ...base, bytes: 5000, graceUntil: earlier, warnedAt: earlier }).transition, 'freeze');
  assert.equal(cap.decide({ ...base, bytes: 5000, graceUntil: earlier, frozenAt: earlier }).transition, 'none');
});

test('decide: a per-app cap moves both lines', () => {
  assert.equal(cap.decide({ ...base, capBytes: 10000, bytes: 5000 }).transition, 'none');
  assert.equal(cap.decide({ ...base, capBytes: 10000, bytes: 8000 }).transition, 'warn');
  assert.equal(cap.decide({ ...base, capBytes: 10000, bytes: 10000 }).transition, 'freeze');
});

// ── sweep ────────────────────────────────────────────────────────────────

function fixture() {
  return fakePool([
    app(1, 'notes'),
    app(2, 'big-one'),
    app(3, 'warm'),
    app(4, 'usernode', { self_hosted: true }),
    app(5, 'roomy', { db_storage_cap_bytes: 8 * GIB }),
  ]);
}

const SIZES = [
  ['app_notes', GIB],
  ['app_big_one', 3.5 * GIB],
  ['app_warm', 2.5 * GIB],
  ['app_usernode', 4 * GIB],
  ['app_roomy', 3.5 * GIB],
  ['app_notes_staging_s12_abcdef', 9 * GIB],
  ['app_notes_stgtmpl', 9 * GIB],
  ['app_orphan', 9 * GIB],
];

test('sweep measures every app database, freezes and warns, and skips what is not an app', async () => {
  const pool = fixture();
  const execute = fakeExecute(SIZES);
  const notify = fakeNotify();

  const out = await cap.sweep(pool, { execute, now: NOW, staging: false, notify });

  assert.equal(out.staging, false);
  assert.equal(out.databases, 8);
  assert.equal(out.measured, 4, 'notes, big-one, warm, roomy');
  assert.equal(out.skipped, 4, 'the self-hosted row, the clone, the template and the orphan');
  assert.deepEqual([out.frozen, out.unfrozen, out.warned, out.cleared], [1, 0, 1, 0]);
  assert.deepEqual(out.errors, []);
  assert.equal(cap.lastSweep(), out, 'recorded for the admin API');

  // Measurements landed on the rows, with the sweep's own clock.
  const measured = pool.calls.filter((c) => /^UPDATE apps SET db_size_bytes/.test(c.sql));
  assert.deepEqual(measured.map((c) => c.params), [
    [GIB, NOW, 1], [3.5 * GIB, NOW, 2], [2.5 * GIB, NOW, 3], [3.5 * GIB, NOW, 5],
  ]);
  // Dates by value from here on: the sweep stamps its own Date instance.
  assert.equal(pool.apps[3].db_size_bytes, null, 'the self-hosted platform row is never measured');

  // big-one is over the 3 GiB default: role frozen, row stamped, admins told.
  assert.deepEqual(execute.roleCalls(), [
    'ALTER ROLE "app_big_one_owner" SET default_transaction_read_only = on',
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'app_big_one_owner' AND pid <> pg_backend_pid()",
  ], 'exactly one role was touched, and it is the app\'s owner role');
  assert.deepEqual(pool.apps[1].db_storage_frozen_at, NOW);
  assert.deepEqual(pool.apps[1].db_storage_warned_at, NOW, 'a freeze counts as the warning');

  // warm is at 83%: warned, not frozen.
  assert.deepEqual(pool.apps[2].db_storage_warned_at, NOW);
  assert.equal(pool.apps[2].db_storage_frozen_at, null);

  // roomy has an 8 GiB override, so 3.5 GiB is nothing.
  assert.equal(pool.apps[4].db_storage_warned_at, null);
  assert.equal(pool.apps[4].db_storage_frozen_at, null);

  assert.deepEqual(notify.calls, [
    { appId: 2, detail: 'storage_full' },
    { appId: 3, detail: 'storage_warn' },
  ]);
});

test('sweep in a staging preview measures and records but touches no role and tells nobody', async () => {
  const pool = fixture();
  const execute = fakeExecute(SIZES);
  const notify = fakeNotify();

  const out = await cap.sweep(pool, { execute, now: NOW, staging: true, notify });

  assert.equal(out.staging, true);
  assert.equal(out.measured, 4);
  assert.equal(out.frozen, 1, 'the row is stamped so the preview\'s screen shows the state');
  assert.deepEqual(execute.roleCalls(), [], 'no ALTER ROLE, no pg_terminate_backend from a preview');
  assert.deepEqual(notify.calls, []);
  assert.deepEqual(pool.apps[1].db_storage_frozen_at, NOW);
  assert.deepEqual(pool.apps[2].db_storage_warned_at, NOW);
});

test('sweep reads USERNODE_ENV when not told which side it is on', async () => {
  process.env.USERNODE_ENV = 'staging';
  const pool = fixture();
  const execute = fakeExecute(SIZES);
  const out = await cap.sweep(pool, { execute, now: NOW, notify: fakeNotify() });
  assert.equal(out.staging, true);
  assert.deepEqual(execute.roleCalls(), []);
});

test('successive sweeps: frozen stays frozen until 95%, thaws without a second warning, re-arms under the line', async () => {
  const pool = fakePool([app(2, 'big-one')]);
  const notify = fakeNotify();
  const at = (m) => new Date(NOW.getTime() + m * 60 * 1000);
  const run = (bytes, now) => cap.sweep(pool, { execute: fakeExecute([['app_big_one', bytes]]), now, staging: false, notify });

  let out = await run(3.5 * GIB, at(0));
  assert.equal(out.frozen, 1);

  out = await run(2.95 * GIB, at(15));
  assert.deepEqual([out.frozen, out.unfrozen, out.warned, out.cleared], [0, 0, 0, 0], '98%: still frozen');
  assert.ok(pool.apps[0].db_storage_frozen_at);

  const execute = fakeExecute([['app_big_one', 2.8 * GIB]]);
  out = await cap.sweep(pool, { execute, now: at(30), staging: false, notify });
  assert.equal(out.unfrozen, 1, '93%: thawed');
  assert.equal(out.warned, 0, 'and NOT warned again: the freeze already was the warning');
  assert.equal(execute.roleCalls()[0], 'ALTER ROLE "app_big_one_owner" RESET default_transaction_read_only');
  assert.equal(pool.apps[0].db_storage_frozen_at, null);
  assert.ok(pool.apps[0].db_storage_warned_at, 'still warned: it is over 80%');

  out = await run(2 * GIB, at(45));
  assert.equal(out.cleared, 1, '67%: the warning re-arms');
  assert.equal(pool.apps[0].db_storage_warned_at, null);

  out = await run(2.5 * GIB, at(60));
  assert.equal(out.warned, 1, '83% again: warned again');

  assert.deepEqual(notify.calls.map((c) => c.detail), ['storage_full', 'storage_warn'],
    'two notifications across five sweeps: the freeze and the fresh crossing');
});

test('successive sweeps: a grace window thaws a frozen app and the sweep re-freezes once it lapses', async () => {
  const pool = fakePool([app(2, 'big-one', {
    db_storage_frozen_at: new Date(NOW.getTime() - 3600000),
    db_storage_warned_at: new Date(NOW.getTime() - 3600000),
    db_storage_grace_until: new Date(NOW.getTime() + 3600000),
  })]);
  const notify = fakeNotify();
  const sizes = [['app_big_one', 3.5 * GIB]];

  let execute = fakeExecute(sizes);
  let out = await cap.sweep(pool, { execute, now: NOW, staging: false, notify });
  assert.equal(out.unfrozen, 1, 'over the cap, but the window is open');
  assert.match(execute.roleCalls()[0], /RESET default_transaction_read_only/);
  assert.equal(pool.apps[0].db_storage_frozen_at, null);

  execute = fakeExecute(sizes);
  out = await cap.sweep(pool, { execute, now: new Date(NOW.getTime() + 2 * 3600000), staging: false, notify });
  assert.equal(out.frozen, 1, 'the window lapsed and it is still over: frozen again');
  assert.match(execute.roleCalls()[0], /SET default_transaction_read_only = on/);
  assert.deepEqual(notify.calls.map((c) => c.detail), ['storage_full']);
});

test('sweep records a failed measurement and touches nothing', async () => {
  const pool = fixture();
  const execute = fakeExecute(SIZES, { failOn: /pg_database_size/ });
  const out = await cap.sweep(pool, { execute, now: NOW, staging: false, notify: fakeNotify() });
  assert.equal(out.measured, 0);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /^measure: /);
  assert.deepEqual(pool.calls, [], 'no app row was read or written');
  assert.equal(cap.lastSweep(), out);
});

test('one app\'s failed role change is recorded and leaves the others alone', async () => {
  const pool = fixture();
  // The freeze statement for big-one is refused; everything else works.
  const execute = fakeExecute(SIZES, { failOn: /ALTER ROLE "app_big_one_owner"/ });
  const notify = fakeNotify();
  const out = await cap.sweep(pool, { execute, now: NOW, staging: false, notify });
  assert.equal(out.frozen, 0);
  assert.equal(out.warned, 1, 'warm was still handled');
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /^big-one: /);
  assert.equal(pool.apps[1].db_storage_frozen_at, null, 'nothing recorded for a freeze that did not happen');
  assert.deepEqual(notify.calls, [{ appId: 3, detail: 'storage_warn' }], 'nobody is told about a freeze that did not happen');
  assert.equal(pool.apps[1].db_size_bytes, 3.5 * GIB, 'the measurement itself still landed');
});

test('a freeze stands when the notification fails', async () => {
  const pool = fixture();
  const execute = fakeExecute(SIZES);
  const notify = async () => { throw new Error('notifications down'); };
  const out = await cap.sweep(pool, { execute, now: NOW, staging: false, notify });
  assert.equal(out.frozen, 1);
  assert.deepEqual(pool.apps[1].db_storage_frozen_at, NOW);
  assert.ok(out.errors.some((e) => /^big-one: notify: notifications down/.test(e)));
  assert.ok(out.errors.some((e) => /^warm: notify: notifications down/.test(e)));
});

test('sweep tells admins through createAppHealthNotification by default', async () => {
  const notifications = require('../src/services/notifications');
  const original = notifications.createAppHealthNotification;
  const calls = [];
  notifications.createAppHealthNotification = async (pool, args) => { calls.push(args); return []; };
  try {
    const pool = fakePool([app(2, 'big-one')]);
    await cap.sweep(pool, { execute: fakeExecute([['app_big_one', 4 * GIB]]), now: NOW, staging: false });
    assert.deepEqual(calls, [{ appId: 2, detail: 'storage_full' }]);
  } finally {
    notifications.createAppHealthNotification = original;
  }
});

// ── grantGrace / setCapOverride ──────────────────────────────────────────

test('grantGrace opens the window and thaws a frozen app on the spot', async () => {
  const pool = fakePool([app(2, 'big-one', {
    db_size_bytes: 3.5 * GIB, db_size_measured_at: NOW,
    db_storage_frozen_at: NOW, db_storage_warned_at: NOW,
  })]);
  const execute = fakeExecute([]);
  const row = await cap.grantGrace(pool, 'big-one', 60, { execute, now: NOW, staging: false });
  assert.equal(row.state, 'grace');
  assert.equal(row.frozenAt, null);
  assert.equal(row.graceUntil, new Date(NOW.getTime() + 3600000).toISOString());
  assert.equal(row.dbSizeBytes, 3.5 * GIB);
  assert.deepEqual(execute.roleCalls(), [
    'ALTER ROLE "app_big_one_owner" RESET default_transaction_read_only',
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'app_big_one_owner' AND pid <> pg_backend_pid()",
  ]);
});

test('grantGrace on an app that is not frozen only sets the window', async () => {
  const pool = fakePool([app(1, 'notes', { db_size_bytes: GIB })]);
  const execute = fakeExecute([]);
  const row = await cap.grantGrace(pool, 'notes', 5, { execute, now: NOW, staging: false });
  assert.equal(row.state, 'grace');
  assert.deepEqual(execute.roleCalls(), []);
});

test('grantGrace from a staging preview writes the row and leaves the role alone', async () => {
  const pool = fakePool([app(2, 'big-one', { db_storage_frozen_at: NOW })]);
  const execute = fakeExecute([]);
  const row = await cap.grantGrace(pool, 'big-one', 60, { execute, now: NOW, staging: true });
  assert.equal(row.frozenAt, null);
  assert.deepEqual(execute.roleCalls(), []);
});

test('grantGrace rejects a bad window and answers null for an unknown or self-hosted app', async () => {
  const pool = fakePool([app(1, 'notes'), app(4, 'usernode', { self_hosted: true })]);
  for (const bad of [0, 1441, -5, 1.5, 'x', undefined]) {
    await assert.rejects(() => cap.grantGrace(pool, 'notes', bad, { now: NOW, staging: false }), /between 1 and 1440/);
  }
  assert.equal(await cap.grantGrace(pool, 'missing', 10, { now: NOW, staging: false }), null);
  assert.equal(await cap.grantGrace(pool, 'usernode', 10, { now: NOW, staging: false }), null);
});

test('setCapOverride sets and clears the per-app cap', async () => {
  const pool = fakePool([app(1, 'notes', { db_size_bytes: 2.5 * GIB })]);
  let row = await cap.setCapOverride(pool, 'notes', 8 * GIB, { now: NOW });
  assert.equal(row.capBytes, 8 * GIB);
  assert.equal(row.capOverrideBytes, 8 * GIB);
  assert.equal(row.state, 'ok', '2.5 GiB of 8 is well under the warning line');
  row = await cap.setCapOverride(pool, 'notes', null, { now: NOW });
  assert.equal(row.capBytes, 3221225472);
  assert.equal(row.capOverrideBytes, null);
  assert.equal(row.state, 'warning', '2.5 GiB of 3 is past the warning line, whether or not the sweep has said so yet');
  for (const bad of [-1, 1.5, 'abc']) {
    await assert.rejects(() => cap.setCapOverride(pool, 'notes', bad), /non-negative integer/);
  }
  assert.equal(await cap.setCapOverride(pool, 'missing', 1), null);
});

// ── admin payloads ───────────────────────────────────────────────────────

test('adminPayload sorts biggest first with unmeasured apps last and derives each state', async () => {
  const pool = fakePool([
    app(1, 'never-measured'),
    app(2, 'small', { db_size_bytes: 10, db_size_measured_at: NOW }),
    app(3, 'frozen-one', { db_size_bytes: 4 * GIB, db_size_measured_at: NOW, db_storage_frozen_at: NOW, db_storage_warned_at: NOW }),
    app(4, 'in-grace', { db_size_bytes: 3.2 * GIB, db_size_measured_at: NOW, db_storage_grace_until: new Date(NOW.getTime() + 60000) }),
    app(5, 'usernode', { self_hosted: true, db_size_bytes: 9 * GIB }),
  ]);
  const payload = await cap.adminPayload(pool, { now: NOW });
  assert.deepEqual(payload.apps.map((a) => [a.slug, a.state]), [
    ['frozen-one', 'frozen'], ['in-grace', 'grace'], ['small', 'ok'], ['never-measured', 'ok'],
  ]);
  assert.deepEqual(payload.defaults, { capBytes: 3221225472, warnPercent: 80, sweepIntervalMs: 900000 });
  assert.equal(payload.lastSweep, null);
  const frozen = payload.apps[0];
  assert.deepEqual(Object.keys(frozen).sort(), [
    'capBytes', 'capOverrideBytes', 'dbSizeBytes', 'frozenAt', 'graceUntil', 'measuredAt', 'name', 'slug', 'state', 'warnedAt',
  ]);
  assert.equal(frozen.frozenAt, NOW.toISOString());
  assert.equal(frozen.capBytes, 3221225472);
});

test('demoAdminPayload is deterministic, obviously fake, and shows every state the screen has', () => {
  const a = cap.demoAdminPayload({ now: NOW });
  const b = cap.demoAdminPayload({ now: NOW });
  assert.deepEqual(a, b);
  assert.equal(a.demo, true);
  assert.equal(a.apps.length, 4);
  assert.ok(a.apps.every((r) => /^Staging demo app \d$/.test(r.name)));
  assert.deepEqual(a.apps.map((r) => r.state), ['frozen', 'warning', 'ok', 'ok']);
  assert.ok(a.apps[2].capOverrideBytes > a.apps[2].dbSizeBytes, 'one row shows a raised cap');
  assert.equal(a.lastSweep.staging, true);
});
