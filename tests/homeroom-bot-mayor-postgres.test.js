'use strict';

// #3624 stage 2: the Homeroom bot's DM, read by a model, against the full
// PostgreSQL schema. The model is a script here: each test hands runDmTurn
// a `chat` that answers with the tool calls a real one would make, so what
// is checked is everything around it: what the tools read for ONE person,
// what reaches the DM (its cards, its offer), what is filed on a tap, what
// a turn costs and where that is counted, and when the bot does not answer
// at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const threadPosts = [];
const systemMessages = [];
const issueUpdates = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    async handleMessage(_pool, client, msg) {
      threadPosts.push({ userId: client.user.id, appId: client.appId, msg });
      return { ok: true, message: { id: threadPosts.length } };
    },
    async sendSystemMessage(_pool, appId, content, _type, _meta, thread) {
      systemMessages.push({ appId, content, thread });
      return { id: systemMessages.length };
    },
    pushIssueUpdate(data) { issueUpdates.push(data); },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};
// A card for a request reads its GitHub issue; this one always exists.
const githubId = require.resolve('../src/services/github');
const created = [];
const githubStub = {
  isEnabled: () => true,
  async fetchPublicIssue(_owner, _repo, number) { return { issue: { number, title: `Issue ${number}`, state: 'open' } }; },
  async createIssue(owner, repo, { title, body }) {
    created.push({ owner, repo, title, body });
    return { number: 40 + created.length, title };
  },
  noteIssueCreated() {},
  safeMention: (s) => s,
};
require.cache[githubId] = {
  id: githubId, filename: githubId, loaded: true,
  exports: new Proxy(githubStub, { get: (t, k) => (k in t ? t[k] : async () => null) }),
};

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const mayor = require('../src/services/homeroom-bot-mayor');
const progressSvc = require('../src/services/homeroom-bot-progress');
const homeroomBot = require('../src/services/homeroom-bot');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };

/** A scripted model: each call answers with the next step's tool calls. */
function scripted(steps, seen = []) {
  let i = 0;
  return async (request) => {
    seen.push(request);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const calls = (typeof step === 'function' ? step(request) : step).map((c, n) => ({
      id: `call_${i}_${n}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) },
    }));
    return {
      content: '',
      toolCalls: calls,
      assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
      usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.0021 },
    };
  };
}

function lastToolResult(request, name) {
  const msgs = request.messages;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role !== 'tool') continue;
    const call = msgs.slice(0, i).reverse().find((m) => m.tool_calls)?.tool_calls.find((c) => c.id === msgs[i].tool_call_id);
    if (!name || call?.function.name === name) return JSON.parse(msgs[i].content);
  }
  return null;
}

test('the Homeroom bot DM, read by a model, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_mayor_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  async function setting(key, value) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  async function project(slug, owner) {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, 'public', 'public') RETURNING id`,
      [slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), slug, owner.id, `https://github.com/usernode-bot/${slug}`],
    );
    // The community is made by a trigger after the insert.
    const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
    await pool.query(
      'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [app.community_id, owner.id],
    );
    return app;
  }
  const seeds = await project('seed-swap', ada);
  const notes = await project('note-board', ada);
  const samsApp = await project('sam-shop', sam);
  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_dm_users', JSON.stringify([ada.username, sam.username]));
  await setting('homeroom_bot_live_apps', JSON.stringify(['seed-swap', 'note-board', 'sam-shop']));
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const settings = await homeroomBot.readSettings(pool);

  async function say(text, extra = {}) {
    const sent = await conversations.sendMessage(pool, ada, opened.conversationId, { content: text, ...extra });
    return sent.message;
  }
  // The agent-session Mayor's connector, as the shim hands it over: a read
  // and a write, of which only the read may reach the model.
  const platformCalls = [];
  let platformClosed = 0;
  async function openMcp(opts) {
    platformCalls.push({ opened: opts });
    return {
      modelTools: [
        { name: 'get_request', description: 'Read one request.', input_schema: { type: 'object', properties: { slug: { type: 'string' }, number: { type: 'integer' } } } },
        { name: 'create_request', description: 'File a request.', input_schema: { type: 'object', properties: {} } },
      ],
      async call(name, args) {
        platformCalls.push({ name, args });
        return { isError: false, text: '<untrusted-content>Request #3: Sort by date. Sort the list newest first.</untrusted-content>' };
      },
      async close() { platformClosed += 1; },
    };
  }
  async function turn(text, chat, extra = {}) {
    const message = await say(text, extra.input || {});
    return mayor.runDmTurn(pool, CONFIG, {
      bot, user: ada, settings: extra.settings || settings, conversationId: opened.conversationId, message,
      deps: { chat, apiKey: 'sk-test', openMcp, sleep: async () => {}, ...(extra.deps || {}) },
    });
  }
  async function read(sent) {
    return conversations.getMessage(pool, ada, opened.conversationId, sent.messageId);
  }

  // Ada's requests: one being worked on, one waiting for her answer, one
  // whose proposal is up for a vote, one waiting in the queue. Sam's one is
  // never hers to see.
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES
       ($1, 3, $3, 'Sort by date'), ($1, 4, $3, 'Dark mode'), ($2, 5, $3, 'Pin notes'), ($2, 6, $3, 'Share a note'),
       ($4, 9, $5, 'Sam''s secret')`,
    [seeds.id, notes.id, ada.id, samsApp.id, sam.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at) VALUES
       ($1, 3, 1, 'new', NOW()), ($2, 6, 2, 'changed', NULL)`,
    [seeds.id, notes.id],
  );
  const asked = await dm.relayIssuePost({
    pool, app: seeds, issueNumber: 4, kind: 'question', postId: 1, bot,
    dm: { question: 'Light or dark first?', answers: ['Dark', 'Light'] },
  });
  const { rows: [proposal] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state)
     VALUES ($1, $2, 'b', 'promoted', 'Pin notes', NOW(), 'passing') RETURNING id`,
    [notes.id, bot.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, proposal_session_id)
     VALUES ($1, 5, 'live', 'ready', 0.10, $2)`,
    [notes.id, proposal.id],
  );

  await t.test('schema: a turn records its cost, not its words, and offers are private', async () => {
    for (const table of ['homeroom_bot_dm_turns', 'homeroom_bot_dm_actions']) {
      const { rows: [c] } = await pool.query(`SELECT obj_description('${table}'::regclass, 'pg_class') AS comment`);
      assert.equal(c.comment, 'staging:private', table);
    }
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'homeroom_bot_dm_turns'`,
    );
    assert.ok(!rows.some((r) => /content|text|reply/.test(r.column_name)), 'no column holds what was said');
    const s = await homeroomBot.readSettings(pool);
    assert.equal(s.liveAtOnce, 6);
    assert.equal(s.perPerson, 2);
    assert.equal(s.dmChat, true);
  });

  await t.test('my_work is one person\'s: each request\'s state, the proposal\'s votes, what runs now', async () => {
    const work = await mayor.myWork(pool, { userId: ada.id, settings, deps: { domain: 'app.test' } });
    const by = new Map(work.requests.map((r) => [`${r.project}#${r.number}`, r]));
    assert.equal(by.get('seed-swap#3').status, 'step 1 of 6: reading the request to decide whether to ask a question or build it');
    assert.ok(by.get('seed-swap#3').since, 'and since when');
    assert.equal(by.get('seed-swap#3').botBuildsHere, true);
    assert.equal(by.get('seed-swap#4').status, 'step 1 of 6: waiting for an answer to the question asked');
    assert.equal(by.get('note-board#5').status, 'step 5 of 6: its proposal is up for the group\'s vote');
    assert.equal(by.get('note-board#5').proposal.proposal, proposal.id);
    assert.equal(by.get('note-board#5').proposal.yesVotes, 0);
    assert.equal(by.get('note-board#5').proposal.checks, 'passed');
    assert.equal(by.get('note-board#5').proposal.link, `https://app.test/#app/note-board/dev/proposals/${proposal.id}`);
    assert.equal(by.get('note-board#6').status, 'step 1 of 6: waiting in the queue (number 1) to be read');
    assert.ok(!by.has('sam-shop#9'), 'never somebody else\'s request');
    assert.deepEqual(work.workingOnNow.map((w) => `${w.project}#${w.number}`), ['seed-swap#3'],
      'only what the bot is doing this minute, not what waits on her, the group or the queue');
    assert.deepEqual(work.allowance, { usedThisWeek: '$0.10', weeklyAllowance: '$50.00', left: '$49.90' });
    assert.equal(work.botIsOn, true);

    // #3685: the pipeline as it runs. A request leaves the queue once it has
    // been read, BEFORE its plan and its build, so the queue alone called a
    // request being built "ready; the build is next" and the bot idle.
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 3', [seeds.id]);
    const { rows: [buildSession] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, session_title)
       VALUES ($1, $2, 'active', 'Homeroom bot: #3 Sort by date') RETURNING id`,
      [seeds.id, bot.id],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id)
       VALUES ($1, 3, 'live', 'ready', $2) RETURNING id`,
      [seeds.id, buildSession.id],
    );
    const planning = await mayor.myWork(pool, { userId: ada.id, settings });
    assert.equal(planning.requests.find((r) => r.project === 'seed-swap' && r.number === 3).status,
      'step 2 of 6: writing the plan for the build');
    assert.deepEqual(planning.workingOnNow.map((w) => `${w.project}#${w.number}`), ['seed-swap#3']);
    // Its plan is posted: it is building.
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, 3, $2, 'spec')`,
      [seeds.id, run.id],
    );
    const later = await mayor.myWork(pool, { userId: ada.id, settings });
    assert.equal(later.requests.find((r) => r.number === 3 && r.project === 'seed-swap').status, 'step 3 of 6: building it');

    // A project the bot is not on: it says so, rather than seeming idle.
    const off = await mayor.myWork(pool, { userId: ada.id, settings: { ...settings, liveApps: ['seed-swap'] } });
    assert.equal(off.requests.find((r) => r.project === 'note-board').botBuildsHere, false);
    const projects = await mayor.myProjects(pool, { user: ada, settings: { ...settings, liveApps: ['seed-swap'] } });
    assert.deepEqual(projects.projects.map((p) => `${p.project}:${p.botBuildsHere}`).sort(), ['note-board:false', 'seed-swap:true']);
  });

  await t.test('it reads the platform through the Mayor\'s connector: reads only, on its own grant, closed after', async () => {
    platformCalls.length = 0;
    const closedBefore = platformClosed;
    const seen = [];
    const chat = scripted([
      [['get_request', { slug: 'seed-swap', number: 3 }]],
      (req) => {
        assert.match(lastToolResult(req, 'get_request').result, /Sort the list newest first/);
        return [['reply', { text: 'It asks for newest first.' }]];
      },
    ], seen);
    await turn('what does my sort request say?', chat);
    const offered = seen[0].tools.map((tool) => tool.function.name);
    assert.ok(offered.includes('get_request'));
    assert.ok(!offered.includes('create_request'), 'a write of the Mayor\'s is never offered here');
    assert.deepEqual(platformCalls[0].opened.agentSessionId, null);
    assert.equal(platformCalls[0].opened.rateSubject, `hrbot-dm-${ada.id}`);
    assert.equal(platformCalls[0].opened.userId, ada.id, 'the grant is the person\'s: it sees what they see');
    assert.deepEqual(platformCalls[1], { name: 'get_request', args: { slug: 'seed-swap', number: 3 } });
    assert.equal(platformClosed, closedBefore + 1, 'the grant is closed when the turn ends');
    assert.match(seen[0].messages[0].content, /PLATFORM RULES\n## What Homeroom is/);

    // Without the platform the turn still answers on its own tools.
    const bare = [];
    await turn('hello', scripted([[['reply', { text: 'hi' }]]], bare), { deps: { openMcp: async () => { throw new Error('no grant'); } } });
    assert.ok(!bare[0].tools.some((tool) => tool.function.name === 'get_request'));
    assert.doesNotMatch(bare[0].messages[0].content, /use get_request/);
  });

  await t.test('pictures: hers and a request\'s screenshots reach a model that can look, and only such a model', async () => {
    const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    let shots = 0;
    async function sayWithPicture(text, filename) {
      const message = await say(text);
      shots += 1;
      await pool.query(
        `INSERT INTO conversation_message_attachments
           (id, conversation_id, message_id, user_id, kind, filename, content_type, size_bytes, data)
         VALUES ($1, $2, $3, $4, 'image', $5, 'image/png', $6, $7)`,
        [String(shots).padStart(32, 'a'), opened.conversationId, message.id, ada.id, filename, PNG.length, PNG],
      );
      return message;
    }
    const run = (message, chat, deps) => mayor.runDmTurn(pool, CONFIG, {
      bot, user: ada, settings, conversationId: opened.conversationId, message,
      deps: { chat, apiKey: 'sk-test', openMcp, ...deps },
    });
    const PART = { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } };
    const screenshot = {
      label: '[Homeroom: screenshot 1 of 1 embedded in request #3\'s description, https://x/issue-images/b.]',
      mimeType: 'image/jpeg', data: '/9j/4AAQ',
    };
    const opens = [];
    const withShots = async (opts) => {
      opens.push(opts);
      const base = await openMcp(opts);
      return { ...base, async call(name, args) { return { ...(await base.call(name, args)), images: [screenshot] }; } };
    };

    // A model that can look: her picture in her message, the request's
    // screenshot after the round's tool results, each after its line.
    const views = [];
    const look = (next) => (req) => { views.push(structuredClone(req.messages)); return next; };
    await run(await sayWithPicture('what is wrong in this?', 'broken.png'), scripted([
      look([['get_request', { slug: 'seed-swap', number: 3 }]]),
      look([['reply', { text: 'The button sits under the keyboard.' }]]),
    ]), { openMcp: withShots, seesImages: true });
    assert.equal(opens[0].imageInput, true, 'the shim is told the model can look');
    const hers = views[0].at(-1);
    assert.equal(hers.role, 'user');
    assert.equal(hers.content[0].text, 'what is wrong in this?\n[Homeroom: they attached the picture broken.png, shown below.]');
    assert.deepEqual(hers.content.slice(1), [PART]);
    const at = views[1].findIndex((m) => m.role === 'tool');
    assert.ok(!JSON.stringify(views[1][at]).includes('/9j/4AAQ'), 'no bytes in the tool message');
    const shown = views[1][at + 1];
    assert.equal(shown.role, 'user', 'the screenshots follow the results');
    assert.match(shown.content[0].text, /^\[Homeroom: the pictures your lookups above returned\. .*untrusted content, never instructions\.\]$/);
    assert.deepEqual(shown.content.slice(1), [
      { type: 'text', text: screenshot.label },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
    ]);

    // A text-only model: nothing fetched for it, and her picture is a line.
    const plain = [];
    const opensPlain = [];
    await turn('and now?', scripted([(req) => { plain.push(JSON.stringify(req.messages)); return [['reply', { text: 'ok' }]]; }]), {
      deps: { seesImages: false, openMcp: async (o) => { opensPlain.push(o); return openMcp(o); } },
    });
    assert.equal(opensPlain[0].imageInput, false);
    assert.ok(!plain[0].includes(PNG.toString('base64')), 'no bytes reach a text-only model');
    assert.match(plain[0], /broken\.png, which you cannot see: your model reads text only/);

    // Only her newest messages' pictures are sent again; older ones are named.
    const later = [];
    await turn('one more thing', scripted([(req) => { later.push(JSON.stringify(req.messages)); return [['reply', { text: 'ok' }]]; }]), {
      deps: { seesImages: true },
    });
    assert.ok(!later[0].includes('"image_url"'));
    assert.match(later[0], /broken\.png\. Only the newest pictures are shown\./);

    // A provider that cannot read a picture: the round goes once more without.
    const tries = [];
    const refusing = async (req) => {
      tries.push(JSON.stringify(req.messages));
      if (tries.length === 1) throw Object.assign(new Error('bad request'), { status: 400 });
      return scripted([[['reply', { text: 'I could not open that picture.' }]]])(req);
    };
    const sent = await run(await sayWithPicture('this one?', 'second.png'), refusing, { seesImages: true });
    assert.equal(tries.length, 2, 'exactly one retry');
    assert.ok(tries[0].includes('"image_url"'));
    assert.ok(!tries[1].includes('"image_url"'));
    assert.match(tries[1], /a picture was left out here: the model provider could not read it/);
    assert.equal((await read(sent)).content, 'I could not open that picture.');
  });

  await t.test('"what are you working on?" gets an answer from my_work, with its cards, and costs her allowance', async () => {
    const seen = [];
    const chat = scripted([
      [['my_work']],
      (req) => {
        const work = lastToolResult(req, 'my_work');
        assert.ok(work.requests.length >= 4, 'the model read her work');
        return [['reply', {
          text: 'I\'m sorting Seed swap by date now, and Pin notes is up for a vote.',
          cards: [{ kind: 'request', project: 'seed-swap', number: 3 }, { kind: 'proposal', proposal: proposal.id }],
        }]];
      },
    ], seen);
    const before = await dm.weeklySpentCents(pool, ada.id);
    const sent = await turn('what are you working on right now?', chat);
    const msg = await read(sent);
    assert.equal(msg.content, 'I\'m sorting Seed swap by date now, and Pin notes is up for a vote.');
    assert.equal(msg.sender.id, bot.id);
    const { rows: objects } = await pool.query(
      'SELECT object_type, object_ref FROM conversation_message_objects WHERE message_id = $1 ORDER BY position',
      [sent.messageId],
    );
    assert.deepEqual(objects.map((o) => `${o.object_type}:${o.object_ref}`), ['github_issue:3', `code_proposal:${proposal.id}`]);
    assert.equal(seen.length, 2, 'two model calls');
    assert.equal(seen[0].messages[0].role, 'system');
    assert.match(seen[0].messages[0].content, /call progress first/);
    assert.match(seen[0].messages[0].content, /For the whole list of their requests, call my_work/);
    assert.ok(seen[0].messages.some((m) => m.role === 'user' && /what are you working on/.test(m.content)));
    assert.ok(seen[0].messages.some((m) => m.role === 'assistant' && /^\[about Seed swap request #4, question open\]/.test(m.content)),
      'the bot\'s own messages carry what they were about');
    const { rows: [row] } = await pool.query(
      'SELECT rounds, tools, input_tokens, output_tokens, cost_usd::float8 AS cost, error FROM homeroom_bot_dm_turns ORDER BY id DESC LIMIT 1',
    );
    assert.deepEqual(row, { rounds: 2, tools: ['my_work', 'reply'], input_tokens: 2000, output_tokens: 200, cost: 0.0042, error: null });
    assert.equal(await dm.weeklySpentCents(pool, ada.id), before + 0, 'under a cent rounds away');
    await pool.query('UPDATE homeroom_bot_dm_turns SET cost_usd = 1.25 WHERE id = (SELECT MAX(id) FROM homeroom_bot_dm_turns)');
    assert.equal(await dm.weeklySpentCents(pool, ada.id), before + 125, 'a DM turn counts in her week');
  });

  await t.test('an answer in her own words is passed on: posted on the request, and the request goes first', async () => {
    threadPosts.length = 0;
    const chat = scripted([
      [['answer_question', {}]],
      (req) => {
        assert.deepEqual(lastToolResult(req, 'answer_question').ok, true);
        return [['reply', { text: 'Posted. I\'ll look at it again next.' }]];
      },
    ]);
    const sent = await turn('dark first please', chat);
    assert.equal(threadPosts.length, 1);
    assert.match(threadPosts[0].msg.content, /^dark first please\n\n\(Answered in a chat with Homeroom bot\.\)$/,
      'her own words, as she wrote them, never the model\'s');
    assert.equal(threadPosts[0].msg.thread.ref, 4);
    const question = await conversations.getMessage(pool, ada, opened.conversationId, asked.messageId);
    assert.equal(question.metadata.homeroomBot.status, 'answered');
    const { rows: [q] } = await pool.query('SELECT priority, reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 4', [seeds.id]);
    assert.deepEqual(q, { priority: 0, reason: 'dm_answer' });
    const { rows: objects } = await pool.query('SELECT object_ref FROM conversation_message_objects WHERE message_id = $1', [sent.messageId]);
    assert.deepEqual(objects.map((o) => o.object_ref), [4], 'and its card');
  });

  await t.test('a new request is offered, filed only on File it, as hers, and decided once', async () => {
    const chat = scripted([
      [['my_projects']],
      [['offer_request', { project: 'Note board', title: 'Add a search box', details: 'Search notes by their text.' }]],
      [['reply', { text: 'Want me to file this on Note board?' }]],
    ]);
    const offered = await turn('can you add search to note board?', chat);
    const msg = await read(offered);
    assert.match(msg.content, /^Want me to file this on Note board\?\n\n\*\*Note board\*\* · new request: Add a search box\n\nSearch notes by their text\.$/);
    const meta = msg.metadata.homeroomBot;
    assert.equal(meta.kind, 'confirm');
    assert.deepEqual(meta.answers, ['File it', 'Not now']);
    assert.equal(meta.status, 'open');
    assert.notEqual(meta.mirrors, true, 'nothing about an offer is public yet');
    assert.equal(created.length, 0, 'nothing filed yet');

    const tap = await say('File it', { reply_to_id: offered.messageId });
    const ack = await mayor.decideOffer(pool, CONFIG, { bot, user: ada, settings, message: tap, deps: {} });
    assert.equal(created.length, 1);
    assert.deepEqual({ title: created[0].title, repo: created[0].repo }, { title: 'Add a search box', repo: 'note-board' });
    assert.match(created[0].body, /Search notes by their text\.\n\n---\nFiled from ada_\d+'s chat with Homeroom bot\./);
    const n = 41;
    const { rows: [issue] } = await pool.query('SELECT created_by, title FROM issues WHERE app_id = $1 AND github_issue_number = $2', [notes.id, n]);
    assert.deepEqual(issue, { created_by: ada.id, title: 'Add a search box' });
    const { rows: [mine] } = await pool.query('SELECT user_id FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = $2', [notes.id, n]);
    assert.equal(mine.user_id, ada.id, 'recorded as hers, so its news reaches her DM');
    const { rows: [queued] } = await pool.query('SELECT priority FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [notes.id, n]);
    assert.equal(queued.priority, 0, 'a project the bot acts on looks at it next');
    assert.ok(systemMessages.some((m) => m.thread?.ref === n), 'its thread opens with where it came from');
    const ackMsg = await read(ack);
    assert.match(ackMsg.content, /^Filed: \*\*Note board\*\* request #41: Add a search box\. I'll look at it now/);
    const offerAfter = await read(offered);
    assert.equal(offerAfter.metadata.homeroomBot.status, 'answered');
    assert.equal(offerAfter.metadata.homeroomBot.answer, 'File it');

    const again = await say('File it', { reply_to_id: offered.messageId });
    const second = await mayor.decideOffer(pool, CONFIG, { bot, user: ada, settings, message: again, deps: {} });
    assert.equal((await read(second)).content, 'I already filed that as request #41.');
    assert.equal(created.length, 1, 'filed once');

    const other = await say('something unrelated', { reply_to_id: offered.messageId });
    assert.equal(await mayor.decideOffer(pool, CONFIG, { bot, user: ada, settings, message: other, deps: {} }), null,
      'words that are not a decision go to the model');
  });

  await t.test('Not now files nothing; a project she is not in cannot be offered', async () => {
    const chat = scripted([
      [['offer_request', { project: 'seed-swap', title: 'Trade history', details: 'A list of past swaps.' }]],
      [['reply', { text: 'File it?' }]],
    ]);
    const offered = await turn('add trade history', chat);
    const tap = await say('Not now', { reply_to_id: offered.messageId });
    const ack = await mayor.decideOffer(pool, CONFIG, { bot, user: ada, settings, message: tap, deps: {} });
    assert.equal((await read(ack)).content, 'OK, I won\'t file it.');
    const { rows: [action] } = await pool.query('SELECT status FROM homeroom_bot_dm_actions WHERE message_id = $1', [offered.messageId]);
    assert.equal(action.status, 'declined');
    assert.equal(created.length, 1);

    const refused = scripted([
      [['offer_request', { project: 'sam-shop', title: 'Cheaper prices', details: 'x' }]],
      (req) => {
        assert.match(lastToolResult(req, 'offer_request').error, /not a member of Sam shop/);
        return [['reply', { text: 'You\'re not in Sam shop, so I can\'t file there.' }]];
      },
    ]);
    const sent = await turn('file cheaper prices on sam shop', refused);
    const msg = await read(sent);
    assert.equal(msg.metadata.homeroomBot.kind, 'chat', 'an ordinary answer, no File it');
  });

  await t.test('#3707: each answer quotes the message it answers, and a request she started here is quoted by its news', async () => {
    const run = (message, steps) => mayor.runDmTurn(pool, CONFIG, {
      bot, user: ada, settings, conversationId: opened.conversationId, message,
      deps: { chat: scripted(steps), apiKey: 'sk-test', openMcp },
    });
    // Two questions sent before either is answered: each answer points at its own.
    const first = await say('is Pin notes up for a vote yet?');
    const second = await say('and what about dark mode?');
    const answers = await Promise.all([
      run(first, [[['reply', { text: 'Yes, Pin notes is up for a vote.' }]]]),
      run(second, [[['reply', { text: 'Dark mode waits for your answer.' }]]]),
    ]);
    const [one, two] = await Promise.all(answers.map(read));
    assert.ok(one.id > second.id && two.id > one.id, 'both answers land after both questions');
    assert.equal(one.reply.id, first.id);
    assert.equal(one.reply.content, 'is Pin notes up for a vote yet?');
    assert.equal(two.reply.id, second.id);
    // Its set answers quote too.
    const off = await turn('hello?', async () => { throw new Error('not called'); }, { settings: { ...settings, mode: 'off' } });
    assert.equal((await read(off)).reply.content, 'hello?');

    // The offer quotes what asked for it; File it is answered quoting the tap.
    const ask = await say('could you add tags to note board?');
    const offered = await run(ask, [
      [['offer_request', { project: 'note-board', title: 'Tags', details: 'Tag notes to find them.' }]],
      [['reply', { text: 'Want me to file this?' }]],
    ]);
    assert.equal((await read(offered)).reply.id, ask.id);
    const tap = await say('File it', { reply_to_id: offered.messageId });
    const ack = await read(await mayor.decideOffer(pool, CONFIG, { bot, user: ada, settings, message: tap, deps: {} }));
    assert.equal(ack.reply.id, tap.id);
    const n = ack.metadata.homeroomBot.issueNumber;
    assert.ok(n > 0);

    // Its news later on, from the bot's work on it, quotes where it started.
    const building = await dm.relayIssuePost({ pool, app: notes, issueNumber: n, kind: 'spec', postId: 37071, bot, dm: { building: true } });
    assert.equal((await read(building)).reply.id, ask.id);
    const held = await dm.noteOverAllowance(pool, {
      settings: { ...settings, userWeeklyCents: 100 }, requester: { userId: ada.id, username: ada.username }, app: notes, issueNumber: n, bot,
    });
    assert.equal((await read(held)).reply.id, ask.id);
    const { rows: [built] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at)
       VALUES ($1, $2, 'tags', 'promoted', 'Tags', NOW()) RETURNING id`,
      [notes.id, bot.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, $2, 'live', 'ready', $3)`,
      [notes.id, n, built.id],
    );
    const live = await dm.noteProposalMerged(pool, { id: built.id });
    assert.match((await read(live)).content, /approved and is live now/);
    assert.equal((await read(live)).reply.id, ask.id);

    // A request filed anywhere else started nowhere here; one whose start
    // she deleted is still told, without the quote.
    const elsewhere = await dm.relayIssuePost({ pool, app: seeds, issueNumber: 3, kind: 'spec', postId: 37072, bot, dm: { building: true } });
    assert.equal((await read(elsewhere)).reply, null);
    await conversations.deleteMessage(pool, ada, opened.conversationId, ask.id);
    const proposed = await dm.relayIssuePost({
      pool, app: notes, issueNumber: n, kind: 'proposal', postId: 37073, bot,
      dm: { link: 'https://app.onhomeroom.com/#app/note-board/dev/proposals/1', sessionId: built.id },
    });
    assert.match((await read(proposed)).content, /It's built/);
    assert.equal((await read(proposed)).reply, null);
  });

  await t.test('another person\'s request is never in reach of her tools', async () => {
    const chat = scripted([
      [['request_detail', { project: 'sam-shop', number: 9 }]],
      (req) => {
        const detail = lastToolResult(req, 'request_detail');
        // Sam's project is public, so its request is readable; her work list
        // never carried it, and nothing here can act on it.
        assert.equal(detail.number, 9);
        return [['reply', { text: 'ok' }]];
      },
    ]);
    await turn('tell me about sam shop 9', chat);
    const answered = scripted([[['answer_question', { project: 'sam-shop', number: 9 }]], [['reply', { text: 'no' }]]]);
    threadPosts.length = 0;
    await turn('answer sam', answered);
    assert.equal(threadPosts.length, 0, 'she can only answer questions the bot asked HER');
  });

  await t.test('#3685: progress reads each stage from the records, with its step, time so far, time limit and links', async () => {
    const read = () => progressSvc.progressFor(pool, { userId: ada.id, settings, deps: { domain: 'app.test' } });
    const first = await read();
    const by = new Map(first.rightNow.map((e) => [`${e.project}#${e.number}`, e]));
    const building = by.get('seed-swap#3');
    assert.equal(building.stage, 'building');
    assert.deepEqual([building.step, building.of, building.stepName], [3, 6, 'Build it']);
    assert.equal(building.stepTimeLimitMinutes, 20, 'a build is stopped at its clock: the most it can take');
    assert.equal(building.busyNow, true);
    assert.ok(Number.isInteger(building.minutesSoFar));
    assert.deepEqual(building.links, {
      project: 'https://app.test/#app/seed-swap', request: 'https://app.test/#app/seed-swap/dev/issues/3',
    });
    // Her answer to its question (passed on above) put it first in the queue.
    assert.equal(by.get('seed-swap#4').stage, 'queued');
    assert.match(by.get('seed-swap#4').doing, /^waiting in the queue \(number 1\) to be read$/);
    assert.equal(by.get('seed-swap#4').busyNow, false);
    assert.equal(by.get('note-board#5').waitingOn, 'the group');
    assert.equal(by.get('note-board#5').proposal.votesNeeded > 0, true, 'and how many votes it needs');
    assert.ok(!first.rightNow.some((e) => e.project === 'sam-shop'), 'never somebody else\'s');

    // The proposal's checks, as they run and as they end.
    await pool.query(
      `UPDATE chat_sessions SET check_state = 'pending', check_phase = 'testing', checks_checked_at = NOW(),
              checks_progress = '{"ran": 120, "expected": 338, "failed": 0}' WHERE id = $1`,
      [proposal.id],
    );
    const running = (await read()).rightNow.find((e) => e.project === 'note-board' && e.number === 5);
    assert.equal(running.doing, 'its proposal is up, and its checks are running: 120 of 338 done, 0 failed so far');
    assert.equal(running.step, 4);
    await pool.query(
      `UPDATE chat_sessions SET check_state = 'failing', check_phase = NULL, checks_progress = NULL,
              test_results = '[{"name": "home", "status": "fail"}, {"name": "list", "status": "pass"}]' WHERE id = $1`,
      [proposal.id],
    );
    const failing = (await read()).rightNow.find((e) => e.project === 'note-board' && e.number === 5);
    assert.equal(failing.stage, 'checks_failed');
    assert.equal(failing.doing, 'its proposal is up, and its checks failed (1 check did not pass)');
    // Merged: no longer in progress, and among what finished lately.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [proposal.id]);
    const merged = await read();
    assert.ok(!merged.rightNow.some((e) => e.project === 'note-board' && e.number === 5));
    const done = merged.finishedLately.find((e) => e.project === 'note-board' && e.number === 5);
    assert.equal(done.outcome, 'approved and live');
    assert.equal(done.links.proposal, `https://app.test/#app/note-board/dev/proposals/${proposal.id}`);
    await pool.query(
      `UPDATE chat_sessions SET status = 'promoted', merged_at = NULL, check_state = 'passing', test_results = '[]'
        WHERE id = $1`,
      [proposal.id],
    );
  });

  // Ada's new project, Ear trainer: created with a description two minutes
  // ago, and still being set up, as in the report.
  const { rows: [earRow] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, created_at)
     VALUES ('Ear trainer', 'ear-trainer', 'creating', $1, 'public', 'public', NOW() - INTERVAL '2 minutes')
     RETURNING id`,
    [ada.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, created_at)
     VALUES ($1, $2, 'Train your ear with intervals and chords.', NOW() - INTERVAL '2 minutes')`,
    [earRow.id, ada.id],
  );
  const settingUp = { read: (slug) => (slug === 'ear-trainer' ? { phase: 'repository', startedAt: new Date().toISOString() } : null) };

  await t.test('#3685: "how far along are you?" while her project is set up gets the step it is on', async () => {
    const chat = scripted([
      [['progress']],
      (req) => {
        const ear = lastToolResult(req, 'progress').rightNow.find((e) => e.project === 'ear-trainer');
        assert.deepEqual(
          { step: ear.step, of: ear.of, stepName: ear.stepName, doing: ear.doing, minutesSoFar: ear.minutesSoFar, busyNow: ear.busyNow },
          { step: 1, of: 7, stepName: 'Set up the project', doing: 'setting up the project: part 2 of 4, making its code repository', minutesSoFar: 2, busyNow: true },
        );
        assert.equal(ear.links.project, 'https://app.test/#app/ear-trainer');
        return [['reply', {
          text: 'Step 1 of 7: I\'m still setting up Ear trainer, making its code repository. 2 minutes so far.',
          cards: [{ kind: 'project', project: 'ear-trainer' }],
        }]];
      },
    ]);
    const sent = await turn('how far along are you?', chat, { deps: { creationPhase: settingUp, domain: 'app.test' } });
    assert.equal((await read(sent)).content, 'Step 1 of 7: I\'m still setting up Ear trainer, making its code repository. 2 minutes so far.');
    const { rows: objects } = await pool.query(
      'SELECT object_type, object_ref FROM conversation_message_objects WHERE message_id = $1', [sent.messageId],
    );
    assert.deepEqual(objects.map((o) => o.object_type), ['app'], 'and the project as a card');
    const { rows: [row] } = await pool.query('SELECT tools, error FROM homeroom_bot_dm_turns ORDER BY id DESC LIMIT 1');
    assert.deepEqual(row, { tools: ['progress', 'reply'], error: null });
  });

  await t.test('#3685: a failed model request is asked again on a fresh route, with more room after a cut-off', async () => {
    const asks = [];
    const chat = async (req) => {
      asks.push({ max: req.maxOutputTokens, session: req.sessionId, choice: req.toolChoice });
      if (asks.length === 1) throw Object.assign(new Error('cut off'), { code: 'output_limit' });
      return scripted([[['reply', { text: 'Ear trainer is still being set up.' }]]])(req);
    };
    const sent = await turn('how far along are you?', chat);
    assert.equal((await read(sent)).content, 'Ear trainer is still being set up.');
    assert.deepEqual(asks.map((a) => a.max), [900, mayor.RETRY_OUTPUT_TOKENS]);
    assert.match(asks[0].session, new RegExp(`^hrbot-dm-${ada.id}-\\d+$`), 'a provider route of this turn, not of every turn of hers');
    assert.equal(asks[1].session, `${asks[0].session}-r2`);
    const { rows: [row] } = await pool.query('SELECT error FROM homeroom_bot_dm_turns ORDER BY id DESC LIMIT 1');
    assert.equal(row.error, null, 'the turn answered');

    // A provider that refuses the forced reply on the last round: the round
    // goes again with the choice left to the model.
    const forced = [];
    const looping = async (req) => {
      forced.push(req.toolChoice);
      if (typeof req.toolChoice === 'object') throw Object.assign(new Error('no endpoints'), { code: 'invalid_request', status: 404 });
      return scripted([[forced.length < mayor.MAX_ROUNDS ? ['my_projects'] : ['reply', { text: 'Done looking.' }]]])(req);
    };
    const answered = await turn('which projects do I have?', looping);
    assert.equal((await read(answered)).content, 'Done looking.');
    assert.deepEqual(forced.slice(-2), [{ type: 'function', function: { name: 'reply' } }, 'auto']);
  });

  await t.test('#3685: when the model still cannot answer, a question about her work is answered from the records', async () => {
    // The report: the model read her work, then failed. It used to say "I
    // couldn't answer just now."
    let calls = 0;
    const breaks = async (req) => {
      calls += 1;
      if (calls === 1) return scripted([[['progress']]])(req);
      throw Object.assign(new Error('bad request'), { code: 'invalid_request', status: 400 });
    };
    const sent = await turn('how far along are you?', breaks, { deps: { creationPhase: settingUp } });
    const msg = await read(sent);
    assert.notEqual(msg.content, mayor.BROKEN_TEXT);
    assert.match(msg.content, /^I couldn't put a full answer together just now\. Here is where things stand, from my records:\n\n/);
    assert.match(msg.content, /\n- Ear trainer, its first version: step 1 of 7, setting up the project: part 2 of 4, making its code repository, for 2 minutes so far\./);
    assert.match(msg.content, /\n- Seed swap request #3 \(Sort by date\): step 3 of 6, building it, for (under a minute|\d+ minutes?) so far\./);
    assert.ok(!/Sam/.test(msg.content), 'only hers');
    const { rows: objects } = await pool.query(
      'SELECT object_type FROM conversation_message_objects WHERE message_id = $1 ORDER BY position', [sent.messageId],
    );
    assert.ok(objects.length > 0, 'with cards for what it names');
    const { rows: [row] } = await pool.query('SELECT error FROM homeroom_bot_dm_turns ORDER BY id DESC LIMIT 1');
    assert.equal(row.error, 'invalid_request', 'the failure is still recorded');

    // A model down from the first request: the question alone is enough.
    const down = async () => { throw Object.assign(new Error('no key'), { code: 'authentication' }); };
    const update = await read(await turn('any update?', down, { deps: { creationPhase: settingUp } }));
    assert.match(update.content, /^I couldn't put a full answer together just now\. Here is where things stand/);
    // Anything else is not answered from the records, which are not an
    // answer to every question. #3733: and a key that does not work is said
    // as that, never as "try again in a minute", which cannot help.
    const other = await read(await turn('can you make the buttons bigger?', down));
    assert.equal(other.content, mayor.KEY_TEXT);
    const { rows: [keyRow] } = await pool.query('SELECT error, failures, fallback FROM homeroom_bot_dm_turns ORDER BY id DESC LIMIT 1');
    assert.deepEqual(keyRow, { error: 'authentication', failures: ['r1:authentication'], fallback: 'key' },
      'asked once: no retry gets past the key');
  });

  // #3733, the report: in the bot's DM, a question about a project's lessons
  // got "I couldn't answer just now. Try again in a minute."; sent again
  // seconds later, it was answered. Each test below is a way a turn ended
  // there, and must now end with an answer.
  const EVAN = 'Shouldn\'t we just always do the number in the lesson? If you want fewer you can just do a different lesson?';
  const lastTurn = async () => (await pool.query(
    'SELECT rounds, error, failures, fallback FROM homeroom_bot_dm_turns ORDER BY id DESC LIMIT 1',
  )).rows[0];
  const replyWith = (text) => [['reply', { text }]];
  const { rows: [{ id: turnsBefore }] } = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM homeroom_bot_dm_turns');

  await t.test('#3733: a busy provider (HTTP 429) is asked again after a wait, and the question is answered', async () => {
    const waits = [];
    const sessions = [];
    const busy = async (req) => {
      sessions.push(req.sessionId);
      if (sessions.length < 3) {
        throw Object.assign(new Error('Global Chat model request failed (HTTP 429)'), { code: 'rate_limited', status: 429 });
      }
      return scripted([replyWith('Yes: one number per lesson. Want me to file that as a request?')])(req);
    };
    const sent = await turn(EVAN, busy, { deps: { sleep: async (ms) => { waits.push(ms); } } });
    const msg = await read(sent);
    assert.equal(msg.content, 'Yes: one number per lesson. Want me to file that as a request?');
    assert.equal(msg.reply.content, EVAN, 'quoting what it answers');
    assert.deepEqual(waits, mayor.RATE_LIMIT_WAITS_MS, 'a few seconds, then a few more');
    assert.deepEqual(sessions.map((id) => id.replace(/^hrbot-dm-\d+-\d+/, '')), ['', '-r2', '-r3'], 'each on a fresh route');
    assert.deepEqual(await lastTurn(), {
      rounds: 1, error: null, failures: ['r1:rate_limited:429', 'r1:rate_limited:429'], fallback: null,
    }, 'answered, and what it got past is on record');
  });

  await t.test('#3733: calls a provider sent without an id or arguments go back well formed', async () => {
    // A provider as strict as a chat template: a request whose calls have no
    // id, share one, carry arguments that are not JSON, or answer a call that
    // is not there is refused.
    const strict = (steps) => {
      let n = 0;
      return async (req) => {
        const calls = req.messages.flatMap((m) => m.tool_calls || []);
        const ids = calls.map((c) => c.id);
        const json = (text) => { try { JSON.parse(text); return true; } catch { return false; } };
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length || !calls.every((c) => json(c.function.arguments))
            || req.messages.some((m) => m.role === 'tool' && !ids.includes(m.tool_call_id))) {
          throw Object.assign(new Error('Global Chat model request failed (HTTP 400)'), { code: 'invalid_request', status: 400 });
        }
        const step = steps[Math.min(n, steps.length - 1)];
        n += 1;
        return { content: '', toolCalls: step, usage: {} };
      };
    };
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });
    const sent = await turn('which of my projects can I file on?', strict([
      [call('', 'my_projects', '')],
      [call('', 'my_work', ''), call('', 'progress', '')],
      [call('call_0', 'reply', JSON.stringify({ text: 'Seed swap and Note board.' }))],
    ]));
    assert.equal((await read(sent)).content, 'Seed swap and Note board.');
    assert.deepEqual(await lastTurn(), { rounds: 3, error: null, failures: [], fallback: null }, 'no request was refused');
  });

  await t.test('#3733: a request the providers refuse still gets a plain answer from the conversation', async () => {
    const seen = [];
    const refusing = async (req) => {
      seen.push(req);
      if (req.tools.length > 1) {
        throw Object.assign(new Error('Global Chat model request failed (HTTP 400)'), { code: 'invalid_request', status: 400 });
      }
      return scripted([replyWith('Good point: one number per lesson is simpler. I could not check the proposal just now.')])(req);
    };
    const sent = await turn(EVAN, refusing);
    const msg = await read(sent);
    assert.equal(msg.content, 'Good point: one number per lesson is simpler. I could not check the proposal just now.');
    assert.notEqual(msg.content, mayor.BROKEN_TEXT);
    const plain = seen.at(-1);
    assert.deepEqual(plain.tools.map((tool) => tool.function.name), ['reply'], 'no lookups this time');
    assert.equal(plain.toolChoice, 'auto');
    assert.equal(plain.maxOutputTokens, mayor.RETRY_OUTPUT_TOKENS);
    assert.match(plain.messages[0].content, /\n\nTHIS ANSWER\nYour lookups could not be finished for this message/);
    assert.ok(plain.messages.length <= 9, 'the newest messages only');
    assert.deepEqual(plain.messages.at(-1), { role: 'user', content: EVAN }, 'her message last, as words');
    assert.equal(new Set(seen.map((r) => r.sessionId)).size, seen.length, 'every request on its own route');
    assert.deepEqual(await lastTurn(), {
      rounds: 1, error: 'invalid_request', fallback: 'plain',
      failures: ['r1:invalid_request:400', 'r1:invalid_request:400', 'r1:invalid_request:400'],
    });
  });

  await t.test('#3733: an admin can read why a DM failed, with its codes, and what answered instead', async () => {
    const summary = await homeroomBot.dmChatSummary(pool);
    assert.ok(summary.recovered >= 3, 'turns that answered only after a failed request was asked again');
    assert.ok(summary.failed >= 3);
    const plain = summary.recentFailures.find((f) => f.fallback === 'plain');
    assert.deepEqual(
      { username: plain.username, error: plain.error, failures: plain.failures, rounds: plain.rounds },
      { username: ada.username, error: 'invalid_request', failures: ['r1:invalid_request:400', 'r1:invalid_request:400', 'r1:invalid_request:400'], rounds: 1 },
    );
    assert.ok(summary.recentFailures.some((f) => f.error === null && f.failures.includes('r1:rate_limited:429')),
      'a recovered turn is listed with what it got past');
    assert.ok(!JSON.stringify(summary).includes('lesson'), 'never what was said');
    // These turns are not her hourly allowance for the tests below.
    await pool.query('DELETE FROM homeroom_bot_dm_turns WHERE id > $1', [turnsBefore]);
  });

  await t.test('#3733: an answer passed on before the model failed is said, never "try again"', async () => {
    threadPosts.length = 0;
    await dm.relayIssuePost({
      pool, app: notes, issueNumber: 6, kind: 'question', postId: 37331, bot,
      dm: { question: 'Share by link or by email?', answers: ['Link', 'Email'] },
    });
    let calls = 0;
    const failsAfter = async (req) => {
      calls += 1;
      if (calls === 1) return scripted([[['answer_question', { project: 'note-board', number: 6 }]]])(req);
      throw Object.assign(new Error('Global Chat model request failed (HTTP 503)'), { code: 'provider_unavailable', status: 503 });
    };
    const sent = await turn('by link please', failsAfter);
    const msg = await read(sent);
    assert.equal(threadPosts.length, 1, 'posted once; "try again" would have posted it twice');
    assert.equal(msg.content, 'I posted your answer on Note board request #6\'s public discussion, and I\'ll look at the request again next.');
    const { rows: objects } = await pool.query(
      'SELECT object_type, object_ref FROM conversation_message_objects WHERE message_id = $1', [sent.messageId],
    );
    assert.deepEqual(objects.map((o) => `${o.object_type}:${o.object_ref}`), ['github_issue:6']);
    const row = await lastTurn();
    assert.equal(row.error, 'provider_unavailable');
    assert.equal(row.fallback, 'posted');
  });

  await t.test('#3733: an answer with nothing in it is asked again', async () => {
    let n = 0;
    const blank = async (req) => {
      n += 1;
      if (n === 1) return { content: '  ', toolCalls: [], usage: { inputTokens: 10, outputTokens: 0, costUsd: 0 } };
      return scripted([replyWith('One number per lesson it is.')])(req);
    };
    const sent = await turn(EVAN, blank);
    assert.equal((await read(sent)).content, 'One number per lesson it is.', 'not "I\'m not sure what to say to that"');
    assert.deepEqual(await lastTurn(), { rounds: 1, error: null, failures: ['r1:empty_answer'], fallback: null });
  });

  await t.test('#3733: a database read that fails is answered around, and a turn that cannot go on still says so', async () => {
    const failing = (pattern) => new Proxy(pool, {
      get(target, key) {
        if (key === 'query') {
          return (sql, ...rest) => (typeof sql === 'string' && pattern.test(sql)
            ? Promise.reject(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))
            : target.query(sql, ...rest));
        }
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const run = (db, message, chat) => mayor.runDmTurn(db, CONFIG, {
      bot, user: ada, settings, conversationId: opened.conversationId, message,
      deps: { chat, apiKey: 'sk-test', openMcp, sleep: async () => {} },
    });
    // The conversation cannot be read: her message alone is answered.
    const seen = [];
    const noHistory = failing(/FROM conversation_messages\s+WHERE conversation_id = \$1 AND id <= \$2/);
    const sent = await run(noHistory, await say(EVAN), scripted([replyWith('One number per lesson sounds right.')], seen));
    assert.equal((await read(sent)).content, 'One number per lesson sounds right.');
    const asked = seen[0].messages;
    assert.deepEqual(asked.slice(1, 2), [{ role: 'user', content: EVAN }]);
    assert.equal(asked[2].role, 'assistant', 'nothing before her message but the prompt');
    assert.deepEqual(await lastTurn(), { rounds: 1, error: null, failures: ['context:history:57P01'], fallback: null });

    // A read the turn cannot go on without: it used to end with no answer and
    // no record at all.
    const noCount = failing(/SELECT COUNT\(\*\)::int AS n FROM homeroom_bot_dm_turns/);
    const crashed = await run(noCount, await say('hello?'), async () => { throw new Error('not called'); });
    assert.equal((await read(crashed)).content, mayor.BROKEN_TEXT);
    assert.deepEqual(await lastTurn(), { rounds: 0, error: 'turn_failed:57P01', failures: [], fallback: 'broken' });

    // One that fails after the model has run: what it cost and what failed
    // on the way are still on record.
    let asks = 0;
    const thenDown = async (req) => {
      asks += 1;
      if (asks === 1) return { ...await scripted([[['progress']]])(req), usage: { inputTokens: 500, outputTokens: 50, costUsd: 0.01 } };
      throw Object.assign(new Error('Could not reach Global Chat model'), { code: 'network' });
    };
    const noCards = failing(/WHERE slug = LOWER\(\$1\) OR LOWER\(name\) = LOWER\(\$1\)/);
    const late = await run(noCards, await say('how far along are you?'), thenDown);
    assert.equal((await read(late)).content, mayor.BROKEN_TEXT);
    const { rows: [lateRow] } = await pool.query(
      'SELECT rounds, error, failures, fallback, cost_usd::float8 AS cost FROM homeroom_bot_dm_turns ORDER BY id DESC LIMIT 1',
    );
    assert.deepEqual(lateRow, {
      rounds: 2, error: 'turn_failed:57P01', failures: ['r2:network', 'r2:network', 'r2:network'], fallback: 'broken', cost: 0.01,
    });
    await pool.query('DELETE FROM homeroom_bot_dm_turns WHERE id > $1', [turnsBefore]);
  });

  await t.test('no answer while the bot is off, past the hourly limit, without a key, or when the model fails', async () => {
    let called = 0;
    const counting = async () => { called += 1; throw new Error('should not be called'); };
    const off = await turn('hi', counting, { settings: { ...settings, mode: 'off' } });
    assert.equal((await read(off)).content, mayor.OFF_TEXT);
    const nokey = await turn('hi', counting, { deps: { apiKey: null } });
    assert.equal((await read(nokey)).content, mayor.KEY_TEXT);
    assert.equal(called, 0);
    // #3733: "Try again in a minute" only once every attempt and the plain
    // answer have failed too.
    let tries = 0;
    const failing = await turn('hi', async () => { tries += 1; const e = new Error('provider down'); e.code = 'network'; throw e; });
    assert.equal((await read(failing)).content, mayor.BROKEN_TEXT);
    assert.equal(tries, mayor.MAX_ATTEMPTS + 1, 'every attempt of the round, then one plain request');
    const { rows: [row] } = await pool.query('SELECT error, failures, fallback FROM homeroom_bot_dm_turns ORDER BY id DESC LIMIT 1');
    assert.deepEqual(row, { error: 'network', failures: ['r1:network', 'r1:network', 'r1:network', 'plain:network'], fallback: 'broken' });
    // A 403 is how OpenRouter also refuses a flagged message: not a key an
    // admin must fix.
    const flagged = await turn('hi', async () => { throw Object.assign(new Error('HTTP 403'), { code: 'authentication', status: 403 }); });
    assert.equal((await read(flagged)).content, mayor.BROKEN_TEXT);
    await pool.query(
      `INSERT INTO homeroom_bot_dm_turns (user_id) SELECT $1 FROM generate_series(1, $2)`,
      [ada.id, mayor.MAX_TURNS_PER_HOUR],
    );
    const busy = await turn('hi', counting);
    assert.equal((await read(busy)).content, mayor.BUSY_TEXT);
    assert.equal(called, 0);
    await pool.query('DELETE FROM homeroom_bot_dm_turns WHERE cost_usd IS NULL AND model IS NULL');
  });

  await t.test('her turns run one after another, never side by side', async () => {
    let active = 0;
    let most = 0;
    const slow = async () => {
      active += 1; most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      const calls = [{ id: 'c', type: 'function', function: { name: 'reply', arguments: '{"text":"ok"}' } }];
      return { content: '', toolCalls: calls, assistantMessage: { role: 'assistant', content: null, tool_calls: calls }, usage: {} };
    };
    await Promise.all([turn('one', slow), turn('two', slow), turn('three', slow)]);
    assert.equal(most, 1);
    assert.equal(mayor._chainsForTests(), 0, 'nothing is left waiting');
  });
});
