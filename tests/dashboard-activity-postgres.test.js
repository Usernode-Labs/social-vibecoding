'use strict';

// The admin analytics activity definition against PostgreSQL's real planner
// and the full platform schema. This test exercises the public route payloads,
// not a copied CTE, so Overview, General users, and Retention have to agree on
// the same activityDaysSql() implementation.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('active-user analytics count recorded human participation once per UTC day', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }

  const database = `dashboard_activity_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  // Deliberately differ from UTC: the production query must define its own
  // calendar boundary instead of inheriting a connection setting.
  await admin.query(`ALTER DATABASE ${database} SET timezone TO 'America/Los_Angeles'`);
  const url = new URL(DSN);
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: String(url), max: 1 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  });

  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  let nextUser = 0;
  async function user(label, { admin: isAdmin = false, readonly = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, is_admin, admin_readonly, created_at)
       VALUES ($1, 'fixture', $2, $3, CURRENT_DATE - INTERVAL '14 days')
       RETURNING id`,
      [`activity_${++nextUser}_${label}`, isAdmin, readonly]
    );
    return rows[0].id;
  }

  const actors = {
    appUse: await user('app-use'),
    appChat: await user('app-chat'),
    classic: await user('classic-change'),
    mayor: await user('mayor-only'),
    direct: await user('direct-message'),
    group: await user('group-message'),
    channel: await user('channel-message'),
    global: await user('global-chat'),
    prVote: await user('pr-vote'),
    issueVote: await user('issue-vote'),
    kudos: await user('kudos'),
    favorite: await user('favorite'),
    filer: await user('request-filer'),
    requester: await user('bot-requester'),
    boundary: await user('previous-day-boundary'),
    noise: await user('generated-noise'),
    inactive: await user('passive-only'),
    fullAdmin: await user('full-admin', { admin: true }),
    readonlyAdmin: await user('readonly-admin', { admin: true, readonly: true }),
  };

  const { rows: appRows } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by)
     VALUES ('Activity fixture', 'activity-fixture', 'running', $1)
     RETURNING id`,
    [actors.inactive]
  );
  const appId = appRows[0].id;

  // The three original activity arms stay live.
  await pool.query(
    `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
     VALUES ($1, $2, 10, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date)`,
    [appId, actors.appUse]
  );
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type)
     VALUES ($1, $2, 'human project message', 'message')`,
    [appId, actors.appChat]
  );
  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name)
     VALUES ($1, $2, 'activity-classic') RETURNING id`,
    [appId, actors.classic]
  );
  const sessionId = sessionRows[0].id;
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content)
     VALUES ($1, 'user', 'human change message')`,
    [sessionId]
  );

  // A Mayor-only prompt has no change session; agent_sessions owns it.
  const { rows: agentRows } = await pool.query(
    `INSERT INTO agent_sessions (user_id, title)
     VALUES ($1, 'Activity fixture') RETURNING id`,
    [actors.mayor]
  );
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content)
     VALUES (NULL, $1, 'user', 'human Mayor prompt')`,
    [agentRows[0].id]
  );

  // Direct, group, and the built-in #general channel all share the Messages
  // store; each actor is active through that one surface only.
  const { rows: conversationRows } = await pool.query(
    `INSERT INTO conversations (kind, title, created_by)
     VALUES ('direct', NULL, $1), ('group', 'Fixture group', $2)
     RETURNING id, kind`,
    [actors.direct, actors.group]
  );
  const directId = conversationRows.find((row) => row.kind === 'direct').id;
  const groupId = conversationRows.find((row) => row.kind === 'group').id;
  const channelId = (await pool.query(
    "SELECT id FROM conversations WHERE kind = 'channel' AND channel_key = 'general'"
  )).rows[0].id;
  await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, msg_type)
     VALUES ($1, $2, 'direct', 'message'),
            ($3, $4, 'group', 'message'),
            ($5, $6, 'channel', 'message')`,
    [directId, actors.direct, groupId, actors.group, channelId, actors.channel]
  );

  const globalThread = crypto.randomUUID();
  await pool.query(
    `INSERT INTO global_chat_threads (id, user_id) VALUES ($1, $2)`,
    [globalThread, actors.global]
  );
  await pool.query(
    `INSERT INTO global_chat_messages (thread_id, role, plain_text)
     VALUES ($1, 'user', 'human Global Chat prompt')`,
    [globalThread]
  );

  const { rows: issueRows } = await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, created_by)
     VALUES ($1, 502, 'Activity fixture issue', $2) RETURNING id`,
    [appId, actors.filer]
  );
  await pool.query(
    `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
     VALUES ($1, $2, $3, 'pr_vote_cast', '{}'),
            ($4, $2, NULL, 'issue_vote_cast', '{}'),
            ($5, $2, $3, 'kudos_given', '{}'),
            ($6, $2, NULL, 'app_favorited', '{"source":"user_favorite_toggle"}')`,
    [actors.prVote, appId, sessionId, actors.issueVote, actors.kudos, actors.favorite]
  );
  // These current-state rows are intentionally absent, as after a vote,
  // kudos, or favorite is retracted. The append-only action still counts on
  // the day it happened.

  // Several actions by one person on the same day still make one active user.
  await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, msg_type)
     VALUES ($1, $2, 'duplicate one', 'message'),
            ($1, $2, 'duplicate two', 'message')`,
    [groupId, actors.appUse]
  );
  await pool.query(
    `INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, 'up')`,
    [issueRows[0].id, actors.appUse]
  );

  // One second before today's UTC boundary belongs to the previous date.
  await pool.query(
    `INSERT INTO conversation_messages
       (conversation_id, sender_id, content, msg_type, created_at)
     VALUES (
       $1, $2, 'previous UTC day', 'message',
       (((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC')
         - INTERVAL '1 second'
     )`,
    [groupId, actors.boundary]
  );

  // Both admin roles are excluded by default and included together on demand.
  await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, msg_type)
     VALUES ($1, $2, 'full admin action', 'message')`,
    [groupId, actors.fullAdmin]
  );
  const adminGlobalThread = crypto.randomUUID();
  await pool.query(
    `INSERT INTO global_chat_threads (id, user_id) VALUES ($1, $2)`,
    [adminGlobalThread, actors.readonlyAdmin]
  );
  await pool.query(
    `INSERT INTO global_chat_messages (thread_id, role, plain_text)
     VALUES ($1, 'user', 'view-only admin action')`,
    [adminGlobalThread]
  );

  // These rows name a user but are system, assistant, or generated state.
  // None is a deliberate human action.
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type)
     VALUES ($1, $2, 'generated project line', 'system')`,
    [appId, actors.noise]
  );
  await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, msg_type)
     VALUES ($1, $2, 'generated Messages line', 'system')`,
    [groupId, actors.noise]
  );
  const { rows: noiseSessionRows } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name)
     VALUES ($1, $2, 'activity-noise') RETURNING id`,
    [appId, actors.noise]
  );
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content)
     VALUES ($1, 'assistant', 'assistant change message')`,
    [noiseSessionRows[0].id]
  );
  const noiseGlobalThread = crypto.randomUUID();
  await pool.query(
    `INSERT INTO global_chat_threads (id, user_id) VALUES ($1, $2)`,
    [noiseGlobalThread, actors.noise]
  );
  await pool.query(
    `INSERT INTO global_chat_messages (thread_id, role, plain_text)
     VALUES ($1, 'assistant', 'assistant Global Chat response')`,
    [noiseGlobalThread]
  );
  await pool.query(
    `INSERT INTO topic_attribute_votes
       (app_id, target_type, target_ref, field, value, user_id)
     VALUES ($1, 'proposal', $2, 'assignee', 'generated owner', $3)`,
    [appId, noiseSessionRows[0].id, actors.noise]
  );
  await pool.query(
    `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
     VALUES ($1, $2, 0, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date)`,
    [appId, actors.noise]
  );
  await pool.query(
    `INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)`,
    [appId, actors.noise]
  );

  // #3970: the Homeroom bot is a synthetic account. People ask it for
  // changes in a direct message; it files the request and builds the change
  // in a session of its own. The person's message counts as their activity;
  // nothing the bot does makes the bot a user. Each change it builds is
  // credited to the person who asked (homeroom_bot_requesters), else to
  // whoever filed the request.
  const bot = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic, created_at)
     VALUES ('activity_homeroom_bot', 'fixture', TRUE, CURRENT_DATE - INTERVAL '14 days')
     RETURNING id`
  )).rows[0].id;
  const { rows: botDmRows } = await pool.query(
    `INSERT INTO conversations (kind, title, created_by)
     VALUES ('direct', NULL, $1) RETURNING id`,
    [actors.requester]
  );
  await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, msg_type)
     VALUES ($1, $2, 'please add a dark mode', 'message'),
            ($1, $3, 'On it: I filed it as a request.', 'message')`,
    [botDmRows[0].id, actors.requester, bot]
  );
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, created_by)
     VALUES ($1, 501, 'Dark mode', $2), ($1, 503, 'Admin ask', $2)`,
    [appId, bot]
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id)
     VALUES ($1, 501, $2), ($1, 503, $3)`,
    [appId, actors.requester, actors.fullAdmin]
  );
  const botSession = async (issue, status) => (await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, created_from_issue_number, status, promoted_at, merged_at)
     VALUES ($1, $2, $3, $4, $5::varchar, NOW(),
             CASE WHEN $5::varchar = 'merged' THEN NOW() END)
     RETURNING id`,
    [appId, bot, `activity-bot-${issue}`, issue, status]
  )).rows[0].id;
  const requestedBuild = await botSession(501, 'merged');
  await botSession(502, 'promoted'); // no requester row: the filer's
  await botSession(503, 'merged'); // an admin's ask
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content)
     VALUES ($1, 'user', 'bot-written build brief')`,
    [requestedBuild]
  );
  // Power users: the requester used projects three times this week, and the
  // bot promoted their change three times. Each promotion is a "proposal
  // made" for the requester, so they are a power user; the bot is not.
  await pool.query(
    `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
     SELECT $1::int, $2::int, NULL::int, 'dapp_active_day', '{}'::jsonb FROM generate_series(1, 3)
     UNION ALL
     SELECT $3::int, $2::int, $4::int, 'pr_promoted', '{}'::jsonb FROM generate_series(1, 3)`,
    [actors.requester, appId, bot, requestedBuild]
  );
  // The bot's own LLM spend stays in the spend totals, but it is not a user
  // in the per-user spend buckets.
  await pool.query(
    `INSERT INTO llm_usage (user_id, date, total_cost_cents) VALUES ($1, CURRENT_DATE, 500)`,
    [bot]
  );

  // Mount the actual route against this disposable database.
  require('../src/db/pool').getPool = () => pool;
  delete require.cache[require.resolve('../src/routes/dashboard')];
  const { dashboardRoutes } = require('../src/routes/dashboard');
  const app = express();
  app.use((req, res, next) => {
    req.user = { id: actors.fullAdmin, username: 'fixture-admin', isAdmin: true };
    next();
  });
  app.use(dashboardRoutes({ databaseUrl: String(url), jwtSecret: 'fixture' }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    const text = await response.text();
    assert.equal(response.status, 200, `${path}: ${text}`);
    return JSON.parse(text);
  };

  const general = await get('/api/admin/analytics/general-users');
  const today = (await pool.query(
    "SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day"
  )).rows[0].day;
  const yesterday = (await pool.query(
    "SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1, 'YYYY-MM-DD') AS day"
  )).rows[0].day;
  assert.equal(general.daily.find((row) => row.day === today).dau, 14,
    'each human-only surface counts (filing a request and messaging the bot too), '
    + 'while duplicates, generated rows and the bot itself do not');
  assert.equal(general.daily.find((row) => row.day === yesterday).dau, 1,
    'the message one second before midnight belongs to the previous UTC day');

  const withAdmins = await get('/api/admin/analytics/general-users?includeAdmins=true');
  assert.equal(withAdmins.daily.find((row) => row.day === today).dau, 16,
    'full and view-only admins enter together only when requested');

  const overview = await get('/api/admin/analytics/overview');
  assert.equal(overview.wau, 15);
  assert.equal(overview.mau, 15);
  assert.equal(overview.users.total, 17, 'the synthetic bot is not a user');
  assert.deepEqual(overview.prs, { promoted: 1, promoted_all_time: 2, merged: 1 },
    'bot builds count for their requester or filer; the admin\'s ask stays out');
  assert.equal(overview.llmSpendTodayCents, 500, 'the bot\'s spend is still spend');
  const overviewWithAdmins = await get('/api/admin/analytics/overview?includeAdmins=true');
  assert.equal(overviewWithAdmins.wau, 17);
  assert.equal(overviewWithAdmins.mau, 17);
  assert.equal(overviewWithAdmins.users.total, 19);
  assert.deepEqual(overviewWithAdmins.prs, { promoted: 1, promoted_all_time: 3, merged: 2 });

  const name = (key) => `activity_${Object.keys(actors).indexOf(key) + 1}_`;
  const top = await get('/api/admin/analytics/top-users');
  assert.ok(!top.users.some((row) => row.name === 'activity_homeroom_bot'),
    'the bot is not a builder');
  const requesterRow = top.users.find((row) => row.name.startsWith(name('requester')));
  assert.ok(requesterRow, 'the person who asked the bot is a builder');
  assert.equal(requesterRow.sessions, 1);
  assert.equal(requesterRow.merged, 1);
  const filerRow = top.users.find((row) => row.name.startsWith(name('filer')));
  assert.equal(filerRow && filerRow.promoted, 1, 'with no requester, the filer is credited');
  assert.ok(!top.users.some((row) => row.is_admin));
  const topWithAdmins = await get('/api/admin/analytics/top-users?includeAdmins=true');
  assert.equal(topWithAdmins.users.find((row) => row.is_admin)?.merged, 1);

  const sum = (rows, key) => rows.reduce((n, row) => n + Number(row[key]), 0);
  const growth = await get('/api/admin/analytics/growth');
  assert.equal(sum(growth.weeks, 'promoted_prs'), 2);
  assert.equal(sum(growth.weeks, 'merged_prs'), 1);
  assert.equal(sum(growth.weeks, 'new_users'), 17, 'the bot is not a new user');
  const growthWithAdmins = await get('/api/admin/analytics/growth?includeAdmins=true');
  assert.equal(sum(growthWithAdmins.weeks, 'merged_prs_admin'), 1);

  const power = await get('/api/admin/analytics/power-users');
  // Power users still bucket by the session's calendar day; its last point
  // is today there.
  assert.equal(power.wau[power.wau.length - 1].count, 1,
    'proposals the bot made for someone count as theirs');

  const spend = await get('/api/admin/analytics/spend');
  assert.equal(sum(spend.days, 'platform_cents'), 500);
  const distribution = await get('/api/admin/analytics/spend-distribution');
  assert.equal(sum(distribution.days, 'b1'), 0, 'the bot is not a user in the spend buckets');

  const retention = await get('/api/admin/analytics/retention');
  assert.equal(retention.cohorts.reduce((sum, cohort) => sum
    + Object.values(cohort.offsets).reduce((n, value) => n + Number(value), 0), 0), 15,
  'retention uses the same de-duplicated human-action surface');
  const retentionWithAdmins = await get('/api/admin/analytics/retention?includeAdmins=true');
  assert.equal(retentionWithAdmins.cohorts.reduce((sum, cohort) => sum
    + Object.values(cohort.offsets).reduce((n, value) => n + Number(value), 0), 0), 17,
  'retention applies the same full and view-only admin inclusion switch');
});
