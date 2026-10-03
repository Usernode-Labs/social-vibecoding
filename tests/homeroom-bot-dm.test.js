'use strict';

// #3624: the Homeroom bot in a DM, without a database.
//
// The contract pieces: a triage question and a follow-up ask carry their
// suggested answers (the default first); the settings hold the DM list and
// the per-person weekly allowance; a project the bot builds for somebody on
// the list is live; the bot's posts on a request carry `dm` to its
// requester's DM; what the DM says is plain and has no em dash; a request
// is held when its requester's allowance is spent; the create dialog sends
// the longer description; and the DM draws a question's answers with the
// line that says an answer is public.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const dm = require('../src/services/homeroom-bot-dm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const DASH = /—/;

// ── The question contract ────────────────────────────────────────────────

const fence = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

test('a triage question carries its suggested answers, the default first, short and distinct', () => {
  const parsed = bot.parseVerdict(fence({
    verdict: 'question', question: 'Which list do you mean?', default: 'The shopping list',
    answers: ['The to-do list', 'the shopping list', 'The shopping list', 'x'.repeat(200), 'Both lists', 'Neither', 'Another'],
    blocker: 'user_facing', why_default_fails: 'They are different screens.', build_note: 'Sort the shopping list.',
  }));
  assert.equal(parsed.verdict, 'question');
  assert.deepEqual(parsed.questionAnswers, ['The shopping list', 'The to-do list', 'Both lists', 'Neither'],
    'the default leads, duplicates and over-long lines are dropped, four at most');
});

test('a question with no answers list still offers its default', () => {
  const parsed = bot.parseVerdict(fence({
    verdict: 'question', question: 'Which list?', default: 'The shopping list',
    blocker: 'user_facing', why_default_fails: 'Different screens.', build_note: 'x',
  }));
  assert.deepEqual(parsed.questionAnswers, ['The shopping list']);
  const ready = bot.parseVerdict(fence({ verdict: 'ready', build_note: 'Do it.' }));
  assert.equal(ready.questionAnswers, null, 'only a question has answers');
});

test('the triage prompt asks for answers a person can tap, in plain words', () => {
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /give `answers`: two to four short replies/);
  assert.match(prompt, /"answers": \[/);
  assert.match(prompt, /plain words, with no file names, code or jargon/);
});

