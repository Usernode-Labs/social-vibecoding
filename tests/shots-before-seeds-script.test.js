'use strict';

// scripts/shots-before-seeds.js writes a change's own staging seeds into the
// pair's BEFORE copy. Before it opens a connection it must refuse any
// database that is not this run's base shots database, and refuse to run
// outside staging: the only data it may touch is the run's two disposable
// copies.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const dbManager = require('../src/services/db-manager');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'shots-before-seeds.js');
const SLUG = 'usernode-2d5619';
const RUN_ID = 'a'.repeat(32);

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function postgresUrl(dbName) {
  return `postgres://fixture:secret@db.example.test:5432/${dbName}`;
}

test('the runner refuses a database that is not the run\'s base shots database', () => {
  const headDb = dbManager.shotsDbName(SLUG, RUN_ID, 'head');
  const result = run({
    USERNODE_ENV: 'staging',
    DATABASE_URL: postgresUrl(headDb),
    SHOTS_SEED_SLUG: SLUG,
    SHOTS_SEED_RUN_ID: RUN_ID,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /base shots database/);
});

test('the runner refuses to run outside staging', () => {
  const baseDb = dbManager.shotsDbName(SLUG, RUN_ID, 'base');
  const result = run({
    USERNODE_ENV: 'production',
    DATABASE_URL: postgresUrl(baseDb),
    SHOTS_SEED_SLUG: SLUG,
    SHOTS_SEED_RUN_ID: RUN_ID,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only runs in staging/);
});

test('the runner accepts this run\'s base shots database', async () => {
  const baseDb = dbManager.shotsDbName(SLUG, RUN_ID, 'base');
  // It may fail to connect, but it must get past the guards and start
  // listening rather than refuse; stop it once it has had time to.
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      USERNODE_ENV: 'staging',
      DATABASE_URL: postgresUrl(baseDb),
      SHOTS_SEED_SLUG: SLUG,
      SHOTS_SEED_RUN_ID: RUN_ID,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 800));
  child.kill('SIGKILL');
  await closed;
  assert.doesNotMatch(stderr, /base shots database|only runs in staging/);
});
