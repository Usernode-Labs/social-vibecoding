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

// The REAL pure merge gate, grabbed before any stubbing — the drain's
// eligibility filter (eased threshold + visibility window) runs it verbatim.
const { mergeGate: realMergeGate } = require('../src/services/active-users');

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
  // #384: tests can swap in a spy to assert WHICH merge_conflict_state
  // snapshots the resolver persists (e.g. that it never writes 'conflict'
  // off a mergeability check). Defaults to the no-op the other cases use.
  persistConflictStateImpl = async () => {},
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
  stub(ids.syncMain, { runSyncMain: runSyncMainImpl, persistConflictState: persistConflictStateImpl });
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

// ── #384: no speculative 'conflict' snapshot off a mergeability check ───
// A `mergeable0 === false` poll means GitHub thinks the branch would not
// merge cleanly — but the platform has NOT attempted an auto-merge yet.
// The resolver must NOT persist merge_conflict_state='conflict' off that
// check (that's the speculative ⚠ warning #384 removes). It still drives
// needsSync off the same value, writes 'resolving' before the sync, and
// lets sync-main own the terminal 'failed'/'clean' snapshot.

test('#384: a mergeable0===false check never persists a speculative conflict snapshot', async () => {
  const persistCalls = [];
  let syncCalls = 0;
  const { subject, restore } = loadResolverForCoalesce({
    // mergeable: false on the first (pollMergeable) read forces needsSync;
    // true thereafter so the post-sync gate lets the retried merge proceed.
    mergeableSeq: [false, true, true, true],
    persistConflictStateImpl: async (_pool, _session, snapshot) => {
      persistCalls.push(snapshot);
    },
    runSyncMainImpl: async () => {
      syncCalls += 1;
      return { ok: true, syncResult: 'resolved', behind: 0 };
    },
  });
  try {
    const r = await subject.resolveAndMaybeRetry({ jwtSecret: 's' }, { sessionId: 7 });
    assert.equal(syncCalls, 1, 'needsSync is still driven off mergeable0===false');
    assert.equal(r.reason, 'synced_and_merged');

    const states = persistCalls.map((s) => s.state);
    assert.ok(
      !states.includes('conflict'),
      `resolver must not persist a speculative 'conflict' snapshot; saw: ${JSON.stringify(states)}`
    );
    assert.ok(
      states.includes('resolving'),
      'the in-flight resolve still snapshots a resolving state before the sync'
    );
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

// ── #380 + app-level drain: checkAndResolveConflicts only at-threshold PRs ────
// The post-merge / post-drift sweep used to fan a worker conflict-resolution
// turn across EVERY promoted sibling. The policy is on-demand AND serialized
// per app: it resolves only PRs whose yes-vote count already meets the
// per-app majority threshold (the same bar checkAndMerge gates the actual
// merge on), one at a time, draining them highest-voted first (longest-
// waiting on a tie). A PR short of the threshold is never pre-emptively
// resolved. These tests drive checkAndResolveConflicts directly against a
// mock pool that emulates the candidate query's threshold + attempted-set
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
  // The eligibility gate reads the active count from here and applies the
  // REAL dynamic merge gate (mergeGate: eased threshold + visibility window).
  // With active=3 and no No votes, requiredVotes(3,0)=2 and any at-threshold
  // row's window is 0 (yes >= M) — so `majority: 2` scenarios behave exactly
  // as they did under the old fixed-majority SQL predicate.
  stub(ids.activeUsers, { getActiveUserStats: async () => ({ active: 3, majority }), mergeGate: realMergeGate });
  stub(ids.votes, { checkAndMerge: async () => { throw new Error('checkAndMerge must not run on the no_conflict path'); } });
  stub(ids.ws, { pushVoteUpdate() {}, sendSystemMessage: async () => {} });

  // The candidate query now fetches EVERY non-excluded promoted sibling
  // (with yes/no counts and timestamps) and the drain applies the dynamic
  // gate + ordering in JS — so the mock just honours the trigger ($2) and
  // attempted-set ($3) exclusions and returns the raw rows. Eligibility
  // (threshold + window) and the yes_count DESC / promoted_at ASC NULLS
  // LAST / created_at ASC ranking are exercised for real in the resolver.
  const candidateRows = (params) => {
    const excluded = new Set();
    if (params && params[1]) excluded.add(params[1]);
    for (const a of (params && params[2]) || []) excluded.add(a);
    return siblings
      .filter((s) => !excluded.has(s.id))
      .map((s) => ({ unblocked: true, no_count: 0, ...s }));
  };

  const pool = makePool([
    // Candidate query — distinctive `cs.promoted_at, cs.created_at` +
    // yes/no tally projection.
    [/SELECT cs\.id, cs\.promoted_at[\s\S]*yes_count[\s\S]*FROM chat_sessions/, (params) => candidateRows(params)],
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
      { id: 11, yes_count: 0, promoted_at: 100, created_at: 100 }, // no support: no gate path
      { id: 12, yes_count: 3, promoted_at: 200, created_at: 200 }, // eligible (threshold)
      // Below threshold AND no unopposed Yes lead (tie) — the lazy-consensus
      // clock never arms, so this stays ineligible even at an ancient anchor.
      { id: 13, yes_count: 1, no_count: 1, promoted_at: 50, created_at: 50 },
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    // The candidate query fetches every non-excluded promoted sibling with
    // its yes/no tallies; eligibility (the dynamic merge gate) and the
    // ranking now run in JS inside the drain.
    const candidate = pool.calls.find((c) => /SELECT cs\.id, cs\.promoted_at[\s\S]*yes_count/.test(c.sql));
    assert.ok(candidate, 'the candidate query was issued');
    assert.match(candidate.sql, /vote = 'no'/, 'fetches the No tally the gate needs');
    assert.equal(candidate.params[1], 9, 'the just-merged trigger is excluded');
    // Exactly one resolve cycle, for the eligible sibling only.
    assert.deepEqual(loadedIds(), [12], 'only the at-threshold sibling is resolved');
  } finally {
    restore();
  }
});

test('checkAndResolveConflicts: resolves nothing when no sibling has a merge path', async () => {
  const { subject, loadedIds, restore } = loadResolverForSweep({
    majority: 2,
    siblings: [
      // Tie → lazy clock never arms; below threshold → no threshold path.
      { id: 31, yes_count: 1, no_count: 1, promoted_at: 100, created_at: 100 },
      { id: 32, yes_count: 0, promoted_at: 200, created_at: 200 },
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    assert.deepEqual(loadedIds(), [], 'no pre-emptive resolution without a merge path');
  } finally {
    restore();
  }
});

test('checkAndResolveConflicts: an elapsed lazy-consensus sibling is eligible', async () => {
  const { subject, loadedIds, restore } = loadResolverForSweep({
    majority: 2,
    siblings: [
      // Below threshold (1 < 2) but unopposed with an ancient anchor — the
      // lazy-consensus clock elapsed long ago, so the drain resolves it.
      { id: 51, yes_count: 1, promoted_at: 100, created_at: 100 },
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    assert.deepEqual(loadedIds(), [51], 'lazy-consensus sibling enters the drain');
  } finally {
    restore();
  }
});

test('checkAndResolveConflicts: drains eligible PRs highest-voted first, one at a time', async () => {
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
    // The app-level drain resolves every eligible sibling sequentially in
    // priority order (most votes first), not just the front-runner.
    assert.deepEqual(loadedIds(), [42, 43, 41], 'drains all eligible, most-voted first');
  } finally {
    restore();
  }
});

test('checkAndResolveConflicts: ties drain earlier-promoted first', async () => {
  const { subject, loadedIds, restore } = loadResolverForSweep({
    majority: 2,
    siblings: [
      { id: 21, yes_count: 2, promoted_at: 300, created_at: 300 },
      { id: 22, yes_count: 2, promoted_at: 100, created_at: 100 }, // earlier promoted → first
      { id: 23, yes_count: 2, promoted_at: 200, created_at: 200 },
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    // All tied on votes → longest-waiting (earliest promoted_at) drains first.
    assert.deepEqual(loadedIds(), [22, 23, 21], 'tied eligible PRs drain longest-waiting first');
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

// ── app-level single-flight: only one drain per app at a time ────────────────
// This is the fix for "multiple proposals resolving conflicts at once": every
// resolve trigger (direct vote, post-merge sweep, drift poller) funnels through
// checkAndResolveConflicts, which serializes per app. Concurrent triggers for
// the same app must NOT spin up parallel resolves — the second joins the
// in-flight drain.
test('checkAndResolveConflicts: concurrent triggers for one app coalesce into a single drain', async () => {
  const { subject, loadedIds, restore } = loadResolverForSweep({
    majority: 2,
    siblings: [
      { id: 12, yes_count: 3, promoted_at: 100, created_at: 100 }, // single eligible
    ],
  });
  try {
    // Fire two triggers for the same app before awaiting either. The second
    // must join the running drain rather than start a parallel one — so the
    // single eligible PR is resolved exactly once, not once per trigger.
    // (Promise identity isn't asserted: checkAndResolveConflicts is an async
    // function, so each call returns a distinct wrapper promise even though
    // both await the same underlying drain.)
    const p1 = subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5 });
    const p2 = subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5 });
    await Promise.all([p1, p2]);
    assert.deepEqual(loadedIds(), [12], 'the eligible PR is resolved once, not once per trigger');
  } finally {
    restore();
  }
});

test('isAppResolving: true while a drain runs, false once it settles', async () => {
  const { subject, restore } = loadResolverForSweep({
    majority: 2,
    siblings: [{ id: 12, yes_count: 3, promoted_at: 100, created_at: 100 }],
  });
  try {
    assert.equal(subject.isAppResolving(5), false, 'idle before any drain');
    const p = subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5 });
    assert.equal(subject.isAppResolving(5), true, 'in flight while the drain runs');
    assert.equal(subject.isAppResolving(99), false, 'scoped per app');
    await p;
    assert.equal(subject.isAppResolving(5), false, 'cleared once the drain settles');
  } finally {
    restore();
  }
});

// ── #391: two-phase drain — merge clean first, resolve blocked last ──────────
// Before #391 the drain attempted the highest-voted PR first and ran its
// (minutes-long) worker sync inline inside the single-flight drain, freezing
// clean lower-voted siblings behind it. The drain now runs in two phases:
// Phase 1 merges every directly-mergeable eligible PR (vote priority) without
// ever syncing — a PR that needs a sync is deferred — and Phase 2 then
// resolves the deferred (blocked) PRs. These tests drive the real drainApp
// (via checkAndResolveConflicts) against a model pool/github/worker so we can
// assert the ORDER of merges vs. worker syncs.
//
// Each sibling carries live state the candidate query reads: yes_count,
// promoted_at, created_at, behind_main, merge_conflict_state, status, and the
// `mergeable` value GitHub reports for its PR (pr_number === 100 + id). A
// blocked PR is one with behind_main > 0 and/or mergeable === false; its
// runSyncMain outcome is configurable ('resolved' clears the block, 'conflict'
// leaves it stuck).
function loadResolverForPhases({ siblings, majority = 2 }) {
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

  // Live sibling table, keyed by id. Defaults: clean & directly mergeable.
  const byId = new Map();
  for (const s of siblings) {
    byId.set(s.id, {
      id: s.id,
      yes_count: s.yes_count,
      promoted_at: s.promoted_at,
      created_at: s.created_at,
      behind_main: s.behind_main || 0,
      merge_conflict_state: s.merge_conflict_state || null,
      status: 'promoted',
      mergeable: s.mergeable === undefined ? true : s.mergeable,
      syncOutcome: s.syncOutcome || 'resolved', // 'resolved' | 'conflict'
    });
  }
  const byPr = (pr) => [...byId.values()].find((s) => 100 + s.id === pr);

  // Ordered event log: ['merge', id] and ['sync', id] in call order.
  const events = [];
  const voteUpdates = [];
  const sysMessages = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });

  // GitHub: report each PR's current mergeable. pollMergeable /
  // waitForMergeableTrue both read this; a 'resolved' sync flips it true.
  const fakeOctokit = async () => ({
    request: async (_route, params) => {
      const s = byPr(params.pull_number);
      return { data: { mergeable: s ? s.mergeable : null } };
    },
  });
  stub(ids.github, { isEnabled: () => true, getOctokit: fakeOctokit, getInstallationOctokit: fakeOctokit });
  stub(ids.limits, { checkSystemBudget: async () => ({ ok: true, remaining: 2500 }) });

  // Worker sync: record the call, then apply the configured outcome.
  stub(ids.syncMain, {
    runSyncMain: async (_config, _pool, sessionId) => {
      events.push(['sync', sessionId]);
      const s = byId.get(sessionId);
      if (s && s.syncOutcome === 'resolved') {
        s.behind_main = 0;
        s.mergeable = true;
        return { ok: true, syncResult: 'resolved', behind: 0 };
      }
      return { ok: true, syncResult: 'conflict', behind: s ? s.behind_main : 0 };
    },
    // Keep the model's merge_conflict_state in step with what the resolver
    // persists so the candidate query's blocked/unblocked sort key is honest.
    persistConflictState: async (_pool, session, { state }) => {
      const s = byId.get(session.id);
      if (s) s.merge_conflict_state = state;
    },
  });

  stub(ids.activeUsers, { getActiveUserStats: async () => ({ active: 3, majority }), mergeGate: realMergeGate });

  // checkAndMerge: by the time the resolver calls it the branch is mergeable,
  // so record the merge and drop the PR out of 'promoted'.
  stub(ids.votes, {
    checkAndMerge: async (_config, _pool, fresh) => {
      events.push(['merge', fresh.id]);
      const s = byId.get(fresh.id);
      if (s) s.status = 'merged';
      return { merged: true };
    },
  });
  stub(ids.ws, {
    pushVoteUpdate(data) { voteUpdates.push(data); },
    sendSystemMessage: async (_pool, _appId, content) => { sysMessages.push(content); },
  });

  // Candidate query: the drain now fetches every promoted, non-excluded
  // sibling (with yes/no tallies, timestamps, and the DB-computed
  // `unblocked` sort key) and applies the dynamic gate + the #391 ranking
  // in JS — so the mock returns raw rows and only honours the exclusions.
  // `unblocked` mirrors the query's expression, minus check_state (these
  // scenarios predate checks and carry none — treat that as unblocked, as
  // the pre-#47 emulation did).
  const blocked = (s) => !(s.behind_main === 0
    && !['conflict', 'failed', 'resolving'].includes(s.merge_conflict_state || 'clean'));
  const candidate = (params) => {
    const excluded = new Set();
    if (params && params[1]) excluded.add(params[1]);
    for (const a of (params && params[2]) || []) excluded.add(a);
    return [...byId.values()]
      .filter((s) => s.status === 'promoted' && !excluded.has(s.id))
      .map((s) => ({ no_count: 0, unblocked: !blocked(s), ...s }));
  };

  const pool = makePool([
    [/SELECT cs\.id, cs\.promoted_at[\s\S]*yes_count[\s\S]*FROM chat_sessions/, candidate],
    [/SELECT cs\.\*, a\.slug/, (params) => {
      const s = byId.get(params[0]);
      if (!s) return [];
      return [{
        ...s, repo_url: 'https://github.com/acme/widget', pr_number: 100 + s.id,
        user_id: 1, app_id: 5, app_slug: 'widget', app_name: 'Widget',
        app_self_hosted: false, conflict_files: [],
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
  return { subject, events, voteUpdates, sysMessages, restore };
}

test('#391: a blocked top-voted PR does not block clean siblings — they merge before any sync', async () => {
  const { subject, events, restore } = loadResolverForPhases({
    majority: 2,
    siblings: [
      // Most votes but behind main (blocked) — would freeze the queue pre-#391.
      { id: 51, yes_count: 5, promoted_at: 100, created_at: 100, behind_main: 2 },
      { id: 52, yes_count: 3, promoted_at: 200, created_at: 200 }, // clean
      { id: 53, yes_count: 2, promoted_at: 300, created_at: 300 }, // clean
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    // Both clean PRs merge first (vote order), THEN the blocked one is synced
    // and merged in Phase 2.
    assert.deepEqual(events, [['merge', 52], ['merge', 53], ['sync', 51], ['merge', 51]],
      'clean PRs merge before the blocked PR is ever synced');
    const firstSync = events.findIndex((e) => e[0] === 'sync');
    const cleanMerges = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e[0] === 'merge' && (e[1] === 52 || e[1] === 53));
    assert.ok(cleanMerges.every(({ i }) => i < firstSync),
      'no worker sync runs until every clean merge is done');
  } finally {
    restore();
  }
});

test('#391: a blocked PR whose sync fails stays stuck but never blocks the clean merge', async () => {
  const { subject, events, voteUpdates, sysMessages, restore } = loadResolverForPhases({
    majority: 2,
    siblings: [
      // Real conflict that the worker cannot resolve.
      { id: 61, yes_count: 5, promoted_at: 100, created_at: 100, behind_main: 2, mergeable: false, syncOutcome: 'conflict' },
      { id: 62, yes_count: 3, promoted_at: 200, created_at: 200 }, // clean
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    // Clean PR merged in Phase 1; blocked PR synced in Phase 2 but never merged.
    assert.deepEqual(events, [['merge', 62], ['sync', 61]],
      'the clean PR merges, the blocked PR is synced but does not merge');
    // Terminal broadcast for the failed resolve surfaces the 'failed' snapshot.
    const failed = voteUpdates.find((u) => u.sessionId === 61 && u.resolving === false);
    assert.ok(failed, 'a terminal (resolving:false) broadcast fired for the blocked PR');
    assert.equal(failed.resolutionOutcome, 'failed', 'outcome is failed');
    assert.equal(failed.mergeConflictState, 'failed', 'persisted snapshot is failed');
    // The owner is told to resolve it by hand.
    assert.ok(sysMessages.some((m) => /61/.test(m) && /resolve/i.test(m)),
      'a group-chat message asks the owner to resolve the conflict');
  } finally {
    restore();
  }
});

test('#391 regression: an all-clean queue drains highest-voted first with no syncs', async () => {
  const { subject, events, restore } = loadResolverForPhases({
    majority: 2,
    siblings: [
      { id: 71, yes_count: 2, promoted_at: 100, created_at: 100 },
      { id: 72, yes_count: 4, promoted_at: 200, created_at: 200 }, // most votes
      { id: 73, yes_count: 3, promoted_at: 50, created_at: 50 },
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    assert.deepEqual(events, [['merge', 72], ['merge', 73], ['merge', 71]],
      'clean PRs merge highest-voted first');
    assert.equal(events.some((e) => e[0] === 'sync'), false, 'no worker sync ever runs');
  } finally {
    restore();
  }
});

test('#391 regression: an all-blocked queue still resolves every PR, highest-voted first', async () => {
  const { subject, events, restore } = loadResolverForPhases({
    majority: 2,
    siblings: [
      { id: 81, yes_count: 2, promoted_at: 100, created_at: 100, behind_main: 1 },
      { id: 82, yes_count: 4, promoted_at: 200, created_at: 200, behind_main: 1 }, // most votes
      { id: 83, yes_count: 3, promoted_at: 50, created_at: 50, behind_main: 1 },
    ],
  });
  try {
    await subject.checkAndResolveConflicts({ jwtSecret: 's' }, { app_id: 5, id: 9 });
    // No clean PRs to merge in Phase 1; Phase 2 resolves them in vote priority.
    const syncs = events.filter((e) => e[0] === 'sync').map((e) => e[1]);
    assert.deepEqual(syncs, [82, 83, 81], 'every blocked PR is synced, highest-voted first');
    // Each resolved sync then merges.
    assert.deepEqual(events.filter((e) => e[0] === 'merge').map((e) => e[1]).sort(), [81, 82, 83],
      'every resolved PR merges');
  } finally {
    restore();
  }
});
