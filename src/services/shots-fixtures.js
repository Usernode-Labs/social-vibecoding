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
// Invited-member fixtures: two private members of one made-up project, an
// invite link to it, and the project itself. A private member
// (has_platform_access FALSE, private_member_since set) is somebody an invite
// link let into a project before they were let into Homeroom, which no
// signed-in shots persona was. The high, fixed ids sit beside the full
// admin's; the token matches community-invite tokens (22 URL-safe chars) but
// is written straight into the two disposable databases, never minted by the
// live invite service.
const INVITED_USER_ID = 2147482998;
const WAITLISTED_USER_ID = 2147482997;
const INVITE_PROJECT_ID = 2147482996;
const INVITED_USERNAME = 'usernode-shots-invited';
const WAITLISTED_USERNAME = 'usernode-shots-waitlisted';
const INVITE_PROJECT_NAME = '[shots fixture] Book swap';
const INVITE_PROJECT_SLUG = 'shots-fixture-book-swap';
const INVITE_PROJECT_EMOJI = '📚';
const INVITE_TOKEN = 'shotsFixtureInvite0001';
const WAITLISTED_EMAIL = 'shots-fixture-waitlisted@example.invalid';
const INVITED_PROFILE = 'platform-invited-member-v1';
const WAITLISTED_PROFILE = 'platform-waitlisted-member-v1';
const INVITE_LINK_PROFILE = 'platform-invite-link-v1';
const SHOTS_PASSWORD = '__shots_not_a_login__';

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

// ── Invited members, an invite link and the project they belong to ──────

const INVITED_TABLES = Object.freeze(['apps', 'users', 'app_collaborators',
  'community_members', 'community_invites', 'waitlist_signups', 'app_sketches',
  'communities']);

