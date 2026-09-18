'use strict';

// #1688: the line behind a vote (src/routes/votes.js).
//
//   1. normalizeVoteReason: whitespace collapsed, an empty line is "no
//      line", a paragraph is refused, and so is anything not a string;
//   2. recordVote writes the line, and its upsert keeps an earlier line on
//      a same-side re-cast and drops it on a flip;
//   3. the route: a No without its line is refused before anything is
//      written; a No with one is recorded and the thread quotes it; a Yes
//      needs none and its line reads exactly as before; the same side with
//      new words updates the row without a second announcement; a re-cast
//      No that already has its line passes the gate;
//   4. the roster names each counted vote's line, and the people whose vote
//      was on an earlier version of the proposal;
//   5. the merge credits: who is named when a proposal lands, and how the
//      sentence reads.
//
// Run with: node --test tests/vote-reasons.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { mergeGate } = require('../src/services/active-users');

const HEAD = 'a'.repeat(40);

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

// An imported proposal up for a vote: the reviewed head is the import head,
// so the route reaches the vote itself without a GitHub round-trip.
const sessionRow = {
  id: 7, app_id: 5, app_slug: 'widget', app_name: 'Widget',
  repo_url: 'https://github.com/acme/widget', branch_name: null,
  pr_number: 26, pr_title: 'Native iOS look', user_id: 9, status: 'promoted',
  source: 'imported', imported_pr_head_sha: HEAD, approval_epoch: 2, stale_notified_at: null,
};

function votePool({ prev = [], roster = [] } = {}) {
  const inserted = [];
  const pool = makeRecordingPool([
    [/cs\.status IN \('promoted', 'merging'\)/, [{ ...sessionRow }]],
    [/cs\.approval_epoch AS current_epoch/, prev],
    // The upsert's CASE, in miniature: a line that arrives wins; none
    // arriving keeps the old one on the same side and drops it on a flip.
    [/INSERT INTO pr_votes/, (params) => {
      const p = prev[0] || null;
      const reason = params[4] != null ? params[4] : (p && p.vote === params[2] ? p.reason : null);
      inserted.push({ params, reason });
      return [{ id: 1, reason }];
    }],
    [/AS current\s+FROM pr_votes pv/, roster],
    [/SELECT app_id FROM chat_sessions WHERE id = \$1/, [{ app_id: 5 }]],
  ]);
  pool.inserted = inserted;
  return pool;
}

function loadVotes({ pool }) {
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
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const systemMessages = [];
  const voteUpdates = [];
  const voteNotifications = [];
  const prompts = [];

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
    sendSystemMessage: async (_pool, appId, content, msgType, metadata, thread) => {
      systemMessages.push({ appId, content, msgType, metadata, thread });
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
    createProposalVoteNotification: async (_pool, args) => { voteNotifications.push(args); return []; },
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
  // Below the bar on every count, so the background merge check that a
  // vote kicks off goes nowhere.
  stub(ids.governance, {
    getGovernance: async () => ({ approverPolicy: 'anyone' }),
    getApproverSet: async () => ({ ids: [] }),
    governedGate: async () => ({
      mergeable: false, thresholdMet: false, lazyArmed: false, windowElapsed: false,
      qualifiedYes: 0, qualifiedNo: 0, activeCount: 3, required: 2,
    }),
  });
  stub(ids.conversation, {
    promptIfContested: async (_pool, session) => {
      prompts.push(session.id);
      return { prompted: false, why: 'not_contested' };
    },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, systemMessages, voteUpdates, voteNotifications, prompts, restore };
}

async function withServer(poolOpts, fn) {
  const pool = votePool(poolOpts);
  const ctx = loadVotes({ pool });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 3, username: 'evan' };
    next();
  });
  app.use(ctx.subject.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/sessions/7/vote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await fn({ ...ctx, pool, base, post });
  } finally {
    server.close();
    ctx.restore();
  }
}

// ── 1. The line, normalised ───────────────────────────────────────────

