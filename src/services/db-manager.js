const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { Client } = require('pg');
const log = require('./logger');
const { withResourceUse } = require('./build-retention-guard');
const { STAGING_TEMPLATE_LOCK } = require('./advisory-locks');
const dbRetry = require('./db-retry');

const execFileAsync = promisify(execFile);

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

// pg_dump | pg_restore (cloneDatabase's copy step) can take a while for
// larger app DBs, so it gets a far more generous ceiling than
// execInTarget's fixed 30s. The copy is streamed through a pipe inside
// the container, so stdout stays tiny; this budget is purely for the
// copy itself. Override via DB_CLONE_TIMEOUT_MS if an app DB grows large
// enough to outrun the default.
const DUMP_RESTORE_TIMEOUT_MS = Number(process.env.DB_CLONE_TIMEOUT_MS) || 10 * 60 * 1000;

// Sentinel for NOT NULL columns scrubbed by `staging:private`. Chosen
// to be obviously non-functional in any auth or token-comparison path:
// bcrypt-style hashes start with `$2{a,b,y}$`, so bcrypt.compare
// against this string returns false for every input. Same shape works
// for any opaque-token column (wallet links, API keys); the auth path
// would need to special-case the literal to ever accept it, and we
// don't.
const STAGING_REDACTED_SENTINEL = '__staging_redacted__';
// ctid renders as (block,offset): uint32 + uint16, at most 18 characters.
// Leave room for the entire value rather than truncating its unique suffix.
const MAX_CTID_TEXT_LENGTH = 18;

function appDbName(slug) {
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}`;
}

function stagingDbName(slug, username, commitHash) {
  const shortHash = commitHash.substring(0, 6);
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_${username.replace(/[^a-z0-9_]/g, '_')}_${shortHash}`;
}

// Shots clones deliberately do not use stagingDbName(): they are owned by
// a short-lived shots run rather than by the proposal preview sweeper.
// Keep the database at 57 bytes so its `_owner` role also fits PostgreSQL's
// 63-byte identifier limit.
function shotsDbName(slug, runId, side, tag = 'shots') {
  if (!['base', 'head'].includes(side)) throw new Error('shotsDbName: side must be base or head');
  const cleanSlug = String(slug || '').toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'app';
  const token = crypto.createHash('sha256').update(String(runId || '')).digest('hex').slice(0, 12);
  const suffix = `_${tag}_${token}_${side === 'base' ? 'b' : 'h'}`;
  return `app_${cleanSlug.slice(0, 57 - 4 - suffix.length)}${suffix}`;
}

