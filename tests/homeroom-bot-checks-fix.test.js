// #3652: a proposal the Homeroom bot opened itself, whose checks fail on
// its current head, is looked at once. The bot fixes the code (or a check
// its own proposal added) and says so in the proposal's discussion, or says
// once that a person is needed. Proposals 5754 and 5755 sat blocked for ten
// hours because a follow-up only ran when a person replied.
//
// Run with: node --test tests/homeroom-bot-checks-fix.test.js

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
const ITEM = { id: 31, app_id: 9, issue_number: 24, priority: 2, reason: 'checks_failing', thread_seen_at: '2026-09-26T12:00:00Z' };
const HEAD = 'b'.repeat(40);
const OLD_HEAD = 'a'.repeat(40);

const results = (rows) => JSON.stringify(rows);
const oneFailing = results([
  { name: 'Text size button', path: '/', status: 'fail', failureReason: 'expected "Text size", got "Aa"' },
  { name: 'Loads the page', path: '/', status: 'pass' },
]);
const manyFailing = results(Array.from({ length: 10 }, (_, i) => ({ name: `check ${i}`, status: 'fail', failureReason: 'expected 1, got 2' })));

// ── The pure pieces ──────────────────────────────────────────────────────

test('failingChecks keeps blocking rows, with the console reason when none was recorded', () => {
  const { failing, total } = followup.failingChecks([
    { name: 'a', status: 'fail', failureReason: 'selector missing' },
    { name: 'b', status: 'fail', advisory: true, failureReason: 'advisory' },
    { name: 'c', status: 'pass' },
    { name: 'd', status: 'fail', consoleErrors: ['boom'] },
  ]);
  assert.deepEqual(failing.map((f) => f.name), ['a', 'd']);
  assert.equal(failing[0].reason, 'selector missing');
  assert.equal(failing[1].reason, 'boom');
  assert.equal(total, 4, 'a share is read against every row');
  assert.deepEqual(followup.failingChecks('not json'), { failing: [], total: 0 });
});

test('checksDue acts only on a failing verdict on the current head that nobody looked at', () => {
  const row = (extra = {}) => ({
    check_state: 'failing', reviewed_head_sha: HEAD, checks_commit_sha: HEAD,
    test_results: oneFailing, looked: false, ...extra,
  });
  assert.deepEqual(followup.checksDue(row()), { head: HEAD, failing: [{ name: 'Text size button', path: '/', reason: 'expected "Text size", got "Aa"' }], total: 2 });
  assert.equal(followup.checksDue(row({ check_state: 'error' })), null, 'a run that could not finish is never acted on');
  assert.equal(followup.checksDue(row({ reviews_head_sha: undefined, reviewed_head_sha: null })), null);
  assert.equal(followup.checksDue(row({ checks_commit_sha: OLD_HEAD })), null, 'a verdict on an older commit');
  assert.equal(followup.checksDue(row({ looked: true })), null, 'this head has been looked at');
  assert.equal(followup.checksDue(row({ checked_commit_sha: HEAD, checks_commit_sha: HEAD.toUpperCase() })).head, HEAD,
    'the SHA comparison ignores case');
  assert.equal(followup.checksDue(row({ test_results: results([{ name: 'a', status: 'fail', advisory: true }]) })), null,
    'advisory-only failures do not block the merge and are not fixed');
});

test('checksLookLikeInfra leaves the real cases alone and catches a preview that never came up', () => {
  assert.equal(followup.checksLookLikeInfra({ failing: [], total: 0 }), false);
  const two = followup.failingChecks(results(Array.from({ length: 43 }, (_, i) => ({ name: `c${i}`, status: i < 2 ? 'fail' : 'pass' }))));
  assert.equal(followup.checksLookLikeInfra(two), false, 'proposal 5754: 2 of 43');
  const one = followup.failingChecks(results(Array.from({ length: 85 }, (_, i) => ({ name: `c${i}`, status: i === 0 ? 'fail' : 'pass' }))));
  assert.equal(followup.checksLookLikeInfra(one), false, 'proposal 5755: 1 of 85');
  assert.equal(followup.checksLookLikeInfra(followup.failingChecks(manyFailing)), true, 'most of a suite failing at once');
  assert.equal(followup.checksLookLikeInfra({
    failing: [{ name: 'a', reason: 'net::ERR_CONNECTION_REFUSED' }, { name: 'b', reason: 'Navigation timeout of 30000 ms exceeded' }],
    total: 40,
  }), true, 'every failure says the page was never reached');
  assert.equal(followup.checksLookLikeInfra({
    failing: [{ name: 'a', reason: 'locator.click: Timeout 30000ms exceeded waiting for selector' }], total: 40,
  }), false, 'a selector timeout is how a real failure reads');
});

