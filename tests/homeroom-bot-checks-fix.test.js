'use strict';

// #3646: the Homeroom bot fixes its own failing checks.
//
// A proposal it opened for a vote used to sit red until a person wrote to
// it. Now a settled failing verdict on the head the group is voting on
// queues one bounded fix look (noteProposalChecks gates it), and the fix
// turn runs even with no replies. These tests drive runTriage down the
// follow-up path with a live app, a promoted bot proposal whose checks are
// failing, and stub workers, and pin noteProposalChecks' gates directly.
//
// Run with: node --test tests/homeroom-bot-checks-fix.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');

const APP = { id: 9, slug: 'recipebot-8ca41d', name: 'Recipebot', repo_url: 'https://github.com/usernode-bot/recipebot-8ca41d', self_hosted: false };
const BOT = { id: 77, username: 'homeroom_bot' };
const SETTINGS = { mode: 'shadow', liveApps: [APP.slug], turnSeconds: 1200, turnInputTokens: 10_000_000 };
const SEEN = '2026-10-17T10:00:00Z';
const ITEM = { id: 31, app_id: 9, issue_number: 48, priority: 2, reason: 'checks_failing', thread_seen_at: '2026-10-17T12:00:00Z' };
const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

// recipebot #82: 1 of 85 failing, a check the proposal itself added that
// looked for "Text size" where the button reads "Aa". Not infra.
const FAILING_RESULTS = [
  { name: 'snooze label', status: 'fail', failureReason: 'expected "Text size" but found "Aa"' },
  { name: 'snooze renders', status: 'pass' },
  { name: 'timer rings', status: 'pass' },
];
// todo-list #87: 2 of 43, both real failures. Not infra either.
const TWO_OF_MANY = [
  { name: 'renders', status: 'fail', failureReason: 'Timeout 30000ms exceeded waiting for selector "#items"' },
  { name: 'saves', status: 'fail', failureReason: 'expected "inherit" but got "line-through"' },
  { name: 'p', status: 'pass' }, { name: 'q', status: 'pass' },
];
const ALL_DEAD = [
  { name: 'a', status: 'fail', failureReason: 'net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8080/' },
  { name: 'b', status: 'fail', failureReason: 'net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8080/' },
  { name: 'c', status: 'fail', failureReason: 'net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8080/' },
];

function failingSession(extra = {}) {
  return {
    id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001',
    pr_number: 25, reviewed_head_sha: OLD_HEAD, checks_commit_sha: OLD_HEAD,
    check_state: 'failing', test_results: FAILING_RESULTS, linked_issues: [48],
    app_slug: APP.slug, app_name: APP.name, repo_url: APP.repo_url, app_self_hosted: false,
    ...extra,
  };
}

/** A pool that answers the checks-fix path's reads. Flags tune the gates. */
function harness({
  proposalStatus = 'promoted', revisions = 0, headLooked = false, session = failingSession(),
  settingsRows = [{ key: 'homeroom_bot_mode', value: 'live' }, { key: 'homeroom_bot_live_apps', value: JSON.stringify([APP.slug]) }],
  botOwns = true, comments = [], issueThread = [], proposalThread = [],
  result = { lastResultText: '```json\n{"action":"revise","reply":"Fixed the check.","summary":"The check now matches the button."}\n```', pushOk: true, sha: NEW_HEAD },
  loopError = null,
} = {}) {
  const calls = { queries: [], exec: [], loop: null, posts: [], onProposal: [], reconciled: [], seen: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 5001, status: proposalStatus, pr_number: 25 }] };
      }
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: SEEN }] };
      if (/JOIN users u ON u\.id = cs\.user_id/.test(s)) {
        return { rows: botOwns ? [{ ...session, slug: APP.slug }] : [] };
      }
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: settingsRows };
      if (/SELECT 1 FROM homeroom_bot_runs\s+WHERE proposal_session_id = \$1 AND checks_head_sha = \$2/.test(s)) {
        return { rows: headLooked ? [{}] : [] };
      }
      if (/SELECT cs\.\* FROM chat_sessions cs\s+WHERE cs\.id = \$1 AND cs\.user_id/.test(s)) {
        return { rows: [session] };
      }
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) return { rows: [{ ...session, app_slug: APP.slug, app_name: APP.name, repo_url: APP.repo_url, app_self_hosted: false }] };
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: revisions }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 48, title: 'Shopping list sort', body: 'sort it', state: 'open' } }; },
      async fetchIssueComments() { return { comments }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-5001'; },
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
    },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce, mode, telemetryComponent }) {
        calls.loop = { mode, telemetryComponent };
        if (loopError) return { result: {}, error: loopError, estimatedCostUsd: 0 };
        const r = await dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.01 };
      },
    },
    activeWorkers: new Set(),
    ws: {},
    sessionLifecycle: {},
    votes: { async reconcileNativeReviewedHead(args) { calls.reconciled.push(args); return { enforced: true }; } },
  };
  return { pool, deps, calls };
}

