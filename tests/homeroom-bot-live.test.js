// #3146: the Homeroom bot, live on the apps in `homeroom_bot_live_apps`.
//
// What matters most here is the loop the bot must never start: a post is
// issue activity, and issue activity re-queues the issue. Those tests come
// first. Then posting, proposing through the one real /promote handler,
// and the build.
//
// Run with: node --test tests/homeroom-bot-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const LIVE_SRC = read('src/services/homeroom-bot-live.js');
const BOT_SRC = read('src/services/homeroom-bot.js');

const APP = { id: 9, slug: 'rss-reader-4113da', name: 'RSS reader', repo_url: 'https://github.com/usernode-bot/rss-reader' };
const REPO = { owner: 'usernode-bot', repo: 'rss-reader' };
const BOT = { id: 77, username: 'homeroom_bot' };

// ── The loop it must never start ─────────────────────────────────────────

test('its own GitHub comment does not re-queue the issue it answered', async () => {
  // The run started reading at 17:00:00 and commented at 17:00:05. GitHub
  // moves the issue's updated_at to the comment's time; the run records the
  // comment's own created_at as seen, so the next refresh finds nothing new.
  const updates = [];
  const pool = { async query(sql, params) { updates.push({ sql: String(sql), params }); return { rows: [] }; } };
  const github = {
    getBotUsername: () => 'usernode-bot',
    async fetchIssueComments() {
      return { comments: [
        { author: 'alice', createdAt: '2026-09-25T16:59:00Z' }, // before the run: already read
        { author: 'usernode-bot', createdAt: '2026-09-25T17:00:05Z' }, // the bot's own
      ] };
    },
  };
  const threadContext = { async loadIssueThread() { return { messages: [] }; } };
  const out = await live.advanceSeen({
    pool, github, threadContext, app: APP, repo: REPO, issueNumber: 12, runId: 900,
    since: '2026-09-25T17:00:00Z', postedAt: ['2026-09-25T17:00:05Z'],
  });
  assert.deepEqual(out, { advanced: true, seen: '2026-09-25T17:00:05.000Z' });
  const update = updates.find((u) => /UPDATE homeroom_bot_runs/.test(u.sql));
  assert.deepEqual(update.params, [900, '2026-09-25T17:00:05.000Z']);
  assert.match(update.sql, /GREATEST\(/, 'never moves what it has seen backwards');

  // And with that recorded, the queue's own rule calls the issue unchanged.
  const verdict = bot.classifyIssue({
    issue: { number: 12, state: 'open', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-25T17:00:05Z' },
    lastRun: { thread_seen_at: out.seen },
  });
  assert.equal(verdict.reason, 'unchanged');
});

test('a person who replied while it worked still gets looked at again', async () => {
  const pool = { async query() { throw new Error('must not record anything'); } };
  const since = '2026-09-25T17:00:00Z';
  const cases = [
    { comments: [{ author: 'alice', createdAt: '2026-09-25T17:00:03Z' }], messages: [] },
    { comments: [], messages: [{ author: 'bob', createdAt: '2026-09-25T17:00:03Z' }] },
  ];
  for (const { comments, messages } of cases) {
    const out = await live.advanceSeen({
      pool,
      github: { getBotUsername: () => 'usernode-bot', async fetchIssueComments() { return { comments }; } },
      threadContext: { async loadIssueThread() { return { messages }; } },
      app: APP, repo: REPO, issueNumber: 12, runId: 900, since, postedAt: ['2026-09-25T17:00:05Z'],
    });
    assert.deepEqual(out, { advanced: false, reason: 'someone_replied' },
      'their reply must re-queue the issue, even at the price of one more look');
  }
});

test('its Homeroom posts are system messages, which the queue never counts as activity', () => {
  assert.match(LIVE_SRC, /msgType = 'system'/, 'posts default to system messages');
  const activity = BOT_SRC.slice(BOT_SRC.indexOf('async function threadActivityByIssue'));
  assert.match(activity.slice(0, 600), /msg_type = 'message'/,
    'the thread-activity query reads people\'s messages only');
  // The proposal card is a 'vote' row: also not 'message'.
  assert.match(BOT_SRC, /msgType: 'vote', metadata: \{ vote: \{ sessionId: built\.sessionId, prNumber: built\.prNumber \} \}/);
});

// ── Where it is live ─────────────────────────────────────────────────────

test('it is live only on a listed app, with the mode on, and never on a staging copy', (t) => {
  const on = { mode: 'shadow', liveApps: [APP.slug] };
  assert.equal(live.isLiveFor(on, APP), true);
  assert.equal(live.isLiveFor({ ...on, mode: 'off' }, APP), false, 'off means off');
  assert.equal(live.isLiveFor({ mode: 'shadow', liveApps: ['other'] }, APP), false, 'only the listed apps');
  assert.equal(live.isLiveFor(null, APP), false);
  const prior = process.env.USERNODE_ENV;
  t.after(() => { if (prior === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prior; });
  process.env.USERNODE_ENV = 'staging';
  assert.equal(live.isLiveFor(on, APP), false,
    'a staging copy starts from production\'s settings and must never post on real issues');
});

test('the live list is a validated setting that ships empty', () => {
  assert.deepEqual(bot.parseSettings([]).liveApps, []);
  assert.deepEqual(bot.parseSettings([{ key: bot.KEY_LIVE_APPS, value: '["rss-reader-4113da", 3]' }]).liveApps, ['rss-reader-4113da']);
  assert.equal(bot.validateSettingsPatch({ liveApps: ['Not A Slug'] }).ok, false);
  assert.equal(bot.validateSettingsPatch({ liveApps: 'rss-reader-4113da' }).ok, false);
  const ok = bot.validateSettingsPatch({ liveApps: ['rss-reader-4113da', 'rss-reader-4113da'] });
  assert.deepEqual(ok.updates, [[bot.KEY_LIVE_APPS, '["rss-reader-4113da"]']], 'deduplicated');
  assert.equal(bot.validateSettingsPatch({ mode: 'live' }).ok, false, 'the global switch still refuses live');
  assert.match(read('src/db/schema.sql'), /\('homeroom_bot_live_apps', '\[\]'\)/);
});

// ── Posting ──────────────────────────────────────────────────────────────

function postHarness({ claimed = true, githubFails = false } = {}) {
  const calls = { queries: [], comments: [], messages: [] };
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql: String(sql), params });
      if (/INSERT INTO homeroom_bot_posts/.test(sql)) return { rows: claimed ? [{ id: 55 }] : [] };
      return { rows: [] };
    },
  };
  const github = {
    async createIssueComment(owner, repo, n, body) {
      if (githubFails) throw new Error('GitHub is down');
      calls.comments.push({ owner, repo, n, body });
      return { id: 1234, created_at: '2026-09-25T17:00:05Z' };
    },
  };
  const ws = {
    async sendSystemMessage(pool_, appId, content, msgType, metadata, thread) {
      calls.messages.push({ appId, content, msgType, metadata, thread });
      return { id: 777 };
    },
  };
  return { pool, github, ws, calls };
}

