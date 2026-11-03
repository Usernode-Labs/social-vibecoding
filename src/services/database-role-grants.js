'use strict';

const { Client } = require('pg');
const access = require('./database-role-access');
const { connectionName } = require('../db/connection-options');

const PLATFORM_SCHEMAS = Object.freeze(['public', 'credentials']);
// Evidence the migrator owns, never runtime application data: migration
// receipts, and the log of who was made an administrator
// (src/db/migrations/privilege-changes.sql), which only its triggers write.
// The runtime logins read it; any inherited or default write grant is taken.
// Read access is also what the existing unredacted pg_dump export needs.
const EVIDENCE = new Set(['public.schema_migrations', 'public.privilege_changes']);
const { WEB_EVENT_COLUMNS, isKernelRelation } = access;
// How long the migration Job waits for web processes of an earlier build to
// go (their rollout): its two tries, each waiting this long, end inside its
// 30-minute deadline with the reason.
const READY_WAIT_MS = 8 * 60 * 1000;

// The workflow kernel's relations: public's wf_* tables and sequences
// (database-role-access.js isKernelRelation), read from the catalog, so a new
// one is the kernel's by its name and never web's to write by default.
async function kernelRelations(pool) {
  const { rows } = await pool.query(`SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS name,
           c.relname, c.relkind = 'S' AS sequence
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname LIKE 'wf\\_%' AND c.relkind IN ('r', 'p', 'S')`);
  return rows;
}

// What web holds of the kernel's relations: it reads them, appends a pending
// event naming only what a producer says (the rest is the kernel's: its
// status, outcome, retry time, cause), and draws a sequence's values without
// setting them. Only adds: what more an earlier release granted is
// restrictWebWorkflow's to take.
async function grantWebWorkflow(pool, web, kernel = null) {
  const role = access.identifier(web);
  const all = kernel || await kernelRelations(pool);
  const tables = all.filter(r => !r.sequence).map(r => r.name);
  const sequences = all.filter(r => r.sequence).map(r => r.name);
  if (tables.length) await pool.query(`GRANT SELECT ON TABLE ${tables.join(', ')} TO ${role}`);
  if (all.some(r => r.relname === 'wf_events')) {
    await pool.query(`GRANT INSERT (${WEB_EVENT_COLUMNS.join(', ')}) ON TABLE public.wf_events TO ${role}`);
  }
  if (sequences.length) await pool.query(`GRANT USAGE, SELECT ON SEQUENCE ${sequences.join(', ')} TO ${role}`);
}

// Takes what more web holds, keeping grantWebWorkflow's. Idempotent. When it
// takes web's writes for the first time since web could update the stream,
// it records when (wf_settings 'web_restricted_at'): a request web appended
// before then reads as the platform's, and web may still withdraw it
// (wf_refuse_pending, src/db/migrations/0014-web-withdraws-at-cutover.sql).
async function restrictWebWorkflow(pool, web) {
  const role = access.identifier(web);
  const kernel = await kernelRelations(pool);
  if (!kernel.length) return;
  const events = kernel.some(r => r.relname === 'wf_events');
  const { rows: [was] } = events
    ? await pool.query(`SELECT has_table_privilege($1, 'public.wf_events', 'UPDATE') AS decided`, [web])
    : { rows: [{ decided: false }] };
  const tables = kernel.filter(r => !r.sequence).map(r => r.name);
  const sequences = kernel.filter(r => r.sequence).map(r => r.name);
  if (tables.length) await pool.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE ${tables.join(', ')} FROM ${role}`);
  if (sequences.length) await pool.query(`REVOKE UPDATE ON SEQUENCE ${sequences.join(', ')} FROM ${role}`);
  await grantWebWorkflow(pool, web, kernel);
  if (was.decided) {
    await pool.query(`INSERT INTO public.wf_settings (key, value) VALUES ('web_restricted_at', clock_timestamp()::text)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
  }
}

