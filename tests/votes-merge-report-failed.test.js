// Regression: a GitHub merge that succeeds but whose report to the
// merge-followups workflow machine THROWS must NOT roll the session back to
// 'promoted'. The PR is merged on GitHub — re-opening it for voting is the
// bug that left whiteboard #41/#44/#52/#54 showing "up for voting" forever.
// Instead checkAndMerge leaves the row 'merging' and answers merged with
// its follow-ups pending: recoverStuckMerges (server.js) finds the merge on
// GitHub and reports it again. Nothing outside the machine moves the row
// into 'merged' (its ownership guard would refuse it).
//
// Same require.cache stubbing pattern as votes-merge-failed-broadcast.test.js
// — nothing real (GitHub, docker, the workflow runtime) spins up.
//
// Run with: node --test tests/votes-merge-report-failed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// The REAL pure merge gate, grabbed before stubbing — checkAndMerge derives
// its vote threshold + visibility window from it.
const { mergeGate } = require('../src/services/active-users');

// routes/votes.js requires express at module level but only calls Router()
// inside voteRoutes(), which this suite never invokes. Serve a stub through
// Module._load so the suite is hermetic.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({}) };
  return _origLoad.call(this, request, ...rest);
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Records every query so the test can assert which status transition fired.
function makeRecordingPool(handlers) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      for (const [re, rows] of handlers) {
        if (re.test(String(sql))) {
          const out = typeof rows === 'function' ? rows(params) : rows;
          return Array.isArray(out) ? { rows: out, rowCount: out.length } : out;
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Loads routes/votes with collaborators stubbed: mergePR SUCCEEDS, but
// the report to the merge-followups machine THROWS.
function loadVotesWithFailingReport(reportError) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    platform: require.resolve('../src/workflow/platform.ts'),
    docker: require.resolve('../src/services/docker'),
    resolver: require.resolve('../src/services/conflict-resolver'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const voteUpdates = [];
  const systemMessages = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => makeRecordingPool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    // Succeeds and returns a squash-merge SHA, just like the real one.
    mergePR: async () => ({ sha: 'deadbeefcafe', merged: true }),
  });
  const reports = [];
  stub(ids.platform, {
    mergeConfirmed: async (m) => { reports.push(m); throw reportError; },
  });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async () => ({ ok: true }),
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content) => { systemMessages.push(content); },
    pushNotificationToUser() {},
    pushVoteUpdate(data) { voteUpdates.push(data); },
    pushSessionUpdate() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 1, majority: 1 }),
    isUserActive: async () => true,
    mergeGate,
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, voteUpdates, systemMessages, reports, restore };
}

const session = {
  id: 7, app_id: 5, app_slug: 'whiteboard', app_self_hosted: false,
  repo_url: 'https://github.com/acme/whiteboard', pr_number: 52,
  pr_title: 'Premium brushes', user_id: 3, behind_main: 0,
  reviewed_head_sha: 'a'.repeat(40),
};

const pool = () => makeRecordingPool([
  [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
  [/SET status = 'merging'/, [{ id: 7 }]],
]);

test('a merge whose report to the machine fails stays merging for recovery, never promoted', async () => {
  const { subject, voteUpdates, reports, restore } = loadVotesWithFailingReport(new Error('the workflow runtime is not running'));
  const p = pool();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session }, { force: true });

    // The PR IS merged on GitHub; recovery records it.
    assert.deepEqual(r, { merged: true, followupsPending: true });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].sessionId, 7);
    assert.equal(reports[0].mergeSha, 'deadbeefcafe');

    // Neither moved into 'merged' here nor rolled back to 'promoted'.
    assert.ok(!p.queries.some((q) => /SET\s+status = 'merged'/.test(q.sql)), 'only the machine moves a row into merged');
    assert.ok(!p.queries.some((q) => /SET status = 'promoted'\s+WHERE id/.test(q.sql)), 'never rolled back to promoted');
    assert.ok(!voteUpdates.some((u) => u.mergeFailed), 'no mergeFailed broadcast on a merged PR');
  } finally {
    restore();
  }
});
