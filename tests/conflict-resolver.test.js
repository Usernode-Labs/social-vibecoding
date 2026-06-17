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
  stub(ids.limits, { checkSystemBudget: async () => ({ ok: true, remaining: 2500 }) });
  stub(ids.syncMain, {
    runSyncMain: async () => ({ ok: true, syncResult: 'clean', behind: 0 }),
    persistConflictState: async () => {},
  });
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
  // #361: the sync draws from the system-token budget. Default to "system
  // budget has headroom"; the exhausted case overrides this with an error.
  limitsImpl = { checkSystemBudget: async () => ({ ok: true, remaining: 2500 }) },
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
  stub(ids.syncMain, { runSyncMain: runSyncMainImpl, persistConflictState: async () => {} });
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

// ── System-token budget gate (#361) ─────────────────────────────────────
// The sync draws from the dedicated system-token budget — never a user's
// allowance or BYOK key. While the budget has headroom the resolve
// proceeds; only an exhausted system budget skips (with the group-chat
// breadcrumb).

test('resolveAndMaybeRetry: system budget with headroom proceeds with the sync', async () => {
  let syncCalls = 0;
  const { subject, restore } = loadResolverForCoalesce({
    limitsImpl: { checkSystemBudget: async () => ({ ok: true, remaining: 1500 }) },
    runSyncMainImpl: async () => {
      syncCalls += 1;
      return { ok: true, syncResult: 'resolved', behind: 0 };
    },
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(syncCalls, 1, 'the sync proceeds against the system budget');
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
    limitsImpl: { checkSystemBudget: async () => ({ error: 'System token budget reached ($25.00). Resets at midnight UTC.' }) },
    runSyncMainImpl: async () => ({ ok: true, syncResult: 'resolved', behind: 0 }),
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(r.reason, 'over_budget');
    assert.equal(startEvents(voteUpdates).length, 0, 'budget gate fires before the start broadcast');
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

test('resolveAndMaybeRetry: exhausted system budget skips and posts the group-chat message', async () => {
  let syncCalls = 0;
  const messages = [];
  const { subject, restore } = loadResolverForCoalesce({
    mergeableSeq: [false],
    limitsImpl: { checkSystemBudget: async () => ({ error: 'System token budget reached ($25.00). Resets at midnight UTC.' }) },
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
    assert.equal(syncCalls, 0, 'no worker turn may run when the system budget is exhausted');
    assert.ok(messages.some((m) => /system token budget is exhausted/.test(m)),
      'the group chat explains the system token budget was exhausted');
  } finally {
    restore();
  }
});

// ── #380: checkAndResolveConflicts resolves only an at-threshold PR ──────────
// The post-merge / post-drift sweep used to fan a worker conflict-resolution
// turn across EVERY promoted sibling. The policy is now strictly on-demand:
// it resolves at most ONE sibling, and only one whose yes-vote count already
// meets the per-app majority threshold (the same bar checkAndMerge gates the
// actual merge on). Among multiple already-eligible PRs it picks the
// highest-voted (longest-waiting on a tie). A PR short of the threshold is
// never pre-emptively resolved. These tests drive checkAndResolveConflicts
// directly against a mock pool that emulates the candidate query's threshold
// filter + ORDER BY / LIMIT 1, with getActiveUserStats stubbed to a fixed
// majority.
function loadResolverForSweep({ siblings, majority = 2 }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    limits: require.resolve('../src/services/limits'),
    syncMain: require.resolve('../src/services/sync-main'),
    activeUsers: require.resolve('../src/services/active-users'),
    pool: require.resolve('../src/db/pool'),
    votes: require.resolve('../src/routes/votes'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/services/conflict-resolver'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  // mergeable: null forever → pollMergeable returns null, needsSync stays
  // false, and resolveWithSession bails at 'no_conflict' WITHOUT a second
  // (fresh) load — so each resolve issues exactly one loadSession call,
  // letting us count resolve cycles by counting those loads.
  const fakeOctokit = async () => ({ request: async () => ({ data: { mergeable: null } }) });
  stub(ids.github, {
    isEnabled: () => true,
    getOctokit: fakeOctokit,
    getInstallationOctokit: fakeOctokit,
  });
  stub(ids.limits, { checkSystemBudget: async () => ({ ok: true, remaining: 2500 }) });
  stub(ids.syncMain, {
    runSyncMain: async () => { throw new Error('runSyncMain must not run on the no_conflict path'); },
    persistConflictState: async () => {},
  });
  // The eligibility gate reads majority from here.
  stub(ids.activeUsers, { getActiveUserStats: async () => ({ active: 3, majority }) });
  stub(ids.votes, { checkAndMerge: async () => { throw new Error('checkAndMerge must not run on the no_conflict path'); } });
  stub(ids.ws, { pushVoteUpdate() {}, sendSystemMessage: async () => {} });

  // Emulate the candidate query's SQL: keep only at-threshold rows
  // (yes_count >= majority), then order yes_count DESC, promoted_at ASC
  // NULLS LAST, created_at ASC, LIMIT 1.
  const rank = (a, b) => {
    if (b.yes_count !== a.yes_count) return b.yes_count - a.yes_count;
    const ap = a.promoted_at, bp = b.promoted_at;
    if (ap == null && bp != null) return 1;      // NULLS LAST
    if (ap != null && bp == null) return -1;
    if (ap != null && bp != null && ap !== bp) return ap - bp; // ASC
    return a.created_at - b.created_at;           // ASC
  };
  const eligibleFrontRunner = () => {
    const eligible = siblings.filter((s) => s.yes_count >= majority);
    if (!eligible.length) return [];
    const sorted = [...eligible].sort(rank);
    return [{ id: sorted[0].id, yes_count: sorted[0].yes_count }];
  };

  const pool = makePool([
    // Candidate query — distinctive `yes_count` projection.
    [/SELECT cs\.id,[\s\S]*yes_count[\s\S]*LIMIT 1/, () => eligibleFrontRunner()],
    // loadSession — return a promoted session row for the requested id.
    [/SELECT cs\.\*, a\.slug/, (params) => {
      const sid = params[0];
      return [{
        id: sid, status: 'promoted', repo_url: 'https://github.com/acme/widget',
        pr_number: 100 + sid, behind_main: 0, user_id: 1, app_id: 5,
        app_slug: 'widget', app_name: 'Widget', app_self_hosted: false,
      }];
    }],
  ]);
  stub(ids.pool, { getPool: () => pool });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  // Ids actually loaded (one loadSession call per resolve cycle).
  const loadedIds = () => pool.calls
    .filter((c) => /SELECT cs\.\*, a\.slug/.test(c.sql))
    .map((c) => c.params[0]);
  return { subject, pool, loadedIds, restore };
}

test('checkAndResolveConflicts: resolves the eligible at-threshold sibling', async () => {
  const { subject, pool, loadedIds, restore } = loadResolverForSweep({
    majority: 2,
    siblings: [
      { id: 11, yes_count: 0, promoted_at: 100, created_at: 100 }, // below threshold
      { id: 12, yes_count: 3, promoted_at: 200, created_at: 200 }, // eligible
      { id: 13, yes_count: 1, promoted_at: 50, created_at: 50 },   // below threshold
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    // The candidate query gates on the threshold and asks for a single row.
    const candidate = pool.calls.find((c) => /SELECT cs\.id,[\s\S]*yes_count/.test(c.sql));
    assert.ok(candidate, 'the candidate query was issued');
    assert.match(candidate.sql, />= \$3/, 'gates on the per-app majority threshold');
    assert.match(candidate.sql, /LIMIT 1/, 'only one sibling is selected');
    assert.match(candidate.sql, /yes_count DESC/, 'ranked by yes votes first');
    assert.match(candidate.sql, /promoted_at ASC NULLS LAST/, 'longest-waiting tiebreak');
    assert.match(candidate.sql, /created_at ASC/, 'deterministic final tiebreak');
    // majority is passed as the third bind param.
    assert.equal(candidate.params[2], 2, 'majority threshold is bound into the query');
    // Exactly one resolve cycle, for the eligible sibling only.
    assert.deepEqual(loadedIds(), [12], 'only the at-threshold sibling is resolved');
  } finally {
    restore();
  }
});

test('checkAndResolveConflicts: resolves nothing when every sibling is below threshold', async () => {
  const { subject, loadedIds, restore } = loadResolverForSweep({
    majority: 2,
    siblings: [
      { id: 31, yes_count: 1, promoted_at: 100, created_at: 100 },
      { id: 32, yes_count: 0, promoted_at: 200, created_at: 200 },
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    assert.deepEqual(loadedIds(), [], 'no pre-emptive resolution for below-threshold PRs');
  } finally {
    restore();
  }
});

test('checkAndResolveConflicts: picks the highest-voted among multiple eligible PRs', async () => {
  const { subject, loadedIds, restore } = loadResolverForSweep({
    majority: 2,
    siblings: [
      { id: 41, yes_count: 2, promoted_at: 100, created_at: 100 }, // eligible
      { id: 42, yes_count: 4, promoted_at: 200, created_at: 200 }, // eligible, most votes
      { id: 43, yes_count: 3, promoted_at: 50, created_at: 50 },   // eligible
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    assert.deepEqual(loadedIds(), [42], 'the most-voted eligible PR is resolved first');
  } finally {
    restore();
  }
});

test('checkAndResolveConflicts: ties among eligible PRs resolve the earlier-promoted one', async () => {
  const { subject, loadedIds, restore } = loadResolverForSweep({
    majority: 2,
    siblings: [
      { id: 21, yes_count: 2, promoted_at: 300, created_at: 300 },
      { id: 22, yes_count: 2, promoted_at: 100, created_at: 100 }, // earlier promoted → wins
      { id: 23, yes_count: 2, promoted_at: 200, created_at: 200 },
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    assert.deepEqual(loadedIds(), [22], 'the longest-waiting of the tied eligible PRs is chosen');
  } finally {
    restore();
  }
});

test('checkAndResolveConflicts: empty queue returns without resolving anything', async () => {
  const { subject, loadedIds, restore } = loadResolverForSweep({ siblings: [] });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    assert.deepEqual(loadedIds(), [], 'no promoted siblings → no resolve cycles');
  } finally {
    restore();
  }
});
