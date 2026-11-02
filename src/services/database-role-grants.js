'use strict';

const { Client } = require('pg');
const access = require('./database-role-access');
const { connectionName } = require('../db/connection-options');

const PLATFORM_SCHEMAS = Object.freeze(['public', 'credentials']);
const { KERNEL_TABLES, WEB_EVENT_COLUMNS } = access;

// What web holds of the kernel's objects once a release takes the rest away:
// it reads them, and appends a pending event naming only what a producer says
// (the rest is the kernel's: its status, outcome, retry time). Idempotent; it
// also takes back what an earlier release granted. A database the bootstrap
// meets before its first migration has none of them yet.
async function restrictWebWorkflow(pool, web) {
  const role = access.identifier(web);
  const { rows } = await pool.query(`SELECT name FROM unnest($1::text[]) AS name
    WHERE pg_catalog.to_regclass('public.' || name) IS NOT NULL`, [[...KERNEL_TABLES, 'wf_events', 'wf_events_id_seq']]);
  const present = new Set(rows.map(r => r.name));
  const kernel = KERNEL_TABLES.filter(t => present.has(t)).map(t => `public.${t}`).join(', ');
  if (kernel) {
    await pool.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE ${kernel} FROM ${role};
      GRANT SELECT ON TABLE ${kernel} TO ${role}`);
  }
  if (present.has('wf_events')) {
    await pool.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.wf_events FROM ${role};
      GRANT SELECT, INSERT (${WEB_EVENT_COLUMNS.join(', ')}) ON TABLE public.wf_events TO ${role}`);
  }
  if (present.has('wf_events_id_seq')) {
    await pool.query(`REVOKE UPDATE ON SEQUENCE public.wf_events_id_seq FROM ${role};
      GRANT USAGE, SELECT ON SEQUENCE public.wf_events_id_seq TO ${role}`);
  }
}

// Run it inside one transaction (`pool` a client that began one): a grant
// another login sees half made is a grant it holds meanwhile.
async function ensureRuntimeGrants(pool, env = process.env) {
  if (!access.enabled(env)) return;
  const roles = access.names(env);
  const runtime = [roles.web, roles.conductor].map(access.identifier).join(', ');
  const reader = access.identifier(roles.provisioner);
  const owner = access.identifier(roles.migrator);
  const { rows: schemas } = await pool.query('SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[])', [PLATFORM_SCHEMAS]);
  for (const { nspname } of schemas) {
    const schema = access.identifier(nspname);
    await pool.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC;
      GRANT USAGE ON SCHEMA ${schema} TO ${runtime}, ${reader};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema}
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema}
        GRANT SELECT ON TABLES TO ${reader};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema}
        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema}
        GRANT SELECT ON SEQUENCES TO ${reader};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema}
        GRANT EXECUTE ON FUNCTIONS TO ${runtime};`);
  }
  // Extension objects keep their operator ownership and existing ACLs.
  // Never attempt to take them over or grant broader extension access.
  const { rows } = await pool.query(`
    SELECT c.oid::regclass::text AS name, c.relkind AS kind,
           n.nspname || '.' || c.relname AS qualified_name
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($2::text[]) AND c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
       AND c.relkind IN ('r','p','v','m','f','S')`, [roles.migrator, PLATFORM_SCHEMAS]);
  for (const item of rows) {
    if (item.qualified_name === 'public.schema_migrations') {
      // Migration receipts are evidence owned by the migrator, never runtime
      // application data. Undo any inherited/default runtime grants too.
      // Read access is required by the existing unredacted pg_dump export.
      await pool.query(`GRANT SELECT ON TABLE public.schema_migrations TO ${runtime}, ${reader};
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON TABLE public.schema_migrations FROM ${runtime}, ${reader}`);
      continue;
    }
    // regclass's rendering is quoted by PostgreSQL and schema qualified
    // when public is not on search_path. It is catalog output, never input.
    const kind = item.kind === 'S' ? 'SEQUENCE' : 'TABLE';
    const privileges = item.kind === 'S' ? 'USAGE, SELECT, UPDATE' : 'SELECT, INSERT, UPDATE, DELETE';
    await pool.query(`GRANT ${privileges} ON ${kind} ${item.name} TO ${runtime}`);
    await pool.query(`GRANT SELECT ON ${kind} ${item.name} TO ${reader}`);
  }
  const { rows: functions } = await pool.query(`
    SELECT p.oid::regprocedure::text AS name FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY($2::text[]) AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
       AND p.prokind <> 'a'`, [roles.migrator, PLATFORM_SCHEMAS]);
  for (const item of functions) await pool.query(`GRANT EXECUTE ON ROUTINE ${item.name} TO ${runtime}`);
  // Web keeps its writes on the kernel's tables for this release, so a web
  // Pod of the build before it can still restart while it rolls out. The
  // release after it takes them (restrictWebWorkflow), once no web process
  // of an earlier build serves (platform_processes.web_restriction_ready).
}

async function withRoleAdmin(fn) {
  if (!access.enabled()) return fn(null);
  const url = access.provisionerUrl();
  const client = new Client({ connectionString: url.toString(),
    application_name: connectionName('admin'), connectionTimeoutMillis: 30_000 });
  try {
    await client.connect();
    await access.assertLogin(client, 'provisioner');
    await client.query('SELECT public.homeroom_adopt_app_roles()');
    return await fn(client);
  } finally { await client.end().catch(() => {}); }
}

module.exports = { PLATFORM_SCHEMAS, ensureRuntimeGrants, restrictWebWorkflow, withRoleAdmin };