test('a post goes to both surfaces, scoped to the issue, and is recorded', async () => {
  const h = postHarness();
  const out = await live.post({ ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'question', runId: 900, text: 'Which feed?' });
  assert.deepEqual(out, { postId: 55, githubCreatedAt: '2026-09-25T17:00:05Z', github: true, thread: true });
  assert.deepEqual(h.calls.comments, [{ owner: 'usernode-bot', repo: 'rss-reader', n: 12, body: 'Which feed?' }]);
  assert.deepEqual(h.calls.messages[0].thread, { type: 'issue', ref: 12 });
  assert.equal(h.calls.messages[0].msgType, 'system');
  const insert = h.calls.queries[0];
  assert.match(insert.sql, /ON CONFLICT \(app_id, issue_number\) WHERE kind = 'looking' DO NOTHING/,
    'the row is written first: for "looking" the insert is the claim');
  assert.ok(h.calls.queries.some((q) => /UPDATE homeroom_bot_posts SET github_comment_id/.test(q.sql) && q.params[1] === 1234 && q.params[2] === 777));
});

test('"looking" is posted once per issue: a second claim sends nothing', async () => {
  const h = postHarness({ claimed: false });
  const out = await live.post({ ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'looking', text: live.lookingText() });
  assert.equal(out, null);
  assert.deepEqual(h.calls.comments, []);
  assert.deepEqual(h.calls.messages, []);
  assert.match(read('src/db/schema.sql'),
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_homeroom_bot_posts_looking\s+ON homeroom_bot_posts\(app_id, issue_number\) WHERE kind = 'looking';/);
});

test('a GitHub failure still posts in Homeroom, and never throws', async () => {
  const h = postHarness({ githubFails: true });
  const out = await live.post({ ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'person', text: 'x' });
  assert.equal(out.github, false);
  assert.equal(out.thread, true);
  assert.equal(out.githubCreatedAt, null, 'nothing to mark as seen');
});

