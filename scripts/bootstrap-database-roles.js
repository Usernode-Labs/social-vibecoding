'use strict';

// A bounded deployment Job. Serving processes never receive its credentials.
const crypto = require('crypto');
const { Client } = require('pg');
const access = require('../src/services/database-role-access');
const { PLATFORM_SCHEMAS, ensureRuntimeGrants } = require('../src/services/database-role-grants');

let stage = 'configuration';
const ident = value => `"${String(value).replace(/"/g, '""')}"`;
const lit = access.literal;

function verifier(password) {
  if (!/^[A-Za-z0-9._~-]{32,}$/.test(password || '')) throw new Error('Database role passwords must be long URL-safe strings');
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const stored = crypto.createHash('sha256').update(client).digest('base64');
  const server = crypto.createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}

async function connected(url, fn, database = null) {
  const target = access.parseUrl(url, 'Database bootstrap connection');
  if (database) target.pathname = `/${database}`;
  const client = new Client({ connectionString: target.toString(),
    application_name: 'homeroom-database-bootstrap', connectionTimeoutMillis: 30_000,
    options: '-c search_path=pg_catalog',
    query_timeout: 125_000, statement_timeout: 120_000, lock_timeout: 5_000 });
  client.on('error', () => {});
  try {
    await client.connect();
    const { rows: [role] } = await client.query(`SELECT rolsuper,
      current_setting('server_version_num')::int AS version FROM pg_catalog.pg_roles WHERE rolname = current_user`);
    if (!role?.rolsuper || role.version < 160000) throw new Error('Bootstrap needs a cluster administrator on PostgreSQL 16 or newer');
    // Passwords reach SQL only as SCRAM verifiers. Suppress utility and
    // statement logging as well; diagnostics below never print SQL/errors.
    await client.query("SET log_statement = 'none'; SET log_min_error_statement = 'panic'; SET pg_stat_statements.track_utility = 'off'; SET log_min_duration_statement = -1; SET log_min_duration_sample = -1");
    return await fn(client);
  } finally { await client.end().catch(() => {}); }
}

async function ensureRole(client, name, password, provisioner = false, readonly = false) {
  access.identifier(name);
  const { rows } = await client.query('SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1', [name]);
  if (rows[0]?.rolsuper) throw new Error('Refusing to repurpose an administrator as an application role');
  if (!rows.length) await client.query(`CREATE ROLE ${ident(name)}`);
  await client.query(`ALTER ROLE ${ident(name)} LOGIN NOSUPERUSER NOREPLICATION INHERIT
    ${provisioner ? 'CREATEDB CREATEROLE BYPASSRLS' : 'NOCREATEDB NOCREATEROLE NOBYPASSRLS'}
    PASSWORD ${lit(verifier(password))}`);
  await client.query(`ALTER ROLE ${ident(name)} SET default_transaction_read_only = ${readonly ? 'on' : 'off'}`);
  if (provisioner) await client.query(`ALTER ROLE ${ident(name)} SET createrole_self_grant = 'set,inherit'`);
  await client.query(`GRANT pg_use_reserved_connections TO ${ident(name)}`);
}

function eligibleRoleSql(roles, platformDb) {
  return `(r.rolname LIKE 'app\\_%' OR r.rolname IN ('usernode_debug_ro','topochain_console_ro'))
    AND r.rolname NOT IN (${Object.values(roles).map(lit).join(', ')})
    AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba = r.oid
      AND (d.datname = ${lit(platformDb)} OR d.datname NOT LIKE 'app\\_%'))`;
}

async function assertTenantOwners(client, roles, platformDb) {
  const { rows: [row] } = await client.query(`SELECT count(*)::int AS unresolved
    FROM pg_catalog.pg_database db JOIN pg_catalog.pg_roles r ON r.oid = db.datdba
    WHERE db.datname LIKE 'app\\_%' AND db.datname <> $1
      AND NOT (r.rolname LIKE 'app\\_%' AND ${eligibleRoleSql(roles, platformDb)})`, [platformDb]);
  if (row.unresolved) {
    throw Object.assign(new Error('Tenant database ownership must be migrated before enabling database identities'),
      { code: 'database_role_ownership_required' });
  }
}

