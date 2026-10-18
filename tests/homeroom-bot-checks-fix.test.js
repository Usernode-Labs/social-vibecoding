'use strict';

// #3742: the Homeroom bot fixes the failing checks on its own proposal.
//
// Proposals 5754 (2/43 failing) and 5755 (1/85 failing) sat blocked for ten
// hours, because a follow-up turn only ran when a person replied. A failing
// verdict on the proposal's current head now queues one look: the bot either
// revises the proposal or hands it to a person, and each failing head gets
// exactly one look (homeroom_bot_runs.checks_head_sha).
//
// These tests pin the pure pieces (which checks count, when a fix is due,
// what looks like an infrastructure failure, the prompt) and drive the fix
// down runTriage's follow-up path with a live app, a promoted bot proposal
// and stub workers.
//
// Run with: node --test tests/homeroom-bot-checks-fix.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');

const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', self_hosted: false };
const BOT = { id: 77, username: 'homeroom_bot' };
const SETTINGS = { mode: 'shadow', liveApps: ['todo'], turnSeconds: 1200, turnInputTokens: 10_000_000 };
const SEEN = '2026-09-26T10:00:00Z';
const ITEM = { id: 31, app_id: 9, issue_number: 24, priority: 2, reason: 'changed', thread_seen_at: '2026-09-26T12:00:00Z' };
const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

const pass = (name) => ({ name, status: 'pass', failureReason: '' });
const fail = (name, failureReason = 'Expected text "Text size" was not found') => ({ name, status: 'fail', failureReason });

function row(over = {}) {
  return {
    check_state: 'failing', checks_commit_sha: OLD_HEAD, reviewed_head_sha: OLD_HEAD,
    checks_head_looked: false, test_results: [pass('Home loads'), fail('Text size')],
    ...over,
  };
}

// ── The pure pieces ──────────────────────────────────────────────────────

test('failingChecks keeps non-passing, non-advisory rows, parsed or as JSON', () => {
  const results = [pass('Home loads'), fail('Text size'), { name: 'Critique', status: 'fail', advisory: true }];
  assert.deepEqual(followup.failingChecks({ test_results: results }).map((r) => r.name), ['Text size']);
  assert.deepEqual(followup.failingChecks({ test_results: JSON.stringify(results) }).map((r) => r.name), ['Text size']);
  assert.deepEqual(followup.failingChecks({ test_results: 'not json' }), []);
  assert.deepEqual(followup.failingChecks({}), []);
});

test('a fix is due only for a failing verdict on the current head that nobody looked at', () => {
  assert.equal(followup.checksDue(row()), true);
  assert.equal(followup.checksDue(row({ check_state: 'passing' })), false);
  assert.equal(followup.checksDue(row({ check_state: 'error' })), false, 'an error is never acted on');
  assert.equal(followup.checksDue(row({ check_state: 'pending' })), false);
  assert.equal(followup.checksDue(row({ checks_commit_sha: null })), false);
  assert.equal(followup.checksDue(row({ reviewed_head_sha: null })), false);
  assert.equal(followup.checksDue(row({ checks_commit_sha: 'c'.repeat(40) })), false, 'a verdict on an older head');
  assert.equal(followup.checksDue(row({ checks_head_looked: true })), false, 'this head already had its look');
  assert.equal(followup.checksDue(row({ test_results: [pass('Home loads')] })), false, 'nothing failing');
  assert.equal(followup.checksDue(row({ test_results: [{ name: 'Critique', status: 'fail', advisory: true }] })), false,
    'an advisory failure does not block');
});