test('what it says: the question with its default, notes that never close, a linked proposal', () => {
  const q = live.questionText({ question: 'Which feed should it refresh?', questionDefault: 'All of them' });
  assert.match(q, /Which feed should it refresh\?/);
  assert.match(q, /If nobody answers, it would go with: All of them/);
  assert.match(q, /Reply here \(or on the GitHub issue\) and it will look again\./);
  assert.match(live.personText({ reason: 'It changes who can see feeds.' }), /a person needs to decide this one: It changes who can see feeds\./);
  const empty = live.emptyText({ reason: 'The body is a placeholder.' });
  assert.match(empty, /couldn't find anything to build/);
  assert.ok(!/close/i.test(empty), 'it never closes, or offers to close, an issue');
  const link = live.proposalLink('app.onhomeroom.com', APP.slug, 5001);
  assert.equal(link, 'https://app.onhomeroom.com/#app/rss-reader-4113da/dev/proposals/5001');
  assert.match(live.proposalText({ link, prNumber: 42 }), /opened a proposal for the group to vote on \(PR #42\): https:\/\/app\.onhomeroom\.com/);
  assert.ok(live.questionText({ question: 'x'.repeat(5000) }).length < 2000, 'model text is clipped');
});

// ── Proposing through the one real handler ───────────────────────────────

test('promoteAsBot dispatches into the router as the bot and returns what the route answered', async () => {
  const seen = [];
  const router = express.Router();
  router.use('/api/sessions/:id', (req, res, next) => { seen.push(['guard', req.params.id]); next(); });
  router.post('/api/sessions/:id/promote', (req, res) => {
    seen.push(['promote', req.params.id, req.user.id]);
    if (req.params.id === '9') return res.status(409).json({ error: 'session_state_changed' });
    return res.json({ ok: true, prNumber: 42 });
  });
  const ok = await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 5001, router });
  assert.deepEqual(ok, { status: 200, body: { ok: true, prNumber: 42 } });
  assert.deepEqual(seen.slice(0, 2), [['guard', '5001'], ['promote', '5001', 77]], 'guards run first, as the bot');
  assert.deepEqual(await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 9, router }),
    { status: 409, body: { error: 'session_state_changed' } });
  const empty = express.Router();
  assert.equal((await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 1, router: empty })).status, 404);
});

test('the route it dispatches into is the real Propose handler, and the bot must own the session', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /router\.post\('\/api\/sessions\/:id\/promote', drainGuard,/);
  assert.match(votes, /WHERE cs\.id = \$1 AND cs\.user_id = \$2 AND cs\.status IN \('active', 'paused'\)/,
    'only the session\'s owner can propose it, so the bot proposes only what it built');
  assert.match(LIVE_SRC, /require\('\.\.\/routes\/votes'\)\.voteRoutes\(config\)/);
  assert.ok(!/UPDATE chat_sessions\s+SET status = 'promoted'/.test(LIVE_SRC), 'it never promotes by hand');
});

test('an issue with an open bot proposal is left alone', () => {
  const q = LIVE_SRC.slice(LIVE_SRC.indexOf('async function openBotProposal'));
  assert.match(q.slice(0, 600), /user_id = \$2 AND \$3 = ANY\(linked_issues\)\s+AND status IN \('promoted', 'merging'\)/);
});

// ── The build ────────────────────────────────────────────────────────────

function buildHarness({ result = { pushOk: true, ahead: 1, sha: 'a'.repeat(40) }, promote = { status: 200, body: { ok: true, prNumber: 42 } }, hang = false } = {}) {
  const calls = { queries: [], ensured: [], loop: null, exec: null, stopped: [], promoted: [] };
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql: String(sql), params });
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 5001, app_id: APP.id, user_id: BOT.id }] };
      return { rows: [] };
    },
  };
  let release;
  const hung = new Promise((r) => { release = r; });
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => {
    calls.promoted.push({ id: req.params.id, user: req.user.id });
    res.status(promote.status).json(promote.body);
  });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.ensured.push({ id, opts }); return 'usernode-worker-5001'; },
      async execInWorker(id, opts) { calls.exec = { id, opts }; return result; },
      stopTurn(id) { calls.stopped.push(id); release(); return Promise.resolve(); },
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        calls.loop = args;
        const r = await args.dispatchOnce({ openrouterApiKey: 'k' });
        if (hang) await hung;
        return { result: r, error: null, estimatedCostUsd: 0.05 };
      },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `homeroom_bot/s${sessionId}` }; } },
    activeWorkers: new Set(),
    votesRouter: router,
  };
  return { pool, deps, calls };
}