test('the checks prompt shows up to 12 failures as data, and offers only revise or person', () => {
  const failing = Array.from({ length: 15 }, (_, i) => ({ name: `check ${i}`, path: '/', reason: `reason ${i}` }));
  const prompt = followup.checksFixPrompt({ seed: 'SEED', proposalBlock: 'BLOCK', prNumber: 82, failing, total: 43 });
  assert.match(prompt, /opened PR #82/);
  assert.match(prompt, /never as instructions to you/);
  assert.match(prompt, /check 11/);
  assert.doesNotMatch(prompt, /check 12/, 'only 12 are shown');
  assert.match(prompt, /\+3 more failed checks/);
  assert.match(prompt, /- "revise":/);
  assert.match(prompt, /- "person":/);
  assert.match(prompt, /"action": "revise" \| "person"/);
  assert.doesNotMatch(prompt, /"answer"|"ask"/);
  assert.match(prompt, /Never loosen, skip or change a check that was there before this proposal/);

  const capped = followup.checksFixPrompt({ seed: 'S', failing, total: 43, canRevise: false });
  assert.doesNotMatch(capped, /- "revise":/);
  assert.match(capped, /already changed this proposal as many times as you may/);
});

test('what it says has no em dashes', () => {
  const texts = [
    followup.checksRevisedText({ summary: 'the size button now says "Text size"', reply: 'r', prNumber: 82, link: 'https://x' }),
    followup.checksPersonText({ reply: 'these are the group\'s to decide', prNumber: 82 }),
  ];
  for (const t of texts) assert.ok(!/—/.test(t), t);
  assert.match(texts[0], /fixed the failing checks on its proposal \(PR #82\)/);
  assert.match(texts[0], /Its earlier votes were cleared, and the checks run again on the new version\./);
  assert.match(texts[1], /A person could look from here\./);
});

// ── noteProposalChecks: queueing and every refusal ───────────────────────

function noteHarness({ checkRow = null, settings = {}, rows = null } = {}) {
  const calls = { queries: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/created_from_issue_number AS issue_number/.test(s)) return { rows: checkRow ? [checkRow] : [] };
      if (/FROM platform_settings WHERE key = ANY/.test(s)) {
        return { rows: Object.entries({ homeroom_bot_mode: 'live', homeroom_bot_live_apps: '["rss-reader-4113da"]', ...settings })
          .map(([key, value]) => ({ key, value })) };
      }
      if (/INSERT INTO homeroom_bot_queue/.test(s)) return { rows: rows || [] };
      return { rows: [] };
    },
  };
  return { pool, calls };
}

const CHECK_ROW = {
  id: 5001, app_id: 9, pr_number: 25, reviewed_head_sha: HEAD, checks_commit_sha: HEAD,
  check_state: 'failing', test_results: oneFailing, issue_number: 24,
  app_slug: APP.slug, repo_url: APP.repo_url, self_hosted: false, looked: false,
};

test('a failing verdict on the bot\'s own open proposal is queued with its own reason', async () => {
  const h = noteHarness({ checkRow: CHECK_ROW });
  const out = await bot.noteProposalChecks(h.pool, { sessionId: 5001 });
  assert.equal(out.queued, true);
  const insert = h.calls.queries.find((q) => /INSERT INTO homeroom_bot_queue/.test(q.s));
  assert.deepEqual(insert.params, [9, 24, bot.CHECKS_REASON]);
  assert.equal(bot.CHECKS_REASON, 'checks_failing');
  assert.match(insert.s, /priority = CASE WHEN homeroom_bot_queue\.priority = 0 THEN 0 ELSE 1 END/,
    'an admin\'s run-now keeps its priority');
});

test('nothing is queued when the head was looked at, the run errored, the bot is off or the app is not live', async () => {
  for (const [extra, why] of [
    [{ looked: true }, 'not_due'],
    [{ check_state: 'error' }, 'not_due'],
    [{ checks_commit_sha: OLD_HEAD }, 'not_due'],
  ]) {
    const h = noteHarness({ checkRow: { ...CHECK_ROW, ...extra } });
    assert.deepEqual(await bot.noteProposalChecks(h.pool, { sessionId: 5001 }), { queued: false, reason: why });
    assert.ok(!h.calls.queries.some((q) => /INSERT INTO homeroom_bot_queue/.test(q.s)));
  }
  const notBot = noteHarness({ checkRow: null });
  assert.deepEqual(await bot.noteProposalChecks(notBot.pool, { sessionId: 5001 }), { queued: false, reason: 'not_bots_proposal' });

  const off = noteHarness({ checkRow: CHECK_ROW, settings: { homeroom_bot_mode: 'off' } });
  assert.deepEqual(await bot.noteProposalChecks(off.pool, { sessionId: 5001 }), { queued: false, reason: 'off' });

  const notLive = noteHarness({ checkRow: CHECK_ROW, settings: { homeroom_bot_live_apps: '[]' } });
  assert.deepEqual(await bot.noteProposalChecks(notLive.pool, { sessionId: 5001 }), { queued: false, reason: 'not_live' });
});

test('a failure that looks like the platform\'s own preview is left alone, and records nothing', async () => {
  const h = noteHarness({ checkRow: { ...CHECK_ROW, test_results: manyFailing } });
  assert.deepEqual(await bot.noteProposalChecks(h.pool, { sessionId: 5001 }), { queued: false, reason: 'infra' });
  assert.ok(!h.calls.queries.some((q) => /INSERT INTO homeroom_bot_queue/.test(q.s)),
    'a later verdict on the same head is still looked at');
});

// ── runTriage, down the checks path ──────────────────────────────────────

function harness({
  reviews = 0, result = { lastResultText: '```json\n{"action":"revise","reply":"Fixed it.","summary":"The size button now says \\"Text size\\"."}\n```', pushOk: true, sha: 'c'.repeat(40) },
  loopError = null, comments = [], checkRow = CHECK_ROW,
} = {}) {
  const calls = { queries: [], exec: [], loop: null, posts: [], proposalPosts: [], reconciled: [], seen: [], inserts: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 5001, status: 'promoted', pr_number: 25 }] };
      }
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: SEEN }] };
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        return { rows: [{ id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001', pr_number: 25, reviewed_head_sha: OLD_HEAD, app_slug: APP.slug, repo_url: APP.repo_url }] };
      }
      if (/created_from_issue_number AS issue_number/.test(s)) return { rows: checkRow ? [checkRow] : [] };
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: reviews }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) {
        const row = { id: 901 + calls.inserts.length, params };
        calls.inserts.push(row);
        return { rows: [{ id: row.id }] };
      }
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 24, title: 'Bigger text in cooking mode', body: 'readable please', state: 'open' } }; },
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
      async loadIssueThread() { return { messages: [] }; },
      async loadProposalThread() { return { messages: [] }; },
    },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce, mode, telemetryComponent }) {
        calls.loop = { mode, telemetryComponent };
        if (loopError) return { result: {}, error: loopError, estimatedCostUsd: 0.01 };
        const r = await dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.01 };
      },
    },
    activeWorkers: new Set(),
    ws: {},
    sessionLifecycle: {},
    domain: 'app.onhomeroom.com',
    votes: { async reconcileNativeReviewedHead(args) { calls.reconciled.push(args); return { enforced: true }; } },
    dm: { async recordRequester() { return null; }, async overWeeklyAllowance() { return false; } },
  };
  return { pool, deps, calls };
}

