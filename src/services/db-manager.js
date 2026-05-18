const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const log = require('./logger');

const execFileAsync = promisify(execFile);

const DB_CONTAINER = process.env.DB_CONTAINER || 'project-usernode-db';
const DB_USER = process.env.DB_USER || 'usernode';

// All app DBs and their dedicated roles use these names. Slugs are
// already passed through the same regex on the way in, so the worst
// case here is a name we refuse to act on; better than splicing user
// input into DDL even by accident.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;
const SAFE_QUALIFIED_IDENT = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i;

// The role name suffix is hard-coded so callers don't need to think
// about it. Every DB `app_xyz` has role `app_xyz_owner`.
const ROLE_SUFFIX = '_owner';

// Sentinel for NOT NULL columns scrubbed by `staging:private`. Chosen
// to be obviously non-functional in any auth or token-comparison path:
// bcrypt-style hashes start with `$2{a,b,y}$`, so bcrypt.compare
// against this string returns false for every input. Same shape works
// for any opaque-token column (wallet links, API keys); the auth path
// would need to special-case the literal to ever accept it, and we
// don't.
const STAGING_REDACTED_SENTINEL = '__staging_redacted__';

function appDbName(slug) {
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}`;
}

function stagingDbName(slug, username, commitHash) {
  const shortHash = commitHash.substring(0, 6);
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_${username.replace(/[^a-z0-9_]/g, '_')}_${shortHash}`;
}

function ownerRoleName(dbName) {
  return `${dbName}${ROLE_SUFFIX}`;
}

function generatePassword() {
  // 24 random bytes → 48 hex chars. Hex contains no URL- or SQL-special
  // characters, so the password is safe to splice into a `postgres://`
  // URL or a `CREATE ROLE … PASSWORD '…'` statement without escaping.
  return crypto.randomBytes(24).toString('hex');
}

// Build the connection URL for an app or staging DB using its
// dedicated role. The password is required — passing it explicitly at
// every call site rather than reading it from env makes the
// per-DB-credential model visible in the code: every place that opens
// a connection has to come up with the right credential, instead of
// silently falling back to the superuser. See SELF-HOSTING.md
// "Per-app postgres roles".
function connectionUrl(dbName, password) {
  if (!dbName || !SAFE_IDENT.test(dbName)) {
    throw new Error(`connectionUrl: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  if (!password || typeof password !== 'string') {
    throw new Error(
      `connectionUrl: password required for ${dbName}. ` +
      `If this is a legacy app row that pre-dates the per-role migration, ` +
      `db/migrate.js's migrateAppDbsToPerRole should have populated apps.db_password ` +
      `before any caller invoked connectionUrl. Likely cause: race between migration ` +
      `and a subsystem that started before it finished.`
    );
  }
  const role = ownerRoleName(dbName);
  return `postgres://${role}:${encodeURIComponent(password)}@${DB_CONTAINER}:5432/${dbName}`;
}