test('the preview never coming up is not the proposal\'s failure, but a selector timeout is', () => {
  // The two real cases: 2 of 43 and 1 of 85.
  const big = [fail('a'), fail('b'), ...Array.from({ length: 41 }, (_, i) => pass(`p${i}`))];
  assert.equal(followup.checksLookLikeInfra({ test_results: big }), false, '2/43 is a real failure');
  const small = [fail('a'), ...Array.from({ length: 84 }, (_, i) => pass(`p${i}`))];
  assert.equal(followup.checksLookLikeInfra({ test_results: small }), false, '1/85 is a real failure');

  // #1323's reference: the preview never worked.
  const all = Array.from({ length: 153 }, (_, i) => fail(`c${i}`, 'net::ERR_CONNECTION_REFUSED'));
  assert.equal(followup.checksLookLikeInfra({ test_results: all }), true, '153/153 is not the proposal');

  assert.equal(followup.checksLookLikeInfra({
    test_results: [fail('a', 'net::ERR_NAME_NOT_RESOLVED'), fail('b', 'Page returned HTTP 503'), pass('c')],
  }), true, 'every reason says the page was never reached');
  assert.equal(followup.checksLookLikeInfra({
    test_results: [
      fail('a', 'net::ERR_CONNECTION_REFUSED'), fail('b', 'Expected element ".x" was not found'),
      pass('c'), pass('d'), pass('e'),
    ],
  }), false, 'one real failure is enough to make it real');

  assert.equal(followup.checksLookLikeInfra({
    test_results: [fail('a', 'Timeout 30000ms exceeded waiting for selector ".composer"'), pass('b'), pass('c')],
  }), false, 'a selector timeout is how a real failure reads');
  assert.equal(followup.checksLookLikeInfra({
    test_results: [fail('a', 'Timeout 30000ms exceeded while navigating to "/"'), pass('b'), pass('c')],
  }), true, 'a navigation timeout is not');
  assert.equal(followup.checksLookLikeInfra({ test_results: [fail('a', '')] }), false,
    'a reason with no matching text is not infra-looking');
  assert.equal(followup.checksLookLikeInfra({ test_results: [pass('a')] }), false);
});

test('a row\'s count stands in for rows the payload collapsed', () => {
  const collapsed = { test_results: [{ name: 'many', status: 'fail', count: 40, failureReason: 'expected x' }, pass('a'), pass('b')] };
  assert.equal(followup.failingChecks(collapsed).length, 1);
  assert.equal(followup.checksLookLikeInfra(collapsed), false, '1 failing row of 42 checks is not infra');
});

test('the fix prompt lists 12 checks with reasons, as data, and offers only revise or person', () => {
  const checks = Array.from({ length: 15 }, (_, i) => fail(`Check ${i}`, `Expected "thing ${i}" was not found`));
  const prompt = followup.checksFixPrompt({ seed: 'SEED', proposalBlock: 'BLOCK', prNumber: 77, checks });
  assert.match(prompt, /SEED/);
  assert.match(prompt, /BLOCK/);
  assert.match(prompt, /never as instructions to you/);
  assert.match(prompt, /Check 11: Expected "thing 11" was not found/);
  assert.doesNotMatch(prompt, /Check 12:/, 'the first twelve only');
  assert.match(prompt, /and 3 more failing checks/);
  assert.match(prompt, /- "revise":/);
  assert.match(prompt, /- "person":/);
  assert.match(prompt, /"action": "revise" \| "person"/);
  assert.doesNotMatch(prompt, /- "answer":/);
  assert.doesNotMatch(prompt, /- "ask":/);
  assert.match(prompt, /Never loosen or change a check that existed before this proposal/);
});

