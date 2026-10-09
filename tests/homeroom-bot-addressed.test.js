'use strict';

// #4530: the Homeroom bot stays quiet on a request nobody is talking to it.
//
// People talking among themselves after the bot already left its note get no
// second copy of it: not its question, not "a person needs to decide this
// one", not "couldn't find anything to build". It speaks again when somebody
// mentions @homeroom_bot, replies to one of its messages, or writes anything
// after a question it asked, on the discussion or on the GitHub issue. The
// rule itself is pure (homeroom-bot-addressed.js); here it is pinned, its
// two queries are held against the full PostgreSQL schema, and
// actOnVerdict is held at both sides of the gate.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-addressed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const holds = require('../src/services/homeroom-bot-holds');
const addressed = require('../src/services/homeroom-bot-addressed');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── The rule ──

const NOTE = (kind) => ({ kind, created_at: '2026-10-09T09:02:00Z' });
const AFTER = '2026-10-09T09:10:00Z';
const BEFORE = '2026-10-09T09:00:00Z';
const msg = (body, { at = AFTER, quotesBot = false } = {}) => ({ body, createdAt: at, quotesBot });
const comment = (author, body, at = AFTER) => ({ author, body, createdAt: at });

test('the bot speaks the first time it could leave a note here', () => {
  assert.deepEqual(addressed.addressed({ lastNote: null }), { speak: true, why: 'first_note' });
});

test('people talking among themselves after a person note are not for the bot', () => {
  const result = addressed.addressed({
    lastNote: NOTE('person'),
    messages: [
      msg('written before the note', { at: BEFORE }),
      msg("I'd go with the list layout, it's easier on a phone"),
      msg('Agreed, let us ask the others at the next meeting'),
    ],
    comments: [comment('evan', 'Same on our side, no rush')],
  });
  assert.deepEqual(result, { speak: false, why: 'not_addressed' });
});

test('a mention speaks, and only a real one', () => {
  const speak = (body) => addressed.addressed({ lastNote: NOTE('person'), messages: [msg(body)] });
  assert.deepEqual(speak('hey @homeroom_bot what about the header?'), { speak: true, why: 'mention' });
  assert.deepEqual(speak('@HOMEROOM_BOT still there?'), { speak: true, why: 'mention' }, 'the mention is not case-bound');
  assert.deepEqual(speak('@homeroom_bot_x what about the header?'), { speak: false, why: 'not_addressed' },
    'a longer handle is somebody else');
  assert.deepEqual(speak('write me at a@homeroom_bot ok?'), { speak: false, why: 'not_addressed' },
    'the tail of an address is not a mention');
  assert.deepEqual(speak('(@homeroom_bot) thanks'), { speak: true, why: 'mention' }, 'punctuation around it is fine');
});

test('a reply to one of the bot\'s messages speaks', () => {
  const result = addressed.addressed({ lastNote: NOTE('person'), messages: [msg('the list one, please', { quotesBot: true })] });
  assert.deepEqual(result, { speak: true, why: 'reply' });
});

test('anything written after a question the bot asked is its answer', () => {
  const withMessage = addressed.addressed({ lastNote: NOTE('question'), messages: [msg('the blue one')] });
  assert.deepEqual(withMessage, { speak: true, why: 'answer' });
  const withComment = addressed.addressed({ lastNote: NOTE('question'), comments: [comment('drea', 'the blue one')] });
  assert.deepEqual(withComment, { speak: true, why: 'answer' });
  assert.deepEqual(addressed.addressed({ lastNote: NOTE('question') }), { speak: false, why: 'not_addressed' },
    'nothing after it yet');
});

test('on the GitHub issue, a mention of the bot or its login speaks, and its own comment does not', () => {
  const issue = addressed.addressed({
    lastNote: NOTE('person'),
    comments: [comment('evan', '@homeroom_bot try again with the dark theme')],
  });
  assert.deepEqual(issue, { speak: true, why: 'mention' });
  const byLogin = addressed.addressed({
    lastNote: NOTE('person'),
    comments: [comment('evan', '@Usernode-Bot please take another look')],
    botLogin: 'usernode-bot[bot]',
  });
  assert.deepEqual(byLogin, { speak: true, why: 'mention' }, 'the GitHub login mentions it too');
  const own = addressed.addressed({
    lastNote: NOTE('question'),
    comments: [
      comment('usernode-bot', 'Homeroom bot asked: which layout?'),
      comment('usernode-bot[bot]', '@homeroom_bot should never match its own words'),
    ],
    botLogin: 'usernode-bot[bot]',
  });
  assert.deepEqual(own, { speak: false, why: 'not_addressed' }, 'the bot does not answer itself');
});

