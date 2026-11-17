'use strict';

// #6784 (17 Nov 2026): a new project made from an idea thread in a private
// chat with Homeroom bot, against the FULL PostgreSQL schema, through the
// real create route (POST /api/apps with `thread`).
//
// What this pins:
//   1. Only the person's own idea thread with no project makes one. Someone
//      else's, or one already made into a project, is refused.
//   2. Its brief is built from the thread: what they sent first, the bot's
//      newest plan reply (never an earlier one it took back), their answers
//      and their own words.
//   3. The link is recorded both ways: homeroom_bot_first_versions keeps the
//      thread, the thread's row is the new project's, and its head says so.
//   4. The first version's plan is written from the thread, not a line of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/ws'), {
  pushConversationEvent: () => 1, pushToUser: () => 1, pushNotificationToUser: () => 1,
  sendSystemMessage: async () => ({ id: 1 }), pushIssueUpdate() {}, sendBotMessage: async () => ({ id: 1 }), pushAppUpdate() {},
});
stub(require.resolve('../src/services/mobile-push'), { scheduleBadgeSync() { return false; } });
stub(require.resolve('../src/services/app-creator'), { createApp: async () => {} });
stub(require.resolve('../src/services/app-forker'), { forkApp: async () => {} });
stub(require.resolve('../src/services/caddy'), { productionHostname: (slug) => `${slug}.example.test`, USERNODE_DOMAIN: 'example.test' });
stub(require.resolve('../src/services/docker'), { getHostPort: async () => null });
stub(require.resolve('../src/services/github'), { parseGithubUrl: () => null, isEnabled: () => false, canActOn: () => false });
stub(require.resolve('../src/services/main-drift-poller'), { checkAndRedeployOne: async () => ({}) });
stub(require.resolve('../src/services/app-secrets'), {});
stub(require.resolve('../src/services/rename-pr'), {});
stub(require.resolve('../src/services/staging'), { MissingSecretsError: class extends Error {} });

let pool = null;
require('../src/db/pool').getPool = () => pool;
const wsBus = require('../src/services/ws-bus');
wsBus.publish = () => {};
wsBus.publishBatched = () => {};

const dm = require('../src/services/homeroom-bot-dm');
const privateThreads = require('../src/services/private-threads');
const fvPlan = require('../src/services/first-version-plan');
const { appRoutes } = require('../src/routes/apps');

const PLAN = [
  'Here is the plan as it now stands, with a real map and real place search kept.',
  '- Home page: popular public lists, ranked by how many people saved them',
  '- Lists: public or private, who can see each',
  '- Adding places: search, results on a real map, tap one to add it',
  '- Sharing: invite link with a role, or by username; viewer and editor',
].join('\n');