// A web process of a build before the one that records
// web_restriction_ready (src/db/migrations/0011-workflow-producers.sql) still
// writes the kernel's tables (its settings at boot, its refusals, an admin's
// release): taking web's writes while one serves would stop it restarting.
// So the migration Job waits, before it migrates anything, for every live web
// process to say it is ready, and refuses the release, changing nothing, if
// one still does not after `waitMs` (that build's rollout never finished, or
// the release that records it was skipped). A database without the table has
// no process to wait for; one without the column has only earlier builds.
// Never inside a transaction: it would hold its locks while it waits.
async function awaitWebRestrictionReady(pool, { waitMs = READY_WAIT_MS, everyMs = 5000, env = process.env } = {}) {
  if (!access.enabled(env)) return;
  const table = await processesTable(pool);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const n = await webNotReady(pool, table);
    if (!n) return;
    if (Date.now() >= deadline) throw notReady(n);
    await new Promise(resolve => setTimeout(resolve, everyMs));
  }
}

// What the migration Job does once it has migrated, in its grants'
// transaction: ask once more, against the processes registered at that
// moment (a straggler that registered since the wait fails the transaction),
// then take web's writes. A web process still booting, not registered yet, is
// not seen: the wait, and the earlier build's rollout having finished, are
// what keep one from serving.
async function takeWebWorkflowWrites(pool, env = process.env) {
  if (!access.enabled(env)) return;
  const n = await webNotReady(pool, await processesTable(pool));
  if (n) throw notReady(n);
  await restrictWebWorkflow(pool, access.names(env).web);
}

async function processesTable(pool) {
  const { rows: [t] } = await pool.query(`SELECT pg_catalog.to_regclass('public.platform_processes') IS NOT NULL AS present,
    EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = pg_catalog.to_regclass('public.platform_processes')
      AND attname = 'web_restriction_ready' AND NOT attisdropped) AS recorded`);
  return t;
}

// Live web (or all) processes whose build does not say it is ready.
async function webNotReady(pool, table) {
  if (!table.present) return 0;
  const { LIVE_SECONDS } = require('./processes');
  const { rows: [w] } = await pool.query(`SELECT count(*)::int AS n FROM public.platform_processes
    WHERE role IN ('web', 'all') AND heartbeat_at > now() - make_interval(secs => $1)
      AND NOT ${table.recorded ? 'web_restriction_ready' : 'FALSE'}`, [LIVE_SECONDS]);
  return w.n;
}

function notReady(n) {
  return Object.assign(new Error(`${n} web process(es) of a build that still writes the workflow kernel's tables serve: `
    + 'deploy the release that records web_restriction_ready first, and let its rollout finish'), { code: 'web_restriction_not_ready' });
}

// Run it inside one transaction (`pool` a client that began one): a grant
// another login sees half made is a grant it holds meanwhile. It only adds
// web's workflow grants; the migration Job takes the rest
// (takeWebWorkflowWrites).
async function ensureRuntimeGrants(pool, env = process.env) {
  if (!access.enabled(env)) return;
  const roles = access.names(env);
  const runtime = [roles.web, roles.conductor].map(access.identifier).join(', ');
  const conductor = access.identifier(roles.conductor);
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
    if (EVIDENCE.has(item.qualified_name)) {
      await pool.query(`GRANT SELECT ON TABLE ${item.name} TO ${runtime}, ${reader};
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON TABLE ${item.name} FROM ${runtime}, ${reader}`);
      continue;
    }
    // regclass's rendering is quoted by PostgreSQL and schema qualified
    // when public is not on search_path. It is catalog output, never input.
    const kind = item.kind === 'S' ? 'SEQUENCE' : 'TABLE';
    const privileges = item.kind === 'S' ? 'USAGE, SELECT, UPDATE' : 'SELECT, INSERT, UPDATE, DELETE';
    await pool.query(`GRANT ${privileges} ON ${kind} ${item.name} TO ${isKernelRelation(item.qualified_name) ? conductor : runtime}`);
    await pool.query(`GRANT SELECT ON ${kind} ${item.name} TO ${reader}`);
  }
  const { rows: functions } = await pool.query(`
    SELECT p.oid::regprocedure::text AS name FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY($2::text[]) AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
       AND p.prokind <> 'a'`, [roles.migrator, PLATFORM_SCHEMAS]);
  for (const item of functions) await pool.query(`GRANT EXECUTE ON ROUTINE ${item.name} TO ${runtime}`);
  await grantWebWorkflow(pool, roles.web);
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

module.exports = {
  PLATFORM_SCHEMAS, ensureRuntimeGrants, restrictWebWorkflow, awaitWebRestrictionReady, takeWebWorkflowWrites, withRoleAdmin,
};
