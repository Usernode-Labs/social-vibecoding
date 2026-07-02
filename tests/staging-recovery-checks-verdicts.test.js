// #461 "run checks, or skip them explicitly": rebuildSessionStaging's no-op
// paths used to `return 'skipped'` with NO verdict written, leaving
// check_state NULL — the merge gate blocks NULL as "still running its tests"
// and the stuck-checks sweeper re-picked the row every pass, re-skipped, and
// the proposal stayed merge-blocked forever. Now every no-op records an
// explicit terminal verdict:
//
//   - unparseable repo_url / missing GITHUB_BOT_TOKEN → 'skipped'
//     ("checks unavailable — GitHub is not configured"), gate-passing;
//   - branch not ahead of main → 'skipped' ("nothing to test");
//   - compareCommits throw → 'error' (retryable via the existing
//     storeChecks backoff bookkeeping).
//
// Also covers the two visuals helpers behind those verdicts:
// storeChecksSkipped (writes 'skipped' + reason, clears the failure streak)
// and setChecksPending (a later push returns a 'skipped' row to 'pending'),
// plus recordStagingBootFailure's exported surface and recordChecksSkipped's
// broadcast + auto-merge re-drive.
//
// Same require.cache stubbing pattern as ensure-staging.test.js — nothing
// real spins up. The ahead_by===0 / compare-throw paths need a live
// @octokit/rest import (not installed in the test tree), so their verdict
// writes are exercised at the helper layer (storeChecksSkipped / the
// storeChecks 'error' branch) rather than through rebuildSessionStaging.
//
// Run with: node --test tests/staging-recovery-checks-verdicts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// services/visuals pulls in jsonwebtoken / pg at load time (paths these
// tests never reach). They aren't installed in the test environment, so shim
// them the same way checks-auto-merge-trigger.test.js does.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'jsonwebtoken') return { sign: () => 'tok', verify: () => ({}) };
  if (request === 'pg') return { Pool: class { async query() { return { rows: [] }; } } };
  return _origLoad.call(this, request, ...rest);
};

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    },
  };
}

// Load staging-recovery with visuals + ws stubbed so recordChecksSkipped /
// recordStagingBootFailure calls are observable without touching Postgres.
function loadRecovery() {
  const paths = {
    logger: require.resolve('../src/services/logger'),
    visuals: require.resolve('../src/services/visuals'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/services/staging-recovery'),
  };
  const skippedCalls = [];
  const errorChecks = [];
  const drains = [];
  const broadcasts = [];
  const originals = [
    [paths.logger, stubModule(paths.logger, { info() {}, warn() {}, error() {}, debug() {} })],
    [paths.visuals, stubModule(paths.visuals, {
      storeChecksSkipped: async (_pool, sessionId, commitSha, reason) => {
        skippedCalls.push({ sessionId, commitSha, reason });
      },
      storeChecks: async (_pool, sessionId, commitSha, result, detail) => {
        errorChecks.push({ sessionId, commitSha, result, detail });
      },
      maybeAutoMergeAfterChecks: (_config, _pool, session, state) => {
        drains.push({ sessionId: session.id, state });
      },
      summarizeBootFailure: (err) => (err && err.message) || 'boot failure',
    })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: (m) => broadcasts.push(m),
      pushSessionUpdate: () => {},
    })],
  ];
  delete require.cache[paths.subject];
  const subject = require('../src/services/staging-recovery');
  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.subject];
  };
  return { subject, skippedCalls, errorChecks, drains, broadcasts, restore };
}

const SESSION = {
  id: 42, app_id: 5, app_slug: 'whiteboard', app_name: 'Whiteboard',
  branch_name: 'feat/x', status: 'promoted',
  checks_commit_sha: 'cafe1234',
};

test("rebuildSessionStaging: unparseable repo_url records a 'skipped' verdict (GitHub not configured)", async () => {
  const { subject, skippedCalls, restore } = loadRecovery();
  try {
    const r = await subject.rebuildSessionStaging({
      config: {}, pool: makeRecordingPool(),
      session: { ...SESSION, repo_url: 'not-a-github-url' },
      reason: 'test',
    });
    assert.equal(r, 'skipped');
    assert.equal(skippedCalls.length, 1);
    assert.equal(skippedCalls[0].sessionId, 42);
    assert.match(skippedCalls[0].reason, /GitHub is not configured/);
    assert.equal(skippedCalls[0].commitSha, 'cafe1234', 'stamps the last-known commit');
  } finally { restore(); }
});

