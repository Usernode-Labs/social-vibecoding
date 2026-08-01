// Native-proposal revision safety. Covers the security invariants independently
// of the imported-PR suites:
//   - a live head change advances reviewed_head_sha and invalidates only stale
//     votes/checks;
//   - a passing check for another commit cannot merge;
//   - native merges pass the expected SHA and a head-moved refusal returns the
//     proposal to review on the newly fetched revision.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({}) };
  return _origLoad.call(this, request, ...rest);
};

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function recordingPool(handlers = []) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });
      for (const [re, result] of handlers) {
        if (!re.test(text)) continue;
        const value = typeof result === 'function' ? result(params) : result;
        return Array.isArray(value) ? { rows: value, rowCount: value.length } : value;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function loadVotes({
  liveHead = NEW,
  mergeImpl = async () => ({ sha: 'merge-sha' }),
  getPRImpl = null,
} = {}) {
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
    appAdmins: require.resolve('../src/services/app-admins'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    governance: require.resolve('../src/services/governance'),
    mergeDebug: require.resolve('../src/services/merge-debug'),
    worker: require.resolve('../src/services/worker'),
    visuals: require.resolve('../src/services/visuals'),
    prImportSync: require.resolve('../src/services/pr-import-sync'),
    subject: require.resolve('../src/routes/votes'),
  };
  const original = {};
  for (const [key, id] of Object.entries(ids)) original[key] = require.cache[id];

  const mergeCalls = [];
  const pendingCalls = [];
  const rerunCalls = [];
  const voteUpdates = [];
  const messages = [];
  const rebuilds = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => recordingPool() });
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async (...args) => (getPRImpl
      ? getPRImpl(...args)
      : { state: 'open', merged: false, head: { sha: liveHead } }),
    mergePR: async (owner, repo, prNumber, sha) => {
      mergeCalls.push({ owner, repo, prNumber, sha });
      return mergeImpl({ owner, repo, prNumber, sha });
    },
    invalidateIssuesCache() {},
    noteIssuesClosed() {},
  });
  stub(ids.staging, {
    rebuildProduction: async () => { rebuilds.push(true); return { sha: 'deployed' }; },
    teardownStaging: async () => {},
  });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async () => ({ ok: true }),
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content) => { messages.push(content); },
    pushNotificationToUser() {},
    pushVoteUpdate(data) { voteUpdates.push(data); },
    pushSessionUpdate() {},
    broadcastGlobalScoped() {},
    pushIssueUpdate() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 1, majority: 1 }),
    isUserActive: async () => true,
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.appAdmins, {
    detectAdminsChange: async () => ({ determinate: false }),
    stampExplicitApproval: async () => {},
  });
  stub(ids.events, {
    record() {},
    EVENT_TYPES: { PR_MERGED: 'pr_merged', BOUNTY_AWARDED: 'bounty_awarded' },
  });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.governance, {
    governedGate: async () => ({
      mergeable: true,
      thresholdMet: true,
      lazyArmed: false,
      windowElapsed: true,
      qualifiedYes: 1,
      qualifiedNo: 0,
      activeCount: 1,
      required: 1,
      mode: 'default',
      policy: 'anyone',
      windowEndsAt: null,
    }),
  });
  stub(ids.mergeDebug, { startRun: async () => 1, step: async () => {}, endRun: async () => {} });
  stub(ids.worker, { isInFlight: () => false, destroyCcVolume: async () => {} });
  stub(ids.visuals, {
    setChecksPending: async (_pool, sessionId, sha) => { pendingCalls.push({ sessionId, sha }); },
    notifyChecksPending() {},
  });
  stub(ids.prImportSync, {
    rerunChecksForNewHead: async (args) => { rerunCalls.push(args); },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [key, id] of Object.entries(ids)) {
      if (original[key]) require.cache[id] = original[key];
      else delete require.cache[id];
    }
  };
  return {
    subject, mergeCalls, pendingCalls, rerunCalls, voteUpdates, messages,
    rebuilds, restore,
  };
}