test('a follow-up ask carries answers too; its other actions keep their shape', () => {
  const ask = followup.parseFollowUp(fence({ action: 'ask', reply: 'Darker or lighter?', answers: ['Darker', 'Lighter', 3] }));
  assert.deepEqual(ask.answers, ['Darker', 'Lighter']);
  const answer = followup.parseFollowUp(fence({ action: 'answer', reply: 'Because.' }));
  assert.equal(Object.hasOwn(answer, 'answers'), false);
  assert.match(followup.followUpPrompt({ seed: 's', replies: [] }), /"answers": \[/);
});

// ── Settings ─────────────────────────────────────────────────────────────

test('the DM list is lower-cased usernames, and the per-person allowance defaults to $50', () => {
  const s = bot.parseSettings([
    { key: 'homeroom_bot_dm_users', value: JSON.stringify(['Evan', 'evan', 'bad name!', 7, 'ada_2']) },
  ]);
  assert.deepEqual(s.dmUsers, ['evan', 'ada_2']);
  assert.equal(s.userWeeklyCents, 5000);
  assert.equal(bot.parseSettings([{ key: 'homeroom_bot_user_weekly_cents', value: '-3' }]).userWeeklyCents, 0);
});

test('an admin sets the DM list and the allowance; anything else is refused', () => {
  const ok = bot.validateSettingsPatch({ dmUsers: ['@Evan', 'ada'], userWeeklyCents: 2000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.updates, [
    ['homeroom_bot_dm_users', '["evan","ada"]'],
    ['homeroom_bot_user_weekly_cents', '2000'],
  ]);
  assert.equal(bot.validateSettingsPatch({ dmUsers: 'evan' }).ok, false);
  assert.equal(bot.validateSettingsPatch({ dmUsers: ['no spaces'] }).ok, false);
  assert.equal(bot.validateSettingsPatch({ dmUsers: Array.from({ length: 51 }, (_, i) => `u${i}`) }).ok, false);
  assert.equal(bot.validateSettingsPatch({ userWeeklyCents: 1.5 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ userWeeklyCents: -1 }).ok, false);
});

test('a project the bot builds for somebody on the list is live, like the live list; never on staging', () => {
  const settings = { mode: 'shadow', liveApps: ['rss'], firstVersionApps: ['chore-wheel'] };
  assert.equal(live.isLiveFor(settings, { slug: 'chore-wheel' }), true);
  assert.equal(live.isLiveFor(settings, { slug: 'rss' }), true);
  assert.equal(live.isLiveFor(settings, { slug: 'other' }), false);
  assert.equal(live.isLiveFor({ ...settings, mode: 'off' }, { slug: 'chore-wheel' }), false);
  const env = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try { assert.equal(live.isLiveFor(settings, { slug: 'chore-wheel' }), false); } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  }
});

test('the bot talks in a DM only to people on the list', () => {
  assert.equal(dm.isDmUser({ mode: 'shadow', dmUsers: ['evan'] }, 'Evan'), true);
  assert.equal(dm.isDmUser({ mode: 'off', dmUsers: ['evan'] }, 'evan'), true,
    'the list is the gate; Mode decides whether the bot works, not who it talks to');
  assert.equal(dm.isDmUser({ mode: 'shadow', dmUsers: [] }, 'evan'), false);
});

test('a first version gets the longer build clocks', () => {
  const app = { repo_url: 'https://github.com/usernode-bot/x' };
  const plain = bot.buildBudgets(app, {}, 60_000);
  const first = bot.buildBudgets(app, {}, 60_000, { firstVersion: true });
  assert.equal(first.turnBudgetMs, plain.turnBudgetMs * bot.FIRST_VERSION_BUILD_TIME_FACTOR);
  assert.equal(first.specBudgetMs, plain.specBudgetMs * bot.FIRST_VERSION_BUILD_TIME_FACTOR);
  assert.equal(bot.FIRST_VERSION_BUILD_TIME_FACTOR, 2, 'a starter template is small; only the change is larger');
});

// ── What the DM says ─────────────────────────────────────────────────────

const KINDS = {
  question: { question: 'Newest first?', answers: ['Yes'] },
  followup_ask: { question: 'Darker?', answers: ['Yes'] },
  spec: { building: true },
  proposal: { link: 'https://app.onhomeroom.com/#app/x/dev/proposals/9' },
  followup_revise: { summary: 'Made it darker.', link: 'https://app.onhomeroom.com/#app/x/dev/proposals/9' },
  blocked: { reason: 'There is no calendar to read.' },
  build_failed: { reason: 'tests failed' },
  person: { reason: 'It is a policy choice.' },
  followup_person: { reason: 'It is a policy choice.' },
  empty: { reason: 'Nothing here.' },
};

test('every kind the DM carries reads plainly, names the request, and has no em dash', () => {
  const context = { appName: 'Seed swap', issueNumber: 7, issueTitle: 'Sort by date', firstVersion: false };
  for (const [kind, payload] of Object.entries(KINDS)) {
    const text = dm.dmText(kind, payload, context);
    assert.ok(text, kind);
    assert.match(text, /^\*\*Seed swap\*\* · request #7: Sort by date/, kind);
    assert.doesNotMatch(text, DASH, kind);
  }
  assert.equal(dm.dmText('looking', {}, context), null, 'not every post is DM news');
  assert.match(dm.dmText('spec', {}, { ...context, firstVersion: true }), /^\*\*Seed swap\*\*, its first version\n\nI'm building the first version now/);
  assert.match(dm.dmText('proposal', KINDS.proposal, context), /try the preview and vote on it: https:/);
  for (const text of [dm.HELP_TEXT, dm.NOT_ENABLED_TEXT, dm.mirroredText('x', { question: true })]) {
    assert.doesNotMatch(text, DASH);
  }
});

test('an answer is posted on the request saying where it came from', () => {
  assert.equal(dm.mirroredText('Oldest first', { question: true }), 'Oldest first\n\n(Answered in a chat with Homeroom bot.)');
  assert.equal(dm.mirroredText('Also add dates'), 'Also add dates\n\n(Sent in a chat with Homeroom bot.)');
});

test('a description is something to build from only when it says something, and is kept to its limit', () => {
  assert.equal(dm.normalizeBrief('  short '), null);
  assert.equal(dm.normalizeBrief(42), null);
  assert.equal(dm.normalizeBrief('A list of chores for the house.\r\n'), 'A list of chores for the house.');
  assert.equal(dm.normalizeBrief('x'.repeat(5000)).length, dm.MAX_BRIEF_CHARS);
});

test('without the helper model, the suggested one-liner is the first sentence, cut at a word', async () => {
  assert.equal(dm.firstSentence('A chore wheel for the house. It is fair.'), 'A chore wheel for the house');
  const long = dm.firstSentence(`A ${'very '.repeat(30)}long sentence`, 40);
  assert.ok(long.length <= 40);
  assert.match(long, /…$/);
  const out = await dm.suggestShortDescription({
    name: 'Chore wheel', brief: 'Who does the dishes this week. Fairly.',
    deps: { llm: { async generateShortDescription() { throw new Error('offline'); } } },
  });
  assert.equal(out.description, 'Who does the dishes this week');
  const model = await dm.suggestShortDescription({
    name: 'Chore wheel', brief: 'Who does the dishes this week. Fairly.',
    deps: { llm: { async generateShortDescription() { return { description: 'A fair chore rota', usage: {}, model: 'm' }; } } },
  });
  assert.equal(model.description, 'A fair chore rota');
});

test('a staging copy never files a first version: a GitHub issue is an irreversible side effect', async () => {
  const env = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  const pool = { async query() { throw new Error('nothing is read on staging'); } };
  try {
    assert.equal(await dm.fileFirstVersion(pool, {}, 1), null);
    assert.equal(await dm.sweepFirstVersions(pool, {}), 0);
  } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  }
});

test('the weekly allowance message is keyed by the platform week, which starts on Monday', () => {
  assert.equal(dm.weekKey(new Date('2026-10-01T12:00:00Z')), '20260928');
  assert.equal(dm.weekKey(new Date('2026-09-28T00:00:00Z')), '20260928');
  assert.equal(dm.weekKey(new Date('2026-09-27T23:59:00Z')), '20260921');
});

// ── The bot's posts carry the news to the DM ─────────────────────────────

test('a post with `dm` is relayed to the requester\'s DM; one without is not', async (t) => {
  const relayed = [];
  const real = dm.relayIssuePost;
  dm.relayIssuePost = async (args) => { relayed.push(args); return null; };
  t.after(() => { dm.relayIssuePost = real; });
  const pool = { async query(s) { return /INSERT INTO homeroom_bot_posts/.test(s) ? { rows: [{ id: 11 }] } : { rows: [] }; } };
  const github = { async createIssueComment() { return { id: 1, created_at: 'now' }; } };
  const ws = { async sendBotMessage() { return { id: 5 }; } };
  const sender = { id: 2, username: 'homeroom_bot' };
  const app = { id: 1, slug: 'seed-swap' };
  const repo = { owner: 'o', repo: 'r' };
  await live.post({ pool, github, ws, app, repo, issueNumber: 7, kind: 'looking', text: 'Looking.', sender });
  assert.equal(relayed.length, 0);
  await live.post({
    pool, github, ws, app, repo, issueNumber: 7, kind: 'question', text: 'Q?', sender, runId: 3,
    dm: { question: 'Q?', answers: ['A'] },
  });
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].kind, 'question');
  assert.equal(relayed[0].postId, 11, 'keyed by the post, so a retry sends once');
  assert.deepEqual(relayed[0].dm, { question: 'Q?', answers: ['A'] });
  // A relay that throws never fails the post.
  dm.relayIssuePost = async () => { throw new Error('boom'); };
  const posted = await live.post({ pool, github, ws, app, repo, issueNumber: 7, kind: 'spec', text: 'S', sender, dm: { building: true } });
  assert.equal(posted.postId, 11);
});

