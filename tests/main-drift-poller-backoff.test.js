// The drift poller backs off a rebuild that keeps failing for the same
// commit. Before this a commit main could not build (a Dockerfile the build
// sandbox cannot build, a syntax error) was rebuilt at full cadence, every
// tick, forever: a full image build per tick and, until staging.js learned
// to suppress repeats, a "Deploy failed" notification per tick. Each
// failure on the same attempted sha doubles the wait, from one tick up to
// a cap; a new commit on main, a success, or the admin's manual "Check for
// updates" starts over.
//
// Run with: node --test tests/main-drift-poller-backoff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  pool: require.resolve('../src/db/pool'),
  github: require.resolve('../src/services/github'),
  staging: require.resolve('../src/services/staging'),
  ws: require.resolve('../src/services/ws'),
  conflictResolver: require.resolve('../src/services/conflict-resolver'),
};

const logged = [];
stub(ids.logger, {
  info: (...a) => logged.push(['info', ...a]),
  warn: (...a) => logged.push(['warn', ...a]),
  error: (...a) => logged.push(['error', ...a]),
  debug: (...a) => logged.push(['debug', ...a]),
});
stub(ids.pool, { getPool: () => pool });

let remoteSha = null;
let fetchError = null;
stub(ids.github, {
  parseGithubUrl: (url) => {
    const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
    return m ? { owner: m[1], repo: m[2] } : null;
  },
  getOctokit: async () => ({
    rest: {
      repos: {
        getBranch: async () => {
          if (fetchError) throw fetchError;
          return { data: { commit: { sha: remoteSha } } };
        },
      },
    },
  }),
  isEnabled: () => true,
});

const rebuilds = [];
let rebuildOutcome = () => { throw new Error('docker build failed: apt-get update timed out'); };
stub(ids.staging, {
  rebuildProduction: async (config, app) => {
    rebuilds.push(app.slug);
    return rebuildOutcome(app);
  },
  MissingSecretsError: class extends Error {},
});
stub(ids.ws, { broadcastGlobal: () => {} });
stub(ids.conflictResolver, { checkAndResolveConflicts: async () => {} });

const queries = [];
const pool = {
  query: async (sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [], rowCount: 1 };
  },
};

const poller = require('../src/services/main-drift-poller');
const { POLL_INTERVAL_MS, BACKOFF_MAX_MS } = poller._forTest;

const RED = 'e7ab4060ee62bea30536db98af7a06aff33554e9';
const RUNNING = 'de34dda1111111111111111111111111111111111';
const FIXED = 'f1x3d000000000000000000000000000000000000';
const app = { id: 8, slug: 'falling-sands', repo_url: 'https://github.com/example/falling-sands', main_sha: RUNNING };
const config = {};

let clock = 0;
function reset() {
  poller._forTest.resetBackoff();
  poller._forTest.setClock(() => clock);
  clock = 1_000_000;
  rebuilds.length = 0;
  queries.length = 0;
  logged.length = 0;
  remoteSha = RED;
  fetchError = null;
  rebuildOutcome = () => { throw new Error('docker build failed: apt-get update timed out'); };
}

test('a failed rebuild is retried on the next tick, then backs off doubling per failure', async () => {
  reset();

  const first = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(first.status, 'rebuild_failed');
  assert.equal(first.attempted, RED);
  assert.equal(first.failures, 1);
  assert.equal(first.retryInMs, POLL_INTERVAL_MS, 'the first retry waits one tick, as before');
  assert.equal(rebuilds.length, 1);

  // Same tick, same sha: the poller does not rebuild again.
  const held = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(held.status, 'backing_off');
  assert.equal(held.attempted, RED);
  assert.equal(held.failures, 1);
  assert.equal(held.retryInMs, POLL_INTERVAL_MS);
  assert.equal(rebuilds.length, 1, 'no rebuild while backing off');

  // One tick later the retry runs and fails again; the wait doubles.
  clock += POLL_INTERVAL_MS;
  const second = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(second.status, 'rebuild_failed');
  assert.equal(second.failures, 2);
  assert.equal(second.retryInMs, 2 * POLL_INTERVAL_MS);
  assert.equal(rebuilds.length, 2);

  // The next tick is inside the doubled wait.
  clock += POLL_INTERVAL_MS;
  assert.equal((await poller.checkAndRedeployOne(config, pool, app)).status, 'backing_off');
  assert.equal(rebuilds.length, 2);

  clock += POLL_INTERVAL_MS;
  const third = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(third.status, 'rebuild_failed');
  assert.equal(third.failures, 3);
  assert.equal(third.retryInMs, 4 * POLL_INTERVAL_MS);
  assert.equal(rebuilds.length, 3);
});

test('the wait is capped', async () => {
  reset();
  for (let i = 0; i < 12; i++) {
    const r = await poller.checkAndRedeployOne(config, pool, app);
    assert.equal(r.status, 'rebuild_failed', `attempt ${i + 1}`);
    assert.ok(r.retryInMs <= BACKOFF_MAX_MS, `attempt ${i + 1} waits ${r.retryInMs} > cap ${BACKOFF_MAX_MS}`);
    clock += r.retryInMs;
  }
  const last = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(last.retryInMs, BACKOFF_MAX_MS);
  assert.ok(last.failures >= 12);
});

