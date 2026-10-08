'use strict';

// Shots-only rows are written to the paired, disposable app databases
// after their exact-revision images boot. The platform's staging check owns
// agent session 990801 as usernode-capture-admin; the shots member cannot
// read it. Copy its real staging conversation to a separate member-owned row
// so a member story can follow an actual Messages row on both revisions.

const { Client } = require('pg');
const dbManager = require('./db-manager');
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
// Two invited members of the self app who are still waiting for platform
// access (users.private_member_since, no has_platform_access): the account a
// private community's invite makes. The first has never been listed on the
// waitlist; the second has a waitlist_signups row joined by email, still
// waiting. Same rules as the full admin above: only in the paired databases,
// minted a token before the browsers start, never a login.
const INVITED_USER_ID = 2147483001;
const INVITED_USERNAME = 'usernode-shots-invited';
const INVITED_PROFILE = 'platform-isolated-invited-self-member-v1';
const INVITED_LISTED_USER_ID = 2147483002;
const INVITED_LISTED_USERNAME = 'usernode-shots-invited-listed';
const INVITED_LISTED_PROFILE = 'platform-isolated-invited-listed-self-member-v1';
// The small private project the guest's invite link opens: one app with its
// own community (the insert leaves community_id NULL; the schema's trigger
// makes the community), a ready sketch card for its invite page's hero, and
// one never-expiring, never-used-up invite from the full admin (expires_at
// and max_uses NULL). The token is fixed so a brief can name the path.
const INVITE_APP_ID = 2147483003;
const INVITE_APP_SLUG = 'shots-demo-invite-project';
const INVITE_APP_NAME = '[shots fixture] Run log';
const INVITE_TOKEN = 'shots-fixture-invite22';
const INVITE_NOTE = 'Come help with our run log. It is only a sketch so far.';
const INVITE_PROFILE = 'platform-isolated-invite-link-v1';

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
  return withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
      const installed = await installFullAdminFixture(client, slug);
      await client.query('COMMIT');
      return installed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

// An invited member of the self app with no platform access yet. `listed`
// adds the waitlist row that names them by email, still waiting (released_at
// NULL). Membership rides app_collaborators, as the full admin's does.
async function installInvitedMemberFixture(client, slug, { listed = false } = {}) {
  const app = await client.query(
    `SELECT id FROM apps WHERE slug = $1 FOR SHARE`,
    [slug]
  );
  if (app.rowCount !== 1) {
    throw new Error('The platform app is missing from the paired shots fixture.');
  }
  const appId = app.rows[0].id;
  const userId = listed ? INVITED_LISTED_USER_ID : INVITED_USER_ID;
  const username = listed ? INVITED_LISTED_USERNAME : INVITED_USERNAME;
  const conflict = await client.query(
    `SELECT id, username FROM users
      WHERE id = $1 OR username = $2
      FOR UPDATE`,
    [userId, username]
  );
  if (conflict.rows.some((row) => Number(row.id) !== userId || row.username !== username)) {
    throw new Error('The reserved shots invited-member identity conflicts with cloned data.');
  }
  if (conflict.rowCount === 0) {
    await client.query(
      `INSERT INTO users
         (id, username, password, is_admin, can_create_apps,
          has_platform_access, private_member_since)
       VALUES ($1, $2, '__shots_not_a_login__', FALSE, FALSE, FALSE, NOW())`,
      [userId, username]
    );
  } else {
    await client.query(
      `UPDATE users
          SET is_admin = FALSE, can_create_apps = FALSE, has_platform_access = FALSE,
              private_member_since = COALESCE(private_member_since, NOW())
        WHERE id = $1 AND username = $2`,
      [userId, username]
    );
  }
  await client.query(
    `INSERT INTO app_collaborators
       (app_id, user_id, status, invited_by, accepted_at)
     VALUES ($1, $2, 'member', NULL, NOW())
     ON CONFLICT (app_id, user_id)
     DO UPDATE SET status = 'member', invited_by = NULL,
                   accepted_at = COALESCE(app_collaborators.accepted_at, NOW())`,
    [appId, userId]
  );
  if (listed) {
    // The spot that lists them, joined by email and still waiting: the same
    // row a release would mark (waitlist.js). example.invalid never resolves.
    await client.query(
      `INSERT INTO waitlist_signups (email, submitted_at, linked_user_id)
       VALUES ($1, NOW() - INTERVAL '9 days', $2)
       ON CONFLICT (email)
       DO UPDATE SET linked_user_id = $2, released_at = NULL`,
      [`${username}@waitlist.example.invalid`, userId]
    );
  }
  return {
    id: listed ? INVITED_LISTED_PROFILE : INVITED_PROFILE,
    persona: listed ? 'invited_member_listed' : 'invited_member',
    startPath: '/#home',
    path: '/#home',
    userId,
    username,
    appMembership: { appId, slug, status: 'member' },
  };
}

