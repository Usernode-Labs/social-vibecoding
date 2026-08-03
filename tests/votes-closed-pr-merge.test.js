// checkAndMerge's 405 handler must distinguish a CLOSED PR from a real
// merge conflict. GitHub reports closed PRs as permanently unmergeable
// ('dirty') and pulls.merge 405s on them — before this fix the handler
// treated every 405 as a conflict and queued the auto-resolver, which
// looped still_conflicting forever (session 2398 / PR #26: withdrawn →
// re-promoted without a reopen). Now: closed-unmerged → reopen and fall
// through to the normal conflict handling; reopen refused → terminal
// pr_closed (session paused, honest group-chat message, no resolver);
// open PR / transient GET failure → the conflict path, unchanged.
//
// Same require.cache stubbing pattern as votes-checks-gate.test.js —
// nothing real spins up.
//
// Run with: node --test tests/votes-closed-pr-merge.test.js

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
    issued(re) { return queries.some((q) => re.test(q.sql)); },
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

// getPRImpl / reopenImpl configure the GitHub PR-state responses; mergePR
// always throws the 405 GitHub returns for an unmergeable PR.
function loadVotes({ getPRImpl, reopenImpl } = {}) {
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
    stagingRecovery: require.resolve('../src/services/staging-recovery'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const systemMessages = [];
  const voteUpdates = [];
  const sessionUpdates = [];
  const getPRCalls = [];
  const reopenCalls = [];
  const resolverCalls = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => makeRecordingPool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    mergePR: async () => {
      const err = new Error('Pull Request is not mergeable - https://docs.github.com/rest/pulls/pulls#merge-a-pull-request');
      err.status = 405;
      throw err;
    },
    getPR: async (owner, repo, pr) => {
      getPRCalls.push({ owner, repo, pr });
      if (!getPRImpl) return { state: 'open', merged: false };
      return getPRImpl(owner, repo, pr);
    },
    reopenPR: async (owner, repo, pr) => {
      reopenCalls.push({ owner, repo, pr });
      if (reopenImpl) return reopenImpl(owner, repo, pr);
      return {};
    },
  });
  stub(ids.staging, {
    rebuildProduction: async () => ({ ok: true }),
    teardownStaging: async () => {},
  });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async (...args) => { resolverCalls.push(args); },
    resolveAndMaybeRetry: async (...args) => { resolverCalls.push(args); return { ok: true }; },
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content) => { systemMessages.push(content); },
    pushNotificationToUser() {},
    pushVoteUpdate(data) { voteUpdates.push(data); },
    pushSessionUpdate(data) { sessionUpdates.push(data); },
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
  stub(ids.stagingRecovery, {
    recheckSessionChecks: async () => 'rechecked',
    rebuildSessionStaging: async () => 'skipped',
    stagingNeedsRebuild: async () => false,
    recordStagingBootFailure: async () => {},
    recordChecksSkipped: async () => {},
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return {
    subject, systemMessages, voteUpdates, sessionUpdates,
    getPRCalls, reopenCalls, resolverCalls, restore,
  };
}

const session = {
  id: 7, app_id: 5, app_slug: 'whiteboard', app_self_hosted: false,
  repo_url: 'https://github.com/acme/whiteboard', pr_number: 52,
  pr_title: 'Premium brushes', user_id: 3, behind_main: 0,
  reviewed_head_sha: 'a'.repeat(40),
};

// Majority met, checks passing, claim succeeds — the merge itself 405s.
function mergingPool() {
  return makeRecordingPool([
    [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
    [/SELECT check_state, test_results[\s\S]*FROM chat_sessions/, [{ check_state: 'passing', test_results: [{ status: 'pass' }], check_error_detail: null }]],
    [/SET status = 'merging'/, [{ id: 7 }]],
  ]);
}

test('405 + closed-unmerged PR + reopen OK → reopened, normal conflict path continues', async () => {
  const ctx = loadVotes({
    getPRImpl: async () => ({ state: 'closed', merged: false }),
  });
  const p = mergingPool();
  try {
    const r = await ctx.subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.conflict, true, 'still surfaced as a conflict after the reopen');
    assert.deepEqual(ctx.reopenCalls, [{ owner: 'acme', repo: 'whiteboard', pr: 52 }]);
    assert.ok(ctx.resolverCalls.length >= 1, 'the auto-resolver is queued as usual');
    assert.ok(!p.issued(/SET status = 'paused'/), 'session is not paused on the reopen-success path');
  } finally {
    ctx.restore();
  }
});

test('405 + closed-unmerged PR + reopen refused → terminal pr_closed, no resolver', async () => {
  const ctx = loadVotes({
    getPRImpl: async () => ({ state: 'closed', merged: false }),
    reopenImpl: async () => { throw new Error('head branch was deleted'); },
  });
  const p = mergingPool();
  try {
    const r = await ctx.subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.prClosed, true);
    assert.equal(r.conflict, false, 'a dead PR is not reported as a conflict');
    assert.ok(p.issued(/SET status = 'paused'/), 'the proposal leaves the vote panel');
    assert.ok(!p.issued(/GREATEST\(behind_main, 1\)/), 'no speculative behind/conflict bump');
    assert.equal(ctx.resolverCalls.length, 0, 'the auto-resolver is never queued');
    assert.ok(ctx.systemMessages.some((m) => /closed on GitHub/.test(m) && /re-propose/i.test(m)),
      'the group chat explains the PR is closed and how to recover');
    // Clients are un-latched (the merging:true broadcast armed banners).
    assert.ok(ctx.voteUpdates.some((u) => u.mergeFailed === true && u.resolving === false),
      'a mergeFailed/no-resolving broadcast un-latches clients');
    assert.ok(ctx.sessionUpdates.some((u) => u.action === 'paused'),
      'session lists refresh off the pause');
  } finally {
    ctx.restore();
  }
});

test('405 + open PR (genuine conflict) → conflict path unchanged, no reopen attempted', async () => {
  const ctx = loadVotes({
    getPRImpl: async () => ({ state: 'open', merged: false }),
  });
  const p = mergingPool();
  try {
    const r = await ctx.subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.conflict, true);
    assert.equal(ctx.reopenCalls.length, 0, 'an open PR is never "reopened"');
    assert.ok(ctx.resolverCalls.length >= 1, 'the auto-resolver is queued');
  } finally {
    ctx.restore();
  }
});

test('405 + transient PR-state GET failure → falls through to the conflict path', async () => {
  const ctx = loadVotes({
    getPRImpl: async () => { throw new Error('api hiccup'); },
  });
  const p = mergingPool();
  try {
    const r = await ctx.subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.conflict, true, 'a GET hiccup must not invent a pr_closed verdict');
    assert.equal(ctx.reopenCalls.length, 0);
    assert.ok(!p.issued(/SET status = 'paused'/));
  } finally {
    ctx.restore();
  }
});

test('405 + closed-but-MERGED PR → not treated as pr_closed (falls through)', async () => {
  // A merged PR also reports state='closed'; the pr_closed handling must
  // key on merged=false so an out-of-band-merged PR isn't "reopened".
  const ctx = loadVotes({
    getPRImpl: async () => ({ state: 'closed', merged: true }),
  });
  const p = mergingPool();
  try {
    const r = await ctx.subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(ctx.reopenCalls.length, 0, 'a merged PR is never reopened');
    assert.equal(r.conflict, true, 'falls through to the existing handling');
  } finally {
    ctx.restore();
  }
});