// The name a run's database had before the rename, for a run the previous
// release started.
function legacyShotsDbName(slug, runId, side) {
  return shotsDbName(slug, runId, side, 'evidence');
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
function connectionUrl(dbName, password, { server = PRIMARY_SERVER } = {}) {
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
  const admin = adminConnection(server);
  admin.username = role;
  admin.password = password;
  admin.pathname = `/${dbName}`;
  // node-postgres lets a URL's query string override its authority, so an
  // administrative `?user=…&password=…` left in place would make the app or
  // preview connect as the administrator whatever role the authority names.
  // The role and password above are the only credentials this URL carries.
  // Only when one is there: touching searchParams rewrites the whole query
  // (`%20` becomes `+`), and a URL without them must come back byte for
  // byte as it always did.
  for (const key of ['user', 'password']) if (admin.searchParams.has(key)) admin.searchParams.delete(key);
  // A preview-server URL says `sslmode=disable` outright, whichever of the
  // two accepted forms the admin URL took. Left out, each reader would fall
  // back to its own default: libpq tries TLS first, and node-postgres obeys
  // a PGSSLMODE in its process's environment, so the platform's own shots
  // fixtures (shots-fixtures.withClient) could demand a verified certificate
  // of a server the rest of the build reached plainly. Both clients read
  // `disable` the same way, and a value in the URL outranks the environment
  // in both. The main server's URLs are returned as they always were.
  if (serverKey(server) !== PRIMARY_SERVER) admin.search = '?sslmode=disable';
  return admin.toString();
}

// ─── Two servers: the main one, and one for preview databases ───────────
//
// Everything used to live on one Postgres server: the platform's database,
// every app's production database, and every database a preview needs (the
// redacted staging templates, each preview's clone, a shots run's two
// clones and the frozen source they are copied from). The preview side is
// most of that server's write load, and production's replicas and its WAL
// archive carry every byte of it for data that is thrown away within days.
//
// STAGING_DB_ADMIN_URL names a second server for the preview side. The name
// follows the two families it belongs to: DB_ADMIN_URL (an administrative
// connection, kept from app and preview containers alike) and the
// STAGING_DB_* settings for preview databases. Absent, there is one server
// and every function below behaves exactly as it did.
//
// With it set:
//   - templates, preview clones, shots clones, their frozen sources and
//     their roles are CREATED on the preview server (previewCreateServer);
//   - the redacted dump is still READ from the main server and restored
//     across (dumpRestore), and both redaction passes run on the preview
//     server exactly as they did here, as fatal as before;
//   - a database is FOUND by looking, not from a record. Its name is unique
//     and says which preview it belongs to, so a drop runs DROP … IF EXISTS
//     on every configured server and the sweeps list each one. A preview
//     made before the setting was turned on is still dropped, reaped and
//     counted on the main server, and nothing has to be migrated or kept
//     in step with a column that a wiped server would make wrong;
//   - a preview CONNECTS with the URL its container was given when it was
//     built, which is never rebuilt afterwards, so it keeps pointing at the
//     server its database was made on;
//   - app production databases, app forks, the platform database and the
//     advisory locks never leave the main server. Placement is decided by
//     the target's name: only the shapes this module builds for previews
//     (isPreviewSideDb) go across.
//
// STAGING_DB_SERVER_DRAIN=1 keeps the preview server known (so its
// databases are still dropped and reaped) while new ones are made on the
// main server again: the first step of switching back, before the setting
// is removed.
const PRIMARY_SERVER = 'primary';
const PREVIEW_SERVER = 'preview';
const PREVIEW_ADMIN_URL_ENV = 'STAGING_DB_ADMIN_URL';

// The connections this module opens outside the pools (a Client per clone
// pass, psql, pg_dump | pg_restore) to the MAIN server, at most
// DB_ADMIN_CONNECTIONS_MAX operations at a time per process (item 4: the
// connection budget, workflow-foundation design-item4-connections.md); the
// rest wait their turn. An operation that holds a turn opens its nested
// connections in it (a clone's psql, pg_restore beside pg_dump) without
// taking another, so nesting cannot wait on itself and an operation opens at
// most two at once: the budget counts twice the cap. The preview server's
// connections are its own server's budget and are not counted here.
const { AsyncLocalStorage } = require('node:async_hooks');
const MAIN_SERVER_OPERATIONS = Math.max(1, parseInt(process.env.DB_ADMIN_CONNECTIONS_MAX || '4', 10) || 4);
const inMainOperation = new AsyncLocalStorage();
const mainOperations = { running: 0, waiting: [], limit: MAIN_SERVER_OPERATIONS };
async function onMainServer(server, fn) {
  if ((server || PRIMARY_SERVER) !== PRIMARY_SERVER || inMainOperation.getStore()) return fn();
  if (mainOperations.running >= mainOperations.limit) {
    await new Promise((resolve) => { mainOperations.waiting.push(resolve); });
  } else {
    mainOperations.running += 1;
  }
  try {
    return await inMainOperation.run(true, fn);
  } finally {
    // A turn given back goes straight to the next in line (running stays),
    // while the limit allows (it is lower once the process drains).
    const next = mainOperations.running <= mainOperations.limit ? mainOperations.waiting.shift() : null;
    if (next) next(); else mainOperations.running -= 1;
  }
}

// A draining process finishes what it holds with at most
// DB_ADMIN_CONNECTIONS_DRAINING operations at a time (item 4).
function shrinkForDrain() {
  mainOperations.limit = Math.max(1, Math.min(mainOperations.limit,
    parseInt(process.env.DB_ADMIN_CONNECTIONS_DRAINING || '1', 10) || 1));
  return mainOperations.limit;
}

function parseAdminUrl(value, label) {
  let parsed;
  // Never echo the value: it carries the server's password.
  try { parsed = new URL(value); } catch { throw new Error(`${label} is not a valid URL`); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use postgres:// or postgresql://`);
  }
  return parsed;
}

function primaryAdminUrl() {
  const value = process.env.DB_ADMIN_URL || process.env.DATABASE_URL;
  if (!value) throw new Error('DB_ADMIN_URL or DATABASE_URL is required for database administration');
  return parseAdminUrl(value, 'DB_ADMIN_URL/DATABASE_URL');
}

// The preview server's URL is read by two clients: psql, pg_dump and
// pg_restore take the host, port, user and password this module lifts out of
// the URL's AUTHORITY (postgresEnv), while node-postgres parses the whole
// string and lets QUERY parameters override the authority (`?host=`,
// `?port=`, `?user=`, `?password=`, `?dbname=`, `?options=`). A URL carrying
// one of those is two different connections depending on who reads it: the
// version and identity checks would run against one server and the copy
// against another. So the address is in the authority or nowhere: the only
// query parameter accepted is `sslmode`, which both clients read alike, and
// anything else fails the URL as a whole. Only the parameter's name is ever
// reported.
//
// The same rule shapes the rest of the address. ONE host, a DNS name or an
// IPv4 address: libpq reads `a,b` as two hosts to try and node-postgres as
// one name that does not resolve. A user name this module can write into SQL
// unquoted (SAFE_IDENT): restored objects are owned by that user and are
// handed to each preview's role by name.
//
// And NO TLS, which is what the main server's connections are today (its
// URL carries no sslmode, the platform's pool and every app's pool are made
// from the bare URL, and nothing configures a certificate). Three clients
// use a preview database: this module through node-postgres, its psql,
// pg_dump and pg_restore children through libpq, and the preview's own
// pool through the URL it is handed. They do not mean the same thing by one
// `sslmode`: node-postgres reads `prefer`, `require` and `verify-ca` as
// full verification where libpq does not verify at all, and each finds its
// certificate authority somewhere else. With `sslmode=require` and a
// self-signed server certificate psql connected, node-postgres did not, and
// a preview was handed a URL it could not use. Until there is one way to
// give all three the same trust, the connection is plain for all three:
// the URL may say `sslmode=disable` or nothing, any other mode is refused
// by name, and every client is told so explicitly rather than left to its
// own default (PGSSLMODE=disable for the children, `ssl: false` for
// node-postgres, `sslmode=disable` in every URL handed out: connectionUrl).
const KNOWN_SSLMODES = new Set(['allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']);
const PREVIEW_URL_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function previewAdminUrl() {
  const value = String(process.env[PREVIEW_ADMIN_URL_ENV] || '').trim();
  if (!value) throw new Error(`${PREVIEW_ADMIN_URL_ENV} is not set`);
  const parsed = parseAdminUrl(value, PREVIEW_ADMIN_URL_ENV);
  if (!PREVIEW_URL_HOST.test(parsed.hostname)) {
    throw new Error(`${PREVIEW_ADMIN_URL_ENV} must name one host in its address, as a DNS name or an IPv4 address`);
  }
  let user = '';
  try { user = decodeURIComponent(parsed.username); } catch { user = ''; }
  if (!SAFE_IDENT.test(user)) {
    throw new Error(`${PREVIEW_ADMIN_URL_ENV} must carry a user of letters, digits and underscores in its address`);
  }
  if (parsed.port && !/^[0-9]{1,5}$/.test(parsed.port)) throw new Error(`${PREVIEW_ADMIN_URL_ENV} has an unusable port`);
  for (const [key, setting] of parsed.searchParams) {
    if (key !== 'sslmode') {
      throw new Error(`${PREVIEW_ADMIN_URL_ENV} has an unsupported parameter ${JSON.stringify(key.slice(0, 40))}: `
        + 'the host, port, user, password and database go in the address, and only sslmode may follow it');
    }
    if (setting !== 'disable') {
      // Name the mode when it is one of the known words; never echo a value.
      const mode = KNOWN_SSLMODES.has(setting) ? `sslmode=${setting}` : 'this sslmode';
      throw new Error(`${PREVIEW_ADMIN_URL_ENV}: ${mode} is not supported. The preview database server is reached `
        + 'without TLS, as the main server is: leave sslmode out or set sslmode=disable');
    }
  }
  if (parsed.searchParams.getAll('sslmode').length > 1) throw new Error(`${PREVIEW_ADMIN_URL_ENV} sets sslmode more than once`);
  parsed.hash = '';
  return parsed;
}

const sameServerAddress = (a, b) => a.hostname.toLowerCase() === b.hostname.toLowerCase()
  && (a.port || '5432') === (b.port || '5432');

// Is there a second server for preview databases? A URL that names the main
// server's own address is not one: treating it as a second server would run
// the file-copy strategy (two checkpoints per copy) on production, which is
// the one thing this split must never do. Said once, then ignored.
let _sameServerWarned = false;
function previewServerConfigured() {
  if (!String(process.env[PREVIEW_ADMIN_URL_ENV] || '').trim()) return false;
  let preview;
  try { preview = previewAdminUrl(); } catch { return true; }   // surfaces at first use
  let primary;
  try { primary = primaryAdminUrl(); } catch { return true; }
  if (!sameServerAddress(preview, primary)) return true;
  if (!_sameServerWarned) {
    _sameServerWarned = true;
    log.warn('db-manager', `${PREVIEW_ADMIN_URL_ENV} names the main database server, so it is ignored`, {
      host: primary.hostname, port: primary.port || '5432',
    });
  }
  return false;
}

function previewServerDraining() {
  return /^(1|true|on|yes)$/i.test(String(process.env.STAGING_DB_SERVER_DRAIN || '').trim());
}

// Where a NEW preview-side database is made.
function previewCreateServer() {
  return previewServerConfigured() && !previewServerDraining() ? PREVIEW_SERVER : PRIMARY_SERVER;
}

// Every server a preview-side database may be on, the preview server first.
function previewSideServers() {
  return previewServerConfigured() ? [PREVIEW_SERVER, PRIMARY_SERVER] : [PRIMARY_SERVER];
}

// Where to look for `dbName`: an app's own database is only ever on the main
// server; a preview-side one may be on either.
function serversHolding(dbName) {
  return isPreviewSideDb(dbName) ? previewSideServers() : [PRIMARY_SERVER];
}

function serverKey(server) {
  if (server == null || server === PRIMARY_SERVER) return PRIMARY_SERVER;
  if (server === PREVIEW_SERVER) return PREVIEW_SERVER;
  throw new Error(`Unknown database server ${JSON.stringify(server)}`);
}

function adminConnection(server = PRIMARY_SERVER) {
  return serverKey(server) === PREVIEW_SERVER ? previewAdminUrl() : primaryAdminUrl();
}

// The database administrative statements connect to. On the main server it
// is `usernode`, as it always was. The preview server is somebody else's to
// provision, so it is whichever database its URL names (`postgres` if none).
function adminDatabase(server = PRIMARY_SERVER) {
  if (serverKey(server) === PRIMARY_SERVER) return 'usernode';
  const name = decodeURIComponent(previewAdminUrl().pathname.replace(/^\//, '')) || 'postgres';
  if (!SAFE_IDENT.test(name)) throw new Error(`${PREVIEW_ADMIN_URL_ENV} names an unusable maintenance database`);
  return name;
}

function adminUser(server = PRIMARY_SERVER) {
  return decodeURIComponent(adminConnection(server).username || DB_USER);
}

// Statement runners bound to one server, in the two shapes this module's
// helpers take: (sql, opts) against the maintenance database, and
// (dbName, sql, opts) against a named one. The main server gets the plain
// functions, so nothing about a one-server install changes.
function adminExecutor(server = PRIMARY_SERVER) {
  if (serverKey(server) === PRIMARY_SERVER) return execInDb;
  return (sql, opts = {}) => execInDb(sql, { ...opts, server });
}

function targetExecutor(server = PRIMARY_SERVER) {
  if (serverKey(server) === PRIMARY_SERVER) return execInTarget;
  return (dbName, sql, opts = {}) => execInTarget(dbName, sql, { ...opts, server });
}

// `as` ({ user, password }) runs the child as a different role than the
// administrator — the copy's own unprivileged owner role for the redaction
// passes — keeping the server's address, TLS and the rest of the environment.
function postgresEnv(dbName, server = PRIMARY_SERVER, as = null) {
  const admin = adminConnection(server);
  // For the preview server the URL is the whole connection. libpq also reads
  // its own environment, and some of it outranks what is set below: a
  // PGSERVICE entry replaces the host and port, PGHOSTADDR replaces the
  // address the host name resolves to. Left in place, psql, pg_dump and
  // pg_restore could reach another server than the one node-postgres reaches
  // with the same URL. So a preview-side child process gets no PG* variable
  // from the platform's environment, only the ones written here. The main
  // server's processes inherit the environment exactly as they always did.
  const inherited = serverKey(server) === PRIMARY_SERVER
    ? process.env
    : Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key)));
  return {
    ...inherited,
    PGHOST: admin.hostname,
    PGPORT: admin.port || '5432',
    PGUSER: as && as.user ? as.user : decodeURIComponent(admin.username || DB_USER),
    PGPASSWORD: as && as.password != null ? as.password : decodeURIComponent(admin.password || ''),
    PGDATABASE: dbName,
    // The preview server: plain, said outright (libpq's own default would
    // try TLS first and the other two clients would not).
    ...(serverKey(server) !== PRIMARY_SERVER ? { PGSSLMODE: 'disable' }
      : admin.searchParams.get('sslmode') ? { PGSSLMODE: admin.searchParams.get('sslmode') } : {}),
  };
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
  await applyAppConnectionLimit(dbName, { execute: execInDb });

  // Reassign any objects in the DB currently owned by the superuser
  // to the new role — a no-op for fresh CREATEs (no objects yet) but
  // important for the adoption branch above. We can't use
  // `REASSIGN OWNED BY ${DB_USER}` here because the superuser also
  // owns pg_toast tables pinned to pg_catalog, and postgres refuses
  // the whole REASSIGN when any system-required objects are involved
  // — see reassignUserObjectsTo for the full rationale.
  await reassignUserObjectsTo(dbName, adminUser(), role).catch((err) => {
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
// Recreating a clone requires confirmed cleanup. Ordinary teardown remains
// best-effort, but clone callers must not create a new role after a failed drop.
// A disposable shots or staging-template database is dropped WITH (FORCE)
// and retried briefly (dropDisposableDatabase); `retry` tunes that.
//
// Where: an app's own database is on the main server. A preview-side one
// (isPreviewSideDb) is dropped on EVERY configured server, the preview
// server first, because nothing records which one it was made on and
// DROP … IF EXISTS is harmless where it is absent. A build asks first instead
// (dropOldTarget), because there the time counts. `server` narrows that
// to one server (the orphan sweep, which decided per server); `execute` is a
// caller's own session and is used as it is.
async function dropDatabase(dbName, { strict = false, execute = null, retry = {}, server = null } = {}) {
  log.info('db-manager', 'Dropping database', { dbName });

  if (!SAFE_IDENT.test(dbName)) {
    log.warn('db-manager', 'Refusing to drop database with unsafe name', { dbName });
    if (strict) throw new Error('dropDatabase: unsafe database name');
    return;
  }

  // `server` with `execute` only names, in the log, the server that session is on.
  if (execute) return dropDatabaseWith(dbName, { strict, execute, retry, server: server ? serverKey(server) : PRIMARY_SERVER });
  const servers = server ? [serverKey(server)] : serversHolding(dbName);
  let firstError = null;
  for (const key of servers) {
    try {
      // A bad STAGING_DB_ADMIN_URL throws while the runner is being made;
      // that is a failed drop on that server, not a reason to skip the next.
      await dropDatabaseWith(dbName, { strict, execute: adminExecutor(key), retry, server: key });
    } catch (err) {
      if (!strict) {
        log.warn('db-manager', 'Failed to drop database', { dbName, server: key, err: err.message });
        continue;
      }
      firstError = firstError || err;
    }
  }
  if (firstError) throw firstError;
}

async function dropDatabaseWith(dbName, { strict, execute, retry, server = PRIMARY_SERVER }) {
  try {
    if (isDisposableDb(dbName)) {
      await dropDisposableDatabase(dbName, { execute, retry });
    } else {
      // Terminate any open connections so DROP DATABASE doesn't error.
      await execute(terminateSessionsSql(dbName)).catch(() => {});
      await execute(`DROP DATABASE IF EXISTS ${dbName}`);
    }
  } catch (err) {
    log.warn('db-manager', 'Failed to drop database', { dbName, server, err: err.message });
    // Don't try to drop the role if the DB drop failed — the role
    // still owns it.
    if (strict) throw err;
    return;
  }

  const role = ownerRoleName(dbName);
  if (!SAFE_IDENT.test(role)) return;

  await execute(`DROP OWNED BY ${role} CASCADE`).catch(() => {});
  await execute(`DROP ROLE IF EXISTS ${role}`).catch((err) => {
    log.warn('db-manager', 'Failed to drop role (may still own objects in another DB)', {
      role, server, err: err.message,
    });
    if (strict) throw err;
  });

  log.info('db-manager', 'Database and role dropped', { dbName, role, server });
}

// ─── Per-preview connection ceiling (#1771) ─────────────────────────────
//
// One Postgres server backed the platform, every production app and every
// staging preview, with the stock 100 connections (previews have since moved
// to a server of their own). Nothing in the
// fleet was bounded against that number: each preview container brings its
// own pg Pool, and a generated app's pool is whatever that app's code says
// it is — code this platform does not own and cannot cap from here. Twenty
// previews times a double-digit pool is arithmetic that does not fit, and
// when it stopped fitting the casualty was not the preview that overran. It
// was whichever proposal's checks ran next, which recorded the resulting
// 500s as assertion failures against its own diff.
//
// `ALTER DATABASE … CONNECTION LIMIT` is the one bound that does not need
// the app's cooperation: the server enforces it per clone, whatever the
// container inside is running. Set generously on purpose. This is a
// BACKSTOP, not a working budget: it has to sit above what a healthy
// preview uses under a full check run (capture drives 8 concurrent pages,
// so 8 concurrent requests, plus the app's own boot/migration connections),
// because a ceiling that bites during normal work would turn this issue's
// symptom into a permanent feature. What it buys is that a preview which
// leaks connections now hits its OWN ceiling and fails locally, with
// Postgres naming the database in the error, instead of draining the shared
// budget and breaking the next proposal's checks.
//
// STAGING_DB_CONNECTION_LIMIT=0 (or negative) disables the ceiling, which is
// also what -1 means to Postgres itself.
const DEFAULT_STAGING_DB_CONNECTION_LIMIT = 12;

function stagingConnectionLimit() {
  const raw = parseInt(process.env.STAGING_DB_CONNECTION_LIMIT || '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_STAGING_DB_CONNECTION_LIMIT;
  return raw > 0 ? raw : -1;   // -1 → unlimited, Postgres's own spelling
}

// app_<slug>_staging_s<sessionId>_<tag> — the shape stagingDbName() builds.
// The ceiling is for previews only: cloneDatabase also serves app forks,
// whose target is a real production database and must stay uncapped.
const STAGING_CLONE_DB_RE = /^app_[a-z0-9_]+_staging_s\d+_([0-9a-f]{6}|latest)$/;
const SHOTS_CLONE_DB_RE = /^app_[a-z0-9_]+_(?:shots|evidence)_[0-9a-f]{12}_[bh]$/;

function isStagingCloneDb(name) {
  return STAGING_CLONE_DB_RE.test(String(name || ''));
}

function isShotsCloneDb(name) {
  return SHOTS_CLONE_DB_RE.test(String(name || ''));
}

// ─── Disposable shots and staging-template databases ────────────────────
//
// The shots and staging-template code makes databases that nothing else
// ever uses: a shots run's two clones, the frozen source they are copied
// from (`_evsrc_<12 hex>`), and the shared staging template with the `_next`
// build that replaces it. A session found on one of them is a leftover: a
// backend still exiting after a terminate, a pool that reconnected between
// the terminate and the DROP, a build an earlier process abandoned. Postgres
// then refuses to copy or drop the database ("is being accessed by other
// users", 55006), and twice that ended a shots run. These databases, and
// only these, may have their sessions cut off and be dropped WITH (FORCE).
// The shapes are the names this module builds; any other name, an app's own
// database or a preview's clone among them, is refused.
const DISPOSABLE_DB_RES = Object.freeze([
  SHOTS_CLONE_DB_RE,
  /^app_[a-z0-9_]+_evsrc_[0-9a-f]{12}$/,
  /^app_[a-z0-9_]+_stgtmpl(?:_next)?$/,
]);

function isDisposableDb(name) {
  const value = String(name || '');
  return value.length <= 63 && DISPOSABLE_DB_RES.some((re) => re.test(value));
}

function assertDisposableDb(name, caller) {
  if (!isDisposableDb(name)) {
    throw new Error(`${caller}: refusing ${JSON.stringify(name)}, which is not a disposable shots or staging-template database`);
  }
}

// The names this module builds for the preview side: a preview's clone, and
// every disposable database above (a shots run's clones, their frozen
// source, a staging template and its `_next` build). Only these may be made
// on, looked for on, or dropped from the preview server.
function isPreviewSideDb(name) {
  return isStagingCloneDb(name) || isDisposableDb(name);
}

function terminateSessionsSql(dbName) {
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`;
}

async function terminateDisposableSessions(dbName, { execute = null, server = PRIMARY_SERVER } = {}) {
  assertDisposableDb(dbName, 'terminateDisposableSessions');
  await (execute || adminExecutor(server))(terminateSessionsSql(dbName));
}

function isSyntaxError(err) {
  return err?.code === '42601' || /\bERROR:\s+syntax error at or near/.test(String(err?.message || ''));
}

// A copy whose template is gone (SQLSTATE 3D000): the shared staging template
// can be dropped and renamed away by a refresh running in another process
// between the freshness read and this copy. Every other failure — refused,
// in use, timed out — is a real problem and still surfaces as it does.
function isMissingTemplateError(err) {
  if (!err) return false;
  if (err.code === '3D000') return true;
  return /template database ".*" does not exist/.test(String(err.message || ''));
}

// FORCE (PostgreSQL 13 and later; the platform runs 17) cuts sessions off and
// keeps new ones out while it drops, which closes the gap a reconnect slipped
// through. An older server rejects the option and gets the plain statement.
// Retried while a backend takes longer to exit than the drop waits for it.
async function dropDisposableDatabase(dbName, { execute: given = null, retry = {}, server = PRIMARY_SERVER } = {}) {
  assertDisposableDb(dbName, 'dropDisposableDatabase');
  const execute = given || adminExecutor(server);
  await dbRetry.withDbRetry(async () => {
    await execute(terminateSessionsSql(dbName)).catch(() => {});
    try {
      await execute(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } catch (err) {
      if (!isSyntaxError(err)) throw err;
      await execute(`DROP DATABASE IF EXISTS ${dbName}`);
    }
  }, { retryable: dbRetry.isDbConflict, label: 'Disposable database drop', ...retry });
}

// ─── Shared-block copies on the preview server ──────────────────────────
//
// CREATE DATABASE … TEMPLATE copies with the WAL_LOG strategy by default:
// every block of the template is written to the WAL, then replayed by each
// replica and archived. PostgreSQL 18 added `file_copy_method = clone`,
// which with STRATEGY = FILE_COPY asks the filesystem to share the
// template's blocks with the copy (a reflink on XFS or Btrfs), so a copy
// writes almost nothing however large the template is.
//
// It is used on the preview server only. FILE_COPY forces a checkpoint
// before and after each copy, which is cheap on a server that holds nothing
// worth protecting and the wrong trade on production; the main server keeps
// the plain statement whatever version it runs.
//
// A server that does not take it (an older version, a build without clone
// support, a filesystem that will not clone across devices) gets the plain
// statement, and the reason is logged once per process. On Linux Postgres
// clones with copy_file_range(), which the kernel turns into an ordinary
// copy on a filesystem without reflink instead of failing: the copy then
// still succeeds and still skips the WAL, but shares nothing. Nothing in SQL
// reports which happened, so "the volume supports reflink" is a property the
// cluster side has to provide (docs/kubernetes-operations.md).
// STAGING_DB_FILE_CLONE=0 turns the attempt off.
const FILE_CLONE_MIN_VERSION = 180000;
const FILE_CLONE_SETUP = 'SET file_copy_method = clone';
const SERVER_VERSION_TTL_MS = 10 * 60 * 1000;
const _fileCloneNotes = new Set();

function fileCloneEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.STAGING_DB_FILE_CLONE || '').trim());
}

// Two addresses, one server? previewServerConfigured() can only compare the
// two URLs' host and port, and one server answers to several names (a
// Service and its Pod, a read-write alias). Postgres gives every cluster an
// identifier when it is initialised, so ask both. Used where being wrong
// costs something: a shared-block copy would run FILE_COPY's checkpoints on
// production, and retiring "the other server's" template would drop the one
// just built. True also when either cannot be read, for those same reasons.
const _instanceCheck = { at: 0, same: true };
async function previewServerIsMainServer() {
  if ((Date.now() - _instanceCheck.at) < SERVER_VERSION_TTL_MS) return _instanceCheck.same;
  const identify = async (server) => String(await execInDb(
    'SELECT system_identifier FROM pg_control_system()', { tuplesOnly: true, server }
  )).trim();
  try {
    const [main, preview] = [await identify(PRIMARY_SERVER), await identify(PREVIEW_SERVER)];
    if (!main || !preview) return true;
    _instanceCheck.same = main === preview;
    _instanceCheck.at = Date.now();
    if (_instanceCheck.same) {
      noteOnce('same-instance', `${PREVIEW_ADMIN_URL_ENV} reaches the main database server under another address: templates are copied the plain way and stay where they are`, {});
    }
    return _instanceCheck.same;
  } catch (err) {
    log.warn('db-manager', 'Could not compare the two database servers', { err: err.message });
    return true;
  }
}

function noteOnce(key, message, meta) {
  if (_fileCloneNotes.has(key)) return;
  _fileCloneNotes.add(key);
  log.warn('db-manager', message, meta);
}

// The main server's own identifier, read once every ten minutes.
const _mainIdentifier = { at: 0, value: '' };
async function mainServerIdentifier() {
  if (_mainIdentifier.value && (Date.now() - _mainIdentifier.at) < SERVER_VERSION_TTL_MS) return _mainIdentifier.value;
  const value = String(await execInDb(
    'SELECT system_identifier FROM pg_control_system()', { tuplesOnly: true }
  )).trim();
  if (value) { _mainIdentifier.value = value; _mainIdentifier.at = Date.now(); }
  return value;
}

// May this copy ask for shared blocks? Decided on `execute`, which must be
// a single connection (withDatabaseConnection): the version, the identity,
// the SET and the copy are four statements of one session on one server,
// so the server that says who it is IS the server the copy runs on. Never a
// cached answer about the setting, and never a second connection that could
// have been routed elsewhere. It must be the preview server, PostgreSQL 18 or later, and NOT
// the main server (compared by the identifier each cluster is given when it
// is initialised). Anything unreadable is a no.
function fileCloneWanted(server) {
  return serverKey(server) === PREVIEW_SERVER && fileCloneEnabled() && !_fileCloneNotes.has('refused');
}

async function fileCloneUsable(server, execute) {
  if (!fileCloneWanted(server)) return false;
  // One connection or none: a runner that opens a connection per statement
  // (psql) could ask one server who it is and send the copy to another.
  if (!isSingleConnection(execute)) return false;
  let version = 0;
  let here = '';
  let main = '';
  try {
    version = parseInt(String(await execute('SHOW server_version_num', { tuplesOnly: true })).trim(), 10) || 0;
    here = String(await execute('SELECT system_identifier FROM pg_control_system()', { tuplesOnly: true })).trim();
    main = await mainServerIdentifier();
  } catch (err) {
    log.warn('db-manager', 'Could not identify the server a template copy runs on: copying the plain way', {
      err: err.message,
    });
    return false;
  }
  if (!here || !main) return false;
  if (here === main) {
    noteOnce('same-instance', `${PREVIEW_ADMIN_URL_ENV} reaches the main database server under another address: templates are copied the plain way and stay where they are`, {});
    return false;
  }
  if (version >= FILE_CLONE_MIN_VERSION) return true;
  if (version > 0) {
    noteOnce('old-server', 'Preview database server is older than PostgreSQL 18: templates are copied the plain way', {
      serverVersionNum: version,
    });
  }
  return false;
}

// The server would not make a shared-block copy: the setting is unknown or
// has no `clone` value there, or the filesystem refused the clone. Anything
// else (the template is in use, the statement ran out of time, the template
// is gone) is the copy's own failure and is handled as it always was.
// A clone that failed for want of room or on an I/O error is not a refusal:
// the plain copy would fail the same way, and it must not switch shared-block
// copies off for the life of the process.
function isFileCloneRefusal(err) {
  const message = String(err?.message || '');
  if (/file_copy_method/i.test(message)) return true;
  return /could not clone file\b.*:\s*(Operation not supported|Invalid cross-device link|Function not implemented|Invalid argument)/i
    .test(message);
}

function noteFileCloneRefused(server, err) {
  noteOnce('refused', 'Preview database server refused a shared-block copy: templates are copied the plain way until this process restarts', {
    server: serverKey(server), err: String(err?.message || '').slice(0, 300),
  });
}

// CREATE DATABASE … TEMPLATE. With `attempts` above one (the shots path), a
// copy refused because a session was on the template (55006) or that lost a
// deadlock is run again: either way Postgres made nothing. Before the next
// attempt the template's sessions are cut off (nothing connects to a
// template on purpose: it is ALLOW_CONNECTIONS false), and a disposable
// target is dropped in case the failed attempt left anything behind.
//
// On the preview server, when it runs PostgreSQL 18 or later, the copy asks
// for shared blocks first (fileCloneUsable below). `server` says which server
// `execute` talks to; the main server always gets the plain statement.
async function createFromTemplate(templateDb, targetDb, ownerRole, {
  execute: given = null, timeoutMs = null, attempts = 1, wait, server = PRIMARY_SERVER,
} = {}) {
  if (![templateDb, targetDb, ownerRole].every((name) => SAFE_IDENT.test(String(name || '')))) {
    throw new Error(`createFromTemplate: unsafe identifiers ${templateDb}/${targetDb}/${ownerRole}`);
  }
  // No runner given, on the preview server: hold one connection for the
  // whole copy, retries included, so a shared-block copy can be asked for
  // (the frozen shots source comes this way). Everywhere else the default is
  // a psql process per statement, as it always was, and the copy is plain.
  if (!given && fileCloneWanted(server)) {
    const maintenanceDb = adminDatabase(server);
    return withDatabaseConnection(maintenanceDb, (run) => createFromTemplate(templateDb, targetDb, ownerRole, {
      execute: singleConnection((sql, opts) => run(maintenanceDb, sql, opts)), attempts, wait, server,
    }), { queryTimeoutMs: timeoutMs || 30_000, server });
  }
  const execute = given || adminExecutor(server);
  const plain = `CREATE DATABASE ${targetDb} TEMPLATE ${templateDb} OWNER ${ownerRole}`;
  const limits = timeoutMs ? { timeoutMs } : {};
  let fileClone = await fileCloneUsable(server, execute);
  await dbRetry.withDbRetry(async (attempt) => {
    if (attempt > 1 && isDisposableDb(targetDb)) {
      await dropDisposableDatabase(targetDb, { execute, retry: { attempts: 1 } });
    }
    if (fileClone) {
      try {
        await execute(`${plain} STRATEGY = FILE_COPY`, { ...limits, sessionSetup: [FILE_CLONE_SETUP] });
        return;
      } catch (err) {
        if (!isFileCloneRefusal(err)) throw err;
        noteFileCloneRefused(server, err);
        fileClone = false;
        // Postgres removes what a failed CREATE DATABASE made. This is for
        // the case where it could not.
        await execute(`DROP DATABASE IF EXISTS ${targetDb}`).catch(() => {});
      }
    }
    await execute(plain, limits);
  }, {
    attempts,
    retryable: dbRetry.isDbConflict,
    beforeRetry: async (error) => {
      if (!dbRetry.isObjectInUse(error)) return;
      await terminateDisposableSessions(templateDb, { execute }).catch((err) => {
        log.warn('db-manager', 'Could not cut sessions off a template before copying it again', {
          templateDb, err: err.message,
        });
      });
    },
    label: 'Template copy',
    ...(wait ? { wait } : {}),
  });
}

// ─── Each production app's own connection cap (item 4) ──────────────────
//
// The child apps share the main server with the platform, and an app's pool
// is whatever its code says. Each app's database is capped
// (APP_DB_CONNECTION_LIMIT, 20: the starter's pool of 10, twice, for the
// moment the app's own rollout runs its old and new container side by side),
// so a runaway app meets its own cap, with Postgres naming the database, and
// the apps' share of the server (what the platform's reserve leaves:
// services/server-budget.js) holds. The platform's own database is never
// capped. 0 or less turns the cap off.
const DEFAULT_APP_DB_CONNECTION_LIMIT = 20;

function appConnectionLimit() {
  const raw = parseInt(process.env.APP_DB_CONNECTION_LIMIT || '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_APP_DB_CONNECTION_LIMIT;
  return raw > 0 ? raw : -1;
}

function platformDatabaseName(databaseUrl = process.env.DATABASE_URL) {
  try { return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) || null; } catch { return null; }
}

// Best-effort, as the staging ceiling is: an app made without its cap is the
// state every app was in before; a creation that fails over it is not.
async function applyAppConnectionLimit(dbName, { execute: given = null } = {}) {
  const limit = appConnectionLimit();
  if (limit < 0 || !SAFE_IDENT.test(dbName) || dbName === platformDatabaseName()) return null;
  try {
    await (given || adminExecutor(PRIMARY_SERVER))(`ALTER DATABASE ${dbName} CONNECTION LIMIT ${limit}`);
    return limit;
  } catch (err) {
    log.warn('db-manager', 'Could not cap the app database\'s connections', { dbName, limit, err: err.message });
    return null;
  }
}

/**
 * Apply the ceiling to one staging clone. Best-effort by design: a preview
 * that exists but is uncapped is the status quo, whereas a build that fails
 * because the cap could not be set is a regression. Returns the limit
 * applied, or null when nothing was done.
 */
async function applyStagingConnectionLimit(dbName, { execute: given = null, server = PRIMARY_SERVER } = {}) {
  const execute = given || adminExecutor(server);
  if (!SAFE_IDENT.test(dbName)) return null;
  if (!isStagingCloneDb(dbName) && !isShotsCloneDb(dbName)) return null;
  const limit = stagingConnectionLimit();
  if (limit < 0) return null;
  try {
    await execute(`ALTER DATABASE ${dbName} CONNECTION LIMIT ${limit}`);
    log.info('db-manager', 'Staging clone connection ceiling applied', { dbName, limit });
    return limit;
  } catch (err) {
    log.warn('db-manager', 'Could not set staging clone connection ceiling', {
      dbName, limit, err: err.message,
    });
    return null;
  }
}

// `viaTemplate` (staging previews only): clone from the source's staging
// template — a redacted copy kept warm on the server and refreshed at most
// every STAGING_DB_TEMPLATE_MAX_AGE_MS — with a file-level CREATE DATABASE
// … TEMPLATE, instead of dumping and restoring the live source on every
// build. Falls back to the direct path on any template failure, so a
// preview build can only ever be as slow as before, never blocked.
async function cloneDatabase(sourceDb, targetDb, { viaTemplate = false } = {}) {
  if (!SAFE_IDENT.test(sourceDb) || !SAFE_IDENT.test(targetDb)) {
    throw new Error(`cloneDatabase: unsafe identifiers ${sourceDb}/${targetDb}`);
  }
  // A preview's clone is made on the preview server when there is one; any
  // other target (an app fork's production database) stays on the main
  // server. The source is always read from the main server.
  const server = isPreviewSideDb(targetDb) ? previewCreateServer() : PRIMARY_SERVER;
  try {
    return await cloneDatabaseOn(server, sourceDb, targetDb, { viaTemplate });
  } catch (err) {
    // Nothing falls back to the main server: a preview server that is down
    // would otherwise move every preview's full copy onto production, which
    // is the load this split exists to take off it. The build fails as a
    // platform fault instead (deploy-failure.bootFailureIsInfrastructure,
    // and staging-recovery.recordStagingBootFailure, which stores it as one
    // so the checks' platform-fault retries apply). That covers every
    // failure of a clone placed on the preview server, and any failure that
    // came from that server while the clone was placed on the main one.
    // Except a copy refused for what the app's own data says (a private
    // table with a foreign child, or refilled by its own code; row-level
    // security on a private column; an extension the copy cannot make): no
    // retry fixes those, and the author is the one to tell.
    if (appCaused(err)) {
      err.appCaused = true;
    } else if (err && typeof err === 'object' && (server === PREVIEW_SERVER || err.previewDatabaseServer)) {
      err.infrastructure = true;
      err.previewDatabaseServerFault = true;
    }
    throw err;
  }
}

// A copy refused for what the app's own data or schema says, never for the
// server: the redaction's fail-closed refusals (noFallback) and the ones
// marked appCaused where they are thrown.
const appCaused = (err) => !!(err && typeof err === 'object' && (err.noFallback || err.appCaused));

async function cloneDatabaseOn(server, sourceDb, targetDb, { viaTemplate }) {
  await assertPreviewServerReachable(server);
  if (viaTemplate && stagingTemplatesEnabled()) {
    const viaTmpl = await withTemplateLock(sourceDb, async () => {
      const ensured = await ensureStagingTemplate(sourceDb, { server }).catch((err) => {
        log.warn('db-manager', 'Staging template unavailable — cloning directly', {
          sourceDb, err: err.message,
        });
        return null;
      });
      if (!ensured) return null;
      try {
        const result = await cloneFromTemplate(ensured.template, targetDb, { server });
        return { ...result, via: 'template', templateRefreshed: ensured.refreshed, templateStale: ensured.stale };
      } catch (err) {
        // The direct copy is another way to make the clone, not another way
        // to reach the server: if the preview server stopped taking this
        // module's connections, dumping production to it helps nobody.
        if (err?.previewServerConnectFailed) throw err;
        log.warn('db-manager', 'Clone from staging template failed — cloning directly', {
          sourceDb, targetDb, template: ensured.template, err: err.message,
        });
        await dropDatabase(targetDb).catch(() => {});
        return null;
      }
    });
    if (viaTmpl) {
      // A template past its soft age served this build as it was; bring it
      // up to date now, off the build's critical path, so the next build
      // finds it warm. Serialised behind any clone in flight.
      if (viaTmpl.templateStale) queueTemplateRefresh(sourceDb, { server });
      await applyStagingConnectionLimit(targetDb, { server });
      return { ...viaTmpl, server };
    }
  }
  const direct = await cloneDatabaseDirect(sourceDb, targetDb, { server });
  // Both clone paths converge here so the ceiling is set once, after the
  // copy rather than before it: pg_restore opens its own connections, and a
  // ceiling that applied mid-restore would cap the restore itself (#1771).
  await applyStagingConnectionLimit(targetDb, { server });
  return { ...direct, via: 'direct', templateRefreshed: false, server };
}

// Before a database is made: an old one of the same name is dropped, and the
// drop must be confirmed, ON THE SERVER IT IS ABOUT TO BE MADE ON. A database
// of that name on the other server is a leftover from before previews moved;
// dropping it is tidying, and its failure (that server being down, most
// likely while it is being drained) must not stop a build that does not use
// it. It stays for the orphan sweep.
//
// The other server is asked first, in one statement, whether it holds
// anything of this name; the four-statement drop runs only when it does. The
// drop used to run every time, on the build's critical path, and nearly
// every build finds nothing there. An answer other than a plain "no" drops
// as before. The question goes through the same runner as the drop (one psql
// process), so it reaches the same server with the same identity, TLS
// settings and connect deadline that the drop does.
async function dropOldTarget(targetDb, server, { ownServer = true } = {}) {
  for (const other of serversHolding(targetDb)) {
    if (other === serverKey(server)) continue;
    try {
      if (await holdsNothingOfName(targetDb, adminExecutor(other))) {
        log.debug('db-manager', 'No old database or role of this name on the other server', { dbName: targetDb, server: other });
        continue;
      }
      await dropDatabase(targetDb, { strict: true, server: other });
    } catch (err) {
      log.warn('db-manager', 'Could not drop an old database of this name on the other server; leaving it for the sweep', {
        dbName: targetDb, server: other, err: err.message,
      });
    }
  }
  if (ownServer) await dropDatabase(targetDb, { strict: true, server: serverKey(server) });
}

// True only when the server `execute` runs on positively answers that it has
// neither a database named `dbName` nor that database's owner role (a role
// can outlive its database when a drop stopped half way). Throws when the
// server cannot be asked. pg_database and pg_roles are shared catalogs, so
// the maintenance database sees every database and role on the server.
async function holdsNothingOfName(dbName, execute) {
  const role = ownerRoleName(dbName);
  if (!SAFE_IDENT.test(dbName) || !SAFE_IDENT.test(role)) return false;
  const out = await execute(
    `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${dbName}') OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}')`,
    { tuplesOnly: true },
  );
  return String(out).trim() === 'f';
}

async function cloneDatabaseDirect(sourceDb, targetDb, { server = PRIMARY_SERVER } = {}) {
  log.info('db-manager', 'Cloning database', { sourceDb, targetDb });
  // The clone's own server: the role, the database, the restore, both
  // ownership passes and both redaction passes. Only the dump's source and
  // the discovery of what to leave out of it read the main server.
  const inAdmin = adminExecutor(server);
  const inTarget = targetExecutor(server);

  // Drop any prior clone (and its role) before cloning fresh. The
  // dropDatabase below also takes care of the role.
  await dropOldTarget(targetDb, server);

  // Create the per-clone role first so we can hand it the fresh clone
  // as OWNER. No need to terminate the source's connections any more —
  // the dump/restore below copies the source while it stays actively in
  // use (see the note on the copy step).
  const targetRole = ownerRoleName(targetDb);
  if (!SAFE_IDENT.test(targetRole)) {
    throw new Error(`cloneDatabase: unsafe target role ${targetRole}`);
  }
  const password = generatePassword();
  await inAdmin(`CREATE ROLE ${targetRole} LOGIN PASSWORD '${password}'`);

  // Copy the source into the clone with a logical pg_dump | pg_restore
  // rather than CREATE DATABASE … TEMPLATE. TEMPLATE requires ZERO other
  // sessions connected to the source at copy time, but the source here
  // is the LIVE prod DB whose app container holds a persistent
  // connection pool. The old terminate-then-TEMPLATE step therefore
  // raced the pool's near-instant reconnect: it failed intermittently
  // under light traffic and effectively always under sustained load
  // (GitHub #73 — "source database … is being accessed by other users").
  // pg_dump instead reads a consistent MVCC snapshot inside a
  // transaction (ACCESS SHARE locks only), so the prod app keeps serving
  // uninterrupted and there is no exclusive-access race.
  //
  // The clone starts from template0 (pristine, never-connected, so it's
  // always clonable) owned by the new role; pg_restore --no-owner, running
  // AS that role (see dumpRestore), lands every object owned by it directly
  // — the same end-state the TEMPLATE path produced. The
  // reassignUserObjectsTo passes below stay as the backstop for anything a
  // restore could still have left with another owner.
  await inAdmin(`CREATE DATABASE ${targetDb} TEMPLATE template0 OWNER ${targetRole}`);

  // Don't dump data we are about to throw away. The scrub passes below
  // TRUNCATE every `staging:private` table anyway, so copying their rows
  // across the pipe is pure cost — and for the self-app it is the
  // DOMINANT cost of the whole proposal-checks pipeline: 99.3% of that
  // database's ~9.8 GB lives in private tables (vrf_obligations,
  // session_visuals, …), so each preview build spent ~4.5 minutes
  // dumping and restoring ~9.4 GB purely to delete it a moment later.
  // Discovering the set from the SOURCE (before the clone exists) and
  // handing it to pg_dump as --exclude-table-data drops the payload to
  // the ~80 MB that actually survives.
  const excludeData = await privateDataExclusions(sourceDb);
  const dumpStartedAt = Date.now();
  // The restore authenticates AS the clone's own role, so the app-defined
  // code the data load evaluates — CHECK constraints validated after the
  // COPY, generated columns computed on insert, row and event triggers —
  // runs with that unprivileged role's rights, not the administrator's (see
  // dumpRestore). The role was created with its password above and owns the
  // fresh database.
  await dumpRestore(sourceDb, targetDb, excludeData, {
    targetServer: server, as: { user: targetRole, password },
  });
  log.info('db-manager', 'Clone copy complete', {
    sourceDb, targetDb,
    excludedTables: excludeData.length,
    durationMs: Date.now() - dumpStartedAt,
  });

  // Lock down PUBLIC connect on the clone — the clone is single-tenant
  // (one staging container) and nothing else should be able to reach it.
  await inAdmin(`REVOKE CONNECT ON DATABASE ${targetDb} FROM PUBLIC`);
  await inAdmin(`GRANT ALL PRIVILEGES ON DATABASE ${targetDb} TO ${targetRole}`);

  // CREATE DATABASE … TEMPLATE copies tables but each one keeps its
  // original owner from the source DB. For a clone of a per-role-
  // migrated source, that owner is `<sourceDb>_owner`; for a clone
  // of a not-yet-migrated source (the self-app — db/migrate.js skips
  // self_hosted rows in migrateAppDbsToPerRole) it's the superuser.
  // Reassign every object inside the target DB to the new clone role
  // so it can ALTER, SELECT, INSERT, and DROP without privilege errors.
  //
  // Why not plain `REASSIGN OWNED BY sourceRole TO targetRole`? It
  // looks like the right tool — and was used here historically — but
  // it has a critical cluster-wide side effect: REASSIGN OWNED also
  // walks shared catalogs (`pg_database`, `pg_tablespace`,
  // `pg_auth_members`), reassigning ownership of *databases* the
  // source role owns. In our setup `app_<slug>_owner` owns the prod
  // database `app_<slug>`, so cloning prod into a staging clone
  // silently transferred prod's `pg_database` row + its grants to the
  // throwaway staging role. The prod container kept its existing
  // pool connections alive, so nothing broke until the container was
  // next restarted (merge rebuild, drift redeploy, host reboot) —
  // at which point the new container couldn't connect to its own DB
  // with FATAL 42501 "permission denied for database … User does not
  // have CONNECT privilege." See the post-mortem in the commit that
  // introduced this comment.
  //
  // The superuser-owned fast path has its own reason to avoid
  // REASSIGN OWNED: the superuser also owns pg_toast tables pinned
  // to pg_catalog, and postgres aborts the whole REASSIGN with
  // "cannot reassign ownership of objects owned by role X because
  // they are required by the database system" — which used to be
  // swallowed at .catch(debug), silently leaving tables owned by
  // the superuser and producing clones the new role couldn't ALTER
  // (staging crash-looped with `42501 must be owner of table users`
  // on the first migration).
  //
  // reassignUserObjectsTo enumerates only user-schema objects in
  // the target DB and ALTERs each one individually — no shared-
  // catalog side effects, no pg_catalog interference. Calling it
  // once per source role (the prod owner if it exists, and the
  // superuser as a fallback for the self-app case) covers both
  // template variants without the REASSIGN OWNED footgun.
  const sourceRole = ownerRoleName(sourceDb);
  if (SAFE_IDENT.test(sourceRole)) {
    await reassignUserObjectsTo(targetDb, sourceRole, targetRole, inTarget).catch((err) => {
      log.warn('db-manager', 'reassignUserObjectsTo from source-role failed', {
        targetDb, sourceRole, err: err.message,
      });
    });
  }
  await reassignUserObjectsTo(targetDb, adminUser(server), targetRole, inTarget).catch((err) => {
    // On the preview server every restored object belongs to the restoring
    // administrator until this pass: a clone whose pass failed is one its
    // own role cannot read, and it is not handed out.
    if (serverKey(server) !== PRIMARY_SERVER) throw err;
    log.warn('db-manager', 'reassignUserObjectsTo from superuser failed', {
      targetDb, err: err.message,
    });
  });

  // Enforce the public/private convention documented in
  // src/prompts/app-conventions.md. The copy above brings schema
  // wholesale; the two passes below redact prod rows so staging clients
  // see the structure but none of the production data.
  //
  // Pass 1 is now mostly a BACKSTOP rather than the primary mechanism:
  // privateDataExclusions already kept those tables' data out of the dump
  // (see the copy step above), so the TRUNCATEs run against empty tables.
  // It stays, deliberately and unchanged, for three reasons: it is the
  // redaction guarantee if the exclusion set and this discovery ever
  // disagree; it covers a table whose identifier the exclusion pass
  // refused to splice; and `TRUNCATE … RESTART IDENTITY` is what resets
  // sequences — --exclude-table-data leaves them at their prod positions,
  // so dropping this pass would silently change clone behaviour.
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
  // The two passes run AS the clone's own owner role, not the administrator
  // (see redactPrivateData): app-defined code a TRUNCATE or UPDATE evaluates
  // then runs with that unprivileged role's rights. The reassign above moved
  // every object to it, so it owns these tables and can empty them.
  const asOwner = (db, sql, opts = {}) =>
    execInTarget(db, sql, { ...opts, server, as: { user: targetRole, password } });
  await redactPrivateData(targetDb, asOwner);

  log.info('db-manager', 'Database cloned with new role', { sourceDb, targetDb, targetRole, server });
  return { password };
}

// ── Staging templates ───────────────────────────────────────────────────
//
// Every preview build used to pay the full logical copy of the live source:
// pg_dump | pg_restore, then the two redaction passes and the ownership
// walk — the same cost for a one-line diff as for a thousand, and the part
// of the build half that no image cache can shrink. The template keeps that
// work's RESULT: `<source>_stgtmpl` is a redacted, truncated, reassigned copy
// with connections disallowed, so a clone from it is CREATE DATABASE …
// TEMPLATE — a file copy of the ~80 MB that survives redaction, seconds
// rather than a minute — and the expensive path runs once per
// STAGING_DB_TEMPLATE_MAX_AGE_MS per app instead of once per build.
//
// Two properties make it safe:
//   - It is built with exactly the direct path's steps (exclusions, restore,
//     reassign to a NOLOGIN template role, truncate, scrub) into a `_next`
//     database, then swapped in by a rename. A half-built template is never
//     the one clones read from.
//   - Clones re-run the two redaction passes anyway. They are no-ops on a
//     template that was built right, and they keep the guarantee the direct
//     path makes: the passes are the redaction, the exclusion is the
//     optimisation.
// Refresh and clone are serialised per source in this process (a rename
// under a running CREATE DATABASE … TEMPLATE is the one race), and the
// staleness window is the only difference a preview can observe: its data
// is as much as MAX_AGE old. Its own boot applies its own schema on top.
//
// Two ages. Past the SOFT age a build still clones from the template it
// finds and a refresh is queued behind it, so the rebuild is never on a
// build's critical path unless there is nothing to clone from: a low-traffic
// app whose builds are hours apart would otherwise pay the direct cost on
// every one and gain nothing. Past the HARD age the data is too old to hand
// to a reviewer, and the build refreshes first. Both are env-tunable; a soft
// age of 0 turns templates off.
const STAGING_TEMPLATE_SUFFIX = '_stgtmpl';
const STAGING_TEMPLATE_MAX_AGE_MS = (() => {
  const v = parseInt(process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 15 * 60 * 1000;
})();
const STAGING_TEMPLATE_HARD_MAX_AGE_MS = (() => {
  const v = parseInt(process.env.STAGING_DB_TEMPLATE_HARD_MAX_AGE_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 6 * 60 * 60 * 1000;
})();
// Postgres identifiers are 63 bytes; the `_next` build name is the longest.
const MAX_TEMPLATE_IDENT = 63 - '_next'.length;

function stagingTemplatesEnabled() {
  return STAGING_TEMPLATE_MAX_AGE_MS > 0;
}

function stagingTemplateDbName(sourceDb) {
  return `${sourceDb}${STAGING_TEMPLATE_SUFFIX}`;
}

const _templateChains = new Map();
function withTemplateLock(key, fn) {
  const prev = _templateChains.get(key) || Promise.resolve();
  // The platform database is the common lock domain, including background
  // template refreshes. Never lock inside the template database being replaced.
  const locked = () => withResourceUse({ databaseUrl: process.env.DATABASE_URL }, STAGING_TEMPLATE_LOCK, key, fn);
  const run = prev.then(locked, locked);
  const tail = run.then(() => {}, () => {});
  _templateChains.set(key, tail);
  tail.then(() => { if (_templateChains.get(key) === tail) _templateChains.delete(key); });
  return run;
}

// Drop a template-side database WITHOUT the role handling dropDatabase does:
// the template role is shared by every build of the template and owns the
// objects inside it, so it must outlive any one database.
async function dropTemplateDb(dbName, { server = PRIMARY_SERVER } = {}) {
  if (!SAFE_IDENT.test(dbName)) throw new Error(`dropTemplateDb: unsafe dbName ${JSON.stringify(dbName)}`);
  await dropDisposableDatabase(dbName, { server });
}

// When the template was last rebuilt, from the comment the refresh stamps
// on it. Null when there is no template, or nothing readable on it.
async function readTemplateRefreshedAt(templateDb, { server = PRIMARY_SERVER } = {}) {
  if (!SAFE_IDENT.test(templateDb)) return null;
  const out = await adminExecutor(server)(
    `SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '${templateDb}'`,
    { tuplesOnly: true }
  ).catch(() => '');
  const m = /refreshed_at=(\S+)/.exec(String(out || ''));
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

// The direct path's steps, verbatim, into `targetDb`: a bare database from
// template0, a dump/restore of the live source, both ownership reassigns and
// the two redaction passes. The caller owns the role, the stamp, the lock
// and the swap. Returns the exclusion list.
//
// `server` is where the copy is made. The dump, and the discovery of which
// tables' data to leave out of it, always read the main server, where the
// live source is; everything else, both redaction passes included, runs on
// the copy's own server, and a failure in either pass is as fatal there.
async function buildRedactedCopy(sourceDb, targetDb, ownerRole, { server = PRIMARY_SERVER } = {}) {
  if (!SAFE_IDENT.test(targetDb) || !SAFE_IDENT.test(ownerRole)) {
    throw new Error(`buildRedactedCopy: unsafe identifiers ${sourceDb}/${targetDb}/${ownerRole}`);
  }
  const inTarget = targetExecutor(server);
  const inAdmin = adminExecutor(server);
  await inAdmin(`CREATE DATABASE ${targetDb} TEMPLATE template0 OWNER ${ownerRole}`);

  // This role is NOLOGIN (a template / prepared-source role is shared and
  // never logs in). Give it a login and a fresh password for everything that
  // runs AS it — the data load (pg_restore authenticates as it, so the
  // app-defined code the load evaluates runs without the platform's rights;
  // see dumpRestore) and the redaction passes (see redactPrivateData) — and
  // take both away again afterwards, on every path. A template or
  // prepared-source role must never be left login-capable, nor with a
  // password on it.
  const redactionPassword = generatePassword();
  await inAdmin(`ALTER ROLE ${ownerRole} LOGIN PASSWORD '${redactionPassword}'`);
  const asOwner = (db, sql, opts = {}) =>
    execInTarget(db, sql, { ...opts, server, as: { user: ownerRole, password: redactionPassword } });
  let excludeData = null;
  let buildErr = null;
  try {
    excludeData = await privateDataExclusions(sourceDb);
    await dumpRestore(sourceDb, targetDb, excludeData, {
      targetServer: server, as: { user: ownerRole, password: redactionPassword },
    });
    const sourceRole = ownerRoleName(sourceDb);
    if (SAFE_IDENT.test(sourceRole)) {
      await reassignUserObjectsTo(targetDb, sourceRole, ownerRole, inTarget).catch((err) => {
        log.warn('db-manager', 'template reassign from source-role failed', { targetDb, sourceRole, err: err.message });
      });
    }
    await reassignUserObjectsTo(targetDb, adminUser(server), ownerRole, inTarget).catch((err) => {
      if (serverKey(server) !== PRIMARY_SERVER) throw err;   // see cloneDatabaseDirect
      log.warn('db-manager', 'template reassign from superuser failed', { targetDb, err: err.message });
    });
    await redactPrivateData(targetDb, asOwner);
  } catch (err) {
    buildErr = err;
  }
  try {
    await inAdmin(`ALTER ROLE ${ownerRole} NOLOGIN PASSWORD NULL`);
  } catch (err) {
    if (buildErr) {
      log.error('db-manager', 'Could not return the redaction role to NOLOGIN after a failed build', {
        ownerRole, err: err.message,
      });
    } else {
      buildErr = err;
    }
  }
  if (buildErr) throw buildErr;
  return excludeData;
}

// Rebuild the template from the live source, then swap it in.
async function refreshStagingTemplate(sourceDb, { server = PRIMARY_SERVER } = {}) {
  const inAdmin = adminExecutor(server);
  const templateDb = stagingTemplateDbName(sourceDb);
  const next = `${templateDb}_next`;
  const templateRole = ownerRoleName(templateDb);
  if (!SAFE_IDENT.test(templateDb) || !SAFE_IDENT.test(templateRole) || templateDb.length > MAX_TEMPLATE_IDENT) {
    throw new Error(`refreshStagingTemplate: unusable template name for ${sourceDb}`);
  }
  const startedAt = Date.now();
  log.info('db-manager', 'Refreshing staging template', { sourceDb, templateDb });

  await dropTemplateDb(next, { server });
  await inAdmin(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${templateRole}') THEN
      CREATE ROLE ${templateRole} NOLOGIN;
    END IF;
  END $$;`);
  const excludeData = await buildRedactedCopy(sourceDb, next, templateRole, { server });

  await inAdmin(`REVOKE CONNECT ON DATABASE ${next} FROM PUBLIC`);
  const stamp = new Date().toISOString();
  await inAdmin(`COMMENT ON DATABASE ${next} IS 'staging-template source=${sourceDb} refreshed_at=${stamp}'`);
  // A template nobody can connect to is one CREATE DATABASE … TEMPLATE can
  // always copy (the "being accessed by other users" refusal needs a
  // session, and there can be none) and one the reap sweep never mistakes
  // for a preview clone: its name carries no `_staging_s<id>_` segment.
  await inAdmin(`ALTER DATABASE ${next} WITH ALLOW_CONNECTIONS false`);

  // Swap. A failed rename leaves `next` behind and no template, which the
  // next ensure simply rebuilds; a failed drop is surfaced, not hidden.
  // The rename too is refused while a session is on `next`, such as the
  // backend of the scrub that just finished, still exiting.
  await dropTemplateDb(templateDb, { server });
  await dbRetry.withDbRetry(() => inAdmin(`ALTER DATABASE ${next} RENAME TO ${templateDb}`), {
    retryable: dbRetry.isDbConflict,
    beforeRetry: (error) => (dbRetry.isObjectInUse(error)
      ? terminateDisposableSessions(next, { server }).catch(() => {}) : null),
    label: 'Staging template swap',
  });
  log.info('db-manager', 'Staging template refreshed', {
    sourceDb, templateDb, excludedTables: excludeData.length, durationMs: Date.now() - startedAt,
    ...(serverKey(server) === PRIMARY_SERVER ? {} : { server }),
  });
  await retireTemplateElsewhere(sourceDb, server);
  return templateDb;
}

// The same app's template on a server that no longer makes previews: the
// main server's copy once the preview server is on, the preview server's
// while it drains. Nothing clones from it again, so it only costs disk and a
// row in every catalog sweep. Called with the source's template lock held.
// Best-effort: a template left behind is harmless, and the reap sweep's
// retireStrayTemplates comes back for it.
async function retireTemplateElsewhere(sourceDb, keepOn) {
  const templateDb = stagingTemplateDbName(sourceDb);
  const templateRole = ownerRoleName(templateDb);
  if (!previewServerConfigured() || await previewServerIsMainServer()) return;
  for (const other of previewSideServers()) {
    if (other === serverKey(keepOn)) continue;
    try {
      const inAdmin = adminExecutor(other);
      const found = await inAdmin(
        `SELECT datname FROM pg_database WHERE datname IN ('${templateDb}', '${templateDb}_next')`,
        { tuplesOnly: true }
      );
      const names = String(found || '').split('\n').map((line) => line.trim())
        .filter((name) => name === templateDb || name === `${templateDb}_next`);
      if (!names.length) continue;
      for (const name of names) await dropTemplateDb(name, { server: other });
      // The role owned only what was inside those databases. If a frozen
      // shots source still uses it, the drop fails and the role stays.
      await inAdmin(`DROP ROLE IF EXISTS ${templateRole}`).catch(() => {});
      log.info('db-manager', 'Retired a staging template on the server that no longer makes previews', {
        sourceDb, server: other, dropped: names,
      });
    } catch (err) {
      log.warn('db-manager', 'Could not retire a staging template on the other server', {
        sourceDb, server: other, err: err.message,
      });
    }
  }
}

// A deleted app's staging templates, on every server that may hold them
// (#5121). The template is a redacted copy of the app's own database, kept
// warm for previews, so it outlived the app: the teardown dropped only
// app_<slug>, and nothing else drops a template whose source is gone. Taken
// under the source's template lock, so a refresh cannot be mid-build. Drops
// the template, its `_next` build and the template role. Idempotent (IF
// EXISTS throughout). Throws on the first failure, for the caller to record.
async function dropStagingTemplates(sourceDb) {
  const templateDb = stagingTemplateDbName(sourceDb);
  const templateRole = ownerRoleName(templateDb);
  if (!SAFE_IDENT.test(templateDb) || !SAFE_IDENT.test(templateRole)) {
    throw new Error(`dropStagingTemplates: unusable template name for ${JSON.stringify(sourceDb)}`);
  }
  // A name too long for a `_next` build was never made into a template.
  if (templateDb.length > MAX_TEMPLATE_IDENT) return;
  await withTemplateLock(sourceDb, async () => {
    for (const server of previewSideServers()) {
      await dropTemplateDb(`${templateDb}_next`, { server });
      await dropTemplateDb(templateDb, { server });
      await adminExecutor(server)(`DROP ROLE IF EXISTS ${templateRole}`);
    }
  });
  log.info('db-manager', 'Staging templates of a deleted app dropped', { sourceDb, templateDb });
}

// The template to clone from. Refreshed first (`refreshed: true`) when it
// is missing or past the hard age; handed over as it is with `stale: true`
// when it is only past the soft age, so the caller can queue the refresh
// behind the clone. Resolves `{ template, refreshed, stale }`.
async function ensureStagingTemplate(sourceDb, {
  maxAgeMs = STAGING_TEMPLATE_MAX_AGE_MS,
  hardMaxAgeMs = STAGING_TEMPLATE_HARD_MAX_AGE_MS,
  now = Date.now(),
  server = PRIMARY_SERVER,
} = {}) {
  if (!SAFE_IDENT.test(sourceDb)) throw new Error(`ensureStagingTemplate: unsafe sourceDb ${JSON.stringify(sourceDb)}`);
  const templateDb = stagingTemplateDbName(sourceDb);
  if (templateDb.length > MAX_TEMPLATE_IDENT) throw new Error(`ensureStagingTemplate: name too long for ${sourceDb}`);
  // A wiped preview server answers "no such template" here like any server
  // that never had one, so the next build rebuilds it without being told.
  const refreshedAt = await readTemplateRefreshedAt(templateDb, { server });
  const age = refreshedAt === null ? null : now - refreshedAt;
  if (age !== null && age <= maxAgeMs) return { template: templateDb, refreshed: false, stale: false };
  if (age !== null && age <= Math.max(hardMaxAgeMs, maxAgeMs)) {
    return { template: templateDb, refreshed: false, stale: true };
  }
  await refreshStagingTemplate(sourceDb, { server });
  return { template: templateDb, refreshed: true, stale: false };
}

// Refresh off the critical path, behind whatever holds the source's lock.
// Re-checks the age under the lock: two builds that both found the template
// stale must not rebuild it twice.
const _queuedRefreshes = new Set();
function queueTemplateRefresh(sourceDb, { server = PRIMARY_SERVER } = {}) {
  if (_queuedRefreshes.has(sourceDb)) return;
  _queuedRefreshes.add(sourceDb);
  withTemplateLock(sourceDb, async () => {
    const refreshedAt = await readTemplateRefreshedAt(stagingTemplateDbName(sourceDb), { server });
    if (refreshedAt !== null && (Date.now() - refreshedAt) <= STAGING_TEMPLATE_MAX_AGE_MS) return;
    await refreshStagingTemplate(sourceDb, { server });
  }).catch((err) => {
    log.warn('db-manager', 'Background staging-template refresh failed', { sourceDb, err: err.message });
  }).finally(() => { _queuedRefreshes.delete(sourceDb); });
}

// Tests: settle everything queued for a source.
function templateIdle(sourceDb) {
  return _templateChains.get(sourceDb) || Promise.resolve();
}

// The fast clone: a file copy of the template, handed to a fresh role.
// `attempts` above one retries the copy (createFromTemplate); a preview
// keeps one, since a failed template clone already falls back to the
// direct copy.
async function cloneFromTemplate(templateDb, targetDb, {
  queryTimeoutMs = 30_000, onProgress = null, attempts = 1, server = PRIMARY_SERVER,
} = {}) {
  if (!SAFE_IDENT.test(templateDb) || !SAFE_IDENT.test(targetDb)) {
    throw new Error(`cloneFromTemplate: unsafe identifiers ${templateDb}/${targetDb}`);
  }
  const templateRole = ownerRoleName(templateDb);
  const targetRole = ownerRoleName(targetDb);
  if (!SAFE_IDENT.test(templateRole) || !SAFE_IDENT.test(targetRole)) {
    throw new Error(`cloneFromTemplate: unsafe roles ${templateRole}/${targetRole}`);
  }
  const startedAt = Date.now();
  const password = generatePassword();
  const maintenanceDb = adminDatabase(server);
  // A database of this name on the OTHER server is an earlier build of the
  // same preview, made before previews moved. It goes first, on its own
  // connection: the session below belongs to this clone's server.
  await dropOldTarget(targetDb, server, { ownServer: false });
  await withDatabaseConnection(maintenanceDb, async (execute) => {
    const admin = singleConnection((sql, opts) => execute(maintenanceDb, sql, opts));
    onProgress?.('drop_target');
    await dropDatabase(targetDb, { strict: true, execute: admin, server });
    onProgress?.('create_role');
    await admin(`CREATE ROLE ${targetRole} LOGIN PASSWORD '${password}'`);
    onProgress?.('copy_template');
    await createFromTemplate(templateDb, targetDb, targetRole, { execute: admin, attempts, server });
    await admin(`REVOKE CONNECT ON DATABASE ${targetDb} FROM PUBLIC`);
    await admin(`GRANT ALL PRIVILEGES ON DATABASE ${targetDb} TO ${targetRole}`);
  }, { queryTimeoutMs, server });
  // Ownership moves to the clone's own role AS the administrator (only it can
  // reassign objects the template role owns); a short-lived psql process, so
  // no administrative session lingers afterwards.
  onProgress?.('reassign_ownership');
  try {
    await reassignUserObjectsTo(targetDb, templateRole, targetRole, targetExecutor(server));
  } catch (error) {
    error.message = `Database clone reassign_ownership: ${error.message}`;
    throw error;
  }
  // The redaction then runs over one connection AUTHENTICATED AS that clone
  // role (see redactPrivateData): app-defined code a TRUNCATE or UPDATE
  // evaluates runs with its unprivileged rights, never the administrator's.
  // Never pooled: the caller may need to drop this database immediately on
  // failure, and a later preview must not inherit this session.
  await withDatabaseConnection(targetDb, async (execute) => {
    try { await redactPrivateData(targetDb, execute, { onProgress }); }
    catch (error) {
      if (!/^Database clone /.test(String(error.message || ''))) {
        error.message = `Database clone redact_private: ${error.message}`;
      }
      throw error;
    }
  }, { queryTimeoutMs, server, as: { user: targetRole, password } });
  onProgress?.('redaction_complete');
  log.info('db-manager', 'Database cloned from staging template', {
    templateDb, targetDb, targetRole, durationMs: Date.now() - startedAt,
  });
  return { password };
}

// #2380: freeze ONE redacted staging-template generation for a paired
// base/head shots run. Calling cloneDatabase(..., { viaTemplate: true })
// twice is not equivalent: the soft-age refresh can swap the shared template
// between those calls. A prepared source is its own immutable, no-connections
// database and therefore gives both sides byte-equivalent starting data.
function preparedCloneSourceName(sourceDb, sourceId) {
  if (!SAFE_IDENT.test(sourceDb)) {
    throw new Error(`preparedCloneSourceName: unsafe sourceDb ${JSON.stringify(sourceDb)}`);
  }
  const token = crypto.createHash('sha256').update(String(sourceId || '')).digest('hex').slice(0, 12);
  const suffix = `_evsrc_${token}`;
  return `${sourceDb.slice(0, 63 - suffix.length)}${suffix}`;
}

// The statement ceiling for preparing a shots run's clone source and for each
// side's clone from it: a large copy or ownership pass under load is slow
// without being stuck.
const PREPARED_SOURCE_TIMEOUT_MS = 90_000;

function isPreparedCloneSource(name) {
  return SAFE_IDENT.test(String(name || '')) && /_evsrc_[0-9a-f]{12}$/.test(String(name));
}

async function prepareStagingCloneSource(sourceDb, { sourceId } = {}) {
  if (!sourceId) throw new Error('prepareStagingCloneSource: sourceId is required');
  if (!stagingTemplatesEnabled()) {
    throw new Error('prepareStagingCloneSource: staging templates are disabled');
  }
  // The frozen source is copied from the shared template, so it is made on
  // the template's server, and both sides are then copied from it there
  // (cloneFromPreparedSource reads the server back from what this returns).
  const server = previewCreateServer();
  const inAdmin = adminExecutor(server);
  await assertPreviewServerReachable(server);
  return withTemplateLock(sourceDb, async () => {
    // The template and its stamp, read again. A missing template rebuilds
    // here; a template with no provenance is a real problem and throws.
    const readProvenance = async () => {
      const ensured = await ensureStagingTemplate(sourceDb, { server });
      const template = ensured.template;
      const refreshedAtMs = await readTemplateRefreshedAt(template, { server });
      if (refreshedAtMs === null) throw new Error('prepareStagingCloneSource: template has no refresh provenance');
      return { template, refreshedAtMs };
    };

    const preparedDb = preparedCloneSourceName(sourceDb, sourceId);
    const preparedRole = ownerRoleName(preparedDb);
    const provenance = await readProvenance();
    let sharedTemplate = provenance.template;
    let refreshedAtMs = provenance.refreshedAtMs;
    await dropOldTarget(preparedDb, server);
    await inAdmin(`CREATE ROLE ${preparedRole} NOLOGIN`);
    try {
      let copied = false;
      let builtDirectly = false;
      // The copy and the ownership pass get the paired clones' own
      // ceiling (cloneFromPreparedSource): under load the copy alone
      // can outlast the 30-second default, and a timeout here fails
      // the whole shots run.
      const copyFromShared = () => createFromTemplate(sharedTemplate, preparedDb, preparedRole, {
        timeoutMs: PREPARED_SOURCE_TIMEOUT_MS, attempts: dbRetry.DB_RETRY_ATTEMPTS, server,
      });
      const buildDirectly = async (why) => {
        log.warn('db-manager', 'Preparing the shots clone source directly from the live source', {
          sourceDb, sharedTemplate, preparedDb, why,
        });
        // The direct build's objects already belong to preparedRole, so
        // the shared-role reassign below is skipped and the stamp reads
        // as fresh now: this copy is as fresh as the moment it was built.
        await buildRedactedCopy(sourceDb, preparedDb, preparedRole, { server });
        builtDirectly = true;
        refreshedAtMs = Date.now();
      };
      for (let attempt = 1; attempt <= 2 && !copied; attempt++) {
        try {
          await copyFromShared();
          copied = true;
        } catch (err) {
          if (!isMissingTemplateError(err)) throw err;
          // A refresh running in another process dropped the shared
          // template between the freshness read and this copy. Drop the
          // half-made copy (the role stays), rebuild the template and
          // try once more; if it still will not copy, build the prepared
          // source directly so the run takes the slower path instead of
          // failing.
          await dropDisposableDatabase(preparedDb, { server });
          if (attempt > 1) {
            await buildDirectly('rebuilt template still missing');
          } else {
            log.warn('db-manager', 'Staging template vanished during the shots copy — rebuilding it and copying again', {
              sourceDb, sharedTemplate, preparedDb, err: err.message,
            });
            try {
              const reEnsured = await readProvenance();
              sharedTemplate = reEnsured.template;
              refreshedAtMs = reEnsured.refreshedAtMs;
            } catch (ensureErr) {
              await buildDirectly(`re-ensure failed: ${ensureErr.message}`);
            }
          }
        }
      }
      if (!builtDirectly) {
        await withDatabaseConnection(preparedDb, async (execute) => {
          await reassignUserObjectsTo(preparedDb, ownerRoleName(sharedTemplate), preparedRole, execute);
        }, { queryTimeoutMs: PREPARED_SOURCE_TIMEOUT_MS, server });
      }
      await inAdmin(`REVOKE CONNECT ON DATABASE ${preparedDb} FROM PUBLIC`);
      const fingerprint = crypto.createHash('sha256')
        .update(`${sourceDb}\n${sharedTemplate}\n${new Date(refreshedAtMs).toISOString()}\n${preparedDb}`)
        .digest('hex');
      await inAdmin(
        `COMMENT ON DATABASE ${preparedDb} IS 'shots-clone-source source=${sourceDb} refreshed_at=${new Date(refreshedAtMs).toISOString()} fingerprint=${fingerprint}'`
      );
      await inAdmin(`ALTER DATABASE ${preparedDb} WITH ALLOW_CONNECTIONS false`);
      return {
        templateDb: preparedDb,
        sourceDb,
        refreshedAt: new Date(refreshedAtMs).toISOString(),
        fingerprint,
        // Only when it is not the main server, so a one-server install's
        // prepared source is the object it always was.
        ...(server === PRIMARY_SERVER ? {} : { server }),
      };
    } catch (err) {
      await dropDatabase(preparedDb).catch(() => {});
      throw err;
    }
  });
}

async function cloneFromPreparedSource(prepared, targetDb, { onProgress = null } = {}) {
  const templateDb = typeof prepared === 'string' ? prepared : prepared?.templateDb;
  if (!isPreparedCloneSource(templateDb)) {
    throw new Error(`cloneFromPreparedSource: invalid prepared source ${JSON.stringify(templateDb)}`);
  }
  // Paired shots resets repeat this clone and have their own bounded
  // lifetime. A large ownership/redaction query may exceed the ordinary
  // preview's 30-second ceiling without being stuck.
  // The server the source was frozen on. A copy can only be made beside it.
  const server = serverKey(typeof prepared === 'object' ? prepared.server : null);
  const result = await cloneFromTemplate(templateDb, targetDb, {
    queryTimeoutMs: PREPARED_SOURCE_TIMEOUT_MS, onProgress, attempts: dbRetry.DB_RETRY_ATTEMPTS, server,
  });
  onProgress?.('connection_limit');
  await applyStagingConnectionLimit(targetDb, { server });
  return {
    ...result,
    ...(server === PRIMARY_SERVER ? {} : { server }),
    via: 'prepared-template',
    fixtureFingerprint: typeof prepared === 'object' ? prepared.fingerprint || null : null,
  };
}

async function releasePreparedCloneSource(prepared) {
  const templateDb = typeof prepared === 'string' ? prepared : prepared?.templateDb;
  if (!isPreparedCloneSource(templateDb)) {
    throw new Error(`releasePreparedCloneSource: invalid prepared source ${JSON.stringify(templateDb)}`);
  }
  await dropDatabase(templateDb, { strict: true });
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
async function reassignUserObjectsTo(dbName, fromRole, toRole, execute = execInTarget) {
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
  --
  -- Every loop also skips an extension's own objects (deptype 'e'):
  -- they stay with whoever created the extension. Handed to an app's
  -- role, pg_stat_statements_reset() (the operator's extension, made by
  -- the administrator) would let a preview's code wipe the query
  -- statistics of every database on the server.
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
            AND d.deptype IN ('a','i','e')
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
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
       )
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
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = t.oid AND d.classid = 'pg_type'::regclass AND d.deptype = 'e'
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
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = n.oid AND d.classid = 'pg_namespace'::regclass AND d.deptype = 'e'
       )
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.nspname, '${toRole}');
  END LOOP;
END $$;`;

  await execute(dbName, sql);
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
  await reassignUserObjectsTo(dbName, adminUser(), role);

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

async function databaseExists(dbName, { strict = false } = {}) {
  if (!SAFE_IDENT.test(dbName)) {
    if (strict) throw new Error('databaseExists: unsafe database name');
    return false;
  }
  // A preview-side name is looked for on every configured server: the
  // caller asks "is a database of this name still serving somewhere".
  let lookupError = null;
  for (const server of serversHolding(dbName)) {
    try {
      const stdout = await adminExecutor(server)(
        `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
        { tuplesOnly: true }
      );
      if ((stdout || '').trim() === '1') return true;
    } catch (err) {
      lookupError = lookupError || err;
    }
  }
  if (lookupError && strict) throw lookupError;
  return false;
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