function nativeSession(extra = {}) {
  return {
    id: 41,
    app_id: 7,
    app_slug: 'demo',
    app_name: 'Demo',
    app_self_hosted: false,
    repo_url: 'https://github.com/acme/demo',
    pr_number: 19,
    pr_title: 'Native proposal',
    branch_name: 'codex/change',
    user_id: 3,
    behind_main: 0,
    source: 'native',
    reviewed_head_sha: OLD,
    checks_commit_sha: OLD,
    ...extra,
  };
}

test('schema adds a generalized native reviewed-head stamp', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.match(schema,
    /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS reviewed_head_sha\s+VARCHAR\(40\)/);
});

test('native head reconciliation clears stale votes and re-runs checks at the new SHA', async () => {
  const ctx = loadVotes({ liveHead: NEW });
  const pool = recordingPool([
    [/WITH claimed AS[\s\S]*UPDATE chat_sessions/, [{
      reviewed_head_sha: NEW, votes_deleted: 2,
    }]],
  ]);
  const session = nativeSession();
  try {
    const result = await ctx.subject.reconcileNativeReviewedHead({
      config: {}, pool, session, fresh: true,
    });
    assert.equal(result.changed, true);
    assert.equal(result.headSha, NEW);
    assert.equal(result.votesDropped, 2);
    assert.equal(session.reviewed_head_sha, NEW);

    const update = pool.queries.find((q) => /UPDATE chat_sessions/.test(q.sql));
    assert.deepEqual(update.params, [NEW, session.id, OLD],
      'optimistic update cannot overwrite a newer concurrent head');
    assert.match(update.sql, /DELETE FROM pr_votes/,
      'the head move and stale-vote cleanup share one atomic statement');
    assert.match(update.sql, /head_sha IS DISTINCT FROM \$1/,
      'only approvals for another revision are deleted');
    assert.deepEqual(ctx.pendingCalls, [{ sessionId: session.id, sha: NEW }]);
    assert.equal(ctx.rerunCalls[0].newHead, NEW);
    assert.ok(ctx.messages.some((m) => /earlier votes were cleared/i.test(m)));
  } finally {
    ctx.restore();
  }
});

test('a native PR without repository identity fails closed', async () => {
  const ctx = loadVotes();
  const pool = recordingPool();
  try {
    const result = await ctx.subject.reconcileNativeReviewedHead({
      config: {},
      pool,
      session: nativeSession({ repo_url: null }),
      fresh: true,
    });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /no GitHub repository/i);
    assert.equal(pool.queries.length, 0);
  } finally {
    ctx.restore();
  }
});

test('background governance sweep refreshes native head before it can count or reject votes', async () => {
  const ctx = loadVotes({ liveHead: NEW });
  const pool = recordingPool([
    [/WITH claimed AS[\s\S]*UPDATE chat_sessions/, [{
      reviewed_head_sha: NEW, votes_deleted: 3,
    }]],
  ]);
  const session = nativeSession();
  try {
    const prepared = await ctx.subject.reconcilePromotedSweepHead({
      config: {}, pool, session,
    });
    assert.equal(prepared.blocked, undefined);
    assert.equal(prepared.changed, true);
    assert.equal(prepared.headSha, NEW,
      'the governance gate must be scoped to the newly fetched revision');
    assert.equal(prepared.votesDropped, 3,
      'old-revision No votes are removed before the caller evaluates rejection');

    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const sweepStart = server.indexOf('const sweepRevision = await reconcilePromotedSweepHead');
    const gateStart = server.indexOf('const gate = await governance.governedGate', sweepStart);
    assert.ok(sweepStart >= 0 && gateStart > sweepStart,
      'the sweeper awaits live revision reconciliation before governance');
    assert.match(server.slice(gateStart, gateStart + 500),
      /headSha: sweepRevision\.headSha/);
  } finally {
    ctx.restore();
  }
});

test('background governance sweep preserves imported PR head semantics', async () => {
  const ctx = loadVotes({ liveHead: NEW });
  const pool = recordingPool();
  const session = nativeSession({
    source: 'imported',
    imported_pr_head_sha: OLD,
    reviewed_head_sha: null,
  });
  try {
    const prepared = await ctx.subject.reconcilePromotedSweepHead({
      config: {}, pool, session,
    });
    assert.equal(prepared.imported, true);
    assert.equal(prepared.headSha, OLD);
    assert.equal(pool.queries.length, 0, 'the native reconciler never mutates imported rows');
  } finally {
    ctx.restore();
  }
});