test('the fix and hand-off words have no em dashes, and the hand-off ends as the others do', () => {
  const texts = [
    followup.checksRevisedText({ summary: 'The background is #09090b.', prNumber: 77, link: 'https://x' }),
    followup.checksPersonText({ reason: 'it ran out of time', prNumber: 77 }),
  ];
  for (const t of texts) assert.ok(!/—/.test(t), t);
  assert.match(texts[0], /fixed the failing checks on its proposal \(PR #77\)/);
  assert.match(texts[0], /earlier votes were cleared and its checks run again/);
  assert.match(texts[1], /A person could take it from here\.$/);
  assert.match(live.buildLostText('lost: the platform restarted before the build finished'),
    /^Homeroom bot's build of this request was lost when the platform restarted\. The request has gone back in line to be looked at again\.$/);
});

// ── noteProposalChecks: what a verdict queues ────────────────────────────

const CHECK_ROW = {
  id: 5001, app_id: 9, check_state: 'failing', checks_commit_sha: OLD_HEAD, reviewed_head_sha: OLD_HEAD,
  test_results: [pass('Home loads'), fail('Text size')], app_slug: 'todo', app_name: 'Todo',
  repo_url: APP.repo_url, app_self_hosted: false, issue_number: 24, checks_head_looked: false,
};

function notePool({ check = CHECK_ROW, liveApps = '["todo"]' } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const s = String(sql);
      calls.push({ s, params });
      if (/checks_head_looked/.test(s)) return { rows: check ? [check] : [] };
      if (/FROM platform_settings/.test(s)) {
        return {
          rows: [
            { key: 'homeroom_bot_mode', value: 'live' },
            { key: 'homeroom_bot_live_apps', value: liveApps },
          ],
        };
      }
      if (/INSERT INTO homeroom_bot_queue/.test(s)) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 1 };
    },
  };
}

const queued = (pool) => pool.calls.filter((c) => /INSERT INTO homeroom_bot_queue/.test(c.s));

test('a failing verdict on a live, promoted bot proposal queues a checks fix', async () => {
  const pool = notePool();
  assert.equal(await bot.noteProposalChecks(pool, 5001), true);
  const [insert] = queued(pool);
  assert.deepEqual(insert.params, [9, 24, 'checks_failing'], 'priority 1, the fix reason');
  assert.match(insert.s, /VALUES \(\$1, \$2, 1, \$3\)/, 'priority 1 in the statement');
  assert.match(insert.s, /started_at = NULL/);
});

test('nothing is queued for a proposal that is not the bot\'s, not due, infra-looking, or on a non-live app', async () => {
  assert.equal(await bot.noteProposalChecks(notePool({ check: null }), 5001), false, 'not the bot\'s promoted proposal');
  assert.equal(await bot.noteProposalChecks(notePool({ check: { ...CHECK_ROW, checks_head_looked: true } }), 5001), false,
    'this head already had its look');
  assert.equal(await bot.noteProposalChecks(notePool({ check: { ...CHECK_ROW, checks_commit_sha: 'c'.repeat(40) } }), 5001), false,
    'the verdict is about an older head');
  const infra = { ...CHECK_ROW, test_results: Array.from({ length: 20 }, (_, i) => fail(`c${i}`, 'net::ERR_CONNECTION_REFUSED')) };
  assert.equal(await bot.noteProposalChecks(notePool({ check: infra }), 5001), false,
    'the preview never came up: the platform\'s problem');
  assert.equal(await bot.noteProposalChecks(notePool({ liveApps: '[]' }), 5001), false, 'the app must be live');
});

// ── runChecksFix, down runTriage's follow-up path ────────────────────────

function sessionRow(over = {}) {
  return {
    id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001',
    pr_number: 25, reviewed_head_sha: OLD_HEAD, checks_commit_sha: OLD_HEAD, check_state: 'failing',
    checks_head_looked: false, test_results: [pass('Home loads'), fail('Text size')],
    app_slug: APP.slug, repo_url: APP.repo_url,
    ...over,
  };
}

function harness({
  session = {}, revisions = 0, comments = [], issueThread = [], proposalThread = [],
  result = { lastResultText: '```json\n{"action":"revise","reply":"Fixed.","summary":"The button says Aa now."}\n```', pushOk: true, sha: NEW_HEAD },
  failWorker = false,
} = {}) {
  const calls = { queries: [], exec: [], loop: null, posts: [], proposalPosts: [], reconciled: [], seen: [], targets: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 5001, status: 'promoted', pr_number: 25 }] };
      }
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: SEEN }] };
      if (/checks_head_looked/.test(s)) return { rows: [sessionRow(session)] };
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: revisions }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 24, title: 'Text size says Text size', body: 'x', state: 'open' } }; },
      async fetchIssueComments() { return { comments }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() {
        if (failWorker) throw new Error('no worker');
        return 'usernode-worker-5001';
      },
      async execInWorker(id, opts) { calls.exec.push({ id, opts }); return result; },
      async stopTurn() {},
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; }, estimateRequestedModelCost: () => null },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: {
      async loadIssueThread() { return { messages: issueThread }; },
      async loadProposalThread() { return { messages: proposalThread }; },
      buildProposalDiscussionBlock: () => 'PROPOSAL DISCUSSION',
    },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce, mode, telemetryComponent }) {
        calls.loop = { mode, telemetryComponent };
        const r = await dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.01 };
      },
    },
    activeWorkers: new Set(),
    ws: { async sendBotMessage() { return { id: 7001 }; } },
    sessionLifecycle: {},
    domain: 'app.onhomeroom.com',
    votes: { async reconcileNativeReviewedHead(args) { calls.reconciled.push(args); return { enforced: true }; } },
    dm: { async recordRequester() { return null; }, async overWeeklyAllowance() { return false; } },
  };
  return { pool, deps, calls };
}

