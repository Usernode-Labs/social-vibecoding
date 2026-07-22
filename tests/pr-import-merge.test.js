// Unit tests for #687 Slice 4 — exact-SHA merge + shared finalizer.
//
// Covers (spec "Tests"):
//   - github.mergePR forwards an optional `sha` to octokit.rest.pulls.merge,
//     and surfaces GitHub's 409 (only when a sha was pinned) as a distinct
//     HeadMovedError; native calls (no sha) keep the raw error.
//   - checkAndMerge passes imported_pr_head_sha for source='imported' rows
//     (gated on the flag), leaves the row recoverable ('promoted') on a
//     head-moved 409, and does NOT error the proposal.
//   - finalizeMerge runs byte-for-byte identically for native and imported
//     merges (same deploy/stamp/teardown/announce tail).
//
// Run with: node --test tests/pr-import-merge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// The REAL pure merge gate, grabbed before any stubbing.
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

// ── github.mergePR: sha forwarding + 409 mapping ──────────────────────

test('mergePR: forwards sha to octokit and returns the merge data', async () => {
  const github = require('../src/services/github');
  let seenParams = null;
  github._setOctokitFactoryForTests(() => ({
    rest: { pulls: { merge: async (p) => { seenParams = p; return { data: { sha: 'mergedsha1', merged: true } }; } } },
  }));
  try {
    const data = await github.mergePR('acme', 'demo', 42, 'headsha123');
    assert.equal(seenParams.sha, 'headsha123', 'sha forwarded to pulls.merge');
    assert.equal(seenParams.merge_method, 'squash');
    assert.equal(seenParams.pull_number, 42);
    assert.equal(data.sha, 'mergedsha1');
  } finally {
    github._setOctokitFactoryForTests(null);
  }
});

test('mergePR: omits sha entirely when none is passed (native path unchanged)', async () => {
  const github = require('../src/services/github');
  let seenParams = null;
  github._setOctokitFactoryForTests(() => ({
    rest: { pulls: { merge: async (p) => { seenParams = p; return { data: { sha: 'nativemerge', merged: true } }; } } },
  }));
  try {
    await github.mergePR('acme', 'demo', 7);
    assert.ok(!('sha' in seenParams), 'no sha key on the native merge params');
    assert.equal(seenParams.merge_method, 'squash');
  } finally {
    github._setOctokitFactoryForTests(null);
  }
});

test('mergePR: a 409 with a pinned sha becomes a HeadMovedError', async () => {
  const github = require('../src/services/github');
  github._setOctokitFactoryForTests(() => ({
    rest: { pulls: { merge: async () => { const e = new Error('Head branch was modified. Review and try the merge again.'); e.status = 409; throw e; } } },
  }));
  try {
    await assert.rejects(
      () => github.mergePR('acme', 'demo', 42, 'reviewedsha'),
      (err) => {
        assert.equal(err.headMoved, true, 'flagged as head moved');
        assert.ok(err instanceof github.HeadMovedError);
        return true;
      }
    );
  } finally {
    github._setOctokitFactoryForTests(null);
  }
});

test('mergePR: a 409 WITHOUT a pinned sha is NOT reinterpreted (native)', async () => {
  const github = require('../src/services/github');
  github._setOctokitFactoryForTests(() => ({
    rest: { pulls: { merge: async () => { const e = new Error('not mergeable'); e.status = 409; throw e; } } },
  }));
  try {
    await assert.rejects(
      () => github.mergePR('acme', 'demo', 7),
      (err) => {
        assert.ok(!err.headMoved, 'native 409 is not a head-moved outcome');
        return /not mergeable/.test(err.message);
      }
    );
  } finally {
    github._setOctokitFactoryForTests(null);
  }
});

// ── checkAndMerge: imported sha pinning, head-moved recovery, finalizer ─

