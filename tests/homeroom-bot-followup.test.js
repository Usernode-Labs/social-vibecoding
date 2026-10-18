// #3264: the Homeroom bot follows up on a proposal it opened itself.
//
// Before, a reply on an issue the bot had proposed for re-queued it, and the
// run stopped at "already has a bot proposal" and said nothing. These tests
// drive runTriage down the follow-up path with a live app, a promoted bot
// proposal and stub workers, and pin the pure pieces (who counts as a reply,
// the prompt, the parser, when the head moved) directly.
//
// Run with: node --test tests/homeroom-bot-followup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'rss-reader-4113da', name: 'RSS reader', repo_url: 'https://github.com/usernode-bot/rss-reader-4113da', self_hosted: false };
const BOT = { id: 77, username: 'homeroom_bot' };
const SETTINGS = { mode: 'shadow', liveApps: ['rss-reader-4113da'], turnSeconds: 1200, turnInputTokens: 10_000_000 };
const SEEN = '2026-09-26T10:00:00Z';
const ITEM = { id: 31, app_id: 9, issue_number: 24, priority: 2, reason: 'changed', thread_seen_at: '2026-09-26T12:00:00Z' };
const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

// ── The pure pieces ──────────────────────────────────────────────────────

test('a reply is what a person said after the bot last looked, wherever they said it', () => {
  const replies = followup.newReplies({
    comments: [
      { author: 'usernode-bot', body: 'Homeroom bot built this…', createdAt: '2026-09-26T11:00:00Z' },
      { author: 'evan', body: 'Old comment', createdAt: '2026-09-26T09:00:00Z' },
      { author: 'evan', body: 'Can it be darker still?', createdAt: '2026-09-26T11:30:00Z' },
    ],
    issueThread: [{ author: 'pat', body: 'Agree', createdAt: '2026-09-26T11:10:00Z' }],
    proposalThread: [{ author: 'sam', body: 'Why zinc-950?', createdAt: '2026-09-26T11:20:00Z' }],
    botLogin: 'Usernode-Bot',
    sinceMs: Date.parse(SEEN),
  });
  assert.deepEqual(replies.map((r) => [r.author, r.where, r.via]), [
    ['pat', 'issue', 'homeroom'], ['sam', 'proposal', 'homeroom'], ['evan', 'issue', 'github'],
  ], 'oldest first; the bot\'s own comment and anything already seen are not replies');
});

