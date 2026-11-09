// A staging preview's share of the Postgres connection budget (#1771).
//
// ── What was measured ─────────────────────────────────────────────────
//
// One Postgres container backs the platform, every production app, and every
// staging preview. Its `max_connections` is never set anywhere in the repo,
// so it is the stock 100. On the production host:
//
//   max_connections  100
//   in use            73   (67 of them idle)
//   live previews     20
//
// and per database, the oldest idle backend's age:
//
//   app_usernode_2d5619_staging_s3704_…   6 connections, oldest idle 5.9 DAYS
//   app_usernode_2d5619_staging_s3896_…   6 connections, oldest idle 1.0 day
//
// The newest idle backend on both was seconds old. A preview nobody had
// looked at in a week was still querying its own clone every few seconds, so
// `idleTimeoutMillis` never fired: it only sheds a connection nothing reuses.
//
// ── Why ───────────────────────────────────────────────────────────────
//
// server.becomeLeader() holds every fleet duty — role bootstraps, container
// cleanup, backfills, six pollers, nine sweepers — and is gated to one leader
// so the two blue-green colors never double-run it. A preview is neither
// color. It is a throwaway clone with its own database, so it wins its own
// advisory lock instantly and runs the whole suite against a copy of
// production's rows, forever, on work it cannot do: no docker socket, no
// GitHub credentials, no fleet.
//
// That is 20 x 6 = 120 permanently-held connections against a limit of 100.
// The fleet is over budget at rest, and any check run tips it — which is the
// second half of the report: the preview's queries throw, its API answers
// 500, and the declared checks record assertion failures against the diff.
//
// These tests pin the two halves of the fix: a preview does not stand for
// election, and the server-wide figure is finally readable.
//
// Run with: node --test tests/preview-connection-budget.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Comments in these files quote the shapes they forbid, so a scan over raw
// source flags its own explanation. Same guard as tests/shell-build.test.js,
// minus its block-comment pass: server.js contains `/` and `*` in regex
// literals and arithmetic that a naive `/*…*/` strip pairs up across
// thousands of lines. Every comment this file needs gone is a `//` one.
const stripComments = (src) => src.replace(/^[ \t]*\/\/.*$/gm, '');

const {
  isConnectionLimitError, isSaturated, connectionCensus, SATURATION_RATIO,
} = require('../src/db/connection-census');
const { setPlatformKeys } = require('./platform-keys');

// ─── a preview does not stand for election ──────────────────────────

