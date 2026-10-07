'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const gc = require('../src/services/shots-gc');

test('recovery starts settled intent-only proposals once for their current checked head', async () => {
  const head = 'a'.repeat(40);
  const rows = [
    { id: 42, source: 'imported', imported_pr_head_sha: head, checks_commit_sha: head },
    { id: 43, source: 'imported', imported_pr_head_sha: 'b'.repeat(40), checks_commit_sha: head },
    { id: 44, source: 'imported', imported_pr_head_sha: 'short', checks_commit_sha: 'short' },
  ];
  const calls = [];
  let queryText;
  const pool = { query: async (sql) => {
    queryText = String(sql);
    return { rows };
  } };
  const result = await gc.recoverUnstarted({ shots: { execute: true } }, pool, {
    schedule: async (_config, options) => {
      calls.push(options);
      return { scheduled: true };
    },
  });
  assert.deepEqual(result, { examined: 3, scheduled: 1 });
  assert.deepEqual(calls.map(({ sessionId, headSha, trigger }) => ({ sessionId, headSha, trigger })),
    [{ sessionId: 42, headSha: head, trigger: 'planned-recovery' }]);
  assert.match(queryText, /shots_run_id IS NULL/);
  assert.match(queryText, /cs\.status IN \('active', 'promoted'\)/);
  assert.match(queryText, /cs\.check_state IN \('passing', 'failing', 'error', 'skipped'\)/);
  assert.match(queryText, /recoveryAttemptAt/);
});

test('recovery starts only run-less declarations and treats every stalled planned run alike', async () => {
  // Author-submitted plans are gone, so a planned run is never waiting on an
  // import-time plan: recovery neither schedules one nor spares it.
  const queries = [];
  await gc.recoverUnstarted({ shots: { execute: true } }, { query: async (sql) => {
    queries.push(String(sql));
    return { rows: [] };
  } }, { schedule: async () => { throw new Error('nothing to schedule'); } });
  assert.match(queries[0], /cs\.shots_run_id IS NULL/);
  assert.doesNotMatch(queries[0], /author_plan|JOIN shot_runs/);
  const interrupted = [];
  await gc.recoverInterrupted({ shots: {} }, { query: async (sql) => {
    interrupted.push(String(sql));
    return { rows: [] };
  } });
  assert.match(interrupted[0], /r\.state IN \('planned','provisioning','exploring','replaying','reviewing'\)/);
  assert.doesNotMatch(interrupted[0], /author_plan/);
});

test('an unlaunchable planned claim is deferred so it cannot starve later claims', async () => {
  const head = 'a'.repeat(40);
  const writes = [];
  const pool = { query: async (sql, params) => {
    if (String(sql).startsWith('SELECT cs.id')) {
      return { rows: [{ id: 42, source: 'imported', imported_pr_head_sha: head, checks_commit_sha: head }] };
    }
    writes.push({ sql: String(sql), params });
    return { rows: [], rowCount: 1 };
  } };
  const result = await gc.recoverUnstarted({ shots: { execute: true } }, pool, {
    schedule: async () => ({ scheduled: false, reason: 'missing_base' }),
  });
  assert.deepEqual(result, { examined: 1, scheduled: 0 });
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /recoveryAttemptAt/);
  assert.equal(writes[0].params[0], 42);
});