test('a live verdict hands its question, and its answers, to the DM', async () => {
  const says = [];
  const deps = {
    github: {}, ws: {},
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
  };
  const realPost = live.post;
  const realSeen = live.advanceSeen;
  const realTargets = live.mentionTargets;
  live.post = async (args) => { says.push(args); return {}; };
  live.advanceSeen = async () => ({});
  live.mentionTargets = async () => [];
  try {
    await bot.actOnVerdict({
      pool: { async query() { return { rows: [] }; } }, config: {}, bot: { id: 2 }, app: { id: 1, slug: 'x' },
      repo: { owner: 'o', repo: 'r' }, issueNumber: 7, issue: {},
      parsed: { verdict: 'question', question: 'Which?', questionDefault: 'This', questionAnswers: ['This', 'That'] },
      capSuppressed: null, runId: 3, seed: '', seedReadAt: 'now', postedAt: [], turnBudgetMs: 1000, model: 'm', deps,
    });
  } finally {
    live.post = realPost; live.advanceSeen = realSeen; live.mentionTargets = realTargets;
  }
  assert.equal(says.length, 1);
  assert.equal(says[0].kind, 'question');
  assert.deepEqual(says[0].dm, { question: 'Which?', answers: ['This', 'That'] });
});

test('a request whose requester spent the week\'s allowance is held, said once, and costs nothing', async (t) => {
  const queries = [];
  const pool = { async query(s, p) { queries.push({ s, p }); return { rows: [] }; } };
  const held = [];
  const deps = {
    github: {
      isEnabled: () => true,
      async fetchPublicIssue() { return { issue: { number: 7, title: 'Sort', body: 'b', state: 'open' } }; },
    },
    worker: {}, agentTurn: {}, threadContext: {}, managedOpenRouter: {}, sessions: {}, activeWorkers: new Set(),
    limits: { async checkBudget() { return { ok: true }; } },
    ws: {}, sessionLifecycle: {},
    dm: {
      async recordRequester() { return { userId: 9, username: 'ada', firstVersion: false }; },
      async overWeeklyAllowance(_pool, settings, userId) { return settings.userWeeklyCents === 100 && userId === 9; },
      async noteOverAllowance(_pool, args) { held.push(args); },
    },
  };
  const out = await bot.runTriage(pool, {}, {
    bot: { id: 2 }, app: { id: 1, slug: 'seed-swap', repo_url: 'https://github.com/o/r' },
    item: { id: 31, issue_number: 7 }, mode: 'shadow',
    settings: { mode: 'shadow', liveApps: ['seed-swap'], userWeeklyCents: 100 }, deps,
  });
  assert.deepEqual(out, { ran: false, reason: 'user_allowance' });
  assert.equal(held.length, 1);
  assert.ok(queries.some((q) => /DELETE FROM homeroom_bot_queue/.test(q.s) && q.p[0] === 31));
  assert.ok(!queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)), 'no run, nothing spent');
});

