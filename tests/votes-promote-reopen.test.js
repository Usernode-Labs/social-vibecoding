// Putting a change up for a vote must reconcile its pull request's GitHub
// state first. A withdrawn (archived) session carries a CLOSED PR; promoting
// it without a reopen creates a proposal that can never merge (session 2398 /
// PR #26).
//
// Since the proposal machine (src/workflow/proposal/), the work is split in
// three, and each part is pinned here where it now lives:
//   1. POST /api/sessions/:id/promote (src/routes/votes.js) reads the
//      session (owned, not headless, Underway), refuses a hand-off whose
//      status moved since its preflight, READS the pull request from GitHub
//      (a failed read fails closed, 503), and hands what it read to
//      platform.promoteProposal, answering with its reply.
//   2. The machine's `review.open` work (src/workflow/proposal/services.ts)
//      does everything GitHub is asked to do once the proposal is claimed
//      for review: a closed native PR is reopened (refused: 409), a merged
//      one refused, a closed or draft imported one refused without touching
//      it, the head read and checked against the hand-off's preflight, and a
//      native draft marked ready for review (refused: the change stays
//      Underway).
//   3. The machine's move into review (machine.ts `opened`) stamps the head,
//      the electorate the vote opened with, and hands the head to the
//      preview machine. Its database effects (votes on other heads removed,
//      promoted_at, the line, the CAS against a concurrent pause or close)
//      are pinned against PostgreSQL by tests/workflow-proposal-postgres.test.js
//      (P2, P3, P5, P6).
//
// Run with: node --test tests/votes-promote-reopen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { mergeGate } = require('../src/services/active-users');
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

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

// One promotable session: active, owned by user 3, PR + title + staging
// already in place.
const sessionRow = {
  id: 7, app_id: 5, app_slug: 'widget', app_name: 'Widget',
  repo_url: 'https://github.com/acme/widget', branch_name: 'dev/x-1',
  pr_number: 26, pr_title: 'Native iOS look', pr_url: 'https://github.com/acme/widget/pull/26',
  staging_url: 'https://stage.example', user_id: 3, status: 'active',
  checks_commit_sha: HEAD,
};

// ── 1. The route ─────────────────────────────────────────────────────────

function promotePool(session = sessionRow) {
  return makeRecordingPool([
    [/cs\.status IN \('active', 'paused'\)/, (params) =>
      ['active', 'paused'].includes(session.status) && session.user_id === params[1]
        && !session.is_headless ? [{ ...session }] : []],
  ]);
}

function loadVotesRouter({ getPRImpl, pool, reply }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    topicAttrs: require.resolve('../src/services/topic-attributes'),
    platform: require.resolve('../src/workflow/platform.ts'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const getPRCalls = [];
  const githubWrites = [];
  const promoteCalls = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async (owner, repo, pr) => {
      getPRCalls.push({ owner, repo, pr });
      if (!getPRImpl) return { state: 'open', merged: false, draft: true, node_id: 'PR_26', head: { sha: HEAD } };
      return getPRImpl(owner, repo, pr);
    },
    // The route only reads: anything GitHub is asked to do is review.open's.
    reopenPR: async (...a) => { githubWrites.push(['reopen', ...a]); },
    markPrReadyForReview: async (...a) => { githubWrites.push(['ready', ...a]); },
  });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.ws, { sendSystemMessage: async () => {}, pushNotificationToUser() {}, pushVoteUpdate() {}, pushSessionUpdate() {} });
  stub(ids.activeUsers, { getActiveUserStats: async () => ({ active: 1, majority: 1 }), isUserActive: async () => true, mergeGate });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.topicAttrs, {});
  stub(ids.platform, {
    async promoteProposal(p) {
      promoteCalls.push(p);
      return reply || { status: 200, body: { ok: true, prNumber: 26, prUrl: sessionRow.pr_url, prTitle: sessionRow.pr_title } };
    },
  });

  delete require.cache[ids.subject];
  const { voteRoutes } = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { voteRoutes, getPRCalls, githubWrites, promoteCalls, restore };
}

async function withServer({ getPRImpl, session, reply, handoff = null } = {}, fn) {
  const pool = promotePool(session);
  const ctx = loadVotesRouter({ getPRImpl, pool, reply });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 3, username: 'evan' };
    if (handoff?.head) req.cliHandoffCheckedHead = handoff.head;
    if (handoff?.status) req.cliHandoffStatus = handoff.status;
    if (handoff?.operation) req.cliHandoffOperation = handoff.operation;
    next();
  });
  app.use(ctx.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ ...ctx, pool, base });
  } finally {
    server.close();
    ctx.restore();
  }
}