function adoptionFunctionSql(roles, platformDb) {
  const provisioner = roles.provisioner;
  return `CREATE OR REPLACE FUNCTION public.homeroom_adopt_app_roles() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $adopt$
    DECLARE candidate record;
    BEGIN
      IF session_user <> ${lit(provisioner)} THEN RAISE EXCEPTION 'Database provisioner login required'; END IF;
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = session_user AND rolsuper) THEN
        RAISE EXCEPTION 'Database provisioner must not be a superuser';
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('homeroom-role-adoption', 0));
      FOR candidate IN
        SELECT r.rolname FROM pg_catalog.pg_roles r
         WHERE ${eligibleRoleSql(roles, platformDb)}
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid = m.member
             WHERE m.roleid = r.oid AND p.rolname = ${lit(provisioner)}
               AND m.admin_option AND m.inherit_option AND m.set_option)
      LOOP
        EXECUTE pg_catalog.format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT TRUE, SET TRUE', candidate.rolname, ${lit(provisioner)});
      END LOOP;
    END $adopt$;
    REVOKE ALL ON FUNCTION public.homeroom_adopt_app_roles() FROM PUBLIC;`;
}

async function installAdoption(client, roles, platformDb) {
  const provisioner = roles.provisioner;
  await client.query(adoptionFunctionSql(roles, platformDb));
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO ${ident(provisioner)};
    GRANT EXECUTE ON FUNCTION public.homeroom_adopt_app_roles() TO ${ident(provisioner)};
    GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${ident(provisioner)};`);
  // Existing objects remain owned by their tenant roles. Only the
  // provisioner's memberships change, never any runtime/administrator role.
  await client.query(`SET SESSION AUTHORIZATION ${ident(provisioner)}`);
  try { await client.query('SELECT public.homeroom_adopt_app_roles()'); }
  finally { await client.query('RESET SESSION AUTHORIZATION'); }
}

// Preserve the connection budget's complete counts without exposing other
// sessions' SQL text through pg_read_all_stats to either serving login.
async function installConnectionCounts(client, users) {
  await client.query(`CREATE OR REPLACE FUNCTION public.homeroom_connection_counts()
    RETURNS TABLE(datname name, used bigint, idle bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $counts$
      SELECT a.datname, count(*), count(*) FILTER (WHERE a.state = 'idle')
        FROM pg_catalog.pg_stat_activity a WHERE a.backend_type = 'client backend'
       GROUP BY a.datname
    $counts$;
    REVOKE ALL ON FUNCTION public.homeroom_connection_counts() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.homeroom_connection_counts()
      TO ${users.map(ident).join(', ')};`);
}

async function ownPlatformSchema(client, roles, database, env = process.env) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER DATABASE ${ident(database)} OWNER TO ${ident(roles.migrator)};
      REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${ident(database)} TO ${[roles.web, roles.conductor, roles.migrator, roles.provisioner].map(ident).join(', ')};
      `);
    const { rows: schemas } = await client.query('SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[])', [PLATFORM_SCHEMAS]);
    for (const { nspname } of schemas) await client.query(`ALTER SCHEMA ${ident(nspname)} OWNER TO ${ident(roles.migrator)}; REVOKE CREATE ON SCHEMA ${ident(nspname)} FROM PUBLIC`);
    // Transfer only this database's non-extension platform objects. REASSIGN
    // OWNED would also change ownership of shared databases/tablespaces.
    const { rows: relations } = await client.query(`SELECT c.oid::regclass::text AS name, c.relkind AS kind
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (${PLATFORM_SCHEMAS.map(lit).join(', ')}) AND c.relkind IN ('r','p','v','m','f','S')
        AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${lit(roles.migrator)})
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
        AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
            AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i')))`);
    for (const row of relations) {
      const kind = { S: 'SEQUENCE', v: 'VIEW', m: 'MATERIALIZED VIEW', f: 'FOREIGN TABLE' }[row.kind] || 'TABLE';
      await client.query(`ALTER ${kind} ${row.name} OWNER TO ${ident(roles.migrator)}`);
    }
    const { rows: routines } = await client.query(`SELECT p.oid::regprocedure::text AS name, p.prokind AS kind
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN (${PLATFORM_SCHEMAS.map(lit).join(', ')}) AND p.proname NOT IN ('homeroom_adopt_app_roles', 'homeroom_connection_counts')
        AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${lit(roles.migrator)})
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`);
    for (const row of routines) {
      const kind = row.kind === 'p' ? 'PROCEDURE' : row.kind === 'a' ? 'AGGREGATE' : 'FUNCTION';
      await client.query(`ALTER ${kind} ${row.name} OWNER TO ${ident(roles.migrator)}`);
    }
    const { rows: types } = await client.query(`SELECT t.oid::regtype::text AS name, t.typtype AS kind
      FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname IN (${PLATFORM_SCHEMAS.map(lit).join(', ')}) AND t.typtype IN ('e','d','r')
        AND t.typowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${lit(roles.migrator)})
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')`);
    for (const row of types) await client.query(`ALTER ${row.kind === 'd' ? 'DOMAIN' : 'TYPE'} ${row.name} OWNER TO ${ident(roles.migrator)}`);
    await ensureRuntimeGrants(client, env);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; }
}