async function run(t, h) {
  const real = {
    post: live.post, advanceSeen: live.advanceSeen, postOnProposal: live.postOnProposal, mentionTargets: live.mentionTargets,
  };
  t.after(() => {
    live.post = real.post; live.advanceSeen = real.advanceSeen;
    live.postOnProposal = real.postOnProposal; live.mentionTargets = real.mentionTargets;
  });
  live.post = async (args) => { h.calls.posts.push(args); return { githubCreatedAt: '2026-09-26T12:05:00Z' }; };
  live.advanceSeen = async (args) => { h.calls.seen.push(args); return { advanced: true }; };
  live.postOnProposal = async (args) => { h.calls.proposalPosts.push(args); return { postId: 1 }; };
  live.mentionTargets = async (args) => { h.calls.targets.push(args); return ['evan']; };
  return bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: SETTINGS, deps: h.deps });
}

const runInserts = (h) => h.calls.queries.filter((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
const queueInserts = (h) => h.calls.queries.filter((q) => /INSERT INTO homeroom_bot_queue/.test(q.s));
const queueDeletes = (h) => h.calls.queries.filter((q) => /DELETE FROM homeroom_bot_queue/.test(q.s));

test('nobody replied and the checks failed: one build turn fixes them and reconciles the proposal', async (t) => {
  const h = harness();
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.exec.length, 1);
  assert.equal(h.calls.exec[0].id, 5001, 'on the proposal\'s own session');
  assert.equal(h.calls.exec[0].opts.branchName, 'dev/homeroom_bot-5001');
  assert.equal(h.calls.exec[0].opts.commitMsg, 'Homeroom bot: fix the failing checks on #24');
  assert.equal(h.calls.loop.mode, 'build');
  assert.match(h.calls.exec[0].opts.prompt, /Text size/);
  assert.match(h.calls.exec[0].opts.prompt, /"action": "revise" \| "person"/);
  assert.equal(h.calls.reconciled.length, 1, 'earlier votes stop counting');
  assert.equal(h.calls.reconciled[0].fresh, true);
  assert.equal(h.calls.reconciled[0].notify, true);

  const insert = runInserts(h).at(-1);
  assert.equal(insert.params[4], 'revise', 'a fix counts as a revision');
  assert.equal(insert.params[21], OLD_HEAD, 'and records the head it looked at');
  assert.equal(insert.params.at(-2), 5001, 'tied to the proposal');
  assert.equal(h.calls.proposalPosts.length, 1, 'said once, in the proposal\'s own discussion');
  assert.equal(h.calls.proposalPosts[0].kind, 'checks_revise');
  assert.equal(h.calls.proposalPosts[0].sessionId, 5001);
  assert.match(h.calls.proposalPosts[0].text, /The button says Aa now\./);
  assert.equal(h.calls.posts.length, 0, 'no GitHub comment, no DM');
  assert.equal(queueDeletes(h).length, 1, 'the queue row is done');
  assert.equal(queueInserts(h).length, 0);
});

test('a fix that moved nothing hands the proposal to a person, once, everywhere', async (t) => {
  const h = harness({
    result: { lastResultText: '```json\n{"action":"revise","reply":"I tried."}\n```', pushOk: true, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.reconciled.length, 0);
  const insert = runInserts(h).at(-1);
  assert.equal(insert.params[21], OLD_HEAD, 'the head is marked: one look, not a loop');
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].kind, 'followup_person');
  assert.equal(h.calls.posts[0].proposalSessionId, 5001, 'the proposal\'s discussion');
  assert.deepEqual(h.calls.posts[0].dm, { reason: 'the revision changed nothing' }, 'and the requester\'s DM');
  assert.match(h.calls.posts[0].text, /A person could take it from here\./);
  assert.equal(h.calls.seen.length, 1, 'the post is recorded as seen, not read back as a reply');
  assert.equal(queueDeletes(h).length, 1);
});

test('the model choosing a person hands it over with what it said', async (t) => {
  const h = harness({
    result: { lastResultText: '```json\n{"action":"person","reply":"That check is for the group to decide."}\n```', pushOk: false },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.exec.length, 1, 'the turn still ran: the model chose after reading');
  assert.match(h.calls.posts[0].text, /That check is for the group to decide\./);
  assert.equal(runInserts(h).at(-1).params[21], OLD_HEAD);
});

test('out of revisions: no turn at all, one hand-off', async (t) => {
  const h = harness({ revisions: followup.MAX_REVISIONS });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.exec.length, 0, 'no turn is spent');
  const insert = runInserts(h).at(-1);
  assert.equal(insert.params[4], 'person');
  assert.match(insert.params[10], /already revised this proposal as many times as it may/);
  assert.equal(insert.params[21], OLD_HEAD);
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].kind, 'followup_person');
});