test("rebuildSessionStaging: missing GITHUB_BOT_TOKEN records a 'skipped' verdict", async () => {
  const { subject, skippedCalls, restore } = loadRecovery();
  const prev = process.env.GITHUB_BOT_TOKEN;
  delete process.env.GITHUB_BOT_TOKEN;
  try {
    const r = await subject.rebuildSessionStaging({
      config: {}, pool: makeRecordingPool(),
      session: { ...SESSION, repo_url: 'https://github.com/acme/whiteboard' },
      reason: 'test',
    });
    assert.equal(r, 'skipped');
    assert.equal(skippedCalls.length, 1);
    assert.match(skippedCalls[0].reason, /GitHub is not configured/);
  } finally {
    if (prev !== undefined) process.env.GITHUB_BOT_TOKEN = prev;
    restore();
  }
});

test('recordChecksSkipped: writes the verdict, broadcasts checks_ready, re-drives the auto-merge drain', async () => {
  const { subject, skippedCalls, drains, broadcasts, restore } = loadRecovery();
  try {
    await subject.recordChecksSkipped({
      config: {}, pool: makeRecordingPool(), session: { ...SESSION },
      commitSha: 'beef5678', reason: 'branch has no commits beyond main — nothing to test',
    });
    assert.equal(skippedCalls.length, 1);
    assert.equal(skippedCalls[0].commitSha, 'beef5678');
    assert.match(skippedCalls[0].reason, /nothing to test/);
    const ev = broadcasts.find((m) => m.event === 'checks_ready');
    assert.ok(ev, 'checks_ready broadcast emitted');
    assert.equal(ev.state, 'skipped');
    assert.equal(ev.sessionId, 42);
    assert.deepEqual(drains, [{ sessionId: 42, state: 'skipped' }],
      'auto-merge drain re-driven with the skipped verdict');
  } finally { restore(); }
});

test('recordStagingBootFailure is exported and records an error verdict with the summarized reason', async () => {
  const { subject, errorChecks, restore } = loadRecovery();
  const pool = makeRecordingPool();
  try {
    assert.equal(typeof subject.recordStagingBootFailure, 'function', 'exported for the dev-turn tails');
    await subject.recordStagingBootFailure({
      config: {}, pool, session: { ...SESSION },
      commitHash: 'dead9999', err: new Error('relation "posts" does not exist'),
    });
    assert.equal(errorChecks.length, 1);
    assert.equal(errorChecks[0].sessionId, 42);
    assert.equal(errorChecks[0].commitSha, 'dead9999');
    assert.equal(errorChecks[0].result.state, 'error');
    assert.match(errorChecks[0].detail, /does not exist/);
  } finally { restore(); }
});

// ── visuals helpers: the SQL behind the verdicts ─────────────────────────

function loadVisuals() {
  const paths = {
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/visuals'),
  };
  const origLogger = stubModule(paths.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[paths.subject];
  const subject = require('../src/services/visuals');
  const restore = () => {
    if (origLogger) require.cache[paths.logger] = origLogger; else delete require.cache[paths.logger];
    delete require.cache[paths.subject];
  };
  return { subject, restore };
}

test("storeChecksSkipped: writes 'skipped' + reason and clears the failure streak", async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.storeChecksSkipped(pool, 42, 'cafe1234', 'branch has no commits beyond main — nothing to test');
    assert.equal(pool.queries.length, 1);
    const q = pool.queries[0];
    assert.match(q.sql, /check_state = 'skipped'/);
    assert.match(q.sql, /consecutive_check_failures = 0/);
    assert.match(q.sql, /first_check_failure_at = NULL/);
    assert.match(q.sql, /last_check_failure_at = NULL/);
    assert.match(q.sql, /check_next_retry_at = NULL/);
    assert.match(q.sql, /check_error_notified_at = NULL/);
    assert.deepEqual(q.params, ['cafe1234', 'branch has no commits beyond main — nothing to test', 42]);
  } finally { restore(); }
});

test('storeChecksSkipped: null commit/reason degrade to NULLs, never "undefined"', async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.storeChecksSkipped(pool, 42, null, null);
    assert.deepEqual(pool.queries[0].params, [null, null, 42]);
  } finally { restore(); }
});

test("setChecksPending returns a 'skipped' row to 'pending' for the next commit (same SQL path)", async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.setChecksPending(pool, 42, 'feed0042');
    assert.equal(pool.queries.length, 1);
    const q = pool.queries[0];
    assert.match(q.sql, /SET check_state = 'pending'/);
    assert.deepEqual(q.params, [42, 'feed0042']);
  } finally { restore(); }
});

test("storeChecks 'error' branch keeps the backoff bookkeeping the compare-throw path relies on", async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.storeChecks(pool, 42, 'cafe1234', { state: 'error', results: [] },
      'could not compare feat/x with main: boom');
    const q = pool.queries[0];
    assert.match(q.sql, /consecutive_check_failures = consecutive_check_failures \+ 1/);
    assert.match(q.sql, /check_next_retry_at = NOW\(\) \+ make_interval/);
    assert.equal(q.params[0], 'error');
    assert.match(String(q.params[4]), /could not compare/);
  } finally { restore(); }
});
