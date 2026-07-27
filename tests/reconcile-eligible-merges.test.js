// Tests for the boot-time auto-merge reconcile sweep (#390 —
// reconcileEligibleMerges in server.js). Before this sweep, auto-merge
// fired ONLY in the background of a live vote, so a proposal that crossed
// the vote-majority threshold while the platform was down stayed stuck
// "up for voting" forever. The sweep re-drives the per-app drain
// (conflict-resolver.checkAndResolveConflicts) for every app with an open
// proposal at startup, so eligible PRs merge without a fresh vote.
//
// What it must guarantee:
//   1. Fans out one drain per DISTINCT app_id that has a 'promoted' session.
//   2. Short-circuits entirely (no DB query, no drain) when GitHub auth is off.
//   3. No-op when there are no open proposals.
//   4. Never throws out of start(): a drain that rejects can't abort the rest.
//   5. Runs AFTER recoverStuckMerges, so a 'merging' row that recoverStuckMerges
//      demotes back to 'promoted' is visible to the reconcile query (ordering).
//   6. End-to-end through the REAL drain: an eligible proposal reaches
//      checkAndMerge (merges), a below-threshold one does not.
//
// server.js only boots under the require.main guard, so requiring it here
// exposes the recovery internals without starting servers. db/pool, github
// and conflict-resolver are required lazily inside the sweep, so we stub
// them via require.cache right before invoking it.
//
// Run with: node --test tests/reconcile-eligible-merges.test.js

// Make the resolver's mergeability backoff instant for the integration test.
process.env.CONFLICT_MERGEABLE_POLL_DELAY_MS = '0';
process.env.CONFLICT_MERGEABLE_TRUE_DELAY_MS = '0';
process.env.CONFLICT_MERGEABLE_AFTER_PUSH_INITIAL_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');

// The REAL pure merge gate, grabbed before stubbing — the drain applies it
// to the candidate rows the mock pool returns.
const { mergeGate: realMergeGate } = require('../src/services/active-users');

// loadConfig() (module level in server.js) hard-exits when these are missing.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
// config.load() requires the four separated platform keys (REQUIRED_PROD).
require('./platform-keys').setPlatformKeys();