async function extensionPlans(url, platformDb) {
  const databases = await connected(url, async client => (await client.query(`
    SELECT datname FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate
      AND (datname LIKE 'app\\_%' OR datname = $1) ORDER BY datname`, [platformDb])).rows);
  const plans = new Map();
  const add = names => { const sorted = [...new Set(names)].sort(); plans.set(JSON.stringify(sorted), sorted); };
  add(['pg_stat_statements']);
  for (const { datname } of databases) {
    const extensions = await connected(url, async client => (await client.query(
      "SELECT extname FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql' ORDER BY extname")).rows, datname);
    const names = extensions.map(row => row.extname);
    add(names);
    // The operator may add its managed statistics extension after a newly
    // created source was inspected. Prepare that exact combination as well.
    add([...names, 'pg_stat_statements']);
  }
  return [...plans.values()];
}

async function prepareTemplates(url, roles, plans) {
  return connected(url, async client => {
    const { rows: available } = await client.query(`SELECT a.name, a.default_version AS version,
      v.superuser AND NOT v.trusted AS admin_only FROM pg_catalog.pg_available_extensions a
      JOIN pg_catalog.pg_available_extension_versions v ON v.name=a.name AND v.version=a.default_version`);
    const catalog = new Map(available.map(row => [row.name, row]));
    const prepared = new Set();
    for (const plan of plans) {
      const extensions = plan.map(name => catalog.get(name)).filter(row => row?.admin_only);
      if (!extensions.length) continue;
      const name = access.templateName(roles.provisioner, extensions);
      if (prepared.has(name)) continue;
      const marker = JSON.stringify({ purpose: 'homeroom-extension-template', extensions: extensions.map(({ name, version }) => ({ name, version })) });
      const lock = `homeroom-extension-template:${name}`;
      await client.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1, 0))', [lock]);
      try {
        const { rows: existing } = await client.query(`SELECT pg_get_userbyid(datdba) AS owner,
          shobj_description(oid,'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname=$1`, [name]);
        if (existing.length) {
          if (existing[0].owner !== roles.provisioner || existing[0].marker !== marker) throw new Error('Existing extension template has unexpected ownership or provenance');
        } else {
          // A killed Job may leave this empty attempt behind, but can never
          // reserve the canonical name before a complete template is ready.
          const attempt = `homeroom_prepare_${crypto.randomBytes(12).toString('hex')}`;
          await client.query(`CREATE DATABASE ${ident(attempt)} TEMPLATE template0 OWNER ${ident(roles.provisioner)}`);
          try {
            await client.query(`REVOKE ALL ON DATABASE ${ident(attempt)} FROM PUBLIC`);
            await connected(url, async template => {
              for (const extension of extensions) await template.query(
                `CREATE EXTENSION IF NOT EXISTS ${ident(extension.name)} WITH SCHEMA public`);
            }, attempt);
            await client.query('BEGIN');
            try {
              await client.query(`COMMENT ON DATABASE ${ident(attempt)} IS ${lit(marker)};
                ALTER DATABASE ${ident(attempt)} ALLOW_CONNECTIONS false;
                ALTER DATABASE ${ident(attempt)} RENAME TO ${ident(name)}`);
              await client.query('COMMIT');
            } catch (err) { await client.query('ROLLBACK'); throw err; }
          } catch (err) {
            // Only this attempt's empty database can be removed. If publish
            // committed before a connection loss, its canonical name stays.
            await client.query(`DROP DATABASE IF EXISTS ${ident(attempt)} WITH (FORCE)`).catch(() => {});
            throw err;
          }
        }
        prepared.add(name);
      } finally {
        await client.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0))', [lock]);
      }
    }
    return prepared.size;
  });
}

