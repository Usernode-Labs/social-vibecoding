const { execFile } = require('child_process');
const { promisify } = require('util');
const log = require('./logger');

const execFileAsync = promisify(execFile);

const DB_CONTAINER = process.env.DB_CONTAINER || 'project-usernode-db';
const DB_USER = process.env.DB_USER || 'usernode';

function appDbName(slug) {
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}`;
}

function stagingDbName(slug, username, commitHash) {
  const shortHash = commitHash.substring(0, 6);
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_${username.replace(/[^a-z0-9_]/g, '_')}_${shortHash}`;
}

async function createDatabase(dbName) {
  log.info('db-manager', 'Creating database', { dbName });
  try {
    await execInDb(`CREATE DATABASE ${dbName}`);
    log.info('db-manager', 'Database created', { dbName });
  } catch (err) {
    if (err.message?.includes('already exists')) {
      log.info('db-manager', 'Database already exists', { dbName });
      return;
    }
    throw err;
  }
}

async function dropDatabase(dbName) {
  log.info('db-manager', 'Dropping database', { dbName });
  try {
    await execInDb(`DROP DATABASE IF EXISTS ${dbName}`);
    log.info('db-manager', 'Database dropped', { dbName });
  } catch (err) {
    log.warn('db-manager', 'Failed to drop database', { dbName, err: err.message });
  }
}

async function cloneDatabase(sourceDb, targetDb) {
  log.info('db-manager', 'Cloning database', { sourceDb, targetDb });

  await dropDatabase(targetDb);

  // Terminate active connections to source
  await execInDb(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${sourceDb}' AND pid <> pg_backend_pid()`
  ).catch(() => {});

  await execInDb(`CREATE DATABASE ${targetDb} TEMPLATE ${sourceDb}`);

  // Enforce the public/private table convention documented in
  // src/prompts/app-conventions.md: any table tagged
  // `COMMENT ON TABLE foo IS 'staging:private'` is copied schema-only.
  // The TEMPLATE clone above brings schema + rows wholesale; this pass
  // empties private tables so staging clients get the structure but
  // none of the production rows. Failures are fatal — refusing to spawn
  // a staging container is strictly safer than spawning one that leaks
  // private data.
  await truncatePrivateTables(targetDb);

  log.info('db-manager', 'Database cloned', { sourceDb, targetDb });
}

async function connectionUrl(dbName) {
  const password = process.env.USERNODE_DB_PASSWORD || 'localdev';
  return `postgres://${DB_USER}:${password}@${DB_CONTAINER}:5432/${dbName}`;
}

async function execInDb(sql) {
  return execInTarget('usernode', sql);
}

async function execInTarget(dbName, sql, opts = {}) {
  const args = ['exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', dbName];
  if (opts.tuplesOnly) {
    // -A unaligned, -t tuples-only — produces clean newline-separated
    // values with no header/footer, suitable for parsing.
    args.push('-At');
  }
  args.push('-c', sql);

  const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 30000 });

  if (stderr && !stderr.includes('NOTICE')) {
    throw new Error(stderr);
  }
  return stdout;
}

// Strict allow-list for fully-qualified table names returned from
// pg_catalog. PG identifiers can technically contain anything when
// quoted, but our own dapps create tables via plain DDL and the worst
// case here is a malicious app declaring a table whose name escapes
// shell/SQL — rejecting unusual names costs us nothing since no real
// app uses them.
const SAFE_QUALIFIED_IDENT = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i;

async function truncatePrivateTables(targetDb) {
  // Discovery query. obj_description on pg_class returns the comment
  // attached via `COMMENT ON TABLE foo IS '...'`. relkind='r' filters
  // to ordinary tables (not views/indexes/sequences). We exclude
  // pg_catalog/information_schema defensively even though they
  // shouldn't have user comments.
  const discoverySql = `
SELECT n.nspname || '.' || c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE obj_description(c.oid, 'pg_class') = 'staging:private'
   AND c.relkind = 'r'
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 1`.trim();

  let stdout;
  try {
    stdout = await execInTarget(targetDb, discoverySql, { tuplesOnly: true });
  } catch (err) {
    // Discovery failure is fatal: we don't know what's private, so we
    // can't safely ship the staging clone.
    log.error('db-manager', 'staging:private discovery failed', {
      targetDb, err: err.message,
    });
    throw new Error(
      `Failed to discover staging:private tables in ${targetDb}: ${err.message}`
    );
  }

  const qualifiedNames = (stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (qualifiedNames.length === 0) {
    log.info('db-manager', 'No staging:private tables to truncate', { targetDb });
    return { truncated: [] };
  }

  log.info('db-manager', 'Truncating staging:private tables', {
    targetDb, count: qualifiedNames.length, tables: qualifiedNames,
  });

  // Per-table failures are collected rather than short-circuiting so
  // we don't leave half the private tables full because one failed.
  // After the pass, if anything failed, throw — a partial truncate is
  // still a leaky clone.
  const failures = [];
  const truncated = [];
  for (const qualified of qualifiedNames) {
    if (!SAFE_QUALIFIED_IDENT.test(qualified)) {
      log.warn('db-manager', 'Refusing to TRUNCATE non-standard identifier', {
        targetDb, qualified,
      });
      failures.push({ table: qualified, error: 'unsafe identifier' });
      continue;
    }
    try {
      await execInTarget(targetDb, `TRUNCATE ${qualified} RESTART IDENTITY CASCADE`);
      truncated.push(qualified);
    } catch (err) {
      log.error('db-manager', 'TRUNCATE failed', {
        targetDb, table: qualified, err: err.message,
      });
      failures.push({ table: qualified, error: err.message });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to truncate ${failures.length} staging:private table(s) in ${targetDb}: ` +
      failures.map((f) => `${f.table} (${f.error})`).join('; ')
    );
  }

  return { truncated };
}

module.exports = {
  appDbName,
  stagingDbName,
  createDatabase,
  dropDatabase,
  cloneDatabase,
  connectionUrl,
  truncatePrivateTables,
};
