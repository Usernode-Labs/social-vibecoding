// #451: the merge gate (routes/votes.js evaluateMergeGate, the proposal
// machine's merge.gate work) backs every auto-merge trigger (vote,
// checks-complete, the review check). These pin what the triggers rely on:
//   - a voted + passing PR is found ready, and the gate itself never merges,
//     claims or writes the merged status (that is the proposal machine's
//     claim and attempt, and merge-followups': one merge per proposal, one
//     attempt per app at a time, tests/workflow-merge-postgres.test.js M1, M3);
//   - a locked app with a winning vote + passing checks but NO admin yes
//     is not ready.
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
// merges and `reports` the merges handed to the merge-followups machine.
function loadVotes(opts = {}) {
  const { locked = false, adminYes = true } = opts;
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    platform: require.resolve('../src/workflow/platform.ts'),
    docker: require.resolve('../src/services/docker'),
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
  const reports = [];
  const claims = [];
  stub(ids.platform, {
    mergeConfirmed: async (m) => { reports.push(m); return { status: 'accepted', eventId: 1 }; },
    claimMerge: async (c) => {
      claims.push(c);
      if (claims.length > 1) return { status: 'rejected', eventId: 2, reason: 'in_progress' };
      return { status: 'accepted', eventId: 2, reply: { claim: 1 } };
    },
    releaseMerge: async () => ({ status: 'accepted', eventId: 3 }),
    abandonMerge: async () => ({ status: 'accepted', eventId: 4 }),
  });
  stub(ids.docker, {});
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

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, mergeCalls, systemMessages, reports, claims, restore };
}

const session = {
  id: 7, app_id: 5, app_slug: 'whiteboard', app_self_hosted: false,
  repo_url: 'https://github.com/acme/whiteboard', pr_number: 52,
  pr_title: 'Premium brushes', user_id: 3, behind_main: 0, linked_issues: null,
  reviewed_head_sha: 'a'.repeat(40),
};

// Pool with a winning vote (1 yes, majority 1) and passing checks. The
// 'promoted'→'merging' claim (the platform stub above) succeeds only ONCE.
function poolReadyToMerge() {
  return makeRecordingPool([
    [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
    [/SELECT check_state, test_results/, [{ check_state: 'passing', test_results: [{ status: 'pass' }] }]],
  ]);
}

test('a voted + passing promoted PR auto-merges (the checks-complete drive target)', async () => {
  const { subject, mergeCalls, reports, restore } = loadVotes();
  const p = poolReadyToMerge();
  try {
    const r = await subject.evaluateMergeGate({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.ready, true);
    assert.equal(mergeCalls.count, 0, 'the gate never asks GitHub to merge');
    assert.equal(reports.length, 0);
    assert.ok(!p.queries.some((q) => /SET\s+status = /.test(q.sql)),
      'the gate never writes a status');
  } finally {
    restore();
  }
});

test('locked app: winning vote + passing checks but no admin yes does NOT auto-merge', async () => {
  const { subject, mergeCalls, claims, restore } = loadVotes({ locked: true, adminYes: false });
  const p = poolReadyToMerge();
  try {
    const r = await subject.evaluateMergeGate({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.awaitingAdmin, true);
    assert.equal(mergeCalls.count, 0, 'never merged');
    assert.equal(claims.length, 0, 'never claimed the merge');
  } finally {
    restore();
  }
});

test('locked app WITH an admin yes + passing checks auto-merges', async () => {
  const { subject, mergeCalls, restore } = loadVotes({ locked: true, adminYes: true });
  const p = poolReadyToMerge();
  try {
    const r = await subject.evaluateMergeGate({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.ready, true);
  } finally {
    restore();
  }
});
