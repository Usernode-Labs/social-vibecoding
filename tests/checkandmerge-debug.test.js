// Integration-style test: checkAndMerge() emits an ordered /debug run.
//
//   - A clean-merge path produces a 'merge' run whose steps narrate the
//     gates → claim → GitHub merge → prod rebuild → teardown → merged, and
//     whose terminal run status is 'merged'.
//   - A GitHub 405 conflict path leaves a run ending in 'conflict_resolving'
//     (the auto-resolver was queued) with a conflict-detected step.
//
// All collaborators (github, staging, ws, active-users, …) are stubbed via
// require.cache so nothing real spins up. The merge-debug service is REAL —
// it writes into the same mock pool, which records every row so we can
// assert the captured steps.
//
// Run with: node --test tests/checkandmerge-debug.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Grab the REAL pure gate helpers before stubbing the module — checkAndMerge
// now gates on mergeGate (eased threshold + visibility window) in addition to
// the checks gate this suite exercises.
const { mergeGate } = require('../src/services/active-users');

function stub(relId, exports) {
  const id = require.resolve(relId);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// ── Stub every module routes/votes.js requires at load time ──────────────
let mergePRImpl = async () => ({ sha: 'abc1234ef', merged: true });
stub('../src/services/github', {
  isEnabled: () => true,
  mergePR: (...a) => mergePRImpl(...a),
  getInstallationOctokit: async () => ({ request: async () => ({ data: {} }) }),
  getOctokit: async () => ({ request: async () => ({ data: {} }) }),
});
stub('../src/services/staging', {
  rebuildProduction: async () => ({ sha: 'def5678ab', containerId: 'c1' }),
  teardownStaging: async () => {},
  buildAndDeployStaging: async () => ({ containerId: 'c2', stagingUrl: 'u', hostname: 'h' }),
  warmStagingCert: async () => {},
});
stub('../src/services/docker', {});
stub('../src/services/conflict-resolver', {
  checkAndResolveConflicts: async () => {},
  isResolving: () => false,
});
stub('../src/services/ws', {
  sendSystemMessage: async () => {},
  pushNotificationToUser: () => {},
  pushVoteUpdate: () => {},
  pushSessionUpdate: () => {},
  broadcastGlobalScoped: () => {},
  broadcastGlobal: () => {},
});
stub('../src/services/active-users', {
  getActiveUserStats: async () => ({ active: 3, majority: 2 }),
  isUserActive: async () => true,
  mergeGate,
});
stub('../src/services/notifications', {
  createPrProposedNotifications: async () => [],
  markReadForSession: async () => 0,
  serialize: (x) => x,
});
let lockedImpl = async () => false;
stub('../src/services/admin-approval', {
  isAppLocked: (...a) => lockedImpl(...a),
  hasAdminYesVote: async () => true,
});
stub('../src/services/events', {
  record: async () => {},
  EVENT_TYPES: new Proxy({}, { get: () => 'evt' }),
});
stub('../src/services/app-access', {
  sessionCollabGuard: () => (req, res, next) => next(),
  getAppForUser: async () => null,
  ACCESS_COLUMNS: '',
});
stub('../src/services/topic-attributes', {
  summarizeForTargets: async () => new Map(),
  emptySummary: () => ({ priority: null, assignee: null }),
});

const { checkAndMerge } = require('../src/routes/votes');

// Mock pool: records every query; scripts results per regex.
function makePool({ checkState = 'passing', yes = 3, behind = 0 } = {}) {
  const calls = [];
  let runIdSeq = 0;
  const pool = {
    calls,
    steps: [],
    runUpdates: [],
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT COUNT\(\*\) as cnt FROM pr_votes/.test(sql)) {
        // Yes and No tallies share this shape; the gate reads both.
        return { rows: [{ cnt: /vote = 'no'/.test(sql) ? '0' : String(yes) }] };
      }
      if (/INSERT INTO merge_debug_runs/.test(sql)) return { rows: [{ id: ++runIdSeq }] };
      if (/INSERT INTO merge_debug_steps/.test(sql)) {
        pool.steps.push({ runId: params[0], seq: params[1], phase: params[2], level: params[3], message: params[4] });
        return { rows: [] };
      }
      if (/UPDATE merge_debug_runs/.test(sql)) {
        pool.runUpdates.push({ runId: params[0], status: params[1], summary: params[2] });
        return { rowCount: 1 };
      }
      if (/SELECT check_state, test_results, checks_checked_at/.test(sql)) {
        return { rows: [{ check_state: checkState, test_results: [], checks_checked_at: new Date().toISOString() }] };
      }
      if (/UPDATE chat_sessions SET status = 'merging'/.test(sql)) return { rows: [{ id: params[0] }] };
      if (/SELECT \* FROM apps WHERE id/.test(sql)) return { rows: [{ id: 5, slug: 'app', self_hosted: false }] };
      if (/UPDATE chat_sessions[\s\S]*behind_main = GREATEST/.test(sql)) return { rows: [{ behind_main: 1 }] };
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

function session(extra = {}) {
  return {
    id: 100, app_id: 5, app_slug: 'app', pr_number: 7, pr_title: 'T',
    repo_url: 'https://github.com/o/r', behind_main: 0, user_id: 9,
    reviewed_head_sha: 'a'.repeat(40),
    linked_issues: [], app_self_hosted: false, ...extra,
  };
}

test('clean merge records an ordered run ending in merged', async () => {
  mergePRImpl = async () => ({ sha: 'abc1234ef', merged: true });
  lockedImpl = async () => false;
  const pool = makePool({ checkState: 'passing' });
  const res = await checkAndMerge({}, pool, session());
  assert.equal(res.merged, true);

  const phases = pool.steps.map((s) => s.phase);
  // Gates → claim → github merge → prod rebuild → teardown → merged.
  assert.ok(phases.includes('gate:majority'), 'majority gate step');
  assert.ok(phases.includes('gate:checks'), 'checks gate step');
  assert.ok(phases.includes('claim'), 'claim step');
  assert.ok(phases.includes('github_merge'), 'github merge step');
  assert.ok(phases.includes('prod_rebuild'), 'prod rebuild step');
  assert.ok(phases.includes('staging_teardown'), 'teardown step');
  assert.ok(phases.includes('merged'), 'merged step');

  // seq is monotonic and dense within the single run.
  const seqs = pool.steps.map((s) => s.seq);
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b));

  assert.equal(pool.runUpdates.length, 1);
  assert.equal(pool.runUpdates[0].status, 'merged');
});

