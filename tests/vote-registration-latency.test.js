'use strict';

// #2782: "voting Yes on an open proposal sometimes takes ages to register".
//
// The vote route used to await a FRESH reconcile of the proposal's head before
// it wrote anything: a full `git fetch` of the app's repository, queued behind
// any other fetch of it (another voter's background merge check, the merge
// queue, the integration sweep), and a cold `git clone` after a pod restart.
// That read now runs after the response. This file pins the three things that
// make that safe, and the timing itself:
//
//   1. the answer does not wait on the mirror — the vote is recorded and
//      answered while the fetch has not even started to settle, and the fresh
//      read runs afterwards (`fresh: true`, before the merge check);
//   2. the vote is bound to the epoch the voter was shown INSIDE the write:
//      recordVote's insert carries the epoch predicate under the row lock, a
//      stale epoch is refused with the current one, and nothing is announced;
//   3. the background read that finds an authored push clears the approvals
//      and stops there — the vote just recorded is retired with every other
//      one on the old code, rather than counted.
//
// Run with: node --test tests/vote-registration-latency.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { mergeGate } = require('../src/services/active-users');

const HEAD = 'a'.repeat(40);
const PUSHED = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A native proposal on a GitHub-backed app, at epoch 2.
const nativeRow = () => ({
  id: 7, app_id: 5, app_slug: 'widget', app_name: 'Widget',
  repo_url: 'https://github.com/acme/widget', branch_name: 'usernode/feature',
  pr_number: 26, pr_title: 'Native iOS look', user_id: 9, status: 'promoted',
  source: 'native', reviewed_head_sha: HEAD, checks_commit_sha: HEAD, check_state: 'passing',
  approval_epoch: 2, stale_notified_at: null,
});

function makePool({ epoch = 2 } = {}) {
  const queries = [];
  const inserted = [];
  const state = { epoch };
  return {
    queries,
    inserted,
    state,
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/cs\.status IN \('promoted', 'merging'\)/.test(text)) {
        return { rows: [{ ...nativeRow(), approval_epoch: state.epoch }], rowCount: 1 };
      }
      if (/cs\.approval_epoch AS current_epoch/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO pr_votes/.test(text)) {
        // The statement's own predicate, in miniature: the row is written
        // only while the session is still at the epoch the voter was shown.
        const expected = params[5];
        if (expected != null && expected !== state.epoch) return { rows: [], rowCount: 0 };
        inserted.push(params);
        return { rows: [{ id: 1, reason: params[4] }], rowCount: 1 };
      }
      if (/SELECT reviewed_head_sha, approval_epoch FROM chat_sessions/.test(text)) {
        return { rows: [{ reviewed_head_sha: HEAD, approval_epoch: state.epoch }], rowCount: 1 };
      }
      if (/approval_epoch = approval_epoch \+ CASE/.test(text)) {
        if (params[2] !== true) state.epoch += 1;
        return { rows: [{ approval_epoch: state.epoch }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function loadVotes({ pool, mirror, move = 'authored' }) {
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
    topicAttrs: require.resolve('../src/services/topic-attributes'),
    visuals: require.resolve('../src/services/visuals'),
    prImportSync: require.resolve('../src/services/pr-import-sync'),
    governance: require.resolve('../src/services/governance'),
    conversation: require.resolve('../src/services/conversation-prompt'),
    mirror: require.resolve('../src/services/repo-mirror'),
    integration: require.resolve('../src/services/integration'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const systemMessages = [];
  const voteUpdates = [];
  const gateCalls = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async () => ({ state: 'open', merged: false, head: { sha: HEAD } }),
    getInstallationOctokit: async () => ({ request: async () => ({ data: {} }) }),
  });
  stub(ids.staging, { rebuildProduction: async () => ({ ok: true }), teardownStaging: async () => {} });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async () => ({ ok: true }),
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, appId, content, msgType, metadata) => {
      systemMessages.push({ appId, content, msgType, metadata });
      return { id: 100 + systemMessages.length, createdAt: new Date().toISOString() };
    },
    pushNotificationToUser() {},
    pushVoteUpdate(data) { voteUpdates.push(data); },
    pushSessionUpdate() {},
    broadcastGlobalScoped() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 3, majority: 2 }),
    isUserActive: async () => true,
    isContested: () => false,
    listActiveUserIds: async () => [],
    mergeGate,
  });
  stub(ids.notifications, {
    markReadForSession: async () => 0,
    createProposalVoteNotification: async () => [],
    hydrateAndPush: async () => {},
    serialize: (x) => x,
  });
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, {
    record: () => {},
    EVENT_TYPES: {
      PR_VOTE_CAST: 'pr_vote_cast', PR_VOTE_RECEIVED: 'pr_vote_received',
      PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged',
    },
  });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.topicAttrs, {});
  stub(ids.visuals, { setChecksPending: async () => true, notifyChecksPending() {} });
  stub(ids.prImportSync, {
    rerunChecksForNewHead: async () => {},
    reconcileImportedHead: async () => ({ reconciled: false, reason: 'fork_head' }),
  });
  stub(ids.governance, {
    getGovernance: async () => ({ approverPolicy: 'anyone' }),
    getApproverSet: async () => ({ ids: [] }),
    governedGate: async () => {
      gateCalls.push(Date.now());
      return {
        mergeable: false, thresholdMet: false, lazyArmed: false, windowElapsed: false,
        qualifiedYes: 0, qualifiedNo: 0, activeCount: 3, required: 2,
      };
    },
  });
  stub(ids.conversation, { promptIfContested: async () => ({ prompted: false }) });
  stub(ids.mirror, mirror);
  stub(ids.integration, {
    _parseRepo: () => ({ owner: 'acme', repo: 'widget' }),
    classifyHeadMove: async () => ({ kind: move }),
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, systemMessages, voteUpdates, gateCalls, restore };
}

