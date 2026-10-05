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
    `INSERT INTO issues (app_id, title, created_by)
     VALUES ($1, 'Activity fixture issue', $2) RETURNING id`,
    [appId, actors.inactive]
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

  // ── Homeroom bot ──────────────────────────────────────────
  // The synthetic bot account is nobody's real use: it is dropped from every
  // count whatever the admin box says, while the people behind its work are
  // credited once, on the day the bot acted for them.
  const { rows: botRows } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic, created_at)
     VALUES ('activity_homeroom_bot', 'fixture', TRUE, CURRENT_DATE - INTERVAL '14 days')
     RETURNING id`
  );
  const bot = botRows[0].id;
  actors.botQueue = await user('bot-queue');
  actors.botRuns = await user('bot-runs');
  actors.both = await user('bot-and-direct');

  // One of the bot's own sessions with a user-role turn. Before the synthetic
  // exclusion this read as a person active through the session arm.
  const { rows: botSessionRows } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name)
     VALUES ($1, $2, 'activity-bot') RETURNING id`,
    [appId, bot]
  );
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content)
     VALUES ($1, 'user', 'bot triage turn')`,
    [botSessionRows[0].id]
  );

  // A queued request credits the person who asked for it; an automated
  // refresh names nobody and counts for nobody.
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, requested_by, payer_user_id)
     VALUES ($1, 7, $2, NULL)`,
    [appId, actors.botQueue]
  );
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, requested_by, payer_user_id)
     VALUES ($1, 8, NULL, NULL)`,
    [appId]
  );

  // A charged run whose payer was never recorded credits the requester of
  // record, found only through homeroom_bot_requesters. An uncharged run
  // (a restart re-read) counts for nobody even though a payer is named.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, charged, payer_user_id)
     VALUES ($1, 9, 'live', 'ready', TRUE, NULL)`,
    [appId]
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 9, $2)`,
    [appId, actors.botRuns]
  );
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, charged, payer_user_id)
     VALUES ($1, 10, 'live', 'ready', FALSE, $2)`,
    [appId, actors.inactive]
  );

  // A person who both ran a direct session and had the bot build for them on
  // the same day is still one active user that day.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, charged, payer_user_id)
     VALUES ($1, 11, 'live', 'ready', TRUE, $2)`,
    [appId, actors.both]
  );
  const { rows: bothSessionRows } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name)
     VALUES ($1, $2, 'activity-both') RETURNING id`,
    [appId, actors.both]
  );
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content)
     VALUES ($1, 'user', 'direct change beside the bot run')`,
    [bothSessionRows[0].id]
  );

  // The bot's metered spend is not a person's spend: it leaves the spend
  // charts through the same exclusion, in both checkbox states.
  await pool.query(
    `INSERT INTO llm_usage (user_id, date, total_cost_cents)
     VALUES ($1, CURRENT_DATE, 12345)`,
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
  assert.equal(general.daily.find((row) => row.day === today).dau, 15,
    'each human-only surface counts, the people behind bot work are credited, '
    + 'and duplicates, generated rows and the synthetic bot do not');
  assert.equal(general.daily.find((row) => row.day === yesterday).dau, 1,
    'the message one second before midnight belongs to the previous UTC day');

  const withAdmins = await get('/api/admin/analytics/general-users?includeAdmins=true');
  assert.equal(withAdmins.daily.find((row) => row.day === today).dau, 17,
    'full and view-only admins enter together only when requested, and the bot never does');

  const overview = await get('/api/admin/analytics/overview');
  assert.equal(overview.wau, 16);
  assert.equal(overview.mau, 16);
  const overviewWithAdmins = await get('/api/admin/analytics/overview?includeAdmins=true');
  assert.equal(overviewWithAdmins.wau, 18);
  assert.equal(overviewWithAdmins.mau, 18);

  const retention = await get('/api/admin/analytics/retention');
  assert.equal(retention.cohorts.reduce((sum, cohort) => sum
    + Object.values(cohort.offsets).reduce((n, value) => n + Number(value), 0), 0), 16,
  'retention uses the same de-duplicated human-action surface');
  const retentionWithAdmins = await get('/api/admin/analytics/retention?includeAdmins=true');
  assert.equal(retentionWithAdmins.cohorts.reduce((sum, cohort) => sum
    + Object.values(cohort.offsets).reduce((n, value) => n + Number(value), 0), 0), 18,
  'retention applies the same full and view-only admin inclusion switch');

  // The bot's own session leaves the session counters and the top-users
  // list; the person who also worked directly still ranks with exactly
  // that one session of their own.
  const top = await get('/api/admin/analytics/top-users');
  assert.ok(!top.users.some((row) => row.name === 'activity_homeroom_bot'),
    'the synthetic bot is not a top user');
  const bothRow = top.users.find((row) => /bot-and-direct/.test(row.name));
  assert.ok(bothRow, 'the person behind a bot run and a direct session is counted');
  assert.equal(bothRow.sessions, 1, 'and appears once, with only their own session');

  // The bot's metered spend leaves the spend charts with the box off AND on.
  const spend = await get('/api/admin/analytics/spend');
  assert.equal(spend.days[spend.days.length - 1].platform_cents, 0,
    'the bot\'s llm_usage spend is dropped with the box off');
  const spendWithAdmins = await get('/api/admin/analytics/spend?includeAdmins=true');
  assert.equal(spendWithAdmins.days[spendWithAdmins.days.length - 1].platform_cents, 0,
    'the bot\'s llm_usage spend is dropped with the box on too');
  const byBuilder = await get('/api/admin/analytics/spend-by-builder');
  assert.ok(!byBuilder.builders.some((row) => row.name === 'activity_homeroom_bot'),
    'the bot is not a spend-by-builder entry');
  const byBuilderWithAdmins = await get('/api/admin/analytics/spend-by-builder?includeAdmins=true');
  assert.ok(!byBuilderWithAdmins.builders.some((row) => row.name === 'activity_homeroom_bot'),
    'the bot is not a spend-by-builder entry with the box on either');
});
