'use strict';

// Deadlocks while a shots pair is written (src/services/db-retry.js). The
// fixture rows and demo states go into the two copies while both booted
// apps run against the same databases, and the run's own state change locks
// the run and its proposal in the opposite order to createRun: each can
// lose a deadlock (40P01) to work that has nothing to do with the proposal.
// Pinned here, with pg replaced by fakes:
//   - a fixture write that loses one is rolled back and run again on a fresh
//     connection; one that keeps losing fails with Postgres's own message;
//     any other failure fails at once, as before;
//   - the two-sided demo-state write is rolled back on BOTH sides and run
//     again whole, never just the state; on the last attempt such a state is
//     left out like any other; and once COMMIT was sent nothing runs again;
//   - a run's state change that loses one is run again from the same patch.
//
// tests/shots-db-retry-postgres.test.js makes a real deadlock.
//
// Run with: node --test tests/shots-db-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
const noWait = { wait: async () => {} };

// A fresh copy of shots-fixtures and shots-demo-states over a fake pg Client.
// `answer(db, sql, params)` returns a result, or throws to fail the query.
function loadWithFakePg(answer) {
  const ids = {
    pg: require.resolve('pg'),
    fixtures: require.resolve('../src/services/shots-fixtures'),
    demo: require.resolve('../src/services/shots-demo-states'),
    logger: require.resolve('../src/services/logger'),
    dbRetry: require.resolve('../src/services/db-retry'),
    dbManager: require.resolve('../src/services/db-manager'),
  };
  const saved = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, require.cache[id]]));
  const clients = [];
  class FakeClient extends EventEmitter {
    constructor(config) {
      super();
      this.db = new URL(config.connectionString).pathname.slice(1);
      this.statements = [];
      this.ended = false;
      clients.push(this);
    }
    async connect() {}
    async query(sql, params) {
      assert.equal(this.ended, false, 'no query on a closed connection');
      this.statements.push(String(sql).trim());
      return answer(this.db, String(sql), params);
    }
    async end() { this.ended = true; }
  }
  require.cache[ids.pg] = { id: ids.pg, filename: ids.pg, loaded: true, exports: { Client: FakeClient }, paths: [] };
  require.cache[ids.logger] = {
    id: ids.logger, filename: ids.logger, loaded: true, paths: [],
    exports: { info() {}, warn() {}, error() {}, debug() {} },
  };
  for (const key of ['fixtures', 'demo', 'dbRetry', 'dbManager']) delete require.cache[ids[key]];
  const fixtures = require(ids.fixtures);
  const demo = require(ids.demo);
  const restore = () => {
    for (const [key, id] of Object.entries(ids)) {
      if (saved[key]) require.cache[id] = saved[key]; else delete require.cache[id];
    }
  };
  return { fixtures, demo, clients, restore };
}

const URL_A = 'postgres://u:p@127.0.0.1:5432/app_demo_shots_aaaaaaaaaaaa_b';
const URL_B = 'postgres://u:p@127.0.0.1:5432/app_demo_shots_aaaaaaaaaaaa_h';

test('a fixture write that loses a deadlock is rolled back and run again on a fresh connection', async () => {
  let failures = 1;
  const { fixtures, clients, restore } = loadWithFakePg((db, sql) => {
    if (/^INSERT INTO fixture/.test(sql) && failures > 0) { failures -= 1; throw deadlock(); }
    return { rowCount: 1, rows: [] };
  });
  try {
    const written = await fixtures.inTransaction(URL_A, async (client) => {
      await client.query('INSERT INTO fixture VALUES (1)');
      return 'written';
    }, { retry: noWait });
    assert.equal(written, 'written');
    assert.equal(clients.length, 2, 'each attempt has its own connection');
    assert.deepEqual(clients[0].statements, ['BEGIN', 'INSERT INTO fixture VALUES (1)', 'ROLLBACK']);
    assert.deepEqual(clients[1].statements, ['BEGIN', 'INSERT INTO fixture VALUES (1)', 'COMMIT']);
    assert.ok(clients.every((client) => client.ended));
  } finally { restore(); }
});