test('#1771: runsClusterMaintenance is false in a preview and true everywhere else', () => {
  const { runsClusterMaintenance } = require('../src/config');
  const before = process.env.USERNODE_ENV;
  const beforeOverride = process.env.STAGING_CLUSTER_MAINTENANCE;
  try {
    delete process.env.USERNODE_ENV;
    assert.equal(runsClusterMaintenance(), true, 'production and dev keep every duty');
    process.env.USERNODE_ENV = 'production';
    assert.equal(runsClusterMaintenance(), true);
    process.env.USERNODE_ENV = 'staging';
    assert.equal(runsClusterMaintenance(), false, 'a preview runs none of it');
    // The escape hatch exists for a preview reviewing a change TO the
    // sweepers, which would otherwise be unreviewable.
    process.env.STAGING_CLUSTER_MAINTENANCE = '1';
    assert.equal(runsClusterMaintenance(), true);
    process.env.STAGING_CLUSTER_MAINTENANCE = 'true';
    assert.equal(runsClusterMaintenance(), false, 'only an explicit 1 opts back in');
  } finally {
    if (before === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = before;
    if (beforeOverride === undefined) delete process.env.STAGING_CLUSTER_MAINTENANCE;
    else process.env.STAGING_CLUSTER_MAINTENANCE = beforeOverride;
  }
});

test('#1771: a preview runs no fleet duty: there is no leader, and the clocks and process duties are gated where they start', () => {
  const src = read('server.js');
  // No election: a preview cannot win a lock it would hold on a copy of
  // production's rows, because there is none to stand for.
  assert.ok(!/becomeLeader|createLeadership|leaderTimers/.test(src), 'no leader, no leader timers');
  assert.match(src, /const \{ load: loadConfig, runsClusterMaintenance \} = require\('\.\/src\/config'\);/);
  // The session sweeper's passes, the stale-PR and stuck-checks sweepers, the
  // orphan sweeps and the watchdog are gone: what they did is the machines'
  // own deadlines, a turn's work item, or a clock (below).
  for (const retired of ['startSessionAutoPauseSweeper', 'startStalePrSweeper', 'startStuckChecksSweeper',
    'startTurnWatchdog', 'startLocalAgentLeaseSweeper', 'sweepOrphanTurns']) {
    assert.ok(!src.includes(`function ${retired}(`), `${retired} no longer exists`);
  }
  // The platform's scheduled jobs are clocks of the workflow, which a
  // preview runs: the release's work arms none of them there
  // (src/workflow/platform.ts armClocks).
  const platform = read('src/workflow/platform.ts');
  const arm = platform.slice(platform.indexOf('async function armClocks('));
  const armed = arm.slice(0, arm.indexOf('\n}\n'));
  assert.match(armed, /const runs = legacy\('config'\)\.runsClusterMaintenance\(\);/);
  assert.match(armed, /if \(runs && CLOCK_JOB_NAMES\.has\(job\)\) continue;/, 'one armed there before is retired');
  assert.match(armed, /if \(!runs\) return 0;/, 'no clock is armed on a staging preview');
  // What each process sweeps of its own never runs on a preview either. Idle
  // workers are a clock's, not a process's (services/worker-eviction.js).
  assert.match(src, /if \(runsClusterMaintenance\(\)\) startProcessDuties\(\);/);
  const duties = src.slice(src.indexOf('function startProcessDuties()'), src.indexOf('async function start()'));
  assert.ok(!/startIdleEvictionSweeper\(/.test(stripComments(duties)), 'no process evicts idle workers of its own');
  assert.match(read('src/workflow/clock/services.ts'), /name: 'worker-eviction', everyMs: 2 \* MIN/, 'the eviction clock does');
});

// ─── a preview's pool ceiling ───────────────────────────────────────

// load() exits the process when a required env var is missing and is chatty
// on the way through, so give it the full REQUIRED set and silence it — the
// same harness tests/max-apps-cap.test.js uses.
function loadWith(env) {
  const saved = {};
  const set = (key, value) => {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  process.env.JWT_SECRET = 'test-jwt-secret';
  setPlatformKeys();
  for (const [key, value] of Object.entries(env)) set(key, value);
  const realLog = console.log;
  console.log = () => {};
  try {
    return require('../src/config').load();
  } finally {
    console.log = realLog;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('#1771: a preview caps its pool at the capture concurrency, prod does not', () => {
  assert.equal(
    loadWith({ USERNODE_ENV: 'staging', DB_POOL_MAX: '60', STAGING_DB_POOL_MAX: undefined }).dbPoolMax,
    8, 'a preview ignores the platform-wide 60 and takes the capture concurrency'
  );
  assert.equal(
    loadWith({ USERNODE_ENV: 'staging', DB_POOL_MAX: '60', STAGING_DB_POOL_MAX: '3' }).dbPoolMax,
    3, 'the preview ceiling is tunable on its own key'
  );
  assert.equal(
    loadWith({ USERNODE_ENV: 'production', DB_POOL_MAX: '60', STAGING_DB_POOL_MAX: '3' }).dbPoolMax,
    60, 'production is untouched by either preview key'
  );
});

test('#1771: the ceiling is read from the preview, never injected into it', () => {
  // Adding a key to platformStagingEnv moves the env fingerprint, which marks
  // every live preview stale and rebuilds the fleet — twenty image builds and
  // twenty database clones, i.e. the exact load this issue is about. The
  // preview reads its own USERNODE_ENV instead, which costs nothing.
  const env = stripComments(read('src/services/staging-env.js'));
  assert.doesNotMatch(env, /DB_POOL_MAX/,
    'no pool key in the fingerprinted env, or the whole fleet rebuilds');
  assert.match(stripComments(read('src/config.js')), /IS_STAGING\(\)\s*\n?\s*\?\s*parseInt\(process\.env\.STAGING_DB_POOL_MAX/);
});

// ─── naming the failure ─────────────────────────────────────────────

test('#1771: a server-side refusal is recognised by code and by text', () => {
  assert.ok(isConnectionLimitError({ code: '53300' }), 'too_many_connections');
  assert.ok(isConnectionLimitError({ code: '53400' }), 'configuration_limit_exceeded');
  assert.ok(isConnectionLimitError({ message: 'sorry, too many clients already' }),
    'the text fallback covers an error that lost its SQLSTATE');
  assert.ok(isConnectionLimitError({ message: 'remaining connection slots are reserved' }));
  assert.equal(isConnectionLimitError({ code: '23505' }), false, 'a unique violation is not this');
  assert.equal(isConnectionLimitError({ message: 'connection terminated' }), false);
  assert.equal(isConnectionLimitError(null), false);
  assert.equal(isConnectionLimitError(undefined), false);
});

test('#1771: the pool says which failure it hit', () => {
  const src = stripComments(read('src/db/pool.js'));
  assert.match(src, /if \(isConnectionLimitError\(err\)\) \{/);
  assert.match(src, /Postgres refused a connection: the server is at max_connections/);
  // The generic branch must survive: everything that is NOT this still needs
  // reporting, and reporting it under the wrong name is the original sin.
  assert.match(src, /Unexpected pool error/);
});

// ─── the census ─────────────────────────────────────────────────────

function fakePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [match, rows] of handlers) {
        if (sql.includes(match)) return { rows };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
}

test('#1771: the census reports the server figure, not the pool figure', async () => {
  const pool = fakePool([
    ['max_connections', [{ max: 100, used: 73, idle: 67 }]],
    ['GROUP BY datname', [
      { datname: 'app_usernode_2d5619_staging_s3704_46cee8', count: 6 },
      { datname: 'app_usernode_2d5619', count: 5 },
    ]],
  ]);
  const census = await connectionCensus(pool);
  assert.deepEqual(
    { max: census.max, used: census.used, idle: census.idle, free: census.free },
    { max: 100, used: 73, idle: 67, free: 27 }
  );
  assert.equal(census.saturated, false, '73 of 100 is loaded, not yet refusing');
  assert.deepEqual(census.topDatabases[0], {
    name: 'app_usernode_2d5619_staging_s3704_46cee8', count: 6,
  }, 'the biggest holder is named, which is the whole point of the breakdown');
});

test('#1771: saturation is called before the server starts refusing', async () => {
  assert.equal(isSaturated({ max: 100, used: 89 }), false);
  assert.equal(isSaturated({ max: 100, used: 90 }), true,
    'the last tenth is not headroom — one check run opens eight at once');
  assert.equal(isSaturated({ max: 0, used: 0 }), false, 'no division by zero');
  assert.equal(isSaturated(null), false);
  assert.equal(SATURATION_RATIO, 0.9);

  const pool = fakePool([
    ['max_connections', [{ max: 100, used: 95, idle: 80 }]],
    ['GROUP BY datname', []],
  ]);
  assert.equal((await connectionCensus(pool)).saturated, true);
});

test('#1771: a census that cannot run returns null rather than throwing', async () => {
  // Every caller is a diagnostic on a path that must not gain a failure mode
  // — including, pointedly, the case where the census cannot run BECAUSE the
  // server has no connection left to give it.
  const refusing = {
    async query() { const err = new Error('sorry, too many clients already'); err.code = '53300'; throw err; },
  };
  assert.equal(await connectionCensus(refusing), null);
});

test('#1771: the census reaches the status payload and the admin meter', () => {
  const status = stripComments(read('src/services/status.js'));
  assert.match(status, /server: await connectionCensus\(pool\),/,
    'the db block carries the figure its pool is competing for');
  const tsx = read('frontend/src/features/admin/admin-status.tsx');
  assert.match(tsx, /Postgres server \(backends \/ max_connections\)/);
  assert.match(tsx, /serverPct >= 90 \? 'red' : serverPct >= 75 \? 'yellow' : 'green'/,
    'the meter goes red before the server does');
  assert.match(tsx, /server\.topDatabases\?\.length/,
    'and names who is holding them');
});

test('#1771: a non-passing check run says whether the server was starved', () => {
  const src = stripComments(read('src/services/visuals.js'));
  // Sampled where the run FINISHED, next to the unreachable-origin check,
  // rather than at the write: storeChecks has a query-order contract that
  // tests/set-checks-pending.test.js and
  // tests/staging-recovery-checks-verdicts.test.js pin by call index.
  const unreachable = src.indexOf("unreachableOriginDetail(containerRows, stagingOrigin)");
  assert.ok(unreachable > 0, 'the sibling infrastructure check must still exist');
  const after = src.slice(unreachable, unreachable + 1400);
  assert.match(after, /if \(checksResult\.state !== 'passing'\) \{/,
    'both failing and error runs get the line — a passing run needs nothing');
  assert.match(after, /const census = await connectionCensus\(getPool\(config\)\);/);
  assert.match(after, /Checks ran while Postgres was near its connection limit/);
  // The census on its own is evidence, not a verdict: a busy server does not
  // excuse a single row, and reclassifying on it alone would let real
  // failures through the merge gate. Whether the run is RE-LABELLED goes
  // through connectionExhaustionDetail's every-row rule instead, which
  // tests/checks-connection-exhaustion.test.js pins.
  const block = after.slice(after.indexOf("if (checksResult.state !== 'passing')"));
  assert.doesNotMatch(block, /advisory: true/, 'no row is quietly downgraded');
  const flip = block.indexOf("checksResult.state = 'error'");
  assert.ok(flip > 0, 'the run block re-labels a starved run (#1771)');
  assert.ok(block.slice(0, flip).includes('connectionExhaustionDetail('),
    'and only ever behind the every-row rule, never on the census alone');
  // And storeChecks stays a pure write.
  const writers = read('src/workflow/preview/check-store.ts');
  const store = writers.slice(writers.indexOf('async function storeChecks('), writers.indexOf('async function storeChecksSkipped'));
  assert.ok(store.length > 0, 'the verdict writer is where it is read from');
  assert.doesNotMatch(store, /connectionCensus/,
    'the persistence path gains no query');
});

// ── Containment: the ceiling, and the reclaim ────────────────────────────
//
// Detection tells the author it was not their diff. It does not give the
// fleet its connections back. These two pin the halves that do.

test('#1771: a preview clone gets a server-enforced ceiling, a fork does not', async () => {
  const dbm = require('../src/services/db-manager');
  const calls = [];
  const execute = async (sql) => { calls.push(sql); };

  // The name shape stagingDbName() builds.
  const applied = await dbm.applyStagingConnectionLimit(
    'app_recipe_box_staging_s4102_9ab31c', { execute }
  );
  assert.equal(applied, dbm.DEFAULT_STAGING_DB_CONNECTION_LIMIT);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^ALTER DATABASE app_recipe_box_staging_s4102_9ab31c CONNECTION LIMIT \d+$/);

  // cloneDatabase also serves app forks, whose target is a real production
  // database. Capping one of those would be this issue's symptom made
  // permanent, on an app nobody is previewing.
  calls.length = 0;
  assert.equal(await dbm.applyStagingConnectionLimit('app_recipe_box', { execute }), null);
  assert.equal(await dbm.applyStagingConnectionLimit('usernode', { execute }), null);
  assert.equal(calls.length, 0, 'a production database is never capped');

  // Identifiers are the one thing interpolated into this statement.
  assert.equal(await dbm.applyStagingConnectionLimit('app_x_staging_s1_aaaaaa; DROP DATABASE usernode', { execute }), null);

  // The ceiling is a BACKSTOP, not a working budget: capture drives 8
  // concurrent pages against the preview, so anything at or below that would
  // throttle a healthy check run instead of localizing a sick one.
  assert.ok(dbm.DEFAULT_STAGING_DB_CONNECTION_LIMIT > 8,
    'must sit above what a healthy preview uses under a full check run');
});

// A shots run's copies (5 Nov 2026): a copy of Homeroom at full use held the
// whole preview ceiling (main pool 8, workflow pool 2, bus, locks: 12), so
// the run's own fixture client was refused with 53300 and the run failed
// before its shots agent started.
test('shots: a run\'s copy gets its own ceiling, and a preview keeps its own', async () => {
  const dbm = require('../src/services/db-manager');
  const calls = [];
  const execute = async (sql) => { calls.push(sql); };
  const saved = { shots: process.env.SHOTS_DB_CONNECTION_LIMIT, staging: process.env.STAGING_DB_CONNECTION_LIMIT };
  try {
    delete process.env.SHOTS_DB_CONNECTION_LIMIT;
    delete process.env.STAGING_DB_CONNECTION_LIMIT;
    for (const name of ['app_usernode_2d5619_shots_a422bcef20e0_b', 'app_usernode_2d5619_shots_a422bcef20e0_h',
      'app_recipe_box_evidence_0123456789ab_b']) {
      assert.equal(await dbm.applyStagingConnectionLimit(name, { execute }), dbm.DEFAULT_SHOTS_DB_CONNECTION_LIMIT, name);
    }
    assert.deepEqual(calls, [
      `ALTER DATABASE app_usernode_2d5619_shots_a422bcef20e0_b CONNECTION LIMIT ${dbm.DEFAULT_SHOTS_DB_CONNECTION_LIMIT}`,
      `ALTER DATABASE app_usernode_2d5619_shots_a422bcef20e0_h CONNECTION LIMIT ${dbm.DEFAULT_SHOTS_DB_CONNECTION_LIMIT}`,
      `ALTER DATABASE app_recipe_box_evidence_0123456789ab_b CONNECTION LIMIT ${dbm.DEFAULT_SHOTS_DB_CONNECTION_LIMIT}`,
    ]);
    assert.equal(await dbm.applyStagingConnectionLimit('app_usernode_2d5619_staging_s12699_703c77', { execute }),
      dbm.DEFAULT_STAGING_DB_CONNECTION_LIMIT, 'a preview\'s ceiling is unchanged');
    assert.equal(dbm.DEFAULT_STAGING_DB_CONNECTION_LIMIT, 12);

    // Each key turns off only its own ceiling.
    calls.length = 0;
    process.env.STAGING_DB_CONNECTION_LIMIT = '0';
    assert.equal(await dbm.applyStagingConnectionLimit('app_x_shots_0123456789ab_b', { execute }),
      dbm.DEFAULT_SHOTS_DB_CONNECTION_LIMIT, 'the preview key leaves a shots copy capped');
    delete process.env.STAGING_DB_CONNECTION_LIMIT;
    process.env.SHOTS_DB_CONNECTION_LIMIT = '0';
    assert.equal(await dbm.applyStagingConnectionLimit('app_x_shots_0123456789ab_b', { execute }), null,
      '0 disables the shots ceiling');
    assert.equal(await dbm.applyStagingConnectionLimit('app_x_staging_s1_aaaaaa', { execute }),
      dbm.DEFAULT_STAGING_DB_CONNECTION_LIMIT, 'and leaves a preview capped');
    process.env.SHOTS_DB_CONNECTION_LIMIT = '20';
    assert.equal(await dbm.applyStagingConnectionLimit('app_x_shots_0123456789ab_h', { execute }), 20);
    assert.equal(calls.at(-1), 'ALTER DATABASE app_x_shots_0123456789ab_h CONNECTION LIMIT 20');
  } finally {
    for (const [key, value] of [['SHOTS_DB_CONNECTION_LIMIT', saved.shots], ['STAGING_DB_CONNECTION_LIMIT', saved.staging]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Every connection the platform names (db/connection-options.js
// connectionName), by whether it can hold a backend on a shots copy. A name
// added anywhere in src/ fails here until it is placed, so a new dedicated
// client cannot take the run's fixture client's room again unnoticed.
const COPY_CONNECTIONS = Object.freeze({
  // The copy's two pools, sized by its config (counted below from it).
  main: 'pool',
  workflow: 'pool',
  // The copy's dedicated clients, one connection each.
  bus: 'copy',        // services/ws-bus.js, the LISTEN client
  locks: 'copy',      // db/session-locks.js
  presence: 'copy',   // services/process-presence.js, opened while a process holds session records
  debug: 'copy',      // services/debug-access.js, a read-only pool of one
  // What the platform opens into a copy as its owner role, one at a time each.
  shots: 'run',       // services/shots-fixtures.js withClient
  dbadmin: 'run',     // services/db-manager.js, its per-database client
  // Never against a copy's ceiling, with the reason.
  'schema-observer': 'boot only, while the migration runs and before the bus, locks and workflow pool open',
  census: 'the preview server\'s maintenance database',
  admin: 'the role provisioner, only with DATABASE_ROLE_SPLIT, which a copy\'s environment does not set',
  export: 'an app export\'s pg_dump, against the app\'s own database',
  retention: 'held while this process builds an image, and a copy builds none (services/preview-projects.js)',
});

test('shots: the ceiling sits above a full copy plus the platform\'s own clients into it', () => {
  const dbm = require('../src/services/db-manager');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|ts)$/.test(entry.name)) files.push(rel);
    }
  };
  walk('src');
  const named = new Set();
  for (const rel of files) {
    for (const m of read(rel).matchAll(/connectionName\('([a-z-]+)'\)/g)) named.add(m[1]);
  }
  assert.ok(named.has('main') && named.has('bus') && named.has('shots'), 'the scan finds the platform\'s named connections');
  const unplaced = [...named].filter((name) => !(name in COPY_CONNECTIONS));
  assert.deepEqual(unplaced, [],
    'place each new named connection in COPY_CONNECTIONS, and if a shots copy can hold it, in DEFAULT_SHOTS_DB_CONNECTION_LIMIT\'s sum (src/services/db-manager.js)');
  const gone = Object.keys(COPY_CONNECTIONS).filter((name) => !named.has(name));
  assert.deepEqual(gone, [], 'a connection no longer opened leaves the list');

  const config = loadWith({ USERNODE_ENV: 'staging', STAGING_DB_POOL_MAX: undefined, WF_POOL_MAX: undefined, PROCESS_ROLE: undefined });
  assert.equal(config.dbPoolMax, 8);
  assert.equal(config.wfPoolMax, 2);
  const dedicated = Object.values(COPY_CONNECTIONS).filter((kind) => kind === 'copy').length;
  const run = Object.values(COPY_CONNECTIONS).filter((kind) => kind === 'run').length;
  const copy = config.dbPoolMax + config.wfPoolMax + dedicated;
  assert.equal(copy, 14);
  assert.ok(dbm.DEFAULT_SHOTS_DB_CONNECTION_LIMIT > copy + run,
    `a copy can hold ${copy} and the platform opens ${run} more: the ceiling must leave room above both`);
});

test('#1771: setting the ceiling never fails a build, and can be turned off', async () => {
  const dbm = require('../src/services/db-manager');
  const boom = async () => { throw new Error('permission denied for database'); };
  assert.equal(await dbm.applyStagingConnectionLimit('app_x_staging_s1_aaaaaa', { execute: boom }), null,
    'an uncapped preview is the status quo; a failed build is a regression');

  const prev = process.env.STAGING_DB_CONNECTION_LIMIT;
  try {
    process.env.STAGING_DB_CONNECTION_LIMIT = '0';
    const calls = [];
    assert.equal(
      await dbm.applyStagingConnectionLimit('app_x_staging_s1_aaaaaa', { execute: async (q) => calls.push(q) }),
      null
    );
    assert.equal(calls.length, 0, '0 disables the ceiling, as -1 does in Postgres');
  } finally {
    if (prev === undefined) delete process.env.STAGING_DB_CONNECTION_LIMIT;
    else process.env.STAGING_DB_CONNECTION_LIMIT = prev;
  }
});

test('#1771: both clone paths converge on one place that sets the ceiling', () => {
  const src = stripComments(read('src/services/db-manager.js'));
  const fn = src.slice(src.indexOf('async function cloneDatabase(sourceDb'));
  const body = fn.slice(0, fn.indexOf('\nasync function cloneDatabaseDirect'));
  // Each call names the server the clone was made on (the main one unless
  // STAGING_DB_ADMIN_URL names a preview server): the ceiling is set where
  // the database is.
  assert.equal((body.match(/applyStagingConnectionLimit\(targetDb, \{ server \}\)/g) || []).length, 2,
    'the template path and the direct path each land on it');
  // After the copy, never before: pg_restore opens its own connections and a
  // ceiling applied mid-restore would cap the restore itself.
  const direct = body.indexOf('cloneDatabaseDirect(sourceDb, targetDb, { server })');
  assert.ok(direct > 0 && direct < body.lastIndexOf('applyStagingConnectionLimit'));
});

test('#1771: pressure reclaim skips every preview somebody is using', () => {
  const { selectPressureVictims } = require('../src/services/staging-reap');
  const rows = [
    { id: 1, status: 'active', last_activity_at: '2026-09-01T00:00:00Z' },   // idle longest
    { id: 2, status: 'promoted', last_activity_at: '2026-09-02T00:00:00Z' }, // backs a live vote
    { id: 3, status: 'merging', last_activity_at: '2026-09-03T00:00:00Z' },  // mid-merge
    { id: 4, status: 'active', last_activity_at: '2026-09-04T00:00:00Z' },   // a turn in flight
    // A preview the machine is building is not excluded here: the machine
    // refuses the retirement itself (staging.teardownStaging reports it busy).
    { id: 5, status: 'paused', last_activity_at: '2026-09-05T00:00:00Z' },
    { id: 6, status: 'active', last_activity_at: '2026-09-06T00:00:00Z' },
  ];
  const victims = selectPressureVictims({
    rows,
    isBusy: (id) => id === 4,
  });
  assert.deepEqual(victims.map((v) => v.id), [1, 5, 6],
    'a reviewer arriving at a dead link is worse than a tight connection budget');
  assert.equal(victims[0].id, 1, 'idle-longest first');
});

// #6157: sleep, beside the pressure reclaim and by its rules (isBusy and
// last_activity_at), but a vote-backed preview sleeps too: sleep has no dead
// link, since whatever opens a sleeping preview wakes it.
test('#6157: an idle vote-backed preview past PREVIEW_SLEEP_AFTER is chosen to sleep, not torn down', () => {
  const { selectSleepers, selectPressureVictims } = require('../src/services/staging-reap');
  const now = Date.parse('2026-11-02T12:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3600 * 1000).toISOString();
  const row = (id, extra = {}) => ({
    id, status: 'promoted', last_activity_at: hoursAgo(3), staging_asleep_at: null,
    machine_state: 'settled', serving: { n: 2, db: 'app_x_staging_s1_abcdef' }, check_run_open: false, ...extra,
  });
  const rows = [row(1, { last_activity_at: hoursAgo(5) }), row(2, { status: 'merging' }), row(3, { status: 'paused', last_activity_at: hoursAgo(4) })];
  const sleepers = selectSleepers({ rows, isBusy: () => false, now, sleepAfterMs: 2 * 3600 * 1000 });
  assert.deepEqual(sleepers.map((r) => r.id), [1, 3, 2], 'vote-backed ones too, idle-longest first');
  assert.deepEqual(selectPressureVictims({ rows: rows.slice(0, 2) }), [],
    'the teardown passes still never take a vote-backed preview');
  // What sleeps is scaled down, never torn down.
  const src = stripComments(read('src/services/staging-reap.js'));
  const fn = src.slice(src.indexOf('async function sweepSleep('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /previewSleep\.sleep\(config, pool, row, \{ afterMs \}\)/);
  assert.doesNotMatch(body, /retire|teardown|reapOne/);
  assert.match(stripComments(read('src/services/preview-sleep.js')), /kubernetes\.scalePreview\(kube, name, 0, \{ attempt: n \}\)/);
});

test('#6157: a preview something works on does not sleep: a worker turn, a checks run, a shots run, a build', () => {
  const { selectSleepers } = require('../src/services/staging-reap');
  const now = Date.parse('2026-11-02T12:00:00Z');
  const idle = new Date(now - 3 * 3600 * 1000).toISOString();
  const row = (id, extra = {}) => ({
    id, status: 'active', last_activity_at: idle, staging_asleep_at: null,
    machine_state: 'settled', serving: { n: 1 }, check_run_open: false, ...extra,
  });
  const rows = [
    row(1),                                  // nothing works on it: sleeps
    row(2),                                  // a worker turn (isBusy: session-work.ts workedOnSql)
    row(3),                                  // a shots run (isBusy too)
    row(4, { machine_state: 'checking' }),   // the machine's checks run
    row(5, { check_run_open: true }),        // a checks run on the cluster
    row(6, { machine_state: 'preparing' }),  // a build
    row(7, { serving: null }),               // nothing serves
    row(8, { serving: { n: 1, lost: true } }),
    row(9, { staging_asleep_at: idle }),     // asleep already
    row(10, { status: 'merged' }),           // backs nothing: the gc's
  ];
  const busy = new Set([2, 3]);
  assert.deepEqual(selectSleepers({ rows, isBusy: (id) => busy.has(id), now, sleepAfterMs: 2 * 3600 * 1000 }).map((r) => r.id), [1]);
});

test('#6157: a preview used inside the window does not sleep, and PREVIEW_SLEEP_AFTER_MS=0 switches sleep off', () => {
  const { selectSleepers } = require('../src/services/staging-reap');
  const previewSleep = require('../src/services/preview-sleep');
  const now = Date.parse('2026-11-02T12:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  const row = (id, ago) => ({ id, status: 'active', last_activity_at: at(ago), machine_state: 'settled', serving: { n: 1 } });
  const window = previewSleep.DEFAULT_SLEEP_AFTER_MS;
  assert.equal(window, 3600 * 1000, 'one hour by default');
  const rows = [row(1, window + 1000), row(2, window - 1000), row(3, 60 * 1000)];
  assert.deepEqual(selectSleepers({ rows, now, sleepAfterMs: window }).map((r) => r.id), [1]);
  assert.deepEqual(selectSleepers({ rows, now, sleepAfterMs: 0 }), []);
  assert.equal(previewSleep.sleepAfterMs({ previewSleepAfterMs: 0 }), 0);
  assert.equal(previewSleep.sleepAfterMs({ previewSleepAfterMs: 'junk' }), window);
});

test('#6157: a sleeping preview holds no connection, so the pressure reclaim passes it by', () => {
  const src = stripComments(read('src/services/staging-reap.js'));
  const fn = src.slice(src.indexOf('async function sweepConnectionPressure('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /AND staging_asleep_at IS NULL/);
});

test('#1771: the reclaim acts on a reading, one preview at a time, and kills nothing', () => {
  const src = stripComments(read('src/services/staging-reap.js'));
  const fn = src.slice(src.indexOf('async function sweepConnectionPressure('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /if \(!before \|\| !before\.saturated\) return summary;/,
    'on an ordinary day this is one cheap query and nothing else');
  assert.match(body, /if \(isStagingEnv\(\)\) return summary;/,
    'a preview computing victims from its own stale clone would be fiction');
  // A retirement is asynchronous, so a census right after the ask sees
  // nothing freed: while the last one asked for is still retiring, no other
  // is asked for. Freeing the budget is the goal, tearing down the means.
  assert.match(body, /if \(await previewWorkflow\.retiring\(Number\(id\)\)\) summary\.asked\.push\(Number\(id\)\);/);
  assert.match(body, /if \(summary\.asked\.length\) \{\s*summary\.waiting = summary\.asked\.length;\s*return summary;/);
  // Through the preview machine, which refuses one under review, worked on,
  // building or checking, and drops its database and nulls staging_url.
  assert.match(body, /previewWorkflow\.retire\(\{ session: \{ id: Number\(victim\.id\), app_id: victim\.app_id \}, reason: 'pressure', terminal: false \}\)/);
  assert.match(body, /summary\.asked\.push\(Number\(victim\.id\)\);\s*break;/, 'one a pass');
  assert.ok(!/teardownStagingForSession/.test(body), 'never around the machine');
  // The fast way to free connections is the wrong one: node-postgres
  // surfaces a killed idle client as a pool 'error' event, and a pool with
  // no listener takes the process down. Generated apps frequently have none,
  // so this would crash-loop other people's production apps.
  // (The module NAMES it, in the doc comment explaining why not, so the scan
  // is for an executable mention rather than any mention at all.)
  for (const line of read('src/services/staging-reap.js').split('\n')) {
    if (!line.includes('pg_terminate_backend')) continue;
    assert.match(line.trim(), /^(\/\/|\*)/,
      'never terminate another database\'s backends to make room');
  }
  // A clock of the workflow, which carries each server's asks from its last
  // run (src/workflow/clock/services.ts), and nothing in server.js.
  const clocks = read('src/workflow/clock/services.ts');
  const job = clocks.slice(clocks.indexOf("name: 'preview-pressure'"));
  const run = job.slice(0, job.indexOf('\n  },\n'));
  assert.match(run, /reap\.sweepConnectionPressure\(config, \{ asked: previous\.main\?\.asked \?\? \[\] \}\)/);
  assert.match(run, /reap\.sweepConnectionPressure\(config, \{ server: 'preview', asked: previous\.preview\?\.asked \?\? \[\] \}\)/);
  assert.ok(!/sweepConnectionPressure/.test(stripComments(read('server.js'))), 'the leader runs no pressure pass of its own');
});
