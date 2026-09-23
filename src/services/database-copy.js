'use strict';

// Full app-data copy, separate from the intentionally sanitized preview path.
// Provisioning, fencing and binding cutover belong to the orchestration layer.
const { Client } = require('pg');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const exec = promisify(execFile);
const USER_SCHEMA = "n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'";
const digest = (value) => createHash('sha256').update(value).digest('hex');
function failure(code) { return Object.assign(new Error(code), { code }); }
function quote(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

function validateCopy(config) {
  if (!config || !Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1 || config.maxBytes > 256 * 1024 * 1024
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 480000) throw failure('COPY_INVALID_CONFIG');
  for (const conn of [config.source, config.destination]) {
    if (!conn || typeof conn.host !== 'string' || conn.host.length > 253
      || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(conn.host)
      || !Number.isInteger(conn.port) || conn.port < 1 || conn.port > 65535
      || !/^app_[a-z0-9_]{1,53}$/.test(conn.database) || conn.user !== `${conn.database}_owner`
      || typeof conn.password !== 'string' || !conn.password || typeof conn.ca !== 'string'
      || !conn.ca.includes('-----BEGIN CERTIFICATE-----')) throw failure('COPY_INVALID_CONFIG');
  }
  if (config.source.host === config.destination.host) throw failure('COPY_SAME_ENDPOINT');
  return config;
}

function clientOptions(conn, timeoutMs) {
  return { host: conn.host, port: conn.port, database: conn.database, user: conn.user,
    password: conn.password, ssl: { ca: conn.ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 15000, statement_timeout: timeoutMs, query_timeout: timeoutMs,
    application_name: 'sv-database-copy', options: '-c timezone=UTC -c datestyle=ISO,YMD -c extra_float_digits=3' };
}
function toolEnv(conn, caFile, readOnly) {
  // Do not pass the platform's environment or credentials to database tools.
  return { PATH: process.env.PATH, LANG: 'C.UTF-8', PGHOST: conn.host, PGPORT: String(conn.port),
    PGDATABASE: conn.database, PGUSER: conn.user, PGPASSWORD: conn.password,
    PGSSLMODE: 'verify-full', PGSSLROOTCERT: caFile, PGCONNECT_TIMEOUT: '15',
    PGAPPNAME: 'sv-database-copy', ...(readOnly ? { PGOPTIONS: '-c default_transaction_read_only=on' } : {}) };
}
function normalizeSchema(sql) {
  // PostgreSQL generates fresh psql restriction tokens for each plain dump.
  return sql.replace(/^\\(?:un)?restrict [^\r\n]*\r?\n/gm, '');
}
async function schemaHash(env, snapshot, timeoutMs) {
  const args = ['--schema-only', '--no-owner', '--no-privileges', '--no-tablespaces', '--quote-all-identifiers'];
  if (snapshot) args.push(`--snapshot=${snapshot}`);
  try {
    const { stdout } = await exec('pg_dump', args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return digest(normalizeSchema(stdout));
  } catch { throw failure('COPY_SCHEMA_DUMP_FAILED'); }
}
async function streamCopy(sourceEnv, destinationEnv, snapshot, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--no-tablespaces', `--snapshot=${snapshot}`],
    { env: sourceEnv, signal, stdio: ['ignore','pipe','pipe'] });
  const restore = spawn('pg_restore', ['--dbname', destinationEnv.PGDATABASE, '--no-owner', '--no-privileges', '--no-tablespaces', '--single-transaction', '--exit-on-error'],
    { env: destinationEnv, signal, stdio: ['pipe','ignore','pipe'] });
  // Tool errors may contain SQL or row values. Drain them, never publish them.
  dump.stderr.resume(); restore.stderr.resume();
  const exited = (child) => new Promise((resolve, reject) => {
    child.once('error', () => reject(failure('COPY_TOOL_FAILED')));
    child.once('close', (code) => code === 0 ? resolve() : reject(failure('COPY_TOOL_FAILED')));
  });
  const jobs = [exited(dump), exited(restore), pipeline(dump.stdout, restore.stdin)];
  try { await Promise.all(jobs); }
  catch {
    dump.kill('SIGKILL'); restore.kill('SIGKILL');
    await Promise.allSettled(jobs);
    throw failure('COPY_TOOL_FAILED');
  }
}
async function identity(client) {
  return (await client.query(`SELECT current_database() AS database, current_user AS owner,
    inet_server_addr()::text AS address, pg_is_in_recovery() AS recovery,
    current_setting('server_version_num')::integer / 10000 AS version,
    d.datcollate, d.datctype, pg_encoding_to_char(d.encoding) AS encoding,
    pg_get_userbyid(d.datdba) = current_user AS owns_database,
    r.rolsuper, r.rolcreatedb, r.rolcreaterole
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
    WHERE d.datname=current_database()`)).rows[0];
}
function assertIdentities(source, destination, config) {
  for (const [actual, expected] of [[source, config.source], [destination, config.destination]]) {
    if (!actual || actual.database !== expected.database || actual.owner !== expected.user || !actual.owns_database
      || actual.rolsuper || actual.rolcreatedb || actual.rolcreaterole || actual.recovery) throw failure('COPY_IDENTITY_MISMATCH');
  }
  if (!source.address || !destination.address || source.address === destination.address) throw failure('COPY_SAME_SERVER');
  if (source.version !== destination.version || source.encoding !== destination.encoding
    || source.datcollate !== destination.datcollate || source.datctype !== destination.datctype) throw failure('COPY_INCOMPATIBLE_DATABASES');
}
async function preflight(client, destination, maxBytes) {
  if (!destination) {
    const size = (await client.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes;
    if (BigInt(size) > BigInt(maxBytes)) throw failure('COPY_SIZE_LIMIT');
  }
  const objects = (await client.query(`SELECT c.relkind, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_SCHEMA}`)).rows;
  const unsupported = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')
    OR EXISTS(SELECT 1 FROM pg_largeobject_metadata)
    OR EXISTS(SELECT 1 FROM pg_foreign_server)
    OR EXISTS(SELECT 1 FROM pg_publication)
    OR EXISTS(SELECT 1 FROM pg_subscription) AS found`)).rows[0].found;
  if (unsupported || objects.some(o => ['f'].includes(o.relkind) || o.relrowsecurity || o.relforcerowsecurity)) throw failure('COPY_UNSUPPORTED_OBJECTS');
  if (destination) {
    const routines = (await client.query(`SELECT count(*)::integer AS n FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${USER_SCHEMA}`)).rows[0].n;
    const schemas = (await client.query(`SELECT count(*)::integer AS n FROM pg_namespace n
      WHERE ${USER_SCHEMA} AND n.nspname <> 'public'`)).rows[0].n;
    const types = (await client.query(`SELECT count(*)::integer AS n FROM pg_type t
      JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${USER_SCHEMA}`)).rows[0].n;
    if (objects.length || routines || schemas || types) throw failure('COPY_DESTINATION_NOT_EMPTY');
  }
}
async function sequences(client) {
  const names = (await client.query(`SELECT n.nspname AS schema, c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND ${USER_SCHEMA} ORDER BY 1,2`)).rows;
  const result = [];
  for (const entry of names) {
    const value = (await client.query(`SELECT last_value::text, is_called FROM ${quote(entry.schema)}.${quote(entry.name)}`)).rows[0];
    result.push({ ...entry, ...value });
  }
  return result;
}
async function tables(client) {
  const names = (await client.query(`SELECT n.nspname AS schema, c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m') AND ${USER_SCHEMA} ORDER BY 1,2`)).rows;
  const result = [];
  for (const entry of names) {
    const table = `${quote(entry.schema)}.${quote(entry.name)}`;
    // Bound memory for this first small-database implementation.
    const count = (await client.query(`SELECT count(*)::text AS n FROM ONLY ${table}`)).rows[0].n;
    if (BigInt(count) > 100000n) throw failure('COPY_ROW_LIMIT');
    const row = (await client.query(`SELECT count(*)::text AS rows,
      encode(sha256(convert_to(COALESCE(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS digest
      FROM (SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS h FROM ONLY ${table} t) hashes`)).rows[0];
    result.push({ ...entry, ...row });
  }
  return result;
}

async function copyDatabase(config, { makeClient = (options) => new Client(options), transfer = streamCopy, schema = schemaHash } = {}) {
  validateCopy(config);
  const source = makeClient(clientOptions(config.source, config.timeoutMs));
  const destination = makeClient(clientOptions(config.destination, config.timeoutMs));
  let directory;
  // Prevent unhandled client disconnect errors; operations will fail closed.
  source.on('error', () => {}); destination.on('error', () => {});
  try {
    await source.connect(); await destination.connect();
    assertIdentities(await identity(source), await identity(destination), config);
    const locked = (await destination.query('SELECT pg_try_advisory_lock(193713,1) AS locked')).rows[0].locked;
    if (!locked) throw failure('COPY_DESTINATION_BUSY');
    await preflight(destination, true, config.maxBytes);
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await preflight(source, false, config.maxBytes);
    const snapshot = (await source.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    if (!/^[A-Fa-f0-9-]+$/.test(snapshot)) throw failure('COPY_INVALID_SNAPSHOT');
    const sourceTables = await tables(source);
    const sourceSequences = await sequences(source);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-copy-ca-'));
    await fs.writeFile(path.join(directory,'source.crt'), config.source.ca, {mode:0o600});
    await fs.writeFile(path.join(directory,'destination.crt'), config.destination.ca, {mode:0o600});
    const sourceEnv = toolEnv(config.source,path.join(directory,'source.crt'),true);
    const destinationEnv = toolEnv(config.destination,path.join(directory,'destination.crt'),false);
    const sourceSchema = await schema(sourceEnv,snapshot,config.timeoutMs);
    await transfer(sourceEnv,destinationEnv,snapshot,config.timeoutMs);
    // Sequence state is not MVCC: refuse verification if writers advanced it.
    if (JSON.stringify(await sequences(source)) !== JSON.stringify(sourceSequences)) throw failure('COPY_SOURCE_SEQUENCE_CHANGED');
    const copiedTables = await tables(destination);
    const copiedSequences = await sequences(destination);
    const copiedSchema = await schema(destinationEnv,null,config.timeoutMs);
    if (JSON.stringify(sourceTables) !== JSON.stringify(copiedTables)
      || JSON.stringify(sourceSequences) !== JSON.stringify(copiedSequences)
      || sourceSchema !== copiedSchema) throw failure('COPY_VERIFICATION_FAILED');
    const foreignOwner = (await destination.query(`SELECT EXISTS(SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_SCHEMA}
      AND pg_get_userbyid(c.relowner) <> current_user) AS found`)).rows[0].found;
    if (foreignOwner) throw failure('COPY_OWNERSHIP_FAILED');
    await source.query('COMMIT');
    return { schemaDigest: sourceSchema, tableCount: sourceTables.length,
      rowCount: sourceTables.reduce((n,t)=>n+BigInt(t.rows),0n).toString(), sequenceCount: sourceSequences.length,
      dataDigest: digest(JSON.stringify(sourceTables)), sequenceDigest: digest(JSON.stringify(sourceSequences)) };
  } catch (error) {
    if (/^COPY_[A-Z_]+$/.test(error.code || '') && error.message === error.code) throw failure(error.code);
    throw failure('COPY_DATABASE_OPERATION_FAILED');
  } finally {
    await Promise.allSettled([source.end(), destination.end()]);
    if (directory) await fs.rm(directory,{recursive:true,force:true});
  }
}
module.exports = { validateCopy, assertIdentities, normalizeSchema, copyDatabase };