async function bootstrap(env = process.env) {
  if (!access.enabled(env)) throw new Error('Database role bootstrap is not enabled');
  const roles = access.names(env);
  const primary = env.DATABASE_BOOTSTRAP_URL;
  const preview = env.STAGING_DATABASE_BOOTSTRAP_URL;
  const database = env.DATABASE_NAME;
  access.identifier(database);
  access.parseUrl(primary, 'DATABASE_BOOTSTRAP_URL');
  if (preview) access.parseUrl(preview, 'STAGING_DATABASE_BOOTSTRAP_URL');
  // Refuse an unresolved legacy/restore owner before changing any login or
  // schema. Ordinary migration must never silently leave such apps behind.
  for (const [side, url] of [['primary', primary], ...(preview ? [['preview', preview]] : [])]) {
    stage = `${side} tenant ownership preflight`;
    await connected(url, client => assertTenantOwners(client, roles, database));
  }
  stage = 'primary roles';
  await connected(primary, async client => {
    for (const [kind, name] of Object.entries(roles)) await ensureRole(client, name,
      env[`DATABASE_${kind.toUpperCase()}_PASSWORD`], kind === 'provisioner');
    await installAdoption(client, roles, database);
    const { rows } = await client.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1', [database]);
    if (!rows.length) await client.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(roles.migrator)}`);
  });
  stage = 'platform object ownership and grants';
  await connected(primary, async client => {
    await ownPlatformSchema(client, roles, database, env);
    await installConnectionCounts(client, [roles.web, roles.conductor, roles.migrator]);
  }, database);
  stage = 'extension inventory';
  const plans = await extensionPlans(primary, database);
  stage = 'primary extension templates';
  const primaryTemplates = await prepareTemplates(primary, roles, plans);
  let previewTemplates = 0;
  if (preview) {
    stage = 'preview roles';
    await connected(preview, async client => {
      await ensureRole(client, roles.web, env.STAGING_DATABASE_READ_PASSWORD, false, true);
      await ensureRole(client, roles.provisioner, env.STAGING_DATABASE_PROVISIONER_PASSWORD, true);
      await installAdoption(client, roles, database);
      await installConnectionCounts(client, [roles.provisioner]);
      const maintenance = decodeURIComponent(access.parseUrl(preview, 'STAGING_DATABASE_BOOTSTRAP_URL').pathname.slice(1));
      await client.query(`GRANT CONNECT ON DATABASE ${ident(maintenance)} TO ${ident(roles.web)}, ${ident(roles.provisioner)}`);
    });
    stage = 'preview extension templates';
    previewTemplates = await prepareTemplates(preview, roles, plans);
  }
  stage = 'complete';
  return { roles: 4, primaryTemplates, previewTemplates };
}

if (require.main === module) bootstrap().then(result => {
  console.log('[database-bootstrap] complete', JSON.stringify(result));
}).catch(error => {
  console.error('[database-bootstrap] failed', JSON.stringify({ stage, code: error.code || 'bootstrap_failed' }));
  process.exitCode = 1;
});

module.exports = { bootstrap, verifier, adoptionFunctionSql, installAdoption, ownPlatformSchema, extensionPlans, prepareTemplates };