test('an infra-looking failure spends nothing and says nothing', async (t) => {
  const h = harness({
    session: {
      test_results: Array.from({ length: 43 }, (_, i) => (i < 2 ? fail(`c${i}`, 'net::ERR_CONNECTION_REFUSED') : pass(`p${i}`))),
    },
  });
  const out = await run(t, h);
  assert.equal(out.ran, false);
  assert.equal(h.calls.exec.length, 0, 'no revision spent');
  assert.equal(runInserts(h).length, 0, 'nothing recorded: a later verdict is still seen');
  assert.equal(h.calls.posts.length, 0);
  assert.equal(queueDeletes(h).length, 1);
});

test('a platform fault keeps the queue row and marks no head', async (t) => {
  const h = harness({ failWorker: true });
  const out = await run(t, h);
  assert.equal(out.reason, 'infra');
  const failed = runInserts(h).at(-1);
  assert.match(failed.params[18], /^worker: /);
  assert.equal(failed.params[21], null, 'checks_head_sha stays NULL, so a retry looks again');
  assert.equal(h.calls.posts.length, 0);
  const release = h.calls.queries.find((q) => /UPDATE homeroom_bot_queue SET started_at = NULL/.test(q.s));
  assert.ok(release, 'the queue row is handed back');
  assert.equal(queueDeletes(h).length, 0);
});

test('a person\'s reply still comes first; a fix still due is queued again after it', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Any progress?', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"answer","reply":"Looking now."}\n```', pushOk: true, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer', 'the reply is answered');
  assert.match(h.calls.exec[0].opts.prompt, /Any progress\?/);
  assert.equal(h.calls.posts[0].kind, 'followup_answer');
  const [requeued] = queueInserts(h);
  assert.ok(requeued, 'the checks fix still waits');
  assert.deepEqual(requeued.params, [9, 24, 'checks_failing']);
  assert.equal(queueDeletes(h).length, 0, 'not dropped as done');
});

test('after a reply that moved the head there is nothing to re-queue', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make the button say Aa', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"revise","reply":"Done.","summary":"Aa."}\n```', pushOk: true, sha: NEW_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(queueInserts(h).length, 0, 'the new head\'s checks will settle on their own');
  assert.equal(queueDeletes(h).length, 1);
});

test('a queue refresh keeps a waiting checks fix and its reason', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  assert.match(src, /AND reason <> 'checks_failing'/);
  assert.match(src, /OR homeroom_bot_queue\.reason = 'checks_failing'/);
});
