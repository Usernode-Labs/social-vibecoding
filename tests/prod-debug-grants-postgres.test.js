'use strict';

// Real ACLs and drift detection against the complete application schema.
// lint:sql also requires this policy check on its existing shadow schema,
// even when this optional local suite skips without TEST_DATABASE_URL.
// Each run owns its database/role; TEST_DATABASE_URL needs CREATEDB/CREATEROLE.
// Only the role identifier is substituted at the database boundary so the
// actual bootstrap/runQuery code cannot collide with another test's role.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const { Client, Pool } = require('pg');
const { verifyDebugRole } = require('../src/services/debug-role-policy');

const quote = name => `"${name.replaceAll('"', '""')}"`;
const marker = 'FAKE_PRIVATE_DEBUG_FIXTURE';

function debugModule(pool, role) {
  const original = Module._load;
  const modulePath = require.resolve('../src/services/debug-access');
  Module._load = function (name) {
    if (name === '../db/pool') return { getPool: () => ({
      query: (sql, values) => pool.query(sql.replaceAll('usernode_debug_ro', role),
        values?.map(value => value === 'usernode_debug_ro' ? role : value)),
    }) };
    if (name === 'pg') return { Pool: class extends Pool {
      constructor(options) { super({ ...options, user: role }); }
    } };
    if (name === './debug-role-policy') return { verifyDebugRole: (pool, options) =>
      verifyDebugRole(pool, { ...options, role }) };
    return original.apply(this, arguments);
  };
  delete require.cache[modulePath];
  try { return require(modulePath); } finally {
    Module._load = original;
    delete require.cache[modulePath];
  }
}

