// Tests for the auto-resolve of close_issue governance proposals whose
// target issue was closed by other means:
//   1. resolveSupersededCloseProposals (src/routes/issues.js) — the shared
//      resolver: race-safe flip, audit payload, cause wording, WS push,
//      and its no-GitHub/no-bounty guarantees.
//   2. The issue-close-watcher hook — observed closes (and gone/skipped
//      numbers) trigger the resolver when a pool is provided; without one
//      the watcher behaves exactly as before.
//   3. The merge-path hook — checkAndMerge resolves proposals for the
//      issues a merged PR closes, and a resolver failure never fails the
//      merge (mirrors the bounty-payout posture).
//
// Run with: node --test tests/close-issue-auto-withdraw.test.js

// Zero the watcher delays before it loads its tunables.
process.env.ISSUE_CLOSE_WATCH_GRACE_MS = '0';
process.env.ISSUE_CLOSE_WATCH_BACKOFF_MS = '0';
process.env.ISSUE_CLOSE_WATCH_ATTEMPTS = '3';

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports, orig) {
  require.cache[id] = {
    id, filename: id, loaded: true, exports, paths: orig ? orig.paths : [],
  };
}

function makePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
    issued(re) { return calls.find((c) => re.test(c.sql)); },
  };
}

// ── Part 1: the shared resolver ───────────────────────────────────────────

// Load routes/issues with ws + github stubbed; returns the resolver plus
// spies. github is fully spied so "never writes to GitHub" is assertable.
function loadResolver(pool) {
  const ids = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    subject: require.resolve('../src/routes/issues'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const spies = { systemMessages: [], issueUpdates: [], ghCalls: [] };
  stub(ids.pool, { getPool: () => pool }, orig.pool);
  const realWs = orig.ws ? orig.ws.exports : require('../src/services/ws');
  stub(ids.ws, {
    ...realWs,
    sendSystemMessage: async (...args) => { spies.systemMessages.push(args); },
    pushIssueUpdate: (data) => { spies.issueUpdates.push(data); },
    pushAppUpdate: () => {},
  }, orig.ws);
  stub(ids.github, new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'isEnabled') return () => false;
      if (prop === 'safeMention') return (s) => s;
      return (...args) => { spies.ghCalls.push({ type: String(prop), args }); };
    },
  }), orig.github);

  delete require.cache[ids.subject];
  const subject = require('../src/routes/issues');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.subject];
  };
  return { subject, spies, restore };
}

const ROW = (over) => ({
  id: 61, app_id: 9,
  payload: { issueNumber: 42, issueTitle: 'Dark mode resets', reason: 'dup' },
  ...over,
});