test('a fixture write that keeps losing fails with Postgres\'s message; any other failure fails at once', async () => {
  const { fixtures, clients, restore } = loadWithFakePg((db, sql) => {
    if (/^INSERT INTO fixture/.test(sql)) throw deadlock();
    if (/^INSERT INTO other/.test(sql)) throw Object.assign(new Error('duplicate key value'), { code: '23505' });
    return { rowCount: 1, rows: [] };
  });
  try {
    await assert.rejects(fixtures.inTransaction(URL_A, (client) => client.query('INSERT INTO fixture VALUES (1)'),
      { retry: noWait }), { code: '40P01', message: 'deadlock detected' });
    assert.equal(clients.length, 3, 'three attempts');
    assert.ok(clients.every((client) => client.statements.at(-1) === 'ROLLBACK'));

    clients.length = 0;
    await assert.rejects(fixtures.inTransaction(URL_A, (client) => client.query('INSERT INTO other VALUES (1)'),
      { retry: noWait }), /duplicate key value/);
    assert.equal(clients.length, 1, 'not a conflict: no retry');
  } finally { restore(); }
});

test('every fixture write goes through the retrying transaction', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/services/shots-fixtures'), 'utf8');
  for (const name of ['ensureFullAdminIdentity', 'ensureHostedAppFixture', 'copyMemberAgentSession', 'copyFullAdminAgentSession']) {
    const body = source.slice(source.indexOf(`async function ${name}(`));
    const end = body.indexOf('\n}\n');
    assert.match(body.slice(0, end), /return inTransaction\(databaseUrl, /, name);
  }
  assert.ok(!/query\('BEGIN'\)/.test(source.replace(/async function inTransaction[^]*?\n}\n/, '')),
    'no fixture opens a transaction of its own');
});

// The personas and platform app context() reads, on either side.
function demoAnswer(fail = () => false) {
  return (db, sql) => {
    if (fail(db, sql)) throw deadlock();
    if (/FROM users\s+WHERE username IN/.test(sql)) {
      return { rowCount: 2, rows: [
        { id: 1, username: 'usernode-capture', is_admin: false },
        { id: 2, username: 'usernode-capture-admin', is_admin: true },
      ] };
    }
    if (/SELECT id FROM apps WHERE slug/.test(sql)) return { rowCount: 1, rows: [{ id: 7 }] };
    return { rowCount: 1, rows: [] };
  };
}
const demoInputs = { base: { databaseUrl: URL_A, selfAppSlug: 'demo' }, head: { databaseUrl: URL_B, selfAppSlug: 'demo' } };
const state = (id) => ({
  id, persona: 'member',
  async install(client) {
    await client.query(`INSERT INTO state_rows VALUES ('${id}')`);
    return { shows: [{ state: id, path: '/' }] };
  },
});

test('a demo state that loses a deadlock reruns the whole two-sided write, not just the state', async () => {
  let failures = 1;
  const { demo, clients, restore } = loadWithFakePg(demoAnswer((db, sql) =>
    db.endsWith('_h') && /'second'/.test(sql) && failures-- > 0));
  try {
    const result = await demo._installInStepForTest(demoInputs, [state('first'), state('second')], { retry: noWait });
    assert.deepEqual(result.installed.map((s) => s.id), ['first', 'second'], 'nothing left out for a deadlock');
    assert.deepEqual(result.skipped, []);
    assert.equal(clients.length, 4, 'two attempts, each with both sides');
    for (const client of clients.slice(0, 2)) {
      assert.equal(client.statements.at(-1), 'ROLLBACK', `${client.db}: the first attempt is rolled back whole`);
      assert.ok(!client.statements.includes('ROLLBACK TO SAVEPOINT shots_demo_state'), 'not just to the savepoint');
      assert.ok(!client.statements.includes('COMMIT'));
    }
    for (const client of clients.slice(2)) {
      assert.equal(client.statements.filter((sql) => sql === 'BEGIN').length, 1);
      assert.equal(client.statements.at(-1), 'COMMIT', `${client.db}: the second attempt commits`);
    }
  } finally { restore(); }
});

