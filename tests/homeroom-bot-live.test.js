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
    getBotUsername: async () => 'usernode-bot',
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
      github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments }; } },
      threadContext: { async loadIssueThread() { return { messages }; } },
      app: APP, repo: REPO, issueNumber: 12, runId: 900, since, postedAt: ['2026-09-25T17:00:05Z'],
    });
    assert.deepEqual(out, { advanced: false, reason: 'someone_replied' },
      'their reply must re-queue the issue, even at the price of one more look');
  }
});

test('its own comment is its own even when the login lookup fails (#3509)', async () => {
  // todo #78: with getBotUsername failing, the bot's held note read as a
  // person's reply, the run's thread_seen_at stayed put, and the next
  // refresh triaged the issue again 3.5 minutes later.
  const since = '2026-09-25T17:00:00Z';
  const updates = [];
  const pool = { async query(sql, params) { updates.push({ sql: String(sql), params }); return { rows: [] }; } };
  const threadContext = { async loadIssueThread() { return { messages: [] }; } };
  const ownOnly = [{ author: 'usernode-bot', createdAt: '2026-09-25T17:00:05Z' }];
  for (const getBotUsername of [async () => { throw new Error('rate limited'); }, async () => null]) {
    updates.length = 0;
    const out = await live.advanceSeen({
      pool, github: { getBotUsername, async fetchIssueComments() { return { comments: ownOnly }; } },
      threadContext, app: APP, repo: REPO, issueNumber: 78, runId: 560, since, postedAt: ['2026-09-25T17:00:05Z'],
    });
    assert.deepEqual(out, { advanced: true, seen: '2026-09-25T17:00:05.000Z' },
      'the comment this run posted is recognised by its own timestamp');
    assert.ok(updates.some((u) => /UPDATE homeroom_bot_runs/.test(u.sql)));
  }
  // A person's reply beside it still counts, with or without the login.
  const out = await live.advanceSeen({
    pool: { async query() { throw new Error('must not record anything'); } },
    github: {
      getBotUsername: async () => null,
      async fetchIssueComments() { return { comments: [...ownOnly, { author: 'alice', createdAt: '2026-09-25T17:00:07Z' }] }; },
    },
    threadContext, app: APP, repo: REPO, issueNumber: 78, runId: 560, since, postedAt: ['2026-09-25T17:00:05Z'],
  });
  assert.deepEqual(out, { advanced: false, reason: 'someone_replied' });
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

// ── Naming the person who filed the issue ──────────────────────────────

function notifyStub({ fails = false } = {}) {
  const calls = { created: [], pushed: [] };
  return {
    calls,
    async createMentionNotifications(_pool, args) {
      if (fails) throw new Error('notifications down');
      calls.created.push(args);
      return [{ id: 31, user_id: 5 }];
    },
    async hydrateAndPush(_pool, row) { calls.pushed.push(row); },
  };
}

test('a post that names the poster: @handle in the thread only, and one mention for them alone', async () => {
  const h = postHarness();
  const notifications = notifyStub();
  const out = await live.post({
    ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'question', runId: 900,
    text: 'Which feed? @alice said the sports one.', mention: 'evan', senderId: 77, notifications,
  });
  assert.deepEqual(out, { postId: 55, githubCreatedAt: '2026-09-25T17:00:05Z', github: true, thread: true });
  assert.equal(h.calls.messages[0].content, '@evan Which feed? @alice said the sports one.', 'named in the thread');
  assert.equal(h.calls.comments[0].body, 'Which feed? @alice said the sports one.',
    'never on GitHub: a platform username there would notify whoever owns it (#723)');
  assert.deepEqual(notifications.calls.created, [{ appId: 9, chatMessageId: 777, senderId: 77, content: '@evan' }],
    'the mention row is for the poster alone, not for every handle the model wrote');
  assert.deepEqual(notifications.calls.pushed, [{ id: 31, user_id: 5 }], 'and it reaches their bell live');
});

test('no poster, no mention; a failed notification keeps the post', async () => {
  const plain = postHarness();
  const untouched = notifyStub();
  await live.post({ ...plain, app: APP, repo: REPO, issueNumber: 12, kind: 'person', text: 'x', notifications: untouched });
  assert.equal(plain.calls.messages[0].content, 'x');
  assert.deepEqual(untouched.calls.created, []);

  const h = postHarness();
  const out = await live.post({
    ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'person', text: 'x',
    mention: 'evan', senderId: 77, notifications: notifyStub({ fails: true }),
  });
  assert.equal(out.thread, true);
  assert.equal(out.github, true);
});

test('issuePoster: the platform\'s issue row, the feedback report, the Source line, then a linked GitHub account; never a bot', async () => {
  const poster = async ({ creators = [], linked = [], body = '', user = null, botLogin = 'usernode-bot' }) => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        if (/FROM issues i JOIN users u ON u\.id = i\.created_by/.test(sql)) return { rows: creators };
        if (/LOWER\(github_login\) = LOWER\(\$1\)/.test(sql)) return { rows: linked };
        return { rows: [] };
      },
    };
    const name = await live.issuePoster(pool, { app: APP, repo: REPO, issueNumber: 24, issue: { body, user }, botLogin });
    return { name, queries };
  };

  const first = await poster({ creators: [{ username: 'maya' }], body: '**Source:** Homeroom admin (evan)\n\nx' });
  assert.equal(first.name, 'maya', 'the platform\'s own record wins over the body');
  assert.match(first.queries[0].sql, /0 AS source_rank[\s\S]*FROM issues i[\s\S]*1 AS source_rank[\s\S]*FROM feedback_reports fr[\s\S]*ORDER BY source_rank/,
    'the issues route\'s order: issue row, then feedback report');
  assert.deepEqual(first.queries[0].params, [9, 24, 'usernode-bot', 'rss-reader']);

  assert.equal((await poster({ body: '**Source:** Homeroom admin (evan)\n\nUse a darker colour.' })).name, 'evan',
    'rss-reader #24: filed from Homeroom, authored on GitHub by the bot');

  const linked = await poster({ body: 'plain', user: 'octocat', linked: [{ username: 'octo' }] });
  assert.equal(linked.name, 'octo', 'opened on GitHub by someone with a linked Homeroom account');
  assert.deepEqual(linked.queries.at(-1).params, ['octocat']);

  assert.equal((await poster({ body: '**Source:** usernode admin\n\nx', user: 'octocat', linked: [{ username: 'octo' }] })).name, 'octo',
    'the legacy bare admin line names nobody');
  for (const user of ['usernode-bot', 'dependabot[bot]', 'Homeroom-Bot']) {
    const r = await poster({ body: 'plain', user, botLogin: 'homeroom-bot', linked: [{ username: 'x' }] });
    assert.equal(r.name, null, `${user} is not a person who filed anything`);
    assert.ok(!r.queries.some((q) => /github_login/.test(q.sql)));
  }
  assert.equal((await poster({ body: 'plain', user: 'stranger' })).name, null, 'no linked account, nobody to notify here');
});