test('a rollout-interrupted run is retried on its current head, a bounded number of times', async () => {
  const head = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [
      { run_id: '1'.repeat(32), head_sha: head, id: 42, source: 'imported',
        imported_pr_head_sha: head, checks_commit_sha: head },
      // A newer commit owns this proposal; its own checks start shots.
      { run_id: '2'.repeat(32), head_sha: head, id: 43, source: 'imported',
        imported_pr_head_sha: newer, checks_commit_sha: newer },
      // Someone else retried it first: the rerun is refused and skipped.
      { run_id: '3'.repeat(32), head_sha: head, id: 44, source: 'native',
        reviewed_head_sha: head, checks_commit_sha: head },
    ] };
  } };
  const reruns = [];
  const schedules = [];
  const result = await gc.retryInterrupted({ shots: { execute: true } }, pool, {
    isShuttingDown: () => false,
    stateService: {
      rerunSameHead: async (_pool, runId, options) => {
        reruns.push({ runId, trigger: options.trigger });
        if (runId === '3'.repeat(32)) {
          throw Object.assign(new Error('owner changed'), { code: 'stale_shots_operation' });
        }
        return { id: '9'.repeat(32), head_sha: head, state: 'planned' };
      },
    },
    schedule: async (_config, options) => { schedules.push(options); return { scheduled: true }; },
  });
  assert.deepEqual(result, { examined: 3, scheduled: 1 });
  assert.deepEqual(reruns, [
    { runId: '1'.repeat(32), trigger: 'interrupted-retry' },
    { runId: '3'.repeat(32), trigger: 'interrupted-retry' },
  ]);
  assert.deepEqual(schedules.map(({ sessionId, headSha, trigger }) => ({ sessionId, headSha, trigger })),
    [{ sessionId: 42, headSha: head, trigger: 'interrupted-retry' }]);
  const { sql, params } = queries[0];
  assert.match(sql, /r\.failure_code = 'shots_run_interrupted'/);
  assert.match(sql, /JOIN shot_runs r ON r\.id = cs\.shots_run_id/);
  assert.match(sql, /cs\.status NOT IN \('merged', 'archived'\)/);
  // Two budgets: any cause against the ceiling, and interruptions the
  // shutdown handler did not explain against the original, tighter one.
  assert.match(sql, /retry\.trigger = 'interrupted-retry'\)::int AS interrupted_retries/);
  assert.match(sql, /COALESCE\(crash\.trace_summary->>'interruptedBy', ''\) <> 'shutdown'\)::int AS unexplained_interruptions/);
  assert.match(sql, /n\.interrupted_retries < \$3/);
  assert.match(sql, /n\.unexplained_interruptions <= \$4/);
  // Each retry of a head waits twice as long as the last, up to a cap.
  assert.match(sql, /LEAST\(\$5::bigint, \$1::bigint \* POWER\(2, n\.interrupted_retries\)::bigint\)/);
  assert.deepEqual(params.slice(2),
    [gc.MAX_INTERRUPTED_RETRIES, gc.MAX_UNEXPLAINED_RETRIES, gc.MAX_RETRY_DELAY_MS]);
  assert.equal(gc.MAX_INTERRUPTED_RETRIES, 6);
  assert.equal(gc.MAX_UNEXPLAINED_RETRIES, 2, 'a crash keeps the original budget');

  const disabled = await gc.retryInterrupted({ shots: { execute: false } }, {
    query: async () => { throw new Error('must not query while shots is disabled'); },
  });
  assert.deepEqual(disabled, { examined: 0, scheduled: 0 });
});

test('recovery releases an abandoned current run while preserving longer grace for pre-heartbeat builds', async () => {
  const id = 'a'.repeat(32);
  const queries = [];
  const transitions = [];
  const pool = { query: async (sql, values) => {
    queries.push({ sql: String(sql), values });
    if (String(sql).includes("r.state IN ('planned','provisioning'")) {
      return { rows: [{ id, current_run_id: id, app_slug: 'demo' }] };
    }
    return { rows: [], rowCount: 1 };
  } };
  const result = await gc.recoverInterrupted({ shots: { maxRunMs: 120_000 } }, pool, {
    cleanup: async () => [],
    stateService: { transitionRun: async (_pool, runId, next, patch) => {
      transitions.push({ runId, next, patch });
    } },
  });
  assert.deepEqual(result, { examined: 1, failed: 1, cancelled: 0, cleanupRetried: 0 });
  assert.deepEqual(queries[0].values, [120_000, 20, gc.LEGACY_RUN_GRACE_MS]);
  assert.match(queries[0].sql, /trace_summary.*\? 'progress'/s);
  assert.deepEqual(transitions.map(({ runId, next, patch }) =>
    ({ runId, next, code: patch.failureCode, minIdleMs: patch.recoveryMinIdleMs })),
  [{ runId: id, next: 'failed', code: 'shots_run_interrupted', minIdleMs: gc.LEGACY_RUN_GRACE_MS }]);
  assert.ok(queries.some(({ sql }) => sql.includes("'cleanupComplete', true")));
});

