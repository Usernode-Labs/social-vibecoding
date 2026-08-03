// #451: the merge engine checkAndMerge backs every auto-merge trigger
// (vote, checks-complete, periodic sweep). These pin the two behaviours the
// extra triggers rely on:
//   - the atomic 'promoted'→'merging' claim makes concurrent triggers safe:
//     two callers racing on one ready PR produce exactly ONE GitHub merge.
//   - a locked app with a winning vote + passing checks but NO admin yes
//     still does not auto-merge.
// Same require.cache stubbing pattern as votes-checks-gate.test.js — nothing
// real spins up.
//
// Run with: node --test tests/votes-auto-merge-on-checks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// The REAL pure merge gate, grabbed before stubbing — checkAndMerge derives
// its vote threshold + visibility window from it.
const { mergeGate } = require('../src/services/active-users');

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({}) };
  return _origLoad.call(this, request, ...rest);
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

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

// Loads routes/votes with all side-effecting deps stubbed. `opts.locked` /
// `opts.adminYes` shape the locked-app gate; `mergeCalls` counts real GitHub
// merges.
function loadVotes(opts = {}) {
  const { locked = false, adminYes = true } = opts;
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
    worker: require.resolve('../src/services/worker'),
    issueWatcher: require.resolve('../src/services/issue-close-watcher'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const mergeCalls = { count: 0 };
  const systemMessages = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => makeRecordingPool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    mergePR: async () => { mergeCalls.count += 1; return { sha: 'deadbeefcafe', merged: true }; },
    noteIssuesClosed() {},
    invalidateIssuesCache() {},
  });
  stub(ids.staging, {
    rebuildProduction: async () => ({ ok: true }),
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
    pushVoteUpdate() {},
    pushSessionUpdate() {},
    pushIssueUpdate() {},
    broadcastGlobalScoped() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 1, majority: 1 }),
    isUserActive: async () => true,
    mergeGate,
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => locked, hasAdminYesVote: async () => adminYes });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.worker, { destroyCcVolume: async () => {} });
  stub(ids.issueWatcher, { watchIssuesClosedAfterMerge: async () => {} });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, mergeCalls, systemMessages, restore };
}

const session = {
  id: 7, app_id: 5, app_slug: 'whiteboard', app_self_hosted: false,
  repo_url: 'https://github.com/acme/whiteboard', pr_number: 52,
  pr_title: 'Premium brushes', user_id: 3, behind_main: 0, linked_issues: null,
  reviewed_head_sha: 'a'.repeat(40),
};

// Pool with a winning vote (1 yes, majority 1) and passing checks, whose
// 'promoted'→'merging' claim succeeds only ONCE (the atomic guard). A second
// concurrent caller sees the row already claimed and finds no row to update.
function poolReadyToMerge() {
  let claimed = false;
  return makeRecordingPool([
    [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
    [/SELECT check_state, test_results/, [{ check_state: 'passing', test_results: [{ status: 'pass' }] }]],
    [/SET status = 'merging'/, () => {
      if (claimed) return [];
      claimed = true;
      return [{ id: 7 }];
    }],
    [/SELECT \* FROM apps WHERE id/, [{ id: 5, slug: 'whiteboard', self_hosted: false }]],
    [/SET\s+status = 'merged'/, { rows: [], rowCount: 1 }],
  ]);
}

test('a voted + passing promoted PR auto-merges (the checks-complete drive target)', async () => {
  const { subject, mergeCalls, restore } = loadVotes();
  const p = poolReadyToMerge();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, true);
    assert.equal(mergeCalls.count, 1, 'merged on GitHub exactly once');
  } finally {
    restore();
  }
});

test('two concurrent triggers on one ready PR produce exactly ONE GitHub merge', async () => {
  const { subject, mergeCalls, restore } = loadVotes();
  const p = poolReadyToMerge();
  try {
    // Simulate a vote-triggered merge racing the checks-complete drive.
    const [a, b] = await Promise.all([
      subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session }),
      subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session }),
    ]);
    assert.equal(mergeCalls.count, 1, 'the atomic claim collapses the race to one merge');
    const merged = [a, b].filter((r) => r.merged);
    const skipped = [a, b].filter((r) => r.inProgress);
    assert.equal(merged.length, 1, 'exactly one caller performed the merge');
    assert.equal(skipped.length, 1, 'the loser bailed with inProgress');
  } finally {
    restore();
  }
});

test('locked app: winning vote + passing checks but no admin yes does NOT auto-merge', async () => {
  const { subject, mergeCalls, restore } = loadVotes({ locked: true, adminYes: false });
  const p = poolReadyToMerge();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.awaitingAdmin, true);
    assert.equal(mergeCalls.count, 0, 'never merged');
    assert.ok(!p.queries.some((q) => /SET status = 'merging'/.test(q.sql)), 'never claimed the merge');
  } finally {
    restore();
  }
});

test('locked app WITH an admin yes + passing checks auto-merges', async () => {
  const { subject, mergeCalls, restore } = loadVotes({ locked: true, adminYes: true });
  const p = poolReadyToMerge();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, true);
    assert.equal(mergeCalls.count, 1);
  } finally {
    restore();
  }
});
