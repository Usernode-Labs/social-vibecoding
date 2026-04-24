const { execFile } = require('child_process');
const { promisify } = require('util');
const log = require('./logger');

const execFileAsync = promisify(execFile);

const DB_CONTAINER = process.env.DB_CONTAINER || 'project-usernode-db';
const DB_USER = process.env.DB_USER || 'usernode';

function appDbName(slug) {
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}`;
}

function stagingDbName(slug, username, commitHash) {
  const shortHash = commitHash.substring(0, 6);
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_${username.replace(/[^a-z0-9_]/g, '_')}_${shortHash}`;
}

async function createDatabase(dbName) {
  log.info('db-manager', 'Creating database', { dbName });
  try {
    await execInDb(`CREATE DATABASE ${dbName}`);
    log.info('db-manager', 'Database created', { dbName });
  } catch (err) {
    if (err.message?.includes('already exists')) {
      log.info('db-manager', 'Database already exists', { dbName });
      return;
    }
    throw err;
  }
}

async function dropDatabase(dbName) {
  log.info('db-manager', 'Dropping database', { dbName });
  try {
    await execInDb(`DROP DATABASE IF EXISTS ${dbName}`);
    log.info('db-manager', 'Database dropped', { dbName });
  } catch (err) {
    log.warn('db-manager', 'Failed to drop database', { dbName, err: err.message });
  }
}

async function cloneDatabase(sourceDb, targetDb) {
  log.info('db-manager', 'Cloning database', { sourceDb, targetDb });

  await dropDatabase(targetDb);

  // Terminate active connections to source
  await execInDb(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${sourceDb}' AND pid <> pg_backend_pid()`
  ).catch(() => {});

  await execInDb(`CREATE DATABASE ${targetDb} TEMPLATE ${sourceDb}`);
  log.info('db-manager', 'Database cloned', { sourceDb, targetDb });
}

async function connectionUrl(dbName) {
  const password = process.env.USERNODE_DB_PASSWORD || 'localdev';
  return `postgres://${DB_USER}:${password}@${DB_CONTAINER}:5432/${dbName}`;
}

async function execInDb(sql) {
  const { stdout, stderr } = await execFileAsync('docker', [
    'exec', DB_CONTAINER,
    'psql', '-U', DB_USER, '-d', 'usernode', '-c', sql,
  ], { timeout: 30000 });

  if (stderr && !stderr.includes('NOTICE')) {
    throw new Error(stderr);
  }
  return stdout;
}

module.exports = {
  appDbName,
  stagingDbName,
  createDatabase,
  dropDatabase,
  cloneDatabase,
  connectionUrl,
};
