'use strict';

// The main PostgreSQL server's side of the connection budget (item 4:
// workflow-foundation design-item4-connections.md, Q3): the platform and the
// child apps cannot starve each other.
//
//   - The server reserves a block of connections (reserved_connections, set
//     with the server in infra) that only roles in pg_use_reserved_connections
//     may take. The platform's user is granted it here, so the apps, however
//     many, never take the platform's last connections. The chart holds the
//     platform's own pools inside that block (postgresql.platformConnections).
//     The grant has to exist before the reserve does: a reserve the
//     platform's user may not use would leave it only the apps' share.
//   - Each production app's database is capped (db-manager
//     applyAppConnectionLimit). New apps get the cap when their database is
//     made; this caps those made before, and any left uncapped since.
//
// The migration Job runs it on every release, with its administrative
// connection, before any Pod of the release starts. Idempotent: a role
// already granted and a database already capped are left as they are, and a
// database given a limit of its own by hand keeps it. Best-effort: a server
// without the role (before PostgreSQL 16) or an administrator who may not
// grant it is logged, and the release goes on.

const log = require('./logger');

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;

function userOf(databaseUrl) {
  try { return decodeURIComponent(new URL(databaseUrl).username) || null; } catch { return null; }
}

// `admin`: a connected pg Client on the administrative URL. `pool`: the
// platform's pool (it reads which databases are apps').
async function ensureServerBudget(config, { admin, pool }) {
  const dbManager = require('./db-manager');
  const out = { granted: false, capped: [] };
  const user = userOf(config.databaseUrl);

  const { rows: [role] } = await admin.query(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pg_use_reserved_connections') AS exists,
            EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND pg_has_role($1, 'pg_use_reserved_connections', 'MEMBER') AS member`,
    [user || '']).catch((err) => { log.warn('server-budget', 'Could not read the reserved-connections role', { err: err.message }); return { rows: [{}] }; });
  if (!role.exists) {
    log.warn('server-budget', 'The server has no pg_use_reserved_connections role (PostgreSQL 16 and later): the platform has no reserve');
  } else if (!user || !SAFE_IDENT.test(user)) {
    log.warn('server-budget', 'The platform\'s database user cannot be named; not granted the reserve', { user });
  } else if (!role.member) {
    try {
      await admin.query(`GRANT pg_use_reserved_connections TO ${user}`);
      out.granted = true;
      log.info('server-budget', 'The platform\'s user may take the server\'s reserved connections', { user });
    } catch (err) {
      log.warn('server-budget', 'Could not grant the platform\'s user the reserved connections', { user, err: err.message });
    }
  }

  const limit = dbManager.appConnectionLimit();
  if (limit < 0) return out;
  const { rows: apps } = await pool.query('SELECT db_name FROM apps WHERE NOT self_hosted AND db_name IS NOT NULL');
  const { rows: uncapped } = await admin.query(
    'SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) AND datconnlimit = -1 AND datname <> $2 ORDER BY datname',
    [apps.map((a) => a.db_name), dbManager.platformDatabaseName(config.databaseUrl) || '']);
  for (const { datname } of uncapped) {
    const applied = await dbManager.applyAppConnectionLimit(datname, { execute: (sql) => admin.query(sql) });
    if (applied != null) out.capped.push(datname);
  }
  if (out.capped.length) log.info('server-budget', 'App databases capped', { limit, count: out.capped.length });
  return out;
}

module.exports = { ensureServerBudget };
