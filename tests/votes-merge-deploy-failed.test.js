// Regression: a GitHub merge that succeeds but whose post-merge step (prod
// rebuild, staging teardown, …) THROWS must NOT roll the session back to
// 'promoted'. The PR is merged on GitHub — re-opening it for voting is the
// bug that left whiteboard #41/#44/#52/#54 showing "up for voting" forever
// (the prod rebuild kept failing on a newly-required secret with no
// production value). Instead checkAndMerge must mark the session 'merged'
// and broadcast merged:true + deployFailed:true.
//
// Same require.cache stubbing pattern as votes-merge-failed-broadcast.test.js
// — nothing real (GitHub, docker, staging) spins up.
//
// Run with: node --test tests/votes-merge-deploy-failed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

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
// staging.rebuildProduction THROWS (the missing-secret failure mode).
function loadVotesWithFailingRebuild(rebuildError) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
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
  stub(ids.staging, {
    rebuildProduction: async () => { throw rebuildError; },
    teardownStaging: async () => {},
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
  return { subject, voteUpdates, systemMessages, restore };
}

const session = {
  id: 7, app_id: 5, app_slug: 'whiteboard', app_self_hosted: false,
  repo_url: 'https://github.com/acme/whiteboard', pr_number: 52,
  pr_title: 'Premium brushes', user_id: 3, behind_main: 0,
};

// The apps row must exist + be non-self-hosted so the rebuild branch runs.
const pool = () => makeRecordingPool([
  [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
  [/SET status = 'merging'/, [{ id: 7 }]],
  [/SELECT \* FROM apps WHERE id/, [{ id: 5, slug: 'whiteboard', self_hosted: false }]],
  [/SET\s+status = 'merged'/, { rows: [], rowCount: 1 }],
]);

test('post-merge rebuild failure marks session merged (not promoted) and broadcasts deployFailed', async () => {
  const err = new Error('missing required secrets: PREMIUM_BRUSH_PAYEE_PUBKEY');
  const { subject, voteUpdates, systemMessages, restore } = loadVotesWithFailingRebuild(err);
  const p = pool();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session }, { force: true });

    // The PR IS merged on GitHub — the result reflects that, with the
    // deploy failure surfaced separately.
    assert.equal(r.merged, true);
    assert.equal(r.deployFailed, true);
    assert.ok(/PREMIUM_BRUSH_PAYEE_PUBKEY/.test(r.error));

    // It marked the row merged — and NEVER rolled back to 'promoted'.
    const markedMerged = p.queries.some((q) => /SET\s+status = 'merged'/.test(q.sql));
    const rolledBack = p.queries.some((q) => /SET status = 'promoted'\s+WHERE id/.test(q.sql));
    assert.ok(markedMerged, 'session marked merged after the deploy failure');
    assert.ok(!rolledBack, 'session was NOT rolled back to promoted');

    // The merge SHA captured from mergePR is persisted via COALESCE.
    const mergedQ = p.queries.find((q) => /SET\s+status = 'merged'/.test(q.sql));
    assert.equal(mergedQ.params[1], 'deadbeefcafe');

    // A "merged but deploy failed" notice went to the group chat.
    assert.ok(systemMessages.some((m) => /merged on GitHub.*deploy failed/i.test(m)));

    // Exactly one vote_update with merged:true + deployFailed:true; never
    // a mergeFailed/rollback broadcast.
    const merged = voteUpdates.filter((u) => u.merged === true && u.deployFailed === true);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].sessionId, 7);
    assert.ok(!voteUpdates.some((u) => u.mergeFailed), 'no mergeFailed broadcast on a merged PR');
  } finally {
    restore();
  }
});
