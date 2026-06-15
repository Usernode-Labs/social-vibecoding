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
// And the post-sync "wait for mergeable:true" gate (used by the
// coalescing test, which drives a full resolve+merge cycle).
process.env.CONFLICT_MERGEABLE_TRUE_DELAY_MS = '0';
process.env.CONFLICT_MERGEABLE_AFTER_PUSH_INITIAL_MS = '0';

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
  // The resolver reads mergeability through the PAT-preferred
  // getOctokit (the self-app's repo owner has no App installation).
  const fakeOctokit = async () => ({
    request: async (route, params) => {
      requestCalls.push({ route, params });
      const mergeable = i < mergeableSequence.length
        ? mergeableSequence[i]
        : mergeableSequence[mergeableSequence.length - 1];
      i += 1;
      return { data: { mergeable } };
    },
  });
  stub(ids.github, {
    isEnabled: () => true,
    getOctokit: fakeOctokit,
    getInstallationOctokit: fakeOctokit,
  });
  stub(ids.limits, { resolveBillingPath: async () => ({ apiKey: null, byok: false }) });
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

// ── resolveAndMaybeRetry per-session coalescing ─────────────────────────────
// Two triggers can race on the same session (an explicit trigger + the
// post-merge sibling sweep, or two sweeps from back-to-back merges).
// Without coalescing both call runSyncMain(id) and the second 500s on the
// worker's "a turn is already in flight for session N" guard — the exact
// error seen on the whiteboard #26 run. The wrapper must collapse
// concurrent resolves of one session onto a single in-flight promise.
function loadResolverForCoalesce({
  runSyncMainImpl,
  mergeableSeq = [false, true, true, true],
  // Limit-first (#212): default to "allowance has headroom" so existing
  // tests keep gating through the platform path; over-budget cases
  // override this with a BYOK spillover or an error.
  limitsImpl = { resolveBillingPath: async () => ({ apiKey: null, byok: false }) },
  onSystemMessage = null,
  // #239: the retried merge's result drives the terminal
  // resolutionOutcome (merged vs synced_awaiting_votes).
  checkAndMergeImpl = async () => ({ merged: true }),
}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    limits: require.resolve('../src/services/limits'),
    syncMain: require.resolve('../src/services/sync-main'),
    pool: require.resolve('../src/db/pool'),
    votes: require.resolve('../src/routes/votes'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/services/conflict-resolver'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const sessionRow = {
    id: 7, status: 'promoted', repo_url: 'https://github.com/acme/widget',
    pr_number: 12, behind_main: 0, user_id: 3, app_id: 5,
    app_slug: 'widget', app_name: 'Widget', app_self_hosted: true,
  };
  // pollMergeable → false (forces needsSync); waitForMergeableTrue → true.
  let mi = 0;

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  const fakeOctokit = async () => ({
    request: async () => {
      const mergeable = mi < mergeableSeq.length
        ? mergeableSeq[mi]
        : mergeableSeq[mergeableSeq.length - 1];
      mi += 1;
      return { data: { mergeable } };
    },
  });
  stub(ids.github, {
    isEnabled: () => true,
    getOctokit: fakeOctokit,
    getInstallationOctokit: fakeOctokit,
  });
  stub(ids.limits, limitsImpl);
  stub(ids.syncMain, { runSyncMain: runSyncMainImpl });
  stub(ids.pool, {
    getPool: () => makePool([[/SELECT cs\.\*, a\.slug/, [sessionRow]]]),
  });
  stub(ids.votes, { checkAndMerge: checkAndMergeImpl });
  // #239: record the resolver's lifecycle vote_update broadcasts so
  // tests can assert the start/terminal pair.
  const voteUpdates = [];
  stub(ids.ws, {
    pushVoteUpdate(data) { voteUpdates.push(data); },
    sendSystemMessage: async (_pool, _appId, content) => {
      if (onSystemMessage) onSystemMessage(content);
    },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, voteUpdates, restore };
}

test('resolveAndMaybeRetry: concurrent resolves of one session share a single worker run', async () => {
  let syncCalls = 0;
  const { subject, restore } = loadResolverForCoalesce({
    runSyncMainImpl: async () => {
      syncCalls += 1;
      await new Promise((r) => setTimeout(r, 20)); // hold it in-flight so the second call overlaps
      return { ok: true, syncResult: 'resolved', behind: 0 };
    },
  });
  try {
    // Fire both before awaiting either — they must overlap.
    const p1 = subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    const p2 = subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(syncCalls, 1, 'the second concurrent resolve must coalesce, not spin a second worker');
    assert.equal(r1.reason, 'synced_and_merged');
    assert.deepEqual(r1, r2, 'both callers receive the same result');
  } finally {
    restore();
  }
});

test('resolveAndMaybeRetry: a later, non-overlapping resolve runs a fresh worker turn', async () => {
  let syncCalls = 0;
  const { subject, restore } = loadResolverForCoalesce({
    // Always-conflicting so every resolve genuinely needs a worker sync —
    // isolating "does the in-flight entry clear?" from "did GitHub go
    // clean?". (resolved sync + still-false mergeable → still_conflicting.)
    mergeableSeq: [false],
    runSyncMainImpl: async () => {
      syncCalls += 1;
      return { ok: true, syncResult: 'resolved', behind: 0 };
    },
  });
  try {
    await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    // First resolve has fully settled → the in-flight entry is cleared, so
    // a subsequent trigger is free to run again (not wrongly deduped).
    await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(syncCalls, 2, 'sequential resolves are independent once the prior one settles');
  } finally {
    restore();
  }
});

// ── Limit-first billing gate (#212) ─────────────────────────────────────
// The sync charges the owner's daily allowance first; once exhausted it
// falls back to their BYOK key. Only over-budget AND key-less owners are
// skipped (with the group-chat breadcrumb).

test('resolveAndMaybeRetry: over-budget owner WITH a BYOK key syncs on the key instead of skipping', async () => {
  let syncCalls = 0;
  const { subject, restore } = loadResolverForCoalesce({
    // Allowance exhausted, key on file → spillover path.
    limitsImpl: { resolveBillingPath: async () => ({ apiKey: 'sk-ant-test', byok: true }) },
    runSyncMainImpl: async () => {
      syncCalls += 1;
      return { ok: true, syncResult: 'resolved', behind: 0 };
    },
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(syncCalls, 1, 'the sync must proceed on the owner key, not skip');
    assert.equal(r.reason, 'synced_and_merged');
  } finally {
    restore();
  }
});

// ── #239: resolution lifecycle broadcasts ──────────────────────────────
// The resolver emits vote_update { resolving:true } right before the
// worker sync starts (past the needsSync + billing gates, so no-op
// sweeps never flash the banner) and exactly one terminal
// { resolving:false, resolutionOutcome } when the deduped promise
// settles. Clients drive the platform banner and vote-panel badge off
// these.

const startEvents = (updates) => updates.filter((u) => u.resolving === true);
const terminalEvents = (updates) => updates.filter((u) => u.resolving === false);

test('lifecycle: start broadcast fires before a real sync, terminal maps synced_and_merged → merged', async () => {
  const { subject, voteUpdates, restore } = loadResolverForCoalesce({
    runSyncMainImpl: async () => ({ ok: true, syncResult: 'resolved', behind: 0 }),
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(r.reason, 'synced_and_merged');

    const starts = startEvents(voteUpdates);
    assert.equal(starts.length, 1, 'exactly one start broadcast');
    assert.equal(starts[0].sessionId, 7);
    assert.equal(starts[0].appSlug, 'widget');
    assert.equal(starts[0].selfHosted, true);

    const terminals = terminalEvents(voteUpdates);
    assert.equal(terminals.length, 1, 'exactly one terminal broadcast');
    assert.equal(terminals[0].sessionId, 7);
    assert.equal(terminals[0].appSlug, 'widget');
    assert.equal(terminals[0].resolutionOutcome, 'merged');
    assert.equal(terminals[0].selfHosted, true);
  } finally {
    restore();
  }
});

test('lifecycle: no start broadcast on the no_conflict early-bail path', async () => {
  const { subject, voteUpdates, restore } = loadResolverForCoalesce({
    // GitHub never settles (null forever) + behind_main 0 → no sync runs.
    mergeableSeq: [null],
    runSyncMainImpl: async () => {
      throw new Error('sync must not run on the no_conflict path');
    },
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(r.reason, 'no_conflict');
    assert.equal(startEvents(voteUpdates).length, 0, 'no-op resolves must not flash the banner');
    const terminals = terminalEvents(voteUpdates);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].resolutionOutcome, 'noop');
  } finally {
    restore();
  }
});

test('lifecycle: synced but not merged (awaiting votes) → resolutionOutcome synced', async () => {
  const { subject, voteUpdates, restore } = loadResolverForCoalesce({
    runSyncMainImpl: async () => ({ ok: true, syncResult: 'resolved', behind: 0 }),
    checkAndMergeImpl: async () => ({ merged: false, yesCount: 1, needed: 2 }),
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(r.reason, 'synced_awaiting_votes');
    const terminals = terminalEvents(voteUpdates);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].resolutionOutcome, 'synced');
  } finally {
    restore();
  }
});

test('lifecycle: unresolved conflict → resolutionOutcome failed (after a start broadcast)', async () => {
  const { subject, voteUpdates, restore } = loadResolverForCoalesce({
    runSyncMainImpl: async () => ({ ok: false, syncResult: 'conflict', behind: 2 }),
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(r.reason, 'unresolved_conflict');
    assert.equal(startEvents(voteUpdates).length, 1, 'a real sync ran, so the start fired');
    const terminals = terminalEvents(voteUpdates);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].resolutionOutcome, 'failed');
  } finally {
    restore();
  }
});