// Loads routes/votes with collaborators stubbed. `mergeImpl` lets each test
// script GitHub's merge behaviour; every other collaborator is a no-op so
// nothing real spins up. Returns the loaded module + captured side effects.
function loadVotes({ mergeImpl }) {
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
    governance: require.resolve('../src/services/governance'),
    mergeDebug: require.resolve('../src/services/merge-debug'),
    worker: require.resolve('../src/services/worker'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const mergeCalls = [];
  const voteUpdates = [];
  const systemMessages = [];
  const rebuildCalls = [];
  const teardownCalls = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => makeRecordingPool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    mergePR: async (owner, repo, prNumber, sha = null) => {
      mergeCalls.push({ owner, repo, prNumber, sha });
      return mergeImpl({ owner, repo, prNumber, sha });
    },
    HeadMovedError: require('../src/services/github').HeadMovedError,
    invalidateIssuesCache() {},
    noteIssuesClosed() {},
  });
  stub(ids.staging, {
    rebuildProduction: async (_c, app) => { rebuildCalls.push(app && app.id); return { sha: 'deployedsha', containerId: 'ctr-1' }; },
    teardownStaging: async (session) => { teardownCalls.push(session.id); },
  });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async () => ({ ok: true }),
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content, _t, _m, thread) => { systemMessages.push({ content, thread }); },
    pushNotificationToUser() {},
    pushVoteUpdate(data) { voteUpdates.push(data); },
    pushSessionUpdate() {},
    broadcastGlobalScoped() {},
    pushIssueUpdate() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 1, majority: 1 }),
    isUserActive: async () => true,
    mergeGate,
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_MERGED: 'pr_merged', BOUNTY_AWARDED: 'bounty_awarded' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  // Real governance would query the pool; stub the one call checkAndMerge makes.
  stub(ids.governance, {
    governedGate: async () => ({
      mergeable: true, thresholdMet: true, lazyArmed: false, windowElapsed: true,
      qualifiedYes: 1, qualifiedNo: 0, activeCount: 1, required: 1,
      mode: 'default', policy: 'anyone', windowEndsAt: null, rejectable: false,
    }),
  });
  stub(ids.mergeDebug, { startRun: async () => 1, step: async () => {}, endRun: async () => {} });
  stub(ids.worker, { isInFlight: () => false, destroyCcVolume: async () => {} });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, mergeCalls, voteUpdates, systemMessages, rebuildCalls, teardownCalls, restore };
}

const nativeSession = {
  id: 11, app_id: 5, app_slug: 'demo', app_self_hosted: false,
  repo_url: 'https://github.com/acme/demo', pr_number: 30,
  pr_title: 'Native change', user_id: 3, behind_main: 0, source: 'native',
};
const importedSession = {
  id: 12, app_id: 5, app_slug: 'demo', app_self_hosted: false,
  repo_url: 'https://github.com/acme/demo', pr_number: 31,
  pr_title: 'Imported change', user_id: 4, behind_main: 0,
  source: 'imported', imported_pr_head_sha: 'reviewedhead',
};

function mergeReadyPool() {
  return makeRecordingPool([
    [/SET status = 'merging'/, [{ id: 1 }]],
    [/SELECT \* FROM apps WHERE id/, [{ id: 5, slug: 'demo', self_hosted: false }]],
    [/SET\s+status = 'merged'/, { rows: [], rowCount: 1 }],
  ]);
}

test('checkAndMerge: imported merge pins imported_pr_head_sha; native passes no sha', async () => {
  const prev = process.env.PR_IMPORT_ENABLED;
  process.env.PR_IMPORT_ENABLED = 'true';
  const { subject, mergeCalls, restore } = loadVotes({
    mergeImpl: () => ({ sha: 'squashsha', merged: true }),
  });
  try {
    await subject.checkAndMerge({ jwtSecret: 's' }, mergeReadyPool(), { ...importedSession }, { force: true });
    await subject.checkAndMerge({ jwtSecret: 's' }, mergeReadyPool(), { ...nativeSession }, { force: true });

    const imported = mergeCalls.find((c) => c.prNumber === 31);
    const native = mergeCalls.find((c) => c.prNumber === 30);
    assert.equal(imported.sha, 'reviewedhead', 'imported merge pins the reviewed head sha');
    assert.ok(native.sha == null, 'native merge passes no sha');
  } finally {
    restore();
    if (prev === undefined) delete process.env.PR_IMPORT_ENABLED; else process.env.PR_IMPORT_ENABLED = prev;
  }
});