const BUILD_ARGS = {
  config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12,
  issue: { title: 'Refresh feeds every hour' }, seed: 'Please work on GitHub issue #12.',
  buildNote: 'Add an hourly refresh to the feed poller.', turnBudgetMs: 20 * 60 * 1000, model: 'z-ai/glm-5.3-flash',
};

test('a ready request is built in a session of its own and proposed', async () => {
  const h = buildHarness();
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS });
  assert.deepEqual(out, { ok: true, sessionId: 5001, prNumber: 42, costUsd: 0.05 });

  const insert = h.calls.queries.find((q) => /INSERT INTO chat_sessions/.test(q.sql));
  assert.match(insert.sql, /ARRAY\[\$3\]::int\[\], TRUE/, 'the issue is linked, so the PR says Closes #12');
  assert.match(insert.sql, /'active', FALSE/, 'a normal dev session, never a headless one');
  assert.equal(insert.params[1], BOT.id, 'owned by the bot');

  assert.equal(h.calls.ensured[0].opts.temporary, true, 'scratch storage, like its triage workers');
  assert.equal(h.calls.ensured[0].opts.branchName, 'homeroom_bot/s5001');
  assert.equal(h.calls.loop.mode, 'build');
  assert.equal(h.calls.loop.telemetryComponent, 'homeroom_bot_build');
  assert.equal(h.calls.loop.resumeThreadId, null);
  assert.equal(h.calls.exec.opts.mode, 'build');
  assert.match(h.calls.exec.opts.prompt, /Add an hourly refresh to the feed poller\./);
  assert.match(h.calls.exec.opts.prompt, /Do not commit or push yourself/);
  assert.deepEqual(h.calls.promoted, [{ id: '5001', user: BOT.id }], 'proposed once, as the bot');
  assert.ok(!h.calls.queries.some((q) => /status = 'archived'/.test(q.sql)));
});

test('a build that changed nothing is not proposed, and its session is archived', async () => {
  const h = buildHarness({ result: { pushOk: true, ahead: 0 } });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS });
  assert.equal(out.ok, false);
  assert.match(out.error, /produced no change/);
  assert.deepEqual(h.calls.promoted, []);
  assert.ok(h.calls.queries.some((q) => /SET status = 'archived'/.test(q.sql)));
});

test('a refused promotion is reported with the route\'s own words, and the built work is kept', async () => {
  const h = buildHarness({ promote: { status: 404, body: { error: 'Session not found' } } });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS });
  assert.equal(out.ok, false);
  assert.match(out.error, /built but could not be proposed: Session not found/);
  assert.ok(!h.calls.queries.some((q) => /SET status = 'archived'/.test(q.sql)),
    'left paused, so a person can open the session and propose it');
});

test('a build is held to the same wall clock as a triage turn', async (t) => {
  const h = buildHarness({ hang: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS });
  for (let i = 0; i < 200 && !h.calls.stopped.length; i += 1) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(20 * 60 * 1000);
  }
  const out = await running;
  assert.deepEqual(h.calls.stopped, [5001]);
  assert.match(out.error, /ran past its time limit/);
  assert.deepEqual(h.calls.promoted, [], 'a stopped build is never proposed');
});

// ── What each verdict does ───────────────────────────────────────────────