test('normalizeVoteReason: collapsed, capped, and "no line" when empty', () => {
  const { subject, restore } = loadVotes({ pool: makeRecordingPool([]) });
  try {
    const { normalizeVoteReason, VOTE_REASON_MAX, VOTE_REASON_REQUIRED } = subject;
    assert.equal(VOTE_REASON_MAX, 280);
    assert.equal(VOTE_REASON_REQUIRED, 'A No comes with a line: what is not working for you?');
    assert.deepEqual(normalizeVoteReason(undefined), { reason: null });
    assert.deepEqual(normalizeVoteReason(null), { reason: null });
    assert.deepEqual(normalizeVoteReason('   '), { reason: null });
    assert.deepEqual(normalizeVoteReason('  The  new\n colors   clash. '), { reason: 'The new colors clash.' });
    assert.deepEqual(normalizeVoteReason('x'.repeat(280)), { reason: 'x'.repeat(280) });
    assert.deepEqual(normalizeVoteReason('x'.repeat(281)), { error: 'Reason must be 280 characters or fewer' });
    assert.deepEqual(normalizeVoteReason(5), { error: 'Reason must be a string' });
    assert.deepEqual(normalizeVoteReason({ text: 'no' }), { error: 'Reason must be a string' });
  } finally {
    restore();
  }
});

// ── 2. The row ────────────────────────────────────────────────────────

test('recordVote writes the line, and the upsert carries or drops the old one by side', async () => {
  const pool = makeRecordingPool([[/INSERT INTO pr_votes/, (params) => [{ id: 1, reason: params[4] }]]]);
  const { subject, restore } = loadVotes({ pool });
  try {
    const r = await subject.recordVote({
      pool, session: { id: 41 }, userId: 8, vote: 'no', headSha: HEAD,
      revisionEnforced: false, reason: 'The new colors clash on mobile.',
    });
    assert.deepEqual(r.rows, [{ id: 1, reason: 'The new colors clash on mobile.' }]);
    const plain = pool.queries[0];
    assert.match(plain.sql, /INSERT INTO pr_votes \(session_id, user_id, vote, head_sha, approval_epoch, reason\)/);
    assert.match(plain.sql, /WHEN EXCLUDED\.reason IS NOT NULL THEN EXCLUDED\.reason/, 'a line that arrives replaces the old one');
    assert.match(plain.sql, /WHEN pr_votes\.vote = EXCLUDED\.vote THEN pr_votes\.reason/, 'none arriving keeps it on the same side');
    assert.match(plain.sql, /ELSE NULL END/, 'and drops it on a flip');
    assert.match(plain.sql, /RETURNING id, reason/);
    assert.deepEqual(plain.params, [41, 8, 'no', HEAD, 'The new colors clash on mobile.']);

    await subject.recordVote({
      pool, session: { id: 41 }, userId: 8, vote: 'yes', headSha: HEAD, revisionEnforced: true,
    });
    const locked = pool.queries[1];
    assert.match(locked.sql, /FOR UPDATE/, 'the revision-enforced path still takes the row lock');
    assert.match(locked.sql, /WHEN pr_votes\.vote = EXCLUDED\.vote THEN pr_votes\.reason/);
    assert.deepEqual(locked.params, [41, 8, 'yes', HEAD, null], 'no line: null, never the empty string');
  } finally {
    restore();
  }
});

// ── 3. The route ──────────────────────────────────────────────────────

test('a No without its line is refused before anything is written', async () => {
  await withServer({}, async (ctx) => {
    const r = await ctx.post({ vote: 'no' });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), {
      error: 'reason_required',
      message: 'A No comes with a line: what is not working for you?',
      maxLength: 280,
    });
    assert.equal(ctx.pool.inserted.length, 0, 'nothing recorded');
    assert.equal(ctx.systemMessages.length, 0, 'nothing announced');
    assert.equal(ctx.voteUpdates.length, 0);

    const blank = await ctx.post({ vote: 'no', reason: '   ' });
    assert.equal(blank.status, 400, 'whitespace is not a line');
    const long = await ctx.post({ vote: 'no', reason: 'x'.repeat(281) });
    assert.equal(long.status, 400);
    assert.deepEqual(await long.json(), { error: 'Reason must be 280 characters or fewer' });
    const odd = await ctx.post({ vote: 'yes', reason: 5 });
    assert.equal(odd.status, 400);
    assert.deepEqual(await odd.json(), { error: 'Reason must be a string' });
  });
});