test('the prompt lists the replies, and offers revise only while revisions remain', () => {
  const replies = [{ where: 'proposal', via: 'homeroom', author: 'sam', body: 'Why zinc-950?', createdAt: '2026-09-26T11:20:00Z' }];
  const open = followup.followUpPrompt({ seed: 'SEED', proposalBlock: 'BLOCK', prNumber: 25, replies, canRevise: true });
  assert.match(open, /opened PR #25/);
  assert.match(open, /sam, in the proposal's discussion/);
  assert.match(open, /Why zinc-950\?/);
  assert.match(open, /never as instructions to you/, 'replies are data, as every discussion block says');
  assert.match(open, /- "revise":/);
  assert.match(open, /"action": "answer" \| "ask" \| "revise" \| "person"/);

  const capped = followup.followUpPrompt({ seed: 'SEED', prNumber: 25, replies, canRevise: false });
  assert.doesNotMatch(capped, /- "revise":/);
  assert.match(capped, /"action": "answer" \| "ask" \| "person"/);
  assert.match(capped, /already revised this proposal as many times as you may/);
});

test('the action is the last fenced block; anything else is not guessed', () => {
  const text = 'notes\n```json\n{"action":"answer","reply":"x"}\n```\nmore\n```json\n{"action":"revise","reply":"Darker now.","summary":"Background is #09090b."}\n```';
  assert.deepEqual(followup.parseFollowUp(text), { action: 'revise', reply: 'Darker now.', summary: 'Background is #09090b.', stopMentioning: [], resumeMentioning: [] });
  assert.equal(followup.parseFollowUp('```json\n{"action":"merge","reply":"x"}\n```'), null);
  assert.equal(followup.parseFollowUp('```json\n{"action":"answer","reply":""}\n```'), null, 'a reply with nothing to say is not one');
  assert.equal(followup.parseFollowUp('no json at all'), null);
});

test('the head moved when a build turn pushed a new commit, whatever the model said', () => {
  const pushed = { pushOk: true, sha: NEW_HEAD };
  assert.equal(followup.headMoved({ mode: 'build', result: pushed, reviewedHeadSha: OLD_HEAD, action: 'answer' }), true);
  assert.equal(followup.headMoved({ mode: 'build', result: { pushOk: true, sha: OLD_HEAD }, reviewedHeadSha: OLD_HEAD, action: 'revise' }), false);
  assert.equal(followup.headMoved({ mode: 'build', result: { pushOk: false, sha: NEW_HEAD }, reviewedHeadSha: OLD_HEAD, action: 'revise' }), false);
  assert.equal(followup.headMoved({ mode: 'scout', result: pushed, reviewedHeadSha: OLD_HEAD, action: 'revise' }), false, 'a scout turn never commits');
  assert.equal(followup.headMoved({ mode: 'build', result: pushed, reviewedHeadSha: null, action: 'revise' }), true);
  assert.equal(followup.headMoved({ mode: 'build', result: pushed, reviewedHeadSha: null, action: 'answer' }), false);
});

test('what it says has no em dashes', () => {
  const texts = [
    followup.answerText({ reply: 'r', prNumber: 25 }),
    followup.askText({ reply: 'r', prNumber: 25 }),
    followup.personText({ reply: 'r', prNumber: 25 }),
    followup.revisedText({ summary: 's', reply: 'r', prNumber: 25, link: 'https://x' }),
    followup.revisionFailedText({ why: 'w', prNumber: 25 }),
  ];
  for (const t of texts) assert.ok(!/—/.test(t), t);
  assert.match(texts[3], /earlier votes were cleared/);
});

// ── runTriage, down the follow-up path ───────────────────────────────────

function harness({
  proposalStatus = 'promoted', revisions = 0, comments = [], issueThread = [], proposalThread = [],
  result = { lastResultText: '```json\n{"action":"answer","reply":"Because the platform uses it."}\n```', pushOk: true, sha: OLD_HEAD },
  checkState = null, checksSha = null, reviewedHead = OLD_HEAD, results = [], checksLooked = false,
  workerFails = false,
} = {}) {
  const calls = { queries: [], exec: [], loop: null, posts: [], proposals: [], reconciled: [], seen: [], queue: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 5001, status: proposalStatus, pr_number: 25 }] };
      }
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: SEEN }] };
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        return { rows: [{
          id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001',
          pr_number: 25, reviewed_head_sha: reviewedHead, check_state: checkState,
          checks_commit_sha: checksSha, test_results: results, checks_looked: checksLooked,
          app_slug: APP.slug, repo_url: APP.repo_url,
        }] };
      }
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: revisions }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
      if (/INSERT INTO homeroom_bot_queue/.test(s)) { calls.queue.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 24, title: 'Use darker color for dark mode theme', body: 'darker please', state: 'open' } }; },
      async fetchIssueComments() { return { comments }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() {
        if (workerFails) throw new Error('the worker would not start');
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
    ws: {},
    sessionLifecycle: {},
    domain: 'app.onhomeroom.com',
    votes: { async reconcileNativeReviewedHead(args) { calls.reconciled.push(args); return { enforced: true }; } },
  };
  return { pool, deps, calls };
}