// Create a fresh database with a dedicated owner role. Caller MUST
// persist the returned password (e.g. into apps.db_password) — it
// can't be recovered after this call returns. Throws on any failure;
// no half-state is left behind because both CREATE statements run as
// independent commands and the caller will see the error.
async function createDatabase(dbName) {
  if (!SAFE_IDENT.test(dbName)) {
    throw new Error(`createDatabase: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  const role = ownerRoleName(dbName);
  if (!SAFE_IDENT.test(role)) {
    throw new Error(`createDatabase: unsafe role ${JSON.stringify(role)}`);
  }
  const password = generatePassword();

  log.info('db-manager', 'Creating database with dedicated role', { dbName, role });

  // CREATE ROLE is independent of database existence. If the role
  // already exists from a partial earlier run, ALTER its password
  // instead so the caller's persisted value is what actually grants
  // access.
  await execInDb(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
      CREATE ROLE ${role} LOGIN PASSWORD '${password}';
    ELSE
      ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}';
    END IF;
  END $$;`);

  try {
    await execInDb(`CREATE DATABASE ${dbName} OWNER ${role}`);
  } catch (err) {
    if (err.message?.includes('already exists')) {
      // Pre-existing DB. Adopt it instead — set the owner, lock down
      // PUBLIC, hand back the new password. Idempotent if the DB is
      // already owned by this role.
      log.info('db-manager', 'Database already exists; adopting under per-role model', { dbName, role });
      await execInDb(`ALTER DATABASE ${dbName} OWNER TO ${role}`);
    } else {
      throw err;
    }
  }

  // Belt-and-suspenders: lock down PUBLIC so even a hypothetical
  // future role (with default permissions) can't connect. Owner +
  // superuser still can.
  await execInDb(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`);
  await execInDb(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${role}`);

  // Reassign any objects in the DB currently owned by the superuser
  // to the new role — a no-op for fresh CREATEs (no objects yet) but
  // important for the adoption branch above. We can't use
  // `REASSIGN OWNED BY ${DB_USER}` here because the superuser also
  // owns pg_toast tables pinned to pg_catalog, and postgres refuses
  // the whole REASSIGN when any system-required objects are involved
  // — see reassignUserObjectsTo for the full rationale.
  await reassignUserObjectsTo(dbName, DB_USER, role).catch((err) => {
    log.warn('db-manager', 'reassignUserObjectsTo skipped (likely no objects yet)', {
      dbName, err: err.message,
    });
  });

  log.info('db-manager', 'Database created with role', { dbName, role });
  return { password };
}

// Drop a database AND its dedicated role. Order matters: postgres
// won't drop a role that owns objects, so the DB has to go first.
// `DROP OWNED BY <role>` cleans up any cluster-level privileges
// (none in our model, but defensive).
async function dropDatabase(dbName) {
  log.info('db-manager', 'Dropping database', { dbName });

  if (!SAFE_IDENT.test(dbName)) {
    log.warn('db-manager', 'Refusing to drop database with unsafe name', { dbName });
    return;
  }

  // Terminate any open connections so DROP DATABASE doesn't error.
  await execInDb(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`
  ).catch(() => {});

  try {
    await execInDb(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch (err) {
    log.warn('db-manager', 'Failed to drop database', { dbName, err: err.message });
    // Don't try to drop the role if the DB drop failed — the role
    // still owns it.
    return;
  }

  const role = ownerRoleName(dbName);
  if (!SAFE_IDENT.test(role)) return;

  await execInDb(`DROP OWNED BY ${role} CASCADE`).catch(() => {});
  await execInDb(`DROP ROLE IF EXISTS ${role}`).catch((err) => {
    log.warn('db-manager', 'Failed to drop role (may still own objects in another DB)', {
      role, err: err.message,
    });
  });

  log.info('db-manager', 'Database and role dropped', { dbName, role });
}

async function cloneDatabase(sourceDb, targetDb) {
  log.info('db-manager', 'Cloning database', { sourceDb, targetDb });

  if (!SAFE_IDENT.test(sourceDb) || !SAFE_IDENT.test(targetDb)) {
    throw new Error(`cloneDatabase: unsafe identifiers ${sourceDb}/${targetDb}`);
  }

  // Drop any prior clone (and its role) before cloning fresh. The
  // dropDatabase below also takes care of the role.
  await dropDatabase(targetDb);

  // Terminate active connections to source so CREATE DATABASE TEMPLATE
  // doesn't error with "source database … is being accessed".
  await execInDb(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${sourceDb}' AND pid <> pg_backend_pid()`
  ).catch(() => {});

  // Create the per-clone role first so we can pass it as OWNER to
  // CREATE DATABASE. This means the cloned DB starts owned by the
  // new role, no separate ALTER step.
  const targetRole = ownerRoleName(targetDb);
  if (!SAFE_IDENT.test(targetRole)) {
    throw new Error(`cloneDatabase: unsafe target role ${targetRole}`);
  }
  const password = generatePassword();
  await execInDb(`CREATE ROLE ${targetRole} LOGIN PASSWORD '${password}'`);

  await execInDb(`CREATE DATABASE ${targetDb} TEMPLATE ${sourceDb} OWNER ${targetRole}`);

  // Lock down PUBLIC connect on the clone — the clone is single-tenant
  // (one staging container) and nothing else should be able to reach it.
  await execInDb(`REVOKE CONNECT ON DATABASE ${targetDb} FROM PUBLIC`);
  await execInDb(`GRANT ALL PRIVILEGES ON DATABASE ${targetDb} TO ${targetRole}`);

  // CREATE DATABASE … TEMPLATE copies tables but each one keeps its
  // original owner from the source DB. For a clone of a per-role-
  // migrated source, that owner is `<sourceDb>_owner`; for a clone
  // of a not-yet-migrated source (the self-app — db/migrate.js skips
  // self_hosted rows in migrateAppDbsToPerRole) it's the superuser.
  // Reassign every object inside the target DB to the new clone role
  // so it can ALTER, SELECT, INSERT, and DROP without privilege errors.
  //
  // The source-role REASSIGN handles the child-app fast path: every
  // user-schema table is owned by `<sourceDb>_owner`, no superuser
  // ownership in the picture, plain REASSIGN OWNED BY works. If the
  // source role doesn't exist (the self-app case), this is a no-op and
  // the fallback below picks up the slack.
  //
  // The superuser fallback CANNOT be a plain `REASSIGN OWNED BY` — the
  // superuser also owns pg_toast tables pinned to pg_catalog, and
  // postgres aborts the whole REASSIGN with "cannot reassign ownership
  // of objects owned by role X because they are required by the
  // database system". That used to be swallowed at .catch(debug) here,
  // which silently left tables owned by the superuser and produced
  // clones the new role couldn't ALTER — staging then crash-looped
  // with `42501 must be owner of table users` on the first migration.
  // reassignUserObjectsTo walks only user-schema objects (skipping
  // pg_catalog), so it works against superuser-owned sources too.
  const sourceRole = ownerRoleName(sourceDb);
  if (SAFE_IDENT.test(sourceRole)) {
    await execInTarget(targetDb, `REASSIGN OWNED BY ${sourceRole} TO ${targetRole}`).catch((err) => {
      log.warn('db-manager', 'REASSIGN OWNED BY source-role failed; falling back to per-object reassign from superuser', {
        sourceDb, sourceRole, err: err.message,
      });
    });
  }
  await reassignUserObjectsTo(targetDb, DB_USER, targetRole).catch((err) => {
    log.warn('db-manager', 'reassignUserObjectsTo from superuser failed', {
      targetDb, err: err.message,
    });
  });

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
  // tokens get redacted; and `apps`, where the app row identity is
  // visible but per-app db_password values get NULL'd.
  //
  // Failures in either pass are fatal — refusing to spawn a staging
  // container is strictly safer than spawning one that leaks. Tables
  // truncated in pass 1 are no-ops for pass 2 (UPDATE on empty), so
  // tagging both levels on the same table is harmless.
  await truncatePrivateTables(targetDb);
  await scrubPrivateColumns(targetDb);

  log.info('db-manager', 'Database cloned with new role', { sourceDb, targetDb, targetRole });
  return { password };
}

// Replacement for `REASSIGN OWNED BY <fromRole> TO <toRole>` in cases
// where `fromRole` is a postgres superuser (in our setup, the
// `usernode` user that owns every per-app database). Postgres refuses
// `REASSIGN OWNED BY` for any role that also owns pinned objects in
// pg_catalog — and every superuser does, because pg_toast tables
// attached to system catalogs are owned by whichever role created
// the database. The error reads:
//
//   ERROR: cannot reassign ownership of objects owned by role <r>
//   because they are required by the database system
//
// …which aborts the entire REASSIGN even though the user-schema
// objects we actually want to move are perfectly reassignable. This
// helper enumerates only objects in non-system schemas and ALTERs
// each one individually, which is exactly what REASSIGN OWNED BY
// would have done if it had a "skip system objects" mode. Indexes,
// pg_toast tables, and other dependent objects follow their parent
// table automatically. We cover:
//
//   - relations    (tables, partitioned tables, views, matviews,
//                   sequences, foreign tables) via pg_class
//   - functions    via pg_proc
//   - types        (enum/domain/standalone composite — we skip the
//                   row types autogenerated for tables, those follow
//                   the table via the relation pass)
//   - schemas      (any user-created schema; we leave `public`
//                   alone because postgres special-cases its owner)
//
// Names are validated by SAFE_IDENT before being spliced. The DO
// block uses format(%I) for inner identifiers belt-and-suspenders.
async function reassignUserObjectsTo(dbName, fromRole, toRole) {
  if (!SAFE_IDENT.test(dbName)) {
    throw new Error(`reassignUserObjectsTo: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  if (!SAFE_IDENT.test(fromRole)) {
    throw new Error(`reassignUserObjectsTo: unsafe fromRole ${JSON.stringify(fromRole)}`);
  }
  if (!SAFE_IDENT.test(toRole)) {
    throw new Error(`reassignUserObjectsTo: unsafe toRole ${JSON.stringify(toRole)}`);
  }

  const sql = `
DO $$
DECLARE r RECORD;
BEGIN
  -- Relations: tables, partitioned tables, views, matviews,
  -- sequences, foreign tables. Indexes (relkind='i') and toast
  -- tables (relkind='t') are deliberately omitted; they inherit
  -- ownership from their parent table on ALTER TABLE OWNER TO.
  --
  -- The NOT EXISTS clause skips sequences (and any other relation)
  -- that pg_depend marks as auto/internal-linked to a parent table
  -- — i.e. the SERIAL/IDENTITY sequences postgres creates implicitly
  -- when you declare an auto-increment column. Postgres refuses to
  -- ALTER … OWNER TO those independently of their parent ("cannot
  -- change owner of sequence X: linked to table Y"), and ALTER TABLE
  -- on the parent already transfers them. Filtering here keeps the
  -- DO block side-effect-clean instead of relying on per-statement
  -- error swallowing.
  FOR r IN
    SELECT n.nspname, c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles role  ON role.oid = c.relowner
     WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND role.rolname = '${fromRole}'
       AND c.relkind IN ('r','p','v','m','S','f')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = c.oid
            AND d.classid = 'pg_class'::regclass
            AND d.deptype IN ('a','i')
       )
  LOOP
    EXECUTE format(
      'ALTER %s %I.%I OWNER TO %I',
      CASE r.relkind
        WHEN 'r' THEN 'TABLE'
        WHEN 'p' THEN 'TABLE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'f' THEN 'FOREIGN TABLE'
      END,
      r.nspname, r.relname, '${toRole}'
    );
  END LOOP;

  -- Functions and procedures.
  FOR r IN
    SELECT n.nspname, p.proname,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles role  ON role.oid = p.proowner
     WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND role.rolname = '${fromRole}'
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) OWNER TO %I',
      r.nspname, r.proname, r.args, '${toRole}'
    );
  END LOOP;

  -- Types: enums (e), domains (d), standalone composites (c). We
  -- exclude composite types autogenerated for tables (they have a
  -- matching pg_class row whose reltype points back at the type) —
  -- those follow ALTER TABLE OWNER above.
  FOR r IN
    SELECT n.nspname, t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_roles role  ON role.oid = t.typowner
     WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND role.rolname = '${fromRole}'
       AND t.typtype IN ('e','d','c')
       AND NOT EXISTS (
         SELECT 1 FROM pg_class c WHERE c.reltype = t.oid
       )
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', r.nspname, r.typname, '${toRole}');
  END LOOP;

  -- User-created schemas. 'public' is intentionally skipped — its
  -- ownership is a global postgres concern (default schema), and
  -- our app DBs only put objects in 'public' anyway.
  FOR r IN
    SELECT n.nspname
      FROM pg_namespace n
      JOIN pg_roles role ON role.oid = n.nspowner
     WHERE n.nspname NOT LIKE 'pg_%'
       AND n.nspname NOT IN ('information_schema','public')
       AND role.rolname = '${fromRole}'
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.nspname, '${toRole}');
  END LOOP;
END $$;`;

  await execInTarget(dbName, sql);
}

// One-shot per-app DB adoption used by the boot migration in
// src/db/migrate.js. For an existing DB owned by the superuser:
// create the dedicated role, transfer ownership, lock down PUBLIC,
// reassign in-DB objects. Idempotent: if the role already exists,
// rotates its password (callers must persist the returned value);
// if ownership is already correct, ALTER DATABASE is a no-op.
//
// Run only against DBs that the platform owns. Calling this for the
// platform's own database (`app_usernode_2d5619`) would orphan the
// platform from its tables — db/migrate.js skips self_hosted rows.
async function adoptExistingDatabase(dbName) {
  if (!SAFE_IDENT.test(dbName)) {
    throw new Error(`adoptExistingDatabase: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  const role = ownerRoleName(dbName);
  const password = generatePassword();

  log.info('db-manager', 'Adopting existing database under per-role model', { dbName, role });

  // 1. Ensure role exists with the new password.
  await execInDb(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
      CREATE ROLE ${role} LOGIN PASSWORD '${password}';
    ELSE
      ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}';
    END IF;
  END $$;`);

  // 2. Transfer DB ownership.
  await execInDb(`ALTER DATABASE ${dbName} OWNER TO ${role}`);

  // 3. Lock down PUBLIC + grant to owner.
  await execInDb(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`);
  await execInDb(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${role}`);

  // 4. Reassign every user-schema object currently owned by the
  // superuser to the new role. Without this the app's pool (now
  // connecting as the new role) couldn't ALTER its own tables,
  // INSERT into sequences it doesn't own, or DROP anything during
  // schema migrations. Scoped to user schemas in the target DB only
  // (see reassignUserObjectsTo), so this can't reach into other DBs
  // in the cluster and never touches system catalogs.
  await reassignUserObjectsTo(dbName, DB_USER, role);

  log.info('db-manager', 'Adoption complete', { dbName, role });
  return { password };
}

// Used by the boot migration's verify path: if apps.db_password is
// already populated but the role got dropped (manual postgres
// intervention, restored backup, etc.), recreate it with the stored
// password so the running container's URL keeps working.
async function ensureRoleExists(dbName, password) {
  if (!SAFE_IDENT.test(dbName)) {
    throw new Error(`ensureRoleExists: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  if (!password || typeof password !== 'string') {
    throw new Error('ensureRoleExists: password required');
  }
  const role = ownerRoleName(dbName);
  await execInDb(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
      CREATE ROLE ${role} LOGIN PASSWORD '${password}';
    ELSE
      ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}';
    END IF;
  END $$;`);
  await execInDb(`ALTER DATABASE ${dbName} OWNER TO ${role}`).catch(() => {});
  await execInDb(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`).catch(() => {});
  await execInDb(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${role}`).catch(() => {});
}

async function databaseExists(dbName) {
  if (!SAFE_IDENT.test(dbName)) return false;
  try {
    const stdout = await execInDb(
      `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
      { tuplesOnly: true }
    );
    return (stdout || '').trim() === '1';
  } catch {
    return false;
  }
}

async function roleExists(roleName) {
  if (!SAFE_IDENT.test(roleName)) return false;
  try {
    const stdout = await execInDb(
      `SELECT 1 FROM pg_roles WHERE rolname = '${roleName}'`,
      { tuplesOnly: true }
    );
    return (stdout || '').trim() === '1';
  } catch {
    return false;
  }
}

async function execInDb(sql, opts = {}) {
  return execInTarget('usernode', sql, opts);
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
  ownerRoleName,
  createDatabase,
  dropDatabase,
  cloneDatabase,
  connectionUrl,
  adoptExistingDatabase,
  ensureRoleExists,
  databaseExists,
  roleExists,
  truncatePrivateTables,
  scrubPrivateColumns,
};