function ensureInvitedMemberIdentity({ databaseUrl, slug, runId, side }, { listed = false } = {}) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
      const installed = await installInvitedMemberFixture(client, slug, { listed });
      await client.query('COMMIT');
      return installed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

// The invite link the guest browser opens: a small private project, its
// sketch card, and one invite from the full admin that never expires and
// never runs out (expires_at and max_uses NULL, as community-invites.js's
// NO_LIMIT makes the first session's). Nothing joins anybody: the page a
// signed-out visitor sees is the fixture.
async function installInviteLinkFixture(client) {
  const conflict = await client.query(
    `SELECT id, slug, name FROM apps
      WHERE id = $1 OR slug = $2
      FOR UPDATE`,
    [INVITE_APP_ID, INVITE_APP_SLUG]
  );
  if (conflict.rows.some((row) => Number(row.id) !== INVITE_APP_ID || row.slug !== INVITE_APP_SLUG)) {
    throw new Error('The reserved shots invite project conflicts with cloned data.');
  }
  if (conflict.rowCount === 0) {
    await client.query(
      `INSERT INTO apps
         (id, name, slug, repo_url, container_id, status, created_by, created_at,
          main_sha, last_deploy_at, manifest_snapshot, self_hosted,
          collab_visibility, view_visibility, anon_shell)
       VALUES ($1, $2, $3, NULL, NULL, 'running', $4, NOW() - INTERVAL '3 days',
               NULL, NULL, NULL::jsonb, FALSE, 'private', 'private', 'public')`,
      [INVITE_APP_ID, INVITE_APP_NAME, INVITE_APP_SLUG, FULL_ADMIN_USER_ID]
    );
  } else {
    await client.query(
      `UPDATE apps
          SET name = $3, status = 'running', created_by = $4, self_hosted = FALSE,
              collab_visibility = 'private', view_visibility = 'private', anon_shell = 'public'
        WHERE id = $1 AND slug = $2`,
      [INVITE_APP_ID, INVITE_APP_SLUG, INVITE_APP_NAME, FULL_ADMIN_USER_ID]
    );
  }
  // The creator is a member of its community, the way the app trigger makes
  // its community and joins its maker (the insert left community_id NULL).
  const community = await client.query(
    'SELECT community_id FROM apps WHERE id = $1',
    [INVITE_APP_ID]
  );
  const communityId = community.rows[0]?.community_id;
  if (!communityId) throw new Error('The shots invite project has no community.');
  await client.query(
    `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
     VALUES ($1, $2, 'member', NOW() - INTERVAL '3 days')
     ON CONFLICT (app_id, user_id)
     DO UPDATE SET status = 'member', accepted_at = COALESCE(app_collaborators.accepted_at, NOW())`,
    [INVITE_APP_ID, FULL_ADMIN_USER_ID]
  );
  // The card its maker was shown, which the invite page's hero draws.
  await client.query(
    `INSERT INTO app_sketches (app_id, user_id, status, design, ready_at, created_at)
     VALUES ($1, $2, 'ready', $3::jsonb, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
     ON CONFLICT (app_id) DO UPDATE
       SET user_id = $2, status = 'ready', design = $3::jsonb,
           ready_at = COALESCE(app_sketches.ready_at, NOW() - INTERVAL '3 days')`,
    [INVITE_APP_ID, FULL_ADMIN_USER_ID, JSON.stringify({
      kind: 'card', emoji: '🏃', source: 'fallback',
      tagline: 'Log every run without a spreadsheet',
      points: ['Keep a private log of distance and how each run felt', 'See the week at a glance on one card'],
    })]
  );
  await client.query(
    `INSERT INTO community_invites (token, community_id, app_id, created_by, max_uses, expires_at, note)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5)
     ON CONFLICT (token) DO UPDATE
       SET community_id = $2, app_id = $3, created_by = $4, max_uses = NULL,
           expires_at = NULL, revoked_at = NULL, note = $5`,
    [INVITE_TOKEN, communityId, INVITE_APP_ID, FULL_ADMIN_USER_ID, INVITE_NOTE]
  );
  return {
    id: INVITE_PROFILE,
    persona: 'guest',
    startPath: `/invite/${INVITE_TOKEN}`,
    path: `/invite/${INVITE_TOKEN}`,
    appSlug: INVITE_APP_SLUG,
    token: INVITE_TOKEN,
    purpose: 'An invite link to a small private project, opened signed out.',
  };
}