test('resolver: flips matching open proposals with a pr-merge audit trail and messages', async () => {
  const pool = makePool([
    [/kind = 'close_issue' AND status = 'open'/, [ROW()]],
    [/UPDATE issues SET status = 'closed', payload = \$2/, [{ id: 61 }]],
  ]);
  const { subject, spies, restore } = loadResolver(pool);
  try {
    const r = await subject.resolveSupersededCloseProposals(pool, {
      appId: 9, appSlug: 'cool-app', numbers: [42],
      cause: { kind: 'pr-merge', prNumber: 431 },
    });
    assert.deepEqual(r.resolved, [61]);

    const sel = pool.issued(/kind = 'close_issue' AND status = 'open'/);
    assert.deepEqual(sel.params, [9, [42]], 'scoped to app + numbers');

    const upd = pool.issued(/UPDATE issues SET status = 'closed', payload = \$2/);
    assert.match(upd.sql, /WHERE id = \$1 AND status = 'open'/, 'race-safe guarded flip');
    const audit = JSON.parse(upd.params[1]);
    assert.equal(audit.supersededBy, 'pr-merge:#431');
    assert.ok(audit.supersededAt);
    assert.equal(audit.issueNumber, 42, 'original payload preserved');

    // Group line + governance-thread dual-post, pr-merge wording names the PR.
    assert.equal(spies.systemMessages.length, 2);
    assert.match(spies.systemMessages[0][2], /Close proposal for issue #42 resolved automatically — PR #431 closed the issue/);
    assert.deepEqual(spies.systemMessages[1][5], { type: 'governance', ref: 61 });

    // Same event the withdraw path emits — clients drop the card.
    assert.equal(spies.issueUpdates.length, 1);
    assert.deepEqual(spies.issueUpdates[0], {
      action: 'closed', appSlug: 'cool-app', appId: 9, issueId: 61,
    });

    // Never writes to GitHub, never touches bounties.
    assert.equal(spies.ghCalls.length, 0);
    assert.ok(!pool.issued(/issue_bounties/));
  } finally { restore(); }
});

test('resolver: github-close cause wording has no PR number', async () => {
  const pool = makePool([
    [/kind = 'close_issue' AND status = 'open'/, [ROW()]],
    [/UPDATE issues SET status = 'closed', payload = \$2/, [{ id: 61 }]],
  ]);
  const { subject, spies, restore } = loadResolver(pool);
  try {
    await subject.resolveSupersededCloseProposals(pool, {
      appId: 9, appSlug: 'cool-app', numbers: [42], cause: { kind: 'github-close' },
    });
    assert.match(spies.systemMessages[0][2], /resolved automatically — the issue was closed on GitHub/);
    const audit = JSON.parse(pool.issued(/UPDATE issues SET status = 'closed'/).params[1]);
    assert.equal(audit.supersededBy, 'github-close');
  } finally { restore(); }
});

test('resolver: a lost race (row no longer open) produces no messages and no push', async () => {
  const pool = makePool([
    [/kind = 'close_issue' AND status = 'open'/, [ROW()]],
    [/UPDATE issues SET status = 'closed', payload = \$2/, []], // vote-apply won
  ]);
  const { subject, spies, restore } = loadResolver(pool);
  try {
    const r = await subject.resolveSupersededCloseProposals(pool, {
      appId: 9, numbers: [42], cause: { kind: 'github-close' },
    });
    assert.deepEqual(r.resolved, []);
    assert.equal(spies.systemMessages.length, 0);
    assert.equal(spies.issueUpdates.length, 0);
  } finally { restore(); }
});

test('resolver: no-ops on empty/invalid inputs and non-matching numbers', async () => {
  const pool = makePool([
    [/kind = 'close_issue' AND status = 'open'/, []],
  ]);
  const { subject, spies, restore } = loadResolver(pool);
  try {
    // Missing appId / empty or junk numbers → no queries at all.
    for (const args of [
      { numbers: [42] },
      { appId: 9, numbers: [] },
      { appId: 9, numbers: ['junk', -1, 0] },
    ]) {
      const r = await subject.resolveSupersededCloseProposals(pool, args);
      assert.deepEqual(r.resolved, []);
    }
    assert.equal(pool.calls.length, 0);

    // Valid input but nothing matches → select only, no flip, no noise.
    const r = await subject.resolveSupersededCloseProposals(pool, {
      appId: 9, numbers: [99], cause: { kind: 'github-close' },
    });
    assert.deepEqual(r.resolved, []);
    assert.ok(!pool.issued(/UPDATE issues/));
    assert.equal(spies.systemMessages.length, 0);
  } finally { restore(); }
});

test('resolver: a throwing pool is swallowed (best-effort contract)', async () => {
  const pool = { async query() { throw new Error('db down'); } };
  const { subject, restore } = loadResolver(pool);
  try {
    const r = await subject.resolveSupersededCloseProposals(pool, {
      appId: 9, numbers: [42], cause: { kind: 'github-close' },
    });
    assert.deepEqual(r.resolved, []);
  } finally { restore(); }
});

// ── Part 2: the issue-close-watcher hook ─────────────────────────────────

// Same stub shape as issue-close-watcher.test.js, plus a routes/issues stub
// whose resolveSupersededCloseProposals is a spy (the watcher lazy-requires
// it only when a pool is provided).
function loadWatcher({ gh = {}, resolverCalls, resolverImpl }) {
  const ids = {
    github: require.resolve('../src/services/github'),
    ws: require.resolve('../src/services/ws'),
    issues: require.resolve('../src/routes/issues'),
    prMeta: require.resolve('../src/services/pr-metadata'),
    subject: require.resolve('../src/services/issue-close-watcher'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  stub(ids.github, {
    isEnabled: () => true,
    getPR: async (...a) => (gh.getPR ? gh.getPR(...a) : { body: '' }),
    getIssue: async (...a) => (gh.getIssue ? gh.getIssue(...a) : { number: a[2], state: 'closed' }),
    noteIssuesClosed: () => {},
    unsuppressIssues: () => {},
    invalidateIssuesCache: () => {},
  }, orig.github);
  stub(ids.ws, { pushIssueUpdate: () => {} }, orig.ws);
  stub(ids.issues, {
    resolveSupersededCloseProposals: async (pool, args) => {
      resolverCalls.push({ pool, args });
      if (resolverImpl) return resolverImpl(pool, args);
      return { resolved: [] };
    },
  }, orig.issues);

  delete require.cache[ids.prMeta];
  delete require.cache[ids.subject];
  const subject = require('../src/services/issue-close-watcher');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.prMeta];
    delete require.cache[ids.subject];
  };
  return { subject, restore };
}

const WATCH_ARGS = {
  owner: 'usernode-bot', repo: 'some-app', prNumber: 42,
  appSlug: 'some-app', appId: 7,
};

// Watcher hook calls are fired-and-forgotten; let the microtask queue drain.
const settle = () => new Promise((r) => setImmediate(r));

test('watcher: observed closes trigger the resolver with the pool and pr-merge cause', async () => {
  const resolverCalls = [];
  const pool = { async query() { return { rows: [] }; } };
  const { subject, restore } = loadWatcher({
    resolverCalls,
    gh: { getPR: async () => ({ body: 'Closes #3, fixes #9' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...WATCH_ARGS, pool });
    await settle();
    assert.deepEqual(res.closed, [3, 9]);
    assert.equal(resolverCalls.length, 1);
    assert.equal(resolverCalls[0].pool, pool, 'the provided pool is forwarded');
    assert.equal(resolverCalls[0].args.appId, 7);
    assert.equal(resolverCalls[0].args.appSlug, 'some-app');
    assert.deepEqual(resolverCalls[0].args.numbers.sort(), [3, 9]);
    assert.deepEqual(resolverCalls[0].args.cause, { kind: 'pr-merge', prNumber: 42 });
  } finally { restore(); }
});

test('watcher: gone (404-skipped) numbers are resolved too', async () => {
  const resolverCalls = [];
  const pool = { async query() { return { rows: [] }; } };
  const { subject, restore } = loadWatcher({
    resolverCalls,
    gh: {
      getPR: async () => ({ body: 'Closes #6' }),
      getIssue: async () => { const e = new Error('Not Found'); e.status = 404; throw e; },
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...WATCH_ARGS, pool });
    await settle();
    assert.deepEqual(res.skipped, [6]);
    assert.equal(resolverCalls.length, 1);
    assert.deepEqual(resolverCalls[0].args.numbers, [6]);
  } finally { restore(); }
});

test('watcher: without a pool the resolver is never required/called and nothing throws', async () => {
  const resolverCalls = [];
  const { subject, restore } = loadWatcher({
    resolverCalls,
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...WATCH_ARGS });
    await settle();
    assert.deepEqual(res.closed, [3]);
    assert.equal(resolverCalls.length, 0);
  } finally { restore(); }
});

test('watcher: a rejecting resolver never breaks the poll loop', async () => {
  const resolverCalls = [];
  const pool = { async query() { return { rows: [] }; } };
  const { subject, restore } = loadWatcher({
    resolverCalls,
    resolverImpl: async () => { throw new Error('resolver boom'); },
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...WATCH_ARGS, pool });
    await settle();
    assert.deepEqual(res.closed, [3], 'watch completed normally');
    assert.equal(resolverCalls.length, 1);
  } finally { restore(); }
});

// ── Part 3: the merge-path hook (checkAndMerge) ──────────────────────────

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({}) };
  return _origLoad.call(this, request, ...rest);
};