async function run(t, h) {
  const realPost = live.post;
  const realOnProposal = live.postOnProposal;
  const realSeen = live.advanceSeen;
  const realTargets = live.mentionTargets;
  t.after(() => {
    live.post = realPost; live.postOnProposal = realOnProposal;
    live.advanceSeen = realSeen; live.mentionTargets = realTargets;
  });
  live.post = async (args) => { h.calls.posts.push(args); return { githubCreatedAt: '2026-10-17T12:05:00Z' }; };
  live.postOnProposal = async (args) => { h.calls.onProposal.push(args); return { thread: true }; };
  live.advanceSeen = async (args) => { h.calls.seen.push(args); return { advanced: true }; };
  live.mentionTargets = async () => ['evan'];
  return bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: SETTINGS, deps: h.deps });
}

const insertOf = (h) => h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
const queueDeletes = (h) => h.calls.queries.filter((q) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(q.s));
const queueInserts = (h) => h.calls.queries.filter((q) => /INSERT INTO homeroom_bot_queue/.test(q.s));

// ── noteProposalChecks: the gates ────────────────────────────────────────

test('a passing or error verdict never reaches the gate', async () => {
  const h = harness();
  assert.equal(await bot.noteProposalChecks(h.pool, { id: 5001 }, 'passing'), false);
  assert.equal(await bot.noteProposalChecks(h.pool, { id: 5001 }, 'error'), false);
  assert.equal(h.calls.queries.length, 0, 'no reads at all');
});

test('the gates: not the bot\'s, not promoted, not live, empty linked issues', async () => {
  const nobody = harness({ botOwns: false });
  assert.equal(await bot.noteProposalChecks(nobody.pool, { id: 5001 }, 'failing'), false);
  assert.equal(queueInserts(nobody).length, 0, 'nothing queued');

  const notLive = harness({ settingsRows: [] });
  assert.equal(await bot.noteProposalChecks(notLive.pool, { id: 5001 }, 'failing'), false,
    'defaults read mode off, so a shadow app never gets a fix look');
  assert.equal(queueInserts(notLive).length, 0);

  const noIssues = harness({ session: failingSession({ linked_issues: [] }) });
  assert.equal(await bot.noteProposalChecks(noIssues.pool, { id: 5001 }, 'failing'), false);
  assert.equal(queueInserts(noIssues).length, 0);
});

test('the due gates: error state, stale head, already-stamped head', async () => {
  const error = harness({ session: failingSession({ check_state: 'error' }) });
  assert.equal(await bot.noteProposalChecks(error.pool, { id: 5001 }, 'failing'), false);
  assert.equal(queueInserts(error).length, 0);

  const stale = harness({ session: failingSession({ checks_commit_sha: NEW_HEAD }) });
  assert.equal(await bot.noteProposalChecks(stale.pool, { id: 5001 }, 'failing'), false,
    'a verdict on an older head is already superseded');
  assert.equal(queueInserts(stale).length, 0);

  const looked = harness({ headLooked: true });
  assert.equal(await bot.noteProposalChecks(looked.pool, { id: 5001 }, 'failing'), false,
    'this head was already looked at');
  assert.equal(queueInserts(looked).length, 0);
});

test('a failing verdict on the current head queues the issue and wakes the loop', async () => {
  const h = harness();
  assert.equal(await bot.noteProposalChecks(h.pool, { id: 5001 }, 'failing'), true);
  const [insert] = queueInserts(h);
  assert.ok(insert, 'queued');
  assert.deepEqual(insert.params, [9, 48, 'checks_failing']);
  assert.match(insert.s, /started_at = NULL, enqueued_at = NOW\(\)/, 'as requeueForRestart resets the row');
});

// ── The fix turn, through runTriage ──────────────────────────────────────

test('with no replies and a fix due, it revises: reconciled, recorded, said once on the proposal only', async (t) => {
  const h = harness();
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.exec.length, 1, 'one build turn');
  assert.equal(h.calls.exec[0].id, 5001, 'on the proposal\'s own session');
  assert.match(h.calls.exec[0].opts.commitMsg, /fix its proposal's failing checks \(#48\)/);
  assert.match(h.calls.exec[0].opts.prompt, /snooze label: expected "Text size" but found "Aa"/,
    'the failing checks are in the prompt as data');
  assert.match(h.calls.exec[0].opts.prompt, /Never loosen, weaken, skip or change a check that existed before your proposal/);
  assert.equal(h.calls.reconciled.length, 1, 'the same reconcile a person\'s revision reaches');
  assert.equal(h.calls.reconciled[0].fresh, true);
  const insert = insertOf(h);
  assert.equal(insert.params[4], 'revise');
  assert.equal(insert.params[21], OLD_HEAD, 'the run records the head it looked at');
  assert.equal(h.calls.onProposal.length, 1, 'said once');
  assert.equal(h.calls.onProposal[0].kind, 'checks_revise');
  assert.equal(h.calls.onProposal[0].sessionId, 5001, 'in the proposal\'s own thread');
  assert.match(h.calls.onProposal[0].text, /The check now matches the button\./);
  assert.equal(h.calls.posts.length, 0, 'nothing on the issue: the revise is not a hand-off');
  assert.equal(queueDeletes(h).length, 1, 'the queue row is spent');
});