// Auto-unref any housekeeping timers scheduled during the require so this
// process can exit.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...args) => { const t = origSetInterval(...args); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...args) => { const t = origSetTimeout(...args); if (t && t.unref) t.unref(); return t; };
let reconcileEligibleMerges;
let recoverStuckMerges;
try {
  ({ reconcileEligibleMerges, recoverStuckMerges } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

const poolId = require.resolve('../src/db/pool');
const githubId = require.resolve('../src/services/github');
const conflictId = require.resolve('../src/services/conflict-resolver');

function stub(id, exports) {
  const prev = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  return prev;
}
function restore(id, prev) {
  if (prev) require.cache[id] = prev; else delete require.cache[id];
}

// ── Level A: reconcileEligibleMerges fan-out + guards ───────────────────────
// A minimal pool whose only job is to answer the DISTINCT-app query.
function makeDistinctPool(appIds, { onQuery } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (onQuery) onQuery(String(sql), params);
      if (/SELECT DISTINCT app_id FROM chat_sessions WHERE status = 'promoted'/.test(String(sql))) {
        return { rows: appIds.map((id) => ({ app_id: id })), rowCount: appIds.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function withStubs(stubs, fn) {
  const prev = {};
  for (const [id, exports] of stubs) prev[id] = stub(id, exports);
  return Promise.resolve().then(fn).finally(() => {
    for (const [id] of stubs) restore(id, prev[id]);
  });
}

test('reconcileEligibleMerges drains every distinct app with a promoted session', async () => {
  const drained = [];
  const pool = makeDistinctPool([1, 2, 3]);
  await withStubs([
    [githubId, { isEnabled: () => true }],
    [poolId, { getPool: () => pool }],
    [conflictId, { checkAndResolveConflicts: async (_cfg, t) => { drained.push(t.app_id); } }],
  ], () => reconcileEligibleMerges({}));

  assert.deepEqual(drained.sort((a, b) => a - b), [1, 2, 3]);
  // Each drain is keyed strictly by { app_id } — no excludeSessionId leaks in.
  assert.ok(pool.calls.some((c) => /SELECT DISTINCT app_id/.test(c.sql)));
});

test('reconcileEligibleMerges is a no-op (no query, no drain) without GitHub auth', async () => {
  let queried = false;
  let drained = false;
  await withStubs([
    [githubId, { isEnabled: () => false }],
    [poolId, { getPool: () => { queried = true; return makeDistinctPool([1]); } }],
    [conflictId, { checkAndResolveConflicts: async () => { drained = true; } }],
  ], () => reconcileEligibleMerges({}));

  assert.equal(queried, false, 'must short-circuit before touching the pool');
  assert.equal(drained, false, 'must not drain any app when GitHub is disabled');
});

test('reconcileEligibleMerges does nothing when there are no promoted sessions', async () => {
  const drained = [];
  await withStubs([
    [githubId, { isEnabled: () => true }],
    [poolId, { getPool: () => makeDistinctPool([]) }],
    [conflictId, { checkAndResolveConflicts: async (_cfg, t) => { drained.push(t.app_id); } }],
  ], () => reconcileEligibleMerges({}));

  assert.deepEqual(drained, []);
});

test('reconcileEligibleMerges keeps going (and never throws) when one app drain rejects', async () => {
  const attempted = [];
  await withStubs([
    [githubId, { isEnabled: () => true }],
    [poolId, { getPool: () => makeDistinctPool([1, 2, 3]) }],
    [conflictId, {
      checkAndResolveConflicts: async (_cfg, t) => {
        attempted.push(t.app_id);
        if (t.app_id === 2) throw new Error('drain blew up');
      },
    }],
  ], () => reconcileEligibleMerges({}));

  // All three apps were attempted despite app 2 throwing, and the sweep
  // itself resolved (never rejected out into start()).
  assert.deepEqual(attempted.sort((a, b) => a - b), [1, 2, 3]);
});

// ── Level A: ordering with recoverStuckMerges ───────────────────────────────
// A 'merging' row stuck by a crash mid-merge is demoted to 'promoted' by
// recoverStuckMerges; only then does the reconcile sweep see its app. We run
// both against ONE shared pool whose state mutates, exactly as the boot call
// site chains them.
test('a crash-stuck merging row is demoted, then picked up by the reconcile sweep', async () => {
  // Mutable fixture: one session, app 9, stuck in 'merging'.
  const session = { id: 50, app_id: 9, status: 'merging', pr_number: 1234, merge_commit_sha: null, repo_url: 'https://github.com/acme/x' };
  const sharedPool = {
    async query(sql, params = []) {
      const s = String(sql);
      // recoverStuckMerges: list open PR sessions.
      if (/SELECT cs\.id[\s\S]*FROM chat_sessions cs/i.test(s) && /status IN \('promoted', 'merging'\)/.test(s)) {
        return { rows: [{ ...session }], rowCount: 1 };
      }
      // recoverStuckMerges: per-row demote of a 'merging' row GitHub never merged.
      if (/SET status = 'promoted'/.test(s) && /WHERE id = \$1/.test(s)) {
        if (session.id === params[0] && session.status === 'merging') session.status = 'promoted';
        return { rows: [], rowCount: 1 };
      }
      // reconcile: distinct apps with a promoted session.
      if (/SELECT DISTINCT app_id FROM chat_sessions WHERE status = 'promoted'/.test(s)) {
        const rows = session.status === 'promoted' ? [{ app_id: session.app_id }] : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const drained = [];
  await withStubs([
    [githubId, { isEnabled: () => true, getPR: async () => ({ merged: false }) }],
    [poolId, { getPool: () => sharedPool }],
    [conflictId, { checkAndResolveConflicts: async (_cfg, t) => { drained.push(t.app_id); } }],
  ], async () => {
    // Sweep alone, BEFORE recovery, would see nothing (row still 'merging').
    await reconcileEligibleMerges({});
    assert.deepEqual(drained, [], 'merging row is invisible to the sweep until demoted');

    // The boot call site chains them: recover first, then reconcile.
    await recoverStuckMerges({});
    assert.equal(session.status, 'promoted', 'recoverStuckMerges demoted the stuck merging row');
    await reconcileEligibleMerges({});
    assert.deepEqual(drained, [9], 'reconcile now drains the demoted row\'s app');
  });
});

// ── Level B: end-to-end through the REAL drain ──────────────────────────────
// Proves the boot sweep actually merges an eligible proposal and leaves a
// below-threshold one alone, by wiring reconcileEligibleMerges to the real
// conflict-resolver with only its leaf collaborators stubbed.
test('reconcile merges an eligible proposal and skips a below-threshold one (real drain)', async () => {
  const activeUsersId = require.resolve('../src/services/active-users');
  const syncMainId = require.resolve('../src/services/sync-main');
  const limitsId = require.resolve('../src/services/limits');
  const wsId = require.resolve('../src/services/ws');
  const votesId = require.resolve('../src/routes/votes');
  const loggerId = require.resolve('../src/services/logger');

  // App 1 has an eligible promoted session (id 10, 3 yes votes); app 2 has a
  // below-threshold one (id 20, 0 yes votes). majority = 2.
  const sessions = {
    10: { id: 10, app_id: 1, status: 'promoted', pr_number: 110, behind_main: 0, user_id: 7, repo_url: 'https://github.com/acme/a', merge_conflict_state: 'clean' },
    20: { id: 20, app_id: 2, status: 'promoted', pr_number: 220, behind_main: 0, user_id: 8, repo_url: 'https://github.com/acme/b', merge_conflict_state: 'clean' },
  };
  const yesVotes = { 10: 3, 20: 0 };
  const MAJORITY = 2;

  const realPool = {
    async query(sql, params = []) {
      const s = String(sql);
      // reconcile: distinct apps.
      if (/SELECT DISTINCT app_id FROM chat_sessions WHERE status = 'promoted'/.test(s)) {
        const ids = [...new Set(Object.values(sessions).filter((x) => x.status === 'promoted').map((x) => x.app_id))];
        return { rows: ids.map((id) => ({ app_id: id })), rowCount: ids.length };
      }
      // drainApp candidate query: every non-excluded promoted sibling with
      // yes/no tallies — eligibility (the dynamic merge gate) and ranking now
      // run in JS inside the drain.
      if (/FROM chat_sessions cs/.test(s) && /cs\.status = 'promoted'/.test(s) && /vote = 'no'/.test(s)) {
        const [appId, excludeId, attempted] = params;
        const cand = Object.values(sessions).filter((x) =>
          x.app_id === appId && x.status === 'promoted' && x.id !== excludeId
          && !(attempted || []).includes(x.id));
        return {
          rows: cand.map((x) => ({
            id: x.id, promoted_at: null, created_at: null, unblocked: true,
            yes_count: yesVotes[x.id] || 0, no_count: 0,
          })),
          rowCount: cand.length,
        };
      }
      // loadSession.
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        const row = sessions[params[0]];
        return { rows: row ? [{ ...row, app_slug: `app-${row.app_id}`, app_name: 'X', app_self_hosted: true }] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  // GitHub octokit always reports the branch mergeable.
  const fakeOctokit = async () => ({ request: async () => ({ data: { mergeable: true } }) });
  const mergeCalls = [];

  const prev = {};
  for (const [id, exports] of [
    [loggerId, { info() {}, warn() {}, error() {}, debug() {} }],
    [githubId, { isEnabled: () => true, getOctokit: fakeOctokit, getInstallationOctokit: fakeOctokit }],
    [activeUsersId, { getActiveUserStats: async () => ({ active: 3, majority: MAJORITY }), mergeGate: realMergeGate }],
    [syncMainId, { runSyncMain: async () => ({ ok: true, syncResult: 'clean', behind: 0 }), persistConflictState: async () => {} }],
    [limitsId, { checkSystemBudget: async () => ({ ok: true, remaining: 2500 }) }],
    [wsId, { pushVoteUpdate() {}, sendSystemMessage: async () => {} }],
    [votesId, {
      checkAndMerge: async (_cfg, _pool, fresh) => {
        mergeCalls.push(fresh.id);
        sessions[fresh.id].status = 'merged';
        return { merged: true };
      },
    }],
    [poolId, { getPool: () => realPool }],
  ]) prev[id] = stub(id, exports);

  // Rebind the real conflict-resolver to the stubbed leaves.
  const prevConflict = require.cache[conflictId];
  delete require.cache[conflictId];
  require(conflictId);

  try {
    await reconcileEligibleMerges({});
    assert.deepEqual(mergeCalls, [10], 'only the eligible proposal reached checkAndMerge');
    assert.equal(sessions[10].status, 'merged', 'eligible proposal merged');
    assert.equal(sessions[20].status, 'promoted', 'below-threshold proposal left untouched');
  } finally {
    restore(conflictId, prevConflict);
    for (const id of [loggerId, githubId, activeUsersId, syncMainId, limitsId, wsId, votesId, poolId]) {
      restore(id, prev[id]);
    }
  }
});