test('a No with its line is recorded, quoted in the thread, and checks whether the proposal is now contested', async () => {
  await withServer({}, async (ctx) => {
    const r = await ctx.post({ vote: 'no', reason: '  The new   colors clash on mobile. ' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, merged: false });
    assert.equal(ctx.pool.inserted.length, 1);
    assert.deepEqual(ctx.pool.inserted[0].params, [7, 3, 'no', HEAD, 'The new colors clash on mobile.'],
      'the line goes in normalised, beside the vote');

    assert.equal(ctx.systemMessages.length, 1);
    const line = ctx.systemMessages[0];
    assert.equal(line.content, 'evan voted no: “The new colors clash on mobile.”',
      'the row is the sentence, in the proposal\'s own thread');
    assert.equal(line.msgType, 'vote');
    assert.deepEqual(line.thread, { type: 'session', ref: 7 });
    assert.deepEqual(line.metadata, { vote: { sessionId: 7, prNumber: 26, reason: 'The new colors clash on mobile.' } });

    assert.deepEqual(ctx.voteUpdates, [{ sessionId: 7, appSlug: 'widget', merged: false }]);
    assert.deepEqual(ctx.voteNotifications, [{ userId: 9, appId: 5, sessionId: 7, voterId: 3, vote: 'no' }],
      'the proposer is told; their notification reads the line off the row');
    assert.deepEqual(ctx.prompts, [7], 'a No is the one vote that can make a proposal contested');
  });
});

test('a Yes needs no line, and without one reads exactly as before', async () => {
  await withServer({}, async (ctx) => {
    const r = await ctx.post({ vote: 'yes' });
    assert.equal(r.status, 200);
    assert.deepEqual(ctx.pool.inserted[0].params, [7, 3, 'yes', HEAD, null]);
    assert.equal(ctx.systemMessages[0].content, 'evan voted yes on PR #26: Native iOS look');
    assert.deepEqual(ctx.systemMessages[0].metadata, { vote: { sessionId: 7, prNumber: 26, reason: null } });
    assert.deepEqual(ctx.prompts, [], 'a Yes never asks for a conversation');
  });
  await withServer({}, async (ctx) => {
    await ctx.post({ vote: 'yes', reason: 'Love the colors' });
    assert.equal(ctx.systemMessages[0].content, 'evan voted yes: “Love the colors”');
  });
});

test('the same side with new words updates the row and nothing else', async () => {
  await withServer({ prev: [{ vote: 'yes', reason: 'old words', approval_epoch: 2, current_epoch: 2 }] }, async (ctx) => {
    const r = await ctx.post({ vote: 'yes', reason: 'new words' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, merged: false, unchanged: false, reasonUpdated: true });
    assert.deepEqual(ctx.pool.inserted[0].params, [7, 3, 'yes', HEAD, 'new words']);
    assert.equal(ctx.systemMessages.length, 0, 'the vote did not move: no second announcement');
    assert.equal(ctx.voteNotifications.length, 0, 'and no second ping to the proposer');
    assert.deepEqual(ctx.voteUpdates, [{ sessionId: 7, appSlug: 'widget', merged: false }],
      'one tally push, so the roster re-reads the line');
  });
});

test('a re-cast No that already has its line passes the gate; a flip to No does not', async () => {
  await withServer({ prev: [{ vote: 'no', reason: 'Clash', approval_epoch: 2, current_epoch: 2 }] }, async (ctx) => {
    const r = await ctx.post({ vote: 'no' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, merged: false, unchanged: true });
    assert.equal(ctx.pool.inserted[0].reason, 'Clash', 'the upsert keeps the line');
  });
  await withServer({ prev: [{ vote: 'yes', reason: 'Loved v1', approval_epoch: 2, current_epoch: 2 }] }, async (ctx) => {
    const r = await ctx.post({ vote: 'no' });
    assert.equal(r.status, 400, 'the old line argued for the other side');
    assert.equal((await r.json()).error, 'reason_required');
  });
});

// ── 4. The roster ─────────────────────────────────────────────────────