test('a passing check for an older native commit is merge-blocked and re-run exactly', async () => {
  const ctx = loadVotes({ liveHead: NEW });
  const pool = recordingPool([
    [/SELECT check_state, test_results/, [{
      check_state: 'passing',
      test_results: [],
      checks_checked_at: new Date().toISOString(),
      checks_commit_sha: OLD,
    }]],
    [/SET status = 'merging'/, [{ id: 41 }]],
  ]);
  const session = nativeSession({ reviewed_head_sha: NEW, checks_commit_sha: OLD });
  try {
    const result = await ctx.subject.checkAndMerge({}, pool, session);
    assert.equal(result.merged, false);
    assert.equal(result.checksBlocked, true);
    assert.equal(result.checksRevisionMismatch, true);
    assert.ok(!pool.queries.some((q) => /SET status = 'merging'/.test(q.sql)),
      'an old green check never reaches the merge claim');
    assert.deepEqual(ctx.pendingCalls, [{ sessionId: session.id, sha: NEW }]);
    assert.equal(ctx.rerunCalls[0].newHead, NEW);
    assert.equal(ctx.mergeCalls.length, 0);
  } finally {
    ctx.restore();
  }
});

test('native head-moved merge returns to review and resets against the new live SHA', async () => {
  const moved = new Error('head changed');
  moved.headMoved = true;
  const ctx = loadVotes({ liveHead: NEW, mergeImpl: async () => { throw moved; } });
  const pool = recordingPool([
    [/SET status = 'merging'/, [{ id: 41 }]],
    [/SET status = 'promoted'/, { rows: [], rowCount: 1 }],
    [/WITH claimed AS[\s\S]*UPDATE chat_sessions/, [{
      reviewed_head_sha: NEW, votes_deleted: 1,
    }]],
  ]);
  const session = nativeSession();
  try {
    const result = await ctx.subject.checkAndMerge({}, pool, session, {
      force: true,
      forceBy: { id: 1, username: 'admin' },
    });
    assert.equal(result.merged, false);
    assert.equal(result.headMoved, true);
    assert.equal(result.reviewedHeadSha, NEW);
    assert.equal(ctx.mergeCalls.length, 1);
    assert.equal(ctx.mergeCalls[0].sha, OLD, 'GitHub merge expected the reviewed SHA');
    assert.equal(ctx.rebuilds.length, 0, 'nothing deploys after GitHub rejects the stale head');
    assert.ok(pool.queries.some((q) => /SET status = 'promoted'/.test(q.sql)),
      'merge claim is released back to review');
    assert.ok(pool.queries.some((q) => /DELETE FROM pr_votes/.test(q.sql)),
      'old-revision approvals are cleared immediately');
    assert.deepEqual(ctx.pendingCalls, [{ sessionId: session.id, sha: NEW }]);
    assert.equal(ctx.rerunCalls[0].newHead, NEW);
    assert.ok(ctx.voteUpdates.some((u) => u.headMoved === true));
  } finally {
    ctx.restore();
  }
});

test('a pinned native 409 with an unchanged head follows conflict recovery', async () => {
  const refused = new Error('Pull Request is not mergeable');
  refused.headMoved = true;
  const ctx = loadVotes({ liveHead: OLD, mergeImpl: async () => { throw refused; } });
  const pool = recordingPool([
    [/SET status = 'merging'/, [{ id: 41 }]],
    [/SET status = 'promoted'/, { rows: [], rowCount: 1 }],
  ]);
  const session = nativeSession();
  try {
    const result = await ctx.subject.checkAndMerge({}, pool, session, {
      force: true,
      forceBy: { id: 1, username: 'admin' },
    });
    assert.equal(result.merged, false);
    assert.equal(result.conflict, true,
      'an unchanged reviewed head means GitHub reported a merge conflict, not new code');
    assert.equal(result.headMoved, undefined);
    assert.ok(!pool.queries.some((q) => /DELETE FROM pr_votes/.test(q.sql)),
      'valid approvals are not cleared for an unchanged commit');
    assert.equal(ctx.pendingCalls.length, 0);
    assert.ok(ctx.voteUpdates.some((u) => u.mergeFailed && u.resolving),
      'the ordinary conflict resolver path is engaged');
  } finally {
    ctx.restore();
  }
});