// ── The create dialog and the DM screen ──────────────────────────────────

test('the create dialog sends the longer description, never with an import', () => {
  const { createBody, BRIEF_MIN, BRIEF_MAX } = loadTsx('frontend/src/features/dialogs/create-app.tsx', {
    stubs: { '../messages/store': { open() {} } },
  });
  assert.equal(BRIEF_MIN, dm.MIN_BRIEF_CHARS, 'the client and server agree on the minimum');
  assert.equal(BRIEF_MAX, dm.MAX_BRIEF_CHARS, 'and on the maximum');
  const base = { name: 'Chore wheel', mode: 'new', audience: 'solo', approvers: null, approvals: null };
  assert.equal(createBody({ ...base, brief: '  A fair chore rota for the house.  ' }).brief, 'A fair chore rota for the house.');
  assert.equal(createBody({ ...base, brief: 'short' }).brief, undefined);
  assert.equal(createBody({ ...base, mode: 'import', repoUrl: 'https://github.com/o/r', brief: 'A fair chore rota for the house.' }).brief, undefined);
  assert.equal(createBody(base).brief, undefined);
});

test('the short description is suggested for everyone making a project, and every description is filed', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'apps.js'), 'utf8');
  const suggest = routes.slice(routes.indexOf("router.post('/api/apps/suggest-description'"), routes.indexOf("router.post('/api/apps', "));
  assert.match(suggest, /router\.post\('\/api\/apps\/suggest-description', feedbackTitleLimiter, sameOriginBrowserOnly, async/,
    'the limiter, then the same-origin guard, as before');
  assert.match(suggest, /if \(!req\.user\) return res\.status\(401\)/, 'any signed-in person');
  assert.doesNotMatch(suggest, /isEnabledFor/, 'no longer only for somebody the bot builds for');
  // POST /api/apps hands every description (never an import's) to the
  // first-request record, which decides whether the bot builds it.
  const create = routes.slice(routes.indexOf("router.post('/api/apps', "));
  assert.match(create, /if \(!repoUrlNormalized && homeroomBotDm\.normalizeBrief\(req\.body\.brief\)\) \{[\s\S]{0,200}startFirstVersion\(pool, config, \{/);
  // #3624: an import, or a project with no description, is recorded for the
  // bot instead (live when its maker is on the DM list), and so is a fork.
  assert.match(create, /\} else \{\s*try \{\s*await homeroomBotDm\.noteProjectMade\(pool, \{\s*app: appRow, user: req\.user, origin: repoUrlNormalized \? 'import' : 'blank',/);
  const fork = routes.slice(routes.indexOf("router.post('/api/apps/:slug/fork'"), routes.indexOf("router.get('/api/apps/:slug'"));
  assert.match(fork, /noteProjectMade\(pool, \{ app: appRow, user: req\.user, origin: 'fork' \}\)[\s\S]{0,200}\}\s*forkApp\(config, appRow, sourceApp\)/);
  // The bot's live list and its wake are only for a first version it builds,
  // or a project somebody on the list made with nothing to build first.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'homeroom-bot-dm.js'), 'utf8');
  assert.match(src, /FROM homeroom_bot_first_versions WHERE bot_builds\s+UNION ALL\s+SELECT app_id, user_id, origin, created_at FROM homeroom_bot_dm_projects/);
  assert.match(src, /WHERE LOWER\(u\.username\) = ANY\(\$1::text\[\]\)/);
  assert.match(src, /if \(botBuilds\) settingsModule\(\)\.noteIssueActivity\(/);
  assert.match(src, /if \(final && botBuilds\) \{/, 'no DM about a request the bot never took on');
  // A sweep the bot's mode does not gate, on the leader.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /\.sweepFirstVersions\(getPool\(config\), config\)[\s\S]{0,240}setInterval\(runFirstRequestSweep, 5 \* 60 \* 1000\)\.unref\(\);/);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS bot_builds BOOLEAN NOT NULL DEFAULT TRUE;/);
});

test('a question in the DM draws its answers, the default marked, and says an answer is public', () => {
  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
    stubs: { './store': { answerBotQuestion() {}, scopeKey: () => 'k', setReply() {} } },
  });
  const message = {
    id: 5, conversationId: 3, content: 'Q', createdAt: 'now', reactions: [], attachments: [], objects: [],
    sender: { id: 2, username: 'homeroom_bot', bot: true },
    metadata: { homeroomBot: {
      kind: 'question', appName: 'Seed swap', issueNumber: 7, question: 'Newest first?',
      answers: ['Newest first', 'Oldest first'], status: 'open', mirrors: true,
    } },
  };
  const html = renderToHtml(createElement(BotQuestion, { message, conversationId: 3 }));
  assert.match(html, /data-bot-answer="default"[^>]*><span>Newest first<\/span><span class="messages-bot-default">suggested<\/span>/);
  assert.match(html, /Oldest first/);
  assert.match(html, /Something else/);
  assert.match(html, /posted on Seed swap request #7’s public discussion, where the group can see it/);

  const answered = { ...message, metadata: { homeroomBot: { ...message.metadata.homeroomBot, status: 'answered', answer: 'Oldest first' } } };
  const after = renderToHtml(createElement(BotQuestion, { message: answered, conversationId: 3 }));
  assert.doesNotMatch(after, /Something else/, 'no buttons once answered');
  assert.match(after, /You answered: Oldest first/);

  const person = { ...message, sender: { id: 4, username: 'ada' } };
  assert.equal(renderToHtml(createElement(BotQuestion, { message: person, conversationId: 3 })), '', 'only the bot\'s own');

  // #3624 stage 2: an offer to file a request takes the same buttons, but
  // nothing is posted until File it, so no public note, no "suggested", and
  // no Something else (typing is read by the bot).
  const offer = { ...message, metadata: { homeroomBot: {
    kind: 'confirm', appName: 'Seed swap', question: 'File this as a request on Seed swap?',
    answers: ['File it', 'Not now'], status: 'open',
  } } };
  const offered = renderToHtml(createElement(BotQuestion, { message: offer, conversationId: 3 }));
  assert.match(offered, /aria-label="File this request\?"/);
  assert.match(offered, /<span>File it<\/span><\/button>/);
  assert.match(offered, /<span>Not now<\/span>/);
  assert.doesNotMatch(offered, /suggested|Something else|public discussion/);
  const chose = { ...offer, metadata: { homeroomBot: { ...offer.metadata.homeroomBot, status: 'answered', answer: 'File it' } } };
  assert.match(renderToHtml(createElement(BotQuestion, { message: chose, conversationId: 3 })), /You chose: File it/);
});

test('the Messages client keeps the bot\'s mark and its question, which it builds field by field', () => {
  // The first staging run showed the question as plain text: this
  // normalizer dropped both fields before the screen ever saw them.
  const { normalizeMessage } = loadTsx('frontend/src/features/messages/api.ts');
  const message = normalizeMessage({
    id: 5, conversationId: 3, content: 'Q', createdAt: '2026-10-01T00:00:00Z',
    sender: { id: 2, username: 'homeroom_bot', bot: true },
    metadata: { homeroomBot: {
      kind: 'question', appName: 'Seed swap', issueNumber: 7, mirrors: true, status: 'open',
      question: 'Newest first?', answers: ['Newest first', 7, 'Oldest first'], unknown: 'x',
    } },
  });
  assert.equal(message.sender.bot, true);
  assert.equal(message.metadata.homeroomBot.status, 'open');
  assert.equal(message.metadata.homeroomBot.mirrors, true);
  assert.equal(message.metadata.homeroomBot.issueNumber, 7);
  assert.deepEqual(message.metadata.homeroomBot.answers, ['Newest first', 'Oldest first']);
  assert.equal(Object.hasOwn(message.metadata.homeroomBot, 'unknown'), false, 'only the named fields');
  const person = normalizeMessage({ id: 6, content: 'hi', sender: { id: 4, username: 'ada' } });
  assert.equal(Object.hasOwn(person, 'metadata'), false);
  assert.equal(Object.hasOwn(person.sender, 'bot'), false);
});

test('the DM screen draws the bot\'s question and badge, and the reply bar names where a reply goes', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /message\.sender\.bot && message\.metadata\?\.homeroomBot\?\.question \? <BotQuestion/);
  assert.match(row, /messages-bot-badge/);
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /Your reply is posted on \$\{requestPlace\(reply\.metadata\.homeroomBot\)\}’s public discussion\./);
  const css = read('public/css/app.css');
  for (const cls of ['.messages-bot-badge', '.messages-bot-answers button', '.messages-bot-note', '.messages-bot-default']) {
    assert.ok(css.includes(cls), cls);
  }
});

// ── Typing, while the bot answers (#3684) ────────────────────────────────

// The typing event goes out through the same audience gate a person's does
// (conversations.withLockedAudience, which needs a database): stood in for
// here by a DM of the bot (2) and Ada (9).
function typingHarness(t) {
  const conversations = require('../src/services/conversations');
  const realAudience = conversations.withLockedAudience;
  const audiences = [];
  conversations.withLockedAudience = async (_pool, actor, conversationId, callback) => {
    audiences.push({ actor: actor.id, conversationId });
    await callback([2, 9]);
    return [2, 9];
  };
  t.after(() => { conversations.withLockedAudience = realAudience; });
  const events = [];
  const ws = {
    pushConversationEvent(memberIds, payload, options) { events.push({ memberIds, payload, options }); return 1; },
  };
  const typing = () => events.filter((e) => e.payload.type === 'conversation_typing').map((e) => e.payload.typing);
  return { audiences, events, ws, typing };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the bot types from the start of its answer until the answer is sent, as a person\'s typing event', async (t) => {
  const { audiences, events, ws, typing } = typingHarness(t);
  const out = await dm.whileTyping({}, { botId: 2, conversationId: 41, ws }, async () => {
    await settle();
    assert.deepEqual(typing(), [true], 'typing while it works');
    ws.pushConversationEvent([2, 9], { type: 'conversation_message_created', conversationId: 41, messageId: 1 });
    return 'answered';
  });
  assert.equal(out, 'answered', 'the answer is what the work resolved');
  assert.deepEqual(events.map((e) => e.payload.type === 'conversation_typing' ? e.payload.typing : 'reply'), [true, 'reply', false],
    'it stops once the answer is out, never before');
  const first = events[0];
  assert.deepEqual(first.payload, { type: 'conversation_typing', conversationId: 41, userId: 2, typing: true });
  assert.deepEqual(first.options, { excludeUserId: 2 }, 'the same event and audience as the typing route');
  assert.deepEqual(audiences, [{ actor: 2, conversationId: 41 }, { actor: 2, conversationId: 41 }],
    'as the bot, through the gate that drops a DM the person blocked');
});

test('a long answer keeps the bot typing, and a failed one still stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { ws, typing } = typingHarness(t);
  let finish;
  const answering = dm.whileTyping({}, { botId: 2, conversationId: 42, ws }, () => new Promise((resolve, reject) => { finish = reject; }));
  await settle();
  for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(dm.TYPING_RENEW_MS); await settle(); }
  finish(new Error('model failed'));
  await assert.rejects(answering, /model failed/, 'the failure is the caller\'s to see');
  await settle();
  const said = typing();
  assert.deepEqual(said, [true, true, true, true, true, true, false], 'said again on every renewal, then stopped');
  t.mock.timers.tick(dm.TYPING_RENEW_MS * 3);
  await settle();
  assert.equal(typing().length, said.length, 'and nothing after');
});