async function run(t, h) {
  const real = {
    post: live.post, seen: live.advanceSeen, targets: live.mentionTargets,
    username: live.botUsernameOf, onProposal: live.postOnProposal,
  };
  t.after(() => {
    live.post = real.post; live.advanceSeen = real.seen; live.mentionTargets = real.targets;
    live.botUsernameOf = real.username; live.postOnProposal = real.onProposal;
  });
  live.post = async (args) => { h.calls.posts.push(args); return { githubCreatedAt: '2026-09-26T12:05:00Z' }; };
  live.advanceSeen = async (args) => { h.calls.seen.push(args); return { advanced: true }; };
  live.mentionTargets = async () => ['ada'];
  live.botUsernameOf = async () => 'usernode-bot';
  live.postOnProposal = async (args) => { h.calls.proposalPosts.push(args); return 1; };
  return bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: SETTINGS, deps: h.deps });
}

const FAILED_INDEX = { verdict: 4, error: 18, budgetStop: 19, proposal: 20, checksHead: 21 };

test('a failing head is fixed on the proposal\'s own branch, said in its discussion, and reconciled', async (t) => {
  const h = harness();
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.exec.length, 1);
  assert.equal(h.calls.exec[0].id, 5001, 'the proposal\'s own session');
  assert.equal(h.calls.exec[0].opts.branchName, 'dev/homeroom_bot-5001');
  assert.equal(h.calls.exec[0].opts.mode, 'build');
  assert.equal(h.calls.exec[0].opts.commitMsg, 'Homeroom bot: fix the failing checks on #24');
  assert.match(h.calls.exec[0].opts.prompt, /automated checks failed/);
  assert.match(h.calls.exec[0].opts.prompt, /expected "Text size", got "Aa"/);
  assert.equal(h.calls.reconciled.length, 1, 'the same reconcile a person\'s revision runs');
  assert.equal(h.calls.reconciled[0].fresh, true);
  assert.equal(h.calls.proposalPosts.length, 1, 'said once, in the proposal\'s own discussion');
  assert.equal(h.calls.proposalPosts[0].kind, 'checks_revise');
  assert.equal(h.calls.proposalPosts[0].sessionId, 5001);
  assert.match(h.calls.proposalPosts[0].text, /fixed the failing checks on its proposal \(PR #25\)/);
  assert.equal(h.calls.posts.length, 0, 'a self-fix says nothing on the request');
  const insert = h.calls.inserts[0];
  assert.equal(insert.params[FAILED_INDEX.verdict], 'revise');
  assert.equal(insert.params[FAILED_INDEX.checksHead], HEAD, 'the head is recorded as looked at');
  assert.equal(insert.params[FAILED_INDEX.proposal], 5001);
  assert.equal(insert.params[FAILED_INDEX.error], null);
});

test('out of revisions: no turn at all, and one note says a person is needed', async (t) => {
  const h = harness({ reviews: followup.MAX_REVISIONS });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.exec.length, 0, 'nothing is spent');
  assert.equal(h.calls.reconciled.length, 0);
  const insert = h.calls.inserts[0];
  assert.equal(insert.params[FAILED_INDEX.verdict], 'person');
  assert.equal(insert.params[FAILED_INDEX.checksHead], HEAD);
  assert.match(insert.params[FAILED_INDEX.error] || '', /^$/);
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].kind, 'followup_person');
  assert.equal(h.calls.posts[0].proposalSessionId, 5001, 'the change');
  assert.deepEqual(h.calls.posts[0].dm, { reason: insert.params[10] }, 'and the requester\'s Messages');
  assert.match(h.calls.posts[0].text, /already changed this proposal 3 times/);
});

