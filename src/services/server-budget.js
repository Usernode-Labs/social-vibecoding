'use strict';

// The main PostgreSQL server's side of the connection budget (item 4:
// workflow-foundation design-item4-connections.md, Q3): the platform and the
// child apps cannot starve each other.
//
//   - The server reserves a block of connections (reserved_connections, set
//     with the server in infra) that ordinary roles cannot take. The
//     platform's user is the chart's administrative user, a superuser, which
//     PostgreSQL never holds to the reserve: in effect the reserve caps the
//     apps' share, and the chart holds the platform's own pools inside it
//     (postgresql.platformConnections).
//   - Each production app's database is capped (db-manager
//     applyAppConnectionLimit). New apps get the cap when their database is
//     made; this caps those made before, and any left uncapped since.
//
// The migration Job runs it on every release, with its administrative
// connection, before any Pod of the release starts. Idempotent: a database
// already capped is left as it is, and one given a limit of its own by hand
// keeps it. The release never fails over it (scripts/migrate-kubernetes.js).

const log = require('./logger');

// `admin`: a connected pg Client on the administrative URL. `pool`: the
// platform's pool (it reads which databases are apps').
async function ensureServerBudget(config, { admin, pool }) {
  const dbManager = require('./db-manager');
  const out = { capped: [] };
  const limit = dbManager.appConnectionLimit();
  if (limit < 0) return out;
  const { rows: apps } = await pool.query('SELECT slug FROM apps WHERE NOT self_hosted');
  const { rows: uncapped } = await admin.query(
    'SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) AND datconnlimit = -1 AND datname <> $2 ORDER BY datname',
    [apps.map((a) => dbManager.appDbName(a.slug)), dbManager.platformDatabaseName(config.databaseUrl) || '']);
  for (const { datname } of uncapped) {
    const applied = await dbManager.applyAppConnectionLimit(datname, { execute: (sql) => admin.query(sql) });
    if (applied != null) out.capped.push(datname);
  }
  if (out.capped.length) log.info('server-budget', 'App databases capped', { limit, count: out.capped.length });
  return out;
}

module.exports = { ensureServerBudget };