test('the model chose person: the head is stamped and ONE note reaches the issue, the proposal thread and the DM', async (t) => {
  const h = harness({
    result: { lastResultText: '```json\n{"action":"person","reply":"The failing check tests another app\'s screen; a person should decide."}\n```', pushOk: false, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.reconciled.length, 0);
  const insert = insertOf(h);
  assert.equal(insert.params[4], 'person');
  assert.equal(insert.params[21], OLD_HEAD, 'the head is stamped');
  assert.equal(h.calls.posts.length, 1, 'one note');
  assert.equal(h.calls.posts[0].kind, 'followup_person');
  assert.equal(h.calls.posts[0].proposalSessionId, 5001, 'in the proposal\'s thread too');
  assert.deepEqual(h.calls.posts[0].dm, { reason: 'The failing check tests another app\'s screen; a person should decide.' }, 'and in the requester\'s DM');
  assert.deepEqual(h.calls.posts[0].mentions, ['evan'], 'tagging uses mentionTargets');
  assert.equal(h.calls.onProposal.length, 0);
  assert.equal(queueDeletes(h).length, 1);
});

test('out of revisions: no turn at all, the head is stamped and a person is handed the proposal', async (t) => {
  const h = harness({ revisions: followup.MAX_REVISIONS });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.exec.length, 0, 'no turn');
  assert.equal(insertOf(h).params[21], OLD_HEAD);
  assert.match(h.calls.posts[0].text, /a person should take this one/);
  assert.match(h.calls.posts[0].text, /already revised this proposal 3 times/);
  assert.equal(queueDeletes(h).length, 1);
});

test('failures that read as the preview never working spend nothing and say nothing', async (t) => {
  const h = harness({ session: failingSession({ test_results: ALL_DEAD }) });
  const out = await run(t, h);
  assert.deepEqual(out, { ran: false, reason: 'checks_look_like_infra' });
  assert.equal(h.calls.exec.length, 0, 'no turn');
  assert.equal(insertOf(h), undefined, 'nothing recorded');
  assert.equal(h.calls.posts.length, 0, 'nothing said');
  assert.equal(h.calls.onProposal.length, 0);
  assert.equal(queueDeletes(h).length, 1, 'the queue row is released, so a later verdict is still looked at');
});

test('2 of 43 is not infra: the fix turn runs', async (t) => {
  const h = harness({ session: failingSession({ test_results: TWO_OF_MANY }) });
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.exec.length, 1);
});

test('a platform fault keeps the queue row and stamps nothing, as a triage\'s fault does', async (t) => {
  const h = harness({ loopError: 'dispatch: worker gone' });
  const out = await run(t, h);
  assert.deepEqual(out, { ran: false, reason: 'infra', detail: 'dispatch: worker gone', runId: 901 });
  const insert = insertOf(h);
  assert.ok(insert, 'the failure is recorded');
  assert.equal(insert.params[21], null, 'the head is NOT stamped');
  assert.ok(h.calls.queries.some((q) => /UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = \$1/.test(q.s)),
    'the queue row is kept');
  assert.equal(queueDeletes(h).length, 0);
  assert.equal(h.calls.posts.length, 0, 'nothing is said');
});

test('a person\'s reply still comes first, and a fix still due afterwards re-queues', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Why is the list unsorted?', createdAt: '2026-10-17T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"answer","reply":"Because the sort lands in the next change."}\n```', pushOk: false, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer', 'the reply is answered');
  assert.equal(h.calls.exec.length, 1);
  const replyInsert = insertOf(h);
  assert.equal(replyInsert.params[4], 'answer');
  assert.equal(replyInsert.params[21], null, 'the reply run stamps nothing');
  const [requeue] = queueInserts(h);
  assert.ok(requeue, 'the fix still due on this head is re-queued');
  assert.deepEqual(requeue.params, [9, 48, 'checks_failing']);
});

test('a person\'s reply about something else with no checks problem queues nothing', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Thanks!', createdAt: '2026-10-17T11:30:00Z' }],
    session: failingSession({ check_state: 'passing' }),
    result: { lastResultText: '```json\n{"action":"answer","reply":"Any time."}\n```', pushOk: false, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer');
  assert.equal(queueInserts(h).length, 0, 'nothing is due');
});