// What node-postgres is given for a server. The main server: its URL, as
// always. The preview server: its URL without a query, and `ssl: false`
// said outright, so that neither an sslmode nor a PGSSLMODE in the
// platform's environment decides how this client connects.
function pgClientConfig(url, server) {
  if (serverKey(server) === PRIMARY_SERVER) return { connectionString: url.toString() };
  const plain = new URL(url.toString());
  plain.search = '';
  return { connectionString: plain.toString(), ssl: false };
}

// The preview server could not be CONNECTED to by node-postgres. Marked so
// that a build stops there (cloneDatabaseOn) instead of trying another way
// to the same server.
function previewConnectFailure(err, server) {
  if (err && typeof err === 'object' && serverKey(server) !== PRIMARY_SERVER) err.previewServerConnectFailed = true;
  return fromPreviewServer(err, server);
}

// Before a build reads anything from production on the preview server's
// behalf: can BOTH clients reach it? psql is the first thing every path
// runs there anyway; node-postgres is not, and a server only psql can reach
// used to cost a full production dump before the build failed, or, worse,
// produced a clone whose URL nothing could use. One short connection.
async function assertPreviewServerReachable(server) {
  if (serverKey(server) === PRIMARY_SERVER) return;
  const maintenanceDb = adminDatabase(server);
  await withDatabaseConnection(maintenanceDb, (run) => run(maintenanceDb, 'SELECT 1'), { server });
  await execInDb('SELECT 1', { server, tuplesOnly: true });
}

