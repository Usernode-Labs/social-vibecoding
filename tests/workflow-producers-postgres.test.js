'use strict';
// test:changed: when src/db/migrations/0011-workflow-producers.sql (producer stamp and refusal)
// test:changed: when src/services/database-role-grants.js (web's kernel grants)
// test:changed: when src/services/database-role-access.js (workflow authority at boot)

// Who appended a workflow event is the database's word (SEC-09): a login that
// may only append (web's) asks for the events its machine lets it, and writes
// nothing else of the kernel's tables. Real PostgreSQL, a real web login
// granted as a split release grants it, and the real kernel; synthetic data.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime, defineMachine, NONE, ok } = require('../src/workflow/kernel/index.ts');
const { restrictWebWorkflow } = require('../src/services/database-role-grants');
const access = require('../src/services/database-role-access');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// wp-door: Asked is what a route asks for; Settled is the conductor's own.
function door() {
  const any = (p) => p || {};
  return defineMachine({
    name: 'wp-door', version: 1,
    events: { Asked: any, Settled: any },
    create: ['Asked', 'Settled'],
    web: ['Asked'],
    decode: (row) => ({ name: row.state, data: row.data }),
    authorize: { Asked: () => ok(), Settled: () => ok() },
    transitions: {
      [NONE]: {
        Asked: { to: (_s, e) => ({ next: { name: 'open', data: { by: e.producer } }, work: [{ kind: 'wp.run', key: 'run', input: {} }] }) },
        Settled: { to: (_s, e) => ({ next: { name: 'done', data: { by: e.producer } } }) },
      },
      open: {
        Asked: { to: (s, e) => ({ next: { name: 'open', data: { ...s.data, again: e.producer } } }) },
        Settled: { to: (_s, e) => ({ next: { name: 'done', data: { by: e.producer } } }) },
        WorkSucceeded: { to: (s) => ({ next: { name: 'done', data: { ...s.data, worked: true } } }) },
      },
      done: { '*': { ignore: 'done' } },
    },
  });
}

