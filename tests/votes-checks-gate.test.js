// #47 "CI for proposals": checkAndMerge blocks a non-'passing' proposal —
// even with a winning vote — and lets a 'passing' one through. Admin
// force-merge bypasses the gate. Same require.cache stubbing pattern as
// votes-merge-deploy-failed.test.js — nothing real spins up.
//
// Run with: node --test tests/votes-checks-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

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

function loadVotes() {
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

  const systemMessages = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => makeRecordingPool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    mergePR: async () => ({ sha: 'deadbeefcafe', merged: true }),
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
  return { subject, systemMessages, restore };
}

const session = {
  id: 7, app_id: 5, app_slug: 'whiteboard', app_self_hosted: false,
  repo_url: 'https://github.com/acme/whiteboard', pr_number: 52,
  pr_title: 'Premium brushes', user_id: 3, behind_main: 0,
};

// Pool whose check_state row is configurable; majority is met (1 yes vote).
function poolWith(checkState, testResults) {
  return makeRecordingPool([
    [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
    [/SELECT check_state, test_results[\s\S]*FROM chat_sessions/, [{ check_state: checkState, test_results: testResults || [], check_error_detail: null }]],
    [/SET status = 'merging'/, [{ id: 7 }]],
    [/SELECT \* FROM apps WHERE id/, [{ id: 5, slug: 'whiteboard', self_hosted: false }]],
    [/SET\s+status = 'merged'/, { rows: [], rowCount: 1 }],
  ]);
}

test('a failing proposal is blocked: checksBlocked, never claims merging', async () => {
  const { subject, systemMessages, restore } = loadVotes();
  const p = poolWith('failing', [{ status: 'fail' }, { status: 'pass' }]);
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.checksBlocked, true);
    assert.equal(r.checkState, 'failing');
    assert.equal(r.failingCount, 1);
    assert.ok(!p.queries.some((q) => /SET status = 'merging'/.test(q.sql)), 'never claimed the merge');
    assert.ok(systemMessages.some((m) => /merge is blocked/i.test(m)), 'posted a block notice');
  } finally {
    restore();
  }
});

test('a pending proposal is blocked too (not yet passing)', async () => {
  const { subject, restore } = loadVotes();
  const p = poolWith('pending', []);
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.checksBlocked, true);
    assert.equal(r.checkState, 'pending');
  } finally {
    restore();
  }
});

test('a NULL check_state (never checked) is blocked', async () => {
  const { subject, restore } = loadVotes();
  const p = poolWith(null, []);
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.checksBlocked, true);
    assert.equal(r.checkState, 'pending');
  } finally {
    restore();
  }
});

test('a passing proposal clears the gate and proceeds to claim the merge', async () => {
  const { subject, restore } = loadVotes();
  const p = poolWith('passing', [{ status: 'pass' }]);
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, true, 'passing proposal merges');
    assert.ok(p.queries.some((q) => /SET status = 'merging'/.test(q.sql)), 'claimed the merge');
  } finally {
    restore();
  }
});

test('admin force-merge bypasses the checks gate', async () => {
  const { subject, restore } = loadVotes();
  // Even with a failing check_state, force=true must merge — and must NOT
  // run the gate query at all.
  const p = poolWith('failing', [{ status: 'fail' }]);
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session }, { force: true });
    assert.equal(r.merged, true);
    assert.ok(!p.queries.some((q) => /SELECT check_state, test_results[\s\S]*FROM chat_sessions/.test(q.sql)),
      'gate query skipped under force');
  } finally {
    restore();
  }
});

// #237: an 'error' verdict (staging preview crashed on boot) blocks the merge
// AND surfaces the captured crash reason in the block message, so the proposal
// owner can act instead of facing an unexplained "couldn't run" dead-end.
test('an errored proposal surfaces its captured boot-failure reason in the block message', async () => {
  const { subject, systemMessages, restore } = loadVotes();
  const detail = '[exited (exit=1)] error: no unique or exclusion constraint matching the ON CONFLICT specification';
  const p = makeRecordingPool([
    [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
    [/SELECT check_state, test_results[\s\S]*FROM chat_sessions/,
      [{ check_state: 'error', test_results: [], checks_checked_at: new Date().toISOString(), check_error_detail: detail }]],
    [/SET status = 'merging'/, [{ id: 7 }]],
  ]);
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.checksBlocked, true);
    assert.equal(r.checkState, 'error');
    assert.ok(!p.queries.some((q) => /SET status = 'merging'/.test(q.sql)), 'never claimed the merge');
    assert.ok(systemMessages.some((m) => /preview failed to start/i.test(m) && m.includes('ON CONFLICT')),
      'block message includes the captured boot-failure reason');
  } finally {
    restore();
  }
});
