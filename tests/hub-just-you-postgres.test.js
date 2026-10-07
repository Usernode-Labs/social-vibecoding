'use strict';

// The hub of a project nobody else is in yet, as GET /api/apps/:slug/community
// answers it (frontend/src/features/dev-board/workshop/: the hero, the First
// version card and Share it read this record; tests/hub-just-you.test.js
// pins how they draw it).
//
// Evan, 5 Oct 2026, of a brand-new "Just you" project Homeroom bot was still
// building: "The initial hub if no one has joined is really sad. It should
// come with a short description, made the build stage, etc." The record had
// no description to give (the first session's own words go to Homeroom bot
// as the project's first request, not into dapp.json), and nothing about the
// build, which only the App tab and the made screen read.
//
// What only the real records can show: the description falls back to the
// first sentence of what the project was made from, dapp.json's own line
// wins once there is one, and the first version moves through the same steps
// the App tab reads (homeroom-bot-dm.js firstVersionState): set up, its plan
// waiting on its maker (from the bot's own plan path), ready to try, and
// gone once it is live. Only its maker is told what it waits on from them or
// handed their chat with the bot.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/hub-just-you-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Realtime and push are process-wide singletons (the bot's DM sends through
// them), and the apps router's infrastructure is not what this is about.
stub(require.resolve('../src/services/ws'), {
  pushConversationEvent: () => 1, pushToUser: () => 1, pushNotificationToUser: () => 1,
  sendSystemMessage: async () => ({ id: 1 }), pushIssueUpdate() {},
});
stub(require.resolve('../src/services/mobile-push'), { scheduleBadgeSync() { return false; } });
stub(require.resolve('../src/services/app-creator'), { createApp: async () => {} });
stub(require.resolve('../src/services/app-forker'), { forkApp: async () => {} });
stub(require.resolve('../src/services/caddy'), { productionHostname: (slug) => `${slug}.example.test`, USERNODE_DOMAIN: 'example.test' });
stub(require.resolve('../src/services/docker'), { getHostPort: async () => null });
stub(require.resolve('../src/services/github'), { parseGithubUrl: () => null, isEnabled: () => false });
stub(require.resolve('../src/services/main-drift-poller'), { checkAndRedeployOne: async () => ({}) });
stub(require.resolve('../src/services/app-secrets'), {});
stub(require.resolve('../src/services/rename-pr'), { findVisibilityPr: async () => null });
stub(require.resolve('../src/services/staging'), { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });

let pool = null;
require('../src/db/pool').getPool = () => pool;

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const conversations = require('../src/services/conversations');
const { appRoutes } = require('../src/routes/apps');
const { createSchemaDatabase } = require('./lib/schema-database');

const BRIEF = 'Plan hikes around Geneva with friends. Pick a trail, a date and who is coming, '
  + 'and see the weather for the day.';