test('a project made from an idea thread', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `thread_project_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 8 });
  let server;
  t.after(async () => {
    server?.close();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'shadow') ON CONFLICT (key) DO UPDATE SET value = 'shadow'`);

  async function person(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [username, synthetic],
    );
    return { id: row.id, username: row.username, isAdmin: false, canAdminWrite: true, hasPlatformAccess: true };
  }
  const bot = await person('homeroom_bot', { synthetic: true });
  const ada = await person('th_ada');
  const sam = await person('th_sam');
  const eve = await person('th_eve');

  // A private thread the person started with the bot: their root, two bot
  // replies, an answered questions card, and their own reply.
  async function ideaThread(user) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [user.id]);
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [c.id, user.id, bot.id]);
    const { rows: [root] } = await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, $3) RETURNING id`,
      [c.id, user.id, 'I want an app for saving places into lists.']);
    const reply = async (senderId, content, metadata = {}) => {
      const { rows: [m] } = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata, thread_root_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [c.id, senderId, content, JSON.stringify(metadata), root.id]);
      return m.id;
    };
    // An earlier plan it took back: never in the brief.
    await reply(bot.id, 'A plan for saved places:\n- Lists only\n- No real maps, use a list of names');
    await reply(user.id, 'Real maps are the whole point.');
    await reply(bot.id, PLAN, { homeroomBot: { kind: 'chat', newProject: true } });
    await reply(bot.id, 'Two questions before I write the request.', {
      homeroomBot: {
        card: {
          type: 'questions', v: 1,
          questions: [{ question: 'Who can see a list?' }, { question: 'Who can edit it?' }],
          answered: ['Only people it is shared with', 'Viewers and editors'],
        },
      },
    });
    await reply(user.id, 'Yes, both of those.');
    return { conversationId: c.id, rootId: root.id };
  }

  const web = express();
  web.use(express.json());
  let signedIn = ada;
  web.use((req, _res, next) => { req.user = signedIn; next(); });
  web.use(appRoutes({ maxApps: 0 }));
  server = web.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, as = ada) => {
    signedIn = as;
    const res = await fetch(`${base}/api/apps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };

  const thread = await ideaThread(ada);
  const BODY = {
    name: 'Saved Places Lists', audience: 'invited', from: 'create',
    brief: 'An app for collecting saved places into lists on a real map.',
    thread: { rootId: thread.rootId },
  };

  let made;
  await t.test('only the person\'s own idea thread with no project makes one', async () => {
    // The malformed ones are asked as eve: app creation is 5 an hour for
    // each person, and a refusal counts as one.
    const own = await ideaThread(eve);
    assert.equal((await post({ ...BODY, thread: { rootId: 'x' } }, eve)).status, 400, 'a rootId that is not one');
    assert.equal((await post({ ...BODY, brief: '' }, eve)).status, 400, 'no plan to start from');
    assert.equal((await post({ ...BODY, design: { rootId: own.rootId } }, eve)).status, 400, 'a design and a thread together');
    assert.equal((await post(BODY, sam)).status, 404, 'nobody else\'s thread');
    // A design thread is not an idea thread.
    const drawn = await ideaThread(eve);
    const { rows: [row] } = await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, kind, state)
       VALUES ($1, $2, $3, 'design', 'open') RETURNING id`,
      [eve.id, drawn.conversationId, drawn.rootId]);
    await pool.query(`INSERT INTO design_threads (private_thread_id, title, surface, width, height) VALUES ($1, 'Places', 'app', 390, 844)`, [row.id]);
    assert.equal((await post({ ...BODY, thread: { rootId: drawn.rootId } }, eve)).status, 409, 'a design thread');

    const res = await post(BODY);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    made = res.data.app;
    const again = await post({ ...BODY, name: 'Saved Places Lists two' });
    assert.equal(again.status, 409);
    assert.match(again.data.error, /already made Saved Places Lists/, 'it says which project it made');
  });

  await t.test('its brief is the plan agreed in the thread, and the link is recorded both ways', async () => {
    const { rows: [fv] } = await pool.query('SELECT * FROM homeroom_bot_first_versions WHERE app_id = $1', [made.id]);
    assert.match(fv.brief, /^An app for collecting saved places into lists on a real map\./, 'what they sent comes first');
    assert.match(fv.brief, /The plan agreed with Homeroom bot in their thread:\nHere is the plan as it now stands/);
    for (const point of ['- Home page: popular public lists', '- Lists: public or private', '- Adding places: search', '- Sharing: invite link']) {
      assert.ok(fv.brief.includes(point), `the plan's point: ${point}`);
    }
    assert.doesNotMatch(fv.brief, /No real maps/, 'an earlier reply the bot took back is left out');
    assert.match(fv.brief, /Their answers:\n- Who can see a list\? Only people it is shared with\n- Who can edit it\? Viewers and editors/);
    assert.match(fv.brief, /Their own words in the thread \(newest first\):\n- Yes, both of those\.\n- Real maps are the whole point\./);

    const { rows: [row] } = await pool.query(
      'SELECT id, app_id, state, kind FROM private_threads WHERE root_message_id = $1 AND user_id = $2',
      [thread.rootId, ada.id]);
    assert.deepEqual({ app: row.app_id, state: row.state, kind: row.kind }, { app: made.id, state: 'filed', kind: 'idea' });
    assert.equal(Number(fv.idea_thread_id), Number(row.id), 'the first version remembers the thread');

    const where = await privateThreads.stateOf(pool, { user: ada, rootId: thread.rootId, bot });
    assert.equal(where.made, true, 'its head says it was made into a project');
    assert.equal(where.app.slug, made.slug);
  });

  await t.test('the first version is planned from the thread, not one line of it', async () => {
    await pool.query(`UPDATE homeroom_bot_first_versions SET early_plan_status = 'pending' WHERE app_id = $1`, [made.id]);
    let prompt = '';
    const llm = {
      isEnabled: () => true,
      estimateCostCents: () => 0,
      async generateFirstVersionPlan(request) {
        prompt = String(request.user);
        return {
          text: JSON.stringify({
            plan: ['Save a place to a list', 'See every list on a map', 'Share a list with a role'],
            choices: [], build_note: 'One map screen with a list of saved places.', assumptions: [],
          }),
          model: 'test-model',
        };
      },
    };
    const out = await fvPlan.runEarlyPlan(pool, { appId: made.id }, { llm });
    assert.equal(out.planned, true, 'a plan was written');
    assert.match(prompt, /THE THREAD IT CAME FROM:/, 'the plan is written knowing where it came from');
    assert.match(prompt, /The plan agreed with Homeroom bot in their thread:[\s\S]*- Sharing: invite link/, 'and from the whole plan');
    const { rows: [fv] } = await pool.query('SELECT early_plan FROM homeroom_bot_first_versions WHERE app_id = $1', [made.id]);
    assert.deepEqual(fv.early_plan.bullets, ['Save a place to a list', 'See every list on a map', 'Share a list with a role']);
  });

  await t.test('the first version\'s thread quotes the plan it came from', async () => {
    const { rows } = await pool.query(
      `SELECT id, content, metadata, thread_root_id FROM conversation_messages
        WHERE metadata->'homeroomBot'->>'kind' = 'first_version_source'
          AND metadata->'homeroomBot'->>'appSlug' = $1`,
      [made.slug]);
    assert.equal(rows.length, 1, 'one source message');
    assert.match(rows[0].content, new RegExp(
      `^Made from your thread \\[I want an app for saving places into lists\\.\\]\\(#homeroom-bot/thread/${thread.rootId}\\)\\. The plan you agreed there:`));
    assert.match(rows[0].content, /> - Sharing: invite link with a role, or by username; viewer and editor/, 'the plan as a quote');
    // It is said in the project's own first-version thread, after the bot's
    // first line there.
    const { rows: [ft] } = await pool.query(
      'SELECT kind, app_id FROM private_threads WHERE root_message_id = $1', [rows[0].thread_root_id]);
    assert.deepEqual(ft, { kind: 'first_version', app_id: made.id });
  });
});