test('the answers tag whoever filed the issue and took part; the notice and a held note tag nobody', async (t) => {
  // Who exactly, and who is left out, is tests/homeroom-bot-mentions.test.js.
  const h = actHarness();
  const realPost = live.post;
  const realTargets = live.mentionTargets;
  t.after(() => { live.post = realPost; live.mentionTargets = realTargets; });
  const lookups = [];
  live.mentionTargets = async (args) => { lookups.push(args); return ['evan', 'maya']; };
  live.post = async (args) => { h.posts.push({ kind: args.kind, mentions: args.mentions, senderId: args.senderId }); return {}; };

  await act(h, { verdict: 'question', question: 'Which colour?' });
  await act(h, { verdict: 'person', reason: 'Taste.' });
  await act(h, { verdict: 'empty', reason: 'Nothing.' });
  assert.deepEqual(h.posts.map((p) => [p.kind, p.mentions, p.senderId]),
    [['question', ['evan', 'maya'], 77], ['person', ['evan', 'maya'], 77], ['empty', ['evan', 'maya'], 77]]);
  assert.equal(lookups.length, 3, 'one lookup per run, read fresh each time');
  assert.equal(lookups[0].issueNumber, 12);
  assert.equal(lookups[0].bot.id, 77, 'so the bot can leave itself out');

  h.posts.length = 0;
  lookups.length = 0;
  await act(h, { verdict: 'question', question: 'x' }, { capSuppressed: 'question_tripwire' });
  assert.deepEqual(h.posts.map((p) => [p.kind, p.mentions]), [['held_question_tripwire', []]]);
  assert.equal(lookups.length, 0, 'a held note looks nobody up');

  for (const kind of ['proposal', 'build_failed', 'spec', 'blocked', 'followup_answer', 'followup_revise']) {
    assert.ok(live.tagsPoster(kind), `${kind} is theirs to know about too`);
  }
  assert.ok(!live.tagsPoster('looking'));
  assert.ok(!live.tagsPoster('held_proposals_per_app'));
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

// ── Proposing on an app it is not part of (rss-reader #24) ─────────────

// The real guards the votes router runs before Propose, over one session
// row. rss-reader is collab-private and the bot is neither a collaborator
// nor a member: its #24 build (session 5119) was refused "Session not found"
// by the collaborator guard. A public-collab app would have refused it
// join_required at the membership gate instead.
function guardedRouter({ app, sessionUserId }) {
  const appAccess = require('../src/services/app-access');
  const communities = require('../src/services/communities');
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      if (/FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id/.test(text)) {
        return { rows: [{ ...app, is_member: false }] };
      }
      if (/^SELECT user_id FROM chat_sessions WHERE id = \$1$/.test(text)) {
        owners.push(params[0]);
        return { rows: [{ user_id: sessionUserId }] };
      }
      if (/FROM app_collaborators/.test(text)) return { rows: [] };
      if (/FROM user_app_blocks/.test(text)) return { rows: [] };
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
  const reached = [];
  const owners = [];
  const router = express.Router();
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));
  router.post('/api/sessions/:id/promote', communities.requireSessionMembership(pool), (req, res) => {
    reached.push(req.user.id);
    res.json({ ok: true, prNumber: 7 });
  });
  return { router, reached, owners };
}
const PRIVATE_COLLAB = { id: 9, slug: 'rss-reader-4113da', name: 'RSS reader', community_id: 48, collab_visibility: 'private', view_visibility: 'public' };
const PUBLIC_COLLAB = { ...PRIVATE_COLLAB, collab_visibility: 'public' };