// Match the existing psql executor's discovery format while reusing a single
// connection within one clone phase. Other administration keeps its existing
// one-shot behavior. SQL stays in autocommit: CREATE/DROP DATABASE cannot run
// inside a transaction, and a failed redaction must not abort later attempts.
async function withDatabaseConnection(dbName, fn, opts = {}) {
  return onMainServer(opts.server, () => withDatabaseConnectionNow(dbName, fn, opts));
}

async function withDatabaseConnectionNow(dbName, fn, { queryTimeoutMs = 30_000, server = PRIMARY_SERVER, as = null } = {}) {
  if (!SAFE_IDENT.test(dbName)) throw new Error(`Unsafe connection database: ${dbName}`);
  const timeoutMs = Math.max(30_000, Math.min(120_000, Number(queryTimeoutMs) || 30_000));
  let url;
  try { url = adminConnection(server); } catch (err) { throw fromPreviewServer(err, server); }
  url.pathname = `/${dbName}`;
  // `as` authenticates as a specific role (the copy's unprivileged owner, for
  // the redaction passes) rather than the administrator. The role and
  // password go in the authority; any administrative user/password left in
  // the URL's query would otherwise override it (see connectionUrl).
  if (as && as.user) {
    url.username = as.user;
    url.password = as.password || '';
    for (const key of ['user', 'password']) if (url.searchParams.has(key)) url.searchParams.delete(key);
  }
  const client = new Client({
    ...pgClientConfig(url, server),
    connectionTimeoutMillis: 30000,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
    application_name: 'social-template-clone',
  });
  let lost;
  let failed = false;
  client.on('error', (err) => { lost = err; });
  try {
    try { await client.connect(); } catch (err) { throw previewConnectFailure(err, server); }
    // The same pin execInTarget applies (see there): inside an app database,
    // the session's search_path decides how the platform's SQL resolves
    // unqualified names, and the app can steer it. Set at the session level,
    // so a database- or role-level default the app set is overridden. The
    // maintenance database keeps the platform's own default path.
    if (dbName !== adminDatabase(server)) {
      await client.query({ text: 'SET search_path = pg_catalog', rowMode: 'array' });
    }
    return await fn(singleConnection(async (targetDb, sql, opts = {}) => {
      if (targetDb !== dbName) throw new Error('Clone connection database mismatch');
      if (lost) throw lost;
      let result;
      try {
        // Settings for this session, sent before the statement that needs
        // them, on this one connection (a shared-block copy's SET).
        for (const setup of opts.sessionSetup || []) {
          await client.query({ text: setup, rowMode: 'array' });
        }
        result = await client.query({ text: sql, rowMode: 'array' });
      } catch (err) {
        // A client-side timeout does not confirm server cancellation. Stop
        // submitting work on this session; finally closes the active query
        // before fallback can recreate the database. Ordinary SQL failures
        // remain in autocommit so the redaction pass can collect its errors.
        if (err.message === 'Query read timeout') lost = err;
        throw err;
      }
      if (!opts.tuplesOnly) return '';
      return result.rows.map((row) => row.map((value) => value === true ? 't'
        : value === false ? 'f' : value == null ? '' : String(value)).join('|')).join('\n');
    }));
  } catch (err) {
    failed = true;
    throw fromPreviewServer(err, server);
  } finally {
    try { await client.end(); } catch (err) {
      // Preserve the original failure so fallback/cleanup diagnostics remain
      // useful; a close failure on an otherwise successful clone is fatal.
      if (!failed) throw err;
      log.warn('db-manager', 'Clone connection close failed', { dbName, err: err.message });
    }
  }
}