test('lifecycle: over-budget skip → resolutionOutcome failed with NO start broadcast', async () => {
  const { subject, voteUpdates, restore } = loadResolverForCoalesce({
    mergeableSeq: [false],
    limitsImpl: { resolveBillingPath: async () => ({ error: 'Daily limit reached.' }) },
    runSyncMainImpl: async () => ({ ok: true, syncResult: 'resolved', behind: 0 }),
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(r.reason, 'over_budget');
    assert.equal(startEvents(voteUpdates).length, 0, 'billing gate fires before the start broadcast');
    const terminals = terminalEvents(voteUpdates);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].resolutionOutcome, 'failed');
  } finally {
    restore();
  }
});

test('lifecycle: two concurrent resolves of one session produce a single start/terminal pair', async () => {
  const { subject, voteUpdates, restore } = loadResolverForCoalesce({
    runSyncMainImpl: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, syncResult: 'resolved', behind: 0 };
    },
  });
  try {
    const p1 = subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    const p2 = subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    await Promise.all([p1, p2]);
    assert.equal(startEvents(voteUpdates).length, 1, 'coalesced resolves share one start');
    assert.equal(terminalEvents(voteUpdates).length, 1, 'coalesced resolves share one terminal');
  } finally {
    restore();
  }
});