async function run(t, h, item = ITEM) {
  const realPost = live.post;
  const realSeen = live.advanceSeen;
  const realProposal = live.postOnProposal;
  t.after(() => { live.post = realPost; live.advanceSeen = realSeen; live.postOnProposal = realProposal; });
  live.post = async (args) => { h.calls.posts.push(args); return { githubCreatedAt: '2026-09-26T12:05:00Z' }; };
  live.advanceSeen = async (args) => { h.calls.seen.push(args); return { advanced: true }; };
  live.postOnProposal = async (args) => { h.calls.proposals.push(args); return { postId: 1 }; };
  return bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item, mode: 'shadow', settings: SETTINGS, deps: h.deps });
}

const insertOf = (h) => h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));

test('activity with nothing a person said is recorded as seen, and costs nothing', async (t) => {
  const h = harness({ comments: [{ author: 'usernode-bot', body: 'Homeroom bot built this', createdAt: '2026-09-26T11:00:00Z' }] });
  const out = await run(t, h);
  assert.deepEqual(out, { ran: false, reason: 'no_new_replies' });
  assert.equal(h.calls.exec.length, 0, 'no turn');
  assert.equal(h.calls.posts.length, 0, 'nothing posted');
  const seen = h.calls.queries.find((q) => /UPDATE homeroom_bot_runs\s+SET thread_seen_at = GREATEST/.test(q.s));
  assert.deepEqual(seen.params, [800, ITEM.thread_seen_at], 'so the same activity does not bring it back');
});

test('a question in the proposal\'s discussion is answered there and on the issue, with the code in front of it', async (t) => {
  const h = harness({ proposalThread: [{ author: 'sam', body: 'Why zinc-950?', createdAt: '2026-09-26T11:20:00Z' }] });
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer');
  assert.equal(h.calls.exec.length, 1);
  assert.equal(h.calls.exec[0].id, 5001, 'on the proposal\'s own session');
  assert.equal(h.calls.exec[0].opts.branchName, 'dev/homeroom_bot-5001', 'on its branch');
  assert.equal(h.calls.loop.mode, 'build');
  assert.equal(h.calls.loop.telemetryComponent, 'homeroom_bot_followup');
  assert.match(h.calls.exec[0].opts.prompt, /Why zinc-950\?/);
  assert.equal(h.calls.reconciled.length, 0, 'an answer moves nothing');
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].kind, 'followup_answer');
  assert.equal(h.calls.posts[0].proposalSessionId, 5001, 'asked in the proposal thread, answered there too');
  assert.match(h.calls.posts[0].text, /Because the platform uses it/);
  const insert = insertOf(h);
  assert.equal(insert.params[4], 'answer');
  assert.equal(insert.params[20], 5001, 'tied to the proposal');
  assert.equal(h.calls.seen[0].proposalSessionId, 5001, 'a reply there during the turn means it looks again');
  assert.ok(h.calls.queries.some((q) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(q.s) && q.params[0] === 31));
});

test('a clear change is made on the proposal, and the proposal is reconciled like any revision', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000 instead', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"revise","reply":"Done.","summary":"The dark background is now #000."}\n```', pushOk: true, sha: NEW_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.reconciled.length, 1);
  assert.equal(h.calls.reconciled[0].fresh, true, 'reads the head it just pushed');
  assert.equal(h.calls.reconciled[0].notify, true, 'the thread says the votes were cleared');
  assert.equal(h.calls.reconciled[0].session.id, 5001);
  assert.equal(h.calls.posts[0].kind, 'followup_revise');
  assert.equal(h.calls.posts[0].proposalSessionId, null, 'asked on the issue, answered on the issue');
  assert.match(h.calls.posts[0].text, /The dark background is now #000\./);
  assert.match(h.calls.posts[0].text, /https:\/\/app\.onhomeroom\.com\/#app\/rss-reader-4113da\/dev\/proposals\/5001/);
  const insert = insertOf(h);
  assert.equal(insert.params[4], 'revise');
  assert.equal(insert.params[9], 'The dark background is now #000.', 'build_note says what changed');
});