test('a new commit on main is a new attempt: it is rebuilt at once and the count starts over', async () => {
  reset();
  let r = await poller.checkAndRedeployOne(config, pool, app);
  clock += POLL_INTERVAL_MS;
  r = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(r.failures, 2);
  assert.equal((await poller.checkAndRedeployOne(config, pool, app)).status, 'backing_off');

  // Someone pushes a fix. Still failing (say the fix was wrong), but this
  // is attempt one for the new sha, not attempt three.
  remoteSha = FIXED;
  r = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(r.status, 'rebuild_failed');
  assert.equal(r.attempted, FIXED);
  assert.equal(r.failures, 1);
  assert.equal(r.retryInMs, POLL_INTERVAL_MS);
  assert.equal(rebuilds.length, 3);
});

test('a rebuild that succeeds clears the backoff, so a later failure on another commit starts fresh', async () => {
  reset();
  await poller.checkAndRedeployOne(config, pool, app);
  clock += POLL_INTERVAL_MS;
  await poller.checkAndRedeployOne(config, pool, app);

  remoteSha = FIXED;
  rebuildOutcome = () => ({ containerId: 'c-2', sha: FIXED });
  const ok = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(ok.status, 'redeployed');
  assert.equal(ok.to, FIXED);
  const update = queries.find((q) => /SET container_id = \$1/.test(q.sql));
  assert.ok(update, 'the app row is updated on success');
  assert.deepEqual(update.params, ['c-2', FIXED, app.id]);

  // Main moves again and the build breaks again: first failure, one tick.
  remoteSha = 'aaaa000000000000000000000000000000000000';
  rebuildOutcome = () => { throw new Error('broken again'); };
  const again = await poller.checkAndRedeployOne(config, pool, { ...app, main_sha: FIXED });
  assert.equal(again.status, 'rebuild_failed');
  assert.equal(again.failures, 1);
});

test('converging by any other path clears the backoff too', async () => {
  reset();
  await poller.checkAndRedeployOne(config, pool, app);
  assert.equal((await poller.checkAndRedeployOne(config, pool, app)).status, 'backing_off');

  // A merge through the platform recorded main_sha = RED itself.
  const converged = await poller.checkAndRedeployOne(config, pool, { ...app, main_sha: RED });
  assert.equal(converged.status, 'no_drift');

  // Main moves on and fails: attempt one, not a continuation.
  remoteSha = FIXED;
  const r = await poller.checkAndRedeployOne(config, pool, { ...app, main_sha: RED });
  assert.equal(r.status, 'rebuild_failed');
  assert.equal(r.failures, 1);
});

test('the admin\'s manual "Check for updates" ignores the wait', async () => {
  reset();
  await poller.checkAndRedeployOne(config, pool, app);
  assert.equal((await poller.checkAndRedeployOne(config, pool, app)).status, 'backing_off');
  assert.equal(rebuilds.length, 1);

  // The admin has just fixed the thing that was failing (say, the network
  // policy) and asks now; the same commit is rebuilt immediately.
  rebuildOutcome = () => ({ containerId: 'c-3', sha: RED });
  const manual = await poller.checkAndRedeployOne(config, pool, app, { manual: true });
  assert.equal(manual.status, 'redeployed');
  assert.equal(rebuilds.length, 2);
});

test('a manual attempt that still fails counts, so the periodic poller keeps backing off', async () => {
  reset();
  await poller.checkAndRedeployOne(config, pool, app);
  const manual = await poller.checkAndRedeployOne(config, pool, app, { manual: true });
  assert.equal(manual.status, 'rebuild_failed');
  assert.equal(manual.failures, 2);
  assert.equal((await poller.checkAndRedeployOne(config, pool, app)).status, 'backing_off');
});

test('fetch failures and first-seen backfills are untouched by the backoff', async () => {
  reset();
  await poller.checkAndRedeployOne(config, pool, app);

  fetchError = new Error('rate limited');
  const fetchFailed = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(fetchFailed.status, 'fetch_failed');

  fetchError = null;
  const firstSeen = await poller.checkAndRedeployOne(config, pool, { ...app, main_sha: null });
  assert.equal(firstSeen.status, 'first_seen');
  assert.ok(queries.some((q) => /SET main_sha = \$1 WHERE id = \$2 AND main_sha IS NULL/.test(q.sql)));
});

test('the backoff is per app', async () => {
  reset();
  const other = { id: 9, slug: 'echo', repo_url: 'https://github.com/example/echo', main_sha: RUNNING };
  await poller.checkAndRedeployOne(config, pool, app);
  assert.equal((await poller.checkAndRedeployOne(config, pool, app)).status, 'backing_off');

  // echo drifts to the same sha string (contrived, but the key is the app).
  const r = await poller.checkAndRedeployOne(config, pool, other);
  assert.equal(r.status, 'rebuild_failed');
  assert.equal(r.failures, 1);
  assert.deepEqual(rebuilds, ['falling-sands', 'echo']);
});

test('the failure log line says how many times and when it will try again', async () => {
  reset();
  await poller.checkAndRedeployOne(config, pool, app);
  const line = logged.find((l) => l[0] === 'error' && l[2] === 'Drift redeploy failed');
  assert.ok(line, 'failure is logged at error');
  assert.equal(line[3].failures, 1);
  assert.equal(line[3].retryInMs, POLL_INTERVAL_MS);
  assert.equal(line[3].attempted, RED.slice(0, 7));
});