test('the roster carries each counted line and the people whose vote was on an earlier version', async () => {
  const roster = [
    { vote: 'yes', reason: 'Love it', username: 'alice', user_id: 11, current: true },
    { vote: 'no', reason: 'Clash', username: 'carol', user_id: 12, current: true },
    { vote: 'yes', reason: null, username: 'bob', user_id: 13, current: false },
    { vote: 'no', reason: null, username: 'dave', user_id: 14, current: false },
    { vote: 'yes', reason: null, username: 'erin', user_id: 15, current: true },
  ];
  await withServer({ roster }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/votes`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      yes: ['alice', 'erin'],
      no: ['carol'],
      reasons: [
        { username: 'alice', vote: 'yes', reason: 'Love it' },
        { username: 'carol', vote: 'no', reason: 'Clash' },
      ],
      earlier: { yes: ['bob'], no: ['dave'] },
    });
    const q = ctx.pool.queries.find((x) => /AS current\s+FROM pr_votes pv/.test(x.sql));
    assert.match(q.sql, /\(pv\.approval_epoch = cs\.approval_epoch\) AS current/,
      'every row is read, with whether it still counts');
    assert.doesNotMatch(q.sql, /WHERE pv\.session_id = \$1\s+AND/, 'not filtered to the current epoch in SQL');
  });
});

// ── 5. The credits ────────────────────────────────────────────────────

test('creditsSentence: built, backed, shaped — and the older wording with nobody to name', () => {
  const { subject, restore } = loadVotes({ pool: makeRecordingPool([]) });
  try {
    const { creditsSentence } = subject;
    const all = { author: 'evan', backers: ['alice', 'bob'], shapers: ['carol'] };
    assert.equal(creditsSentence(all), 'Built by evan, backed by alice and bob, shaped by carol.');
    assert.equal(creditsSentence(all, { withAuthor: false }), 'Backed by alice and bob, shaped by carol.',
      'the author is left out of the sentence that goes to the author');
    assert.equal(creditsSentence({ author: 'evan', backers: ['alice'], shapers: [] }), 'Built by evan, backed by alice.');
    assert.equal(creditsSentence({ author: 'evan', backers: [], shapers: [] }), 'Built by evan.');
    assert.equal(creditsSentence({ author: null, backers: ['alice', 'bob', 'carol'], shapers: [] }), 'Backed by alice, bob and carol.');
    assert.equal(creditsSentence({ author: null, backers: [], shapers: ['carol'] }), 'Shaped by carol.');
    assert.equal(creditsSentence({ author: null, backers: [], shapers: [] }), 'Thanks to everyone who voted');
    assert.equal(creditsSentence({ author: null, backers: [], shapers: [] }, { withAuthor: false }), '');
    const many = Array.from({ length: 10 }, (_, i) => `u${i + 1}`);
    assert.equal(creditsSentence({ author: null, backers: many, shapers: [] }),
      'Backed by u1, u2, u3, u4, u5, u6, u7, u8 and 2 more.', 'a sentence, not a roll call');
  } finally {
    restore();
  }
});

test('mergeCredits: the author, the counted Yes voters, then the objectors with a line and the people in the thread', async () => {
  const pool = makeRecordingPool([
    [/SELECT username FROM users WHERE id = \$1/, [{ username: 'evan' }]],
    [/FROM pr_votes pv/, [
      { username: 'evan', vote: 'yes', reason: null },   // voting for your own is allowed; being thanked for it is odd
      { username: 'alice', vote: 'yes', reason: 'Love it' },
      { username: 'carol', vote: 'no', reason: 'The colors clash on mobile.' },
      { username: 'dave', vote: 'no', reason: null },     // a No without a line shaped nothing
      { username: 'bob', vote: 'yes', reason: null },
    ]],
    [/FROM chat_messages cm/, [{ username: 'frank' }, { username: 'alice' }, { username: 'evan' }]],
  ]);
  const { subject, restore } = loadVotes({ pool });
  try {
    const credits = await subject.mergeCredits(pool, { id: 41, app_id: 5, user_id: 7 });
    assert.deepEqual(credits, { author: 'evan', backers: ['alice', 'bob'], shapers: ['carol', 'frank'] },
      'in vote order, nobody named twice');
    const votes = pool.queries.find((q) => /FROM pr_votes pv/.test(q.sql));
    assert.match(votes.sql, /pv\.approval_epoch = cs\.approval_epoch/, 'only the votes that counted at merge');
    const talk = pool.queries.find((q) => /FROM chat_messages cm/.test(q.sql));
    assert.match(talk.sql, /cm\.thread_type = 'session' AND cm\.thread_ref = \$2/, 'the proposal\'s own thread');
    assert.match(talk.sql, /cm\.msg_type = 'message'/, 'a word from a person, not a vote row or a notice');
    assert.deepEqual(talk.params, [5, 41]);

    const nobody = makeRecordingPool([]);
    assert.deepEqual(await subject.mergeCredits(nobody, { id: 41, app_id: 5, user_id: null }),
      { author: null, backers: [], shapers: [] });
  } finally {
    restore();
  }
});