test('a turn that changed files while "answering" is still a revision, and is reconciled', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'thoughts?', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"answer","reply":"Tweaked it."}\n```', pushOk: true, sha: NEW_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise', 'the pushed head is the truth, not the label');
  assert.equal(h.calls.reconciled.length, 1, 'votes on the old head must not keep counting');
});

test('"revise" that pushed nothing is a failure, said plainly, and nothing is reconciled', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"revise","reply":"Done."}\n```', pushOk: true, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.reconciled.length, 0);
  assert.match(insertOf(h).params[18], /^revise: the turn produced no change/);
  assert.equal(h.calls.posts[0].kind, 'followup_failed');
  assert.match(h.calls.posts[0].text, /The proposal is unchanged/);
});

test('after MAX_REVISIONS the turn runs read-only, and can only hand over', async (t) => {
  const h = harness({
    revisions: followup.MAX_REVISIONS,
    comments: [{ author: 'evan', body: 'One more tweak', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"person","reply":"They want another change; a person should take this over."}\n```', pushOk: false, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(h.calls.loop.mode, 'scout', 'no commit, no push');
  assert.doesNotMatch(h.calls.exec[0].opts.prompt, /- "revise":/);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.posts[0].kind, 'followup_person');
  assert.equal(followup.MAX_REVISIONS, 3);
});

test('a proposal that is merging is left alone', async (t) => {
  const h = harness({ proposalStatus: 'merging', comments: [{ author: 'evan', body: 'x', createdAt: '2026-09-26T11:30:00Z' }] });
  const out = await run(t, h);
  assert.deepEqual(out, { ran: false, reason: 'has_proposal' });
  assert.equal(h.calls.exec.length, 0);
});

// ── Getting it queued ────────────────────────────────────────────────────

test('on a live app, a person\'s message in the bot proposal\'s thread is activity on its issue', async () => {
  const inserts = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (/FROM issue_claims|UNNEST\(cs\.linked_issues\) AS n\s+FROM chat_sessions cs JOIN users|headless_issue_number AS n|created_from_issue_number AS n/.test(s)) return { rows: [] };
      if (/CROSS JOIN LATERAL UNNEST\(cs\.linked_issues\)/.test(s)) {
        assert.deepEqual(params, [9, 77], 'the bot\'s own proposals on this app');
        return { rows: [{ n: 24, last_at: '2026-09-26T11:20:00Z' }] };
      }
      if (/FROM chat_messages/.test(s)) return { rows: [] };
      if (/FROM homeroom_bot_runs/.test(s)) return { rows: [{ issue_number: 24, thread_seen_at: SEEN, created_at: SEEN }] };
      if (/INSERT INTO homeroom_bot_queue/.test(s)) { inserts.push(params); return { rows: [] }; }
      if (/DELETE FROM homeroom_bot_queue/.test(s)) return { rowCount: 0, rows: [] };
      return { rows: [] };
    },
  };
  const github = { async fetchPublicIssues() { return { issues: [{ number: 24, state: 'open', updatedAt: SEEN }] }; } };
  await bot.refreshApp(pool, APP, { github, bot: BOT, capRoom: { proposals_per_app: 1, question_tripwire: 5 } });
  assert.deepEqual(inserts.map((p) => [p[1], p[3]]), [[24, 'changed']]);

  inserts.length = 0;
  await bot.refreshApp(pool, APP, { github, bot: BOT });
  assert.equal(inserts.length, 0, 'a shadow app never follows up');
});

test('a message in the bot\'s proposal thread wakes it; any other proposal\'s does not', async () => {
  const asked = [];
  const pool = (rows) => ({ async query(sql, params) { asked.push({ s: String(sql), params }); return { rows }; } });
  assert.equal(await bot.noteProposalActivity(pool([{ linked_issues: [24] }]), { appId: 9, sessionId: 5001 }), true);
  assert.deepEqual(asked[0].params, [5001, 9, 'homeroom_bot']);
  assert.match(asked[0].s, /cs\.status = 'promoted'/);
  assert.equal(await bot.noteProposalActivity(pool([]), { appId: 9, sessionId: 6000 }), false);
  const ws = read('src/services/ws.js');
  assert.match(ws, /if \(thread && thread\.type === 'session'\) noteProposalActivityForBot\(pool, client\.appId, thread\.ref\);/);
});

test('the bot\'s replies in a proposal thread come from its own user, and are never read as a person\'s', () => {
  // #3288: its posts are ordinary messages now, so the guard is who wrote
  // them, not what kind of row they are.
  const src = read('src/services/homeroom-bot-live.js');
  assert.match(src, /inThread\(text, \{ type: 'session', ref: Number\(proposalSessionId\) \}, null, 'system'\)/);
  assert.match(src, /ws\.sendBotMessage\(pool, app\.id, \{ user: sender, content, metadata: meta, thread \}\)/);
  const q = read('src/services/homeroom-bot.js');
  const activity = q.slice(q.indexOf('async function proposalThreadActivityByIssue'), q.indexOf('function latestOf'));
  assert.match(activity, /m\.msg_type = 'message'/);
  assert.match(activity, /cs\.status = 'promoted'/);
  assert.match(activity, /author\.is_synthetic IS NOT TRUE/, 'the bot\'s own reply there does not re-queue it');
});


// ── Failing checks ───────────────────────────────────────────────────────

const HEAD = OLD_HEAD;
const failRow = (name, failureReason = 'expected the button to say Save') => ({ name, path: `/${name}`, status: 'fail', failureReason });
const passRow = (name) => ({ name, path: `/${name}`, status: 'pass' });

test('a checks fix is due only for a failing verdict on the current head, with a real failure, once per head', () => {
  const due = {
    check_state: 'failing', checks_commit_sha: HEAD, reviewed_head_sha: HEAD,
    test_results: [passRow('Home'), failRow('Todo')], checks_looked: false,
  };
  assert.equal(followup.checksDue(due), true);
  assert.equal(followup.checksDue({ ...due, check_state: 'error' }), false, 'an error verdict is never acted on');
  assert.equal(followup.checksDue({ ...due, checks_commit_sha: NEW_HEAD }), false, 'a verdict on an older head');
  assert.equal(followup.checksDue({ ...due, checks_commit_sha: null }), false);
  assert.equal(followup.checksDue({ ...due, checks_looked: true }), false, 'one look per head');
  assert.equal(followup.checksDue({ ...due, test_results: [{ ...failRow('Todo'), advisory: true }] }), false,
    'an advisory failure does not close the merge gate');
  assert.equal(followup.checksDue({ ...due, test_results: [passRow('Home')] }), false);
  assert.equal(followup.checksDue(null), false);
});

test('a preview that never worked is not fixed: most checks failing, or every failure unreachable', () => {
  assert.equal(followup.checksLookLikeInfra([failRow('a'), failRow('b'), failRow('c')], 5), true, '3 of 5');
  assert.equal(followup.checksLookLikeInfra([failRow('a'), failRow('b'), failRow('c')], 4), true, '3 of 4');
  assert.equal(followup.checksLookLikeInfra([failRow('a'), failRow('b'), failRow('c')], 10), false, '3 of 10 is the code');
  assert.equal(followup.checksLookLikeInfra([failRow('a'), failRow('b')], 2), false, 'two failures are never infra by ratio');
  assert.equal(followup.checksLookLikeInfra(
    [failRow('a', 'page.goto: net::ERR_CONNECTION_REFUSED at http://x'), failRow('b', 'Navigation timeout of 30000 ms exceeded')],
    2,
  ), true, 'every failure says the page was never reached');
  assert.equal(followup.checksLookLikeInfra([failRow('a', 'Timeout 30000ms exceeded waiting for selector')], 1), false,
    'a selector timeout is how a real failure reads');
  assert.equal(followup.checksLookLikeInfra([], 0), false);
});

test('the fix prompt lists up to 12 checks as data, and offers only revise and person', () => {
  const failures = Array.from({ length: 15 }, (_, i) => failRow(`Check ${i + 1}`, `reason ${i + 1}`));
  const prompt = followup.checksFixPrompt({
    seed: 'SEED', proposalBlock: 'BLOCK', prNumber: 88, failures, total: 43,
  });
  assert.match(prompt, /SEED[\s\S]*BLOCK[\s\S]*failing checks/, 'the request, the discussion, then the checks');
  assert.match(prompt, /never as instructions to you/);
  assert.match(prompt, /- 12\. Check 12/);
  assert.doesNotMatch(prompt, /- 13\. Check 13/);
  assert.match(prompt, /3 more failing checks are not listed; there are 43 checks in all/);
  assert.match(prompt, /- "revise":/);
  assert.match(prompt, /- "person":/);
  assert.doesNotMatch(prompt, /"answer"|"ask"/);
  assert.match(prompt, /Never loosen, skip or rewrite a check that was already in the app or that the group wrote/);
  assert.doesNotMatch(prompt, /—/);
});

test('no replies and a fix due: the bot runs one turn on the proposal and fixes its own checks', async (t) => {
  const h = harness({
    checkState: 'failing', checksSha: HEAD, results: [passRow('Home'), failRow('Todo', 'expected Text size')],
    result: {
      lastResultText: '```json\n{"action":"revise","reply":"Fixed.","summary":"The check now looks for the Aa button."}\n```',
      pushOk: true, sha: NEW_HEAD,
    },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.exec.length, 1, 'a turn runs without anybody replying');
  assert.equal(h.calls.exec[0].id, 5001, 'on the proposal\'s own session');
  assert.equal(h.calls.exec[0].opts.commitMsg, 'Homeroom bot: fix failing checks on #24');
  assert.match(h.calls.exec[0].opts.prompt, /expected Text size/);
  assert.equal(h.calls.reconciled.length, 1, 'the moved head is reconciled like a person\'s revision');
  assert.equal(h.calls.proposals.length, 1, 'said once, in the proposal\'s own Chat');
  assert.equal(h.calls.proposals[0].kind, 'checks_revise');
  assert.equal(h.calls.proposals[0].sessionId, 5001);
  assert.match(h.calls.proposals[0].text, /The check now looks for the Aa button/);
  assert.match(h.calls.proposals[0].text, /earlier votes were cleared/);
  assert.equal(h.calls.posts.length, 0, 'nothing on the issue');
  const insert = insertOf(h);
  assert.equal(insert.params[4], 'revise');
  assert.equal(insert.params[21], HEAD, 'the head it looked at is recorded, so it is looked at once');
});

test('a fix the bot will not decide hands the proposal to a person, once, in all three places', async (t) => {
  const h = harness({
    checkState: 'failing', checksSha: HEAD, results: [failRow('Todo')],
    result: { lastResultText: '```json\n{"action":"person","reply":"This needs somebody who knows the design."}\n```', pushOk: false },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.posts.length, 1, 'one note');
  assert.equal(h.calls.posts[0].kind, 'followup_person');
  assert.equal(h.calls.posts[0].proposalSessionId, 5001, 'the proposal\'s Chat');
  assert.deepEqual(h.calls.posts[0].dm, { reason: 'This needs somebody who knows the design.' }, 'and the requester\'s DM');
  assert.match(h.calls.posts[0].text, /This needs somebody who knows the design/);
  assert.equal(insertOf(h).params[21], HEAD, 'the head is marked');
  assert.equal(h.calls.proposals.length, 0);
});

test('out of revisions, no turn runs at all: one note asks for a person', async (t) => {
  const h = harness({
    revisions: followup.MAX_REVISIONS, checkState: 'failing', checksSha: HEAD, results: [failRow('Todo')],
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.exec.length, 0, 'no turn');
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].kind, 'followup_person');
  assert.match(h.calls.posts[0].text, /already revised this proposal as many times as it may/);
  assert.equal(insertOf(h).params[21], HEAD);
});

test('a revise that moved nothing hands over, rather than looping on the same head', async (t) => {
  const h = harness({
    checkState: 'failing', checksSha: HEAD, results: [failRow('Todo')],
    result: { lastResultText: '```json\n{"action":"revise","reply":"Tried."}\n```', pushOk: true, sha: HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.match(insertOf(h).params[18], /^revise: the turn produced no change/);
  assert.equal(insertOf(h).params[21], HEAD);
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].kind, 'followup_person');
  assert.match(h.calls.posts[0].text, /produced no change/);
});

test('a preview that looks broken spends nothing, says nothing, and marks no head', async (t) => {
  const h = harness({
    checkState: 'failing', checksSha: HEAD,
    results: [failRow('a', 'net::ERR_CONNECTION_REFUSED'), failRow('b', 'net::ERR_CONNECTION_REFUSED'), failRow('c', 'ERR_CONNECTION_REFUSED')],
  });
  const out = await run(t, h);
  assert.deepEqual(out, { ran: false, reason: 'checks_look_like_infra' });
  assert.equal(h.calls.exec.length, 0);
  assert.equal(h.calls.posts.length, 0);
  assert.equal(h.calls.proposals.length, 0);
  assert.equal(insertOf(h), undefined, 'no run, so the same head can be looked at again');
  assert.ok(h.calls.queries.some((q) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(q.s)));
});

test('a platform fault keeps the queue row and leaves the head unmarked', async (t) => {
  const h = harness({ checkState: 'failing', checksSha: HEAD, results: [failRow('Todo')], workerFails: true });
  const out = await run(t, h);
  assert.equal(out.reason, 'infra');
  assert.equal(h.calls.exec.length, 0);
  assert.equal(h.calls.posts.length, 0);
  const insert = insertOf(h);
  assert.equal(insert.params[4], 'failed');
  assert.equal(insert.params[21], null, 'no head marked, so the same head is looked at again');
  const keep = h.calls.queries.find((q) => /UPDATE homeroom_bot_queue SET started_at = NULL/.test(q.s));
  assert.deepEqual(keep.params, [ITEM.id]);
});

test('a person\'s reply comes first, and a fix still due after a turn that moved nothing is queued again', async (t) => {
  const h = harness({
    checkState: 'failing', checksSha: HEAD, results: [failRow('Todo')],
    comments: [{ author: 'evan', body: 'Why is it red?', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"answer","reply":"Because the check is wrong."}\n```', pushOk: true, sha: HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer', 'the reply is answered, not the checks fixed in that turn');
  assert.match(h.calls.exec[0].opts.prompt, /Since then, people replied/);
  assert.ok(h.calls.queue.some((p) => p[2] === 'checks_failing'),
    'the fix is queued again for a later turn');
});

test('a reply turn that moved the head is not queued for a fix: its checks run again', async (t) => {
  const h = harness({
    checkState: 'failing', checksSha: HEAD, results: [failRow('Todo')],
    comments: [{ author: 'evan', body: 'Make it darker', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"revise","reply":"Done."}\n```', pushOk: true, sha: NEW_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.queue.length, 0, 'no fix queued: the new head gets its own verdict');
});

test('a checks_failing row is not told "looking": the news is about the proposal', async (t) => {
  const h = harness();
  const out = await run(t, h, { ...ITEM, reason: 'checks_failing' });
  assert.deepEqual(out, { ran: false, reason: 'no_new_replies' });
  assert.equal(h.calls.posts.length, 0, 'no "looking" post, and nothing else to say');
  assert.ok(h.calls.queries.some((q) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(q.s) && q.params[0] === ITEM.id));
});
