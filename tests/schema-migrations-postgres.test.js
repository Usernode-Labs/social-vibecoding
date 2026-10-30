'use strict';
// test:changed: when src/db/migrations/ (real migration history)
// test:changed: when src/db/schema.sql (fresh and upgraded catalogs agree)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Pool, Client } = require('pg');
const { applySchemaWithLockRetry: apply, observeSchemaLocks, snapshotHistorySql } = require('../src/db/schema-migrations');
const policy = require('../src/services/platform-preview-data-policy');
const log = require('../src/services/logger');
const { waitFor } = require('./lib/wait-for');
const { connectionName } = require('../src/db/connection-options');
const BASE = process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
const snapshot = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
const journal = snapshot.match(/CREATE TABLE IF NOT EXISTS schema_migrations[\s\S]*?COMMENT ON TABLE schema_migrations IS 'staging:private';/)[0];
const digest = sql => crypto.createHash('sha256').update(sql).digest('hex');
const noObserver = () => async () => {};

async function database(t) {
  if (!BASE) { t.skip('set TEST_DATABASE_URL for real PostgreSQL regression tests'); return; }
  const name = `migration_regression_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: BASE }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(BASE); url.pathname = `/${name}`;
  const pools = [];
  const pool = (extra = {}) => {
    const p = new Pool({ connectionString: String(url), max: 1, connectionTimeoutMillis: 3000, ...extra });
    pools.push(p); return p;
  };
  t.after(async () => {
    await Promise.all(pools.map(p => p.end()));
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  return { pool, admin, url, name };
}
function plan(t, statements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-postgres-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entries = statements.map((sql, i) => ({ id: `${String(i + 1).padStart(4, '0')}-step`,
    sha256: digest(sql), schemaSha256: digest(statements.slice(0, i + 1).join('\n')) }));
  statements.forEach((sql, i) => fs.writeFileSync(path.join(dir, `${entries[i].id}.sql`), sql));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, migrations: entries }));
  return { dir, schema: statements.join('\n'), retries: 1, retryDelayMs: 1, observe: noObserver };
}
const baseline = `CREATE TABLE migration_probe (id int PRIMARY KEY, value int);
  INSERT INTO migration_probe VALUES (1, 0); ${journal}`;

// This checks the actual 17k-line baseline, not a miniature substitute: the
// first rollout must preserve a legacy DB and an unchanged deploy must work
// even while a long transaction is reading an old production table.
test('legacy adoption preserves rows, matches the fresh snapshot and never replays DDL', { timeout: 90000 }, async t => {
  const db = await database(t); if (!db) return;
  const p = db.pool();
  await p.query(snapshot.slice(0, snapshot.lastIndexOf('-- Applied schema changes')));
  await p.query("INSERT INTO users (username, password) VALUES ('existing-person', 'local-only')");
  await apply(p, { observe: noObserver });
  const first = (await p.query('SELECT * FROM schema_migrations')).rows;
  assert.equal(first.length, 1);
  assert.equal((await p.query("SELECT count(*)::int AS n FROM users WHERE username='existing-person'")).rows[0].n, 1);
  await p.query('SET search_path=pg_catalog');
  const upgraded = JSON.parse((await p.query(policy.CATALOG_SQL)).rows[0].inventory);
  // A separate empty DB created directly from schema.sql has exactly the
  // same catalog as the immutable baseline plus all incremental migrations.
  const fresh = await database(t);
  const fp = fresh.pool(); await fp.query(snapshot);
  await fp.query('SET search_path=pg_catalog');
  const created = JSON.parse((await fp.query(policy.CATALOG_SQL)).rows[0].inventory);
  assert.equal(policy.schemaFingerprint(upgraded), policy.schemaFingerprint(created));
  policy.verifyCatalog(upgraded);
  await p.query('SET search_path=public');
  const holder = await db.pool().connect();
  try {
    await holder.query('BEGIN; LOCK TABLE users IN ACCESS SHARE MODE');
    await apply(p, { observe: noObserver, lockTimeoutMs: 100, retries: 1 });
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  assert.deepEqual((await p.query('SELECT * FROM schema_migrations')).rows, first);
});

test('only pending deltas execute; data and DDL roll back together and resume from the last receipt', async t => {
  const db = await database(t); if (!db) return; const p = db.pool();
  const first = plan(t, [baseline]); await apply(p, first);
  const delta = 'ALTER TABLE migration_probe ADD note text; UPDATE migration_probe SET value = value + 1;';
  const second = plan(t, [baseline, delta]); await apply(p, second);
  await apply(p, second);
  assert.equal((await p.query('SELECT value FROM migration_probe')).rows[0].value, 1);
  const broken = plan(t, [baseline, delta, 'ALTER TABLE migration_probe ADD failed int; UPDATE migration_probe SET value=100; SELECT 1/0;']);
  await assert.rejects(apply(p, broken), { code: '22012' });
  assert.equal((await p.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 2);
  assert.equal((await p.query('SELECT value FROM migration_probe')).rows[0].value, 1);
  assert.equal((await p.query("SELECT 1 FROM information_schema.columns WHERE table_name='migration_probe' AND column_name='failed'")).rowCount, 0);
  const fixed = plan(t, [baseline, delta, 'ALTER TABLE migration_probe ADD recovered int;']);
  await apply(p, fixed);
  assert.equal((await p.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 3);
  assert.equal((await p.query('SELECT value FROM migration_probe')).rows[0].value, 1);
  await assert.rejects(apply(p, second), /newer than this build/);
  const changed = plan(t, [baseline, delta.replace('value + 1', 'value + 2'), 'ALTER TABLE migration_probe ADD recovered int;']);
  await assert.rejects(apply(p, changed), /history differs/);
});

test('simultaneous startup applies each migration once with capacity-one pools', async t => {
  const db = await database(t); if (!db) return;
  const f = plan(t, [baseline + ' SELECT pg_sleep(0.1);', 'UPDATE migration_probe SET value=value+1;']);
  await Promise.all([apply(db.pool(), f), apply(db.pool(), f)]);
  assert.equal((await db.pool().query('SELECT value FROM migration_probe')).rows[0].value, 1);
  assert.equal((await db.pool().query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 2);
});

test('lock timeout leaves no partial DDL or receipt; the same migration succeeds when the reader releases', async t => {
  const db = await database(t); if (!db) return; const p = db.pool();
  const first = plan(t, [baseline]); await apply(p, first);
  const second = plan(t, [baseline, 'ALTER TABLE migration_probe ADD waited int;']);
  const holder = await db.pool().connect();
  try {
    await holder.query('BEGIN; LOCK TABLE migration_probe IN ACCESS SHARE MODE');
    await assert.rejects(apply(p, { ...second, lockTimeoutMs: 100 }), { code: '55P03' });
    assert.equal((await db.pool().query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  await apply(p, second);
  assert.equal((await p.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 2);
});

test('an unprivileged observer identifies another role holding a lock without reading SQL', { timeout: 15000 }, async t => {
  const db = await database(t); if (!db) return;
  const previousName = process.env.DB_APPLICATION_NAME;
  process.env.DB_APPLICATION_NAME = 'homeroom-migration';
  t.after(() => {
    if (previousName === undefined) delete process.env.DB_APPLICATION_NAME;
    else process.env.DB_APPLICATION_NAME = previousName;
  });
  const suffix = crypto.randomBytes(6).toString('hex');
  const migrator = `test_migrator_${suffix}`; const reader = `test_reader_${suffix}`;
  await db.admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD 'local-only'; CREATE ROLE ${reader} LOGIN PASSWORD 'local-only'`);
  const root = db.pool();
  await root.query(`GRANT CREATE ON SCHEMA public TO ${migrator}`);
  const url = new URL(db.url); url.username = migrator; url.password = 'local-only';
  const p = db.pool({ connectionString: String(url) });
  const first = plan(t, [baseline]); await apply(p, first);
  await p.query(`GRANT SELECT ON migration_probe TO ${reader}`);
  url.username = reader;
  const holder = await db.pool({ connectionString: String(url), application_name: 'preview-copy-test' }).connect();
  const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await holder.query('BEGIN; SELECT * FROM migration_probe');
  let captured;
  const original = log.warn;
  log.warn = (area, message, details) => {
    if (details?.blockers?.some(b => b.blocker_pid === holderPid)) { captured = details; }
    else original(area, message, details);
  };
  const second = plan(t, [baseline, 'ALTER TABLE migration_probe ADD observed int;']);
  const running = apply(p, { ...second, lockTimeoutMs: 5000,
    observe: (pool, pid) => observeSchemaLocks(pool, pid, { intervalMs: 20 }) });
  try {
    await waitFor(() => captured, { label: 'a diagnostic identifying the reader holding the lock', timeoutMs: 3000 });
    const blocker = captured.blockers.find(b => b.blocker_pid === holderPid);
    assert.equal(blocker.application_name, 'preview-copy-test');
    assert.equal(blocker.usename, reader);
    assert.equal(blocker.relation, 'migration_probe');
    assert.equal(blocker.state, null, 'no pg_read_all_stats grant is needed');
    assert.equal(blocker.transaction_age_seconds, null);
    assert.equal(Object.hasOwn(blocker, 'query'), false);
    const observers = await root.query('SELECT application_name FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1',
      [connectionName('schema-observer')]);
    assert.deepEqual(observers.rows, [{ application_name: 'homeroom-migration-schema-observer' }]);
  } finally {
    await holder.query('ROLLBACK'); holder.release();
    await running.finally(() => { log.warn = original; });
  }
  const remaining = await root.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1',
    [connectionName('schema-observer')]);
  assert.equal(remaining.rows[0].n, 0, 'the observer connection closes after completion');
  // database() owns pool lifetimes; remove roles in a final hook after DROP DB.
  t.after(async () => {
    const admin = new Client({ connectionString: BASE }); await admin.connect();
    try { await admin.query(`DROP ROLE ${migrator}; DROP ROLE ${reader}`); }
    finally { await admin.end(); }
  });
});