test('web asks for its machines\' events and decides nothing', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const id = crypto.randomBytes(5).toString('hex');
  const db = `wf_producers_${id}`;
  const web = `wf_web_${id}`;
  const reader = `wf_reader_${id}`;
  const password = crypto.randomBytes(18).toString('hex');
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.query(`CREATE ROLE ${web} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE ROLE ${reader} LOGIN PASSWORD '${password}'`);
  const at = (user) => { const u = new URL(DSN); u.pathname = `/${db}`; if (user) { u.username = user; u.password = password; } return String(u); };
  const platform = new Pool({ connectionString: at(), max: 6 });
  const webPool = new Pool({ connectionString: at(web), max: 4 });
  const readerPool = new Pool({ connectionString: at(reader), max: 1 });
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await Promise.all([platform.end(), webPool.end(), readerPool.end()]);
    await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
    await admin.query(`DROP ROLE ${web}`);
    await admin.query(`DROP ROLE ${reader}`);
    await admin.end();
  });
  await platform.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  // What a split release grants a runtime login (database-role-grants.js
  // ensureRuntimeGrants), then what it takes back from web's.
  await platform.query(`GRANT USAGE ON SCHEMA public TO ${web}, ${reader};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${web};
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${web};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${web};
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader}`);
  await restrictWebWorkflow(platform, web);

  const make = (pool) => {
    const r = createRuntime({ pool, machines: [door()], services: { 'wp.run': { run: async () => ({}) } }, pollMs: 50 });
    runtimes.push(r);
    return r;
  };
  const conductor = make(platform);
  const asWeb = make(webPool);
  let n = 0;
  const ask = (rt, type, extra = {}) => rt.append('wp-door', `k${++n}`, { type, payload: {} },
    { requestKey: `r${n}`, source: { kind: 'route', name: 'synthetic' }, ...extra });
  const row = async (eventId) => (await platform.query(
    'SELECT producer, status, result, reason FROM wf_events WHERE id = $1', [eventId])).rows[0];
  const denied = (promise) => assert.rejects(promise, (e) => e.code === '42501');

  await t.test('the database stamps the producer, and web names only what a producer says', async () => {
    const fromWeb = await ask(asWeb, 'Asked');
    const fromPlatform = await ask(conductor, 'Settled');
    assert.equal((await row(fromWeb)).producer, 'web');
    assert.equal((await row(fromPlatform)).producer, 'platform');
    // The kernel's columns (producer, status, outcome, retry time) are not
    // web's to name, marker or not.
    const client = await webPool.connect();
    try {
      for (const [column, value] of [['producer', "'platform'"], ['status', "'processed'"], ['result', "'accepted'"],
        ['retry_at', "'2999-01-01'"], ['reply', "'{}'"], ['attempts', '1'], ['created_at', 'now()']]) {
        await client.query("BEGIN; SET LOCAL app.wf_writer = 'transition'");
        await denied(client.query(`INSERT INTO wf_events (machine, key, type, payload, source, request_key, ${column})
          VALUES ('wp-door', 'forged', 'Asked', '{}', '{"kind":"route"}', 'forged-${column}', ${value})`));
        await client.query('ROLLBACK');
      }
    } finally { client.release(); }
    // What caused an event is the kernel's to say.
    const { rows: [caused] } = await webPool.query(
      `INSERT INTO wf_events (machine, key, type, payload, source, request_key, caused_by)
       VALUES ('wp-door', 'caused', 'Asked', '{}', '{"kind":"route"}', 'reask:' || $1::bigint, $1::bigint) RETURNING id`, [fromPlatform]);
    assert.equal((await platform.query('SELECT caused_by FROM wf_events WHERE id = $1', [caused.id])).rows[0].caused_by, null);
    // The conductor's own writes of the row keep it.
    await platform.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      UPDATE wf_events SET producer = 'platform', attempts = attempts WHERE id = ${fromWeb}; COMMIT`);
    assert.equal((await row(fromWeb)).producer, 'web');
    await conductor.drain();
  });

  await t.test('a refused web event the conductor asks again is still web\'s', async () => {
    const original = await ask(asWeb, 'Settled');
    await conductor.drain();
    assert.equal((await row(original)).reason, 'not_a_producer');
    const again = await conductor.append('wp-door', `k${n}`, { type: 'Settled', payload: {} },
      { requestKey: `reask:${original}`, source: { kind: 'route', name: 'synthetic' }, causedBy: original });
    // A platform event that only names another as its cause stays the platform's.
    const other = await conductor.append('wp-door', `k${n}`, { type: 'Settled', payload: {} },
      { requestKey: 'not-a-reask', source: { kind: 'system' }, causedBy: original });
    assert.equal((await row(again)).producer, 'web');
    assert.equal((await row(other)).producer, 'platform');
    await conductor.drain();
    assert.equal((await row(again)).reason, 'not_a_producer');
  });

  await t.test('a type the build does not know is refused as unknown, so a newer build asks it again', async () => {
    const { rows: [e] } = await webPool.query(`INSERT INTO wf_events (machine, key, type, payload, source, request_key)
      VALUES ('wp-door', 'newer', 'Gained', '{}', '{"kind":"route"}', 'newer') RETURNING id`);
    await conductor.drain();
    assert.equal((await row(e.id)).reason, 'unknown_event');
  });

  await t.test('web is refused an event its machine does not list, before replay', async () => {
    const allowed = await ask(asWeb, 'Asked');
    const refused = await ask(asWeb, 'Settled');
    // The conductor's accepted request, asked again by web under its key.
    const key = `k${++n}`;
    await conductor.append('wp-door', key, { type: 'Settled', payload: {} }, { requestKey: 'same', source: { kind: 'system' } });
    const replay = await asWeb.append('wp-door', key, { type: 'Settled', payload: {} }, { requestKey: 'same', source: { kind: 'system' } });
    await conductor.drain();
    assert.equal((await row(allowed)).result, 'accepted');
    assert.deepEqual(await row(refused), { producer: 'web', status: 'processed', result: 'rejected', reason: 'not_a_producer' });
    assert.equal((await row(replay)).reason, 'not_a_producer');
    const { rows: [inst] } = await platform.query("SELECT data FROM wf_instances WHERE machine = 'wp-door' AND key = $1", [`k${n - 1}`]);
    assert.equal(inst, undefined, 'the refused event created nothing');
  });

  await t.test('web cannot claim a work result, a timer or another machine\'s message', async () => {
    const opened = await ask(conductor, 'Asked');
    await conductor.drain();
    const { rows: [work] } = await platform.query(
      "SELECT id, kind, work_key FROM wf_work WHERE machine = 'wp-door' AND key = $1", [`k${n}`]);
    for (const source of [
      { kind: 'service', workId: work.id, workKind: work.kind, attempt: 1 },
      { kind: 'timer', setAtVersion: 1 },
      { kind: 'message', from: { machine: 'wp-door', key: 'other', eventId: opened } },
    ]) {
      await assert.rejects(asWeb.append('wp-door', `k${n}`, {
        type: 'WorkSucceeded', payload: { workId: work.id, kind: work.kind, workKey: work.work_key, attempt: 1 },
      }, { requestKey: `forged-${source.kind}`, source }), /WF_PRODUCER_REFUSED/);
    }
    // Under a source web may claim, a work result is still not web's.
    const claimed = await asWeb.append('wp-door', `k${n}`, {
      type: 'WorkSucceeded', payload: { workId: work.id, kind: work.kind, workKey: work.work_key, attempt: 1 },
    }, { requestKey: 'forged-system', source: { kind: 'system' } });
    await conductor.drain();
    assert.equal((await row(claimed)).reason, 'not_a_producer');
  });

  await t.test('web writes nothing of the kernel\'s tables, marker or not', async () => {
    const pending = await ask(asWeb, 'Asked');
    const client = await webPool.connect();
    try {
      for (const sql of [
        "INSERT INTO wf_instances (machine, key, state, machine_version) VALUES ('wp-door', 'mine', 'done', 1)",
        "UPDATE wf_instances SET state = 'done'",
        "INSERT INTO wf_work (machine, key, kind, work_key, input) VALUES ('wp-door', 'mine', 'wp.run', 'x', '{}')",
        "UPDATE wf_work SET status = 'queued'",
        "DELETE FROM wf_work_attempts",
        "INSERT INTO wf_receipts (machine, key, request_key, payload_hash, outcome, event_id) VALUES ('wp-door', 'mine', 'r', 'h', '{}', 1)",
        "INSERT INTO wf_settings (key, value) VALUES ('enabled:wp-door', '1')",
        `UPDATE wf_events SET status = 'processed', result = 'accepted' WHERE id = ${pending}`,
        'DELETE FROM wf_events',
        "SELECT setval('wf_events_id_seq', 1)",
      ]) {
        await client.query("BEGIN; SET LOCAL app.wf_writer = 'transition'");
        await denied(client.query(sql));
        await client.query('ROLLBACK');
      }
    } finally { client.release(); }
    assert.equal((await row(pending)).status, 'pending');
    await conductor.drain();
  });

  await t.test('a producer withdraws its own pending request, never another\'s', async () => {
    const mine = await ask(asWeb, 'Asked');
    const theirs = await ask(conductor, 'Settled');
    assert.equal((await asWeb.refuseIfPending(mine, 'expired')).status, 'rejected');
    assert.equal((await asWeb.refuseIfPending(theirs, 'expired')).status, 'pending');
    assert.deepEqual(await row(mine), { producer: 'web', status: 'processed', result: 'rejected', reason: 'expired' });
    assert.equal((await row(theirs)).status, 'pending');
    assert.equal((await conductor.refuseIfPending(theirs, 'stop_unavailable')).reason, 'stop_unavailable');
    await assert.rejects(webPool.query('SELECT wf_refuse_pending($1, $2)', [mine, 'Not a reason']), /WF_INVALID_REFUSAL/);
    // Never a reason the kernel decides with (an unknown event is asked again
    // by the conductor).
    await assert.rejects(webPool.query('SELECT wf_refuse_pending($1, $2)', [await ask(asWeb, 'Asked'), 'unknown_event']), /WF_INVALID_REFUSAL/);
    // The marker it sets for its own update does not outlive it.
    const client = await webPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT wf_refuse_pending($1, $2)', [await ask(asWeb, 'Asked'), 'expired']);
      assert.equal((await client.query("SELECT current_setting('app.wf_writer', true) AS m")).rows[0].m, '');
      await client.query('ROLLBACK');
    } finally { client.release(); }
    // A read-only login cannot call it at all.
    await denied(readerPool.query('SELECT wf_refuse_pending($1, $2)', [theirs, 'expired']));
    await conductor.drain();
  });

  await t.test('boot refuses a login whose workflow authority is not its role\'s', async () => {
    const check = (pool, kind) => access.assertWorkflowAuthority(pool, kind);
    await check(webPool, 'web');
    await assert.rejects(check(webPool, 'conductor'), /workflow authority/);
    await check(platform, 'conductor');
    await assert.rejects(check(platform, 'web'), /workflow authority/);
    for (const grant of [`GRANT UPDATE ON wf_work TO ${web}`, `GRANT INSERT ON wf_events TO ${web}`,
      `GRANT INSERT (retry_at) ON wf_events TO ${web}`]) {
      await platform.query(grant);
      await assert.rejects(check(webPool, 'web'), /workflow authority/, grant);
      await restrictWebWorkflow(platform, web);
      await check(webPool, 'web');
    }
  });

  await t.test('the producer cannot be judged by a function of the caller\'s', async () => {
    // A login with a schema of its own puts a has_table_privilege that says
    // yes ahead of PostgreSQL's (web's own login has no such schema).
    const schema = `wf_shadow_${id}`;
    await platform.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${web}`);
    await webPool.query(`CREATE FUNCTION ${schema}.has_table_privilege(name, oid, text) RETURNS boolean
      LANGUAGE sql AS 'SELECT true'`);
    const client = await webPool.connect();
    try {
      await client.query(`SET search_path = ${schema}, public, pg_catalog`);
      await assert.rejects(client.query(`INSERT INTO wf_events (machine, key, type, payload, source, request_key)
        VALUES ('wp-door', 'shadow', 'WorkSucceeded', '{}', '{"kind":"service"}', 'shadow')`), /WF_PRODUCER_REFUSED/);
    } finally { client.release(); }
  });
});