test('recovery retries cleanup left unfinished by a process exit', async () => {
  const id = 'b'.repeat(32);
  const queries = [];
  let cleaned = 0;
  const pool = { query: async (sql) => {
    queries.push(String(sql));
    if (String(sql).includes("WHERE r.state IN ('verified','failed','stale'")) {
      return { rows: [{ id, app_slug: 'demo' }] };
    }
    return { rows: [], rowCount: 1 };
  } };
  const result = await gc.recoverInterrupted({ shots: {} }, pool, {
    cleanup: async () => { cleaned += 1; return []; },
  });
  assert.deepEqual(result, { examined: 0, failed: 0, cancelled: 0, cleanupRetried: 1 });
  assert.equal(cleaned, 1);
  assert.ok(queries.some((sql) => sql.includes("'cleanupComplete', true")));
});

test('recovery leaves a renewed current run and its resources untouched', async () => {
  const id = 'c'.repeat(32);
  let cleanupCalls = 0;
  const pool = { query: async (sql) => ({
    rows: String(sql).includes("r.state IN ('planned','provisioning'")
      ? [{ id, current_run_id: id, app_slug: 'demo', trace_summary: { progress: { phase: 'build_revisions' } } }]
      : [],
  }) };
  const result = await gc.recoverInterrupted({ shots: { maxRunMs: 720_000 } }, pool, {
    stateService: { transitionRun: async () => { throw Object.assign(new Error('renewed'), { code: 'shots_run_active' }); } },
    cleanup: async () => { cleanupCalls += 1; return []; },
  });
  assert.deepEqual(result, { examined: 1, failed: 0, cancelled: 0, cleanupRetried: 0 });
  assert.equal(cleanupCalls, 0);
});

test('superseded recovery fences terminalization to its old owner and idle threshold', async () => {
  const id = 'd'.repeat(32);
  const statements = [];
  const pool = { query: async (sql, values) => {
    statements.push({ sql: String(sql), values });
    if (String(sql).includes("r.state IN ('planned','provisioning'")) {
      return { rows: [{ id, current_run_id: 'e'.repeat(32), app_slug: 'demo' }] };
    }
    return { rows: [], rowCount: 0 };
  } };
  const result = await gc.recoverInterrupted({ shots: { maxRunMs: 720_000 } }, pool, {
    cleanup: async () => { throw new Error('row was no longer stale'); },
  });
  assert.deepEqual(result, { examined: 1, failed: 0, cancelled: 0, cleanupRetried: 0 });
  const update = statements.find(({ sql }) => sql.includes("SET state = 'cancelled'"));
  assert.deepEqual(update.values, [300_000, gc.LEGACY_RUN_GRACE_MS, id]);
  assert.match(update.sql, /s\.shots_run_id IS DISTINCT FROM r\.id/);
  assert.match(update.sql, /r\.updated_at < NOW\(\)/);
});

test('retention uses configured windows and never deletes the current session-owned run', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rowCount: 0, rows: [] };
    },
  };
  await gc.prune(pool, {
    shots: { failedArtifactRetentionHours: 6, failedMetadataRetentionDays: 45 },
  });
  assert.deepEqual(calls.map((call) => call.params[0]), [6, gc.ROLLBACK_MEDIA_DAYS, 45]);
  assert.match(calls[2].sql, /NOT EXISTS[\s\S]*shots_run_id = r\.id/);
});

