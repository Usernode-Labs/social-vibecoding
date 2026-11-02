'use strict';

const crypto = require('crypto');

const DEFAULT_ROLES = Object.freeze({
  web: 'homeroom_web', conductor: 'homeroom_conductor',
  migrator: 'homeroom_migrator', provisioner: 'homeroom_provisioner',
});
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
// The workflow kernel's relations are public's wf_* tables and sequences,
// read from the catalog wherever they are granted or checked. The conductor
// decides and writes them; web asks, appending to wf_events alone
// (src/db/migrations/0011-workflow-producers.sql). Default privileges give
// both serving logins every new table's writes, so a new kernel table is
// the kernel's by its name: the grants and these checks find it.
const isKernelRelation = (qualifiedName) => /^public\.wf_/.test(qualifiedName);
// Its catalog form, for the checks below.
const KERNEL_SQL = `SELECT c.oid, c.relname, c.relkind FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname LIKE 'wf\\_%' AND c.relkind IN ('r', 'p', 'S')`;
// What a producer names when it appends an event; every other column of
// wf_events (its status, outcome, retry time, producer) is the kernel's.
const WEB_EVENT_COLUMNS = Object.freeze(['machine', 'key', 'app_id', 'type', 'payload', 'source', 'actor', 'request_key', 'caused_by']);