test('the bot proposes its own build on an app it is not a collaborator or member of', async () => {
  for (const app of [PRIVATE_COLLAB, PUBLIC_COLLAB]) {
    const { router, reached } = guardedRouter({ app, sessionUserId: BOT.id });
    const out = await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 5119, router });
    assert.deepEqual(out, { status: 200, body: { ok: true, prNumber: 7 } }, `${app.collab_visibility} collab`);
    assert.deepEqual(reached, [77]);
  }
});

test('the exception is the bot\'s own session only, and only its in-process promote', async () => {
  // Somebody else's change: the walls stand, even for the bot.
  const other = guardedRouter({ app: PRIVATE_COLLAB, sessionUserId: 5 });
  assert.deepEqual(await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 5120, router: other.router }),
    { status: 404, body: { error: 'Session not found' } });
  assert.deepEqual(other.reached, []);

  // The same user without the marker, as an HTTP request would be.
  const appAccess = require('../src/services/app-access');
  const plain = { id: BOT.id, username: BOT.username, is_synthetic: true, HOMEROOM_BOT_PROPOSAL: true };
  assert.equal(appAccess.isBotOwnProposal(plain, BOT.id), false, 'a string key is not the marker');
  const marked = { id: BOT.id, [appAccess.HOMEROOM_BOT_PROPOSAL]: true };
  assert.equal(appAccess.isBotOwnProposal(marked, BOT.id), true);
  assert.equal(appAccess.isBotOwnProposal(marked, 5), false, 'not someone else\'s session');
  assert.equal(appAccess.isBotOwnProposal(marked, null), false);
  assert.equal(appAccess.isBotOwnProposal(null, BOT.id), false);

  // Through the real guards without the marker: refused as before.
  const { router } = guardedRouter({ app: PRIVATE_COLLAB, sessionUserId: BOT.id });
  const refused = await new Promise((resolve) => {
    const url = '/api/sessions/5119/promote';
    const req = { method: 'POST', url, originalUrl: url, baseUrl: '', path: url, headers: {}, query: {}, params: {}, body: {},
      user: plain, get() {}, header() {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      set() { return this; }, setHeader() {}, getHeader() {} };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
  assert.deepEqual(refused, { status: 404, body: { error: 'Session not found' } });

  // An unmarked request never pays for the exception: the guards' own
  // queries are unchanged (a golden transcript pins them) and the owner is
  // never looked up.
  const quiet = guardedRouter({ app: PUBLIC_COLLAB, sessionUserId: 5 });
  await new Promise((resolve) => {
    const url = '/api/sessions/5120/promote';
    const req = { method: 'POST', url, originalUrl: url, baseUrl: '', path: url, headers: {}, query: {}, params: {}, body: {},
      user: { id: 5, username: 'maya' }, get() {}, header() {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve(b); return this; },
      set() { return this; }, setHeader() {}, getHeader() {} };
    quiet.router.handle(req, res, () => resolve(null));
  });
  assert.deepEqual(quiet.owners, [], 'no owner lookup for an ordinary request');
  assert.match(read('src/services/app-access.js'),
    /`SELECT a\.id, a\.collab_visibility, a\.view_visibility, a\.moderation_suspended_at\n\s+FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id\n\s+WHERE cs\.id = \$1`/);

  // Never an admin: the marker is the whole exception.
  const src = read('src/services/homeroom-bot-live.js');
  assert.match(src, /id: bot\.id, username: bot\.username, is_admin: false, is_synthetic: true,\n\s*\[require\('\.\/app-access'\)\.HOMEROOM_BOT_PROPOSAL\]: true,/);
  assert.doesNotMatch(src, /isAdmin: true/);
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

// The spec turn comes first (mode 'scout', see tests/homeroom-bot-spec.test.js);
// `loop` and `exec` are the BUILD turn's.
function buildHarness({ result = { pushOk: true, ahead: 1, sha: 'a'.repeat(40) }, promote = { status: 200, body: { ok: true, prNumber: 42 } }, hang = false, spec = '' } = {}) {
  const calls = { queries: [], ensured: [], loop: null, exec: null, stopped: [], promoted: [], modes: [] };
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
      async execInWorker(id, opts) {
        calls.modes.push(opts.mode);
        if (opts.mode === 'scout') return { lastResultText: spec };
        calls.exec = { id, opts };
        if (hang && opts.onProgress) {
          for (const line of ['Reading public/app.js', 'Running: npm test', 'Running: npm test',
            'Waiting on a command for 540s: npm start', 'Waiting on a command for 600s: npm start']) opts.onProgress(line);
        }
        return result;
      },
      stopTurn(id) { calls.stopped.push(id); release(); return Promise.resolve(); },
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        const r = await args.dispatchOnce({ openrouterApiKey: 'k' });
        if (args.mode === 'scout') return { result: r, error: null, estimatedCostUsd: null };
        calls.loop = args;
        if (hang) await hung;
        return { result: r, error: null, estimatedCostUsd: 0.05 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
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
  assert.deepEqual(out, {
    ok: true, sessionId: 5001, prNumber: 42, branchName: 'homeroom_bot/s5001', sha: 'a'.repeat(40), commits: 1,
    costUsd: 0.05,
    specNote: 'no spec (the spec turn returned nothing); the build worked from the plan',
  }, 'this harness writes no spec, and the result says so');

  const insert = h.calls.queries.find((q) => /INSERT INTO chat_sessions/.test(q.sql));
  assert.match(insert.sql, /ELSE ARRAY\[\$3::int\] END, TRUE/, 'the issue is linked, so the PR says Closes #12');
  assert.equal(insert.params[2], 12, 'a proposing build links its issue');
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
  assert.deepEqual(h.calls.modes, ['scout', 'build'], 'a spec first; with none written, the build goes ahead from the plan');
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
  // #3385: what it was waiting on, the last three distinct progress lines.
  assert.equal(out.error, 'the build ran past its time limit; last activity: Running: npm test | '
    + 'Waiting on a command for 540s: npm start | Waiting on a command for 600s: npm start');
  assert.deepEqual(h.calls.promoted, [], 'a stopped build is never proposed');
});

// ── What each verdict does ───────────────────────────────────────────────

function actHarness() {
  const posts = [];
  const queries = [];
  const pool = { async query(sql, params) { queries.push({ sql: String(sql), params }); return { rows: [] }; } };
  const deps = {
    github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
    ws: {},
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    limits: { spend: [], async recordSpend(_p, id, cents) { this.spend.push(cents); } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
    domain: 'app.onhomeroom.com',
  };
  return { pool, deps, posts, queries };
}

async function act(h, parsed, { capSuppressed = null, quietHold = false } = {}) {
  return bot.actOnVerdict({
    pool: h.pool, config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12, issue: { title: 'x' },
    parsed, capSuppressed, runId: 900, seed: 'seed', seedReadAt: '2026-09-25T17:00:00Z', postedAt: [],
    turnBudgetMs: 1000, model: 'm', quietHold, deps: h.deps,
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

  live.buildAndPropose = async (args) => {
    await args.onSession({ id: 5001 });
    return { ok: true, sessionId: 5001, prNumber: 42, costUsd: 0.25 };
  };
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }), 'proposed');
  assert.ok(h.queries.some((q) => /SET build_session_id = \$2 WHERE id = \$1/.test(q.sql) && q.params[0] === 900 && q.params[1] === 5001),
    'the live run is linked to its build session as soon as it exists, so a restart can find it (#3471)');
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

test('a backlog pass holds silently, and still speaks when it has something to say (#3509)', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  t.after(() => { live.post = realPost; });
  live.post = async (args) => { h.posts.push({ kind: args.kind }); return { githubCreatedAt: '2026-09-25T17:00:05Z' }; };
  const quiet = { quietHold: true };
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }, { ...quiet, capSuppressed: 'proposals_per_app' }), 'held');
  assert.equal(await act(h, { verdict: 'question', question: 'q' }, { ...quiet, capSuppressed: 'question_tripwire' }), 'held');
  assert.deepEqual(h.posts, [], 'held is still the verdict, and the cap_freed refresh brings it back; no note');
  assert.equal(await act(h, { verdict: 'question', question: 'Which feed?' }, quiet), 'question');
  assert.deepEqual(h.posts.map((p) => p.kind), ['question'], 'a verdict that is not held is said as ever');
  // Anything else held still says so once.
  await act(h, { verdict: 'ready', buildNote: 'x' }, { capSuppressed: 'proposals_per_app' });
  assert.deepEqual(h.posts.map((p) => p.kind), ['question', 'held_proposals_per_app']);
});