test('orphan checkout sweep removes only old, inactive, tightly named shots directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shots-gc-test-'));
  try {
    const active = 'usernode-shots-aaaaaaaa-active';
    const orphan = 'usernode-shots-bbbbbbbb-orphan';
    // A checkout the previous release made, named before the rename.
    const legacy = 'usernode-evidence-cccccccc-orphan';
    const unrelated = 'usernode-shots-bad';
    const names = [active, orphan, legacy, unrelated];
    await Promise.all(names.map((name) => fs.mkdir(path.join(root, name))));
    const old = new Date(Date.now() - 120_000);
    await Promise.all(names.map((name) => fs.utimes(path.join(root, name), old, old)));
    const pool = { query: async () => ({ rows: [{ id: 'aaaaaaaa' + '0'.repeat(24) }] }) };
    const result = await gc.sweepOrphanCheckouts(pool, { maxAgeMs: 60_000, tmpDir: root });
    assert.equal(result.removed, 2);
    assert.deepEqual((await fs.readdir(root)).sort(), [active, unrelated].sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cleanup of an interrupted run also removes what the previous release named it', async () => {
  const applicationRuntime = require('../src/services/application-runtime');
  const dbManager = require('../src/services/db-manager');
  const saved = { mode: applicationRuntime.mode, remove: applicationRuntime.remove, drop: dbManager.dropDatabase,
    release: dbManager.releasePreparedCloneSource };
  const removed = [];
  const dropped = [];
  applicationRuntime.mode = () => 'kubernetes';
  applicationRuntime.remove = async (_config, ref) => {
    removed.push(ref.runtimeName);
    // The runtime adapter already treats 404 as a successful no-op.
  };
  dbManager.dropDatabase = async (name) => { dropped.push(name); };
  dbManager.releasePreparedCloneSource = async () => {};
  try {
    const runId = 'd'.repeat(32);
    const errors = await gc.cleanupRunResources({ appRuntime: 'kubernetes' }, { id: runId, app_slug: 'demo' });
    assert.deepEqual(errors, [], 'a legacy name that is not there is not a cleanup failure');
    assert.deepEqual(removed, [
      'sv-shots-dddddddddddddddd-b', 'sv-evidence-dddddddddddddddd-b',
      'sv-shots-dddddddddddddddd-h', 'sv-evidence-dddddddddddddddd-h',
      'sv-app-2147482999-homeroom-shots-dddddddddddddddd',
      'sv-app-2147482999-homeroom-evidence-dddddddddddddddd',
    ]);
    assert.deepEqual(dropped.filter((name) => /_evidence_/.test(name)), [
      dbManager.legacyShotsDbName('demo', runId, 'base'), dbManager.legacyShotsDbName('demo', runId, 'head'),
    ]);
    assert.equal(dropped.filter((name) => /_shots_/.test(name)).length, 2);
  } finally {
    applicationRuntime.mode = saved.mode;
    applicationRuntime.remove = saved.remove;
    dbManager.dropDatabase = saved.drop;
    dbManager.releasePreparedCloneSource = saved.release;
  }
});

test('a draining process neither retries interrupted runs nor recovers unstarted ones', async () => {
  const pool = { query: async () => { throw new Error('must not query while shutting down'); } };
  const schedule = async () => { throw new Error('must not schedule while shutting down'); };
  const config = { shots: { execute: true } };
  assert.deepEqual(await gc.retryInterrupted(config, pool, { isShuttingDown: () => true, schedule }),
    { examined: 0, scheduled: 0 });
  assert.deepEqual(await gc.recoverUnstarted(config, pool, { isShuttingDown: () => true, schedule }),
    { examined: 0, scheduled: 0 });
  // The default reads the process-wide flag the shutdown handler sets.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/services/shots-gc.js'), 'utf8');
  assert.equal((src.match(/isShuttingDown = lifecycle\.isShuttingDown/g) || []).length, 2);
});
