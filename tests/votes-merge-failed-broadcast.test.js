// #239: the mergeFailed vote_update broadcast from checkAndMerge's
// catch block must carry `resolving: true` when the failure is a
// conflict-class error (405 / "not mergeable") and the auto-resolver is
// about to kick in — that's what lets clients transition the platform
// banner in place (updating → resolving) instead of silently dismissing
// it. Generic failures keep `resolving: false` and the old cancel
// behaviour.
//
// Same require.cache stubbing pattern as the other suites — nothing
// real (GitHub, docker, staging) spins up.
//
// Run with: node --test tests/votes-merge-failed-broadcast.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// routes/votes.js requires express at module level but only calls
// Router() inside voteRoutes(), which this suite never invokes. Serve a
// stub through Module._load so the suite is hermetic (and runs even
// where node_modules isn't installed) — require.cache stubbing can't
// cover a package, since resolution happens before the cache lookup.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({}) };
  return _origLoad.call(this, request, ...rest);
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makePool(handlers) {
  return {
    async query(sql, params) {
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
  };
}

// Loads routes/votes with every collaborator stubbed and a mergePR that
// throws `mergeError`. Drives checkAndMerge with force:true so the vote
// gates are skipped and the run goes straight to the GitHub merge.
function loadVotesWithFailingMerge(mergeError) {
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
  const resolverCalls = [];
  const retryCalls = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => makePool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    mergePR: async () => { throw mergeError; },
  });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.resolver, {
    // Vote-driven conflict / behind_main auto-resolve paths funnel through
    // the app-level drain (checkAndResolveConflicts) so resolves are
    // serialized one-per-app. A FORCED merge that conflicts instead fires a
    // per-session resolveAndMaybeRetry carrying the force intent (the drain
    // would re-apply the vote gate the admin just bypassed and skip the PR).
    checkAndResolveConflicts: async (...args) => { resolverCalls.push(args); return undefined; },
    resolveAndMaybeRetry: async (...args) => { retryCalls.push(args); return { ok: true }; },
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async () => {},
    pushNotificationToUser() {},
    pushVoteUpdate(data) { voteUpdates.push(data); },
    pushSessionUpdate() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 1, majority: 1 }),
    isUserActive: async () => true,
    mergeGate: () => ({
      required: 1, windowMs: 0, windowEndsAt: null, contested: false,
      thresholdMet: true, windowElapsed: true, mergeable: true,
    }),
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, {});
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, voteUpdates, resolverCalls, retryCalls, restore };
}

const session = {
  id: 7, app_id: 5, app_slug: 'widget', app_self_hosted: true,
  repo_url: 'https://github.com/acme/widget', pr_number: 12,
  pr_title: 'Widget tweak', user_id: 3, behind_main: 0,
};

const pool = () => makePool([
  [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
  [/SELECT check_state, test_results/, [{ check_state: 'passing', test_results: [] }]],
  [/SET status = 'merging'/, [{ id: 7 }]],
  [/SET behind_main = GREATEST/, [{ behind_main: 1 }]],
]);

test('checkAndMerge catch: forced 405 conflict fires the per-session resolver with force preserved', async () => {
  const err = Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });
  const { subject, voteUpdates, resolverCalls, retryCalls, restore } = loadVotesWithFailingMerge(err);
  try {
    const forceBy = { id: 1, username: 'admin' };
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool(), { ...session }, { force: true, forceBy });
    assert.equal(r.merged, false);
    assert.equal(r.conflict, true);

    const failed = voteUpdates.filter((u) => u.mergeFailed);
    assert.equal(failed.length, 1, 'exactly one mergeFailed broadcast');
    assert.equal(failed[0].resolving, true, 'conflict + autoResolve → resolving rides along');
    assert.equal(failed[0].selfHosted, true);
    assert.equal(failed[0].sessionId, 7);

    // Force-carry-through: the recovery must NOT be handed to the
    // gate-filtered app drain (which would re-apply the vote gate the admin
    // just bypassed and skip a below-threshold PR) — it resolves THIS
    // session directly, with the force intent threaded so the post-sync
    // retry merge stays forced.
    assert.equal(resolverCalls.length, 0, 'forced conflicts skip the gate-filtered drain');
    assert.equal(retryCalls.length, 1, 'a per-session resolve was dispatched');
    const [, target, opts] = retryCalls[0];
    assert.deepEqual(target, { sessionId: 7 });
    assert.equal(opts.force, true, 'the force flag survives into the resolver');
    assert.deepEqual(opts.forceBy, forceBy, 'the forcing admin rides along');
    assert.equal(opts.mergeOnly, false, 'the worker sync is allowed');
  } finally {
    restore();
  }
});