// A mirror whose fetch settles only when the test says so, recording every
// call and whether it asked for a fresh read.
function controlledMirror(liveHead = HEAD) {
  const calls = [];
  const fetches = [];
  return {
    calls,
    fetches,
    ensureMirror(_owner, _repo, options = {}) {
      calls.push({ fresh: !!options.fresh });
      const d = deferred();
      fetches.push(d);
      return d.promise;
    },
    defaultBranchSha: async () => MAIN,
    resolveBranch: async () => liveHead,
  };
}

async function withServer({ pool, mirror, move }, fn) {
  const ctx = loadVotes({ pool, mirror, move });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 3, username: 'evan' }; next(); });
  app.use(ctx.subject.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/sessions/7/vote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await fn({ ...ctx, post });
  } finally {
    server.close();
    ctx.restore();
  }
}

async function until(predicate, ms = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for background work');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── 1. The answer does not wait on the mirror ─────────────────────────

test('a Yes is recorded and answered while the repository fetch is still outstanding', async () => {
  const pool = makePool();
  const mirror = controlledMirror();
  await withServer({ pool, mirror }, async (ctx) => {
    const r = await ctx.post({ vote: 'yes', expectedEpoch: 2 });
    assert.equal(r.status, 200, 'the vote is answered without the fetch having settled');
    assert.deepEqual(await r.json(), { ok: true, merged: false });
    assert.equal(pool.inserted.length, 1, 'and it is recorded');
    assert.equal(pool.inserted[0][5], 2, 'bound to the epoch the voter was shown');
    assert.equal(ctx.systemMessages.length, 1, 'the thread line is not held back either');
    assert.ok(ctx.voteUpdates.some((u) => u.sessionId === 7 && !u.headMoved),
      'the tally push goes out before any GitHub read has finished');

    // The read the response used to wait on happens now, fresh, and first.
    await until(() => mirror.calls.length >= 1);
    assert.equal(mirror.calls[0].fresh, true,
      'the post-vote read must not join a fetch that predates the vote');
    assert.equal(ctx.gateCalls.length, 0, 'the merge check waits for the fresh read');

    mirror.fetches[0].resolve('/tmp/mirror');
    // checkAndMerge's own non-fresh reconcile follows.
    await until(() => mirror.calls.length >= 2);
    assert.equal(mirror.calls[1].fresh, false);
    mirror.fetches[1].resolve('/tmp/mirror');
    await until(() => ctx.gateCalls.length >= 1);
    assert.equal(pool.state.epoch, 2, 'an unmoved head clears nothing');
  });
});

test('a mirror that never answers cannot hold a vote hostage', async () => {
  const pool = makePool();
  const mirror = controlledMirror();
  await withServer({ pool, mirror }, async (ctx) => {
    const started = Date.now();
    const r = await ctx.post({ vote: 'yes', expectedEpoch: 2 });
    assert.equal(r.status, 200);
    assert.ok(Date.now() - started < 1500, 'answered promptly with the fetch still pending');
    await until(() => mirror.calls.length >= 1);
    // Fail the fetch: the vote stands, and the merge check still runs on
    // the stored revision (the exact-sha merge is its guard).
    mirror.fetches[0].reject(new Error('network down'));
    await until(() => mirror.calls.length >= 2);
    mirror.fetches[1].reject(new Error('network down'));
    await until(() => ctx.gateCalls.length >= 1);
    assert.equal(pool.inserted.length, 1);
    assert.equal(pool.state.epoch, 2);
  });
});

// ── 2. The vote is bound to the epoch it was cast at ──────────────────

test('a vote cast at an epoch that has since moved is refused, with the current epoch, and nothing is announced', async () => {
  const pool = makePool({ epoch: 3 });
  const mirror = controlledMirror();
  await withServer({ pool, mirror }, async (ctx) => {
    const r = await ctx.post({ vote: 'yes', expectedEpoch: 2 });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.headChanged, true);
    assert.equal(body.approvalEpoch, 3, 'the next click can land without a refetch');
    assert.equal(pool.inserted.length, 0);
    assert.equal(ctx.systemMessages.length, 0);
    assert.equal(mirror.calls.length, 0, 'and no GitHub read was made to find that out');
  });
});