function loadVotes({ resolverCalls, resolverImpl }) {
  const realActiveUsers = require('../src/services/active-users');
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
    mergeDebug: require.resolve('../src/services/merge-debug'),
    prMeta: require.resolve('../src/services/pr-metadata'),
    issues: require.resolve('../src/routes/issues'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} }, orig.logger);
  stub(ids.pool, { getPool: () => ({}) }, orig.pool);
  stub(ids.github, {
    isEnabled: () => false,
    mergePR: async () => ({}),
    noteIssuesClosed: () => {},
    invalidateIssuesCache: () => {},
  }, orig.github);
  stub(ids.staging, { teardownStaging: async () => {}, rebuildProduction: async () => ({}) }, orig.staging);
  stub(ids.docker, {}, orig.docker);
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async () => ({ ok: true }),
    isResolving: () => false,
  }, orig.resolver);
  stub(ids.ws, {
    sendSystemMessage: async () => {},
    pushNotificationToUser() {},
    pushVoteUpdate() {},
    pushSessionUpdate() {},
    pushIssueUpdate() {},
    broadcastGlobalScoped() {},
  }, orig.ws);
  stub(ids.activeUsers, {
    ...realActiveUsers,
    getActiveUserStats: async () => ({ active: 2, majority: 2 }),
    isUserActive: async () => true,
  }, orig.activeUsers);
  stub(ids.notifications, {}, orig.notifications);
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true }, orig.adminApproval);
  stub(ids.events, { record() {}, EVENT_TYPES: { PR_MERGED: 'pr_merged', BOUNTY_AWARDED: 'bounty_awarded' } }, orig.events);
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() }, orig.appAccess);
  stub(ids.worker, { destroyCcVolume: async () => {}, isInFlight: () => false }, orig.worker);
  stub(ids.mergeDebug, {
    startRun: async () => 1, step() {}, endRun() {}, pruneOldRuns: async () => {},
  }, orig.mergeDebug);
  // The merge hook lazy-requires routes/issues — hand it a spy.
  stub(ids.issues, {
    resolveSupersededCloseProposals: async (pool, args) => {
      resolverCalls.push({ pool, args });
      if (resolverImpl) return resolverImpl(pool, args);
      return { resolved: [] };
    },
  }, orig.issues);

  delete require.cache[ids.prMeta];
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.prMeta];
    delete require.cache[ids.subject];
  };
  return { subject, restore };
}

