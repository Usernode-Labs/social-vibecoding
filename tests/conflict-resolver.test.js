// Tests for the worker-based auto-conflict-resolver.
//
// Covers two guarantees the re-architecture depends on:
//   1. pollMergeable() waits out GitHub's `mergeable: null` window
//      instead of treating null as "no conflict" (the old no-op bug).
//   2. runSyncMain()'s push path never deletes pr_votes — that's what
//      lets an already-approved PR auto-retry its merge after a sync.
//
// Like the other suites we stub collaborators via require.cache so
// nothing real (GitHub, worker, docker) spins up.
//
// Run with: node --test tests/conflict-resolver.test.js

// Make pollMergeable's backoff instant for the suite.
process.env.CONFLICT_MERGEABLE_POLL_DELAY_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mock pool ───────────────────────────────────────────────────────────
function makePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
    issued(re) { return calls.some((c) => re.test(c.sql)); },
  };
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// ── pollMergeable ─────────────────────────────────────────────────────────
// Loads conflict-resolver with a stubbed github whose octokit.request
// returns a scripted sequence of `mergeable` values.
function loadResolverWithGithub(mergeableSequence) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    limits: require.resolve('../src/services/limits'),
    syncMain: require.resolve('../src/services/sync-main'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/conflict-resolver'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  let i = 0;
  const requestCalls = [];
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, {
    isEnabled: () => true,
    getInstallationOctokit: async () => ({
      request: async (route, params) => {
        requestCalls.push({ route, params });
        const mergeable = i < mergeableSequence.length
          ? mergeableSequence[i]
          : mergeableSequence[mergeableSequence.length - 1];
        i += 1;
        return { data: { mergeable } };
      },
    }),
  });
  stub(ids.limits, { checkBudget: async () => ({ error: null }) });
  stub(ids.syncMain, { runSyncMain: async () => ({ ok: true, syncResult: 'clean', behind: 0 }) });
  stub(ids.pool, { getPool: () => makePool([]) });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, requestCalls, restore };
}

test('pollMergeable: waits out null, then returns false once GitHub settles', async () => {
  const { subject, requestCalls, restore } = loadResolverWithGithub([null, null, false]);
  try {
    const result = await subject.pollMergeable('acme', 'widget', 12);
    assert.equal(result, false);
    assert.equal(requestCalls.length, 3, 'should poll until mergeable is non-null');
  } finally {
    restore();
  }
});

test('pollMergeable: returns true immediately when GitHub already computed', async () => {
  const { subject, requestCalls, restore } = loadResolverWithGithub([true]);
  try {
    const result = await subject.pollMergeable('acme', 'widget', 7);
    assert.equal(result, true);
    assert.equal(requestCalls.length, 1, 'no extra polling once a boolean is seen');
  } finally {
    restore();
  }
});

test('pollMergeable: returns null when GitHub never settles within the budget', async () => {
  // Sequence stays null forever → exhausts MERGEABLE_POLL_TRIES (6).
  const { subject, requestCalls, restore } = loadResolverWithGithub([null]);
  try {
    const result = await subject.pollMergeable('acme', 'widget', 99);
    assert.equal(result, null);
    assert.equal(requestCalls.length, 6, 'gives up after the configured number of tries');
  } finally {
    restore();
  }
});

// ── runSyncMain vote-preservation ──────────────────────────────────────────
function loadSyncMainWithWorker(workerResult) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    worker: require.resolve('../src/services/worker'),
    activeWorkers: require.resolve('../src/services/active-workers'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/services/sync-main'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const execCalls = [];
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.worker, {
    ensureWorkerImage: async () => {},
    ensureWorker: async () => {},
    execInWorker: async (sessionId, opts) => { execCalls.push({ sessionId, opts }); return workerResult; },
  });
  // Real active-workers Set is harmless; keep it.
  stub(ids.ws, { pushSessionUpdate() {} });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, execCalls, restore };
}

test('runSyncMain: resolved sync never deletes pr_votes (approval survives)', async () => {
  const { subject, execCalls, restore } = loadSyncMainWithWorker({
    syncResult: 'resolved', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0,
  });
  try {
    const pool = makePool([
      [/SELECT anthropic_key_enc/, []],
      [/UPDATE chat_sessions SET behind_main/, []],
      [/INSERT INTO chat_session_messages/, []],
    ]);
    const sessionRow = {
      id: 7, user_id: 3, app_slug: 'widget', branch_name: 'dev/x-1',
      repo_url: 'https://github.com/acme/widget',
    };
    const res = await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow });

    assert.equal(res.ok, true);
    assert.equal(res.syncResult, 'resolved');
    assert.equal(res.behind, 0);
    // The whole point: a conflict-resolution sync must NOT wipe votes.
    assert.equal(pool.issued(/DELETE FROM pr_votes/), false, 'sync push must not reset votes');
    // It drove exactly one MODE=sync worker turn.
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].opts.mode, 'sync');
  } finally {
    restore();
  }
});

test('runSyncMain: conflict outcome reports not-ok and still avoids vote deletion', async () => {
  const { subject, restore } = loadSyncMainWithWorker({
    syncResult: 'conflict', behind: 2, sha: '', pushOk: false, exitCode: 0,
  });
  try {
    const pool = makePool([
      [/SELECT anthropic_key_enc/, []],
      [/UPDATE chat_sessions SET behind_main/, []],
      [/INSERT INTO chat_session_messages/, []],
    ]);
    const sessionRow = {
      id: 8, user_id: 4, app_slug: 'w', branch_name: 'dev/y-2',
      repo_url: 'https://github.com/acme/w',
    };
    const res = await subject.runSyncMain({ jwtSecret: 's' }, pool, 8, { sessionRow });
    assert.equal(res.ok, false);
    assert.equal(res.syncResult, 'conflict');
    assert.equal(pool.issued(/DELETE FROM pr_votes/), false);
  } finally {
    restore();
  }
});