test('the same text the holds module matches a mention with, both places build it', () => {
  assert.equal(holds.mentionPattern(), "(^|[^a-z0-9_])@homeroom_bot([^a-z0-9_-]|$)");
  const src = read('src/services/homeroom-bot-holds.js');
  assert.match(src, /AND m\.content ~\* \$3/);
  assert.match(src, /\[appId, numbers, mentionPattern\(\), windowHours\]/, 'recentMentions uses it');
});

// ── actOnVerdict at the gate ──

const PERSON_PARSED = { verdict: 'person', reason: 'which of the two layouts the group wants' };

function fakePool(routes = []) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push([String(sql), params]);
      for (const [pattern, answer] of routes) {
        if (pattern.test(String(sql))) {
          if (answer instanceof Error) throw answer;
          return answer;
        }
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

function verdictArgs(over = {}) {
  const pool = over.pool || fakePool();
  return {
    pool, config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'chores', name: 'Chores' },
    repo: { owner: 'o', repo: 'r' }, issueNumber: 12, issue: { title: 'Two layouts' },
    parsed: PERSON_PARSED, capSuppressed: null, runId: 900,
    seed: 's', seedReadAt: '2026-10-09T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'stage/build',
    deps: {
      github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
      ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
      limits: { async recordSpend() {}, async checkBudget() { return {}; } },
      managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
    },
    ...over,
  };
}

function stubLive(t) {
  const real = { post: live.post, advanceSeen: live.advanceSeen };
  const seen = { posts: [], seen: [] };
  live.post = async (a) => { seen.posts.push(a); return {}; };
  live.advanceSeen = async (a) => { seen.seen.push(a); return { advanced: false, reason: 'nothing_posted' }; };
  t.after(() => Object.assign(live, real));
  return seen;
}

// The gate's two queries, as fake pool answers: the bot's last note, then
// what people said since it.
const NOTE_ROUTE = [/FROM homeroom_bot_posts/, { rows: [{ kind: 'person', created_at: '2026-10-09T09:02:00Z' }] }];
const talk = (...bodies) => [/metadata->'quote'/, {
  rows: bodies.map((body, i) => ({ id: i + 1, content: body, created_at: AFTER, quotes_bot: false })),
}];

test('a repeat person note stays quiet while people talk among themselves', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool([
    NOTE_ROUTE,
    talk("I'd go with the list layout", 'Agreed, let us ask the others'),
  ]);
  const args = verdictArgs({ pool, relook: true });
  assert.equal(await bot.actOnVerdict(args), 'unaddressed');
  assert.equal(seen.posts.length, 0, 'nothing is posted, here or on GitHub');
  assert.equal(seen.seen.length, 1, 'the read is still recorded, so it is not read again for nothing');
  assert.deepEqual(pool.queries.find(([sql]) => /FROM homeroom_bot_posts/.test(sql))[1], [9, 12]);
  assert.deepEqual(pool.queries.find(([sql]) => /metadata->'quote'/.test(sql))[1],
    [9, 12, '2026-10-09T09:02:00Z', 77], 'the words after the note, for its user');
});

test('the note is posted again after a mention, and after a reply to one of its messages', async (t) => {
  const seen = stubLive(t);
  const mentioned = fakePool([NOTE_ROUTE, talk('@homeroom_bot what did you mean by the header?')]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: mentioned, relook: true })), 'person');
  assert.equal(seen.posts.length, 1);
  assert.equal(seen.posts[0].kind, 'person');

  seen.posts.length = 0;
  const replied = fakePool([
    NOTE_ROUTE,
    [/metadata->'quote'/, { rows: [{ id: 4, content: 'the list one, please', created_at: AFTER, quotes_bot: true }] }],
  ]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: replied, relook: true })), 'person');
  assert.equal(seen.posts.length, 1, 'a Reply counts the same as a mention');
});

test('a first look posts as it always did, and runs no gate query', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool();
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool, relook: false })), 'person');
  assert.equal(seen.posts.length, 1);
  assert.ok(!pool.queries.some(([sql]) => /homeroom_bot_posts/.test(sql)), 'the gate is not even asked');
});

test('a re-look that concludes the request is ready still acts', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool();
  const args = verdictArgs({
    pool, relook: true,
    parsed: { verdict: 'ready', buildNote: 'Make the header sticky.', complicated: false },
  });
  assert.equal(await bot.actOnVerdict(args), 'build_queued');
  assert.equal(seen.posts.length, 0, 'the build, not a note, is what this look says');
  assert.ok(!pool.queries.some(([sql]) => /homeroom_bot_posts/.test(sql)), 'a ready verdict is not held for words');
});

test('a look that cannot check whether it was addressed speaks as before', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool([
    [/FROM homeroom_bot_posts/, new Error('database is down')],
  ]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool, relook: true })), 'person');
  assert.equal(seen.posts.length, 1);
});

