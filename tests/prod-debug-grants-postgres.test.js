'use strict';

// Real ACLs, including grants left by an older release. Each run creates its
// own database and role; TEST_DATABASE_URL must allow CREATEDB/CREATEROLE.
// Only the role identifier is substituted at the database boundary so the
// actual bootstrap/runQuery code cannot collide with another test's role.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const { Client, Pool } = require('pg');

const quote = name => `"${name.replaceAll('"', '""')}"`;
const marker = 'FAKE_PRIVATE_DEBUG_FIXTURE';

function debugModule(pool, role) {
  const original = Module._load;
  const modulePath = require.resolve('../src/services/debug-access');
  Module._load = function (name) {
    if (name === '../db/pool') return { getPool: () => ({
      query: (sql, values) => pool.query(sql.replaceAll('usernode_debug_ro', role), values),
    }) };
    if (name === 'pg') return { Pool: class extends Pool {
      constructor(options) { super({ ...options, user: role }); }
    } };
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
  pool = new Pool({ connectionString: url.href, max: 2 });
  const config = { databaseUrl: url.href, dataEncryptionKey: crypto.randomBytes(32).toString('hex') };
  await pool.query(`
    CREATE TABLE platform_db_roles (role TEXT PRIMARY KEY, ok BOOLEAN, reason TEXT,
      secret_enc TEXT, release TEXT, ensured_at TIMESTAMPTZ);
    CREATE TABLE apps (id INTEGER, slug TEXT, status TEXT, db_password TEXT, future_private TEXT);
    CREATE TABLE users (id INTEGER, username TEXT, password TEXT);
    CREATE TABLE chat_sessions (id INTEGER, app_id INTEGER, status TEXT, active_turn JSONB, spec_md TEXT);
    INSERT INTO apps VALUES (1, 'fake-project', 'running', '${marker}', '${marker}');
    INSERT INTO users VALUES (1, 'fake-user', '${marker}');
    INSERT INTO chat_sessions VALUES (1, 1, 'active', '{"input":"${marker}"}', '${marker}');
  `);
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
    sms_otp_codes: ['session_hash', 'code_hash', 'phone_e164'],
    new_private_store: ['content'],
  };
  for (const [table, columns] of Object.entries(privateFields)) {
    await pool.query(`CREATE TABLE ${quote(table)} (id INTEGER, status TEXT, state TEXT,
      ${columns.map(column => `${quote(column)} TEXT`).join(', ')})`);
    await pool.query(`INSERT INTO ${quote(table)} VALUES (1, 'queued', 'running',
      ${columns.map(() => `'${marker}'`).join(', ')})`);
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
    assert.equal((await before.query('SELECT input FROM wf_work')).rows[0].input, marker,
      'positive control: a stale role can read the synthetic private marker');
  } finally { await before.end(); }

  debug = debugModule(pool, role);
  await debug.ensureRole(config);
  assert.equal(debug.isAvailable(), true);
  const read = sql => debug.runQuery(sql, { config });
  assert.deepEqual((await read(`SELECT a.slug, a.status, s.status AS session_status
    FROM apps a JOIN chat_sessions s ON s.app_id = a.id`)).rows,
  [{ slug: 'fake-project', status: 'running', session_status: 'active' }]);
  assert.deepEqual((await read('SELECT status, count(*)::int AS n FROM wf_work GROUP BY status')).rows,
    [{ status: 'queued', n: 1 }]);
  assert.deepEqual((await read('SELECT state FROM wf_instances')).rows, [{ state: 'running' }]);
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
    'SELECT w.input FROM apps a JOIN wf_work w ON a.id = w.id',
    'SELECT input FROM (SELECT input FROM wf_work) t',
  ]) await denied(sql);

  // Column ACLs remain narrow even before another bootstrap runs.
  await pool.query(`ALTER TABLE apps ADD COLUMN later_private TEXT DEFAULT '${marker}'`);
  await denied('SELECT later_private FROM apps');
  await debug.ensureRole(config);
  await denied('SELECT later_private FROM apps');
  assert.equal((await read('SELECT id FROM apps')).rows[0].id, 1);
  await assert.rejects(read("UPDATE apps SET status = 'changed'"), { code: '25006' });
  // Even changing the read-only default cannot manufacture write grants.
  await read('SET default_transaction_read_only = off');
  await denied("UPDATE apps SET status = 'changed'");
});
