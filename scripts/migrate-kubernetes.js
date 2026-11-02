'use strict';

require('dotenv').config();

const { Client } = require('pg');
const { load: loadConfig } = require('../src/config');
const { migrate } = require('../src/db/migrate');
const { getPool } = require('../src/db/pool');
const { connectionName } = require('../src/db/connection-options');

function databaseName(connectionString) {
  const name = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database name in DATABASE_URL: ${JSON.stringify(name)}`);
  }
  return name;
}

async function ensureTargetDatabase(config) {
  if (require('../src/services/database-role-access').enabled()) {
    await require('../src/services/database-role-access').assertLogin(getPool(config), 'migrator');
    return; // The bootstrap job creates/owns the platform database first.
  }
  const adminUrl = process.env.DB_ADMIN_URL;
  if (!adminUrl) throw new Error('DB_ADMIN_URL is required for the Kubernetes migration Job');

  const target = databaseName(config.databaseUrl);
  const client = new Client({ connectionString: adminUrl, application_name: connectionName('admin') });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
    if (existing.rowCount === 0) {
      // PostgreSQL does not accept a bind parameter for an identifier. The
      // strict allow-list above makes this interpolation safe and predictable.
      await client.query(`CREATE DATABASE "${target}"`);
    }
  } finally {
    await client.end();
  }
}

// The server's side of the connection budget (services/server-budget.js):
// every app's database is capped. It never fails the release.
async function ensureServerBudget(config, pool) {
  const client = new Client({ connectionString: process.env.DB_ADMIN_URL, application_name: connectionName('admin') });
  try {
    await client.connect();
    if (require('../src/services/database-role-access').enabled()) {
      await require('../src/services/database-role-access').assertLogin(client, 'provisioner');
      await client.query('SELECT public.homeroom_adopt_app_roles()');
    }
    const out = await require('../src/services/server-budget').ensureServerBudget(config, { admin: client, pool });
    console.log('[migration] connection budget', JSON.stringify({ capped: out.capped.length }));
  } catch (error) {
    console.error('[migration] connection budget not ensured', error.message);
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const config = loadConfig();
  const pool = getPool(config);
  try {
    const grants = require('../src/services/database-role-grants');
    await ensureTargetDatabase(config);
    // Web's writes on the workflow kernel's tables go only once no web
    // process of a build that needs them serves: wait for that before
    // changing anything, so a release refused for it leaves the running one
    // as it was.
    await grants.awaitWebRestrictionReady(pool);
    await migrate(config);
    // One transaction, after the schema web's withdrawals use is in place: no
    // login sees a grant half made, and web's writes go last.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await grants.ensureRuntimeGrants(client);
      await grants.takeWebWorkflowWrites(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    // The read-only database roles, by the new build over the new schema,
    // before any Pod of the release starts (services/db-roles.js).
    await require('../src/services/db-roles').ensureRoles(config);
    await ensureServerBudget(config, pool);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[migration] failed', error);
    process.exitCode = 1;
  });
}

module.exports = { databaseName, ensureTargetDatabase, ensureServerBudget, main };