// A statement runner that is ONE database connection for its whole life:
// every statement it is given runs on the same server, in the same session.
// Only withDatabaseConnection makes one, and a wrapper that merely fixes the
// database argument keeps the mark (cloneFromTemplate's `admin`).
const SINGLE_CONNECTION = Symbol('single database connection');
function singleConnection(run) {
  run[SINGLE_CONNECTION] = true;
  return run;
}
const isSingleConnection = (run) => typeof run === 'function' && run[SINGLE_CONNECTION] === true;

async function execInDb(sql, opts = {}) {
  let maintenanceDb;
  try { maintenanceDb = adminDatabase(opts.server); } catch (err) { throw fromPreviewServer(err, opts.server); }
  return execInTarget(maintenanceDb, sql, opts);
}

// Marks an error as having come from the preview database server (or from
// its setting), wherever in a build it surfaced: a clone made there, or the
// clean-up of an old database there while previews are made on the main
// server again. cloneDatabase turns the mark into a platform fault.
function fromPreviewServer(err, server) {
  if (err && typeof err === 'object' && server != null && server !== PRIMARY_SERVER) err.previewDatabaseServer = true;
  return err;
}

// `timeoutMs` lets a statement known to run long (a CREATE DATABASE … TEMPLATE
// copy under load) take longer than the 30-second default, up to two minutes.
// `server` picks the server (the main one unless said). Each call is its own
// psql process and so its own connection: nothing that must share a session
// with another statement goes through here (see withDatabaseConnection).
async function execInTarget(dbName, sql, opts = {}) {
  return onMainServer(opts.server, () => execInTargetNow(dbName, sql, opts));
}

async function execInTargetNow(dbName, sql, opts = {}) {
  if (!SAFE_IDENT.test(dbName)) throw new Error(`execInTarget: unsafe dbName ${JSON.stringify(dbName)}`);
  const args = ['-X', '-v', 'ON_ERROR_STOP=1'];
  if (opts.tuplesOnly) {
    // -A unaligned, -t tuples-only — produces clean newline-separated
    // values with no header/footer, suitable for parsing.
    args.push('-At');
  }
  args.push('-c', sql);

  const timeoutMs = Math.max(30_000, Math.min(120_000, Number(opts.timeoutMs) || 30_000));
  // Inside an app database the session's search_path decides how the
  // platform's own SQL resolves unqualified names — obj_description,
  // pg_relation_size, a `'pg_class'::regclass` constant — and the app
  // controls what a session there can see: it may set database-level
  // settings on its own database, app code running during the data load can
  // set them on the copy too, and it can create same-named functions in
  // public. With `search_path = public, pg_catalog` its shadow functions are
  // found FIRST, so the platform's statements would call app code and the
  // emptiness checks could be fooled by a fake that always answers 0. So
  // every session the platform opens inside an app database pins the
  // search_path to the built-in functions (pg_temp is still searched for
  // temp relations, and never for functions): every name the platform's SQL
  // reaches unqualified is catalog-qualified by nature, so this changes no
  // answer, only who provides it. The maintenance database keeps the
  // platform's own default path — its SQL names its own unqualified tables.
  const env = postgresEnv(dbName, opts.server, opts.as);
  if (dbName !== adminDatabase(opts.server)) env.PGOPTIONS = '-c search_path=pg_catalog';
  let ran;
  try {
    ran = await execFileAsync('psql', args, { timeout: timeoutMs, env });
  } catch (err) {
    throw fromPreviewServer(psqlFailure(err, { sql, timeoutMs }), opts.server);
  }
  const { stdout, stderr } = ran;

  if (stderr && !stderr.includes('NOTICE')) {
    throw new Error(stderr);
  }
  return stdout;
}

const PASSWORD_LITERAL = /\bPASSWORD\s+'(?:[^']|'')*'/gi;
const maskPasswords = (text) => (typeof text === 'string'
  ? text.replace(PASSWORD_LITERAL, 'PASSWORD \'[redacted]\'') : text);

// What a failed psql run says. Node's message is "Command failed: psql
// <args>" and then psql's stderr, which carries Postgres's own error
// ("ERROR: source database … is being accessed by other users"), so that one
// is kept as it is. A run cut off at its time limit has no stderr: its
// message ended at the command, and the before & after shots gallery showed
// exactly that for two copies on 2026-10-09 (a CREATE DATABASE … TEMPLATE
// past its 90 seconds, a DROP DATABASE … WITH (FORCE) past its 30), with
// nothing saying time ran out. Killing psql does not cancel the statement,
// which may still be running on the server. A password in the statement
// (CREATE ROLE … PASSWORD) is masked everywhere the error carries it, its
// stack included: the message reaches logs and the shots failure people read. The error's own
// fields (code, signal, stderr) stay, for db-retry's reading of them.
function psqlFailure(err, { sql, timeoutMs }) {
  if (!err || typeof err !== 'object') return err;
  const timedOut = err.killed === true && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  if (timedOut) {
    const said = typeof err.stderr === 'string' && err.stderr.trim() ? `\n${err.stderr.trim()}` : '';
    err.message = `No answer from Postgres within ${Math.round(timeoutMs / 1000)} seconds, psql's time limit, so `
      + `psql was stopped and the statement may still be running on the server: ${sql}${said}`;
  } else if (!err.code && err.signal) {
    err.message = `psql was stopped by ${err.signal} before Postgres answered: ${sql}`;
  }
  err.message = maskPasswords(err.message);
  for (const field of ['cmd', 'stderr', 'stack']) {
    if (typeof err[field] === 'string') err[field] = maskPasswords(err[field]);
  }
  return err;
}

// Which tables' DATA can be skipped by the clone's pg_dump — i.e. exactly
// the set truncatePrivateTables is going to empty anyway.
//
// It is NOT just the `staging:private` tables. That pass runs
// `TRUNCATE … CASCADE`, so it also empties every table holding a foreign
// key INTO a private table, transitively. Production has three of those:
// pr_votes, pr_undo_votes and maintenance_campaign_apps all FK
// chat_sessions (which is private). Excluding a parent's data without
// excluding the child's would restore rows pointing at nothing, pg_restore
// would report FK violations, and dumpRestore's "errors ignored on
// restore" check would fail EVERY staging build. So the closure is a
// correctness requirement, not an optimisation — hence the recursive CTE
// below, which mirrors CASCADE's own reachability exactly.
//
// Discovery runs against the SOURCE db (the clone has no data yet) and a
// failure is FATAL: not knowing what is private means we can't know what
// is safe to skip, and guessing risks shipping prod rows into a preview.
// Names are re-validated with SAFE_QUALIFIED_IDENT before they reach the
// pg_dump argv, same stance as truncatePrivateTables.
async function privateDataExclusions(sourceDb) {
  if (!SAFE_IDENT.test(sourceDb)) {
    throw new Error(`privateDataExclusions: unsafe identifier ${sourceDb}`);
  }

  const discoverySql = `
WITH RECURSIVE priv AS (
  SELECT c.oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE obj_description(c.oid, 'pg_class') = 'staging:private'
     AND c.relkind = 'r'
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
), closure AS (
  SELECT oid FROM priv
  UNION
  SELECT con.conrelid
    FROM pg_constraint con
    JOIN closure cl ON cl.oid = con.confrelid
   WHERE con.contype = 'f'
     AND con.conrelid <> con.confrelid
)
SELECT n.nspname || '.' || c.relname
  FROM closure cl
  JOIN pg_class c     ON c.oid = cl.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r'
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 1`.trim();

  let stdout;
  try {
    stdout = await execInTarget(sourceDb, discoverySql, { tuplesOnly: true });
  } catch (err) {
    log.error('db-manager', 'staging:private dump-exclusion discovery failed', {
      sourceDb, err: err.message,
    });
    throw new Error(
      `Failed to discover staging:private tables in ${sourceDb}: ${err.message}`
    );
  }

  const names = (stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const safe = [];
  for (const qualified of names) {
    if (!SAFE_QUALIFIED_IDENT.test(qualified)) {
      // Don't splice a non-standard identifier into the dump command.
      // Omitting it is safe: its data is still dumped and the truncate
      // pass still empties it — we only lose the speedup for that table.
      log.warn('db-manager', 'Refusing to exclude non-standard identifier from dump', {
        sourceDb, qualified,
      });
      continue;
    }
    safe.push(qualified);
  }

  log.debug('db-manager', 'Clone dump exclusions resolved', {
    sourceDb, count: safe.length,
  });
  return safe;
}

// The source's extensions that the copy's own role could not create: those
// whose default version on the target server needs a superuser and is not
// trusted. A trusted one (pg_trgm, pgcrypto) the role creates itself during
// the restore and then owns. One the target server does not offer is left
// to the restore, which fails naming it. Resolves [{ name, schema }].
const SAFE_EXTENSION_NAME = /^[a-z0-9_][a-z0-9_-]*$/;
async function extensionsOnlyAnAdminCanCreate(sourceDb, targetServer = PRIMARY_SERVER) {
  // A name this cannot splice safely is left to the restore, like one the
  // target does not offer.
  const installed = String(await execInTarget(sourceDb,
    "SELECT json_build_array(e.extname, n.nspname)::text FROM pg_extension e"
    + " JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY 1",
    { tuplesOnly: true })).split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => JSON.parse(line)).filter(([name]) => SAFE_EXTENSION_NAME.test(name));
  if (installed.length === 0) return [];
  const names = installed.map(([name]) => `'${name}'`).join(', ');
  const adminOnly = new Set(String(await adminExecutor(targetServer)(
    'SELECT v.name FROM pg_available_extension_versions v'
    + ' JOIN pg_available_extensions a ON a.name = v.name AND a.default_version = v.version'
    + ` WHERE v.name IN (${names}) AND v.superuser AND NOT v.trusted`,
    { tuplesOnly: true })).split('\n').map((line) => line.trim()).filter(Boolean));
  const found = installed.filter(([name]) => adminOnly.has(name));
  // A fresh copy has only the public schema. An extension in another schema
  // would need that schema before the restore creates it, so the copy is
  // refused instead, saying why.
  const elsewhere = found.filter(([, schema]) => schema !== 'public');
  if (elsewhere.length > 0) {
    const err = new Error(`dumpRestore: ${elsewhere.map(([name, schema]) => `${name} (in schema ${schema})`).join(', ')}`
      + ' can only be created by an administrator, and only in the public schema of a copy');
    err.appCaused = true;
    throw err;
  }
  return found.map(([name, schema]) => ({ name, schema }));
}

// Logical copy of one database into another via a networked
// pg_dump | pg_restore pipeline. cloneDatabase uses this instead of
// CREATE DATABASE … TEMPLATE so the source can be copied while it is
// actively serving traffic (see the note in cloneDatabase). Both names
// are SAFE_IDENT-validated by the caller; we re-check defensively before
// splicing them into the shell command.
//
// `excludeData` is the qualified-table list whose rows to skip (see
// privateDataExclusions) — schema, constraints and comments still ship.
//
// The dump is always read from the main server, where the live source is.
// `targetServer` is where it is restored: the same server, or the preview
// server, in which case the two processes simply talk to different hosts.
// pg_dump must be at least as new as the server it reads and pg_restore
// reads what that pg_dump wrote, so one client version serves both as long
// as it is not older than either server.
//
// `as` ({ user, password }) authenticates the RESTORE as the copy's own
// unprivileged owner role instead of the administrator. Loading the data
// makes the server evaluate app-defined code — CHECK constraints validated
// after the COPY, STORED generated columns computed on insert, and row and
// event triggers fired by both — as the connected user, and that must not be
// the platform administrator, for the same reason the redaction passes
// authenticate as this role (see redactPrivateData). The copy's own role
// owns the fresh database and every object the restore creates lands with
// it (pg_restore --no-owner attributes everything to the connecting user),
// so nothing needs the administrator's rights. pg_dump's emitted SQL is
// schema-qualified by construction, so the unprivileged session cannot
// redirect it; the dump side stays administrative and reads only.
// pg_dump reads the main server: one operation's turn, pg_restore beside it.
async function dumpRestore(sourceDb, targetDb, excludeData = [], opts = {}) {
  return onMainServer(PRIMARY_SERVER, () => dumpRestoreNow(sourceDb, targetDb, excludeData, opts));
}

