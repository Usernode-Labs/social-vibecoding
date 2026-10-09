'use strict';

// Shots-only rows are written to the paired, disposable app databases
// after their exact-revision images boot. The platform's staging check owns
// agent session 990801 as usernode-capture-admin; the shots member cannot
// read it. Copy its real staging conversation to a separate member-owned row
// so a member story can follow an actual Messages row on both revisions.

const { Client } = require('pg');
const dbManager = require('./db-manager');
const dbRetry = require('./db-retry');
const hostedApp = require('../../worker/shots-hosted-app-contract');

const SOURCE_SESSION_ID = 990801;
const SOURCE_CHANGE_ID = 990802;
const MEMBER_SESSION_ID = 990899;
const MEMBER_CHANGE_ID = 990898;
const PROFILE = 'platform-member-agent-session-v1';
const FULL_ADMIN_SESSION_ID = 990897;
const FULL_ADMIN_CHANGE_ID = 990896;
const FULL_ADMIN_SESSION_PROFILE = 'platform-full-admin-agent-session-v1';
// This identity is inserted only into the two disposable shots databases.
// Production and ordinary staging databases never contain a full-admin
// service account. The high, fixed id lets the platform mint one short-lived
// app-scoped iframe token before either isolated browser starts.
const FULL_ADMIN_USER_ID = 2147483000;
const FULL_ADMIN_USERNAME = 'usernode-shots-full-admin';
const FULL_ADMIN_PROFILE = 'platform-isolated-full-admin-self-member-v2';

function assertShotsDatabase(databaseUrl, slug, runId, side) {
  const expected = dbManager.shotsDbName(slug, runId, side);
  const actual = new URL(databaseUrl).pathname.slice(1);
  if (actual !== expected) throw new Error('Before & after shots fixture requires its isolated shots database.');
}

async function withClient(databaseUrl, fn) {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    application_name: 'social-shots-fixture',
  });
  await client.connect();
  try { return await fn(client); }
  finally { await client.end(); }
}

// One fixture write, as one transaction on a fresh connection. These rows go
// in while both booted copies are already running against the same
// databases, so a write can lose a deadlock (40P01) or a serialization
// conflict (40001) to the app's own work. That says nothing about the
// proposal, and the rolled-back transaction is simply run again, a bounded
// number of times; any other failure, or one that outlasts the retries,
// fails as before.
async function inTransaction(databaseUrl, fn, { retry = {} } = {}) {
  return dbRetry.withDbRetry(() => withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }), { label: 'Shots fixture write', ...retry });
}

