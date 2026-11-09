'use strict';
// test:changed: when scripts/bootstrap-database-roles.js (deployment bootstrap)
// test:changed: when src/services/database-role-access.js (connection authority)
// test:changed: when src/services/database-role-grants.js (schema grants)
// test:changed: when src/services/db-manager.js (tenant lifecycle)
// test:changed: when src/services/db-export.js (runtime exports)
// test:changed: when src/services/db-roles.js (readonly capability bootstrap)
// test:changed: when src/db/connection-census.js (cluster connection budget)
// test:changed: when src/db/migrations/ (actual fresh and upgraded schema under split identities)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { Writable } = require('node:stream');
const { gunzipSync } = require('node:zlib');
const { Client, Pool } = require('pg');
const { applySchemaWithLockRetry } = require('../src/db/schema-migrations');
const { seedReferenceData } = require('../src/db/reference-data');
const access = require('../src/services/database-role-access');
const { bootstrap } = require('../scripts/bootstrap-database-roles');
const { ensureRuntimeGrants, takeWebWorkflowWrites } = require('../src/services/database-role-grants');

// Explicit opt-in: this regression creates cluster roles on TWO disposable
// test servers, never on the generic SQL-lint connection or a platform DB.
const PRIMARY = process.env.DATABASE_ROLES_TEST_URL;
const PREVIEW = process.env.DATABASE_ROLES_TEST_PREVIEW_URL;
const at = (base, database, user, password) => {
  const u = new URL(base); u.pathname = `/${database}`;
  if (user) { u.username = user; u.password = password; }
  return String(u);
};
async function use(url, fn) {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 120000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
// Match startup for both a fresh fixture and its later owner-role boot.
// Initialization SQL cannot be replayed after contract migrations drop columns.
async function migrateDatabase(url) {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await applySchemaWithLockRetry(pool);
    await seedReferenceData(pool);
  } finally { await pool.end(); }
}
async function denied(c, sql) {
  await assert.rejects(c.query(sql), e => ['42501', '25006'].includes(e.code));
}