function enabled(env = process.env) { return env.DATABASE_ROLE_SPLIT === 'true'; }
function names(env = process.env) {
  const out = {};
  for (const [kind, fallback] of Object.entries(DEFAULT_ROLES)) {
    const value = env[`DATABASE_${kind.toUpperCase()}_USER`] || fallback;
    if (!IDENT.test(value)) throw new Error(`Invalid database ${kind} role name`);
    out[kind] = value;
  }
  if (new Set(Object.values(out)).size !== 4) throw new Error('Database roles must have distinct names');
  return out;
}
function identifier(value) {
  if (!IDENT.test(value || '')) throw new Error('Invalid database identifier');
  return `"${value}"`;
}
function literal(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function parseUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} is required and must be a PostgreSQL URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${label} must use PostgreSQL`);
  // libpq and node-postgres must agree about the login and destination.
  for (const key of ['user', 'password', 'host', 'hostaddr', 'port', 'dbname', 'service', 'options']) {
    if (url.searchParams.has(key)) throw new Error(`${label} cannot override its address or role in query parameters`);
  }
  return url;
}

function provisionerUrl(server = 'primary', env = process.env) {
  const key = server === 'preview' ? 'STAGING_DB_ADMIN_URL' : 'DB_ADMIN_URL';
  const value = env[key];
  if (enabled(env)) {
    if (env.PROCESS_ROLE === 'web') throw new Error('Database provisioning is unavailable on web');
    const url = parseUrl(value, key);
    if (decodeURIComponent(url.username) !== names(env).provisioner) throw new Error(`${key} must use the provisioner role`);
    return url;
  }
  return parseUrl(value || (server === 'primary' ? env.DATABASE_URL : ''), key);
}

function readUrl(server = 'primary', env = process.env) {
  return parseUrl(server === 'preview'
    ? env.STAGING_DB_READ_URL || env.STAGING_DB_ADMIN_URL
    : env.DATABASE_URL, server === 'preview' ? 'STAGING_DB_READ_URL' : 'DATABASE_URL');
}

async function assertLogin(pool, kind, env = process.env) {
  if (!enabled(env)) return;
  const expected = names(env)[kind];
  if (!expected) throw new Error('Invalid database connection purpose');
  const allowed = ['pg_use_reserved_connections', 'topochain_console_ro'];
  if (kind === 'migrator' || kind === 'provisioner') allowed.push('pg_database_owner');
  const { rows: [row] } = await pool.query(`
    SELECT current_user AS name, session_user AS login_name, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
           EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'credentials')
             AND has_schema_privilege(current_user, n.oid, 'CREATE')) AS schema_create,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles p WHERE p.rolname <> current_user
             AND (p.rolsuper OR p.rolcreatedb OR p.rolcreaterole OR p.rolreplication OR p.rolbypassrls
               OR p.rolname = ANY($1::text[])
               OR (p.rolname <> ALL($2::text[]) AND NOT ($3::boolean AND
                 (p.rolname LIKE 'app\\_%' OR p.rolname = 'usernode_debug_ro'))))
             AND pg_has_role(current_user, p.oid, 'MEMBER')) AS privileged_membership,
           current_setting('server_version_num')::int AS version
      FROM pg_catalog.pg_roles WHERE rolname = current_user`,
  [[...Object.values(names(env)), 'pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'], allowed, kind === 'provisioner']);
  if (!row || row.version < 160000 || row.name !== expected || row.login_name !== expected || row.rolsuper || row.rolreplication
      || row.privileged_membership
      || (['web', 'conductor'].includes(kind) && row.schema_create)
      || (kind !== 'provisioner' && (row.rolcreatedb || row.rolcreaterole || row.rolbypassrls))
      || (kind === 'provisioner' && (!row.rolcreatedb || !row.rolcreaterole || !row.rolbypassrls))) {
    throw new Error(`Database ${kind} login does not match its required privileges`);
  }
  if (kind === 'web' || kind === 'conductor') await assertWorkflowAuthority(pool, kind);
}

// The workflow's producers are told apart by this (wf_events.producer): web
// may append a pending event, naming only what a producer says, and write
// nothing more of the kernel's relations (nor set a sequence's value); the
// conductor may update the stream, or every event it appends would count as
// web's, and writes every kernel table.
async function assertWorkflowAuthority(pool, kind) {
  const { rows: [row] } = await pool.query(`
    WITH k AS (${KERNEL_SQL}),
    t AS (
      SELECT relname, has_table_privilege(current_user, oid, 'INSERT') AS i, has_table_privilege(current_user, oid, 'UPDATE') AS u,
             has_table_privilege(current_user, oid, 'DELETE') AS d, has_table_privilege(current_user, oid, 'TRUNCATE') AS x
        FROM k WHERE relkind <> 'S')
    SELECT has_table_privilege(current_user, 'public.wf_events', 'INSERT') AS appends,
           has_table_privilege(current_user, 'public.wf_events', 'UPDATE') AS decides,
           (SELECT bool_or(u OR d OR x OR (i AND relname <> 'wf_events')) FROM t)
             OR (SELECT bool_or(has_sequence_privilege(current_user, oid, 'UPDATE')) FROM k WHERE relkind = 'S') AS writes_any,
           (SELECT bool_and(i AND u AND d) FROM t) AS writes_all,
           (SELECT bool_and(has_column_privilege(current_user, 'public.wf_events', a.attname, 'INSERT') = (a.attname = ANY($1::text[])))
              FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = 'public.wf_events'::regclass AND a.attnum > 0 AND NOT a.attisdropped) AS asks,
           has_function_privilege(current_user, 'public.wf_refuse_pending(bigint, text)', 'EXECUTE') AS withdraws`,
  [WEB_EVENT_COLUMNS]);
  const ok = kind === 'web'
    ? row.asks && !row.appends && row.withdraws && !row.decides && !row.writes_any
    : row.appends && row.withdraws && row.decides && row.writes_all;
  if (!ok) throw new Error(`Database ${kind} login does not match its workflow authority`);
}

async function assertReadonlyRole(pool, role) {
  const { rows: [row] } = await pool.query(
    'SELECT rolsuper, rolbypassrls, rolreplication FROM pg_catalog.pg_roles WHERE rolname = $1', [role]);
  if (!row || row.rolsuper || row.rolbypassrls || row.rolreplication) {
    throw new Error('Read-only database role has unexpected attributes');
  }
}

function templateName(provisioner, extensions) {
  identifier(provisioner);
  const entries = extensions.map(({ name, version }) => [name, version]).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) return 'template0';
  const digest = crypto.createHash('sha256').update(JSON.stringify([provisioner, entries])).digest('hex').slice(0, 28);
  return `homeroom_empty_${digest}`;
}

module.exports = {
  WEB_EVENT_COLUMNS, isKernelRelation, enabled, names, identifier, literal, parseUrl, provisionerUrl, readUrl, assertLogin, assertWorkflowAuthority,
  assertReadonlyRole, templateName,
};