test('an answer that never ends stops the typing at the cap, and each renewal beats the reader\'s expiry', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { ws, typing } = typingHarness(t);
  let finish;
  const answering = dm.whileTyping({}, { botId: 2, conversationId: 43, ws }, () => new Promise((resolve) => { finish = resolve; }));
  await settle();
  for (let at = 0; at < dm.TYPING_MAX_MS; at += dm.TYPING_RENEW_MS) { t.mock.timers.tick(dm.TYPING_RENEW_MS); await settle(); }
  const said = typing();
  assert.equal(said.at(-1), false, 'stopped at the cap, whatever the work is doing');
  assert.equal(said.filter((v) => v === false).length, 1);
  t.mock.timers.tick(dm.TYPING_RENEW_MS * 3);
  await settle();
  assert.equal(typing().length, said.length, 'no renewal after the cap');
  finish('late');
  assert.equal(await answering, 'late');
  await settle();
  assert.equal(typing().length, said.length, 'a late answer stops nothing twice');

  // The Messages reader drops a typing line it has not heard again within
  // its expiry, so the renewal must come sooner, with room for the trip.
  const store = read('frontend/src/features/messages/store.ts');
  const expiry = Number(store.match(/case 'conversation_typing': \{[\s\S]*?\}, (\d+)\)\);/)[1]);
  assert.equal(expiry, 6000);
  assert.ok(dm.TYPING_RENEW_MS <= expiry - 1500, 'renewed well inside the reader\'s expiry');
});

