// checkAndMerge-level tests for the two merge gates (eased Yes threshold +
// minimum visibility window). Stubs every collaborator so nothing real
// (GitHub, docker, staging) spins up. Uses the REAL active-users helpers
// (requiredVotes / mergeWindowMs / mergeGate) with only getActiveUserStats
// overridden to pin the active-user count.
//
// Run with: node --test tests/checkandmerge-window.test.js

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

// Pool that matches SQL by regex. Each handler returns rows (or a function of
// params). The window tests need distinct yes/no vote counts and to observe
// whether the promoted→merging claim ran.
function makePool(opts) {
  const claims = [];
  const updates = [];
  const pool = {
    async query(sql, params) {
      if (/vote = 'yes'/.test(sql)) return { rows: [{ cnt: String(opts.yes) }] };
      if (/vote = 'no'/.test(sql)) return { rows: [{ cnt: String(opts.no) }] };
      if (/SET status = 'merging'/.test(sql)) {
        claims.push(params);
        return { rows: [{ id: opts.sessionId }] };
      }
      if (/SELECT \* FROM apps WHERE id/.test(sql)) {
        // self_hosted app → checkAndMerge skips rebuildProduction.
        return { rows: [{ id: opts.appId, self_hosted: true, slug: 'widget' }] };
      }
      // #47 checks gate: this suite exercises the vote/window gates, so the
      // proposal's checks are always green here.
      if (/SELECT check_state, test_results, checks_checked_at/.test(sql)) {
        return { rows: [{ check_state: 'passing', test_results: [], checks_checked_at: new Date().toISOString() }] };
      }
      if (/UPDATE chat_sessions SET status = 'merged'/.test(sql)) {
        updates.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { pool, claims, updates };
}

function loadVotes() {
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
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  let activeCount = 20;
  const setActive = (n) => { activeCount = n; };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => ({}) });
  stub(ids.github, { isEnabled: () => false, mergePR: async () => ({}) });
  stub(ids.staging, { teardownStaging: async () => {}, rebuildProduction: async () => ({}) });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async () => ({ ok: true }),
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async () => {},
    pushNotificationToUser() {},
    pushVoteUpdate() {},
    pushSessionUpdate() {},
    pushIssueUpdate() {},
    broadcastGlobalScoped() {},
  });
  stub(ids.activeUsers, {
    ...realActiveUsers,
    getActiveUserStats: async () => ({ active: activeCount, majority: Math.floor(activeCount / 2) + 1 }),
    isUserActive: async () => true,
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record() {}, EVENT_TYPES: { PR_MERGED: 'pr_merged', BOUNTY_AWARDED: 'bounty_awarded' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.worker, { destroyCcVolume: async () => {}, isInFlight: () => false });
  stub(ids.mergeDebug, {
    startRun: async () => 1, step() {}, endRun() {}, pruneOldRuns: async () => {},
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, setActive, restore };
}

const DAY = 24 * 60 * 60 * 1000;
const baseSession = {
  id: 7, app_id: 5, app_slug: 'widget', app_self_hosted: true,
  repo_url: '', pr_number: 12, pr_title: 'Tweak', user_id: 3,
  behind_main: 0, linked_issues: [],
};

test('threshold met but inside the visibility window → deferred (waitingForWindow), no claim', async () => {
  const { subject, setActive, restore } = loadVotes();
  setActive(20); // majority 11
  try {
    // yes=6 (>= required 6), no=0, just promoted → window ~3.4d not elapsed.
    const { pool, claims } = makePool({ yes: 6, no: 0, sessionId: 7, appId: 5 });
    const session = { ...baseSession, promoted_at: new Date().toISOString() };
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
    assert.equal(r.merged, false);
    assert.equal(r.waitingForWindow, true);
    assert.equal(r.needed, 6, 'eased threshold surfaced');
    assert.ok(r.windowEndsAt, 'window-end timestamp surfaced for the countdown pill');
    assert.equal(claims.length, 0, 'never claimed the merge while inside the window');
  } finally {
    restore();
  }
});

test('threshold met and window elapsed → merges', async () => {
  const { subject, setActive, restore } = loadVotes();
  setActive(20);
  try {
    const { pool, claims, updates } = makePool({ yes: 6, no: 0, sessionId: 7, appId: 5 });
    // Promoted 8 days ago → window (~3.4d) long elapsed.
    const session = { ...baseSession, promoted_at: new Date(Date.now() - 8 * DAY).toISOString() };
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
    assert.equal(r.merged, true);
    assert.equal(claims.length, 1, 'claimed the merge once the window elapsed');
    assert.equal(updates[0][2], 6, 'snapshotted the eased threshold (required=6), not the majority');
  } finally {
    restore();
  }
});

test('below threshold, unopposed lead, clock running → deferred (lazy consensus)', async () => {
  const { subject, setActive, restore } = loadVotes();
  setActive(20);
  try {
    // yes=5 (< required 6), no=0, just promoted → lazy clock armed (missing
    // 1 vote → 3d), not elapsed → deferred exactly like a threshold-met row
    // inside its visibility window.
    const { pool, claims } = makePool({ yes: 5, no: 0, sessionId: 7, appId: 5 });
    const session = { ...baseSession, promoted_at: new Date().toISOString() };
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
    assert.equal(r.merged, false);
    assert.equal(r.needed, 6);
    assert.equal(r.waitingForWindow, true, 'lazy clock surfaces as waitingForWindow');
    assert.ok(r.windowEndsAt, 'lazy window end surfaced for the countdown pill');
    assert.equal(claims.length, 0, 'never claimed while the lazy clock runs');
  } finally {
    restore();
  }
});

test('below threshold, unopposed lead, clock elapsed → merges (silence is consent)', async () => {
  const { subject, setActive, restore } = loadVotes();
  setActive(20);
  try {
    const { pool, claims, updates } = makePool({ yes: 5, no: 0, sessionId: 7, appId: 5 });
    const session = { ...baseSession, promoted_at: new Date(Date.now() - 30 * DAY).toISOString() };
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
    assert.equal(r.merged, true, 'lazy-consensus window elapsed with no objection');
    assert.equal(claims.length, 1);
    assert.equal(updates[0][2], 6, 'still snapshots the eased threshold');
  } finally {
    restore();
  }
});

test('below threshold with no Yes lead → blocked on count, no clock', async () => {
  const { subject, setActive, restore } = loadVotes();
  setActive(20);
  try {
    // Tie (2/2): the lazy clock never arms, so even an ancient proposal
    // stays blocked on the count.
    const { pool, claims } = makePool({ yes: 2, no: 2, sessionId: 7, appId: 5 });
    const session = { ...baseSession, promoted_at: new Date(Date.now() - 30 * DAY).toISOString() };
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
    assert.equal(r.merged, false);
    assert.notEqual(r.waitingForWindow, true);
    assert.equal(r.windowEndsAt, null, 'no clock of any kind serialized');
    assert.equal(claims.length, 0);
  } finally {
    restore();
  }
});

test('majority of Yes merges immediately regardless of window', async () => {
  const { subject, setActive, restore } = loadVotes();
  setActive(20); // majority 11
  try {
    const { pool, claims } = makePool({ yes: 11, no: 0, sessionId: 7, appId: 5 });
    const session = { ...baseSession, promoted_at: new Date().toISOString() }; // just promoted
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
    assert.equal(r.merged, true, 'a clear majority skips the window entirely');
    assert.equal(claims.length, 1);
  } finally {
    restore();
  }
});

test('contested proposal: full majority merges immediately, sub-majority is blocked', async () => {
  const { subject, setActive, restore } = loadVotes();
  setActive(20); // majority 11
  try {
    // Contested (no=7 → 0.35 >= 1/3). required rises to majority (11).
    const blocked = makePool({ yes: 6, no: 7, sessionId: 7, appId: 5 });
    const justNow = { ...baseSession, promoted_at: new Date().toISOString() };
    let r = await subject.checkAndMerge({ jwtSecret: 's' }, blocked.pool, justNow, {});
    assert.equal(r.merged, false, 'contested + sub-majority does not merge');
    assert.equal(r.needed, 11, 'contested restores the full majority threshold');
    assert.equal(blocked.claims.length, 0);

    const passes = makePool({ yes: 11, no: 7, sessionId: 7, appId: 5 });
    r = await subject.checkAndMerge({ jwtSecret: 's' }, passes.pool, justNow, {});
    assert.equal(r.merged, true, 'contested + full majority merges immediately, no window');
    assert.equal(passes.claims.length, 1);
  } finally {
    restore();
  }
});