test('database identities preserve runtime, migration and tenant-copy behavior', { timeout: 180000 }, async t => {
  if (!PRIMARY || !PREVIEW) { t.skip('set both DATABASE_ROLES_TEST URLs for disposable PostgreSQL servers'); return; }
  assert.notEqual(new URL(PRIMARY).host, new URL(PREVIEW).host, 'two independent servers are required');
  const id = crypto.randomBytes(5).toString('hex');
  const maintenance = `role_fixture_${id}`;
  const platform = `app_roles_${id}`;
  const source = `app_source_${id}`;
  const sourceOwner = `${source}_owner`;
  const roles = Object.fromEntries(['web', 'conductor', 'migrator', 'provisioner'].map(k => [k, `fixture_${id}_${k}`]));
  const passwords = Object.fromEntries([...Object.keys(roles), 'previewRead', 'previewProvisioner'].map(k => [k, crypto.randomBytes(24).toString('hex')]));
  const targets = [source + '_staging_s901_abcdef', source + '_staging_s902_abcdef'];
  const env = {
    DATABASE_ROLE_SPLIT: 'true', DATABASE_NAME: platform,
    DATABASE_BOOTSTRAP_URL: at(PRIMARY, maintenance), STAGING_DATABASE_BOOTSTRAP_URL: at(PREVIEW, maintenance),
    ...Object.fromEntries(Object.entries(roles).map(([k,v]) => [`DATABASE_${k.toUpperCase()}_USER`, v])),
    ...Object.fromEntries(Object.keys(roles).map(k => [`DATABASE_${k.toUpperCase()}_PASSWORD`, passwords[k]])),
    STAGING_DATABASE_READ_PASSWORD: passwords.previewRead, STAGING_DATABASE_PROVISIONER_PASSWORD: passwords.previewProvisioner,
    DATABASE_URL: at(PRIMARY, platform, roles.conductor, passwords.conductor),
    DB_ADMIN_URL: at(PRIMARY, maintenance, roles.provisioner, passwords.provisioner),
    STAGING_DB_ADMIN_URL: at(PREVIEW, maintenance, roles.provisioner, passwords.previewProvisioner),
    STAGING_DB_READ_URL: at(PREVIEW, maintenance, roles.web, passwords.previewRead),
    PROCESS_ROLE: 'conductor', USERNODE_ENV: 'production', STAGING_DB_TEMPLATES: '1',
    STAGING_DB_FILE_CLONE: '1', STAGING_DB_SERVER_DRAIN: '0',
  };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  const dbs = new Set([maintenance, platform, source]);
  const children = new Set();
  let mainPool;
  let readonlyRolesCreated = false;
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    if (mainPool) await mainPool.end();
    for (const [key,value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const base of [PRIMARY, PREVIEW]) await use(base, async c => {
      // Only fixture databases/roles, including templates owned by this
      // fixture's unique provisioner, can be removed by the cleanup.
      const databases = await c.query(`SELECT datname FROM pg_database WHERE datname = ANY($1::text[])
        OR datdba = (SELECT oid FROM pg_roles WHERE rolname = $2)`, [[...dbs, ...targets, source + '_stgtmpl'], roles.provisioner]);
      for (const {datname} of databases.rows) await c.query(`DROP DATABASE ${access.identifier(datname)} WITH (FORCE)`);
      if (base === PRIMARY && readonlyRolesCreated) {
        for (const role of ['usernode_debug_ro', 'topochain_console_ro']) await c.query(`DROP ROLE IF EXISTS ${role}`);
      }
      const ownedRoles = await c.query(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])
        OR starts_with(rolname, $2) OR starts_with(rolname, $3)`, [[...Object.values(roles), sourceOwner], source, platform]);
      for (const {rolname} of ownedRoles.rows) await c.query(`DROP ROLE ${access.identifier(rolname)}`);
    });
  });
  for (const base of [PRIMARY, PREVIEW]) await use(base, c => c.query(`CREATE DATABASE ${maintenance}`));
  await use(PRIMARY, async c => {
    await c.query(`CREATE DATABASE ${platform};`);
    await c.query(`CREATE ROLE ${sourceOwner} LOGIN PASSWORD 'synthetic-source-only'`);
    await c.query(`CREATE DATABASE ${source} OWNER ${sourceOwner}`);
    await c.query(`REVOKE CONNECT ON DATABASE ${source} FROM PUBLIC`);
  });
  await migrateDatabase(at(PRIMARY, platform));
  await use(at(PRIMARY, source), c => c.query(`CREATE EXTENSION pg_stat_statements;
    CREATE TABLE public.notes(id serial PRIMARY KEY, body text);
    INSERT INTO public.notes(body) VALUES ('synthetic retained row');
    ALTER TABLE public.notes OWNER TO ${sourceOwner};
    ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;
    CREATE POLICY nobody ON public.notes USING(false);
    CREATE SCHEMA copy_fixture AUTHORIZATION ${sourceOwner};
    CREATE TABLE copy_fixture.retained(id int PRIMARY KEY, body text);
    INSERT INTO copy_fixture.retained VALUES (1, 'synthetic secondary-schema row');
    ALTER TABLE copy_fixture.retained OWNER TO ${sourceOwner}`));
  await use(at(PRIMARY, source), c => c.query(`CREATE FUNCTION public.current_setting(text) RETURNS text
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'catalog lookup fixture'; END $$`));
  await use(PRIMARY, c => c.query(`ALTER DATABASE ${source} SET search_path = public, pg_catalog`));
  Object.assign(process.env, env);
  await t.test('bootstrap checks both servers for unresolved owners before changing logins', async () => {
    const legacy = source + '_legacy'; dbs.add(legacy);
    await use(PREVIEW, c => c.query(`CREATE ROLE ${sourceOwner}`));
    for (const base of [PRIMARY, PREVIEW]) await use(base, c => c.query(`CREATE DATABASE ${legacy}`));
    for (const base of [PRIMARY, PREVIEW]) {
      await assert.rejects(bootstrap(), { code: 'database_role_ownership_required' });
      for (const cluster of [PRIMARY, PREVIEW]) await use(cluster, async c => {
        const result = await c.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1::text[])', [Object.values(roles)]);
        assert.equal(result.rows[0].n, 0, 'no cutover login is changed before both ownership checks pass');
      });
      await use(base, async c => {
        await c.query(`ALTER DATABASE ${legacy} OWNER TO ${sourceOwner}`);
      });
    }
  });
  await bootstrap();
  await bootstrap(); // re-running a release must preserve grants and templates

  await t.test('bootstrap retries publish a complete template after an interrupted preparation', async () => {
    await use(PRIMARY, async c => {
      const result = await c.query('SELECT datname FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=$1) AND starts_with(datname,$2)', [roles.provisioner, 'homeroom_empty_']);
      assert.ok(result.rows.length);
      for (const { datname } of result.rows) await c.query(`DROP DATABASE ${access.identifier(datname)} WITH (FORCE)`);
    });
    const child = fork(require.resolve('./fixtures/database-role-bootstrap'), [], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.add(child);
    const exited = once(child, 'exit');
    try {
      const message = await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(20000) }).then(([m]) => m),
        exited.then(() => { throw new Error('bootstrap fixture exited before preparation'); }),
      ]);
      child.kill('SIGKILL'); await exited; children.delete(child);
      assert.equal(message.type, 'prepared');
      assert.match(message.name, /^homeroom_prepare_[a-f0-9]{24}$/);
      await bootstrap();
      await use(PRIMARY, async c => {
        const ready = await c.query(`SELECT datallowconn, shobj_description(oid,'pg_database') AS marker
          FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=$1) AND starts_with(datname,$2)`, [roles.provisioner, 'homeroom_empty_']);
        assert.ok(ready.rows.length);
        for (const row of ready.rows) { assert.equal(row.datallowconn, false); assert.match(row.marker, /homeroom-extension-template/); }
        // The interrupted empty attempt was never trusted as a ready template.
        assert.equal((await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [message.name])).rows.length, 1);
        await c.query(`DROP DATABASE ${access.identifier(message.name)} WITH (FORCE)`);
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited; children.delete(child);
    }
  });

  await t.test('role adoption uses the administrative catalogs despite temporary relation names', async () => {
    const lateRole = source + '_late_owner';
    await use(PRIMARY, c => c.query(`CREATE ROLE ${lateRole}`));
    await use(env.DB_ADMIN_URL, async c => {
      for (const table of ['pg_roles', 'pg_auth_members', 'pg_database']) {
        await c.query(`CREATE TEMP VIEW ${table} AS SELECT * FROM pg_catalog.${table} WHERE false`);
      }
      await c.query('SELECT public.homeroom_adopt_app_roles()');
      assert.equal((await c.query('SELECT pg_catalog.pg_has_role(current_user,$1,$2) ok', [lateRole, 'SET'])).rows[0].ok, true);
    });
    // Multiple maintenance callers may discover the same newly created role.
    const concurrentRole = source + '_concurrent';
    await use(PRIMARY, c => c.query(`CREATE ROLE ${concurrentRole}`));
    let arrived = 0, release;
    const ready = new Promise(resolve => { release = resolve; });
    await Promise.all(Array.from({length: 6}, () => use(env.DB_ADMIN_URL, async c => {
      if (++arrived === 6) release();
      await ready;
      await c.query('SELECT public.homeroom_adopt_app_roles()');
    })));
    await use(env.DB_ADMIN_URL, async c => {
      assert.equal((await c.query('SELECT pg_catalog.pg_has_role(current_user,$1,$2) ok', [concurrentRole, 'SET'])).rows[0].ok, true);
    });
  });

  await t.test('serving logins have DML and default grants without DDL or role authority', async () => {
    for (const kind of ['web', 'conductor']) await use(at(PRIMARY, platform, roles[kind], passwords[kind]), async c => {
      await access.assertLogin(c, kind);
      await c.query('SELECT count(*) FROM public.users');
      for (const sql of ['CREATE TABLE public.role_probe(id int)', 'CREATE ROLE role_probe', 'CREATE DATABASE role_probe',
        `SET ROLE ${roles.migrator}`, `SET ROLE ${roles.provisioner}`]) {
        await denied(c, sql);
      }
    });
    await use(at(PRIMARY, platform, roles.migrator, passwords.migrator), async c => {
      await access.assertLogin(c, 'migrator');
      await c.query('CREATE TABLE public.role_default_grant(id serial PRIMARY KEY, body text)');
      await denied(c, 'CREATE ROLE role_probe');
      // The real migration entry point runs as the owner and verifies receipts
      // without replaying baseline DDL over an already-contracted schema.
      await migrateDatabase(at(PRIMARY, platform, roles.migrator, passwords.migrator));
      // The migration Job's grants: one transaction, web's writes taken last.
      await c.query('BEGIN');
      await ensureRuntimeGrants(c, env);
      await takeWebWorkflowWrites(c, env);
      await c.query('COMMIT');
      const reconcile = async () => {
        const statements = [];
        const observed = { query: (sql, values) => {
          statements.push(sql); return c.query(sql, values);
        } };
        await c.query('BEGIN');
        try {
          await ensureRuntimeGrants(observed, env);
          await takeWebWorkflowWrites(observed, env);
          await c.query('COMMIT');
        } catch (err) { await c.query('ROLLBACK'); throw err; }
        return statements.filter(sql => /^\s*(GRANT|REVOKE|ALTER)\b/.test(sql));
      };
      assert.deepEqual(await reconcile(), [], 'unchanged runtime permissions execute no DDL');
      await c.query(`REVOKE SELECT ON public.apps FROM ${access.identifier(roles.web)};
        GRANT UPDATE ON public.wf_events TO ${access.identifier(roles.web)};
        GRANT DELETE ON public.schema_migrations TO ${access.identifier(roles.conductor)};
        GRANT UPDATE ON public.apps TO ${access.identifier(roles.provisioner)};
        GRANT CREATE ON SCHEMA public TO ${access.identifier(roles.web)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT UPDATE ON TABLES TO ${access.identifier(roles.provisioner)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM ${access.identifier(roles.provisioner)}`);
      assert.ok((await reconcile()).length, 'a missing grant, default grant and excess writes cause repair');
      const { rows: [fixed] } = await c.query(`SELECT
        has_table_privilege($1, 'public.apps', 'SELECT') AS reads,
        has_table_privilege($1, 'public.wf_events', 'UPDATE') AS decides,
        has_table_privilege($2, 'public.schema_migrations', 'DELETE') AS edits_receipts,
        has_table_privilege($3, 'public.apps', 'UPDATE') AS reader_writes,
        has_schema_privilege($1, 'public', 'CREATE') AS creates`, [roles.web, roles.conductor, roles.provisioner]);
      assert.deepEqual(fixed, { reads: true, decides: false, edits_receipts: false, reader_writes: false, creates: false });
      assert.deepEqual(await reconcile(), [], 'the repaired policy returns to the no-DDL path');
      // A web process of a build that still writes the kernel's tables keeps
      // them: the grants refuse in their own transaction, changing nothing.
      await c.query("INSERT INTO public.platform_processes (id, role, heartbeat_at) VALUES ('role-probe-earlier', 'web', now())");
      try {
        await c.query('BEGIN');
        await assert.rejects(takeWebWorkflowWrites(c, env), { code: 'web_restriction_not_ready' });
      } finally {
        await c.query('ROLLBACK');
        await c.query("DELETE FROM public.platform_processes WHERE id = 'role-probe-earlier'");
      }
    });
    for (const kind of ['web', 'conductor']) await use(at(PRIMARY, platform, roles[kind], passwords[kind]), async c => {
      const { rows } = await c.query("INSERT INTO public.role_default_grant(body) VALUES ('default grant') RETURNING id");
      assert.ok(rows[0].id > 0);
      await c.query('UPDATE public.role_default_grant SET body=body');
      await c.query('DELETE FROM public.role_default_grant');
      await c.query('SELECT * FROM public.schema_migrations');
      for (const sql of ['DELETE FROM public.schema_migrations',
        'TRUNCATE public.schema_migrations']) await denied(c, sql);
    });
    await use(at(PRIMARY, platform, roles.migrator, passwords.migrator), c => c.query('DROP TABLE public.role_default_grant'));
    // The workflow kernel: web appends and withdraws its own request, the
    // database records which login appended, and only the conductor decides.
    const probe = (c) => c.query(`INSERT INTO public.wf_events (machine, key, type, source, request_key)
      VALUES ('role-probe', 'k', 'Asked', '{"kind":"route"}', gen_random_uuid()::text) RETURNING id, producer`);
    await use(at(PRIMARY, platform, roles.web, passwords.web), async c => {
      const { rows: [e] } = await probe(c);
      assert.equal(e.producer, 'web');
      for (const sql of [`UPDATE public.wf_events SET status = 'held' WHERE id = ${e.id}`, 'DELETE FROM public.wf_work',
        "INSERT INTO public.wf_settings (key, value) VALUES ('role-probe', '1')", "UPDATE public.wf_instances SET state = 'x'",
        "INSERT INTO public.wf_events (machine, key, type, source, request_key, retry_at) VALUES ('role-probe', 'k', 'Asked', '{\"kind\":\"route\"}', 'late', '2999-01-01')"]) {
        await denied(c, sql);
      }
      assert.equal((await c.query('SELECT public.wf_refuse_pending($1, $2) AS refused', [e.id, 'expired'])).rows[0].refused, true);
    });
    await use(at(PRIMARY, platform, roles.conductor, passwords.conductor), async c => {
      assert.equal((await probe(c)).rows[0].producer, 'platform');
      await c.query("BEGIN; SET LOCAL app.wf_writer = 'transition'; DELETE FROM public.wf_events WHERE machine = 'role-probe'; COMMIT");
    });
    // Who is an administrator: each runtime login's change is recorded under
    // that login, and neither can write, rewrite or switch off the record.
    const { rows: [probeUser] } = await use(at(PRIMARY, platform, roles.conductor, passwords.conductor), c =>
      c.query("INSERT INTO public.users (username, password) VALUES ('privilege-probe', 'x') RETURNING id"));
    const { rows: [probeApp] } = await use(at(PRIMARY, platform, roles.conductor, passwords.conductor), c =>
      c.query("INSERT INTO public.apps (name, slug, created_by, status) VALUES ('Privilege probe', 'privilege-probe', $1, 'running') RETURNING id", [probeUser.id]));
    await use(at(PRIMARY, platform, roles.web, passwords.web), c =>
      c.query('UPDATE public.users SET is_admin = TRUE WHERE id = $1', [probeUser.id]));
    await use(at(PRIMARY, platform, roles.conductor, passwords.conductor), c =>
      c.query('INSERT INTO public.app_admins (app_id, user_id) VALUES ($1, $2)', [probeApp.id, probeUser.id]));
    for (const kind of ['web', 'conductor']) await use(at(PRIMARY, platform, roles[kind], passwords[kind]), async c => {
      const { rows } = await c.query(
        'SELECT login, change, app_id, before, after FROM public.privilege_changes WHERE user_id = $1 ORDER BY changed_at', [probeUser.id]);
      assert.deepEqual(rows, [
        { login: roles.web, change: 'platform_admin', app_id: null,
          before: { is_admin: false, admin_readonly: false }, after: { is_admin: true, admin_readonly: false } },
        { login: roles.conductor, change: 'app_admin', app_id: probeApp.id,
          before: null, after: { app_id: probeApp.id, user_id: probeUser.id } },
      ], kind);
      for (const sql of [
        `INSERT INTO public.privilege_changes (login, change, user_id) VALUES ('forged', 'platform_admin', ${probeUser.id})`,
        "UPDATE public.privilege_changes SET login = 'forged'", 'DELETE FROM public.privilege_changes',
        'TRUNCATE public.privilege_changes', 'ALTER TABLE public.users DISABLE TRIGGER users_record_admin_change',
        'ALTER TABLE public.app_admins DISABLE TRIGGER app_admins_record_change', 'SET session_replication_role = replica',
      ]) await denied(c, sql);
    });
    await use(at(PRIMARY, platform, roles.migrator, passwords.migrator), async c => {
      await c.query('DELETE FROM public.apps WHERE id = $1', [probeApp.id]);
      await c.query('DELETE FROM public.users WHERE id = $1', [probeUser.id]);
      await c.query('DELETE FROM public.privilege_changes WHERE user_id = $1', [probeUser.id]);
    });
    await use(env.DB_ADMIN_URL, c => access.assertLogin(c, 'provisioner'));
    await use(at(PRIMARY, platform), async c => {
      await c.query(`SET ROLE ${roles.web}`);
      await assert.rejects(access.assertLogin(c, 'web'), /required privileges/);
    });
    await use(PRIMARY, async admin => {
      await admin.query(`GRANT ${roles.migrator} TO ${roles.web} WITH INHERIT FALSE, SET TRUE`);
      try {
        await use(at(PRIMARY, platform, roles.web, passwords.web), c =>
          assert.rejects(access.assertLogin(c, 'web'), /required privileges/));
      } finally { await admin.query(`REVOKE ${roles.migrator} FROM ${roles.web}`); }
    });
    for (const kind of ['web', 'conductor']) await use(at(PRIMARY, maintenance, roles[kind], passwords[kind]), c => denied(c, 'SELECT public.homeroom_adopt_app_roles()'));
  });

  await t.test('connection diagnostics count other logins without exposing their queries', async () => {
    await use(at(PRIMARY, platform), async admin => {
      await use(at(PRIMARY, platform, roles.web, passwords.web), async web => {
        const census = await require('../src/db/connection-census').connectionCensus(web);
        assert.ok(census.used >= 2);
        assert.ok(census.topDatabases.some(row => row.name === platform && row.count >= 2));
        const result = await web.query('SELECT query FROM pg_stat_activity WHERE pid = $1', [admin.processID]);
        assert.equal(result.rows[0].query, '<insufficient privilege>');
      });
    });
  });

  await t.test('preview pressure recovery can read complete counts on its maintenance connection', async () => {
    await use(at(PREVIEW, maintenance), async () => {
      const manager = require('../src/services/db-manager');
      const census = await require('../src/db/connection-census').connectionCensus(manager.previewServerQueryable());
      assert.ok(census, 'preview maintenance census must remain available');
      assert.ok(census.used >= 2);
      assert.ok(census.topDatabases.some(row => row.name === maintenance && row.count >= 2));
    });
  });

  await t.test('read-only capabilities use the provisioner for roles and migrator for grants', async () => {
    Object.assign(process.env, { DATABASE_URL: at(PRIMARY, platform, roles.migrator, passwords.migrator) });
    const config = { databaseUrl: process.env.DATABASE_URL, dataEncryptionKey: 'synthetic-fixture-key', dbPoolMax: 1 };
    mainPool = require('../src/db/pool').getPool(config);
    // These cluster role names are fixed by the product. Refuse to alter a
    // pre-existing capability on a misconfigured test server.
    await use(PRIMARY, async c => {
      const {rows} = await c.query("SELECT rolname FROM pg_roles WHERE rolname IN ('usernode_debug_ro','topochain_console_ro')");
      assert.equal(rows.length, 0, 'disposable test server must not already have platform readonly roles');
    });
    readonlyRolesCreated = true;
    await require('../src/services/db-roles').ensureRoles(config);
    const debug = require('../src/services/debug-access');
    const consoleRole = require('../src/services/topochain/db-console-role');
    assert.equal(debug.isAvailable(), true);
    assert.equal(consoleRole.isAvailable(), true);
    const ddl = [];
    const originalQuery = Client.prototype.query;
    Client.prototype.query = function (...args) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (/^\s*(GRANT|REVOKE|ALTER|DO)\b/.test(sql || '')) ddl.push(sql);
      return originalQuery.apply(this, args);
    };
    try {
      await require('../src/services/db-roles').ensureRoles(config);
      assert.deepEqual(ddl, [], 'unchanged readonly capabilities execute no role or permission DDL');
      for (const drift of [
        'REVOKE SELECT ON public.apps FROM topochain_console_ro',
        'GRANT UPDATE (status) ON public.apps TO topochain_console_ro',
        'GRANT SELECT (password) ON public.users TO topochain_console_ro',
        'ALTER ROLE topochain_console_ro SET default_transaction_read_only = off',
        'GRANT USAGE ON SCHEMA credentials TO topochain_console_ro',
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${access.identifier(roles.migrator)} IN SCHEMA public GRANT SELECT ON TABLES TO topochain_console_ro`,
      ]) {
        await use(at(PRIMARY, platform), c => c.query(drift));
        ddl.length = 0;
        await require('../src/services/db-roles').ensureRoles(config);
        assert.equal(consoleRole.isAvailable(), true, `repair succeeds: ${drift}`);
        assert.equal(debug.isAvailable(), true);
        assert.ok(ddl.length, 'incorrect permissions trigger repair');
        ddl.length = 0;
        await require('../src/services/db-roles').ensureRoles(config);
        assert.deepEqual(ddl, [], 'the repaired policy returns to the no-DDL path');
      }
      await mainPool.query('CREATE TABLE public.fresh_permission_probe(id int)');
      await require('../src/services/db-roles').ensureRoles(config);
      assert.equal(consoleRole.isAvailable(), true, 'new schema objects receive their declared permissions');
      await use(at(PRIMARY, platform, roles.web, passwords.web), async c => {
        await c.query('BEGIN READ ONLY');
        await c.query('SET LOCAL ROLE topochain_console_ro');
        await c.query('SELECT * FROM public.fresh_permission_probe');
        await c.query('ROLLBACK');
      });
      await mainPool.query('DROP TABLE public.fresh_permission_probe');
      await use(at(PRIMARY, platform), c => c.query('DROP OWNED BY topochain_console_ro; DROP ROLE topochain_console_ro'));
      await require('../src/services/db-roles').ensureRoles(config);
      assert.equal(consoleRole.isAvailable(), true, 'a missing console role is recreated with the current policy');
    } finally { Client.prototype.query = originalQuery; }
    await debug.closePool();
    await use(at(PRIMARY, platform, roles.web, passwords.web), async c => {
      await c.query('BEGIN READ ONLY');
      await c.query('SET LOCAL ROLE topochain_console_ro');
      await c.query('SELECT count(*) FROM public.onchain_accounts');
      await denied(c, 'SELECT * FROM credentials.user_ai_credentials');
      await c.query('ROLLBACK');
    });
    Object.assign(process.env, { DATABASE_URL: env.DATABASE_URL });
  });

  await t.test('the provisioner creates and drops a production app database without the platform owner', async () => {
    const target = source + '_new'; dbs.add(target);
    const manager = require('../src/services/db-manager');
    assert.deepEqual(await manager.existingRoles([sourceOwner, source + '_absent_owner']), new Set([sourceOwner]),
      'the real bulk catalog lookup distinguishes existing and missing roles');
    const result = await manager.createDatabase(target);
    await use(manager.connectionUrl(target, result.password), c => c.query('CREATE TABLE public.created_by_app(id int)'));
    await manager.dropDatabase(target, { strict: true, server: manager.PRIMARY_SERVER });
    await use(PRIMARY, async c => {
      assert.equal((await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [target])).rows.length, 0);
      assert.equal((await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [manager.ownerRoleName(target)])).rows.length, 0);
    });
  });

  await t.test('copies use prepared extensions and preserve source rows under forced RLS', async () => {
    const manager = require('../src/services/db-manager');
    for (const [i, target] of targets.entries()) {
      const result = await manager.cloneDatabase(source, target, { viaTemplate: i === 1 });
      assert.equal(result.server, manager.PREVIEW_SERVER);
      assert.equal(result.via, i === 0 ? 'direct' : 'template');
      await use(manager.connectionUrl(target, result.password, { server: result.server }), async c => {
        assert.equal((await c.query('SELECT count(*)::int n FROM notes')).rows[0].n, 0);
        assert.equal((await c.query('SELECT body FROM copy_fixture.retained')).rows[0].body,
          'synthetic secondary-schema row');
        const schema = await c.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='copy_fixture'");
        assert.equal(schema.rows[0].owner, manager.ownerRoleName(target));
        const reset = await c.query(`SELECT r.rolsuper AS operator_owned,
          p.proowner = e.extowner AS extension_owned,
          has_function_privilege(current_user, p.oid, 'EXECUTE') AS executable
          FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
          JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
          JOIN pg_extension e ON d.refclassid='pg_extension'::regclass AND d.refobjid=e.oid
          WHERE e.extname='pg_stat_statements' AND p.proname='pg_stat_statements_reset'`);
        assert.deepEqual(reset.rows, [{ operator_owned: true, extension_owned: true, executable: false }]);
        await denied(c, `SET ROLE ${roles.provisioner}`);
      });
      await use(at(PREVIEW, target, roles.provisioner, passwords.previewProvisioner), async c => {
        assert.equal((await c.query('SELECT count(*)::int n FROM notes')).rows[0].n, 1);
      });
      await assert.rejects(use(at(PREVIEW, target, roles.web, passwords.previewRead), c => c.query('SELECT 1')), { code: '42501' });
    }
    await use(at(PRIMARY, source), async c => {
      const owners = await c.query(`SELECT pg_get_userbyid(n.nspowner) AS schema_owner,
        pg_get_userbyid(r.relowner) AS table_owner FROM pg_namespace n
        JOIN pg_class r ON r.relnamespace=n.oid WHERE n.nspname='copy_fixture' AND r.relname='retained'`);
      assert.deepEqual(owners.rows, [{ schema_owner: sourceOwner, table_owner: sourceOwner }]);
      assert.equal((await c.query('SELECT count(*)::int n FROM copy_fixture.retained')).rows[0].n, 1);
    });
  });

  // SEC-06: a platform preview starts EMPTY (its own boot builds and seeds
  // it), on the preview server, owned by its own login; nothing is read from
  // the platform's database and no template of it is made.
  await t.test('platform previews start empty as their own owner and copy nothing', async () => {
    const username = `fixture_${id}`;
    const { rows: [user] } = await use(at(PRIMARY, platform, roles.conductor, passwords.conductor), c =>
      c.query("INSERT INTO users(username, password) VALUES ($1, $2) RETURNING id", [username, 'synthetic-source-hash']));
    await use(at(PRIMARY, platform, roles.conductor, passwords.conductor), c =>
      c.query("INSERT INTO credentials.user_ai_credentials(user_id, provider, purpose, secret_enc) VALUES ($1, 'openrouter', 'coding_agent', 'synthetic-ciphertext')", [user.id]));
    await use(at(PRIMARY, platform, roles.conductor, passwords.conductor), c =>
      c.query("INSERT INTO apps(name,slug,self_hosted) VALUES ('Homeroom fixture','usernode-2d5619',TRUE)"));
    const manager = require('../src/services/db-manager');
    dbs.add(platform + '_stgtmpl');
    dbs.add(platform + '_stgtmpl_next');
    async function checkEmpty(target, result) {
      assert.equal(result.via, 'empty');
      assert.equal(result.server, manager.PREVIEW_SERVER);
      await use(manager.connectionUrl(target, result.password, { server: result.server }), async c => {
        const owner = await c.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()');
        assert.equal(owner.rows[0].owner, manager.ownerRoleName(target));
        const relations = await c.query(`SELECT count(*)::int n FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND r.relkind IN ('r', 'p', 'v', 'm', 'S')`);
        assert.equal(relations.rows[0].n, 0, 'no table, view or sequence: the preview\'s own boot makes them');
        await denied(c, `SET ROLE ${roles.provisioner}`);
      });
    }
    for (const [number, viaTemplate] of [[903, false], [904, true]]) {
      const target = platform + `_staging_s${number}_abcdef`; dbs.add(target);
      await checkEmpty(target, await manager.cloneDatabase(platform, target, { viaTemplate }));
    }
    const sourceId = `role-fixture-${id}`;
    dbs.add(manager.preparedCloneSourceName(platform, sourceId));
    const prepared = await manager.prepareStagingCloneSource(platform, { sourceId });
    const target = platform + '_staging_s905_abcdef'; dbs.add(target);
    try {
      await checkEmpty(target, await manager.cloneFromPreparedSource(prepared, target));
    } finally {
      await manager.releasePreparedCloneSource(prepared);
    }
    for (const server of [PRIMARY, PREVIEW]) {
      await use(server, async c => {
        const templates = await c.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
          [[platform + '_stgtmpl', platform + '_stgtmpl_next']]);
        assert.deepEqual(templates.rows, [], 'no template of the platform\'s database');
      });
    }
    await use(at(PRIMARY, platform, roles.conductor, passwords.conductor), async c => {
      assert.equal((await c.query('SELECT count(*)::int n FROM credentials.user_ai_credentials')).rows[0].n, 1);
      const database = await c.query("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()");
      assert.equal(database.rows[0].owner, roles.migrator);
    });
  });

  await t.test('web exports and preview verdicts use only runtime reader credentials', async () => {
    Object.assign(process.env, { PROCESS_ROLE: 'web', DB_ADMIN_URL: '', STAGING_DB_ADMIN_URL: '',
      DATABASE_URL: at(PRIMARY, platform, roles.web, passwords.web) });
    const manager = require('../src/services/db-manager');
    assert.equal(await manager.previewDatabaseVerdict(manager.previewDatabaseLabels(targets[0], manager.PREVIEW_SERVER)), null);
    await assert.rejects(manager.createDatabase(source + '_web_probe'), /unavailable on web/);
    await use(env.STAGING_DB_READ_URL, async c => {
      await c.query('SELECT datname FROM pg_database');
      await denied(c, 'CREATE DATABASE role_probe');
    });
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, cb) { chunks.push(chunk); cb(); } });
    res.setHeader = () => {};
    process.env.DB_ADMIN_URL = 'postgres://synthetic:unused@127.0.0.1:1/unused';
    const result = await require('../src/services/db-export').runExport({ dbName: platform, res, filename: 'fixture.sql.gz' });
    assert.equal(result.status, 'completed', result.error);
    assert.match(gunzipSync(Buffer.concat(chunks)).toString(), /CREATE TABLE public.users/);
  });
});