// The shape and the free identities this fixture needs, on one side. A row
// that occupies a reserved identity is installable only when it is already
// this run's marked row (a reset rewrites it to the same values); anything
// else is cloned data in the way, and the fixture is left out.
async function canInstallInvitedFixtures({ databaseUrl, slug, runId, side }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [INVITED_TABLES]
    );
    const present = new Set(rows.map((row) => row.table_name));
    if (INVITED_TABLES.some((table) => !present.has(table))) return false;
    const taken = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM apps
                  WHERE (id = $1 OR slug = $3)
                    AND (manifest_snapshot->'usernode_shots_fixture'->>'runId') IS DISTINCT FROM $2)
           AS app_taken,
         EXISTS (SELECT 1 FROM apps WHERE slug = $3
                   AND (manifest_snapshot->'usernode_shots_fixture'->>'runId') = $2
                   AND id <> $1) AS slug_taken,
         EXISTS (SELECT 1 FROM users
                  WHERE id = ANY($4::bigint[])
                    AND ((id = $5 AND username IS DISTINCT FROM $7)
                      OR (id = $6 AND username IS DISTINCT FROM $8))) AS user_taken,
         EXISTS (SELECT 1 FROM users
                  WHERE username IN ($7, $8) AND id NOT IN ($5, $6)) AS username_taken,
         EXISTS (SELECT 1 FROM waitlist_signups
                  WHERE email = $9 AND linked_user_id IS DISTINCT FROM $6) AS email_taken,
         EXISTS (SELECT 1 FROM community_invites
                  WHERE token = $10 AND app_id IS DISTINCT FROM $1) AS token_taken
       `,
      [INVITE_PROJECT_ID, runId, INVITE_PROJECT_SLUG,
        [INVITED_USER_ID, WAITLISTED_USER_ID], INVITED_USER_ID, WAITLISTED_USER_ID,
        INVITED_USERNAME, WAITLISTED_USERNAME, WAITLISTED_EMAIL, INVITE_TOKEN]
    );
    return !taken.rows[0].app_taken && !taken.rows[0].slug_taken
      && !taken.rows[0].user_taken && !taken.rows[0].username_taken
      && !taken.rows[0].email_taken && !taken.rows[0].token_taken;
  });
}

async function installInvitedFixtures(client, runId) {
  const maker = await client.query(
    `SELECT id FROM users WHERE username = 'usernode-capture' AND is_admin = FALSE`
  );
  if (maker.rowCount !== 1) {
    throw new Error('The invited-member fixture has no shots member to make its project.');
  }
  const memberId = maker.rows[0].id;
  const conflict = await client.query(
    `SELECT id, slug, manifest_snapshot FROM apps
      WHERE id = $1 OR slug = $2
      FOR UPDATE`,
    [INVITE_PROJECT_ID, INVITE_PROJECT_SLUG]
  );
  if (conflict.rows.some((row) => !row.manifest_snapshot
      || row.manifest_snapshot?.usernode_shots_fixture?.runId !== runId)) {
    throw new Error('The reserved shots invite project conflicts with cloned data.');
  }
  const users = await client.query(
    `SELECT id, username FROM users
      WHERE id = ANY($1::bigint[]) OR username = ANY($2::text[])
      FOR UPDATE`,
    [[INVITED_USER_ID, WAITLISTED_USER_ID], [INVITED_USERNAME, WAITLISTED_USERNAME]]
  );
  if (users.rows.some((row) => ![INVITED_USER_ID, WAITLISTED_USER_ID].includes(Number(row.id))
      || ![INVITED_USERNAME, WAITLISTED_USERNAME].includes(row.username))) {
    throw new Error('The reserved shots invited identities conflict with cloned data.');
  }
  const marker = JSON.stringify({
    usernode_shots_fixture: { version: 1, runId, kind: 'invite-project' },
  });
  const appValues = [
    INVITE_PROJECT_ID, INVITE_PROJECT_NAME, INVITE_PROJECT_SLUG, memberId,
    marker, INVITE_PROJECT_EMOJI,
  ];
  if (conflict.rowCount === 0) {
    await client.query(
      `INSERT INTO apps
         (id, name, slug, status, created_by, container_id, main_sha, created_at,
          manifest_snapshot, icon_emoji, collab_visibility, view_visibility)
       VALUES ($1, $2, $3, 'running', $4, NULL, NULL, NOW() - INTERVAL '2 days',
               $5::jsonb, $6, 'private', 'private')`,
      appValues
    );
  } else {
    await client.query(
      `UPDATE apps
          SET name = $2, status = 'running', created_by = $4, container_id = NULL,
              main_sha = NULL, manifest_snapshot = $5::jsonb, icon_emoji = $6,
              collab_visibility = 'private', view_visibility = 'private'
        WHERE id = $1 AND slug = $3`,
      appValues
    );
  }
  const app = await client.query(
    `SELECT id, community_id FROM apps WHERE id = $1`,
    [INVITE_PROJECT_ID]
  );
  if (app.rowCount !== 1 || app.rows[0].community_id == null) {
    throw new Error('The shots invite fixture project has no community.');
  }
  const communityId = app.rows[0].community_id;
  // The two members' accounts exist before their collaborator rows do (the
  // collaborator table points at users).
  for (const [userId, username] of [[INVITED_USER_ID, INVITED_USERNAME],
    [WAITLISTED_USER_ID, WAITLISTED_USERNAME]]) {
    await client.query(
      `INSERT INTO users (id, username, password, has_platform_access,
                          private_member_since, needs_communities_choice)
       VALUES ($1, $2, $3, FALSE, NOW() - INTERVAL '1 day', FALSE)
       ON CONFLICT (id) DO UPDATE
         SET username = $2, password = $3, has_platform_access = FALSE,
             private_member_since = COALESCE(users.private_member_since, NOW() - INTERVAL '1 day'),
             needs_communities_choice = FALSE`,
      [userId, username, SHOTS_PASSWORD]
    );
  }
  for (const userId of [memberId, INVITED_USER_ID, WAITLISTED_USER_ID]) {
    await client.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW() - INTERVAL '1 day')
       ON CONFLICT (app_id, user_id)
       DO UPDATE SET status = 'member', accepted_at = COALESCE(app_collaborators.accepted_at, NOW() - INTERVAL '1 day')`,
      [INVITE_PROJECT_ID, userId]
    );
  }
  // Community membership follows from the collaborator row (the platform
  // rule); the trigger writes it. Fail rather than continue without it.
  const memberships = await client.query(
    `SELECT user_id FROM community_members
      WHERE community_id = $1 AND user_id = ANY($2::bigint[])`,
    [communityId, [INVITED_USER_ID, WAITLISTED_USER_ID]]
  );
  if (memberships.rowCount !== 2) {
    throw new Error('The shots invite fixture did not get its community memberships from the collaborator trigger.');
  }
  await client.query(
    `INSERT INTO waitlist_signups (email, submitted_at, confirmed_at, released_at,
                                   linked_user_id, more_token, answers)
     VALUES ($1, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', NULL,
             $2, $3, NULL)
     ON CONFLICT (email) DO UPDATE
       SET confirmed_at = COALESCE(waitlist_signups.confirmed_at, NOW() - INTERVAL '1 hour'),
           released_at = NULL,
           linked_user_id = $2,
           more_token = $3`,
    [WAITLISTED_EMAIL, WAITLISTED_USER_ID, 'shots-fixture-more-token']
  );
  await client.query(
    `INSERT INTO app_sketches (app_id, user_id, status, design, ready_at)
     VALUES ($1, $2, 'ready', $3::jsonb, NOW() - INTERVAL '1 day')
     ON CONFLICT (app_id) DO UPDATE
       SET user_id = $2, status = 'ready', design = $3::jsonb, ready_at = NOW() - INTERVAL '1 day'`,
    [INVITE_PROJECT_ID, memberId, JSON.stringify({
      kind: 'card', emoji: INVITE_PROJECT_EMOJI,
      tagline: '[shots fixture] Swap books with your neighbours',
      points: [
        '[shots fixture] List the books you can lend',
        '[shots fixture] Ask to borrow one you like',
        '[shots fixture] Meet up and swap',
      ],
      source: 'fallback',
    })]
  );
  await client.query(
    `INSERT INTO community_invites (token, community_id, app_id, created_by,
                                    expires_at, max_uses, note)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5)
     ON CONFLICT (token) DO UPDATE
       SET community_id = $2, app_id = $3, created_by = $4,
           expires_at = NULL, max_uses = NULL, revoked_at = NULL, note = $5`,
    [INVITE_TOKEN, communityId, INVITE_PROJECT_ID, memberId,
      '[shots fixture] Come help us try the book swap.']
  );
  return [
    {
      id: INVITED_PROFILE,
      persona: 'invited_member',
      startPath: `/#app/${INVITE_PROJECT_SLUG}`,
      path: `/#app/${INVITE_PROJECT_SLUG}`,
      appSlug: INVITE_PROJECT_SLUG,
      shows: 'A private member of the fixture project on their first visit: '
        + 'the project menu offers Go to Homeroom, with Add Homeroom to your '
        + 'home screen inside that card on a phone. Pressing Go to Homeroom '
        + 'uses up this browser\'s first visit, so shoot first-visit changes '
        + 'before you press it. After it, Home shows the waitlist card at Join.',
    },
    {
      id: WAITLISTED_PROFILE,
      persona: 'waitlisted_member',
      startPath: '/#home',
      path: '/#home',
      shows: 'A private member who has been Home and joined the waitlist by '
        + 'email: Home\'s waitlist card reads On the waitlist, with the '
        + 'address they joined with.',
    },
    {
      id: INVITE_LINK_PROFILE,
      persona: 'guest',
      startPath: `/invite/${INVITE_TOKEN}`,
      path: `/invite/${INVITE_TOKEN}`,
      shows: 'A live invite to a private project still being built, with its '
        + 'sketch card and the sender\'s note.',
    },
  ];
}

async function ensureInvitedFixtures({ databaseUrl, slug, runId, side }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
      const installed = await installInvitedFixtures(client, runId);
      await client.query('COMMIT');
      return installed;
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
  WAITLISTED_USER_ID,
  INVITE_PROJECT_ID,
  INVITED_USERNAME,
  WAITLISTED_USERNAME,
  INVITE_PROJECT_NAME,
  INVITE_PROJECT_SLUG,
  INVITE_TOKEN,
  WAITLISTED_EMAIL,
  INVITED_PROFILE,
  WAITLISTED_PROFILE,
  INVITE_LINK_PROFILE,
  canInstallInvitedFixtures,
  installInvitedFixtures,
  ensureInvitedFixtures,
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
