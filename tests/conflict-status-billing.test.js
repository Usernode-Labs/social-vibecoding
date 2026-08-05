// #361: tests for the merge-conflict status + system-token budget work.
//
// Covers:
//   1. worker.parseLine() pulls conflict_files off the MODE=sync
//      __USERNODE_RESULT__ line into state.conflictFiles.
//   2. runSyncMain() gates on limits.checkSystemBudget (skips + throws
//      the system-budget message when exhausted) and records the turn's
//      cost to system_token_usage rather than llm_usage.
//   3. runSyncMain() persists the derived merge_conflict_state /
//      conflict_files snapshot (failed on an unresolved conflict, clean
//      otherwise).
//
// Run with: node --test tests/conflict-status-billing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/worker');

// ── worker.parseLine: conflict_files ───────────────────────────────────

test('parseLine pulls conflict_files (CSV) into state.conflictFiles', () => {
  const state = worker.newWatchState();
  worker.parseLine(
    '__USERNODE_RESULT__ cc_exit=0 ahead=1 behind=0 sha=abc1234 push_ok=1 mode=sync sync_result=resolved conflict_files=src/app.js,public/index.html',
    () => {},
    state
  );
  assert.deepEqual(state.conflictFiles, ['src/app.js', 'public/index.html']);
  assert.equal(state.syncResult, 'resolved');
});

test('parseLine: empty conflict_files yields an empty array', () => {
  const state = worker.newWatchState();
  worker.parseLine(
    '__USERNODE_RESULT__ cc_exit=0 ahead=0 behind=0 sha=abc push_ok=1 mode=sync sync_result=clean conflict_files=',
    () => {},
    state
  );
  assert.deepEqual(state.conflictFiles, []);
});

test('newWatchState seeds conflictFiles as an empty array', () => {
  assert.deepEqual(worker.newWatchState().conflictFiles, []);
});

// ── sync-main: system-budget gate + record + conflict-state persist ────

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Route pool queries by SQL so platform_settings (the system cap) and
// system_token_usage (today's spend) can return distinct, test-driven
// rows. `sysSpent` controls whether checkSystemBudget passes.
function makePool({ sysCap = 2500, sysSpent = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM platform_settings/.test(sql)) {
        return { rows: [{ value: String(sysCap) }] };
      }
      if (/SELECT cost_cents FROM system_token_usage/.test(sql)) {
        return { rows: [{ cost_cents: sysSpent }] };
      }
      if (/Claude Code progress/.test(sql)) return { rows: [{ id: 99 }] };
      return { rows: [] };
    },
  };
}

function loadSyncMain({ execImpl }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    worker: require.resolve('../src/services/worker'),
    ws: require.resolve('../src/services/ws'),
    sessionBus: require.resolve('../src/services/session-bus'),
    events: require.resolve('../src/services/events'),
    subject: require.resolve('../src/services/sync-main'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const execCalls = [];
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.worker, {
    ensureWorkerImage: async () => {},
    ensureWorker: async () => {},
    // #937: runSyncMain retires any pending stop before its own dispatch
    // — a sync turn is a new turn, and it is not in stopRegistry, so
    // nothing else would ever clear a flag left by an earlier chat stop.
    clearPendingStop: () => {},
    execInWorker: async (sessionId, opts) => {
      execCalls.push({ sessionId, opts });
      return execImpl(opts);
    },
  });
  stub(ids.ws, { pushSessionUpdate() {}, broadcastGlobal() {} });
  stub(ids.sessionBus, { publish() {} });
  stub(ids.events, { record() {}, EVENT_TYPES: { SYNC_MAIN: 'sync_main' } });

  // limits stays REAL — it's the unit under test for the gate/record.
  // Invalidate its cache so the routed pool's cap value is read fresh.
  require('../src/services/limits').invalidate();

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    require('../src/services/limits').invalidate();
  };
  return { subject, execCalls, restore };
}