test('on the last attempt a state that keeps losing is left out like any other, and the rest still go in', async () => {
  const { demo, clients, restore } = loadWithFakePg(demoAnswer((db, sql) => db.endsWith('_b') && /'second'/.test(sql)));
  try {
    const result = await demo._installInStepForTest(demoInputs, [state('first'), state('second')], { retry: noWait });
    assert.deepEqual(result.installed.map((s) => s.id), ['first']);
    assert.deepEqual(result.skipped, [{ id: 'second', code: '40P01' }]);
    assert.equal(clients.length, 6, 'three attempts');
    assert.ok(clients.slice(4).every((client) => client.statements.includes('ROLLBACK TO SAVEPOINT shots_demo_state')
      && client.statements.at(-1) === 'COMMIT'));
  } finally { restore(); }
});

test('once COMMIT was sent, a deadlock is not run again: one side may already hold the states', async () => {
  const { demo, clients, restore } = loadWithFakePg(demoAnswer((db, sql) => db.endsWith('_h') && sql === 'COMMIT'));
  try {
    await assert.rejects(demo._installInStepForTest(demoInputs, [state('first')], { retry: noWait }),
      { code: '40P01' });
    assert.equal(clients.length, 2, 'one attempt');
  } finally { restore(); }
});

test('a state that fails for its own reasons is still left out at once, with no rerun', async () => {
  const { demo, clients, restore } = loadWithFakePg((db, sql) => {
    if (/'second'/.test(sql)) throw Object.assign(new Error('column "x" does not exist'), { code: '42703' });
    return demoAnswer()(db, sql);
  });
  try {
    const result = await demo._installInStepForTest(demoInputs, [state('first'), state('second')], { retry: noWait });
    assert.deepEqual(result.skipped, [{ id: 'second', code: '42703' }]);
    assert.equal(clients.length, 2);
  } finally { restore(); }
});

test('a run\'s state change that loses a deadlock runs again from the same patch', async () => {
  const shotsState = require('../src/services/shots-state');
  const RUN_ID = 'e'.repeat(32);
  const row = {
    id: RUN_ID, session_id: 42, current_run_id: RUN_ID, state: 'provisioning',
    plan_hash: null, hard_verdict: null, failure_reason: null, updated_at: new Date(),
  };
  const transactions = [];
  let failures = 1;
  const pool = {
    query: async () => { throw new Error('the transition runs on its own client'); },
    async connect() {
      const statements = [];
      transactions.push(statements);
      return {
        release() {},
        async query(sql, values) {
          statements.push({ sql: String(sql).trim(), values });
          if (/FOR UPDATE OF r, s/.test(sql)) return { rows: [{ ...row }] };
          if (/^UPDATE shot_runs/.test(String(sql).trim())) return { rows: [{ ...row, state: values[1] }] };
          // The proposal's row, locked last: where the other order meets it.
          if (/UPDATE chat_sessions/.test(sql)) {
            if (failures-- > 0) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
            return { rowCount: 1 };
          }
          return { rows: [] };
        },
      };
    },
  };
  const patch = {
    failureCode: '40P01', failureReason: 'deadlock detected',
    traceMerge: { interruptedBy: 'shutdown' }, recoveryMinIdleMs: 0,
  };
  const next = await shotsState.transitionRun(pool, RUN_ID, 'failed', patch, { retry: noWait });
  assert.equal(next.state, 'failed');
  assert.equal(transactions.length, 2);
  assert.deepEqual(transactions[0].map((s) => s.sql.split(/\s+/)[0]), ['BEGIN', 'SELECT', 'UPDATE', 'UPDATE', 'ROLLBACK']);
  const update = transactions[1].find((s) => /^UPDATE shot_runs/.test(s.sql));
  assert.ok(update.values.includes(JSON.stringify({ interruptedBy: 'shutdown' })),
    'the retry still merges the trace: the first attempt did not use the patch up');
  assert.ok(update.values.includes('deadlock detected'));
  assert.ok('traceMerge' in patch && 'recoveryMinIdleMs' in patch, 'the caller\'s patch is left as it was');
});
