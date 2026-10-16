// Unit tests for #687 — checkAndMerge routes an IMPORTED merge through the
// mock-GitHub client in staging (USERNODE_ENV === 'staging'), exercising
// both outcomes without real credentials:
//   - pinned sha matches the mock head → merge succeeds → the merge is
//     reported to the merge-followups workflow machine, like a native one;
//   - pinned sha is stale (author pushed since the vote) → the mock refuses
//     with a HeadMovedError, and checkAndMerge treats it as "head moved":
//     releases the row to 'promoted', posts the re-review note, reports no
//     merge.
// Native merges are unaffected (they never use the mock).
//
// Run with: node --test tests/pr-import-mock-merge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGate } = require('../src/services/active-users');
// Real mock — the system under test on the merge path. Required before any
// stubbing so it captures the real HeadMovedError sentinel.
const githubMock = require('../src/services/github-mock');

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

// Loads routes/votes with collaborators stubbed. github-mock is intentionally
// NOT stubbed (it is the real adapter under test); the real `github` stub's
// mergePR must never be reached on the imported+mock path.
function loadVotes() {
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
    governance: require.resolve('../src/services/governance'),
    mergeDebug: require.resolve('../src/services/merge-debug'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const realMergeCalls = [];
  const voteUpdates = [];
  const systemMessages = [];
  const reports = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => makeRecordingPool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    // If this fires on an imported+mock merge, the client selection is wrong.
    mergePR: async (owner, repo, prNumber, sha = null) => {
      realMergeCalls.push({ owner, repo, prNumber, sha });
      return { sha: 'REAL-should-not-run', merged: true };
    },
    HeadMovedError: require('../src/services/github').HeadMovedError,
    invalidateIssuesCache() {},
    noteIssuesClosed() {},
  });
  stub(ids.platform, {
    mergeConfirmed: async (m) => { reports.push(m); return { status: 'accepted', eventId: 1 }; },
  });
  stub(ids.docker, {});
  stub(ids.resolver, { checkAndResolveConflicts: async () => {}, resolveAndMaybeRetry: async () => ({ ok: true }), isResolving: () => false });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content, _t, _m, thread) => { systemMessages.push({ content, thread }); },
    pushNotificationToUser() {},
    pushVoteUpdate(data) { voteUpdates.push(data); },
    pushSessionUpdate() {},
    broadcastGlobalScoped() {},
    pushIssueUpdate() {},
  });
  stub(ids.activeUsers, { getActiveUserStats: async () => ({ active: 1, majority: 1 }), isUserActive: async () => true, mergeGate });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_MERGED: 'pr_merged', BOUNTY_AWARDED: 'bounty_awarded' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.governance, {
    governedGate: async () => ({
      mergeable: true, thresholdMet: true, lazyArmed: false, windowElapsed: true,
      qualifiedYes: 1, qualifiedNo: 0, activeCount: 1, required: 1,
      mode: 'default', policy: 'anyone', windowEndsAt: null, rejectable: false,
    }),
  });
  stub(ids.mergeDebug, { startRun: async () => 1, step: async () => {}, endRun: async () => {} });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, realMergeCalls, voteUpdates, systemMessages, reports, restore };
}

const PR = 9401;
function importedSession(headSha) {
  return {
    id: 71, app_id: 5, app_slug: 'demo', app_self_hosted: false,
    repo_url: 'https://github.com/acme/demo', pr_number: PR,
    pr_title: 'Mock imported PR', user_id: 3, behind_main: 0,
    source: 'imported', imported_pr_head_sha: headSha,
  };
}
function mergeReadyPool() {
  return makeRecordingPool([
    [/SET status = 'merging'/, [{ id: 71 }]],
  ]);
}

// The mock merge client is selected whenever USERNODE_ENV === 'staging'
// (see usesMockGithubForImports in config.js) — run the body in staging.
function withStagingEnv(fn) {
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  return (async () => {
    try { return await fn(); }
    finally {
      if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
    }
  })();
}

test('checkAndMerge (mock): imported merge with a matching head succeeds via the mock', async () => {
  githubMock._resetForTests();
  await withStagingEnv(async () => {
    const { subject, realMergeCalls, reports, restore } = loadVotes();
    const pool = mergeReadyPool();
    try {
      const head = githubMock.currentHead(PR);
      const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, importedSession(head), { force: true });
      assert.equal(r.merged, true, 'mock merge succeeded');
      assert.equal(realMergeCalls.length, 0, 'the REAL github.mergePR was never called');
      assert.equal(reports.length, 1, 'the merge was reported to the merge-followups machine');
      assert.equal(reports[0].sessionId, 71);
      assert.ok(reports[0].mergeSha, 'with the mock merge commit');
    } finally { restore(); }
  });
});

test('checkAndMerge (mock): a stale pinned head is refused (headMoved) and left recoverable', async () => {
  githubMock._resetForTests();
  await withStagingEnv(async () => {
    const { subject, realMergeCalls, voteUpdates, systemMessages, reports, restore } = loadVotes();
    const pool = mergeReadyPool();
    try {
      // Simulate: the vote was cast on an older commit; the mock head is now newer.
      const staleHead = 'stalehead'.padEnd(40, '0');
      const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, importedSession(staleHead), { force: true });

      assert.equal(r.merged, false, 'nothing merged');
      assert.equal(r.headMoved, true, 'distinct head-moved outcome');
      assert.equal(realMergeCalls.length, 0, 'real client never used');
      assert.equal(reports.length, 0, 'no merge reported on a refused merge');

      assert.ok(
        pool.queries.some((q) => /SET status = 'promoted'\s+WHERE id = \$1 AND status = 'merging'/.test(q.sql)),
        'row released back to promoted (recoverable)'
      );
      assert.ok(!pool.queries.some((q) => /SET\s+status = 'merged'/.test(q.sql)), 'never marked merged');
      assert.ok(systemMessages.some((m) => /updated on GitHub/i.test(m.content)), 're-review note posted');
      assert.ok(voteUpdates.some((u) => u.headMoved === true), 'headMoved broadcast');
      assert.ok(!voteUpdates.some((u) => u.mergeFailed), 'not a merge failure');
    } finally { restore(); }
  });
});

test('checkAndMerge (production): imported merge uses the REAL client, not the mock', async () => {
  githubMock._resetForTests();
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  const { subject, realMergeCalls, restore } = loadVotes();
  const pool = mergeReadyPool();
  try {
    await subject.checkAndMerge({ jwtSecret: 's' }, pool, importedSession('anyhead'), { force: true });
    assert.equal(realMergeCalls.length, 1, 'real github.mergePR used outside staging');
    assert.equal(realMergeCalls[0].sha, 'anyhead', 'still pins the imported head sha');
  } finally {
    restore();
    if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
  }
});