async function canCopyMemberAgentSession({ databaseUrl, slug, runId, side }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    const { rows } = await client.query(
      `SELECT to_regclass('public.agent_sessions') IS NOT NULL AS has_sessions,
              to_regclass('public.chat_sessions') IS NOT NULL AS has_changes,
              to_regclass('public.chat_session_messages') IS NOT NULL AS has_messages`
    );
    if (!rows[0]?.has_sessions || !rows[0]?.has_changes || !rows[0]?.has_messages) return false;
    const source = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM agent_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND u.username = 'usernode-capture-admin'
       ) AS session_ready,
       EXISTS (
         SELECT 1 FROM chat_sessions c
          WHERE c.id = $2 AND c.agent_session_id = $1
       ) AS change_ready,
       EXISTS (
         SELECT 1 FROM chat_session_messages m
          WHERE m.agent_session_id = $1 AND m.role = 'user'
       ) AS message_ready`,
      [SOURCE_SESSION_ID, SOURCE_CHANGE_ID]
    );
    return !!(source.rows[0]?.session_ready && source.rows[0]?.change_ready
      && source.rows[0]?.message_ready);
  });
}

async function installFullAdminFixture(client, slug) {
  const app = await client.query(
    `SELECT id FROM apps WHERE slug = $1 FOR SHARE`,
    [slug]
  );
  if (app.rowCount !== 1) {
    throw new Error('The platform app is missing from the paired shots fixture.');
  }
  const appId = app.rows[0].id;
  const conflict = await client.query(
    `SELECT id, username FROM users
      WHERE id = $1 OR username = $2
      FOR UPDATE`,
    [FULL_ADMIN_USER_ID, FULL_ADMIN_USERNAME]
  );
  if (conflict.rows.some((row) => Number(row.id) !== FULL_ADMIN_USER_ID
      || row.username !== FULL_ADMIN_USERNAME)) {
    throw new Error('The reserved shots full-admin identity conflicts with cloned data.');
  }
  if (conflict.rowCount === 0) {
    await client.query(
      `INSERT INTO users
         (id, username, password, is_admin, admin_readonly, can_create_apps,
          has_platform_access, platform_access_granted_at)
       VALUES ($1, $2, '__shots_not_a_login__', TRUE, FALSE, FALSE, TRUE, NOW())`,
      [FULL_ADMIN_USER_ID, FULL_ADMIN_USERNAME]
    );
  } else {
    await client.query(
      `UPDATE users
          SET is_admin = TRUE, admin_readonly = FALSE, can_create_apps = FALSE,
              has_platform_access = TRUE,
              platform_access_granted_at = COALESCE(platform_access_granted_at, NOW())
        WHERE id = $1 AND username = $2`,
      [FULL_ADMIN_USER_ID, FULL_ADMIN_USERNAME]
    );
  }
  // App channels are membership-scoped even for a platform administrator.
  // Make the isolated full-admin identity a real member of the self app so
  // shots can exercise the same channel rows a human app member sees.
  // This row exists only in the paired disposable databases and is added
  // symmetrically to base and head on every reset before the shots.
  await client.query(
    `INSERT INTO app_collaborators
       (app_id, user_id, status, invited_by, accepted_at)
     VALUES ($1, $2, 'member', NULL, NOW())
     ON CONFLICT (app_id, user_id)
     DO UPDATE SET status = 'member', invited_by = NULL,
                   accepted_at = COALESCE(app_collaborators.accepted_at, NOW())`,
    [appId, FULL_ADMIN_USER_ID]
  );
  return {
    id: FULL_ADMIN_PROFILE,
    persona: 'full_admin',
    startPath: '/#admin',
    path: '/#admin/users',
    userId: FULL_ADMIN_USER_ID,
    username: FULL_ADMIN_USERNAME,
    appMembership: { appId, slug, status: 'member' },
  };
}

async function ensureFullAdminIdentity({ databaseUrl, slug, runId, side }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return inTransaction(databaseUrl, (client) => installFullAdminFixture(client, slug));
}

async function installHostedAppFixture(client, runId) {
  const slug = hostedApp.hostedAppSlug(runId);
  const conflict = await client.query(
    `SELECT id, slug, manifest_snapshot FROM apps
      WHERE id = $1 OR slug = $2
      FOR UPDATE`,
    [hostedApp.HOSTED_APP_ID, slug]
  );
  if (conflict.rows.some((row) => !hostedApp.isHostedAppFixture(row, runId))) {
    throw new Error('The reserved shots hosted app conflicts with cloned data.');
  }
  const manifest = hostedApp.hostedAppManifest(runId);
  if (conflict.rowCount === 0) {
    await client.query(
      `INSERT INTO apps
         (id, name, slug, repo_url, container_id, status, created_by,
          created_at, main_sha, last_deploy_at, manifest_snapshot,
          self_hosted, collab_visibility, view_visibility, anon_shell,
          anon_shell_checked_at)
       VALUES
         ($1, 'Homeroom shots app', $2, NULL, NULL, 'running', NULL,
          NOW(), NULL, NOW(), $3::jsonb,
          FALSE, 'public', 'public', 'public', NOW())`,
      [hostedApp.HOSTED_APP_ID, slug, JSON.stringify(manifest)]
    );
  } else {
    await client.query(
      `UPDATE apps
          SET name = 'Homeroom shots app', repo_url = NULL,
              container_id = NULL, status = 'running', main_sha = NULL,
              last_deploy_at = NOW(), manifest_snapshot = $3::jsonb,
              self_hosted = FALSE, collab_visibility = 'public',
              view_visibility = 'public', anon_shell = 'public',
              anon_shell_checked_at = NOW()
        WHERE id = $1 AND slug = $2`,
      [hostedApp.HOSTED_APP_ID, slug, JSON.stringify(manifest)]
    );
  }
  return {
    id: hostedApp.HOSTED_APP_PROFILE,
    persona: 'member',
    startPath: '/#apps',
    path: `/app/${slug}`,
    appSlug: slug,
    purpose: 'Clean deployed app for Homeroom app-frame and bridge shots.',
  };
}

async function ensureHostedAppFixture({ databaseUrl, slug, runId, side }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return inTransaction(databaseUrl, (client) => installHostedAppFixture(client, runId));
}

// A copy of the staging fixture's agent session, owned by `userId`, with its
// change and first user message. The source belongs to the read-only admin;
// the other personas get a copy so every persona's session lists (Messages'
// Agents, the menu's Agent sessions) look the same on both builds.
async function copyAgentSession(client, { userId, appId, sessionId, changeId, branch, persona }) {
  const session = await client.query(
    `INSERT INTO agent_sessions
       (id, user_id, title, title_source, status, focus_app_id, focus_context,
        last_activity_at, created_at)
     SELECT $1, $2, s.title, 'manual', 'open', $3, s.focus_context,
            NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '5 minutes'
       FROM agent_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $4 AND u.username = 'usernode-capture-admin'
     RETURNING id, title`,
    [sessionId, userId, appId, SOURCE_SESSION_ID]
  );
  if (session.rowCount !== 1) throw new Error(`The source agent session is unavailable for ${persona} shots.`);
  const change = await client.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, session_title, status, agent_session_id,
        created_at, last_activity_at)
     SELECT $1, $2, $3, $7, c.session_title,
            'active', $4, NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '2 minutes'
       FROM chat_sessions c
      WHERE c.id = $5 AND c.agent_session_id = $6
     RETURNING id`,
    [changeId, appId, userId, sessionId, SOURCE_CHANGE_ID, SOURCE_SESSION_ID, branch]
  );
  if (change.rowCount !== 1) throw new Error(`The source agent change is unavailable for ${persona} shots.`);
  await client.query('UPDATE agent_sessions SET active_change_id = $2 WHERE id = $1', [sessionId, changeId]);
  // Copy a real user message from the exact revision's own staging
  // fixture. It proves the transcript loaded; no model or fake response
  // is needed and no admin confirmation card crosses the identity wall.
  const message = await client.query(
    `INSERT INTO chat_session_messages
       (session_id, agent_session_id, role, content, metadata, created_at)
     SELECT NULL, $1, m.role, m.content, '{}'::jsonb, NOW() - INTERVAL '5 minutes'
       FROM chat_session_messages m
      WHERE m.agent_session_id = $2 AND m.role = 'user'
      ORDER BY m.id LIMIT 1
     RETURNING id`,
    [sessionId, SOURCE_SESSION_ID]
  );
  if (message.rowCount !== 1) throw new Error(`The source agent message is unavailable for ${persona} shots.`);
  return session.rows[0];
}

