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

test('#1771: the guard sits at the election, not at each of the fifteen duties', () => {
  const src = read('server.js');
  // One decision, at the one seam every duty is already behind. Guarding
  // each starter instead would leave the next one added unguarded.
  assert.match(src, /if \(!runsClusterMaintenance\(\)\) \{/,
    'the election is gated on whether this process runs cluster maintenance');
  assert.match(src, /\} else \{\n\s*leadership = createLeadership\(/,
    'and the coordinator is created only in the other arm');
  assert.equal((src.match(/leadership = createLeadership\(/g) || []).length, 1,
    'exactly one place elects a leader, so exactly one guard covers it');
  assert.match(src, /const \{ load: loadConfig, runsClusterMaintenance \} = require\('\.\/src\/config'\);/);
  // Shutdown already tolerates a null coordinator; a preview now relies on
  // that, so it must not regress into an unguarded call.
  assert.match(src, /if \(leadership\) \{\s*\n\s*await leadership\.stop\(\)/,
    'stop() stays guarded — a preview never assigns `leadership`');
});

test('#1771: becomeLeader is still where the fleet duties live', () => {
  // If a sweeper ever starts outside becomeLeader, the one guard above stops
  // covering it. This is the tripwire for that.
  const src = read('server.js');
  const body = src.slice(src.indexOf('async function becomeLeader()'), src.indexOf('async function start()'));
  assert.ok(body.length > 1000, 'becomeLeader must still exist');
  for (const starter of [
    'startIdleEvictionSweeper', 'startConversationAttachmentSweeper',
    'startSessionAutoPauseSweeper', 'startStalePrSweeper', 'startWorkshopThemeSweeper',
    'startLocalAgentLeaseSweeper', 'startGovernanceApplyTicker', 'startEligibleMergeSweeper',
    'startTitleHealSweeper',
  ]) {
    assert.ok(body.includes(`${starter}(`), `${starter} is started under the leader gate`);
  }
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
  // A log line, never a verdict. Reclassifying rows on a busy box would let
  // real failures through.
  const block = after.slice(after.indexOf("if (checksResult.state !== 'passing')"));
  assert.doesNotMatch(block.slice(0, 700), /checksResult\.state = |advisory: true/,
    'the census must not change what the run decided');
  // And storeChecks stays a pure write.
  const store = src.slice(src.indexOf('async function storeChecks('), src.indexOf('async function storeChecksSkipped'));
  assert.doesNotMatch(store, /connectionCensus/,
    'the persistence path gains no query');
});