test('an ambiguous native 409 defers when GitHub cannot verify the live head', async () => {
  const refused = new Error('conflict');
  refused.headMoved = true;
  const ctx = loadVotes({
    mergeImpl: async () => { throw refused; },
    getPRImpl: async () => { throw new Error('GitHub unavailable'); },
  });
  const pool = recordingPool([
    [/SET status = 'merging'/, [{ id: 41 }]],
    [/SET status = 'promoted'/, { rows: [], rowCount: 1 }],
  ]);
  const session = nativeSession();
  try {
    const result = await ctx.subject.checkAndMerge({}, pool, session, {
      force: true,
      forceBy: { id: 1, username: 'admin' },
    });
    assert.equal(result.merged, false);
    assert.equal(result.revisionBlocked, true);
    assert.equal(result.transient, true);
    assert.equal(result.conflict, undefined,
      'the platform does not guess whether an ambiguous 409 was a head move or conflict');
    assert.equal(ctx.rebuilds.length, 0);
    assert.ok(pool.queries.some((q) => /SET status = 'promoted'/.test(q.sql)),
      'the merge claim is released for a safe retry');
  } finally {
    ctx.restore();
  }
});

test('a vote is accepted only for the native revision rendered by the browser', () => {
  const ctx = loadVotes({ liveHead: NEW });
  try {
    assert.equal(ctx.subject.voteMatchesReviewedRevision(NEW, {
      enforced: true, headSha: NEW,
    }), true);
    assert.equal(ctx.subject.voteMatchesReviewedRevision(OLD, {
      enforced: true, headSha: NEW,
    }), false, 'a click rendered for the old commit cannot approve the new one');
    assert.equal(ctx.subject.voteMatchesReviewedRevision(null, {
      enforced: true, headSha: NEW,
    }), false, 'cached clients without a revision stamp fail closed');
    assert.equal(ctx.subject.voteMatchesReviewedRevision(null, {
      enforced: false, headSha: null,
    }), true, 'GitHub-disabled/local rows retain their existing behavior');
  } finally {
    ctx.restore();
  }
});

test('native vote write locks and verifies the stored reviewed head atomically', async () => {
  const ctx = loadVotes({ liveHead: NEW });
  const pool = recordingPool([
    [/WITH current_session AS/, [{ id: 99 }]],
  ]);
  const session = nativeSession({ reviewed_head_sha: NEW });
  try {
    const result = await ctx.subject.recordVote({
      pool, session, userId: 8, vote: 'yes', headSha: NEW, revisionEnforced: true,
    });
    assert.equal(result.rowCount, 1);
    const write = pool.queries[0];
    assert.match(write.sql, /reviewed_head_sha = \$4::varchar/);
    assert.match(write.sql, /FOR UPDATE/,
      'a concurrent head transition cannot slip between verification and insert');
    assert.match(write.sql, /INSERT INTO pr_votes/);
    assert.deepEqual(write.params, [session.id, 8, 'yes', NEW]);
  } finally {
    ctx.restore();
  }
});

test('a 409 recognizes a new head already installed by a concurrent verifier', async () => {
  const refused = new Error('head changed');
  refused.headMoved = true;
  const ctx = loadVotes({ liveHead: NEW, mergeImpl: async () => { throw refused; } });
  const pool = recordingPool([
    [/SET status = 'merging'/, [{ id: 41 }]],
    [/WITH claimed AS[\s\S]*UPDATE chat_sessions/, []],
    [/SELECT reviewed_head_sha FROM chat_sessions/, [{ reviewed_head_sha: NEW }]],
    [/SET status = 'promoted'/, { rows: [], rowCount: 1 }],
  ]);
  const session = nativeSession();
  try {
    const result = await ctx.subject.checkAndMerge({}, pool, session, {
      force: true,
      forceBy: { id: 1, username: 'admin' },
    });
    assert.equal(result.headMoved, true);
    assert.equal(result.reviewedHeadSha, NEW);
    assert.equal(result.revisionBlocked, undefined,
      'a verified different head is not reported as an unverifiable revision');
  } finally {
    ctx.restore();
  }
});