test('a sub-threshold vote opens no run', async () => {
  const pool = makePool({ yes: 0 });
  const res = await checkAndMerge({}, pool, session());
  assert.equal(res.merged, false);
  assert.equal(pool.steps.length, 0, 'no debug steps for "not enough votes yet"');
  assert.ok(!pool.calls.some((c) => /INSERT INTO merge_debug_runs/.test(c.sql)), 'no run opened');
});

test('a checks-blocked merge ends the run as blocked', async () => {
  lockedImpl = async () => false;
  const pool = makePool({ checkState: 'failing' });
  const res = await checkAndMerge({}, pool, session());
  assert.equal(res.merged, false);
  assert.equal(res.checksBlocked, true);
  assert.ok(pool.steps.some((s) => s.phase === 'gate:checks' && s.level === 'warn'));
  assert.equal(pool.runUpdates[0].status, 'blocked');
});

test('a GitHub 405 conflict ends the run as conflict_resolving', async () => {
  mergePRImpl = async () => { const e = new Error('Pull Request is not mergeable'); e.status = 405; throw e; };
  lockedImpl = async () => false;
  const pool = makePool({ checkState: 'passing' });
  const res = await checkAndMerge({}, pool, session(), { autoResolve: true });
  assert.equal(res.merged, false);
  assert.equal(res.conflict, true);
  assert.ok(pool.steps.some((s) => s.phase === 'conflict_detected'), 'conflict-detected step recorded');
  assert.equal(pool.runUpdates[0].status, 'conflict_resolving');
});

test('a passed-in debugRunId is reused, not re-opened, and not ended by checkAndMerge', async () => {
  mergePRImpl = async () => ({ sha: 'abc1234ef', merged: true });
  lockedImpl = async () => false;
  const pool = makePool({ checkState: 'passing' });
  await checkAndMerge({}, pool, session(), { autoResolve: false, debugRunId: 4242 });
  assert.ok(!pool.calls.some((c) => /INSERT INTO merge_debug_runs/.test(c.sql)), 'no new run opened');
  assert.ok(pool.steps.every((s) => s.runId === 4242), 'steps nested under the passed-in run');
  assert.equal(pool.runUpdates.length, 0, 'checkAndMerge does not end a borrowed run');
});
