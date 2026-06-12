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

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => makePool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    mergePR: async () => { throw mergeError; },
  });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async (...args) => { resolverCalls.push(args); return { ok: true }; },
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
  return { subject, voteUpdates, resolverCalls, restore };
}

const session = {
  id: 7, app_id: 5, app_slug: 'widget', app_self_hosted: true,
  repo_url: 'https://github.com/acme/widget', pr_number: 12,
  pr_title: 'Widget tweak', user_id: 3, behind_main: 0,
};

const pool = () => makePool([
  [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
  [/SET status = 'merging'/, [{ id: 7 }]],
  [/SET behind_main = GREATEST/, [{ behind_main: 1 }]],
]);

test('checkAndMerge catch: 405 conflict failure broadcasts mergeFailed with resolving:true', async () => {
  const err = Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });
  const { subject, voteUpdates, resolverCalls, restore } = loadVotesWithFailingMerge(err);
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool(), { ...session }, { force: true });
    assert.equal(r.merged, false);
    assert.equal(r.conflict, true);

    const failed = voteUpdates.filter((u) => u.mergeFailed);
    assert.equal(failed.length, 1, 'exactly one mergeFailed broadcast');
    assert.equal(failed[0].resolving, true, 'conflict + autoResolve → resolving rides along');
    assert.equal(failed[0].selfHosted, true);
    assert.equal(failed[0].sessionId, 7);
    assert.equal(resolverCalls.length, 1, 'the auto-resolver was actually kicked off');
  } finally {
    restore();
  }
});

test('checkAndMerge catch: generic failure broadcasts mergeFailed with resolving:false', async () => {
  const { subject, voteUpdates, resolverCalls, restore } =
    loadVotesWithFailingMerge(new Error('secondary rate limit'));
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool(), { ...session }, { force: true });
    assert.equal(r.merged, false);
    assert.equal(r.conflict, false);

    const failed = voteUpdates.filter((u) => u.mergeFailed);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].resolving, false, 'no resolver coming → clients cancel as before');
    assert.equal(resolverCalls.length, 0, 'generic failures never fire the resolver');
  } finally {
    restore();
  }
});

test('checkAndMerge catch: conflict failure with autoResolve:false broadcasts resolving:false', async () => {
  const err = Object.assign(new Error('merge conflict'), { status: 405 });
  const { subject, voteUpdates, resolverCalls, restore } = loadVotesWithFailingMerge(err);
  try {
    // The resolver's own retry path calls checkAndMerge with
    // autoResolve:false — its conflict failure must not claim a
    // resolver is coming (none is).
    const r = await subject.checkAndMerge(
      { jwtSecret: 's' }, pool(), { ...session }, { force: true, autoResolve: false }
    );
    assert.equal(r.merged, false);
    const failed = voteUpdates.filter((u) => u.mergeFailed);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].resolving, false);
    assert.equal(resolverCalls.length, 0);
  } finally {
    restore();
  }
});