test('production debug bootstrap removes old grants and exposes only reviewed metadata', {
  skip: !process.env.TEST_DATABASE_URL,
}, async t => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const database = `debug_acl_${suffix}`, role = `debug_acl_ro_${suffix}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  let pool, debug;
  t.after(async () => {
    debug?.closePool();
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${quote(role)}`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE ${quote(database)} TEMPLATE template0`);
  await admin.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD 'fake-old-debug-password'`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  pool = new Pool({ connectionString: url.href, max: 1 });
  const config = { databaseUrl: url.href, dataEncryptionKey: crypto.randomBytes(32).toString('hex') };
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows: [owner] } = await pool.query(
    'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id', ['fake-debug-user', marker]);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url, status, db_password)
     VALUES ('Fake fixture', 'fake-project', $1, 'https://example.invalid/fake', 'running', $2) RETURNING id`, [owner.id, marker]);
  await pool.query(`CREATE TABLE new_private_store (content TEXT);
    INSERT INTO new_private_store VALUES ('${marker}');
    ALTER TABLE apps ADD COLUMN future_private TEXT DEFAULT '${marker}'`);
  const privateFields = {
    agent_sessions: ['summary_md', 'focus_context', 'active_turn'],
    agent_session_drafts: ['content'],
    chat_session_messages: ['content', 'metadata'],
    wf_instances: ['data', 'deadline_event', 'flag_detail'],
    wf_events: ['payload', 'source', 'error', 'emitted', 'reply', 'reason'],
    wf_receipts: ['outcome'],
    wf_work: ['input', 'checkpoint', 'last_error', 'result'],
    wf_work_attempts: ['error'],
    stream_events: ['event'],
    new_private_store: ['content'],
  };
  const { rows: inventory } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
  for (const [table, columns] of Object.entries(privateFields)) {
    privateFields[table] = columns.filter(column => inventory.some(row => row.table_name === table && row.column_name === column));
    assert.ok(privateFields[table].length, `${table} retains a private field`);
  }
  await pool.query(`
    CREATE VIEW old_private_view AS SELECT input FROM wf_work;
    CREATE MATERIALIZED VIEW old_private_materialized AS SELECT input FROM wf_work;
    CREATE TABLE "odd-table" ("odd-column" TEXT);
    INSERT INTO "odd-table" VALUES ('${marker}');
    GRANT USAGE ON SCHEMA public TO ${quote(role)};
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quote(role)};
    GRANT SELECT (input) ON wf_work TO ${quote(role)};
    GRANT SELECT (input) ON old_private_view TO ${quote(role)};
    GRANT SELECT (input) ON old_private_materialized TO ${quote(role)};
    GRANT SELECT ("odd-column") ON "odd-table" TO ${quote(role)};
    GRANT SELECT (future_private) ON apps TO ${quote(role)};
  `);
  const before = new Client({ host: url.hostname, port: Number(url.port) || 5432,
    database, user: role, password: 'fake-old-debug-password' });
  await before.connect();
  try {
    assert.equal((await before.query('SELECT password FROM users WHERE id = $1', [owner.id])).rows[0].password, marker,
      'positive control: a stale role can read the synthetic private marker');
  } finally { await before.end(); }

  debug = debugModule(pool, role);
  await debug.ensureRole(config);
  assert.equal(debug.isAvailable(), true);
  const read = sql => debug.runQuery(sql, { config });
  assert.deepEqual((await read(`SELECT slug, status FROM apps WHERE id = ${app.id}`)).rows,
    [{ slug: 'fake-project', status: 'running' }]);
  assert.deepEqual((await read('SELECT status FROM wf_work LIMIT 0')).rows, []);
  assert.deepEqual((await read('SELECT state FROM wf_instances LIMIT 0')).rows, []);
  const denied = async sql => assert.rejects(read(sql), { code: '42501' }, sql);
  for (const [table, columns] of Object.entries(privateFields)) {
    for (const column of columns) await denied(`SELECT ${quote(column)} FROM ${quote(table)}`);
    await denied(`SELECT row_to_json(t) FROM ${quote(table)} t`);
  }
  for (const sql of [
    'SELECT password FROM users', 'SELECT db_password FROM apps',
    'SELECT future_private FROM apps', 'SELECT active_turn, spec_md FROM chat_sessions',
    'SELECT input FROM old_private_view', 'SELECT input FROM old_private_materialized',
    'SELECT "odd-column" FROM "odd-table"',
    'SELECT w.input FROM apps a JOIN wf_work w ON TRUE',
    'SELECT input FROM (SELECT input FROM wf_work) t',
  ]) await denied(sql);

  // Column ACLs remain narrow even before another bootstrap runs.
  await pool.query(`ALTER TABLE apps ADD COLUMN later_private TEXT DEFAULT '${marker}'`);
  await denied('SELECT later_private FROM apps');
  await debug.ensureRole(config);
  await denied('SELECT later_private FROM apps');
  assert.equal((await read(`SELECT id FROM apps WHERE id = ${app.id}`)).rows[0].id, app.id);
  await assert.rejects(read("UPDATE apps SET status = 'changed'"), { code: '25006' });
  // Even changing the read-only default cannot manufacture write grants.
  await read('SET default_transaction_read_only = off');
  await denied("UPDATE apps SET status = 'changed'");

  const verify = () => verifyDebugRole(pool, { role, readableColumns: debug.READABLE_COLUMNS, requireAllColumns: true });
  const ddl = [];
  const originalQuery = pool.query.bind(pool);
  pool.query = (sql, values) => {
    if (typeof sql === 'string' && /^\s*(GRANT|REVOKE|ALTER|DO)\b/.test(sql)) ddl.push(sql);
    return originalQuery(sql, values);
  };
  await debug.ensureRole(config);
  assert.deepEqual(ddl, [], 'a verified role keeps its password and executes no permission DDL');
  for (const drift of [
    `REVOKE SELECT (id) ON apps FROM ${quote(role)}`,
    `GRANT UPDATE (status) ON apps TO ${quote(role)}`,
    `GRANT SELECT ON new_private_store TO ${quote(role)}`,
    `ALTER ROLE ${quote(role)} SET default_transaction_read_only = off`,
    `ALTER ROLE ${quote(role)} IN DATABASE ${quote(database)} SET statement_timeout = '1h'`,
    `ALTER ROLE ${quote(role)} PASSWORD 'changed-outside-the-record'`,
  ]) {
    await pool.query(drift);
    ddl.length = 0;
    await debug.ensureRole(config);
    assert.equal(debug.isAvailable(), true, `repair succeeds: ${drift}`);
    await verify();
    assert.ok(ddl.length, 'drift triggers role or permission repair');
    assert.equal((await read(`SELECT id FROM apps WHERE id = ${app.id}`)).rows[0].id, app.id);
    ddl.length = 0;
    await debug.ensureRole(config);
    assert.deepEqual(ddl, [], 'an already-repaired role needs no repeated permission DDL');
  }
  await pool.query(`DROP OWNED BY ${quote(role)}; DROP ROLE ${quote(role)}`);
  await debug.ensureRole(config);
  assert.equal(debug.isAvailable(), true, 'a dropped role is recreated from the declared policy');
  await verify();
  const checked = await verify();
  t.diagnostic(`complete-schema catalog audit: ${checked.columns} approved columns, ${checked.durationMs} ms`);
  // Roll back every fault, including cluster-wide role/default ACL changes.
  const faults = [
    ['PUBLIC private grant', 'GRANT SELECT ON new_private_store TO PUBLIC', /unexpected SELECT/],
    ['membership', `CREATE ROLE ${quote(`alternate_${suffix}`)};
      GRANT ${quote(`alternate_${suffix}`)} TO ${quote(role)}`, /role membership/],
    ['ownership', `ALTER TABLE new_private_store OWNER TO ${quote(role)}`, /unexpected SELECT|write privilege/],
    ['privileged function', `CREATE FUNCTION synthetic_private_reader() RETURNS TEXT LANGUAGE SQL
      SECURITY DEFINER AS 'SELECT content FROM new_private_store LIMIT 1'`, /privileged function authority/],
    ['other schema', `CREATE SCHEMA synthetic_private; GRANT USAGE ON SCHEMA synthetic_private TO ${quote(role)}`, /schema authority/],
    ['default grants', `ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${quote(role)}`, /future object grant/],
    ['PUBLIC default grants', 'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC', /future object grant/],
    ['sequence grant', `GRANT USAGE ON SEQUENCE users_id_seq TO ${quote(role)}`, /sequence authority/],
    ['table-wide grant on reviewed metadata', `GRANT SELECT ON platform_processes TO ${quote(role)}`, /table-wide privilege/],
    ['zero-column view', `CREATE VIEW synthetic_count AS SELECT FROM new_private_store;
      GRANT SELECT ON synthetic_count TO PUBLIC`, /table-wide privilege/],
    ['changed type', 'ALTER TABLE llm_usage ALTER COLUMN total_cost_cents TYPE BIGINT', /review column type\/constraints/],
    ['lost constraint', 'ALTER TABLE wf_events DROP CONSTRAINT wf_events_result_check', /review column type\/constraints/],
    // Only the operator's extension is accepted, never a view named like it.
    ['view named like the operator statistics', `CREATE VIEW pg_stat_statements AS SELECT content FROM new_private_store;
      GRANT SELECT ON pg_stat_statements TO PUBLIC`, /unexpected SELECT|table-wide privilege/],
    ['write grant on the operator statistics', `CREATE EXTENSION pg_stat_statements;
      GRANT INSERT ON pg_stat_statements TO ${quote(role)}`, /write privilege|table-wide privilege/],
  ];
  // The database operator installs pg_stat_statements in every database, and
  // the extension grants SELECT on its views to PUBLIC (the production
  // refusal of 23 October to 3 November). Reading them shows statistics, not
  // other roles' query text, so the role is still made.
  await t.test('the operator statistics extension, as installed', async () => {
    await pool.query('BEGIN');
    try {
      await pool.query('CREATE EXTENSION pg_stat_statements');
      const { rows: [grant] } = await pool.query(
        "SELECT has_table_privilege($1, 'pg_stat_statements', 'SELECT') AS readable", [role]);
      assert.equal(grant.readable, true, 'positive control: PUBLIC reaches the debug role');
      await verify();
    } finally { await pool.query('ROLLBACK'); }
  });
  for (const [name, sql, message] of faults) {
    await t.test(name, async () => {
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await assert.rejects(verify(), { code: 'DEBUG_POLICY_MISMATCH', message });
      } finally { await pool.query('ROLLBACK'); }
    });
  }
  await verify();
});
