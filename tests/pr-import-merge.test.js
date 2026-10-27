// Unit tests for #687 Slice 4 — exact-SHA merge.
//
// Covers (spec "Tests"):
//   - github.mergePR forwards an optional `sha` to octokit.rest.pulls.merge,
//     and surfaces GitHub's 409 (only when a sha was pinned) as a distinct
//     HeadMovedError; generic calls without a sha keep the raw error.
//   - the merge gate re-pins an imported row from the mirror before it is
//     found ready (the pinned merge itself: tests/merge-attempt.test.js).
//
// Everything after GitHub's merge (the deploy, the teardown, the merge line)
// belongs to the merge-followups workflow machine, the same for native and
// imported merges; tests/workflow-merge-followups-postgres.test.js covers it.
//
// Run with: node --test tests/pr-import-merge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// The REAL pure merge gate, grabbed before any stubbing.
const { mergeGate } = require('../src/services/active-users');

// The imported-merge path picks the mock GitHub client when
// USERNODE_ENV === 'staging'. This suite exercises the REAL-client path
// (github is stubbed below), so pin the env to production regardless of
// what the harness set.
process.env.USERNODE_ENV = 'production';

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

test('mergePR: omits sha entirely when a generic caller passes none', async () => {
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

test('mergePR: a 409 WITHOUT a pinned sha is NOT reinterpreted', async () => {
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

// ── the merge gate: an imported row's pin ──────────────────────────────

// Loads routes/votes with collaborators stubbed. `mergeImpl` lets each test
// script GitHub's merge behaviour; every other collaborator is a no-op so
// nothing real spins up. Returns the loaded module + captured side effects.
function loadVotes({ mergeImpl, reconcileImpl = null }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    prImportSync: require.resolve('../src/services/pr-import-sync'),
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
    governance: require.resolve('../src/services/governance'),
    mergeDebug: require.resolve('../src/services/merge-debug'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const mergeCalls = [];
  const voteUpdates = [];
  const systemMessages = [];
  const reports = [];
  const reconcileCalls = [];
  const requeues = [];
  const claims = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  // The mirror-driven re-pin (#2100). Scripted per test; the default answers
  // what a fork-hosted head answers, which leaves the merge path as it was.
  stub(ids.prImportSync, {
    async reconcileImportedHead(args) {
      reconcileCalls.push(args);
      if (reconcileImpl) return reconcileImpl(args, reconcileCalls.length);
      return { reconciled: false, reason: 'fork_head' };
    },
    async rerunChecksForNewHead() {},
    async kickImportedChecks() {},
    async syncImportedProposal() { return 'unchanged'; },
  });
  stub(ids.pool, { getPool: () => makeRecordingPool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    mergePR: async (owner, repo, prNumber, sha = null) => {
      mergeCalls.push({ owner, repo, prNumber, sha });
      return mergeImpl({ owner, repo, prNumber, sha });
    },
    HeadMovedError: require('../src/services/github').HeadMovedError,
  });
  // The merge's claim and its releases are the proposal machine's
  // (platform.claimMerge / releaseMerge): granted here, and recorded.
  stub(ids.platform, {
    mergeConfirmed: async (m) => { reports.push(m); return { status: 'accepted', eventId: 1 }; },
    claimMerge: async (c) => { claims.push(['claim', c]); return { status: 'accepted', reply: { claim: 1 } }; },
    releaseMerge: async (r) => { claims.push(['release', r]); return { status: 'accepted', reply: {} }; },
    abandonMerge: async (r) => { claims.push(['abandon', r]); return { status: 'accepted', reply: {} }; },
  });
  stub(ids.docker, {});
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content, _t, meta, thread) => { systemMessages.push({ content, thread, meta }); },
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

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return {
    subject, mergeCalls, voteUpdates, systemMessages, reports,
    reconcileCalls, requeues, claims, restore,
  };
}

const nativeSession = {
  id: 11, app_id: 5, app_slug: 'demo', app_self_hosted: false,
  repo_url: 'https://github.com/acme/demo', pr_number: 30,
  pr_title: 'Native change', user_id: 3, behind_main: 0, source: 'native',
  reviewed_head_sha: 'b'.repeat(40),
};
const importedSession = {
  id: 12, app_id: 5, app_slug: 'demo', app_self_hosted: false,
  repo_url: 'https://github.com/acme/demo', pr_number: 31,
  pr_title: 'Imported change', user_id: 4, behind_main: 0,
  source: 'imported', imported_pr_head_sha: 'reviewedhead',
};
const cliSession = {
  id: 13, app_id: 5, app_slug: 'demo', app_self_hosted: false,
  repo_url: 'https://github.com/acme/demo', pr_number: 32,
  pr_title: 'CLI handoff change', user_id: 5, behind_main: 0,
  source: 'cli_handoff', handoff_head_sha: 'lastlocalhead',
  checks_commit_sha: 'sharedreviewedhead',
  reviewed_head_sha: 'sharedreviewedhead',
};

function mergeReadyPool() {
  return makeRecordingPool([]);
}

// The merge gate re-pins an imported row from the mirror before it is found
// ready: the merge is offered the commit the platform's own sync pushed, not
// the one the poller last saw (#2100, #2095). GitHub's half of the merge
// (the pinned sha, a 409) is tests/merge-attempt.test.js.

test('the gate: an imported row is re-pinned from the mirror before it is found ready', async () => {
  const SYNCED = 's'.repeat(40);
  const { subject, mergeCalls, reconcileCalls, restore } = loadVotes({
    mergeImpl: () => ({ sha: 'squashsha', merged: true }),
    reconcileImpl: ({ session }) => {
      session.imported_pr_head_sha = SYNCED;
      return { reconciled: true, changed: true, headSha: SYNCED, kind: 'mechanical', votesKept: true };
    },
  });
  try {
    const r = await subject.evaluateMergeGate({ jwtSecret: 's' }, mergeReadyPool(), { ...importedSession }, { force: true });
    assert.equal(r.ready, true);
    assert.equal(reconcileCalls[0].checks, 'defer',
      'the rebuild is left to the checks gate, which rebuilds exactly the pinned head');
    assert.deepEqual(mergeCalls, [], 'the gate never asks GitHub to merge');
  } finally {
    restore();
  }
});

test('the gate: an authored push found at the door returns the imported row to review', async () => {
  const PUSHED = 'p'.repeat(40);
  const { subject, mergeCalls, restore } = loadVotes({
    mergeImpl: () => ({ sha: 'squashsha', merged: true }),
    reconcileImpl: ({ session }) => {
      session.imported_pr_head_sha = PUSHED;
      return { reconciled: true, changed: true, headSha: PUSHED, kind: 'authored', votesKept: false };
    },
  });
  try {
    const r = await subject.evaluateMergeGate({ jwtSecret: 's' }, mergeReadyPool(), { ...importedSession }, { force: true });
    assert.notEqual(r.ready, true);
    assert.equal(r.reviewReset, true, 'same shape as the native return-to-review');
    assert.equal(r.reviewedHeadSha, PUSHED);
    assert.deepEqual(mergeCalls, []);
  } finally {
    restore();
  }
});