async function dumpRestoreNow(sourceDb, targetDb, excludeData = [], { targetServer = PRIMARY_SERVER, as = null } = {}) {
  if (!SAFE_IDENT.test(sourceDb) || !SAFE_IDENT.test(targetDb)) {
    throw new Error(`dumpRestore: unsafe identifiers ${sourceDb}/${targetDb}`);
  }
  for (const qualified of excludeData) {
    if (!SAFE_QUALIFIED_IDENT.test(qualified)) {
      throw new Error(`dumpRestore: unsafe exclude-table-data ${JSON.stringify(qualified)}`);
    }
  }
  if (as && (!as.user || !SAFE_IDENT.test(as.user) || as.password == null)) {
    throw new Error('dumpRestore: the restore role needs a safe name and a password');
  }
  // An extension only a superuser may create (pg_stat_statements, which the
  // database operator installs in every database) would stop the copy's own
  // role at its CREATE EXTENSION. The administrator creates those first, in
  // the copy while it is still empty, so no app-defined object exists yet
  // for the extension's script to meet, and the dump leaves them out.
  const adminExtensions = as ? await extensionsOnlyAnAdminCanCreate(sourceDb, targetServer) : [];
  for (const { name, schema } of adminExtensions) {
    await execInTarget(targetDb, `CREATE EXTENSION IF NOT EXISTS "${name}" WITH SCHEMA "${schema}"`, { server: targetServer });
  }

  // -Fc custom format piped straight into pg_restore (no temp file on
  // disk). --no-owner / --no-privileges: ownership and ACLs are
  // re-established by cloneDatabase's reassign + GRANT/REVOKE passes, so
  // we deliberately don't carry the source's role grants across (they
  // reference the prod-side role). Comments are KEPT — the scrub passes
  // (truncatePrivateTables / scrubPrivateColumns) discover their targets
  // via the 'staging:private' COMMENTs, so --no-comments would silently
  // disable redaction. Both child exit codes are checked so a pg_dump
  // failure cannot be masked by pg_restore's exit code.
  //
  // --exclude-table-data skips the COPY body for a table while still
  // dumping its schema, indexes, constraints, sequences and COMMENTs — so
  // the clone keeps the structure staging needs (and the 'staging:private'
  // comments the scrub passes discover their targets from), it just
  // arrives empty. See privateDataExclusions for how the set is derived
  // and why it must include the FK closure.
  const dumpArgs = [
    '-Fc',
    ...excludeData.map((qualified) => `--exclude-table-data=${qualified}`),
    ...adminExtensions.map(({ name }) => `--exclude-extension=${name}`),
  ];
  const dump = spawn('pg_dump', dumpArgs, {
    env: postgresEnv(sourceDb), stdio: ['ignore', 'pipe', 'pipe'],
  });
  // pg_restore does not infer "restore into a database" from PGDATABASE:
  // without -d/--dbname it expects -f and exits before reading stdin. Keep
  // the explicit target in argv as well as postgresEnv(targetDb), which
  // provides the network credentials — the copy's own owner role when `as`
  // says so, the administrator otherwise.
  const restore = spawn('pg_restore', pgRestoreArgs(targetDb), {
    env: postgresEnv(targetDb, targetServer, as), stdio: ['pipe', 'ignore', 'pipe'],
  });
  dump.stdout.pipe(restore.stdin);
  // --exit-on-error stops pg_restore at its first failed statement while
  // pg_dump may still be writing, and the pipe then fails with EPIPE. That
  // is the restore's failure, reported by the exit codes below; unhandled,
  // the stream's 'error' takes the whole process down. pg_dump, left with
  // nobody reading, is stopped rather than left blocked until the timeout.
  let pipeError = null;
  restore.stdin.on('error', (err) => { pipeError = err; });
  dump.stdout.on('error', (err) => { pipeError = err; });
  restore.once('close', (code) => {
    if (code !== 0 && dump.exitCode === null && dump.signalCode === null) dump.kill('SIGKILL');
  });
  let dumpStderr = '';
  let restoreStderr = '';
  dump.stderr.on('data', (chunk) => { dumpStderr = (dumpStderr + chunk).slice(-64 * 1024); });
  restore.stderr.on('data', (chunk) => { restoreStderr = (restoreStderr + chunk).slice(-64 * 1024); });
  const timer = setTimeout(() => {
    dump.kill('SIGKILL');
    restore.kill('SIGKILL');
  }, DUMP_RESTORE_TIMEOUT_MS);
  const waitChild = (child) => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let dumpResult;
  let restoreResult;
  try {
    [dumpResult, restoreResult] = await Promise.all([waitChild(dump), waitChild(restore)]);
  } finally {
    clearTimeout(timer);
  }
  const stderr = `${dumpStderr}\n${restoreStderr}`.trim();
  if (dumpResult.code !== 0 || restoreResult.code !== 0) {
    throw new Error(
      `dumpRestore ${sourceDb} → ${targetDb} failed ` +
      `(pg_dump=${dumpResult.code ?? dumpResult.signal}, pg_restore=${restoreResult.code ?? restoreResult.signal}): ` +
      stderr.slice(0, 2000)
    );
  }
  if (pipeError) {
    throw new Error(`dumpRestore ${sourceDb} → ${targetDb}: the pipe between pg_dump and pg_restore failed: ${pipeError.message}`);
  }

  // pg_restore continues past per-object errors by default and prints a
  // tally at the end ("errors ignored on restore: N"). Treat any such
  // tally as fatal: a partially-populated clone would boot staging with
  // missing schema/rows, which is worse than failing the build loudly.
  const ignored = /errors ignored on restore:\s*(\d+)/i.exec(stderr || '');
  if (ignored && Number(ignored[1]) > 0) {
    throw new Error(
      `dumpRestore ${sourceDb} → ${targetDb}: pg_restore reported ${ignored[1]} ` +
      `error(s). stderr: ${stderr.slice(0, 2000)}`
    );
  }
  if (stderr && stderr.trim()) {
    log.debug('db-manager', 'pg_dump|pg_restore stderr (non-fatal)', {
      sourceDb, targetDb, stderr: stderr.slice(0, 2000),
    });
  }
}

function pgRestoreArgs(targetDb) {
  if (!SAFE_IDENT.test(targetDb)) {
    throw new Error(`pgRestoreArgs: unsafe database name ${JSON.stringify(targetDb)}`);
  }
  return ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', targetDb];
}

// ── Shared staging:private emptiness logic ───────────────────────────────
// The TRUNCATE pass (truncatePrivateTables) proves the private tables empty
// right after emptying them; the re-check after the column pass
// (verifyPrivateTablesEmpty) proves it again. Both use the SAME discovery
// query and the SAME size-then-read proof, kept here once so the two cannot
// drift. Only the TRUNCATE itself lives in the pass.
const PRIVATE_TABLES_DISCOVERY_SQL = `
WITH RECURSIVE private(name, rel) AS (
  SELECT n.nspname || '.' || c.relname, c.oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE obj_description(c.oid, 'pg_class') = 'staging:private'
     AND c.relkind = 'r'
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
), tree(name, rel) AS (
  SELECT name, rel FROM private
  UNION SELECT tree.name, i.inhrelid FROM pg_inherits i JOIN tree ON i.inhparent = tree.rel
)
SELECT name FROM private
UNION ALL
SELECT DISTINCT 'FOREIGN ' || json_build_array(tree.name, n.nspname || '.' || c.relname)::text
  FROM tree
  JOIN pg_class c ON c.oid = tree.rel
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'f'
 ORDER BY 1`.trim();

function refuseForeignCopy(targetDb, pairs) {
  log.error('db-manager', 'staging:private table with a foreign-table descendant; copy refused', {
    targetDb, foreign: pairs,
  });
  const err = new Error(
    `Refusing to empty the staging:private tables in ${targetDb}: ` +
    pairs.map(([parent, child]) => `${parent} has the foreign-table descendant ${child}`).join('; ') +
    '. Its rows are on another server: they can neither be emptied from a copy safely nor shown to be empty.'
  );
  err.noFallback = true;
  return err;
}