test('a trusted current snapshot records its own history without replaying old DDL or data transforms', async t => {
  const db = await database(t); if (!db) return; const p = db.pool();
  const f = plan(t, [baseline, 'ALTER TABLE migration_probe ADD latest int; UPDATE migration_probe SET value=value+1;']);
  await p.query(f.schema); // The trusted preview builder materializes schema.sql.
  await p.query(snapshotHistorySql({ dir: f.dir }));
  await apply(p, f); // A bare ALTER ADD would fail if it ran again.
  assert.equal((await p.query('SELECT value FROM migration_probe')).rows[0].value, 1);
  assert.equal((await p.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 2);
  await assert.rejects(p.query(snapshotHistorySql({ dir: f.dir })), /must start empty/);
});

test('diagnostic connection failures do not fail or stall the migration', async t => {
  const db = await database(t); if (!db) return;
  const f = plan(t, [baseline + ' SELECT pg_sleep(0.2);']);
  const p = db.pool(); let failed = false;
  const original = log.warn;
  log.warn = (area, message, detail) => {
    if (message === 'Schema lock diagnostics unavailable') failed = true;
    else original(area, message, detail);
  };
  try {
    await apply(p, { ...f, observe: (pool, pid) => observeSchemaLocks({ options: { ...pool.options,
      connectionString: undefined, host: '127.0.0.1', port: 1, user: 'local-only' } }, pid, { intervalMs: 10 }) });
    assert.equal(failed, true);
    assert.equal((await p.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 1);
  } finally { log.warn = original; }
});

test('a COMMIT between dollar-containing identifiers is rejected without partial DDL or a receipt', async t => {
  const db = await database(t); if (!db) return; const p = db.pool();
  const first = plan(t, [baseline]); await apply(p, first);
  const create = 'CREATE TABLE first$hide$ (id int); CREATE TABLE second$hide$ (id int);';
  // Prove these are real PostgreSQL identifiers, not quoted-body delimiters.
  await p.query('BEGIN');
  try {
    await p.query(create);
    assert.equal((await p.query("SELECT relname FROM pg_class WHERE oid=to_regclass('first$hide$')")).rows[0].relname, 'first$hide$');
  } finally { await p.query('ROLLBACK'); }
  const broken = plan(t, [baseline, 'CREATE TABLE first$hide$ (id int); COMMIT; CREATE TABLE second$hide$ (id int); SELECT 1/0;']);
  await assert.rejects(apply(p, broken), /must be transactional/);
  assert.deepEqual((await p.query("SELECT to_regclass('first$hide$')::text AS first, to_regclass('second$hide$')::text AS second")).rows,
    [{ first: null, second: null }]);
  assert.equal((await p.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 1);
  const valid = plan(t, [baseline, create]);
  await apply(p, valid);
  assert.equal((await p.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 2);
});

test('boot reference rows match the fresh schema and preserve saved values without schema replay', async t => {
  const db = await database(t); if (!db) return; const p = db.pool();
  const { seedReferenceData } = require('../src/db/reference-data');
  await p.query(snapshot);
  await p.query(snapshotHistorySql());
  const fresh = new Map((await p.query('SELECT key,value,description FROM platform_settings')).rows.map(row => [row.key, row]));
  await p.query('DELETE FROM conversations; DELETE FROM platform_settings;');
  const receipts = (await p.query('SELECT * FROM schema_migrations')).rows;
  await apply(p, { observe: noObserver }); // Recorded schema does not restore any rows.
  assert.equal((await p.query('SELECT count(*)::int n FROM platform_settings')).rows[0].n, 0);
  await seedReferenceData(p);
  const restored = (await p.query('SELECT key,value,description FROM platform_settings')).rows;
  assert.ok(restored.length >= 23, 'restore required defaults, not historical backfill markers');
  const tracking = new Set(['app_outages_tracked_since', 'model_cost_observed_since',
    'homeroom_bot_audience_since', 'platform_live_tracked_since']);
  for (const row of restored) {
    const expected = fresh.get(row.key);
    assert.ok(expected, `the schema snapshot declares default ${row.key}`);
    assert.equal(row.description, expected.description, row.key);
    if (tracking.has(row.key)) assert.ok(Number.isFinite(Date.parse(row.value)), row.key);
    else assert.equal(row.value, expected.value, row.key);
  }
  assert.equal((await p.query("SELECT count(*)::int n FROM conversations WHERE channel_key='general' AND kind='channel'")).rows[0].n, 1);
  await p.query("UPDATE platform_settings SET value='saved',description='Saved by operator' WHERE key='topochain_first_block_points'");
  await p.query("UPDATE conversations SET title='Keep this title' WHERE channel_key='general'");
  const saved = (await p.query('SELECT * FROM platform_settings ORDER BY key')).rows;
  await seedReferenceData(p);
  assert.deepEqual((await p.query('SELECT * FROM platform_settings ORDER BY key')).rows, saved);
  assert.equal((await p.query("SELECT title FROM conversations WHERE channel_key='general'")).rows[0].title, 'Keep this title');
  assert.deepEqual((await p.query('SELECT * FROM schema_migrations')).rows, receipts);
});

test('rendered initialization preserves migration query boundaries with optional semicolons', async t => {
  const db = await database(t); if (!db) return; const p = db.pool();
  const { loadPlan, renderSchema } = require('../src/db/schema-source');
  const f = plan(t, [baseline + ' SELECT 1 -- trailing line comment', 'CREATE TABLE later_file (id int)']);
  await p.query(renderSchema(loadPlan(f.dir), []));
  assert.equal((await p.query("SELECT to_regclass('later_file')::text AS name")).rows[0].name, 'later_file');
});

test('fresh initialization and skipped-release upgrades agree after a reference-data transformation', async t => {
  const legacy = await database(t); if (!legacy) return; const fresh = await database(t);
  const { loadPlan, renderSchema } = require('../src/db/schema-source');
  const base = `CREATE TABLE reference_config (key text PRIMARY KEY, value text); ${journal}`;
  const delta = "UPDATE reference_config SET key='current', value='new-default' WHERE key='old' AND value='old-default'";
  const currentSeeds = "INSERT INTO reference_config VALUES ('current','new-default') ON CONFLICT DO NOTHING";
  const original = plan(t, [base]);
  const lp = legacy.pool(); await apply(lp, original);
  await lp.query("INSERT INTO reference_config VALUES ('old','old-default')");
  const current = plan(t, [base, delta]);
  await apply(lp, current); await lp.query(currentSeeds);
  const fp = fresh.pool();
  await fp.query(renderSchema(loadPlan(current.dir), [currentSeeds]));
  await fp.query(snapshotHistorySql({ dir: current.dir }));
  await apply(fp, current); // A trusted snapshot must not rerun its data transform.
  const rows = async p => (await p.query('SELECT * FROM reference_config ORDER BY key')).rows;
  assert.deepEqual(await rows(lp), [{ key: 'current', value: 'new-default' }]);
  assert.deepEqual(await rows(fp), await rows(lp));
  assert.equal((await fp.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 2);
});