test('a "Triage this app again" item is triaged without the "looking" post, and held quietly', () => {
  assert.equal(bot.APP_AGAIN_REASON, 'app_again');
  assert.match(BOT_SRC, /SELECT \$1, q\.n, 0, 'app_again', \$4/, 'retriageApp queues with that reason');
  assert.match(BOT_SRC, /const looked = item\.reason === RESTART_REASON \|\| item\.reason === APP_AGAIN_REASON \? null : await live\.post\(/);
  assert.match(BOT_SRC, /quietHold: item\.reason === APP_AGAIN_REASON,/);
  // The refresh keeps a priority-0 row's reason, so a comment before the
  // row runs does not turn it back into a "looking" one mid-pass.
  assert.match(BOT_SRC, /reason = CASE WHEN homeroom_bot_queue\.priority = 0\s+THEN homeroom_bot_queue\.reason ELSE EXCLUDED\.reason END/);
});

test('a live build\'s outcome is recorded on its run, in the shadow build\'s columns (#3509)', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; });
  live.post = async (args) => { h.posts.push({ kind: args.kind }); return { githubCreatedAt: '2026-09-25T17:00:05Z' }; };
  const recorded = () => {
    const u = h.queries.filter((q) => /SET build_ok = \$2, build_error = \$3/.test(q.sql)).at(-1);
    return u && u.params;
  };

  live.buildAndPropose = async () => ({
    ok: true, sessionId: 5001, prNumber: 42, branchName: 'homeroom_bot/s5001', sha: 'b'.repeat(40), commits: 2,
    costUsd: 0.3, specNote: 'no spec (the spec ran past its time limit); the build worked from the plan',
  });
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }), 'proposed');
  assert.deepEqual(recorded(), [900, true, 'no spec (the spec ran past its time limit); the build worked from the plan',
    'homeroom_bot/s5001', 'b'.repeat(40), 2, 0.3, 5001, null], 'a proposal built without a spec says why');

  live.buildAndPropose = async () => ({ ok: false, sessionId: 5002, error: 'the build ran past its time limit', costUsd: 0.2 });
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }), 'build_failed');
  assert.deepEqual(recorded().slice(0, 3), [900, false, 'the build ran past its time limit']);

  live.buildAndPropose = async () => ({
    ok: false, sessionId: 5003, blocked: 'the app has no image generation', error: 'the spec found it impossible', costUsd: 0.1,
  });
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }), 'blocked');
  assert.deepEqual(recorded().slice(0, 3), [900, false, 'blocked: the app has no image generation'],
    'blocked and failed are told apart');

  // Recorded before anything is said: a post that throws cannot lose it.
  const src = BOT_SRC.slice(BOT_SRC.indexOf('async function announceBuilt'));
  assert.match(src.slice(0, 200), /\{\n  await recordLiveBuild\(pool, runId, built\);/);
  // Never the lane's markers: build_at is how the lane and its restart
  // recovery (runOfSession) tell a build of theirs under way.
  const rec = BOT_SRC.slice(BOT_SRC.indexOf('async function recordLiveBuild'));
  assert.doesNotMatch(rec.slice(0, rec.indexOf('\n}\n')), /build_at|build_queued_at/);
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
  // Two build calls: actOnVerdict's, and the shadow build's, which never
  // proposes and never posts (shadow builds leave a branch and nothing else).
  assert.equal((BOT_SRC.match(/buildAndPropose\(/g) || []).length, 2, 'actOnVerdict, and the shadow build');
  const shadow = BOT_SRC.slice(BOT_SRC.indexOf('async function shadowBuild('), BOT_SRC.indexOf('/**', BOT_SRC.indexOf('async function shadowBuild(')));
  assert.match(shadow, /propose: false,?\s*\}\);/);
  assert.doesNotMatch(shadow, /live\.post\(|promoteAsBot|advanceSeen/, 'a shadow build says nothing anywhere');
  assert.match(BOT_SRC, /\} else if \(parsed\.verdict === 'ready' && shadowBuildsApply\(settings, app, config\)\) \{/,
    'and it is queued only where the live branch does not run');
  assert.equal(bot.shadowBuildSkipReason({ mode: 'shadow', liveApps: ['todo'], shadowBuilds: true }, { slug: 'todo' }),
    'the app is live now', 'a live app is never also shadow built');
  assert.match(BOT_SRC, /const liveMode = live\.isLiveFor\(settings, app\);/);
  assert.match(BOT_SRC, /if \(liveMode\) \{\n\s+const open = await live\.openBotProposal/);
  assert.match(BOT_SRC, /if \(liveMode\) \{\n\s+try \{\n\s+acted = await actOnVerdict\(/);
});

test('the dashboard says what a live build came to, and never calls it a shadow build (#3509)', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /\{run\.mode === 'live' \? <LiveBuild run=\{run\} \/> : <ShadowBuild run=\{run\} \/>\}/);
  const fn = tsx.slice(tsx.indexOf('function LiveBuild('), tsx.indexOf('/** A question\'s "user_facing: why" as words. */'));
  assert.match(fn, /data-live-build=\{why\.startsWith\('blocked: '\) \? 'blocked' : 'failed'\}/);
  assert.match(fn, /Live build did not become a proposal: \$\{why\}\./);
  assert.match(fn, /data-live-build="built"/);
  assert.doesNotMatch(fn, /Shadow|href=/, 'the proposal link below the note is the one link');
});