test('the model choosing a person records the head and says so once', async (t) => {
  const h = harness({
    result: { lastResultText: '```json\n{"action":"person","reply":"This changes what the proposal is; a person should decide."}\n```', pushOk: false, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.inserts[0].params[FAILED_INDEX.verdict], 'person');
  assert.equal(h.calls.inserts[0].params[FAILED_INDEX.checksHead], HEAD);
  assert.match(h.calls.posts[0].text, /a person should decide/);
});

test('a revise that moved nothing is a failed turn, with the head recorded', async (t) => {
  const h = harness({ result: { lastResultText: '```json\n{"action":"revise","reply":"Done."}\n```', pushOk: true, sha: OLD_HEAD } });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.inserts[0].params[FAILED_INDEX.verdict], 'failed');
  assert.match(h.calls.inserts[0].params[FAILED_INDEX.error], /^checks: its turn changed nothing/);
  assert.equal(h.calls.inserts[0].params[FAILED_INDEX.checksHead], HEAD);
  assert.equal(h.calls.proposalPosts.length, 0);
  assert.equal(h.calls.posts[0].kind, 'followup_person');
});

test('a platform fault keeps the queue row and does not mark the head', async (t) => {
  const h = harness({ loopError: 'backend_disabled' });
  const out = await run(t, h);
  assert.equal(out.reason, 'infra');
  const insert = h.calls.inserts[0];
  assert.equal(insert.params[FAILED_INDEX.verdict], 'failed');
  assert.equal(insert.params[FAILED_INDEX.checksHead], null, 'the head can still be fixed on a retry');
  const released = h.calls.queries.find((q) => /UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = \$1/.test(q.s));
  assert.deepEqual(released.params, [ITEM.id], 'kept, not deleted');
  assert.ok(!h.calls.queries.some((q) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(q.s) && q.params[0] === ITEM.id));
});

test('the infra guard stops a checks turn that a re-run has changed to a preview failure', async (t) => {
  const h = harness({ checkRow: { ...CHECK_ROW, test_results: manyFailing } });
  const out = await run(t, h);
  assert.deepEqual(out, { ran: false, reason: 'checks_infra' });
  assert.equal(h.calls.exec.length, 0);
  assert.equal(h.calls.inserts.length, 0, 'nothing recorded, so a later verdict is still looked at');
});

test('a person\'s reply comes first, even with checks failing', async (t) => {
  const h = harness({
    comments: [{ author: 'ada', body: 'Can the button be bigger?', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"answer","reply":"It is as big as the screen allows."}\n```', pushOk: false, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer');
  assert.match(h.calls.exec[0].opts.prompt, /Since then, people replied/);
  assert.doesNotMatch(h.calls.exec[0].opts.prompt, /its automated checks failed/);
  assert.equal(h.calls.inserts[0].params[FAILED_INDEX.checksHead], null, 'a reply turn does not mark the checks head');
});

// ── The hook, and the column it reads ────────────────────────────────────

test('every settled verdict reaches the hook, and only a failing one costs a read', () => {
  const visuals = read('src/services/visuals.js');
  const fn = visuals.slice(visuals.indexOf('function noteBotChecksAfterChecks'), visuals.indexOf('// #866: which git ref'));
  assert.match(fn, /if \(state !== 'failing' \|\| !session\?\.id\) return;/);
  assert.match(fn, /bot\.noteProposalChecks\(pool, \{ sessionId: session\.id \}\)/);
  const calls = visuals.match(/noteBotChecksAfterChecks\(/g) || [];
  assert.equal(calls.length, 3, 'the definition and the two settle paths');
  assert.match(visuals, /maybeAutoMergeAfterChecks\(config, getPool\(config\), session, completed\.state\);\s*\n\s*if \(completed\?\.state\) noteBotChecksAfterChecks/);
  assert.match(visuals, /if \(!operation\) noteBotChecksAfterChecks\(pool, session, checksResult\.state\)/);
  assert.match(read('src/services/check-harvest.js'), /visuals\.noteBotChecksAfterChecks\?\.\(pool, session, settled\.result\.state\)/);
});

test('the run carries the head it looked at, and the index that reads it exists', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS checks_head_sha TEXT;/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_homeroom_bot_runs_proposal\s*\n\s*ON homeroom_bot_runs\(proposal_session_id\) WHERE proposal_session_id IS NOT NULL;/);
  assert.match(read('src/services/homeroom-bot.js'), /checks_head_sha = LOWER\(cs\.reviewed_head_sha\)/);
});