test('isResolving: true while the deduped promise is in flight, false after it settles', async () => {
  const { subject, restore } = loadResolverForCoalesce({
    runSyncMainImpl: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, syncResult: 'resolved', behind: 0 };
    },
  });
  try {
    assert.equal(subject.isResolving(7), false, 'idle before any resolve');
    const p = subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(subject.isResolving(7), true, 'in flight while the promise is pending');
    assert.equal(subject.isResolving(8), false, 'scoped per session');
    await p;
    assert.equal(subject.isResolving(7), false, 'cleared once the resolve settles');
  } finally {
    restore();
  }
});

test('resolveAndMaybeRetry: over-budget owner with NO key skips and posts the group-chat message', async () => {
  let syncCalls = 0;
  const messages = [];
  const { subject, restore } = loadResolverForCoalesce({
    mergeableSeq: [false],
    limitsImpl: { resolveBillingPath: async () => ({ error: 'Daily limit reached ($25.00). Resets at midnight UTC.' }) },
    runSyncMainImpl: async () => {
      syncCalls += 1;
      return { ok: true, syncResult: 'resolved', behind: 0 };
    },
    onSystemMessage: (content) => messages.push(content),
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'over_budget');
    assert.equal(syncCalls, 0, 'no worker turn may run for an over-budget key-less owner');
    assert.ok(messages.some((m) => /daily LLM limit/.test(m)),
      'the owner is told in group chat why the auto-resolve was skipped');
  } finally {
    restore();
  }
});
