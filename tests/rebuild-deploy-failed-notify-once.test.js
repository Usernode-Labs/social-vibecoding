// staging.rebuildProduction records every failed attempt on apps.last_failure
// but notifies the app's creator and admins (#1374, the app_health
// "deploy_failed" notification) once per INCIDENT: a new notification when
// the commit that fails, or the stage it fails at, is not what the previous
// record already said. The drift poller retries a failing rebuild on every
// tick, and a commit the build sandbox cannot build fails identically each
// time; twenty-five "Deploy failed" pushes went out for one falling-sands
// commit in a night before this.
//
// Functional, against the real rebuildProduction with its collaborators
// stubbed: clone succeeds, rev-parse reports the sha we choose, and the
// manifest read throws to stand in for the build failing. The pool stub
// keeps a real apps.last_failure value so the read-before-write in the
// UPDATE ... RETURNING is exercised as the code sees it.
//
// Run with: node --test tests/rebuild-deploy-failed-notify-once.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  pool: require.resolve('../src/db/pool'),
  docker: require.resolve('../src/services/docker'),
  github: require.resolve('../src/services/github'),
  appManifest: require.resolve('../src/services/app-manifest'),
  notifications: require.resolve('../src/services/notifications'),
  caddy: require.resolve('../src/services/caddy'),
  dbManager: require.resolve('../src/services/db-manager'),
  applicationRuntime: require.resolve('../src/services/application-runtime'),
  appSecrets: require.resolve('../src/services/app-secrets'),
  appLlmEnv: require.resolve('../src/services/app-llm-env'),
  appStorageEnv: require.resolve('../src/services/app-storage-env'),
  appIdentityEnv: require.resolve('../src/services/app-identity-env'),
  stagingEnv: require.resolve('../src/services/staging-env'),
  events: require.resolve('../src/services/events'),
  buildRetentionGuard: require.resolve('../src/services/build-retention-guard'),
};

const logged = [];
stub(ids.logger, {
  info: (...a) => logged.push(['info', ...a]),
  warn: (...a) => logged.push(['warn', ...a]),
  error: (...a) => logged.push(['error', ...a]),
  debug: (...a) => logged.push(['debug', ...a]),
});