const promote = (ctx) => fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });

test('the route hands the proposal machine the status it read, the cap, and the pull request as GitHub shows it', async () => {
  await withServer({ session: { ...sessionRow, status: 'paused' } }, async (ctx) => {
    const response = await promote(ctx);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, prNumber: 26, prUrl: sessionRow.pr_url, prTitle: sessionRow.pr_title });
    assert.equal(ctx.getPRCalls.length, 1);
    assert.deepEqual(ctx.getPRCalls[0], { owner: 'acme', repo: 'widget', pr: 26 });
    assert.deepEqual(ctx.promoteCalls, [{
      sessionId: 7, appId: 5, userId: 3, username: 'evan',
      from: 'paused', cap: 3,
      // `base`: where it would merge (src/workflow/rules/pr-base.ts); this
      // GitHub answer names none, which the machine reads as main.
      pr: { state: 'open', draft: true, merged: false, head: HEAD, base: null },
      expectedHead: null, viaAgent: false, ownOperation: null,
    }]);
    assert.deepEqual(ctx.githubWrites, [], 'the route reads GitHub; it changes nothing there');
    assert.equal(ctx.pool.issued(/UPDATE chat_sessions/), false, 'the status move is the machine\'s');
  });
});

test('a merged or closed pull request is passed as read, for the machine to refuse', async () => {
  await withServer({ getPRImpl: async () => ({ state: 'closed', merged: true, draft: false, head: { sha: 'not-a-sha' } }) }, async (ctx) => {
    await promote(ctx);
    assert.deepEqual(ctx.promoteCalls[0].pr, { state: 'closed', draft: false, merged: true, head: null, base: null },
      'a head that is not a commit sha is passed as none');
  });
});

test('a session without a pull request is promoted with none (review.open opens it)', async () => {
  await withServer({ session: { ...sessionRow, pr_number: null, pr_title: null, pr_url: null } }, async (ctx) => {
    assert.equal((await promote(ctx)).status, 200);
    assert.equal(ctx.getPRCalls.length, 0);
    assert.equal(ctx.promoteCalls[0].pr, null);
  });
});

test('paused promotion preserves ownership, headless, and terminal status exclusions', async () => {
  for (const patch of [{ user_id: 99 }, { is_headless: true }, { status: 'archived' },
    { status: 'promoted' }, { status: 'merging' }, { status: 'merged' }]) {
    await withServer({ session: { ...sessionRow, status: 'paused', ...patch } }, async (ctx) => {
      const response = await promote(ctx);
      assert.equal(response.status, 404);
      assert.equal(ctx.getPRCalls.length, 0);
      assert.equal(ctx.promoteCalls.length, 0);
      // The promote route's own lookup, found by what it selects rather than
      // by position: the community membership gate (services/communities.js)
      // runs its read ahead of it on the same pool.
      const lookup = ctx.pool.queries.find((q) => /SELECT cs\.\*/.test(q.sql)).sql;
      assert.match(lookup, /cs.user_id = \$2/);
      assert.match(lookup, /cs.is_headless = FALSE/);
    });
  }
});

test('a lifecycle change after native preflight requires a fresh submission', async () => {
  await withServer({ session: { ...sessionRow, source: 'cli_handoff', status: 'paused' },
    handoff: { head: HEAD, status: 'active' } }, async (ctx) => {
    const response = await promote(ctx);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'session_state_changed');
    assert.equal(ctx.getPRCalls.length, 0);
    assert.equal(ctx.promoteCalls.length, 0);
  });
});

test('a CLI hand-off names the head its preflight checked and its own operation', async () => {
  await withServer({ session: { ...sessionRow, source: 'cli_handoff', status: 'paused' },
    handoff: { head: HEAD, status: 'paused', operation: 'op-17' } }, async (ctx) => {
    assert.equal((await promote(ctx)).status, 200);
    assert.equal(ctx.promoteCalls[0].expectedHead, HEAD, 'review.open refuses a head that moved since');
    assert.equal(ctx.promoteCalls[0].ownOperation, 'op-17', 'the hand-off does not count as somebody working on it');
    assert.equal(ctx.promoteCalls[0].from, 'paused');
  });
});