function mergePool({ yes, no }) {
  return {
    async query(sql) {
      if (/vote = 'yes'/.test(sql)) return { rows: [{ cnt: String(yes) }] };
      if (/vote = 'no'/.test(sql)) return { rows: [{ cnt: String(no) }] };
      if (/SET status = 'merging'/.test(sql)) return { rows: [{ id: 7 }] };
      if (/SELECT \* FROM apps WHERE id/.test(sql)) {
        return { rows: [{ id: 5, self_hosted: true, slug: 'widget' }] };
      }
      if (/SELECT check_state, test_results, checks_checked_at/.test(sql)) {
        return { rows: [{ check_state: 'passing', test_results: [], checks_checked_at: new Date().toISOString() }] };
      }
      return { rows: [] };
    },
  };
}

const MERGE_SESSION = {
  id: 7, app_id: 5, app_slug: 'widget', app_self_hosted: true,
  repo_url: 'https://github.com/acme/widget', pr_number: 12, pr_title: 'Fix', user_id: 3,
  behind_main: 0, linked_issues: [42, 43],
  promoted_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
};

test('merge hook: checkAndMerge resolves close proposals for the linked issues it closes', async () => {
  const resolverCalls = [];
  const { subject, restore } = loadVotes({ resolverCalls });
  try {
    const pool = mergePool({ yes: 2, no: 0 });
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, { ...MERGE_SESSION }, {});
    await new Promise((res) => setImmediate(res));
    assert.equal(r.merged, true);
    assert.equal(resolverCalls.length, 1);
    assert.equal(resolverCalls[0].pool, pool, 'merge pool forwarded');
    assert.equal(resolverCalls[0].args.appId, 5);
    assert.equal(resolverCalls[0].args.appSlug, 'widget');
    assert.deepEqual(resolverCalls[0].args.numbers, [42, 43]);
    assert.deepEqual(resolverCalls[0].args.cause, { kind: 'pr-merge', prNumber: 12 });
  } finally { restore(); }
});

test('merge hook: a rejecting resolver never fails the merge', async () => {
  const resolverCalls = [];
  const { subject, restore } = loadVotes({
    resolverCalls,
    resolverImpl: async () => { throw new Error('resolver boom'); },
  });
  try {
    const pool = mergePool({ yes: 2, no: 0 });
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, { ...MERGE_SESSION }, {});
    await new Promise((res) => setImmediate(res));
    assert.equal(r.merged, true, 'merge unaffected by the failing hook');
    assert.equal(resolverCalls.length, 1);
  } finally { restore(); }
});

test('merge hook: no linked issues → resolver never invoked', async () => {
  const resolverCalls = [];
  const { subject, restore } = loadVotes({ resolverCalls });
  try {
    const pool = mergePool({ yes: 2, no: 0 });
    const r = await subject.checkAndMerge(
      { jwtSecret: 's' }, pool, { ...MERGE_SESSION, linked_issues: [] }, {}
    );
    await new Promise((res) => setImmediate(res));
    assert.equal(r.merged, true);
    assert.equal(resolverCalls.length, 0);
  } finally { restore(); }
});