let headSha = null;
stub(ids.docker, {
  execFileAsync: async (cmd, args) => {
    if (cmd === 'git' && args.includes('rev-parse')) return { stdout: `${headSha}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  },
});
stub(ids.github, { getCloneUrl: async () => 'https://github.com/example/falling-sands.git' });

let buildError = null;
stub(ids.appManifest, {
  read: () => { throw buildError; },
  MAX_APP_NAME_LENGTH: 64,
});

const notified = [];
const pushed = [];
stub(ids.notifications, {
  createAppHealthNotification: async (pool, args) => {
    notified.push(args);
    return [{ id: notified.length, kind: 'app_health', detail: args.detail }];
  },
  hydrateAndPush: async (pool, row) => { pushed.push(row); },
});

stub(ids.caddy, {});
stub(ids.dbManager, {});
stub(ids.applicationRuntime, {});
stub(ids.appSecrets, {});
stub(ids.appLlmEnv, {});
stub(ids.appStorageEnv, {});
stub(ids.appIdentityEnv, { appIdentityEnv: () => ({}) });
stub(ids.stagingEnv, {});
stub(ids.events, { emit: () => {} });
stub(ids.buildRetentionGuard, { withResourceUse: (config, classifier, resource, fn) => fn() });

// One apps row, with a real last_failure that the UPDATE ... RETURNING
// reads before it writes, the way Postgres does.
const appRow = { id: 8, slug: 'falling-sands', last_failure: null };
const queries = [];
const pool = {
  query: async (sql, params) => {
    const s = String(sql);
    queries.push({ sql: s, params });
    if (/UPDATE apps SET last_failure = \$1/.test(s)) {
      assert.match(s, /WITH before AS \(SELECT last_failure FROM apps WHERE id = \$2\)/);
      assert.match(s, /RETURNING \(SELECT last_failure FROM before\) AS previous_failure/);
      assert.equal(params[1], appRow.id);
      const previous = appRow.last_failure;
      appRow.last_failure = JSON.parse(params[0]);
      return { rows: [{ previous_failure: previous }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};
stub(ids.pool, { getPool: () => pool });

const staging = require('../src/services/staging');

const RED = 'e7ab4060ee62bea30536db98af7a06aff33554e9';
const FIXED = 'f1x3d000000000000000000000000000000000000';
const app = { id: 8, slug: 'falling-sands', repo_url: 'https://github.com/example/falling-sands', main_sha: 'de34dda' };
const config = {};

function reset() {
  appRow.last_failure = null;
  queries.length = 0;
  notified.length = 0;
  pushed.length = 0;
  logged.length = 0;
  headSha = RED;
  buildError = new Error('docker build failed: E: Failed to fetch http://deb.debian.org/debian/dists/bookworm/InRelease Connection timed out');
}

async function failOnce() {
  await assert.rejects(staging.rebuildProduction(config, app), buildError);
}

test('the first failure on a commit records it and notifies', async () => {
  reset();
  await failOnce();

  assert.equal(appRow.last_failure.sha, RED, 'the failed commit is stamped on the record');
  assert.equal(notified.length, 1);
  assert.deepEqual(notified[0], { appId: 8, detail: 'deploy_failed' });
  assert.equal(pushed.length, 1, 'the created notification is pushed');
});

test('the same commit failing again at the same stage is recorded but not re-notified', async () => {
  reset();
  await failOnce();
  const firstRecord = appRow.last_failure;

  // Five more ticks of the drift poller.
  for (let i = 0; i < 5; i++) await failOnce();

  const writes = queries.filter((q) => /UPDATE apps SET last_failure/.test(q.sql));
  assert.equal(writes.length, 6, 'every attempt is persisted');
  assert.notEqual(appRow.last_failure.at, undefined);
  assert.equal(appRow.last_failure.sha, RED);
  assert.equal(appRow.last_failure.stage, firstRecord.stage);
  assert.equal(notified.length, 1, 'one notification for the incident, not one per attempt');
  assert.equal(pushed.length, 1);

  const quiet = logged.filter((l) => l[2] === 'Production rebuild failed again for the same commit; already notified');
  assert.equal(quiet.length, 5, 'each suppressed repeat says so in the log');
  assert.equal(quiet[0][3].sha, RED);
});

test('a different commit failing is a new incident and notifies again', async () => {
  reset();
  await failOnce();
  await failOnce();
  assert.equal(notified.length, 1);

  headSha = FIXED;
  await failOnce();
  assert.equal(appRow.last_failure.sha, FIXED);
  assert.equal(notified.length, 2, 'the new commit\'s failure is news');

  await failOnce();
  assert.equal(notified.length, 2, 'and its repeat is not');
});

test('the same commit failing at a different stage is a new incident', async () => {
  reset();
  await failOnce();
  assert.equal(notified.length, 1);
  const buildStage = appRow.last_failure.stage;

  // The classifier reads the error: a clone failure is its own stage.
  buildError = Object.assign(new Error('fatal: could not read from remote repository'), { cloneFailed: true });
  await failOnce();
  assert.notEqual(appRow.last_failure.stage, buildStage);
  assert.equal(appRow.last_failure.sha, RED, 'same commit');
  assert.equal(notified.length, 2, 'a different fault on the same commit is news');
});

test('a failure with no sha (the clone itself failed) keeps notifying, as before', async () => {
  reset();
  headSha = '';
  buildError = Object.assign(new Error('fatal: could not read from remote repository'), { cloneFailed: true });
  await failOnce();
  await failOnce();
  assert.equal(appRow.last_failure.sha, null);
  assert.equal(notified.length, 2);
});

test('a previous record in the legacy string shape is a new incident', async () => {
  reset();
  appRow.last_failure = 'docker build failed';
  // The stub hands the string back as previous_failure, as a pre-#416 row would.
  await failOnce();
  assert.equal(notified.length, 1);
  assert.equal(appRow.last_failure.sha, RED, 'and the record is upgraded to the structured shape');
});

test('when the record cannot be persisted the failure is treated as new and still notifies', async () => {
  reset();
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/UPDATE apps SET last_failure/.test(String(sql))) throw new Error('connection reset');
    return realQuery(sql, params);
  };
  try {
    await failOnce();
    await failOnce();
  } finally {
    pool.query = realQuery;
  }
  assert.equal(notified.length, 2, 'unknown previous state fails open to notifying');
  assert.ok(logged.some((l) => l[2] === 'Failed to persist last_failure'));
});