test('the route answers with what the machine answered', async () => {
  const replies = [
    { status: 409, body: { error: 'session_state_changed' } },
    { status: 409, body: { error: 'branch_head_changed', message: 'The proposal branch changed after checks.' } },
    { status: 503, body: { error: 'GitHub could not mark the draft pull request ready for review.' } },
    { status: 202, body: { ok: true, pending: true, message: 'Being put up for a vote.' } },
  ];
  for (const reply of replies) {
    await withServer({ reply }, async (ctx) => {
      const r = await promote(ctx);
      assert.equal(r.status, reply.status);
      assert.deepEqual(await r.json(), reply.body);
    });
  }
});

test('promote: a transient PR-state GET failure fails closed before voting', async () => {
  await withServer({ getPRImpl: async () => { throw new Error('api hiccup'); } }, async (ctx) => {
    const r = await promote(ctx);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /could not verify/i);
    assert.equal(ctx.promoteCalls.length, 0, 'an unverified revision never enters voting');
  });
});

// ── 2. review.open ───────────────────────────────────────────────────────

const servicesPath = require.resolve('../src/workflow/proposal/services.ts');
const { proposalServices } = require(servicesPath);
const { WORK } = require('../src/workflow/proposal/machine.ts');

// Runs the machine's review.open for `row` with GitHub and the legacy
// modules it reaches (through src/workflow/legacy.ts, the shared require
// cache) stubbed.
async function reviewOpen(row, { getPRImpl, reopenImpl, markReadyImpl, expectedHead = null } = {}) {
  const ids = {
    github: require.resolve('../src/services/github'),
    appAdmins: require.resolve('../src/services/app-admins'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const calls = { getPR: [], reopen: [], ready: [], explicit: [] };
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async (owner, repo, pr) => {
      calls.getPR.push({ owner, repo, pr });
      return { draft: true, node_id: 'PR_26', ...(getPRImpl ? await getPRImpl() : { state: 'open', merged: false, head: { sha: HEAD } }) };
    },
    reopenPR: async (owner, repo, pr) => {
      calls.reopen.push({ owner, repo, pr });
      return reopenImpl ? reopenImpl() : {};
    },
    markPrReadyForReview: async (owner, repo, pr, existing) => {
      calls.ready.push({ owner, repo, pr, existing });
      return markReadyImpl ? markReadyImpl() : { ...existing, draft: false };
    },
  });
  stub(ids.appAdmins, { refreshExplicitApproval: async (_pool, _row, next) => { calls.explicit.push(next.reviewed_head_sha); } });
  const pool = {
    async query(sql) {
      if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) return { rows: [{ ...row }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  try {
    const handler = proposalServices({ config: {}, pool })[WORK.open];
    let result = null;
    let error = null;
    try {
      result = await handler.run({ input: { sessionId: row.id, n: 1, userId: 3, expectedHead, imported: row.source === 'imported' } });
    } catch (err) {
      error = err;
    }
    return { result, error, calls };
  } finally {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  }
}

const reviewRow = { ...sessionRow, app_slug: 'widget', source: null };

test('review.open: an open PR captures its head, is marked ready for review, and is not reopened', async () => {
  const { result, error, calls } = await reviewOpen(reviewRow);
  assert.equal(error, null);
  assert.deepEqual(result, { head: HEAD, prNumber: 26, prUrl: sessionRow.pr_url, prTitle: sessionRow.pr_title, issueLinkSeeded: false });
  assert.equal(calls.reopen.length, 0);
  assert.equal(calls.ready.length, 1, 'a native draft is marked ready before the vote opens (bug 9)');
  assert.equal(calls.ready[0].pr, 26);
  assert.equal(calls.ready[0].existing.head.sha, HEAD, 'the PR it read is handed on, so no second read');
  assert.deepEqual(calls.explicit, [HEAD], 'the explicit-approval stamp reads the head about to be reviewed');
});

test('review.open: GitHub refusing to mark a draft ready fails the move, and it is retried', async () => {
  const { error } = await reviewOpen(reviewRow, { markReadyImpl: async () => { throw new Error('GraphQL unavailable'); } });
  assert.equal(error.code, 'ready_failed', 'platform answers ready_failed 503 and the change stays Underway');
  assert.match(error.message, /ready for review/);
  assert.notEqual(error.permanent, true, 'a GitHub hiccup is retried before the promote is refused');
});

test('review.open: a CLI hand-off refuses a PR head that moved after its ready preflight', async () => {
  const moved = 'c'.repeat(40);
  const { error, calls } = await reviewOpen({ ...reviewRow, source: 'cli_handoff' }, {
    expectedHead: HEAD, getPRImpl: async () => ({ state: 'open', merged: false, head: { sha: moved } }),
  });
  assert.equal(error.code, 'branch_head_changed');
  assert.equal(error.permanent, true);
  assert.equal(calls.ready.length, 0, 'the raced, unchecked PR revision is never readied for the vote');
});

test('review.open: a closed-unmerged native PR is reopened, then readied', async () => {
  const { result, error, calls } = await reviewOpen(reviewRow, { getPRImpl: async () => ({ state: 'closed', merged: false, head: { sha: HEAD } }) });
  assert.equal(error, null);
  assert.deepEqual(calls.reopen, [{ owner: 'acme', repo: 'widget', pr: 26 }]);
  assert.equal(calls.ready.length, 1);
  assert.equal(result.head, HEAD);
});

test('review.open: a closed PR whose reopen is refused is refused, with an actionable message', async () => {
  const { error } = await reviewOpen(reviewRow, {
    getPRImpl: async () => ({ state: 'closed', merged: false, head: { sha: HEAD } }),
    reopenImpl: async () => { throw new Error('head branch was deleted'); },
  });
  assert.equal(error.code, 'reopen_failed', 'platform answers reopen_failed 409');
  assert.equal(error.permanent, true);
  assert.match(error.message, /couldn't be reopened/i);
});

test('review.open: an already-merged PR is refused (nothing left to vote on), never reopened', async () => {
  const { error, calls } = await reviewOpen(reviewRow, { getPRImpl: async () => ({ state: 'closed', merged: true }) });
  assert.equal(error.code, 'pr_merged');
  assert.match(error.message, /already merged/i);
  assert.equal(calls.reopen.length, 0);
});

test('review.open: an active imported PR captures its head without publishing its draft', async () => {
  const imported = { ...reviewRow, source: 'imported', imported_pr_head_sha: OLD_HEAD };
  const { result, error, calls } = await reviewOpen(imported, { getPRImpl: async () => ({ state: 'open', merged: false, draft: false, head: { sha: HEAD } }) });
  assert.equal(error, null);
  assert.equal(result.head, HEAD, 'the live imported head is the reviewed revision');
  assert.equal(calls.reopen.length, 0);
  assert.equal(calls.ready.length, 0, 'local promotion must not change an externally owned PR on GitHub');
});

test('review.open: a closed or draft imported PR is refused without touching it', async () => {
  const imported = { ...reviewRow, source: 'imported', imported_pr_head_sha: OLD_HEAD };
  const closed = await reviewOpen(imported, { getPRImpl: async () => ({ state: 'closed', merged: false, head: { sha: HEAD } }) });
  assert.equal(closed.error.code, 'pr_closed');
  assert.match(closed.error.message, /closed on GitHub/i);
  assert.equal(closed.calls.reopen.length, 0, 'the platform does not reopen an external PR');
  const draft = await reviewOpen(imported, { getPRImpl: async () => ({ state: 'open', merged: false, draft: true, head: { sha: HEAD } }) });
  assert.equal(draft.error.code, 'pr_draft');
  assert.equal(draft.calls.ready.length, 0);
});

test('review.open: a failed PR read is retried as GitHub being unavailable; a PR gone is refused', async () => {
  const hiccup = await reviewOpen(reviewRow, { getPRImpl: async () => { throw new Error('api hiccup'); } });
  assert.equal(hiccup.error.code, 'github_unavailable');
  assert.notEqual(hiccup.error.permanent, true);
  assert.match(hiccup.error.message, /could not verify/i);
  const gone = await reviewOpen(reviewRow, { getPRImpl: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } });
  assert.equal(gone.error.code, 'pr_create_failed');
  assert.equal(gone.error.permanent, true);
  const bad = await reviewOpen(reviewRow, { getPRImpl: async () => ({ state: 'open', merged: false, head: { sha: 'nope' } }) });
  assert.equal(bad.error.code, 'bad_head');
});

// ── 3. The move into review ──────────────────────────────────────────────

const { proposal } = require('../src/workflow/proposal/machine.ts');
const DEPS = { idleMs: 0, exemptFixtures: false, reviewCheckMs: 0, staleNotifyMs: 0, staleGraceMs: 0 };

function opened({ imported = false, result, failed = null, electorate = 1 }) {
  const m = proposal(DEPS);
  const state = { name: 'proposing', data: {
    sessionId: 7, appId: 5, imported, slot: imported ? 'none' : 'released', reason: null, claim: null, n: 1,
    promoting: { n: 1, by: 3, byName: 'evan', prior: 'paused', expectedHead: null, viaAgent: false },
    answer: null, pr: { running: 'open:1', next: [] }, doomed: [],
  } };
  const payload = { kind: WORK.open, workKey: 'open:1', workId: 9, attempt: 1,
    ...(failed ? { error: failed } : { result }) };
  const event = { id: 11, type: failed ? 'WorkFailed' : 'WorkSucceeded', payload, source: { kind: 'service', workId: 9 } };
  const facts = { row: { id: 7, appId: 5, appSlug: 'widget', prNumber: 26, prTitle: 'Native iOS look', ownerName: 'evan',
    ownerSynthetic: false, linkedIssues: [] }, electorate, caps: null, gate: null };
  return m.entryFor('proposing', event.type).to(state, event, facts, { now: new Date(), key: 'session:7' });
}

test('in review: the head GitHub read and the active-member count the vote opened with are stamped', async () => {
  // #3234: the vote's threshold counts active members live, so it can move
  // while voting is open; the electorate it opened with is kept for the
  // "was N when voting opened" note.
  const out = opened({ result: { head: HEAD, prNumber: 26, prUrl: null, prTitle: 'Native iOS look' }, electorate: 7 });
  assert.equal(out.next.name, 'in_review');
  const w = out.writes.find((x) => x.type === 'promoted');
  assert.equal(w.head, HEAD);
  assert.equal(w.electorate, 7);
  assert.equal(w.imported, false);
});

test('in review: the reviewed head goes to the preview machine, a native one as a promote, an imported one as an import', async () => {
  // #3173 / #3043: a change submitted with its preview gone gets it back
  // and its checks re-run on the reviewed commit; the preview machine joins
  // a build or a verdict it already has for that head.
  // The app's merge queue hears it is in line too (it sweeps the line from
  // then on, so a conflict before any vote is looked at).
  const native = opened({ result: { head: HEAD } });
  assert.deepEqual(native.messages.map((m) => [m.to.machine, m.event.type, m.event.payload.head ?? m.event.payload.reason, m.event.payload.source]),
    [['preview', 'RevisionSubmitted', HEAD, 'promote'], ['merge-queue', 'MergeWanted', 'promoted', undefined]]);
  const imported = opened({ imported: true, result: { head: HEAD } });
  assert.deepEqual(imported.messages.map((m) => [m.to.machine, m.event.type, m.event.payload.head ?? m.event.payload.reason, m.event.payload.source]),
    [['preview', 'RevisionSubmitted', HEAD, 'imported'], ['merge-queue', 'MergeWanted', 'promoted', undefined]]);
});

test('a refused review.open sends the change back to Underway, with the answer the route gives', async () => {
  const out = opened({ failed: { code: 'reopen_failed', message: 'This proposal\'s pull request (#26) was closed on GitHub and couldn\'t be reopened.' } });
  assert.equal(out.next.name, 'underway');
  assert.equal(out.next.data.slot, 'released', 'a paused change gets back no slot it gave up');
  assert.deepEqual(out.next.data.answer, { n: 1, ok: false, code: 'reopen_failed',
    message: 'This proposal\'s pull request (#26) was closed on GitHub and couldn\'t be reopened.' });
  assert.equal((out.writes || []).some((w) => w.type === 'promoted' || w.type === 'line'), false, 'a doomed proposal is never promoted');
});

test('the pull request\'s base is passed as GitHub shows it, for the machine to refuse one no open change is built on', async () => {
  await withServer({ getPRImpl: async () => ({ state: 'open', merged: false, draft: false, head: { sha: HEAD }, base: { ref: 'claude/sec09-parent' } }) }, async (ctx) => {
    await promote(ctx);
    assert.equal(ctx.promoteCalls[0].pr.base, 'claude/sec09-parent');
  });
});