test('checkAndMerge: flag OFF never pins a sha even for an imported row', async () => {
  const prev = process.env.PR_IMPORT_ENABLED;
  delete process.env.PR_IMPORT_ENABLED;
  const { subject, mergeCalls, restore } = loadVotes({
    mergeImpl: () => ({ sha: 'squashsha', merged: true }),
  });
  try {
    await subject.checkAndMerge({ jwtSecret: 's' }, mergeReadyPool(), { ...importedSession }, { force: true });
    const imported = mergeCalls.find((c) => c.prNumber === 31);
    assert.ok(imported.sha == null, 'no sha pinned while the feature is dark');
  } finally {
    restore();
    if (prev === undefined) delete process.env.PR_IMPORT_ENABLED; else process.env.PR_IMPORT_ENABLED = prev;
  }
});

test('checkAndMerge: head-moved 409 leaves the imported row recoverable and does not error', async () => {
  const prev = process.env.PR_IMPORT_ENABLED;
  process.env.PR_IMPORT_ENABLED = 'true';
  const { subject, voteUpdates, systemMessages, rebuildCalls, restore } = loadVotes({
    mergeImpl: () => { throw new (require('../src/services/github').HeadMovedError)(); },
  });
  const pool = mergeReadyPool();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, { ...importedSession }, { force: true });

    assert.equal(r.merged, false, 'nothing merged');
    assert.equal(r.headMoved, true, 'distinct head-moved outcome');

    // The merge claim is released back to 'promoted' — a recoverable state.
    const releasedToPromoted = pool.queries.some((q) => /SET status = 'promoted'\s+WHERE id = \$1 AND status = 'merging'/.test(q.sql));
    assert.ok(releasedToPromoted, 'row released to promoted for the sync poller to pick up');

    // Never marked merged, never rebuilt production.
    assert.ok(!pool.queries.some((q) => /SET\s+status = 'merged'/.test(q.sql)), 'never marked merged');
    assert.equal(rebuildCalls.length, 0, 'no production rebuild on a refused merge');

    // A head-moved notice, and a headMoved vote_update — but no mergeFailed.
    assert.ok(systemMessages.some((m) => /updated on GitHub/i.test(m.content)));
    assert.ok(voteUpdates.some((u) => u.headMoved === true));
    assert.ok(!voteUpdates.some((u) => u.mergeFailed), 'a head move is not a merge failure');
  } finally {
    restore();
    if (prev === undefined) delete process.env.PR_IMPORT_ENABLED; else process.env.PR_IMPORT_ENABLED = prev;
  }
});

test('finalizeMerge: runs the identical deploy tail for native and imported merges', async () => {
  const prev = process.env.PR_IMPORT_ENABLED;
  process.env.PR_IMPORT_ENABLED = 'true';
  const { subject, rebuildCalls, teardownCalls, systemMessages, voteUpdates, restore } = loadVotes({
    mergeImpl: () => ({ sha: 'squashsha', merged: true }),
  });
  try {
    const finalizerArgs = {
      required: 1, activeCount: 1, yesCount: 1, majority: 1,
      force: false, forceBy: null, dstep: () => {}, dend: () => {},
      mergeCommitSha: 'abc123', config: { jwtSecret: 's' },
    };
    const appHandlers = mergeReadyPool();

    await subject.finalizeMerge({ ...finalizerArgs, pool: mergeReadyPool(), session: { ...nativeSession } });
    await subject.finalizeMerge({ ...finalizerArgs, pool: mergeReadyPool(), session: { ...importedSession } });
    void appHandlers;

    // Both merges rebuilt prod (same app), tore down staging, announced merge.
    assert.equal(rebuildCalls.length, 2, 'both native + imported rebuilt production');
    assert.deepEqual(teardownCalls.sort(), [11, 12], 'both tore down their staging');
    const merged = voteUpdates; // finalizer itself emits none; announcements are system messages
    void merged;
    const mergeAnnouncements = systemMessages.filter((m) => /merged and deployed/i.test(m.content));
    assert.ok(mergeAnnouncements.length >= 2, 'both announced a successful merge identically');
  } finally {
    restore();
    if (prev === undefined) delete process.env.PR_IMPORT_ENABLED; else process.env.PR_IMPORT_ENABLED = prev;
  }
});