test('checkAndMerge catch: vote-driven 405 conflict still funnels through the app drain', async () => {
  const err = Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });
  const { subject, voteUpdates, resolverCalls, retryCalls, restore } = loadVotesWithFailingMerge(err);
  try {
    // No force: the (stubbed always-mergeable) vote gate admits the merge,
    // GitHub 405s, and recovery goes through the serialized app-level drain.
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool(), { ...session }, {});
    assert.equal(r.merged, false);
    assert.equal(r.conflict, true);

    const failed = voteUpdates.filter((u) => u.mergeFailed);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].resolving, true);
    assert.equal(resolverCalls.length, 1, 'the app-level drain was kicked off');
    assert.deepEqual(resolverCalls[0][1], { app_id: 5 });
    assert.equal(retryCalls.length, 0, 'no per-session force resolve on the vote path');
  } finally {
    restore();
  }
});

// #384: the ⚠ "Conflicts" badge is only honest if the 'conflict'
// snapshot is written by a REAL auto-merge attempt that failed. This is
// the one legitimate writer (the speculative mergeability-check writer in
// conflict-resolver.js was removed), so guard that it keeps persisting
// merge_conflict_state='conflict' on a 405 conflict failure.
test('#384: checkAndMerge catch persists merge_conflict_state=conflict on a 405 conflict failure', async () => {
  const err = Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });
  const { subject, restore } = loadVotesWithFailingMerge(err);
  try {
    const calls = [];
    const recordingPool = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (/SET behind_main = GREATEST/.test(sql)) return { rows: [{ behind_main: 1 }] };
        if (/SET status = 'merging'/.test(sql)) return { rows: [{ id: 7 }] };
        if (/SELECT COUNT\(\*\) as cnt FROM pr_votes/.test(sql)) return { rows: [{ cnt: '1' }] };
        return { rows: [] };
      },
    };
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, recordingPool, { ...session }, { force: true });
    assert.equal(r.conflict, true);

    const bump = calls.find((c) => /SET behind_main = GREATEST/.test(c.sql));
    assert.ok(bump, 'the conflict path issues the behind_main/merge_conflict_state bump');
    assert.match(bump.sql, /merge_conflict_state = 'conflict'/,
      'the real merge-time conflict still records the conflict snapshot');
  } finally {
    restore();
  }
});

test('checkAndMerge catch: generic failure broadcasts mergeFailed with resolving:false', async () => {
  const { subject, voteUpdates, resolverCalls, retryCalls, restore } =
    loadVotesWithFailingMerge(new Error('secondary rate limit'));
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool(), { ...session }, { force: true });
    assert.equal(r.merged, false);
    assert.equal(r.conflict, false);

    const failed = voteUpdates.filter((u) => u.mergeFailed);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].resolving, false, 'no resolver coming → clients cancel as before');
    assert.equal(resolverCalls.length, 0, 'generic failures never fire the resolver');
    assert.equal(retryCalls.length, 0);
  } finally {
    restore();
  }
});

test('checkAndMerge catch: conflict failure with autoResolve:false broadcasts resolving:false', async () => {
  const err = Object.assign(new Error('merge conflict'), { status: 405 });
  const { subject, voteUpdates, resolverCalls, retryCalls, restore } = loadVotesWithFailingMerge(err);
  try {
    // The resolver's own retry path calls checkAndMerge with
    // autoResolve:false — its conflict failure must not claim a
    // resolver is coming (none is), even on the forced path (this bounds
    // the forced resolve+retry to a single cycle too).
    const r = await subject.checkAndMerge(
      { jwtSecret: 's' }, pool(), { ...session }, { force: true, autoResolve: false }
    );
    assert.equal(r.merged, false);
    const failed = voteUpdates.filter((u) => u.mergeFailed);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].resolving, false);
    assert.equal(resolverCalls.length, 0);
    assert.equal(retryCalls.length, 0, 'no re-entrant force resolve either');
  } finally {
    restore();
  }
});