// Split the discovery answer into the [private table] names and the
// [private, foreign] descendant pairs; an unreadable pair is still a foreign
// descendant, shown as it came.
function parsePrivateDiscovery(stdout) {
  const lines = (stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const foreignPair = (text) => {
    try {
      const pair = JSON.parse(text);
      if (Array.isArray(pair) && pair.length === 2) return pair.map(String);
    } catch { /* shown raw below */ }
    return ['?', text];
  };
  const foreign = lines.filter((line) => line.startsWith('FOREIGN '))
    .map((line) => foreignPair(line.slice('FOREIGN '.length)));
  const qualifiedNames = lines.filter((line) => !line.startsWith('FOREIGN '));
  return { foreign, qualifiedNames };
}

// Each statement as few parts as fit under the psql argument ceiling
// (MAX_SCRUB_STATEMENT_BYTES): psql takes a statement as one command-line
// argument, which Linux caps at 128 KiB (spawn E2BIG).
function chunkedStatements(items, render, join, wrap) {
  const statements = [];
  let parts = [];
  for (const item of items) {
    const part = render(item);
    if (parts.length > 0 && Buffer.byteLength(wrap(parts.concat(part).join(join))) > MAX_SCRUB_STATEMENT_BYTES) {
      statements.push(wrap(parts.join(join)));
      parts = [];
    }
    parts.push(part);
  }
  if (parts.length > 0) statements.push(wrap(parts.join(join)));
  return statements;
}

// Names were validated by the caller, so they splice as text too.
function privateSizeSqls(safe) {
  return chunkedStatements(safe, (t) => `('${t}', '${t}'::regclass)`, ', ', (values) =>
    `WITH RECURSIVE targets(name, rel) AS (VALUES ${values}), tree(name, rel) AS (SELECT name, rel FROM targets`
    + ' UNION SELECT tree.name, i.inhrelid::regclass FROM pg_inherits i JOIN tree ON i.inhparent = tree.rel)'
    + " SELECT DISTINCT json_build_array(tree.name, c.oid::bigint, c.relkind, n.nspname || '.' || c.relname)::text FROM tree"
    + ' JOIN pg_class c ON c.oid = tree.rel JOIN pg_namespace n ON n.oid = c.relnamespace'
    + ' LEFT JOIN pg_am am ON am.oid = c.relam'
    + " WHERE c.relkind <> 'r' OR am.amname IS DISTINCT FROM 'heap'"
    + ' OR pg_relation_size(tree.rel) IS DISTINCT FROM 0 ORDER BY 1');
}

// The staging:private tables (by name, in `safe`) that still hold a row:
// proven by a zero-length heap file for the common case, and for any
// "suspect" (pages present, a non-heap access method, a partitioned table) a
// read with row_security off, so a refill hidden by row-level security raises
// rather than passing. Throws (noFallback) on a foreign descendant surfaced
// now or a line that cannot be read — the per-table TRUNCATE must not reach
// either. `safe` is the validated list of private table names; `sizeSqls`
// comes from privateSizeSqls(safe).
async function listPrivateTablesHoldingRows(targetDb, safe, sizeSqls, execute) {
  const unconfirmed = (err) => new Error(
    `Could not confirm the staging:private tables in ${targetDb} are empty: ${err.message}`);
  const suspects = [];
  const foreignNow = [];
  for (const sql of sizeSqls) {
    let out;
    try {
      out = await execute(targetDb, sql, { tuplesOnly: true });
    } catch (err) { throw unconfirmed(err); }
    for (const line of String(out || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      let row = null;
      try { row = JSON.parse(line); } catch { /* below */ }
      const [name, oid, relkind, display] = Array.isArray(row) ? row : [];
      // Classified before anything else is checked: a foreign table is
      // refused whatever its name.
      if (relkind === 'f') { foreignNow.push([String(name), String(display)]); continue; }
      if (!Array.isArray(row) || row.length !== 4 || !safe.includes(name)
          || !Number.isSafeInteger(oid) || oid <= 0 || typeof relkind !== 'string' || !/^[a-z]$/.test(relkind)) {
        const err = unconfirmed(new Error(`a relation under a staging:private table cannot be checked: ${JSON.stringify(line)}`));
        err.noFallback = true;
        throw err;
      }
      suspects.push({ name, oid, display: String(display) });
    }
  }
  if (foreignNow.length > 0) throw refuseForeignCopy(targetDb, foreignNow);
  if (suspects.length === 0) return [];
  // The marker is assembled by format(), so the statement's own text, which
  // a psql failure echoes, never contains it.
  const readSqls = chunkedStatements(suspects,
    ({ name, oid }) => `EXECUTE format('SELECT EXISTS (SELECT 1 FROM ONLY %s)', ${oid}::oid::regclass) INTO present; `
      + `IF present AND NOT '${name}' = ANY (found) THEN found := found || '${name}'::text; END IF; `,
    '',
    (body) => 'DO $staging_check$ DECLARE found text[] := \'{}\'; present boolean; BEGIN SET LOCAL row_security = off; '
      + body
      + "IF cardinality(found) > 0 THEN RAISE EXCEPTION '%', format('staging:private %s: %s;', 'rows remain in', array_to_string(found, ', ')); END IF; END $staging_check$");
  const holding = new Set();
  for (const sql of readSqls) {
    try {
      await execute(targetDb, sql);
    } catch (err) {
      const m = /staging:private rows remain in: ([a-z0-9_., ]+);/i.exec(String(err.message || ''));
      const names = m ? m[1].split(', ').filter((n) => safe.includes(n)) : [];
      if (names.length === 0) throw unconfirmed(err);
      names.forEach((n) => holding.add(n));
    }
  }
  return [...holding];
}

// ── Running the redaction without the platform's database rights ─────────
//
// The copy's redaction (the TRUNCATE and UPDATE passes) used to run over the
// administrative connection. On the preview server that administrator is a
// SUPERUSER, and a TRUNCATE or UPDATE makes the server evaluate app-defined
// code attached to the table — triggers (statement- and row-level, and those
// a CASCADE reaches), CHECK and domain functions, generated-column and index
// expressions, RLS policy expressions, rules — AS THE SESSION USER. An app
// author controls that code through the app's own schema, so it ran with the
// administrator's rights over every app's preview copies.
//
// So the redaction now runs over a connection AUTHENTICATED AS the copy's own
// owner role, which every path already creates as an ordinary LOGIN role with
// a generated password and no attributes (not SUPERUSER, not CREATEROLE, not
// CREATEDB) and no rights outside this one database. Authenticating as it is
// the boundary: SET ROLE / SET SESSION AUTHORIZATION do not hold, because a
// superuser session can RESET them; only the session's real identity cannot
// be shed, and here it is the unprivileged role. If a private table FORCEs
// row-level security, it then applies to the owner too, and the fail-closed
// checks above refuse the copy rather than leak.
//
// Belt and braces, and to keep "every private table is empty in every copy
// handed out" true even when a trigger would refill one: user triggers are
// switched OFF on the affected tables for the duration and put back exactly
// as they were, so the preview behaves as production does.

// Switch user triggers off on every regular table the passes touch — each
// staging:private table, its inheritance descendants, and each table with a
// staging:private column — capturing each trigger's prior state so it can be
// restored precisely (ENABLE loses ALWAYS/REPLICA). FK/RI internal triggers
// are left alone, so CASCADE still works. Returns { restore }. `execute` is
// the owner-authenticated runner, which owns these tables after the reassign
// pass and so may disable their triggers.
const REDACTION_TABLE_OIDS_SQL = `
WITH RECURSIVE roots(rel) AS (
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND (obj_description(c.oid, 'pg_class') = 'staging:private'
          OR EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                        AND col_description(a.attrelid, a.attnum) = 'staging:private'))
), tree(rel) AS (
  SELECT rel FROM roots
  UNION SELECT i.inhrelid FROM pg_inherits i JOIN tree ON i.inhparent = tree.rel
)
SELECT DISTINCT c.oid::bigint FROM tree JOIN pg_class c ON c.oid = tree.rel
 WHERE c.relkind = 'r' ORDER BY 1`.trim();

async function captureAndDisableUserTriggers(targetDb, execute) {
  let out;
  try {
    out = await execute(targetDb, REDACTION_TABLE_OIDS_SQL, { tuplesOnly: true });
  } catch (err) {
    throw new Error(`Could not list the tables to clean in ${targetDb}: ${err.message}`);
  }
  const oids = String(out || '').split('\n').map((s) => s.trim()).filter(Boolean)
    .map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (oids.length === 0) return { restore: async () => {} };
  const arr = `ARRAY[${oids.join(',')}]::oid[]`;
  let stateOut;
  try {
    stateOut = await execute(targetDb,
      `SELECT json_build_array(tgrelid::bigint, tgname, tgenabled)::text FROM pg_trigger`
      + ` WHERE NOT tgisinternal AND tgenabled <> 'D' AND tgrelid = ANY(${arr}) ORDER BY tgrelid, tgname`,
      { tuplesOnly: true });
  } catch (err) {
    throw new Error(`Could not read trigger state in ${targetDb}: ${err.message}`);
  }
  const prior = [];
  for (const line of String(stateOut || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
    let row = null;
    try { row = JSON.parse(line); } catch { /* below */ }
    if (!Array.isArray(row) || row.length !== 3 || !Number.isSafeInteger(Number(row[0]))
        || typeof row[1] !== 'string' || !/^[OAR]$/.test(String(row[2]))) {
      throw new Error(`Unreadable trigger state in ${targetDb}: ${JSON.stringify(line)}`);
    }
    prior.push({ oid: Number(row[0]), name: String(row[1]), state: String(row[2]) });
  }
  // Switch every user trigger off, by oid, in one statement. format(%I)
  // quotes each (arbitrary) trigger name; the table is named by oid::regclass.
  await execute(targetDb,
    `DO $sv_trig_off$ DECLARE r oid; BEGIN FOR r IN SELECT unnest(${arr}) LOOP`
    + ` EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', r::regclass); END LOOP; END $sv_trig_off$`);
  const restore = async () => {
    if (prior.length === 0) return;
    // Put each trigger back to its exact prior state: ENABLE keeps O,
    // ENABLE ALWAYS keeps A, ENABLE REPLICA keeps R. Names go through
    // format(%I); the keyword is from the validated single letter.
    const rows = chunkedStatements(prior,
      (p) => `(${p.oid},'${p.name.replace(/'/g, "''")}','${p.state === 'A' ? 'ENABLE ALWAYS'
        : p.state === 'R' ? 'ENABLE REPLICA' : 'ENABLE'}')`,
      ', ',
      (values) => `DO $sv_trig_on$ DECLARE r record; BEGIN FOR r IN SELECT * FROM (VALUES ${values})`
        + ' AS v(rel, nm, kw) LOOP'
        + " EXECUTE format('ALTER TABLE %s %s TRIGGER %I', r.rel::oid::regclass, r.kw, r.nm); END LOOP; END $sv_trig_on$");
    for (const sql of rows) await execute(targetDb, sql);
  };
  return { restore };
}

// The whole redaction of a copy, over an owner-authenticated `execute`: user
// triggers off, the two passes, the after-the-column-pass re-check, and the
// triggers put back (always, even on failure — a copy or template must never
// be left with its triggers disabled). `onProgress` names the two passes for
// the clone-progress surface.
async function redactPrivateData(targetDb, execute, { onProgress = null } = {}) {
  const { restore } = await captureAndDisableUserTriggers(targetDb, execute);
  let bodyErr = null;
  try {
    onProgress?.('truncate_private');
    await truncatePrivateTables(targetDb, execute);
    onProgress?.('scrub_private');
    await scrubPrivateColumns(targetDb, execute);
    // The column pass runs UPDATEs, which can fire a trigger that writes a
    // private value into a private table (an audit row of the old value). The
    // TRUNCATE pass proved the private tables empty; prove it again here,
    // after the UPDATEs. With user triggers off above this is defence in
    // depth, and it is one round trip when nothing refilled.
    const refilled = await verifyPrivateTablesEmpty(targetDb, execute);
    if (refilled.length > 0) {
      const err = new Error(
        `staging:private table(s) refilled during the column pass in ${targetDb}: ${refilled.join(', ')}`);
      err.noFallback = true;
      throw err;
    }
  } catch (err) {
    bodyErr = err;
  }
  try {
    await restore();
  } catch (restoreErr) {
    if (bodyErr) {
      log.error('db-manager', 'Could not re-enable user triggers after a failed redaction', {
        targetDb, err: restoreErr.message,
      });
    } else {
      bodyErr = restoreErr;
    }
  }
  if (bodyErr) throw bodyErr;
}

// The re-check after the column pass: re-discover the staging:private tables
// (refusing a foreign descendant) and prove they still hold no row. Returns
// the names that do (empty in the normal case); throws when emptiness cannot
// be proven.
async function verifyPrivateTablesEmpty(targetDb, execute) {
  let stdout;
  try {
    stdout = await execute(targetDb, PRIVATE_TABLES_DISCOVERY_SQL, { tuplesOnly: true });
  } catch (err) {
    throw new Error(`Failed to re-check staging:private tables in ${targetDb}: ${err.message}`);
  }
  const { foreign, qualifiedNames } = parsePrivateDiscovery(stdout);
  if (foreign.length > 0) throw refuseForeignCopy(targetDb, foreign);
  const safe = qualifiedNames.filter((n) => SAFE_QUALIFIED_IDENT.test(n));
  if (safe.length === 0) return [];
  return listPrivateTablesHoldingRows(targetDb, safe, privateSizeSqls(safe), execute);
}

async function truncatePrivateTables(targetDb, execute = execInTarget) {
  // Discovery query. obj_description on pg_class returns the comment
  // attached via `COMMENT ON TABLE foo IS '...'`. relkind='r' filters
  // to ordinary tables (not views/indexes/sequences). We exclude
  // pg_catalog/information_schema defensively even though they
  // shouldn't have user comments.
  //
  // The same query also lists every foreign table among their inheritance
  // descendants, as `FOREIGN ["<private table>", "<foreign table>"]`: JSON,
  // so no name, however odd, breaks the line or hides the prefix.
  // TRUNCATE without ONLY reaches those children,
  // and for postgres_fdw it sends TRUNCATE to the remote server, which in a
  // copy is the same server the live app's definition names. Nor can their
  // emptiness be shown from here: another user mapping, or a policy on the
  // remote side, may see rows ours does not. So a private table with a
  // foreign descendant refuses the copy before any TRUNCATE is sent.
  const discoverySql = PRIVATE_TABLES_DISCOVERY_SQL;

  let stdout;
  try {
    stdout = await execute(targetDb, discoverySql, { tuplesOnly: true });
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

  const { foreign, qualifiedNames } = parsePrivateDiscovery(stdout);
  if (foreign.length > 0) throw refuseForeignCopy(targetDb, foreign);

  if (qualifiedNames.length === 0) {
    log.info('db-manager', 'No staging:private tables to truncate', { targetDb });
    return { truncated: [] };
  }

  log.info('db-manager', 'Truncating staging:private tables', {
    targetDb, count: qualifiedNames.length, tables: qualifiedNames,
  });

  // Failures are collected rather than short-circuiting so we don't
  // leave half the private tables full because one failed. After the
  // pass, if anything failed, throw — a partial truncate is still a
  // leaky clone.
  const failures = [];
  const safe = [];
  for (const qualified of qualifiedNames) {
    if (!SAFE_QUALIFIED_IDENT.test(qualified)) {
      log.warn('db-manager', 'Refusing to TRUNCATE non-standard identifier', {
        targetDb, qualified,
      });
      failures.push({ table: qualified, error: 'unsafe identifier' });
      continue;
    }
    safe.push(qualified);
  }

  // All of them in ONE statement, so one round trip and one transaction.
  // One statement per table (191 for the platform's own database) paid a
  // network round trip per table — a psql process per table on the
  // template build — and a WAL flush per table: a TRUNCATE drops relation
  // files, and Postgres flushes WAL at the commit of any transaction that
  // does, whatever synchronous_commit says. One statement also truncates
  // each relation once, where the per-table form re-truncates whatever
  // several tables' CASCADE reaches.
  // Do NOT replace this with the per-table statements inside BEGIN/COMMIT:
  // re-truncating a relation already truncated in the same transaction
  // flushes WAL every time, which measured slower than autocommit.
  //
  // When the statement fails with an error from the server, it rolled back
  // and every table is as it was; the fallback then runs one statement per
  // table, in autocommit, to empty all that can be emptied and to name each
  // table that cannot. A client-side timeout says nothing about the outcome:
  // the statement may have committed or may still be running. On the one
  // connection a clone uses, the runner then refuses every later statement,
  // so the fallback and the check below fail and the pass throws (the
  // caller may then try the direct copy). Through psql, the process is
  // killed at its deadline but the server may still be working, and the
  // fallback's statements can wait behind it.
  //
  // AFTER TRUNCATE triggers fire once the whole statement has emptied every
  // table in it, so a trigger on one private table that writes into another
  // would refill it after the fact. Hence the check: one query that names
  // every private table still holding a row. Rows found after the single
  // statement send the pass to the per-table form; rows found after that
  // fail the pass, and the copy is not handed out.
  //
  // The check runs in two steps, so the usual case costs one query:
  //   1. File sizes. For every private table and every inheritance child
  //      (TRUNCATE without ONLY empties those too), a plain heap table whose
  //      file is zero bytes long holds no row: TRUNCATE leaves a zero-length
  //      file, and any row written afterwards takes a page. A size reads the
  //      same for every role, so row-level security cannot hide anything
  //      here. Every other relation is a suspect: a heap with pages, which
  //      may hold only dead rows, and anything not a plain heap (another
  //      access method, a partitioned table; a foreign table was refused
  //      before any TRUNCATE), whose local file size says nothing about its
  //      rows.
  //   2. Only when there are suspects: their rows are read, in one DO block
  //      with row_security off for that transaction. With it off, a read
  //      that a policy would filter raises an error instead, so a refill
  //      hidden by row-level security fails the check rather than passing
  //      it, and so does a suspect that cannot be read (no privilege, a
  //      relation gone). The block raises, naming the private
  //      tables whose suspects hold rows; it returns nothing when none do.
  // After the single statement, anything but proof of emptiness sends the
  // pass table by table; after that pass, it fails the pass. Two findings
  // never go to the per-table pass, whose TRUNCATE would reach whatever the
  // check could not vouch for: a foreign table (a TRUNCATE trigger can create
  // one after discovery), and a line of the check's answer that cannot be
  // read. Both refuse the copy at once.
  // Step 1 answers in JSON, one array per relation: the private table, the
  // relation's oid, its relkind, and its name for messages. No catalog name
  // is ever put into SQL: step 2 reads each relation by oid, through
  // format('%s', oid::regclass), which quotes it.
  //
  // psql takes a statement as one argument, which Linux caps at 128 KiB
  // (spawn E2BIG, before the database sees anything). The single statement
  // is skipped above MAX_SCRUB_STATEMENT_BYTES, the same ceiling the column
  // pass uses, and both check queries are split under it.
  const truncated = [];
  const perTable = async () => {
    truncated.length = 0;
    for (const qualified of safe) {
      try {
        await execute(targetDb, `TRUNCATE ${qualified} RESTART IDENTITY CASCADE`);
        truncated.push(qualified);
      } catch (err) {
        log.error('db-manager', 'TRUNCATE failed', {
          targetDb, table: qualified, err: err.message,
        });
        failures.push({ table: qualified, error: err.message });
      }
    }
  };
  const sizeSqls = privateSizeSqls(safe);
  const stillHoldingRows = () => listPrivateTablesHoldingRows(targetDb, safe, sizeSqls, execute);
  if (safe.length > 0) {
    let batched = false;
    const oneStatement = `TRUNCATE ${safe.join(', ')} RESTART IDENTITY CASCADE`;
    if (Buffer.byteLength(oneStatement) > MAX_SCRUB_STATEMENT_BYTES) {
      log.warn('db-manager', 'Too many staging:private tables for one statement; truncating table by table', {
        targetDb, count: safe.length, bytes: Buffer.byteLength(oneStatement),
      });
    } else {
      try {
        await execute(targetDb, oneStatement);
        batched = true;
      } catch (batchErr) {
        log.warn('db-manager', 'One-statement TRUNCATE failed; truncating table by table', {
          targetDb, count: safe.length, err: batchErr.message,
        });
      }
    }
    let refilled = [];
    if (batched) {
      // Anything short of proof that every table is empty, an unreadable
      // suspect included, sends the pass table by table, as before this
      // check existed; after that pass the check has the last word.
      try {
        refilled = await stillHoldingRows();
      } catch (err) {
        if (err.noFallback) throw err;
        refilled = [`(${err.message})`];
      }
      if (refilled.length === 0) truncated.push(...safe);
      else {
        log.warn('db-manager', 'Rows came back after the one-statement TRUNCATE, or could not be ruled out; truncating table by table', {
          targetDb, tables: refilled,
        });
      }
    }
    if (!batched || refilled.length > 0) {
      const failedBefore = failures.length;
      await perTable();
      if (failures.length === failedBefore) {
        for (const table of await stillHoldingRows()) {
          failures.push({ table, error: 'still holds rows after TRUNCATE' });
        }
      }
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

async function scrubPrivateColumns(targetDb, execute = execInTarget) {
  // Discovery query mirrors truncatePrivateTables but at the column
  // level. col_description is the column-comment counterpart of
  // obj_description. attnum > 0 filters out system columns; attisdropped
  // skips logically-removed columns that pg keeps as zombies. The
  // information_schema.columns join adds character_maximum_length so we
  // can size the per-row placeholder to fit (e.g. VARCHAR(64)).
  // row_security_active says whether row-level security applies to this
  // session's role on the table: then an UPDATE, and any check after it,
  // would see only the rows a policy lets through. Output is pipe-separated:
  // <schema.table>|<column>|<not_null t/f>|<max_length or empty>|<rls t/f>.
  const discoverySql = `
SELECT n.nspname || '.' || c.relname,
       a.attname,
       a.attnotnull,
       COALESCE(ic.character_maximum_length::text, ''),
       row_security_active(c.oid)
  FROM pg_attribute a
  JOIN pg_class    c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN information_schema.columns ic
    ON ic.table_schema = n.nspname
   AND ic.table_name = c.relname
   AND ic.column_name = a.attname
 WHERE col_description(a.attrelid, a.attnum) = 'staging:private'
   AND c.relkind = 'r'
   AND a.attnum > 0
   AND NOT a.attisdropped
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 1, 2`.trim();

  let stdout;
  try {
    stdout = await execute(targetDb, discoverySql, { tuplesOnly: true });
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
      // psql -At with the default field separator '|'. Five fields;
      // the third and fifth are exactly 't' or 'f' from a bool column, the
      // fourth is a character_maximum_length integer or '' when unbounded
      // (e.g. TEXT).
      const [qualified, column, notNullRaw, maxLengthRaw, rlsRaw] = line.split('|');
      const maxLength = maxLengthRaw ? Number(maxLengthRaw) : null;
      return { qualified, column, notNull: notNullRaw === 't', maxLength, rlsRaw };
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

  // Every column is checked first; a column that fails a check is never put
  // into SQL, and it still fails the pass after the others are scrubbed.
  const failures = [];
  const columns = [];
  for (const { qualified, column, notNull, maxLength, rlsRaw } of targets) {
    const target = `${qualified}.${column}`;
    if (!SAFE_QUALIFIED_IDENT.test(qualified) || !SAFE_IDENT.test(column)) {
      log.warn('db-manager', 'Refusing to UPDATE non-standard identifier', {
        targetDb, qualified, column,
      });
      failures.push({ target, error: 'unsafe identifier', schema: true });
      continue;
    }
    if (rlsRaw !== 'f') {
      // Row-level security would hide rows from the UPDATE and from every
      // check after it, so the column cannot be shown to be scrubbed. Fail
      // closed (an unreadable flag too) and leave the column out of SQL.
      log.error('db-manager', 'staging:private column is behind row-level security', {
        targetDb, qualified, column, rls: rlsRaw,
      });
      failures.push({
        target,
        error: rlsRaw === 't'
          ? 'row-level security applies to this role, so rows could be hidden from the scrub'
          : `unreadable row-level security flag ${JSON.stringify(rlsRaw)}`,
        schema: true,
      });
      continue;
    }
    if (!notNull) {
      columns.push({ qualified, column, target, placeholder: null });
      continue;
    }
    if (maxLength != null && (!Number.isInteger(maxLength) || maxLength < 1)) {
      // Unexpected metadata shape — fail closed rather than guess at a
      // placeholder that might not fit the column.
      log.error('db-manager', 'staging:private column has unusable max length', {
        targetDb, qualified, column, maxLength,
      });
      failures.push({ target, error: `unusable max length ${maxLength}`, schema: true });
      continue;
    }
    // A template is scrubbed when built and again on each clone. Its
    // existing placeholders contain the rows' OLD ctids; a later UPDATE
    // can assign one of those values to a different row and hit a UNIQUE
    // constraint. Give every scrub a fresh namespace, check that it is
    // absent from the source column, and append the row's current ctid.
    // Do not truncate the ctid: that would make multiple rows equal.
    const compact = maxLength != null
      && maxLength < STAGING_REDACTED_SENTINEL.length + 16 + 1 + MAX_CTID_TEXT_LENGTH;
    const marker = compact ? '~' : STAGING_REDACTED_SENTINEL;
    const nonceBytes = compact ? 4 : 8;
    if (maxLength != null && maxLength < marker.length + nonceBytes * 2 + 1 + MAX_CTID_TEXT_LENGTH) {
      failures.push({ target, error: `max length ${maxLength} cannot hold unique redaction values` });
      continue;
    }
    columns.push({ qualified, column, target, placeholder: { marker, nonceBytes } });
  }

  let scrubbed = [];
  if (columns.length > 0) {
    // All of them in ONE statement first: one round trip instead of one or
    // two per column. Through psql (template build, direct copy) that is
    // one process instead of one per statement.
    const oneStatement = scrubInOneStatementSql(columns.map((c) => ({
      ...c, prefix: c.placeholder ? newRedactionPrefix(c.placeholder) : null,
    })));
    let batchError = null;
    let tooLong = false;
    if (Buffer.byteLength(oneStatement) > MAX_SCRUB_STATEMENT_BYTES) {
      // Hundreds of columns: psql takes the statement as one argument, which
      // Linux caps at 128 KiB, so it is never sent; column by column instead.
      tooLong = true;
      log.warn('db-manager', 'Too many staging:private columns for one statement; scrubbing column by column', {
        targetDb, count: columns.length, bytes: Buffer.byteLength(oneStatement),
      });
    } else {
      try {
        await execute(targetDb, oneStatement);
        scrubbed = columns.map((c) => c.target);
      } catch (err) {
        batchError = err;
      }
    }
    if (batchError && !databaseAnsweredWithError(batchError)) {
      // No answer, a lost connection, or psql stopped at its deadline: the
      // statement may have committed, failed or still be running. Nothing
      // more is sent, because the column-by-column pass could wait behind it
      // or, on the clone's single connection, is refused anyway. The copy is
      // not handed out.
      log.error('db-manager', 'One-statement column scrub got no answer from the database', {
        targetDb, count: columns.length, err: briefError(batchError),
      });
      throw new Error(
        `Failed to scrub staging:private columns in ${targetDb}: no answer to the one-statement scrub of ` +
        `${columns.length} column(s), so whether it changed anything is unknown; ` +
        `the column-by-column pass was not tried: ${briefError(batchError)}`
      );
    }
    if (batchError || tooLong) {
      // The database refused the statement, so it rolled back and changed
      // nothing (or it was never sent). Today's column-by-column pass then
      // scrubs every column it can and names each one it cannot; a check
      // afterwards names any column a trigger or rule left unscrubbed. Each
      // statement commits on its own, so deferred triggers have run by then.
      if (batchError) {
        log.warn('db-manager', 'One-statement column scrub failed; scrubbing column by column', {
          targetDb, count: columns.length, err: briefError(batchError),
        });
      }
      const byColumn = await scrubColumnByColumn(targetDb, columns, execute);
      failures.push(...byColumn.failures);
      scrubbed = byColumn.scrubbed;
      if (byColumn.failures.length === 0) {
        const done = columns.filter((c) => scrubbed.includes(c.target))
          .map((c) => ({ ...c, prefix: byColumn.prefixes.get(c.target) || null }));
        try {
          for (const { target, rowSecurity } of await columnsNotScrubbed(targetDb, done, execute)) {
            failures.push({
              target,
              error: rowSecurity
                ? 'row-level security applies to this role now, so rows could have been hidden from the scrub'
                : 'still holds a value after its UPDATE',
            });
          }
        } catch (err) {
          failures.push({ target: 'the check after the column-by-column pass', error: err.message });
        }
      }
    }
  }

  if (failures.length > 0) {
    const err = new Error(
      `Failed to scrub ${failures.length} staging:private column(s) in ${targetDb}: ` +
      failures.map((f) => `${f.target} (${f.error})`).join('; ')
    );
    // Every column refused for what the app's own schema says (row-level
    // security, a name or a size the scrub cannot use): the app's to fix.
    if (failures.every((f) => f.schema)) err.appCaused = true;
    throw err;
  }

  return { scrubbed };
}

// A fresh placeholder namespace: the marker, a random nonce, and ':'. The
// row's ctid follows it, so every value in one scrub is distinct, and the
// namespace is checked to be absent from the column before it is used.
function newRedactionPrefix({ marker, nonceBytes }) {
  return `${marker}${crypto.randomBytes(nonceBytes).toString('hex')}:`;
}

// What a column holds once scrubbed: NULL, or its placeholder namespace.
// Names were validated and prefixes are [~_a-z0-9:], so both splice as text.
// IS DISTINCT FROM NULL, not IS NOT NULL: for a composite value IS NOT NULL
// asks whether every field is non-null, so ROW('secret', NULL) would pass.
function unscrubbedRowSql({ column, prefix }) {
  return prefix
    ? `left(${column}::text, ${prefix.length}) IS DISTINCT FROM '${prefix}'`
    : `${column} IS DISTINCT FROM NULL`;
}

// Above this the one statement is not sent, and the check after the
// column-by-column pass is split into queries below it: psql receives a
// statement as one command-line argument, and Linux refuses an argument over
// 128 KiB (spawn E2BIG) before the database sees anything. About 400
// columns fit.
const MAX_SCRUB_STATEMENT_BYTES = 96 * 1024;

// The whole column pass as one statement. A DO block runs as one statement,
// so it commits or rolls back as a whole, and an error inside it reaches the
// caller as the database's error. In order:
//   1. each NOT NULL column's new namespace must be absent from the column;
//   2. one UPDATE per table, setting all of that table's private columns;
//   3. each column must now hold only NULL or its namespace.
// Step 3 is there because one UPDATE per table is not the same as one per
// column: a BEFORE UPDATE trigger or a rule sees every column change at once,
// and could, for instance, copy an old private value into another private
// column that a later per-column UPDATE would have cleared. Any of the three
// raises, the block rolls back, and the caller scrubs column by column.
// Two settings make step 3 see what will be committed:
//   - SET CONSTRAINTS ALL IMMEDIATE: a DEFERRABLE INITIALLY DEFERRED
//     constraint trigger would otherwise fire at commit, after step 3, and
//     could write a private value back. Set first, so such triggers run at
//     the end of each UPDATE, and again before step 3 in case one of them
//     deferred anything again.
//   - SET LOCAL row_security = off: a query that row-level security would
//     filter raises instead of silently skipping rows. Discovery already
//     refuses tables where it applies; this keeps the block fail-closed too.
function scrubInOneStatementSql(columns) {
  const reserve = columns.filter((c) => c.prefix).map((c) =>
    `  IF EXISTS (SELECT 1 FROM ${c.qualified} WHERE left(${c.column}::text, ${c.prefix.length}) = '${c.prefix}') THEN\n` +
    `    RAISE EXCEPTION 'staging:private scrub: placeholder namespace is taken in %', '${c.target}';\n` +
    '  END IF;');
  const tables = new Map();
  for (const c of columns) {
    if (!tables.has(c.qualified)) tables.set(c.qualified, []);
    tables.get(c.qualified).push(`${c.column} = ${c.prefix ? `'${c.prefix}' || ctid::text` : 'NULL'}`);
  }
  const updates = [...tables].map(([qualified, sets]) => `  UPDATE ${qualified} SET ${sets.join(', ')};`);
  const verify = columns.map((c) =>
    `  IF EXISTS (SELECT 1 FROM ${c.qualified} WHERE ${unscrubbedRowSql(c)}) THEN\n` +
    `    RAISE EXCEPTION 'staging:private scrub: % still holds a value after its UPDATE', '${c.target}';\n` +
    '  END IF;');
  return ['DO $staging_scrub$', 'BEGIN',
    '  SET LOCAL row_security = off;', '  SET CONSTRAINTS ALL IMMEDIATE;',
    ...reserve, ...updates,
    '  SET CONSTRAINTS ALL IMMEDIATE;',
    ...verify, 'END', '$staging_scrub$'].join('\n');
}

// The one statement is long (a few kB for the platform's own database), and
// psql's failure repeats it in full. Log and report what the database said
// (psql's stderr), or the start of the message.
function briefError(err) {
  const said = err && typeof err.stderr === 'string' ? err.stderr.trim() : '';
  return (said || String(err && err.message || err)).slice(0, 500);
}

// True only when the database answered the statement with an ERROR: it ran,
// failed and rolled back, so running the column-by-column pass next is safe.
// node-postgres carries the server's severity and SQLSTATE; psql exits with
// status 1 and prints the server's ERROR. A FATAL (the session ended), a
// client-side timeout, a lost connection, psql stopped at its deadline or
// exiting 2: none of those says what happened to the statement.
function databaseAnsweredWithError(err) {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.severity === 'string') {
    return err.severity === 'ERROR' && /^[0-9A-Z]{5}$/.test(String(err.code || ''));
  }
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  return err.code === 1 && err.killed !== true && !err.signal && /(^|\n)ERROR: {2}/.test(stderr);
}

// Today's pass, one column at a time: reserve a namespace for a NOT NULL
// column (one probe, up to five), then UPDATE it. Used only when the
// one-statement scrub was refused by the database; it names each column it
// cannot scrub and goes on with the others.
async function scrubColumnByColumn(targetDb, columns, execute) {
  const failures = [];
  const scrubbed = [];
  const prefixes = new Map();
  for (const { qualified, column, target, placeholder } of columns) {
    let value = 'NULL';
    if (placeholder) {
      let prefix = null;
      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const candidate = newRedactionPrefix(placeholder);
          const occupied = await execute(targetDb,
            `SELECT EXISTS (SELECT 1 FROM ${qualified} WHERE left(${column}::text, ${candidate.length}) = '${candidate}')`,
            { tuplesOnly: true });
          if (String(occupied).trim() !== 'f') continue;
          prefix = candidate;
          break;
        }
      } catch (err) {
        failures.push({ target, error: err.message });
        continue;
      }
      if (!prefix) {
        failures.push({ target, error: 'could not reserve a unique redaction namespace' });
        continue;
      }
      prefixes.set(target, prefix);
      value = `'${prefix}' || ctid::text`;
    }
    try {
      await execute(targetDb, `UPDATE ${qualified} SET ${column} = ${value}`);
      scrubbed.push(target);
    } catch (err) {
      log.error('db-manager', 'staging:private column UPDATE failed', {
        targetDb, qualified, column, err: err.message,
      });
      failures.push({ target, error: err.message });
    }
  }
  return { failures, scrubbed, prefixes };
}

// One query naming every column that still holds something other than NULL
// or its placeholder namespace (step 3 of the one-statement scrub, for the
// column-by-column pass). It also names any column whose table row-level
// security now applies to: discovery's flag is from before the pass, and a
// trigger fired by one of its UPDATEs can turn row-level security on, after
// which this role's UPDATEs and this very check see only some rows. The
// flag is read in the same query, so it is current when the pass ends. If the query itself fails, the caller counts that
// as a failure: nothing is confirmed.
async function columnsNotScrubbed(targetDb, columns, execute) {
  // As few queries as fit under MAX_SCRUB_STATEMENT_BYTES (one for any
  // ordinary schema).
  const queries = [];
  let parts = [];
  let bytes = 0;
  for (const c of columns) {
    const rls = `row_security_active('${c.qualified}'::regclass)`;
    const part = `SELECT '${c.target}', ${rls} WHERE ${rls} OR EXISTS (SELECT 1 FROM ${c.qualified} WHERE ${unscrubbedRowSql(c)})`;
    if (parts.length > 0 && bytes + part.length + 11 > MAX_SCRUB_STATEMENT_BYTES) {
      queries.push(parts.join(' UNION ALL '));
      parts = [];
      bytes = 0;
    }
    parts.push(part);
    bytes += part.length + 11;
  }
  if (parts.length > 0) queries.push(parts.join(' UNION ALL '));
  const found = [];
  for (const sql of queries) {
    const out = await execute(targetDb, sql, { tuplesOnly: true });
    for (const line of String(out || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
      const [target, rowSecurity] = line.split('|');
      found.push({ target, rowSecurity: rowSecurity === 't' });
    }
  }
  return found;
}

// ─── Per-app database storage cap (#2253) ───────────────────────────────
//
// Uploaded files have had a per-app ceiling since app-files.js grew
// PER_APP_CAP; each app's own Postgres database had none, and a single app
// writing rows in a loop could fill the volume every production app and
// the platform itself share. services/app-storage-cap.js owns the policy
// (the cap, the warning line, the freeze/thaw hysteresis); these are the
// only Postgres-touching halves of it, kept here beside the naming scheme
// and the SAFE_IDENT guard they depend on.
//
// Measurement is one catalog query, run as the admin user against the
// platform's own database: pg_database_size() reads the data directory
// and needs no connection to the app's database. Staging clones and
// staging templates come back too, since they share the `app_` prefix,
// and the sweep is what excludes them (isStagingCloneDb /
// isStagingTemplateDb), so a preview never counts against the app it was
// cloned from.
const APP_DB_SIZES_SQL =
  "SELECT datname, pg_database_size(datname) FROM pg_database "
  + "WHERE datname LIKE 'app\\_%' AND NOT datistemplate";

// `-At` output is one `datname|bytes` line per database. Anything that is
// not exactly that shape (a NOTICE that leaked onto stdout, a blank line, a
// name SAFE_IDENT would refuse to act on) is dropped rather than turned
// into a NaN measurement, because a bad row here becomes a freeze decision.
function parseDatabaseSizes(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|');
    if (parts.length !== 2) continue;
    const [dbName, raw] = parts;
    if (!SAFE_IDENT.test(dbName) || !/^\d+$/.test(raw)) continue;
    const bytes = Number(raw);
    if (!Number.isSafeInteger(bytes)) continue;
    out.push({ dbName, bytes });
  }
  return out;
}

async function listAppDatabaseSizes({ execute = execInDb } = {}) {
  const stdout = await execute(APP_DB_SIZES_SQL, { tuplesOnly: true });
  return parseDatabaseSizes(stdout);
}

// app_<slug>_stgtmpl — the redacted copy ensureStagingTemplate keeps warm.
function isStagingTemplateDb(name) {
  const value = String(name || '');
  return value.length > STAGING_TEMPLATE_SUFFIX.length && value.endsWith(STAGING_TEMPLATE_SUFFIX);
}

// Freeze or thaw one app's database by flipping its OWNER ROLE's default
// transaction mode. Every connection the app opens authenticates as that
// role (connectionUrl above), so `default_transaction_read_only = on`
// makes each of its transactions read-only from the first statement:
// SELECTs keep working, an INSERT/UPDATE/DELETE fails with "cannot execute
// ... in a read-only transaction". The setting is a role DEFAULT, which a
// session only picks up when it connects, hence the terminate that
// follows: pooled connections the app is holding open would otherwise keep
// writing until they happened to reconnect. The app's pool reconnects on
// its own; a request in flight at that instant sees one failed query,
// which the freeze was going to fail anyway.
//
// A default, not a privilege: app code that explicitly runs `SET
// default_transaction_read_only = off` gets its writes back. That is the
// deliberate trade. This is a fair-use ceiling that stops a runaway app
// from filling the shared volume, not a security boundary, and a
// REVOKE-based freeze would have to walk every table the app creates in
// both directions. The admin console shows who is frozen, and an app that
// went out of its way to override the setting would be visible there.
//
// The name is validated twice on purpose: SAFE_IDENT, as everywhere else in
// this module, and lowercase, because the role was created unquoted (see
// createDatabase) and so was folded to lowercase by the server. Quoting it
// here keeps the statement exact; quoting a mixed-case name would address a
// role that does not exist.
async function setAppDatabaseWritable(dbName, writable, { execute = execInDb } = {}) {
  if (!SAFE_IDENT.test(dbName) || dbName !== dbName.toLowerCase()) {
    throw new Error(`setAppDatabaseWritable: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  const role = ownerRoleName(dbName);
  const quoted = `"${role}"`;
  await execute(writable
    ? `ALTER ROLE ${quoted} RESET default_transaction_read_only`
    : `ALTER ROLE ${quoted} SET default_transaction_read_only = on`);
  await execute(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity '
    + `WHERE usename = '${role}' AND pid <> pg_backend_pid()`
  );
  log.info('db-manager', writable ? 'App database writes restored' : 'App database frozen read-only', {
    dbName, role,
  });
  return { dbName, role, writable: !!writable };
}

// Whether an app database's owner role already carries the read-only
// default setAppDatabaseWritable(…, false) gives it: the storage sweep holds
// a freeze by checking this first, since setting it again also ends every
// connection the app has open.
async function isAppDatabaseReadOnly(dbName, { execute = execInDb } = {}) {
  if (!SAFE_IDENT.test(dbName) || dbName !== dbName.toLowerCase()) {
    throw new Error(`isAppDatabaseReadOnly: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  const role = ownerRoleName(dbName);
  const out = await execute(
    'SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole '
    + `WHERE r.rolname = '${role}' AND s.setdatabase = 0 `
    + "AND 'default_transaction_read_only=on' = ANY (s.setconfig)",
    { tuplesOnly: true });
  return String(out || '').trim() === '1';
}

// ─── Looking at the preview server from the sweeps ──────────────────────
//
// The reap, pressure and heal passes read `pg_database` and
// `pg_stat_activity` through the platform's pool, which is the main server.
// These give them the same reads on the preview server. Each opens one
// short connection and closes it: nothing here is on a request path, and a
// pooled administrative session on a server that may be wiped at any time
// is one more thing to go stale.

// A pool-shaped reader (`query(sql, params)` resolving `{ rows }`) for the
// preview server's maintenance database, for code written against the
// platform pool (db/connection-census.js).
function previewServerQueryable() {
  return {
    async query(sql, params) {
      const url = adminConnection(PREVIEW_SERVER);
      url.pathname = `/${adminDatabase(PREVIEW_SERVER)}`;
      const client = new Client({
        ...pgClientConfig(url, PREVIEW_SERVER),
        connectionTimeoutMillis: 10_000,
        statement_timeout: 30_000,
        query_timeout: 30_000,
        application_name: 'social-preview-census',
      });
      client.on('error', () => {});
      await client.connect();
      try { return await client.query(sql, params); } finally { await client.end().catch(() => {}); }
    },
  };
}

// Every `%_staging_%` database on the preview server and the databases that
// have a client connected, in the shape the orphan sweep reads off the main
// server. Throws when the server cannot be read: a failed listing is not an
// empty one.
async function listPreviewServerStagingDatabases() {
  const reader = previewServerQueryable();
  const dbs = await reader.query("SELECT datname FROM pg_database WHERE datname LIKE '%\\_staging\\_%'");
  const connected = await reader.query(
    `SELECT DISTINCT datname FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND datname IS NOT NULL`
  );
  return {
    dbNames: dbs.rows.map((row) => row.datname),
    connectedDbNames: new Set(connected.rows.map((row) => row.datname)),
  };
}

async function previewServerDatabaseHasSessions(dbName) {
  if (!SAFE_IDENT.test(String(dbName || ''))) throw new Error('previewServerDatabaseHasSessions: unsafe database name');
  const { rows } = await previewServerQueryable().query(
    'SELECT 1 FROM pg_stat_activity WHERE datname = $1 LIMIT 1', [dbName]
  );
  return rows.length > 0;
}

// Every `app_…` database name on a server, kept for a minute: the heal pass
// asks about each preview in turn.
const PREVIEW_NAMES_TTL_MS = 60 * 1000;
const _serverDbNames = new Map();

async function appDatabaseNames(server, { fresh = false } = {}) {
  const key = serverKey(server);
  const cached = _serverDbNames.get(key);
  if (!fresh && cached && (Date.now() - cached.at) < PREVIEW_NAMES_TTL_MS) return cached.ids;
  const out = await adminExecutor(key)(
    "SELECT datname FROM pg_database WHERE datname LIKE 'app\\_%'", { tuplesOnly: true }
  );
  const ids = new Set(String(out || '').split('\n').map((line) => line.trim()).filter(Boolean).map(databaseIdentity));
  _serverDbNames.set(key, { at: Date.now(), ids });
  return ids;
}

// ─── Which database a running preview uses ──────────────────────────────
//
// A session can have several clones at once: each commit's build makes its
// own, on whichever server previews were being made on that day, and the
// orphan sweep keeps every clone of a session that has a live preview. So
// "is there a database with this session's id somewhere" says nothing about
// the one the running container is connected to: an old clone on the main
// server would vouch for a current one that was wiped.
//
// The preview's runtime therefore carries two labels, written when it is
// deployed: an identity of the database it was given and the server that
// database was made on. They are written only while a preview server is
// configured, so a one-server install deploys exactly what it always did,
// and a preview built before the setting existed has none (it is on the
// main server, and nothing is asked about it).
//
// The identity is not the name. Postgres keeps 63 bytes of an identifier
// (NAMEDATALEN) and quietly drops the rest, at CREATE, at connect and at
// DROP alike, on 17 and on 18: a 50-character slug asks for a 75-character
// clone name and gets its first 63. A label holds 63 characters at most on
// Kubernetes and must end in a letter or digit, which a cut-off name need
// not. So the label is a short digest of the name AS POSTGRES STORES IT,
// and the check digests each name in `pg_database` the same way.
const LABEL_PREVIEW_DB = 'usernode.db.id';
const LABEL_PREVIEW_DB_SERVER = 'usernode.db.server';
const POSTGRES_NAME_BYTES = 63;

function storedDatabaseName(dbName) {
  return Buffer.from(String(dbName || ''), 'utf8').subarray(0, POSTGRES_NAME_BYTES).toString('utf8');
}

function databaseIdentity(dbName) {
  return crypto.createHash('sha256').update(storedDatabaseName(dbName)).digest('hex').slice(0, 32);
}

function previewDatabaseLabels(dbName, server) {
  if (!previewServerConfigured() || !isStagingCloneDb(dbName)) return {};
  return { [LABEL_PREVIEW_DB]: databaseIdentity(dbName), [LABEL_PREVIEW_DB_SERVER]: serverKey(server) };
}

// The server a runtime's labels say its database is on, or null when it
// carries none this module wrote.
function previewDatabaseServerOf(labels) {
  const labelled = labels?.[LABEL_PREVIEW_DB_SERVER];
  if (labelled !== PRIMARY_SERVER && labelled !== PREVIEW_SERVER) return null;
  return /^[0-9a-f]{32}$/.test(String(labels?.[LABEL_PREVIEW_DB] || '')) ? labelled : null;
}

// Does this running preview need rebuilding because of WHERE its database
// is? Asked with the runtime's labels. Two cases, both only possible with a
// preview database server:
//
//   'gone'      The database it was given is no longer on the server it was
//               made on. The preview server is disposable: it can be wiped
//               and come back empty while preview containers built against
//               it keep running, each answering errors for every page that
//               reads its database. Nothing else about such a container says
//               so (it is running, and its environment is current).
//   'draining'  The preview server is being drained (STAGING_DB_SERVER_DRAIN)
//               and this preview's database is on it. A rebuild makes it on
//               the main server, so the preview server empties without
//               anyone's preview breaking when it is finally removed.
//
// The heal and recheck paths ask here (staging-recovery.stagingNeedsRebuild)
// and rebuild, which rebuilds the template where previews are now made and
// copies again. Null means no: also without a preview server (nothing is
// asked and nothing changes), for a runtime without the labels, and whenever
// the server could not be read. "There" is believed for up to a minute, so a
// wipe is noticed at once or up to a minute late; "gone" is always read
// again first.
async function previewDatabaseVerdict(labels) {
  if (!previewServerConfigured()) return null;
  const labelled = previewDatabaseServerOf(labels);
  if (!labelled) return null;
  const id = labels[LABEL_PREVIEW_DB];
  try {
    if (!(await appDatabaseNames(labelled)).has(id)
      && !(await appDatabaseNames(labelled, { fresh: true })).has(id)) return 'gone';
  } catch (err) {
    log.warn('db-manager', 'Could not tell whether a preview database is still there', {
      server: labelled, err: err.message,
    });
    return null;
  }
  return labelled === PREVIEW_SERVER && previewServerDraining() ? 'draining' : null;
}

// What still depends on the preview server, for an operator deciding whether
// it can be removed: the databases a before & after shots run is using there
// (two clones and their frozen source, dropped when the run ends). Previews
// are counted by their runtimes' labels, by the caller. Throws when the
// server cannot be read.
async function previewServerShotsDatabases() {
  const out = await adminExecutor(PREVIEW_SERVER)(
    "SELECT datname FROM pg_database WHERE datname LIKE 'app\\_%'", { tuplesOnly: true }
  );
  return String(out || '').split('\n').map((line) => line.trim())
    .filter((name) => isShotsCloneDb(name) || isPreparedCloneSource(name));
}

// Staging templates left on a server that no longer makes previews, for apps
// that have not built since the switch (a build retires its own app's:
// retireTemplateElsewhere). Run from the reap sweep. Each is dropped under
// its source's template lock, so a platform process that has not yet picked
// up the setting cannot be mid-copy from it. Never throws.
async function retireStrayTemplates({ limit = 50 } = {}) {
  const summary = { examined: 0, dropped: 0, failed: 0 };
  if (!previewServerConfigured() || await previewServerIsMainServer()) return summary;
  const keepOn = previewCreateServer();
  for (const other of previewSideServers()) {
    if (other === keepOn) continue;
    let names;
    try {
      const out = await adminExecutor(other)(
        "SELECT datname FROM pg_database WHERE datname LIKE 'app\\_%\\_stgtmpl' OR datname LIKE 'app\\_%\\_stgtmpl\\_next'",
        { tuplesOnly: true }
      );
      names = String(out || '').split('\n').map((line) => line.trim()).filter((name) => isDisposableDb(name));
    } catch (err) {
      log.warn('db-manager', 'Could not list staging templates on the other server', { server: other, err: err.message });
      summary.failed++;
      continue;
    }
    const sources = [...new Set(names.map((name) => name.replace(/_stgtmpl(?:_next)?$/, '')))];
    summary.examined += sources.length;
    for (const sourceDb of sources.slice(0, limit)) {
      try {
        await withTemplateLock(sourceDb, async () => {
          // The setting may have changed while this waited for the lock.
          if (previewCreateServer() !== keepOn) return;
          await retireTemplateElsewhere(sourceDb, keepOn);
        });
        summary.dropped++;
      } catch (err) {
        summary.failed++;
        log.warn('db-manager', 'Could not retire a stray staging template', { sourceDb, server: other, err: err.message });
      }
    }
  }
  return summary;
}

module.exports = {
  MAIN_SERVER_OPERATIONS,
  _mainOperations: mainOperations,
  _onMainServer: onMainServer,
  shrinkForDrain,
  appDbName,
  stagingDbName,
  shotsDbName,
  legacyShotsDbName,
  ownerRoleName,
  createDatabase,
  dropDatabase,
  cloneDatabase,
  connectionUrl,
  // Per-preview connection ceiling (#1771).
  stagingConnectionLimit,
  isStagingCloneDb,
  isShotsCloneDb,
  applyStagingConnectionLimit,
  applyAppConnectionLimit,
  appConnectionLimit,
  platformDatabaseName,
  // Disposable shots and staging-template databases.
  isDisposableDb,
  terminateDisposableSessions,
  dropDisposableDatabase,
  createFromTemplate,
  DEFAULT_STAGING_DB_CONNECTION_LIMIT,
  adoptExistingDatabase,
  ensureRoleExists,
  databaseExists,
  roleExists,
  truncatePrivateTables,
  scrubPrivateColumns,
  redactPrivateData,
  verifyPrivateTablesEmpty,
  privateDataExclusions,
  pgRestoreArgs,
  dumpRestore,
  // Staging templates.
  stagingTemplateDbName,
  stagingTemplatesEnabled,
  ensureStagingTemplate,
  refreshStagingTemplate,
  cloneFromTemplate,
  preparedCloneSourceName,
  isPreparedCloneSource,
  prepareStagingCloneSource,
  cloneFromPreparedSource,
  releasePreparedCloneSource,
  readTemplateRefreshedAt,
  queueTemplateRefresh,
  STAGING_TEMPLATE_MAX_AGE_MS,
  STAGING_TEMPLATE_HARD_MAX_AGE_MS,
  _templateIdleForTest: templateIdle,
  _psqlFailureForTest: psqlFailure,
  // Per-app database storage cap (#2253).
  parseDatabaseSizes,
  listAppDatabaseSizes,
  setAppDatabaseWritable,
  isAppDatabaseReadOnly,
  isStagingTemplateDb,
  // A second server for preview databases (STAGING_DB_ADMIN_URL).
  PRIMARY_SERVER,
  PREVIEW_SERVER,
  previewServerConfigured,
  previewServerDraining,
  previewCreateServer,
  previewSideServers,
  isPreviewSideDb,
  previewServerQueryable,
  listPreviewServerStagingDatabases,
  previewServerDatabaseHasSessions,
  previewDatabaseVerdict,
  previewDatabaseLabels,
  previewDatabaseServerOf,
  databaseIdentity,
  previewServerShotsDatabases,
  LABEL_PREVIEW_DB,
  LABEL_PREVIEW_DB_SERVER,
  retireStrayTemplates,
  dropStagingTemplates,
  // What a preview-side child process is started with (tests run the real
  // psql with it).
  _childEnvForTest: postgresEnv,
  _resetPreviewServerStateForTest() {
    _mainIdentifier.at = 0;
    _mainIdentifier.value = '';
    _fileCloneNotes.clear();
    _serverDbNames.clear();
    _sameServerWarned = false;
    _instanceCheck.at = 0;
    _instanceCheck.same = true;
  },
};