function ownerRow(overrides = {}) {
  return {
    id: 7, user_id: 3, app_id: 5, app_slug: 'widget', branch_name: 'dev/x-1',
    repo_url: 'https://github.com/acme/widget', behind_main: 2,
    ...overrides,
  };
}

const sysSpendInserts = (pool) => pool.calls.filter((c) => /INSERT INTO system_token_usage/.test(c.sql));
const llmSpendInserts = (pool) => pool.calls.filter((c) => /INSERT INTO llm_usage/.test(c.sql));
const conflictStateUpdates = (pool) => pool.calls.filter(
  (c) => /UPDATE chat_sessions/.test(c.sql) && /merge_conflict_state/.test(c.sql)
);

test('runSyncMain records the turn cost to system_token_usage, never llm_usage', async () => {
  const { subject, execCalls, restore } = loadSyncMain({
    execImpl: async () => ({ syncResult: 'resolved', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0, costUsd: 0.20, conflictFiles: ['src/app.js'] }),
  });
  try {
    const pool = makePool({ sysCap: 2500, sysSpent: 0 });
    const res = await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: ownerRow() });
    assert.equal(res.ok, true);
    // platform key path only — no BYOK key read, no user llm_usage write.
    assert.equal(llmSpendInserts(pool).length, 0, 'must not bill any user llm_usage');
    const sys = sysSpendInserts(pool);
    assert.equal(sys.length, 1, 'one system_token_usage upsert');
    assert.equal(sys[0].params[0], 20, '$0.20 → 20 cents');
    // platform key forced: execInWorker called with no anthropic key.
    assert.equal(execCalls[0].opts.anthropicApiKey, null);
  } finally {
    restore();
  }
});

test('runSyncMain skips + throws the system-budget message when the budget is exhausted', async () => {
  const { subject, execCalls, restore } = loadSyncMain({
    execImpl: async () => ({ syncResult: 'clean', behind: 0, sha: 'abc', pushOk: true, exitCode: 0, costUsd: 0.1 }),
  });
  try {
    const pool = makePool({ sysCap: 2500, sysSpent: 2500 }); // at cap
    await assert.rejects(
      () => subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: ownerRow() }),
      /System token budget reached/
    );
    assert.equal(execCalls.length, 0, 'no worker turn runs when over budget');
    assert.equal(sysSpendInserts(pool).length, 0, 'nothing recorded when the gate fails');
  } finally {
    restore();
  }
});

test('runSyncMain persists merge_conflict_state=failed with the conflicting files on an unresolved conflict', async () => {
  const { subject, restore } = loadSyncMain({
    execImpl: async () => ({ syncResult: 'conflict', behind: 2, sha: '', pushOk: false, exitCode: 0, costUsd: 0.05, conflictFiles: ['src/app.js', 'public/index.html'] }),
  });
  try {
    const pool = makePool();
    const res = await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: ownerRow() });
    assert.equal(res.ok, false);
    const upd = conflictStateUpdates(pool);
    assert.equal(upd.length, 1, 'one conflict-state persist');
    assert.equal(upd[0].params[0], 'failed');
    assert.deepEqual(JSON.parse(upd[0].params[1]), ['src/app.js', 'public/index.html']);
  } finally {
    restore();
  }
});

test('runSyncMain persists merge_conflict_state=clean with no files on a resolved sync', async () => {
  const { subject, restore } = loadSyncMain({
    execImpl: async () => ({ syncResult: 'resolved', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0, costUsd: 0.05, conflictFiles: ['src/app.js'] }),
  });
  try {
    const pool = makePool();
    await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: ownerRow() });
    const upd = conflictStateUpdates(pool);
    assert.equal(upd.length, 1);
    assert.equal(upd[0].params[0], 'clean');
    assert.deepEqual(JSON.parse(upd[0].params[1]), []);
  } finally {
    restore();
  }
});