test('runTriage gates exactly the looks the request itself started', () => {
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /relook: item\.reason === 'changed' \|\| item\.reason === READ_AGAIN_REASON,\s*\n\s*comments,/);
  assert.match(src, /const gate = relook && !capSuppressed && addressedMod\(\)\.NOTE_KINDS\.includes\(parsed\.verdict\)/);
});

// ── The queries, against the real schema ──

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `hrbot_addr_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

test('the gate reads the last note and the words since it, against PostgreSQL', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  const homeroomBot = await user('homeroom_bot', { synthetic: true });
  const drea = await user('drea');
  const evan = await user('evan');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Chores', 'chores', 'running', $1, 'https://github.com/usernode-bot/chores', 'public', 'public')
     RETURNING id, slug, name, repo_url`,
    [evan.id],
  );
  const n = 12;

  // 9:02 the bot left its person note; 9:05 it spoke once more on the thread;
  // 9:10 drea replied to that line; 9:12 evan added to the talk; and one of
  // drea's messages is deleted, so it counts for nothing.
  await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, kind, created_at)
     VALUES ($1, $2, 'person', '2026-10-09T09:02:00Z')`,
    [app.id, n],
  );
  const post = (userId, content, at, issueNo = n) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     VALUES ($1, $2, $3, 'message', 'issue', $4, $5::timestamptz) RETURNING id`,
    [app.id, userId, content, issueNo, at],
  );
  await post(homeroomBot.id, '@Drea @evan Homeroom bot thinks a person needs to decide this one.', '2026-10-09T09:02:30Z');
  const { rows: [botLine] } = await post(homeroomBot.id, 'The two layouts are the cards and the list.', '2026-10-09T09:05:00Z');
  // The Reply quotes the bot's line by id, as the chat's Reply action stores
  // it (metadata.quote.refMsgId).
  const reply = await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at, metadata)
     VALUES ($1, $2, $3, 'message', 'issue', $4, $5::timestamptz, $6::jsonb) RETURNING id`,
    [app.id, drea.id, 'The list one, please', n, '2026-10-09T09:10:00Z', JSON.stringify({ quote: { refMsgId: String(botLine.id) } })],
  );
  await post(evan.id, 'Agreed, let us ask the others at the next meeting.', '2026-10-09T09:12:00Z');
  const gone = await post(drea.id, 'deleted while thinking', '2026-10-09T09:13:00Z');
  await pool.query('UPDATE chat_messages SET deleted_at = NOW() WHERE id = $1', [gone.rows[0].id]);

  const loaded = await addressed.loadAddressed(pool, { appId: app.id, issueNumber: n, botId: homeroomBot.id });
  assert.equal(loaded.lastNote.kind, 'person');
  assert.equal(loaded.messages.length, 2, 'the bot\'s own lines and the deleted one are left out');
  assert.deepEqual(loaded.messages.map((m) => m.quotesBot), [true, false], 'the Reply names the bot\'s message');
  assert.equal(new Date(loaded.messages[0].createdAt).toISOString(), '2026-10-09T09:10:00.000Z');

  const replied = await addressed.shouldSpeak(pool, { appId: app.id, issueNumber: n, botId: homeroomBot.id });
  assert.deepEqual(replied, { speak: true, why: 'reply' }, 'a Reply to its message, read back through the query');

  // A second request the bot noted on, where the two of them only talk to
  // each other, and then mention it.
  const other = 13;
  await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, kind, created_at)
     VALUES ($1, $2, 'person', '2026-10-09T09:02:00Z')`,
    [app.id, other],
  );
  await post(drea.id, 'The list layout is easier on a phone.', '2026-10-09T09:10:00Z', other);
  await post(evan.id, 'Agreed, let us ask the others at the next meeting.', '2026-10-09T09:12:00Z', other);
  const quiet = await addressed.shouldSpeak(pool, { appId: app.id, issueNumber: other, botId: homeroomBot.id });
  assert.deepEqual(quiet, { speak: false, why: 'not_addressed' }, 'two people among themselves');

  await post(evan.id, '@homeroom_bot then make it the list one', '2026-10-09T09:20:00Z', other);
  const now = await addressed.shouldSpeak(pool, { appId: app.id, issueNumber: other, botId: homeroomBot.id });
  assert.deepEqual(now, { speak: true, why: 'mention' }, 'a mention is heard through the same query');

  const nowhere = await addressed.shouldSpeak(pool, { appId: app.id, issueNumber: 99, botId: homeroomBot.id });
  assert.deepEqual(nowhere, { speak: true, why: 'first_note' }, 'no note on this request yet');
  assert.ok(reply.rows[0].id);
});