function ensureInviteLinkIdentity({ databaseUrl, slug, runId, side }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
      const installed = await installInviteLinkFixture(client);
      await client.query('COMMIT');
      return installed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
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
  return withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
      const installed = await installHostedAppFixture(client, runId);
      await client.query('COMMIT');
      return installed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
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
  return withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
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
      await client.query('COMMIT');
      return {
        id: PROFILE,
        persona: 'member',
        startPath: '/#messages',
        path: `/#messages/agent/${MEMBER_SESSION_ID}`,
        title: session.title,
        sessionId: MEMBER_SESSION_ID,
        changeId: MEMBER_CHANGE_ID,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

// The full admin gets an agent session too. Without one, anything drawn only
// for a viewer with sessions (the menu's Agent sessions list) is absent on a
// before build, and its change cannot be shown there.
async function copyFullAdminAgentSession({ databaseUrl, slug, runId, side, selfAppSlug }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
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
      await client.query('COMMIT');
      return {
        id: FULL_ADMIN_SESSION_PROFILE,
        persona: 'full_admin',
        startPath: '/#messages',
        path: `/#messages/agent/${FULL_ADMIN_SESSION_ID}`,
        title: session.title,
        sessionId: FULL_ADMIN_SESSION_ID,
        changeId: FULL_ADMIN_CHANGE_ID,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

module.exports = {
  assertShotsDatabase,
  withClient,
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
  INVITED_USER_ID,
  INVITED_USERNAME,
  INVITED_PROFILE,
  INVITED_LISTED_USER_ID,
  INVITED_LISTED_USERNAME,
  INVITED_LISTED_PROFILE,
  INVITE_APP_ID,
  INVITE_APP_SLUG,
  INVITE_APP_NAME,
  INVITE_TOKEN,
  INVITE_NOTE,
  INVITE_PROFILE,
  HOSTED_APP_ID: hostedApp.HOSTED_APP_ID,
  HOSTED_APP_PROFILE: hostedApp.HOSTED_APP_PROFILE,
  hostedAppSlug: hostedApp.hostedAppSlug,
  installFullAdminFixture,
  ensureFullAdminIdentity,
  installInvitedMemberFixture,
  ensureInvitedMemberIdentity,
  installInviteLinkFixture,
  ensureInviteLinkIdentity,
  installHostedAppFixture,
  ensureHostedAppFixture,
  canCopyMemberAgentSession,
  copyMemberAgentSession,
};
