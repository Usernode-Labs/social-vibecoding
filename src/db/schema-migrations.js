'use strict';

const path = require('node:path');
const { Pool } = require('pg');
const log = require('../services/logger');
const { connectionName } = require('./connection-options');

// Separate from the legacy server boot lock: Kubernetes and previews use
// this lock too, on the SAME connection that performs and records the DDL.
const MIGRATION_LOCK = 0x5343484d; // SCHM
const directory = path.join(__dirname, 'migrations');
const { loadPlan } = require('./schema-source');

function pendingMigrations(plan, applied) {
  if (applied.length > plan.length) throw new Error('Database schema is newer than this build');
  applied.forEach((row, index) => {
    const migration = plan[index];
    if (row.id !== migration.id || row.checksum !== migration.sha256
        || row.schema_sha256 !== migration.schemaSha256) {
      throw new Error('Schema migration history differs from this build; never edit applied migrations');
    }
  });
  return plan.slice(applied.length);
}

// Only the trusted preview builder calls this, AFTER it materializes the
// deployed schema.sql and sanitizes imported rows. Receipts come from this
// build's verified files, never from production or proposal-controlled data.
// An ordinary legacy database must apply migrations, not use this shortcut.
function snapshotHistorySql({ dir = directory } = {}) {
  const rows = loadPlan(dir).map(m => ({ id: m.id, checksum: m.sha256, schema_sha256: m.schemaSha256 }));
  // IDs and checksums have already passed strict alphabet validation.
  const values = JSON.stringify(rows);
  return `DO $snapshot_history$ BEGIN
    IF EXISTS (SELECT 1 FROM public.schema_migrations) THEN
      RAISE EXCEPTION 'Trusted snapshot migration history must start empty';
    END IF;
    END $snapshot_history$;
    INSERT INTO public.schema_migrations (id, checksum, schema_sha256)
      SELECT id, checksum, schema_sha256 FROM jsonb_to_recordset('${values}'::jsonb)
        AS receipt(id text, checksum text, schema_sha256 text);`;
}

// pg_blocking_pids identifies ACTUAL blockers, including an idle transaction.
// Basic identity and lock metadata are readable without pg_read_all_stats;
// state/age can be null for another role. Never select query text or grant
// runtime accounts broader visibility merely to diagnose a deployment.
const BLOCKERS_SQL = `
  SELECT w.locktype, w.mode, w.relation::regclass::text AS relation,
         b.pid AS blocker_pid, a.usename, a.application_name, a.state,
         EXTRACT(epoch FROM clock_timestamp() - a.xact_start)::int AS transaction_age_seconds
    FROM pg_catalog.pg_locks w
    CROSS JOIN LATERAL unnest(pg_catalog.pg_blocking_pids($1::int)) b(pid)
    LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = b.pid
   WHERE w.pid = $1::int AND NOT w.granted
   LIMIT 20`;

function observeSchemaLocks(pool, pid, { intervalMs = 1000 } = {}) {
  // A separate, bounded connection works even when the migration pool has
  // capacity one. It is closed before the runner returns, success or failure.
  const observer = new Pool({ ...pool.options, password: pool.options.password, max: 1,
    application_name: connectionName('schema-observer'), connectionTimeoutMillis: 1000,
    query_timeout: 1500, statement_timeout: 1000 });
  let timer;
  let pending;
  let stopped = false;
  let failed = false;
  const reportFailure = error => {
    if (!failed) log.warn('db', 'Schema lock diagnostics unavailable', { code: error.code });
    failed = true;
  };
  observer.on('error', reportFailure);
  const sample = () => {
    pending = observer.query(BLOCKERS_SQL, [pid]).then(({ rows }) => {
      if (rows.length) log.warn('db', 'Schema migration waiting for database locks', { migrationPid: pid, blockers: rows });
    }).catch(reportFailure).finally(() => {
      if (!stopped) timer = setTimeout(sample, intervalMs).unref();
    });
  };
  timer = setTimeout(sample, intervalMs).unref();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
    await observer.end();
  };
}

async function retry(client, label, fn, { retries, retryDelayMs }) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (!['55P03', '40P01'].includes(error.code) || attempt >= retries) throw error;
      log.warn('db', 'Schema migration lock conflict; retrying', {
        migration: label, code: error.code, attempt, maxAttempts: retries,
      });
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function applySchemaWithLockRetry(pool, {
  dir = directory, lockTimeoutMs = 10000, retries = 25, retryDelayMs = 3000,
  observe = observeSchemaLocks,
} = {}) {
  // Validate all files before opening a connection or making any DB change.
  const plan = loadPlan(dir);
  const client = await pool.connect();
  let stopObserving;
  try {
    await client.query("SELECT set_config('lock_timeout', $1, false)", [`${lockTimeoutMs}ms`]);
    const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
    stopObserving = observe(pool, pid);
    await retry(client, 'migration serialization',
      () => client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]), { retries, retryDelayMs });

    const { rows: [{ journal }] } = await client.query("SELECT to_regclass('public.schema_migrations')::text AS journal");
    const applied = journal
      ? (await client.query('SELECT id, checksum, schema_sha256 FROM public.schema_migrations ORDER BY id')).rows
      : [];
    const pending = pendingMigrations(plan, applied);
    for (const migration of pending) {
      await retry(client, migration.id, async () => {
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(`INSERT INTO public.schema_migrations (id, checksum, schema_sha256)
            VALUES ($1, $2, $3)`, [migration.id, migration.sha256, migration.schemaSha256]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }, { retries, retryDelayMs });
      log.info('db', 'Schema migration applied', { migration: migration.id });
    }
    log.info('db', 'Schema migration history verified', { applied: pending.length, current: plan.at(-1).id });
  } finally {
    // Closing also releases the session advisory lock and lock_timeout, even
    // after a failed COMMIT or broken connection; never leak either to callers.
    client.release(true);
    try { await stopObserving?.(); }
    catch (error) { log.warn('db', 'Schema lock diagnostic cleanup failed', { code: error.code }); }
  }
}

module.exports = { applySchemaWithLockRetry, loadPlan, pendingMigrations, snapshotHistorySql, observeSchemaLocks, BLOCKERS_SQL };