test('two answers in one DM keep one typing line up until the last is sent', async (t) => {
  const { ws, typing } = typingHarness(t);
  const finishers = [];
  const work = () => new Promise((resolve) => { finishers.push(resolve); });
  const first = dm.whileTyping({}, { botId: 2, conversationId: 44, ws }, work);
  const second = dm.whileTyping({}, { botId: 2, conversationId: 44, ws }, work);
  await settle();
  assert.deepEqual(typing(), [true], 'said once');
  finishers[0]('one');
  await first;
  await settle();
  assert.deepEqual(typing(), [true], 'still typing the second answer');
  finishers[1]('two');
  await second;
  assert.deepEqual(typing(), [true, false]);
});

test('a message from somebody on the list is answered while the bot types; anybody else\'s is not', async (t) => {
  const { ws, typing } = typingHarness(t);
  const pool = {
    async query(sql) {
      if (/FROM platform_settings/.test(sql)) return { rows: [{ key: 'homeroom_bot_dm_users', value: '["ada"]' }] };
      if (/FROM conversation_direct_pairs/.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
  };
  const bot = { id: 2, username: 'homeroom_bot' };
  const seen = [];
  const mayor = {
    async decideOffer() { return null; },
    async runDmTurn(_pool, _config, args) { await settle(); seen.push(typing().slice()); return { turn: args.message.id }; },
  };
  const out = await dm.noteUserMessage(pool, {}, {
    user: { id: 9, username: 'ada' }, conversationId: 45, message: { id: 70, content: 'what are you working on?' },
    deps: { bot, mayor, ws },
  });
  assert.deepEqual(out, { turn: 70 });
  assert.deepEqual(seen, [[true]], 'typing while the model answers');
  assert.deepEqual(typing(), [true, false], 'and stopped once it has');

  const conversations = require('../src/services/conversations');
  const realOpen = conversations.ensureAdmittedDirect;
  conversations.ensureAdmittedDirect = async () => null;
  t.after(() => { conversations.ensureAdmittedDirect = realOpen; });
  await dm.noteUserMessage(pool, {}, {
    user: { id: 11, username: 'sam' }, conversationId: 46, message: { id: 71, content: 'hi' },
    deps: { bot, mayor, ws },
  });
  assert.deepEqual(typing(), [true, false], 'the bot does not type to somebody it does not answer');
});