test('a just-you project\'s hub: what it is, and where its first version stands', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hub_just_you_${crypto.randomBytes(6).toString('hex')}`;
  await createSchemaDatabase(admin, name);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 6, connectionTimeoutMillis: 10000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const homeroomBot = await user('homeroom_bot', true);
  const evan = await user('evan_t1005');
  const sam = await user('sam_t1006');
  // Made in the first session: private, its maker its one member, so Just you.
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
     VALUES ('Geneva hike planner', 'geneva-hike-planner', 'creating', $1, 'private', 'private',
             'https://github.com/usernode-bot/geneva-hike-planner')
     RETURNING id`,
    [evan.id],
  );
  const app = (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, evan.id]);
  await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, evan.id]);
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_dm_users', JSON.stringify([evan.username]));
  await set('homeroom_bot_mode', 'live');
  await set('homeroom_bot_live_apps', JSON.stringify([app.slug]));
  const opened = await conversations.ensureAdmittedDirect(pool, homeroomBot.id, evan.id);

  let viewer = evan;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = { id: viewer.id, username: viewer.username }; next(); });
  server.use(appRoutes({}));
  const listening = server.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => {
    if (typeof listening.closeAllConnections === 'function') listening.closeAllConnections();
    listening.close();
  });
  const get = async () => {
    const res = await fetch(`http://127.0.0.1:${listening.address().port}/api/apps/${app.slug}/community`);
    assert.equal(res.status, 200);
    return res.json();
  };
  const fv = (over) => ({
    step: 1, of: 7, step_name: 'Set up the project', ready: false, mine: true, creator: evan.username,
    waits_on: null, conversation_id: opened.conversationId, session_id: null, ...over,
  });
  // The step's name as firstVersionState names it for this viewer: what
  // the App tab and the made screen say, whatever a step is called.
  const named = async (who) => (await dm.firstVersionState(pool, app.id, { viewerId: who.id })).stepName;

  await t.test('a project made with no description says nothing about what it is, and has no build to show', async () => {
    const body = await get();
    assert.equal(body.audience, 'solo');
    assert.equal(body.description, null);
    assert.equal(body.first_version, null);
  });

  await t.test('being set up: the first sentence of what it was made from, and step 1 of 7', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds) VALUES ($1, $2, $3, TRUE)`,
      [app.id, evan.id, BRIEF],
    );
    const body = await get();
    assert.equal(body.description, 'Plan hikes around Geneva with friends',
      'cut the way the create dialog\'s own suggestion is when no model answers');
    assert.deepEqual(body.first_version, fv());
  });

  await t.test('dapp.json\'s own line wins once there is one', async () => {
    await pool.query(
      `UPDATE apps SET manifest_snapshot = $2 WHERE id = $1`,
      [app.id, JSON.stringify({ description: 'Group hikes around Lake Geneva', secrets: [] })],
    );
    assert.equal((await get()).description, 'Group hikes around Lake Geneva');
    await pool.query('UPDATE apps SET manifest_snapshot = NULL WHERE id = $1', [app.id]);
    assert.equal((await get()).description, 'Plan hikes around Geneva with friends');
  });

  let run;
  await t.test('its plan waits on its maker: step 3, and what it waits on, for them alone', async () => {
    await pool.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [app.id]);
    await pool.query(
      `UPDATE homeroom_bot_first_versions SET status = 'filed', issue_number = 1, filed_at = NOW() WHERE app_id = $1`,
      [app.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text)
       VALUES ($1, 1, $2, 'First version of Geneva hike planner', TRUE, $3)`,
      [app.id, evan.id, BRIEF],
    );
    assert.deepEqual((await get()).first_version, fv({ step: 2, step_name: 'Read the description' }),
      'filed, and next to be read');
    ({ rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note)
       VALUES ($1, 1, 'live', 'ready', 'Build the trail list.') RETURNING id`,
      [app.id],
    ));
    // The bot's own plan path, as the made screen's test drives it.
    const plan = { bullets: ['A list of trails near Geneva', 'Who is coming, and when'], questions: [] };
    assert.equal(await bot.awaitGo(pool, { runId: run.id, app, issueNumber: 1, parsed: { plan }, bot: homeroomBot }), true);
    assert.deepEqual((await get()).first_version, fv({ step: 3, step_name: await named(evan), waits_on: 'plan' }),
      'named as the App tab names it for its maker, and no build time');
  });

  await t.test('ready to try: the change, and no promise of when', async () => {
    const { rows: [proposal] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state)
       VALUES ($1, $2, 'hrbot/geneva-hike-planner-1', 'promoted', 'First version of Geneva hike planner', NOW(), 'passing')
       RETURNING id`,
      [app.id, homeroomBot.id],
    );
    await pool.query('DELETE FROM homeroom_bot_runs WHERE app_id = $1', [app.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, proposal_session_id)
       VALUES ($1, 1, 'live', 'ready', TRUE, $2)`,
      [app.id, proposal.id],
    );
    assert.deepEqual((await get()).first_version,
      fv({ step: 6, step_name: await named(evan), ready: true, session_id: proposal.id }));

    // A project with people in it: the same step for everyone, and nothing
    // of its maker's (their chat, what it waits on from them).
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, sam.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, sam.id]);
    viewer = sam;
    try {
      const body = await get();
      assert.equal(body.audience, 'invited');
      assert.deepEqual(body.first_version,
        fv({ step: 6, step_name: await named(sam), ready: true, mine: false, conversation_id: null, session_id: proposal.id }));
      assert.equal(body.description, 'Plan hikes around Geneva with friends');
    } finally {
      viewer = evan;
    }

    // Live: the hub has no build to show, and still says what it is.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [proposal.id]);
    const live = await get();
    assert.equal(live.first_version, null);
    assert.equal(live.description, 'Plan hikes around Geneva with friends');
  });

  await t.test('a read of the build that fails is no state, never a failed hub', async () => {
    await pool.query(`UPDATE chat_sessions SET status = 'promoted', merged_at = NULL WHERE app_id = $1`, [app.id]);
    assert.ok((await get()).first_version, 'up for approval again');
    const real = dm.firstVersionState;
    dm.firstVersionState = async () => { throw new Error('boom'); };
    try {
      const body = await get();
      assert.equal(body.first_version, null);
      assert.equal(body.description, 'Plan hikes around Geneva with friends');
    } finally {
      dm.firstVersionState = real;
    }
  });
});