async function copyMemberAgentSession({ databaseUrl, slug, runId, side, selfAppSlug }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return inTransaction(databaseUrl, async (client) => {
    const viewer = await client.query(
      `SELECT id FROM users WHERE username = 'usernode-capture' AND is_admin = FALSE`
    );
    const app = await client.query('SELECT id FROM apps WHERE slug = $1', [selfAppSlug]);
    if (viewer.rowCount !== 1 || app.rowCount !== 1) {
      throw new Error('Before & after shots member identity or platform app is missing from the paired fixture.');
    }
    const userId = viewer.rows[0].id;
    const appId = app.rows[0].id;
    // A member story must see the same private app surface that a genuine
    // collaborator sees. This grant lives only in this run's disposable DB.
    await client.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (app_id, user_id)
       DO UPDATE SET status = 'member', accepted_at = COALESCE(app_collaborators.accepted_at, NOW())`,
      [appId, userId]
    );
    const session = await copyAgentSession(client, {
      userId, appId, sessionId: MEMBER_SESSION_ID, changeId: MEMBER_CHANGE_ID,
      branch: 'shots-fixture/member-agent-session', persona: 'member',
    });
    return {
      id: PROFILE,
      persona: 'member',
      startPath: '/#messages',
      path: `/#messages/agent/${MEMBER_SESSION_ID}`,
      title: session.title,
      sessionId: MEMBER_SESSION_ID,
      changeId: MEMBER_CHANGE_ID,
    };
  });
}

// The full admin gets an agent session too. Without one, anything drawn only
// for a viewer with sessions (the menu's Agent sessions list) is absent on a
// before build, and its change cannot be shown there.
async function copyFullAdminAgentSession({ databaseUrl, slug, runId, side, selfAppSlug }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return inTransaction(databaseUrl, async (client) => {
    const app = await client.query('SELECT id FROM apps WHERE slug = $1', [selfAppSlug]);
    const admin = await client.query('SELECT id FROM users WHERE id = $1 AND username = $2',
      [FULL_ADMIN_USER_ID, FULL_ADMIN_USERNAME]);
    if (app.rowCount !== 1 || admin.rowCount !== 1) {
      throw new Error('Before & after shots full-admin identity or platform app is missing from the paired fixture.');
    }
    const session = await copyAgentSession(client, {
      userId: FULL_ADMIN_USER_ID, appId: app.rows[0].id,
      sessionId: FULL_ADMIN_SESSION_ID, changeId: FULL_ADMIN_CHANGE_ID,
      branch: 'shots-fixture/full-admin-agent-session', persona: 'full admin',
    });
    return {
      id: FULL_ADMIN_SESSION_PROFILE,
      persona: 'full_admin',
      startPath: '/#messages',
      path: `/#messages/agent/${FULL_ADMIN_SESSION_ID}`,
      title: session.title,
      sessionId: FULL_ADMIN_SESSION_ID,
      changeId: FULL_ADMIN_CHANGE_ID,
    };
  });
}

module.exports = {
  assertShotsDatabase,
  withClient,
  inTransaction,
  PROFILE,
  FULL_ADMIN_SESSION_ID,
  FULL_ADMIN_CHANGE_ID,
  FULL_ADMIN_SESSION_PROFILE,
  copyFullAdminAgentSession,
  copyAgentSession,
  SOURCE_SESSION_ID,
  MEMBER_SESSION_ID,
  MEMBER_CHANGE_ID,
  FULL_ADMIN_USER_ID,
  FULL_ADMIN_USERNAME,
  FULL_ADMIN_PROFILE,
  HOSTED_APP_ID: hostedApp.HOSTED_APP_ID,
  HOSTED_APP_PROFILE: hostedApp.HOSTED_APP_PROFILE,
  hostedAppSlug: hostedApp.hostedAppSlug,
  installFullAdminFixture,
  ensureFullAdminIdentity,
  installHostedAppFixture,
  ensureHostedAppFixture,
  canCopyMemberAgentSession,
  copyMemberAgentSession,
};