function actHarness() {
  const posts = [];
  const queries = [];
  const pool = { async query(sql, params) { queries.push({ sql: String(sql), params }); return { rows: [] }; } };
  const deps = {
    github: { getBotUsername: () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
    ws: {},
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    limits: { spend: [], async recordSpend(_p, id, cents) { this.spend.push(cents); } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
    domain: 'app.onhomeroom.com',
  };
  return { pool, deps, posts, queries };
}

async function act(h, parsed, { capSuppressed = null } = {}) {
  return bot.actOnVerdict({
    pool: h.pool, config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12, issue: { title: 'x' },
    parsed, capSuppressed, runId: 900, seed: 'seed', seedReadAt: '2026-09-25T17:00:00Z', postedAt: [],
    turnBudgetMs: 1000, model: 'm', deps: h.deps,
  });
}

test('each verdict says its own thing; a verdict held by a cap says only that it is held', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; });
  live.post = async (args) => { h.posts.push({ kind: args.kind, text: args.text, msgType: args.msgType, metadata: args.metadata }); return { githubCreatedAt: '2026-09-25T17:00:05Z' }; };

  assert.equal(await act(h, { verdict: 'question', question: 'Which feed?' }), 'question');
  assert.equal(await act(h, { verdict: 'person', reason: 'Billing.' }), 'person');
  assert.equal(await act(h, { verdict: 'empty', reason: 'Placeholder.' }), 'empty');
  assert.deepEqual(h.posts.map((p) => p.kind), ['question', 'person', 'empty']);

  h.posts.length = 0;
  assert.equal(await act(h, { verdict: 'question', question: 'Which feed?' }, { capSuppressed: 'question_tripwire' }), 'held');
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }, { capSuppressed: 'proposals_per_app' }), 'held');
  assert.deepEqual(h.posts.map((p) => p.kind), ['held_question_tripwire', 'held_proposals_per_app'],
    'the caps hold the question and the build, and say so in one line (#3152)');
  assert.ok(!/Which feed/.test(h.posts[0].text), 'the held question itself is not posted');
  assert.match(h.posts[1].text, /would build this, but it already has 2 proposals open on this app/);
  assert.match(h.posts[1].text, /come back to this issue when one of them is merged or closed/);

  live.buildAndPropose = async () => ({ ok: true, sessionId: 5001, prNumber: 42, costUsd: 0.25 });
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }), 'proposed');
  const card = h.posts.find((p) => p.kind === 'proposal');
  assert.equal(card.msgType, 'vote', 'the thread gets the live vote card');
  assert.deepEqual(card.metadata, { vote: { sessionId: 5001, prNumber: 42 } });
  assert.match(card.text, /https:\/\/app\.onhomeroom\.com\/#app\/rss-reader-4113da\/dev\/proposals\/5001/);
  assert.ok(h.queries.some((q) => /SET proposal_session_id = \$2/.test(q.sql) && q.params[1] === 5001));
  assert.deepEqual(h.deps.limits.spend, [25], 'the build is paid for from the bot\'s weekly allowance');

  live.buildAndPropose = async () => ({ ok: false, sessionId: 5002, error: 'the build produced no change to propose', costUsd: 0 });
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }), 'build_failed');
  assert.match(h.posts.at(-1).text, /tried to build this but couldn't finish: the build produced no change to propose/);
});


test('a held issue is told once, not again on every retry that is held again (#3152)', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  t.after(() => { live.post = realPost; });
  live.post = async (args) => { h.posts.push({ kind: args.kind }); return { githubCreatedAt: '2026-09-25T17:00:05Z' }; };
  let newest = null;
  h.pool.query = async (sql) => {
    if (/FROM homeroom_bot_posts/.test(String(sql))) return { rows: newest ? [{ kind: newest }] : [] };
    return { rows: [] };
  };
  const held = { capSuppressed: 'proposals_per_app' };
  await act(h, { verdict: 'ready', buildNote: 'x' }, held);
  newest = 'held_proposals_per_app';
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }, held), 'held');
  assert.deepEqual(h.posts.map((p) => p.kind), ['held_proposals_per_app'], 'the second hold says nothing new');
  // Held for a different reason than the newest post: that is news.
  await act(h, { verdict: 'question', question: 'q' }, { capSuppressed: 'question_tripwire' });
  assert.deepEqual(h.posts.map((p) => p.kind), ['held_proposals_per_app', 'held_question_tripwire']);
});

test('the held lines name the limit and never promise more than the refresh does', () => {
  assert.match(live.heldText({ cap: 'proposals_per_app', verdict: 'ready', limit: 2 }), /already has 2 proposals open on this app/);
  const q = live.heldText({ cap: 'question_tripwire', verdict: 'question', limit: 10 });
  assert.match(q, /has a question about this request, but it has already posted 10 questions and notes on this app in the last day/);
  assert.match(live.heldText({ cap: 'question_tripwire', verdict: 'empty', limit: 10 }), /has a note on this request/);
  for (const text of [q, live.heldText({ cap: 'proposals_per_app', limit: 2 })]) assert.ok(!/\u2014/.test(text));
});
test('runTriage acts only through the live module, and only when the app is live', () => {
  // Shadow mode stays structurally silent: none of the posting or proposing
  // calls appear in homeroom-bot.js at all, and every call into the live
  // module sits behind liveMode.
  for (const forbidden of ['createIssueComment', 'sendSystemMessage', '/promote']) {
    assert.ok(!BOT_SRC.includes(forbidden), `homeroom-bot.js never reaches ${forbidden} itself`);
  }
  assert.equal((BOT_SRC.match(/buildAndPropose\(/g) || []).length, 1, 'one build call, inside actOnVerdict');
  assert.match(BOT_SRC, /const liveMode = live\.isLiveFor\(settings, app\);/);
  assert.match(BOT_SRC, /if \(liveMode\) \{\n\s+const open = await live\.openBotProposal/);
  assert.match(BOT_SRC, /if \(liveMode\) \{\n\s+try \{\n\s+acted = await actOnVerdict\(/);
});