test('an epoch that moves between the read and the write lock refuses the vote rather than moving it', async () => {
  const pool = makePool();
  const mirror = controlledMirror();
  // The session read says epoch 2; a reconciliation lands before the insert.
  const realQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/INSERT INTO pr_votes/.test(String(sql))) pool.state.epoch = 3;
    return realQuery(sql, params);
  };
  await withServer({ pool, mirror }, async (ctx) => {
    const r = await ctx.post({ vote: 'yes', expectedEpoch: 2 });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.match(body.error, /changed while your vote was being recorded/);
    assert.equal(body.approvalEpoch, 3);
    assert.equal(pool.inserted.length, 0);
    assert.equal(ctx.systemMessages.length, 0);
    assert.equal(mirror.calls.length, 0);
  });
});

test('recordVote carries the epoch predicate inside the locked statement', async () => {
  const pool = makePool();
  const { subject, restore } = loadVotes({ pool, mirror: controlledMirror() });
  try {
    await subject.recordVote({
      pool, session: { id: 7 }, userId: 3, vote: 'yes', headSha: HEAD,
      revisionEnforced: true, expectedEpoch: '2',
    });
    const q = pool.queries.find((x) => /INSERT INTO pr_votes/.test(x.sql));
    assert.match(q.sql, /FOR UPDATE/);
    assert.match(q.sql, /WHERE \$6::integer IS NULL OR approval_epoch = \$6::integer/);
    assert.equal(q.params[5], 2);

    assert.equal(subject.parseExpectedEpoch(undefined), null, 'no stamp: voting on whatever is current');
    assert.equal(subject.parseExpectedEpoch(''), null);
    assert.equal(subject.parseExpectedEpoch('x'), null);
    assert.equal(subject.parseExpectedEpoch(0), 0, 'epoch 0 is an epoch');
  } finally {
    restore();
  }
});

test('the offline read answers from the row and never touches the mirror', async () => {
  const pool = makePool();
  const mirror = controlledMirror();
  const { subject, restore } = loadVotes({ pool, mirror });
  try {
    const out = await subject.reconcileNativeReviewedHead({
      config: {}, pool, session: nativeRow(), offline: true,
    });
    assert.deepEqual(out, { enforced: true, headSha: HEAD, epoch: 2, unchanged: true, deferred: true });
    assert.equal(mirror.calls.length, 0);
    // The rows it could never verify still answer exactly as before.
    const noRepo = await subject.reconcileNativeReviewedHead({
      config: {}, pool, session: { ...nativeRow(), repo_url: null }, offline: true,
    });
    assert.equal(noRepo.blocked, true);
  } finally {
    restore();
  }
});

// ── 3. The background read retires a vote on code that moved ──────────

test('an authored push found after the vote clears the approvals and skips the merge check', async () => {
  const pool = makePool();
  const mirror = controlledMirror(PUSHED);
  const { subject, systemMessages, voteUpdates, gateCalls, restore } = loadVotes({ pool, mirror, move: 'authored' });
  try {
    const session = nativeRow();
    const settled = subject.settleVoteInBackground({
      config: {}, pool, session, revision: { enforced: true, deferred: true, epoch: 2 },
    });
    await until(() => mirror.calls.length >= 1);
    mirror.fetches[0].resolve('/tmp/mirror');
    const out = await settled;
    assert.equal(out.merged, false);
    assert.equal(out.reviewReset, true);
    assert.equal(pool.state.epoch, 3, 'the epoch the vote was stamped with no longer counts');
    assert.equal(mirror.calls.length, 1, 'fresh read only; checkAndMerge never ran');
    assert.equal(mirror.calls[0].fresh, true);
    assert.equal(gateCalls.length, 0);
    assert.ok(voteUpdates.some((u) => u.headMoved), 'every client hears the head moved');
    assert.ok(systemMessages.some((m) => /votes were cleared/.test(m.content)),
      'and the thread asks for a re-review');
  } finally {
    restore();
  }
});

test('a mechanical sync found after the vote keeps it and goes on to the merge check', async () => {
  const pool = makePool();
  const mirror = controlledMirror(PUSHED);
  const { subject, gateCalls, restore } = loadVotes({ pool, mirror, move: 'mechanical' });
  try {
    const settled = subject.settleVoteInBackground({
      config: {}, pool, session: nativeRow(), revision: { enforced: true, deferred: true, epoch: 2 },
    });
    await until(() => mirror.calls.length >= 1);
    mirror.fetches[0].resolve('/tmp/mirror');
    await until(() => mirror.calls.length >= 2);
    mirror.fetches[1].resolve('/tmp/mirror');
    await settled;
    assert.equal(pool.state.epoch, 2, 'a sync that changed nothing keeps every vote');
    assert.equal(gateCalls.length, 1, 'and the majority is checked');
  } finally {
    restore();
  }
});
