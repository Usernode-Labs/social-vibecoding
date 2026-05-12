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

  // Enforce the public/private convention documented in
  // src/prompts/app-conventions.md. The TEMPLATE clone above brings
  // schema + rows wholesale; the two passes below redact prod rows so
  // staging clients see the structure but none of the production data.
  //
  // Pass 1 — table-level: any table tagged
  //   COMMENT ON TABLE foo IS 'staging:private'
  // is TRUNCATEd. Use this for tables whose every row is sensitive
  // (sessions, app_secrets, llm_usage, …).
  //
  // Pass 2 — column-level: any column tagged
  //   COMMENT ON COLUMN foo.bar IS 'staging:private'
  // is UPDATE'd to NULL (or a sentinel for NOT NULL columns), with the
  // surrounding row left intact. Use this for tables where the row
  // identity is useful in staging (FK targets for attribution) but a
  // few columns carry secrets — the canonical case is `users`, where
  // username + id + pubkey survive but password / API keys / wallet
  // tokens get redacted.
  //
  // Failures in either pass are fatal — refusing to spawn a staging
  // container is strictly safer than spawning one that leaks. Tables
  // truncated in pass 1 are no-ops for pass 2 (UPDATE on empty), so
  // tagging both levels on the same table is harmless.
  await truncatePrivateTables(targetDb);
  await scrubPrivateColumns(targetDb);

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
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;

// Sentinel for NOT NULL columns scrubbed by `staging:private`. Chosen
// to be obviously non-functional in any auth or token-comparison path:
// bcrypt-style hashes start with `$2{a,b,y}$`, so bcrypt.compare
// against this string returns false for every input. Same shape works
// for any opaque-token column (wallet links, API keys); the auth path
// would need to special-case the literal to ever accept it, and we
// don't.
const STAGING_REDACTED_SENTINEL = '__staging_redacted__';

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

async function scrubPrivateColumns(targetDb) {
  // Discovery query mirrors truncatePrivateTables but at the column
  // level. col_description is the column-comment counterpart of
  // obj_description. attnum > 0 filters out system columns; attisdropped
  // skips logically-removed columns that pg keeps as zombies. Output is
  // pipe-separated triples: <schema.table>|<column>|<not_null t/f>.
  const discoverySql = `
SELECT n.nspname || '.' || c.relname,
       a.attname,
       a.attnotnull
  FROM pg_attribute a
  JOIN pg_class    c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE col_description(a.attrelid, a.attnum) = 'staging:private'
   AND c.relkind = 'r'
   AND a.attnum > 0
   AND NOT a.attisdropped
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 1, 2`.trim();

  let stdout;
  try {
    stdout = await execInTarget(targetDb, discoverySql, { tuplesOnly: true });
  } catch (err) {
    log.error('db-manager', 'staging:private column discovery failed', {
      targetDb, err: err.message,
    });
    throw new Error(
      `Failed to discover staging:private columns in ${targetDb}: ${err.message}`
    );
  }

  const targets = (stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      // psql -At with the default field separator '|'. Three fields
      // and the third is exactly 't' or 'f' from a bool column.
      const [qualified, column, notNullRaw] = line.split('|');
      return { qualified, column, notNull: notNullRaw === 't' };
    });

  if (targets.length === 0) {
    log.info('db-manager', 'No staging:private columns to scrub', { targetDb });
    return { scrubbed: [] };
  }

  log.info('db-manager', 'Scrubbing staging:private columns', {
    targetDb,
    count: targets.length,
    columns: targets.map((t) => `${t.qualified}.${t.column}`),
  });

  const failures = [];
  const scrubbed = [];
  for (const { qualified, column, notNull } of targets) {
    if (!SAFE_QUALIFIED_IDENT.test(qualified) || !SAFE_IDENT.test(column)) {
      log.warn('db-manager', 'Refusing to UPDATE non-standard identifier', {
        targetDb, qualified, column,
      });
      failures.push({ target: `${qualified}.${column}`, error: 'unsafe identifier' });
      continue;
    }
    // NOT NULL columns can't accept NULL; substitute a sentinel that's
    // safe to store and obviously non-functional. Auth code should
    // never accept this literal in any code path — bcrypt.compare
    // against it returns false for every plaintext, which is the only
    // place today that meaningfully reads users.password.
    const value = notNull
      ? `'${STAGING_REDACTED_SENTINEL}'`
      : 'NULL';
    try {
      await execInTarget(targetDb, `UPDATE ${qualified} SET ${column} = ${value}`);
      scrubbed.push(`${qualified}.${column}`);
    } catch (err) {
      log.error('db-manager', 'staging:private column UPDATE failed', {
        targetDb, qualified, column, err: err.message,
      });
      failures.push({ target: `${qualified}.${column}`, error: err.message });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to scrub ${failures.length} staging:private column(s) in ${targetDb}: ` +
      failures.map((f) => `${f.target} (${f.error})`).join('; ')
    );
  }

  return { scrubbed };
}

module.exports = {
  appDbName,
  stagingDbName,
  createDatabase,
  dropDatabase,
  cloneDatabase,
  connectionUrl,
  truncatePrivateTables,
  scrubPrivateColumns,
};
