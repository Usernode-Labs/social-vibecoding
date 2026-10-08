'use strict';

// The workflow kernel (src/workflow/kernel/) against the full PostgreSQL
// schema. One subtest per kernel guarantee (K1-K17 in the workflow
// foundation's guarantee list), driven through a small test machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime, defineMachine, inspect, NONE, ok, reject } = require('../src/workflow/kernel/index.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// kt-counter: a counter with one event per kernel feature.
function counter({ name = 'kt-counter', version = 1 } = {}) {
  const any = (p) => p || {};
  const same = (s, data) => ({ next: { name: s.name, data: { ...s.data, ...data } } });
  return defineMachine({
    name,
    version,
    events: {
      Create: any, Add: (p) => { if (!Number.isInteger(p?.n)) throw new Error('n must be an integer'); return p; },
      Explode: any, Flaky: any, Swallow: any, Sneaky: any, Lock: any, Send: any, Work: any,
      Arm: any, Tick: any, Admit: any, Close: any,
    },
    create: ['Create'],
    terminal: ['closed'],
    decode: (row) => ({ name: row.state, data: row.data }),
    async facts(tx, state, event, ctx) {
      if (event.payload?.sleepMs) await tx.query('SELECT pg_sleep($1::float8 / 1000)', [event.payload.sleepMs]);
      const { rows: [f] } = await tx.query(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS exclusive,
                COALESCE((SELECT on_off FROM kt_flags WHERE name = 'admission'), TRUE) AS admission`, [ctx.key]);
      return f;
    },
    authorize: {
      Create: () => ok(), Add: () => ok(), Explode: () => ok(), Flaky: () => ok(), Swallow: () => ok(),
      Sneaky: () => ok(), Lock: () => ok(), Send: () => ok(), Work: () => ok(), Arm: () => ok(), Close: () => ok(),
      Tick: (e) => (e.source.kind === 'timer' ? ok() : reject('timer_only')),
      Admit: (e, f) => (f.admission ? ok() : reject('admission_off')),
    },
    transitions: {
      [NONE]: { Create: { to: (s, e) => ({ next: { name: 'active', data: { count: e.payload.start || 0, log: [], ticks: 0, results: [], overlaps: 0 } } }) } },
      active: {
        Create: { ignore: 'exists' },
        Add: {
          guard: (s, e) => (e.payload.n > 0 ? ok() : reject('not_positive')),
          to: (s, e, f) => ({
            ...same(s, { count: s.data.count + e.payload.n, log: [...s.data.log, e.payload.n], overlaps: s.data.overlaps + (f.exclusive ? 0 : 1) }),
            writes: [{ type: 'log', n: e.payload.n }],
            notify: [{ type: 'counted' }],
          }),
        },
        Explode: { to: () => { throw new Error('boom'); } },
        Flaky: { to: (s) => ({ ...same(s, {}), writes: [{ type: 'log', n: -1 }, { type: 'flaky' }] }) },
        Swallow: { to: (s) => ({ ...same(s, {}), writes: [{ type: 'swallow' }] }) },
        Sneaky: { to: (s) => ({ ...same(s, {}), writes: [{ type: 'log', n: -2 }, { type: 'sneaky' }] }) },
        Lock: { to: (s, e) => ({ ...same(s, {}), writes: [{ type: 'lock', row: e.payload.row }] }) },
        Send: {
          to: (s, e) => ({
            ...same(s, {}),
            messages: e.payload.ns.map((n) => ({ to: { machine: name, key: e.payload.to }, event: { type: 'Add', payload: { n } } })),
          }),
        },
        Work: {
          to: (s, e) => ({
            ...same(s, { expect: e.payload.workKey }),
            work: (e.payload.keys || [e.payload.workKey]).map((key) => ({
              kind: 'kt.echo', key, input: { mode: e.payload.mode || 'ok' }, ...(e.payload.continues ? { continues: e.payload.continues } : {}),
            })),
          }),
        },
        WorkSucceeded: {
          guard: (s, e) => (e.payload.workKey === s.data.expect ? ok() : reject('stale_result')),
          to: (s, e) => same(s, { results: [...s.data.results, ['ok', e.payload.workKey, e.payload.result]] }),
        },
        WorkFailed: { to: (s, e) => same(s, { results: [...s.data.results, ['failed', e.payload.workKey, e.payload.error.message]] }) },
        WorkExhausted: { to: (s, e) => same(s, { results: [...s.data.results, ['exhausted', e.payload.workKey, e.payload.attempt]] }) },
        Arm: { to: (s, e, f, ctx) => ({ ...same(s, {}), timer: { at: new Date(ctx.now.getTime() + e.payload.ms), event: { type: 'Tick', payload: { armedAt: ctx.version + 1 } } } }) },
        Tick: { to: (s) => same(s, { ticks: s.data.ticks + 1 }) },
        Admit: { to: (s) => same(s, { admitted: true }) },
        Close: { to: (s) => ({ next: { name: 'closed', data: s.data } }) },
      },
      closed: {
        '*': { ignore: 'closed' },
        WorkSucceeded: { to: (s, e) => ({ next: { name: 'closed', data: { ...s.data, late: e.payload.workKey } } }) },
      },
    },
    writes: {
      log: (tx, w, ctx) => tx.query('INSERT INTO kt_log (key, n) VALUES ($1, $2)', [ctx.key, w.n]),
      async flaky(tx) {
        const { rows: [f] } = await tx.query(`SELECT on_off FROM kt_flags WHERE name = 'flaky'`);
        if (f?.on_off) throw new Error('flaky write');
      },
      async swallow(tx) { try { await tx.query('SELECT 1/0'); } catch { /* swallowed on purpose */ } },
      sneaky: (tx) => tx.query('COMMIT'),
      lock: (tx, w) => tx.query('UPDATE kt_rows SET v = v + 1 WHERE id = $1', [w.row]),
    },
    async project(tx, before, after, ctx) {
      await tx.query(
        `INSERT INTO kt_legacy (key, status, payload) VALUES ($1, $2, jsonb_build_object('appliedAt', $3::int))
         ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, payload = kt_legacy.payload || EXCLUDED.payload`,
        [ctx.key, `${after.name}:${after.data.count}`, ctx.version]);
    },
    // The producer's answer, read in the transaction after the projection.
    async reply(tx, event, after, ctx) {
      if (event.type !== 'Add') return undefined;
      const { rows: [l] } = await tx.query('SELECT status FROM kt_legacy WHERE key = $1', [ctx.key]);
      return { count: after.data.count, projected: l.status };
    },
    notifiers: { counted: () => { notified++; } },
  });
}
let notified = 0;

test('workflow kernel against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_kernel_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  const other = new Pool({ connectionString: String(url), max: 12 });
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await other.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent
  await pool.query(`
    CREATE TABLE kt_log (id BIGSERIAL PRIMARY KEY, key TEXT NOT NULL, n INT NOT NULL);
    CREATE TABLE kt_flags (name TEXT PRIMARY KEY, on_off BOOLEAN NOT NULL);
    CREATE TABLE kt_rows (id INT PRIMARY KEY, v INT NOT NULL DEFAULT 0);
    INSERT INTO kt_rows (id) VALUES (1);
    CREATE TABLE kt_legacy (id BIGSERIAL, key TEXT PRIMARY KEY, status TEXT, payload JSONB NOT NULL DEFAULT '{}', note TEXT);
    CREATE TRIGGER kt_legacy_owned BEFORE UPDATE ON kt_legacy FOR EACH ROW
      WHEN (OLD.key NOT LIKE 'free:%')
      EXECUTE FUNCTION wf_guard_owned_columns('status', 'payload.appliedAt');`);

  const handlers = {};
  const echo = {
    maxAttempts: 2, backoffMs: () => 0, leaseMs: 600,
    async run(ctx) {
      const hook = handlers[ctx.key];
      if (hook) return hook(ctx);
      if (ctx.input.mode === 'fail') throw Object.assign(new Error('transient'), { code: 'EAGAIN' });
      if (ctx.input.mode === 'permanent') throw Object.assign(new Error('bad input'), { permanent: true });
      return { echoed: ctx.key, attempt: ctx.attempt };
    },
  };
  const machine = counter();
  const make = (o = {}) => {
    const r = createRuntime({ log: process.env.WF_DEBUG ? { info: console.log, warn: console.log, error: console.log } : undefined, pool: o.pool || pool, machines: [o.machine || machine], services: { 'kt.echo': echo }, pollMs: 50, ...o });
    runtimes.push(r);
    return r;
  };
  const rt = make();
  let seq = 0;
  const route = (key, type, payload = {}, extra = {}) => rt.append(machine, key, { type, payload },
    { requestKey: extra.requestKey || `req-${++seq}`, source: { kind: 'route' }, actor: extra.actor ?? 'user:1', appId: 7, ...extra });
  const event = async (id) => (await pool.query('SELECT * FROM wf_events WHERE id = $1', [id])).rows[0];
  const inst = async (key, m = 'kt-counter') => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [m, key])).rows[0];
  const create = async (key, start = 0) => { const id = await route(key, 'Create', { start }); await rt.drain(); return id; };

  await t.test('K1/K2 replay first, conflicting payload refused', async () => {
    await create('k1');
    const a = await route('k1', 'Add', { n: 2 }, { requestKey: 'add-once' });
    await rt.drain();
    assert.equal((await event(a)).result, 'accepted');
    // Admission turned off and state moved on: the retry still replays.
    await pool.query(`INSERT INTO kt_flags VALUES ('admission', FALSE) ON CONFLICT (name) DO UPDATE SET on_off = FALSE`);
    await route('k1', 'Add', { n: 5 });
    const retry = await route('k1', 'Add', { n: 2 }, { requestKey: 'add-once' });
    const conflict = await route('k1', 'Add', { n: 3 }, { requestKey: 'add-once' });
    const otherActor = await route('k1', 'Add', { n: 2 }, { requestKey: 'add-once', actor: 'user:2' });
    await rt.drain();
    const r = await event(retry);
    assert.equal(r.result, 'replayed');
    assert.equal(r.state_after, 'active');
    assert.equal(Number(r.version_after), 2, 'replays the original outcome, not the current version');
    assert.deepEqual(r.emitted, { replayOf: a });
    assert.equal((await event(conflict)).reason, 'request_key_conflict');
    assert.equal((await event(otherActor)).reason, 'request_key_conflict', 'the actor is part of the request');
    assert.equal((await inst('k1')).data.count, 7);
    await pool.query(`UPDATE kt_flags SET on_off = TRUE WHERE name = 'admission'`);
  });

  await t.test('K3 a rejection writes no receipt, so the same key can be accepted later', async () => {
    await create('k3');
    await pool.query(`UPDATE kt_flags SET on_off = FALSE WHERE name = 'admission'`);
    const first = await route('k3', 'Admit', {}, { requestKey: 'admit-1' });
    await rt.drain();
    const rejected = await event(first);
    assert.equal(rejected.result, 'rejected');
    assert.equal(rejected.reason, 'admission_off');
    assert.equal((await pool.query(`SELECT 1 FROM wf_receipts WHERE request_key = 'admit-1'`)).rowCount, 0);
    await pool.query(`UPDATE kt_flags SET on_off = TRUE WHERE name = 'admission'`);
    const again = await route('k3', 'Admit', {}, { requestKey: 'admit-1' });
    await rt.drain();
    assert.equal((await event(again)).result, 'accepted');
    // Guard rejections and undeclared/ignored pairs are rejections too.
    const zero = await route('k3', 'Add', { n: 0 });
    const tick = await route('k3', 'Tick');
    await rt.drain();
    assert.equal((await event(zero)).reason, 'not_positive');
    assert.equal((await event(tick)).reason, 'timer_only');
    await assert.rejects(route('k3', 'Add', { n: 'x' }), { code: 'invalid_payload' });
    await assert.rejects(route('k3', 'Nope'), { code: 'unknown_event' });
  });

  await t.test('inherited object keys are unknown events, at append and in the pipeline', async () => {
    await create('k-proto');
    for (const type of ['toString', 'constructor']) {
      await assert.rejects(route('k-proto', type), { code: 'unknown_event' }, type);
      // A row that skipped the boundary (written straight into the stream)
      // is refused by the pipeline's own decoder lookup.
      const raw = async (key, requestKey) => Number((await pool.query(
        `INSERT INTO wf_events (machine, key, type, source, request_key) VALUES ('kt-counter', $1, $2, '{"kind":"route"}', $3) RETURNING id`,
        [key, type, requestKey])).rows[0].id);
      const existing = await raw('k-proto', `proto-${type}`);
      const fresh = await raw(`k-proto-${type}`, `proto-new-${type}`);
      await rt.drain();
      for (const id of [existing, fresh]) {
        const e = await event(id);
        assert.deepEqual([e.result, e.reason], ['rejected', 'unknown_event'], type);
      }
      assert.equal(await inst(`k-proto-${type}`), undefined, `${type}: no instance created`);
    }
    assert.equal(Number((await inst('k-proto')).version), 1);
  });

  await t.test('creating events: a rejected or unknown first event leaves no instance', async () => {
    const id = await route('k-none', 'Add', { n: 1 });
    await rt.drain();
    assert.equal((await event(id)).reason, 'no_instance');
    assert.equal(await inst('k-none'), undefined);
    const c = await create('k-new', 4);
    assert.equal((await event(c)).state_before, NONE);
    const row = await inst('k-new');
    assert.equal(row.state, 'active');
    assert.equal(row.app_id, 7);
    assert.equal(Number(row.version), 1);
  });

  await t.test('K4 nothing commits partially, and machine code cannot commit', async () => {
    await create('k4');
    await pool.query(`INSERT INTO kt_flags VALUES ('flaky', TRUE) ON CONFLICT (name) DO UPDATE SET on_off = TRUE`);
    const before = await inst('k4');
    for (const type of ['Flaky', 'Sneaky', 'Swallow']) {
      const key = `k4-${type}`;
      await create(key);
      const id = await route(key, type, {}, { requestKey: `${type}-1` });
      await rt.drain();
      const e = await event(id);
      assert.equal(e.result, 'faulted', type);
      const row = await inst(key);
      assert.equal(row.flag, 'faulted', type);
      assert.equal(Number(row.version), 1, `${type}: state unchanged`);
      assert.equal((await pool.query('SELECT 1 FROM kt_log WHERE key = $1', [key])).rowCount, 0, `${type}: the domain write rolled back`);
      assert.equal((await pool.query(`SELECT 1 FROM wf_receipts WHERE request_key = $1`, [`${type}-1`])).rowCount, 0, `${type}: no receipt`);
    }
    assert.match((await event((await pool.query(`SELECT id FROM wf_events WHERE key = 'k4-Sneaky' AND result = 'faulted'`)).rows[0].id)).error.message, /cannot control the transaction/);
    assert.equal((await pool.query(`SELECT error->>'code' AS code FROM wf_events WHERE key = 'k4-Swallow' AND result = 'faulted'`)).rows[0].code, '22012',
      'a swallowed error still fails the event');
    assert.equal(Number((await inst('k4')).version), Number(before.version));
  });

  await t.test('K16 a fault holds only its instance; release retries or skips', async () => {
    await create('k16-a');
    await create('k16-b');
    const flaky = await route('k16-a', 'Flaky');
    const held = await route('k16-a', 'Add', { n: 1 });
    await rt.drain();
    assert.equal((await event(flaky)).result, 'faulted');
    assert.equal((await event(held)).status, 'held');
    const later = await route('k16-a', 'Add', { n: 2 });
    const b = await route('k16-b', 'Add', { n: 1 });
    await rt.drain();
    assert.equal((await event(b)).result, 'accepted', 'other instances keep moving');
    assert.equal((await event(later)).status, 'pending', 'nothing applies to a faulted instance');
    const problems = await inspect.problems(pool);
    const flagged = problems.flagged.find((p) => p.key === 'k16-a');
    assert.equal(flagged.flag, 'faulted');
    assert.equal(flagged.heldEvents, 1);
    // Fix the cause, then retry the faulted event: it goes first.
    await pool.query(`UPDATE kt_flags SET on_off = FALSE WHERE name = 'flaky'`);
    assert.deepEqual(await rt.release('kt-counter', 'k16-a', { mode: 'retry', actor: 'admin:1' }), { released: true, heldEvents: 1 });
    await rt.drain();
    const ev = (await inspect.instance(pool, 'kt-counter', 'k16-a')).events.reverse();
    const order = ev.filter((e) => e.result === 'accepted' && e.type !== '@Released').map((e) => e.type);
    assert.deepEqual(order, ['Create', 'Flaky', 'Add', 'Add']);
    const retried = await event(flaky);
    assert.equal(retried.result, 'accepted');
    assert.equal(retried.error.message, 'flaky write', 'the fault stays on record');
    assert.ok(ev.some((e) => e.type === '@Released' && e.actor === 'admin:1'));
    assert.equal((await inst('k16-a')).data.count, 3);
    // Skip leaves the faulted event as it was.
    const boom = await route('k16-b', 'Explode');
    await rt.drain();
    await rt.release('kt-counter', 'k16-b', { mode: 'skip', actor: 'admin:1' });
    const after = await route('k16-b', 'Add', { n: 1 });
    await rt.drain();
    assert.equal((await event(boom)).result, 'faulted');
    assert.equal((await event(after)).result, 'accepted');
  });

  await t.test('K16 a timeout returns the event to pending and does not block other instances', async () => {
    const quick = make({ lockTimeoutMs: 150, stallAfter: 1 });
    await create('k16-wait');
    await create('k16-free');
    const holder = await other.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM kt_rows WHERE id = 1 FOR UPDATE');
      const waiting = await route('k16-wait', 'Lock', { row: 1 });
      const free = await route('k16-free', 'Add', { n: 1 });
      await quick.drain();
      const w = await event(waiting);
      assert.equal(w.status, 'pending');
      assert.equal(w.attempts, 1);
      assert.equal(w.error.code, '55P03');
      assert.ok(w.retry_at);
      assert.equal((await event(free)).result, 'accepted', 'another instance was processed meanwhile');
      assert.equal((await inst('k16-wait')).flag, 'stalled');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    await sleep(600);
    await quick.drain();
    const row = await inst('k16-wait');
    assert.equal(row.flag, null, 'success clears the stall');
    assert.equal(Number(row.version), 2);
  });

  await t.test('K16 a first event that times out or throws leaves only a flagged (none) row', async () => {
    const flag = (name, on) => pool.query(
      `INSERT INTO kt_flags VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET on_off = EXCLUDED.on_off`, [name, on]);
    const birth = defineMachine({
      name: 'kt-birth', version: 1,
      events: { Create: (p) => p || {}, Poke: (p) => p || {} },
      create: ['Create'],
      decode: (row) => ({ name: row.state, data: row.data }),
      async facts(tx) {
        const { rows: [f] } = await tx.query(
          `SELECT COALESCE((SELECT on_off FROM kt_flags WHERE name = 'birth-slow'), FALSE) AS slow,
                  COALESCE((SELECT on_off FROM kt_flags WHERE name = 'birth-boom'), FALSE) AS boom`);
        if (f.slow) await tx.query('SELECT pg_sleep(0.3)');
        return f;
      },
      authorize: { Create: () => ok(), Poke: () => ok() },
      transitions: {
        [NONE]: { Create: { to: (s, e, f) => { if (f.boom) throw new Error('born broken'); return { next: { name: 'alive', data: { pokes: 0 } } }; } } },
        alive: { Create: { ignore: 'exists' }, Poke: { to: (s) => ({ next: { name: 'alive', data: { pokes: s.data.pokes + 1 } } }) } },
      },
    });
    const born = (key) => inst(key, 'kt-birth');
    const add = (r, key, type) => r.append(birth, key, { type }, { requestKey: `${key}-${type}-${++seq}`, source: { kind: 'route' } });
    // Timeouts: the row exists only to carry the stall, and goes once it gets through.
    const slow = make({ machine: birth, statementTimeoutMs: 100, stallAfter: 1 });
    await flag('birth-slow', true);
    const created = await add(slow, 'b1', 'Create');
    await slow.drain();
    assert.deepEqual([(await event(created)).status, (await event(created)).attempts], ['pending', 1]);
    assert.deepEqual([(await born('b1')).state, (await born('b1')).flag, Number((await born('b1')).version)], [NONE, 'stalled', 0]);
    await flag('birth-slow', false);
    await sleep(600);
    await slow.drain();
    assert.equal((await event(created)).result, 'accepted');
    assert.deepEqual([(await born('b1')).state, (await born('b1')).flag, Number((await born('b1')).version)], ['alive', null, 1]);
    // A throw: faulted, later events held, and a retry creates it as if nothing happened.
    const r = make({ machine: birth });
    await flag('birth-boom', true);
    const boom = await add(r, 'b2', 'Create');
    const poke = await add(r, 'b2', 'Poke');
    await r.drain();
    assert.deepEqual([(await event(boom)).result, (await event(boom)).state_before], ['faulted', NONE]);
    assert.equal((await event(poke)).status, 'held');
    assert.deepEqual([(await born('b2')).state, (await born('b2')).flag], [NONE, 'faulted']);
    await flag('birth-boom', false);
    await r.release('kt-birth', 'b2', { mode: 'retry', actor: 'admin:1' });
    await r.drain();
    assert.deepEqual([(await event(boom)).result, (await event(poke)).result], ['accepted', 'accepted']);
    assert.deepEqual([(await born('b2')).state, (await born('b2')).data.pokes, Number((await born('b2')).version)], ['alive', 1, 2]);
  });

  await t.test('K15 a new instance is created once, even when an earlier event commits late', async () => {
    // Event A is appended in a caller's transaction that commits after event
    // B (both creating) is already being processed: the two slots hold
    // different events of one instance that has no row yet.
    const caller = await other.connect();
    const second = make({ pool: other });
    try {
      await caller.query('BEGIN');
      const a = await rt.append(machine, 'k15-new', { type: 'Create', payload: { start: 1 } },
        { requestKey: 'k15-new-a', source: { kind: 'route' }, db: caller });
      const b = await route('k15-new', 'Create', { start: 2, sleepMs: 400 });
      const first = rt.processNext();          // takes B (A is not visible yet) and sleeps in its facts
      await sleep(100);
      await caller.query('COMMIT');
      const late = second.processNext();       // takes A, the head now
      await Promise.all([first, late]);
      await rt.drain();
      const results = [(await event(a)).result, (await event(b)).result];
      assert.deepEqual(results.sort(), ['accepted', 'rejected'], 'one creation, the other refused');
      assert.equal(Number((await inst('k15-new')).version), 1, 'one transition, not two at version 1');
      assert.equal((await event(a)).reason, 'exists', 'A was applied after B, to the instance B created');
    } finally {
      caller.release();
    }
  });

  await t.test('K1 a retry that waited behind its original replays it', async () => {
    // The same request twice: the copy appended in a caller's transaction
    // commits late, so it is picked while the original is being applied, and
    // waits for the instance. Its receipt lookup must see the original's.
    await create('k1-late');
    const caller = await other.connect();
    const second = make({ pool: other });
    try {
      await caller.query('BEGIN');
      const copy = await rt.append(machine, 'k1-late', { type: 'Add', payload: { n: 1, sleepMs: 400 } },
        { requestKey: 'k1-late-add', source: { kind: 'route' }, actor: 'user:1', db: caller });
      const original = await route('k1-late', 'Add', { n: 1, sleepMs: 400 }, { requestKey: 'k1-late-add' });
      const first = rt.processNext();
      await sleep(100);
      await caller.query('COMMIT');
      await Promise.all([first, second.processNext()]);
      assert.equal((await event(original)).result, 'accepted');
      assert.deepEqual([(await event(copy)).result, (await event(copy)).emitted], ['replayed', { replayOf: original }]);
      assert.equal((await inst('k1-late')).data.count, 1, 'applied once');
    } finally {
      caller.release();
    }
  });

  await t.test('K5 a transition locks only its own instance; a message to a locked instance does not wait', async () => {
    await create('k5-a');
    await create('k5-b');
    const holder = await other.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM wf_instances WHERE machine = 'kt-counter' AND key = 'k5-b' FOR UPDATE`);
      const send = await route('k5-a', 'Send', { to: 'k5-b', ns: [1] });
      const quick = make({ lockTimeoutMs: 150 });
      await quick.drain();
      assert.equal((await event(send)).result, 'accepted');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    await rt.drain();
    assert.equal((await inst('k5-b')).data.count, 1);
  });

  await t.test('K10/K14 messages: appended with their cause, ordered, exactly once, rejections visible', async () => {
    await create('k10-a');
    await create('k10-b');
    const send = await route('k10-a', 'Send', { to: 'k10-b', ns: [1, 2, 0, 3] });
    await rt.drain();
    const sent = (await event(send)).emitted.messages.map((m) => m.eventId);
    const caused = (await inspect.instance(pool, 'kt-counter', 'k10-b')).events.filter((e) => e.causedBy === send).reverse();
    assert.deepEqual(caused.map((e) => e.id), sent, 'the cause lists what it emitted');
    assert.deepEqual(caused.map((e) => [e.type, e.result, e.reason]), [
      ['Add', 'accepted', null], ['Add', 'accepted', null], ['Add', 'rejected', 'not_positive'], ['Add', 'accepted', null],
    ]);
    assert.deepEqual((await inst('k10-b')).data.log, [1, 2, 3]);
    const first = caused[0];
    assert.equal(first.requestKey, `msg:${send}:0`);
    assert.deepEqual(first.source, { kind: 'message', from: { machine: 'kt-counter', key: 'k10-a', eventId: send } });
    assert.deepEqual(first.cause, { machine: 'kt-counter', key: 'k10-a', type: 'Send' }, 'the effect names its cause');
    // A duplicate delivery of the same message replays.
    const dup = await rt.append('kt-counter', 'k10-b', { type: 'Add', payload: { n: 1 } },
      { requestKey: `msg:${send}:0`, source: first.source, causedBy: send });
    await rt.drain();
    assert.equal((await event(dup)).result, 'replayed');
    assert.deepEqual((await inst('k10-b')).data.log, [1, 2, 3]);
  });

  await t.test('K6/K9 work: one item per key, results settle it, stale results are refused', async () => {
    await create('k6');
    await route('k6', 'Work', { workKey: 'w1' });
    await route('k6', 'Work', { workKey: 'w1' });
    await rt.drain();
    const { rows: items } = await pool.query(`SELECT * FROM wf_work WHERE key = 'k6'`);
    assert.equal(items.length, 1, 're-emitting a work key creates nothing');
    assert.equal(await rt.runServices(), 1);
    const reported = (await pool.query(`SELECT status FROM wf_work WHERE id = $1`, [items[0].id])).rows[0];
    assert.equal(reported.status, 'reported', 'the service reports, it does not settle');
    await rt.drain();
    const data = (await inst('k6')).data;
    assert.deepEqual(data.results, [['ok', 'w1', { echoed: 'w1', attempt: 1 }]]);
    assert.equal((await pool.query(`SELECT status FROM wf_work WHERE id = $1`, [items[0].id])).rows[0].status, 'settled');
    // A result for work the instance no longer expects fails its guard; the item still settles.
    await route('k6', 'Work', { workKey: 'w2', keys: ['w2', 'w3'] });
    await rt.drain();
    await rt.runServices();
    await rt.drain();
    const { rows: results } = await pool.query(
      `SELECT payload->>'workKey' AS key, result, reason FROM wf_events WHERE key = 'k6' AND type = 'WorkSucceeded' ORDER BY id`);
    const stale = results.find((r) => r.key === 'w3');
    assert.equal(stale.result, 'rejected');
    assert.equal(stale.reason, 'stale_result');
    assert.deepEqual((await pool.query(`SELECT DISTINCT status FROM wf_work WHERE key = 'k6'`)).rows, [{ status: 'settled' }]);
    // A forged result is refused: wrong source, or work that is not this instance's.
    const forged = await rt.append('kt-counter', 'k6', { type: 'WorkSucceeded', payload: { workId: items[0].id, kind: 'kt.echo', workKey: 'w2', attempt: 9 } },
      { requestKey: 'forged', source: { kind: 'route' } });
    const foreign = await rt.append('kt-counter', 'k1', { type: 'WorkSucceeded', payload: { workId: items[0].id, kind: 'kt.echo', workKey: 'w1', attempt: 1 } },
      { requestKey: 'foreign', source: { kind: 'service', workId: items[0].id, workKind: 'kt.echo', attempt: 1 } });
    await rt.drain();
    assert.equal((await event(forged)).reason, 'not_a_service_result');
    assert.equal((await event(foreign)).reason, 'unknown_work');
    // Terminal states still accept work results.
    await route('k6', 'Work', { workKey: 'w4' });
    await route('k6', 'Close');
    await rt.drain();
    await rt.runServices();
    await rt.drain();
    assert.equal((await inst('k6')).data.late, 'w4');
  });

  await t.test('K7 a lost lease reports nothing; the next claim resumes from the checkpoint', async () => {
    await create('k7');
    let release;
    const gate = new Promise((r) => { release = r; });
    const seen = [];
    handlers['k7-w'] = async (ctx) => {
      seen.push(ctx.resumeFrom);
      if (ctx.resumeFrom) return { resumed: ctx.resumeFrom };
      await ctx.checkpoint({ step: 'submitted' });
      await gate;
      await ctx.checkpoint({ step: 'done' }); // the claim is gone: throws
      return { finished: true };
    };
    await route('k7', 'Work', { workKey: 'k7-w' });
    await rt.drain();
    const run = rt.runServices();
    await sleep(100);
    await pool.query(`UPDATE wf_work SET lease_until = now() - interval '1 second' WHERE work_key = 'k7-w'`);
    release();
    await run;
    let item = (await pool.query(`SELECT * FROM wf_work WHERE work_key = 'k7-w'`)).rows[0];
    assert.equal(item.status, 'running', 'nothing was reported');
    assert.deepEqual(item.checkpoint, { step: 'submitted' });
    await rt.runServices();
    item = (await pool.query(`SELECT * FROM wf_work WHERE work_key = 'k7-w'`)).rows[0];
    assert.equal(item.status, 'reported');
    assert.equal(item.attempt_count, 2);
    assert.deepEqual(seen, [null, { step: 'submitted' }]);
    const attempts = (await pool.query(`SELECT outcome FROM wf_work_attempts WHERE work_id = $1 ORDER BY number`, [item.id])).rows;
    assert.deepEqual(attempts.map((a) => a.outcome), ['lost', 'succeeded']);
    await rt.drain();
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE key = 'k7' AND type LIKE 'Work%ed'`)).rows[0].n, 1);
  });

  await t.test('K7 a stopping process reports work that finished anyway, and nothing for work that ended on the stop', async () => {
    await create('k7s');
    let release;
    const gate = new Promise((r) => { release = r; });
    const started = new Set();
    // One finishes its step whatever the signal says (a deploy); one gives up on it.
    handlers['k7s-done'] = async () => { started.add('done'); await gate; return { finished: true }; };
    handlers['k7s-quit'] = async (ctx) => {
      if (ctx.attempt > 1) return { resumed: true };
      started.add('quit');
      await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
    };
    await route('k7s', 'Work', { keys: ['k7s-done', 'k7s-quit'], workKey: 'k7s-done' });
    await rt.drain();
    const r = make({ slots: 1 });
    await r.start({ loops: true, slots: false });
    while (started.size < 2) await sleep(20);
    const stopped = r.stop();
    release();
    await stopped;
    const items = new Map((await pool.query(`SELECT work_key, status FROM wf_work WHERE work_key LIKE 'k7s-%'`)).rows.map((w) => [w.work_key, w.status]));
    assert.equal(items.get('k7s-done'), 'reported', 'its result is kept, not run again after the lease');
    assert.equal(items.get('k7s-quit'), 'running', 'nothing reported; the next claim resumes it');
    await rt.drain();
    assert.deepEqual((await inst('k7s')).data.results.map((x) => x.slice(0, 2)), [['ok', 'k7s-done']]);
    // Its lease lapses and the next claim finishes it, so no later test meets it.
    await sleep(700);
    await rt.runServices();
    await rt.drain();
    assert.equal((await pool.query(`SELECT status FROM wf_work WHERE work_key = 'k7s-quit'`)).rows[0].status, 'settled');
  });

  await t.test('K7 a work item that continues an earlier one starts from its checkpoint', async () => {
    await create('k7c');
    const seen = new Map();
    handlers['k7c-1'] = async (ctx) => {
      await ctx.checkpoint({ closed: true, commented: true });
      throw Object.assign(new Error('after the comment'), { permanent: true });
    };
    handlers['k7c-2'] = handlers['k7c-3'] = async (ctx) => { seen.set(ctx.key, ctx.resumeFrom); return { done: true }; };
    await route('k7c', 'Work', { workKey: 'k7c-1' });
    await rt.drain();
    await rt.runServices();
    await rt.drain();
    await route('k7c', 'Work', { workKey: 'k7c-2', continues: 'k7c-1' });
    await route('k7c', 'Work', { workKey: 'k7c-3' });
    await rt.drain();
    await rt.runServices();
    assert.deepEqual(seen.get('k7c-2'), { closed: true, commented: true }, 'the continuing item resumes');
    assert.equal(seen.get('k7c-3'), null, 'an item that names nothing starts fresh');
  });

  await t.test('K8/K13 retries are bounded and reported; accepted work runs with admission off', async () => {
    await create('k8');
    await route('k8', 'Work', { workKey: 'k8-fail', mode: 'fail' });
    await route('k8', 'Work', { workKey: 'k8-bad', keys: ['k8-bad'], mode: 'permanent' });
    await rt.drain();
    await pool.query(`UPDATE kt_flags SET on_off = FALSE WHERE name = 'admission'`);
    await rt.runServices();
    await rt.runServices();
    await rt.drain();
    await pool.query(`UPDATE kt_flags SET on_off = TRUE WHERE name = 'admission'`);
    const results = (await inst('k8')).data.results;
    assert.deepEqual(results.map((r) => r.slice(0, 2)).sort(), [['exhausted', 'k8-fail'], ['failed', 'k8-bad']]);
    assert.deepEqual(results.find((r) => r[0] === 'exhausted')[2], 2, 'maxAttempts');
    const problems = await inspect.problems(pool);
    assert.ok(problems.work.some((w) => w.workKey === 'k8-fail'), 'exhausted work is a problem');
  });

  await t.test('K11 a timer fires once per version, from any number of loops', async () => {
    await create('k11');
    await route('k11', 'Arm', { ms: -1000 });
    await rt.drain();
    const armed = await inst('k11');
    assert.ok(armed.deadline_at);
    const second = make({ pool: other });
    const fired = await Promise.all([rt.fireTimers(), second.fireTimers(), rt.fireTimers()]);
    assert.equal(fired.reduce((a, b) => a + b, 0), 1);
    const { rows: [tick] } = await pool.query(`SELECT * FROM wf_events WHERE key = 'k11' AND type = 'Tick'`);
    assert.equal(tick.request_key, `timer:${armed.deadline_version}`);
    assert.equal(tick.source.kind, 'timer');
    const dup = await rt.append('kt-counter', 'k11', { type: 'Tick', payload: tick.payload },
      { requestKey: tick.request_key, source: tick.source, actor: 'timer' });
    await rt.drain();
    assert.equal((await event(dup)).result, 'replayed');
    const after = await inst('k11');
    assert.equal(after.data.ticks, 1);
    assert.equal(after.deadline_at, null);
    // A deadline in the future does not fire.
    await route('k11', 'Arm', { ms: 60000 });
    await rt.drain();
    assert.equal(await rt.fireTimers(), 0);
  });

  await t.test('K11 a deadline set earlier than the timer loop\'s wake-up wakes it, not the fallback', async () => {
    const r = make({ pollMs: 60000 });
    await r.start({ loops: true });
    try {
      await route('k11-wake', 'Create');
      await sleep(300);  // the loop has looked and gone to sleep, a minute away at the earliest
      const started = Date.now();
      await route('k11-wake', 'Arm', { ms: 700 });
      while (!(await inst('k11-wake'))?.data?.ticks) {
        assert.ok(Date.now() - started < 5000, 'fired by its own announcement, not the 60 s fallback');
        await sleep(50);
      }
      assert.ok(Date.now() - started >= 600, 'not before it was due');
    } finally {
      await r.stop();
    }
  });

  await t.test('K15 serial per instance, concurrent across instances and processes', async () => {
    const a = make({ slots: 4 });
    const b = make({ pool: other, slots: 4 });
    const keys = Array.from({ length: 6 }, (_, i) => `k15-${i}`);
    for (const key of keys) await route(key, 'Create');
    for (let i = 0; i < 6; i++) for (const key of keys) await route(key, 'Add', { n: i + 1, sleepMs: 10 });
    await a.start({ loops: true });
    await b.start({ loops: true });
    const deadline = Date.now() + 30000;
    while ((await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE key LIKE 'k15-%' AND status <> 'processed'`)).rows[0].n) {
      assert.ok(Date.now() < deadline, 'events drained');
      await sleep(50);
    }
    await a.stop();
    await b.stop();
    for (const key of keys) {
      const row = await inst(key);
      assert.deepEqual(row.data.log, [1, 2, 3, 4, 5, 6], `${key}: applied in stream order`);
      assert.equal(row.data.overlaps, 0, `${key}: never processed by two slots at once`);
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT machine_version FROM wf_events WHERE key LIKE 'k15-%'`);
    assert.deepEqual(rows, [{ machine_version: 1 }]);
  });

  await t.test('K15 a process never applies events to an instance a newer version wrote', async () => {
    const v2 = counter({ version: 2 });
    const newer = make({ machine: v2 });
    await create('k15-v');
    await newer.append(v2, 'k15-v', { type: 'Add', payload: { n: 1 } }, { requestKey: 'v2-1', source: { kind: 'route' } });
    await newer.drain();
    assert.equal((await inst('k15-v')).machine_version, 2);
    const pending = await route('k15-v', 'Add', { n: 1 });
    assert.equal(await rt.drain(), 0, 'the old version leaves it pending');
    assert.equal((await event(pending)).status, 'pending');
    await newer.drain();
    assert.equal((await event(pending)).result, 'accepted');
  });

  await t.test('K12/K15 only the pipeline writes machine state and owned columns', async () => {
    await create('k12');
    await assert.rejects(pool.query(`UPDATE wf_instances SET state = 'closed' WHERE key = 'k12'`), /WF_OWNERSHIP_VIOLATION/);
    await assert.rejects(pool.query(`DELETE FROM wf_instances WHERE key = 'k12'`), /WF_OWNERSHIP_VIOLATION/);
    await assert.rejects(pool.query(`INSERT INTO wf_receipts (machine, key, request_key, payload_hash, outcome, event_id) VALUES ('kt-counter', 'k12', 'x', 'h', '{}', 1)`), /WF_OWNERSHIP_VIOLATION/);
    await assert.rejects(pool.query(`UPDATE wf_events SET result = 'accepted' WHERE key = 'k12'`), /WF_OWNERSHIP_VIOLATION/);
    await assert.rejects(pool.query(
      `INSERT INTO wf_events (machine, key, type, source, request_key, status, result) VALUES ('kt-counter', 'k12', 'Add', '{}', 'y', 'processed', 'accepted')`),
    /WF_OWNERSHIP_VIOLATION/, 'nobody appends an already-processed event');
    // Owned legacy columns: the projection may write them, nothing else may.
    assert.equal((await pool.query(`SELECT status FROM kt_legacy WHERE key = 'k12'`)).rows[0].status, 'active:0');
    await assert.rejects(pool.query(`UPDATE kt_legacy SET status = 'x' WHERE key = 'k12'`), /WF_OWNERSHIP_VIOLATION: kt_legacy.status/);
    await assert.rejects(pool.query(`UPDATE kt_legacy SET payload = payload || '{"appliedAt": 99}' WHERE key = 'k12'`), /kt_legacy.payload.appliedAt/);
    await pool.query(`UPDATE kt_legacy SET note = 'fine', payload = payload || '{"other": 1}' WHERE key = 'k12'`);
    await pool.query(`INSERT INTO kt_legacy (key, status) VALUES ('free:1', 'a')`);
    await pool.query(`UPDATE kt_legacy SET status = 'b' WHERE key = 'free:1'`); // outside the WHEN clause
    // Log mode allows and records.
    await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('ownership_mode', 'log')`);
    await pool.query(`UPDATE kt_legacy SET status = 'x' WHERE key = 'k12'`);
    await pool.query(`DELETE FROM wf_settings WHERE key = 'ownership_mode'`);
    const { ownershipViolations } = await inspect.problems(pool);
    assert.deepEqual(ownershipViolations.map((v) => [v.table_name, v.column_path, v.count]), [['kt_legacy', 'status', 1]]);
  });

  await t.test('the problems name each write outside a machine: row, application, statement', async () => {
    const { ownershipViolationRows: rows } = await inspect.problems(pool);
    const legacyId = Number((await pool.query(`SELECT id FROM kt_legacy WHERE key = 'k12'`)).rows[0].id);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].table, rows[0].column, rows[0].row], ['kt_legacy', 'status', { id: legacyId }]);
    assert.equal(typeof rows[0].application, 'string');
    assert.match(rows[0].query, /UPDATE kt_legacy SET status = 'x'/);
  });

  await t.test('K17 appendAndWait answers with the outcome, or pending within its budget', async () => {
    await create('k17');
    const waiting = await rt.appendAndWait(machine, 'k17', { type: 'Add', payload: { n: 1 } },
      { requestKey: 'k17-a', source: { kind: 'route' }, actor: 'user:1', waitMs: 150 });
    assert.equal(waiting.status, 'pending');
    assert.equal(waiting.requestKey, 'k17-a');
    await rt.drain();
    assert.equal((await event(waiting.eventId)).result, 'accepted');
    // State moves on; the replay below still answers with the original reply.
    await route('k17', 'Add', { n: 5 });
    await rt.drain();
    const r = make({ slots: 1 });
    await r.start({ loops: true });
    const started = Date.now();
    const replay = await r.appendAndWait(machine, 'k17', { type: 'Add', payload: { n: 1 } },
      { requestKey: 'k17-a', source: { kind: 'route' }, actor: 'user:1', waitMs: 5000 });
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.version, 2);
    assert.deepEqual(replay.reply, { count: 1, projected: 'active:1' }, 'the reply recorded with the receipt');
    assert.equal((await inst('k17')).data.count, 6);
    const fresh = await r.appendAndWait(machine, 'k17', { type: 'Add', payload: { n: 0 } },
      { requestKey: 'k17-b', source: { kind: 'route' }, actor: 'user:1', waitMs: 5000 });
    assert.deepEqual([fresh.status, fresh.reason], ['rejected', 'not_positive']);
    assert.ok(Date.now() - started < 3000, 'answered by notification, not by the budget');
    await r.stop();
    assert.ok(notified > 0, 'post-commit notifiers ran');
  });

  await t.test('admin reads: state counts, instance list and timeline', async () => {
    const counts = await inspect.stateCounts(pool, 'kt-counter');
    assert.ok(counts.find((c) => c.state === 'active').count > 5);
    const list = await inspect.listInstances(pool, { machine: 'kt-counter', appId: 7, state: 'closed' });
    assert.deepEqual(list.map((i) => i.key), ['k6']);
    const { instance, events, work } = await inspect.instance(pool, 'kt-counter', 'k6');
    assert.equal(instance.state, 'closed');
    assert.ok(events.length > 5);
    assert.ok(events.every((e) => e.result && e.stateBefore && e.source));
    assert.ok(work.every((w) => w.attempts.length >= 1));
  });

  await t.test('retention purges old history, not instances', async () => {
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      UPDATE wf_events SET processed_at = now() - interval '100 days' WHERE key = 'k6';
      UPDATE wf_work SET settled_at = now() - interval '100 days' WHERE key = 'k6';
      UPDATE wf_instances SET updated_at = now() - interval '40 days' WHERE key = 'k6'; COMMIT`);
    await rt.purge();
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE key = 'k6'`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_work WHERE key = 'k6'`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_receipts WHERE key = 'k6'`)).rows[0].n, 0);
    assert.equal((await inst('k6')).state, 'closed');
    assert.ok((await pool.query(`SELECT count(*)::int AS n FROM wf_receipts WHERE key = 'k1'`)).rows[0].n > 0);
  });
});
