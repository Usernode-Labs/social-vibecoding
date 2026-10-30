'use strict';

const { Client } = require('pg');
const access = require('./database-role-access');
const { connectionName } = require('../db/connection-options');

const PLATFORM_SCHEMAS = Object.freeze(['public', 'credentials']);

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
    SELECT c.oid::regclass::text AS name, c.relkind AS kind
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($2::text[]) AND c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
       AND c.relkind IN ('r','p','v','m','f','S')`, [roles.migrator, PLATFORM_SCHEMAS]);
  for (const item of rows) {
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

module.exports = { PLATFORM_SCHEMAS, ensureRuntimeGrants, withRoleAdmin };
