'use strict';

// Shots-only rows are written to the paired, disposable app databases
// after their exact-revision images boot. The platform's staging check owns
// agent session 990801 as usernode-capture-admin; the shots member cannot
// read it. Copy its real staging conversation to a separate member-owned row
// so a member story can follow an actual Messages row on both revisions.

const { Client } = require('pg');
const crypto = require('node:crypto');
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

// THE INVITED-MEMBER FIXTURES (#4437). One made-up private project, its two
// invited members and the invite link that let them in, inserted only into
// the two disposable shots databases. The personas they answer for: a
// private member who has not been Home yet (first-visit, offered "Go to
// Homeroom"), one on the platform waitlist (listed, joined by email), and
// the unsigned-in visitor the invite link itself opens for. The two members
// are two separate people, not one browser switching states: the first
// visit lives in the browser's storage (the private-home key), so the
// listed persona's storage state carries it and the first-visit persona's
// does not. The high, fixed ids sit beside the full-admin identity's.
const INVITED_APP_ID = 2147482998;
const INVITED_APP_SLUG = 'shots-fixture-picnic-planner';
const INVITED_MEMBER_USER_ID = 2147483001;
const INVITED_MEMBER_USERNAME = 'usernode-shots-invited';
const INVITED_MEMBER_LISTED_USER_ID = 2147483002;
const INVITED_MEMBER_LISTED_USERNAME = 'usernode-shots-invited-listed';
const INVITED_FIRST_VISIT_PROFILE = 'platform-invited-member-first-visit-v1';
const INVITED_LISTED_PROFILE = 'platform-invited-member-listed-v1';
const INVITE_LINK_PROFILE = 'platform-guest-invite-link-v1';
// The invite's maker: the staging general channel's own person, present in
// every staging clone. The link lives only while its maker's standing does
// (community_invite_maker_holds), so a collaborator row keeps it true here.
const INVITE_MAKER_USER_ID = 902784;
const INVITE_MAKER_USERNAME = 'staging-demo-general-lin';
const INVITED_NOTE = '[shots fixture] Come help us plan the summer picnic!';
const INVITED_SKETCH_DESIGN = Object.freeze({
  kind: 'card',
  emoji: '🧺',
  tagline: 'Plan the club picnic together',
  points: ['Pick a date and a place', 'List what to bring', 'Sign up for food and games'],
});

// The link's 22-character token, derived from the run so both sides mint
// the same one and the entry's path names it. community-invites TOKEN_RE
// reads /^[A-Za-z0-9_-]{22}$/, and base64url's alphabet is exactly that.
function invitedInviteToken(runId) {
  return crypto.createHash('sha256').update(`${runId}:invite-token`).digest('base64url').slice(0, 22);
}
// The waitlist's stage-2 capability for the listed member, unique per run.
function invitedWaitlistToken(runId) {
  return crypto.createHash('sha256').update(`${runId}:waitlist-token`).digest('hex').slice(0, 32);
}

function assertShotsDatabase(databaseUrl, slug, runId, side) {
  const expected = dbManager.shotsDbName(slug, runId, side);
  const actual = new URL(databaseUrl).pathname.slice(1);
  if (actual !== expected) throw new Error('Before & after shots fixture requires its isolated shots database.');
}

// ONE MOMENT FOR BOTH SIDES. Every row the platform writes into a pair is
// stamped from one instant, read once per reset (shots-environment.resetPair)
// and handed to both sides. Postgres reads NOW() from each side's own
// transaction, which began at its own instant, so rows written "together"
// were never quite the same: they differed by however far apart the two
// transactions began, microseconds for the demo states and a tenth of a
// second or more for writes made on one side after the other.
function pairMoment(at) {
  const ms = at == null ? Date.now() : at instanceof Date ? at.getTime() : Date.parse(String(at));
  if (!Number.isFinite(ms)) throw new Error('Before & after shots fixtures need a valid moment.');
  return new Date(ms).toISOString();
}

// A client whose NOW() is that moment: each NOW() in a statement is bound to
// it as the statement's next parameter. The fixtures and demo states keep
// writing NOW() in their SQL, so a state added later is pinned the same way.
// Column defaults and triggers are Postgres's own and still read its clock.
const NOW_CALL = /\bNOW\(\)/gi;
function atMoment(client, at) {
  const moment = pairMoment(at);
  return {
    query(sql, params) {
      if (typeof sql !== 'string' || !/\bNOW\(\)/i.test(sql)) return client.query(sql, params);
      const values = params ? [...params, moment] : [moment];
      return client.query(sql.replace(NOW_CALL, `$${values.length}::timestamptz`), values);
    },
  };
}

async function withClient(databaseUrl, fn, { at = null } = {}) {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    application_name: require('../db/connection-options').connectionName('shots'),
  });
  await client.connect();
  try { return await fn(at == null ? client : atMoment(client, at)); }
  finally { await client.end(); }
}

// One fixture write, as one transaction on a fresh connection. These rows go
// in while both booted copies are already running against the same
// databases, so a write can lose a deadlock (40P01) or a serialization
// conflict (40001) to the app's own work. That says nothing about the
// proposal, and the rolled-back transaction is simply run again, a bounded
// number of times; any other failure, or one that outlasts the retries,
// fails as before.
async function inTransaction(databaseUrl, fn, { retry = {}, at = null } = {}) {
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
  }, { at }), { label: 'Shots fixture write', ...retry });
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
          has_platform_access, platform_access_granted_at, created_at)
       VALUES ($1, $2, '__shots_not_a_login__', TRUE, FALSE, FALSE, TRUE, NOW(), NOW())`,
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

async function ensureFullAdminIdentity({ databaseUrl, slug, runId, side, at = null }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return inTransaction(databaseUrl, (client) => installFullAdminFixture(client, slug), { at });
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

async function ensureHostedAppFixture({ databaseUrl, slug, runId, side, at = null }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return inTransaction(databaseUrl, (client) => installHostedAppFixture(client, runId), { at });
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

async function copyMemberAgentSession({ databaseUrl, slug, runId, side, selfAppSlug, at = null }) {
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
  }, { at });
}

// The full admin gets an agent session too. Without one, anything drawn only
// for a viewer with sessions (the menu's Agent sessions list) is absent on a
// before build, and its change cannot be shown there.
async function copyFullAdminAgentSession({ databaseUrl, slug, runId, side, selfAppSlug, at = null }) {
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
  }, { at });
}

// Whether a side can hold the invited fixtures at all: the tables and user
// columns the rows go into, the invite's maker (the staging general
// channel's own person) and the platform app the private community is
// built on. A copy missing any of them simply gets the fixtures left out.
async function canInstallInvitedFixtures({ databaseUrl, slug, runId, side, selfAppSlug }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    const { rows } = await client.query(
      `SELECT to_regclass('public.community_invites') IS NOT NULL AS has_invites,
              to_regclass('public.app_sketches') IS NOT NULL AS has_sketches,
              to_regclass('public.waitlist_signups') IS NOT NULL AS has_waitlist,
              EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = 'users'
                         AND column_name = 'private_member_since') AS has_private_members`
    );
    if (!rows[0]?.has_invites || !rows[0]?.has_sketches
        || !rows[0]?.has_waitlist || !rows[0]?.has_private_members) return false;
    const ready = await client.query(
      `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND username = $2) AS maker_ready,
              EXISTS (SELECT 1 FROM apps WHERE slug = $3) AS self_app_ready`,
      [INVITE_MAKER_USER_ID, INVITE_MAKER_USERNAME, selfAppSlug]
    );
    return ready.rows[0]?.maker_ready === true && ready.rows[0]?.self_app_ready === true;
  });
}

// The private project, its two invited members, the sketch and the link,
// as one transaction. Mirrors apply_community_invite's grant: a
// collaborator row joins, a community-members row and a Home pin keep the
// person there. Idempotent, so a retried reset lands on the update path.
async function installInvitedFixtures(client, { selfAppSlug, runId }) {
  const token = invitedInviteToken(runId);
  const maker = await client.query('SELECT id FROM users WHERE id = $1 AND username = $2',
    [INVITE_MAKER_USER_ID, INVITE_MAKER_USERNAME]);
  if (maker.rowCount !== 1) throw new Error('The shots invite maker is missing from the paired fixture.');
  await client.query('SELECT id FROM apps WHERE slug = $1', [selfAppSlug]);
  const existing = await client.query(
    `SELECT id, slug FROM apps WHERE id = $1 OR slug = $2 FOR UPDATE`,
    [INVITED_APP_ID, INVITED_APP_SLUG]
  );
  if (existing.rows.some((row) => Number(row.id) !== INVITED_APP_ID || row.slug !== INVITED_APP_SLUG)) {
    throw new Error('The reserved shots invited app conflicts with cloned data.');
  }
  if (existing.rowCount === 0) {
    // community_id stays NULL: the boot trigger makes the project's
    // private community, as it does for every app created in the app.
    await client.query(
      `INSERT INTO apps
         (id, name, slug, status, created_by, self_hosted,
          collab_visibility, view_visibility, icon_emoji, created_at)
       VALUES ($1, $2, $3, 'running', $4, FALSE, 'private', 'private', $5, NOW())`,
      [INVITED_APP_ID, '[shots fixture] Picnic planner', INVITED_APP_SLUG,
        INVITE_MAKER_USER_ID, INVITED_SKETCH_DESIGN.emoji]
    );
  } else {
    await client.query(
      `UPDATE apps
          SET name = $3, status = 'running', created_by = $4, self_hosted = FALSE,
              collab_visibility = 'private', view_visibility = 'private', icon_emoji = $5
        WHERE id = $1 AND slug = $2`,
      [INVITED_APP_ID, INVITED_APP_SLUG, '[shots fixture] Picnic planner',
        INVITE_MAKER_USER_ID, INVITED_SKETCH_DESIGN.emoji]
    );
  }
  const { rows: appRows } = await client.query(
    'SELECT community_id FROM apps WHERE id = $1 AND community_id IS NOT NULL', [INVITED_APP_ID]
  );
  const communityId = appRows[0]?.community_id;
  if (!Number.isInteger(communityId)) {
    throw new Error('The shots invited app has no community to invite into.');
  }
  // The two members: no platform access, joined an hour ago. Their
  // passwords are unusable; sessions come from minted tokens only.
  const invitedUsers = [
    [INVITED_MEMBER_USER_ID, INVITED_MEMBER_USERNAME],
    [INVITED_MEMBER_LISTED_USER_ID, INVITED_MEMBER_LISTED_USERNAME],
  ];
  for (const [userId, username] of invitedUsers) {
    await client.query(
      `INSERT INTO users
         (id, username, password, is_admin, can_create_apps,
          has_platform_access, private_member_since, created_at)
       VALUES ($1, $2, '__shots_not_a_login__', FALSE, FALSE, FALSE, NOW() - INTERVAL '1 hour', NOW())
       ON CONFLICT (id) DO UPDATE
         SET username = EXCLUDED.username, is_admin = FALSE, can_create_apps = FALSE,
             has_platform_access = FALSE,
             private_member_since = COALESCE(users.private_member_since, EXCLUDED.private_member_since)`,
      [userId, username]
    );
    await client.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES ($1, $2, 'member', $3, NOW())
       ON CONFLICT (app_id, user_id)
       DO UPDATE SET status = 'member', invited_by = $3,
                     accepted_at = COALESCE(app_collaborators.accepted_at, NOW())`,
      [INVITED_APP_ID, userId, INVITE_MAKER_USER_ID]
    );
    await client.query(
      `INSERT INTO community_members (community_id, user_id, source)
       VALUES ($1, $2, 'joined')
       ON CONFLICT (community_id, user_id) DO NOTHING`,
      [communityId, userId]
    );
    await client.query(
      `INSERT INTO app_favorites (app_id, user_id, hidden)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (app_id, user_id) DO UPDATE SET hidden = FALSE`,
      [INVITED_APP_ID, userId]
    );
  }
  // The maker keeps the standing to grant what the link grants
  // (community_invite_maker_holds), so its page and preview stay live.
  await client.query(
    `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
     VALUES ($1, $2, 'member', NULL, NOW())
     ON CONFLICT (app_id, user_id)
     DO UPDATE SET status = 'member',
                   accepted_at = COALESCE(app_collaborators.accepted_at, NOW())`,
    [INVITED_APP_ID, INVITE_MAKER_USER_ID]
  );
  // The sketch the project's FeaturedCard is drawn from: pictureFor reads
  // the ready row's design, kind 'card', so the project's page and the
  // invite page both show a picture.
  await client.query(
    `INSERT INTO app_sketches (app_id, user_id, status, design, created_at, ready_at)
     VALUES ($1, $2, 'ready', $3::jsonb, NOW(), NOW())
     ON CONFLICT (app_id) DO UPDATE
       SET user_id = EXCLUDED.user_id, status = 'ready', design = EXCLUDED.design,
           ready_at = NOW(), committed_at = NULL, html = NULL, error = NULL`,
    [INVITED_APP_ID, INVITE_MAKER_USER_ID, JSON.stringify(INVITED_SKETCH_DESIGN)]
  );
  // The link: no end date, no use limit, the maker's own words as its note.
  await client.query(
    `INSERT INTO community_invites
       (token, community_id, app_id, created_by, max_uses, uses, expires_at, revoked_at, note)
     VALUES ($1, $2, $3, $4, NULL, 0, NULL, NULL, $5)
     ON CONFLICT (token) DO UPDATE
       SET community_id = EXCLUDED.community_id, app_id = EXCLUDED.app_id,
           created_by = EXCLUDED.created_by, revoked_at = NULL, note = EXCLUDED.note`,
    [token, communityId, INVITED_APP_ID, INVITE_MAKER_USER_ID, INVITED_NOTE]
  );
  // The listed member joined the waitlist by email and is confirmed, not
  // released: member-waitlist.stateFor reads 'listed'.
  await client.query(
    `INSERT INTO waitlist_signups
       (email, submitted_at, confirmed_at, released_at, linked_user_id, more_token)
     VALUES ('shots-invited-listed@shots-fixture.invalid', NOW(), NOW() - INTERVAL '30 minutes', NULL, $1, $2)
     ON CONFLICT (email) DO UPDATE
       SET linked_user_id = EXCLUDED.linked_user_id,
           confirmed_at = COALESCE(waitlist_signups.confirmed_at, EXCLUDED.confirmed_at),
           released_at = NULL, more_token = EXCLUDED.more_token`,
    [INVITED_MEMBER_LISTED_USER_ID, invitedWaitlistToken(runId)]
  );
  return [
    {
      id: INVITED_FIRST_VISIT_PROFILE,
      persona: 'invited_member',
      startPath: '/',
      path: '/',
      userId: INVITED_MEMBER_USER_ID,
      username: INVITED_MEMBER_USERNAME,
      appSlug: INVITED_APP_SLUG,
      purpose: 'A private member on their first visit to Home, still offered Go to Homeroom.',
    },
    {
      id: INVITED_LISTED_PROFILE,
      persona: 'invited_member_listed',
      startPath: '/',
      path: '/',
      userId: INVITED_MEMBER_LISTED_USER_ID,
      username: INVITED_MEMBER_LISTED_USERNAME,
      appSlug: INVITED_APP_SLUG,
      purpose: 'A private member who has been Home and is on the platform waitlist.',
    },
    {
      id: INVITE_LINK_PROFILE,
      persona: 'guest',
      startPath: `/invite/${token}`,
      path: `/invite/${token}`,
      appSlug: INVITED_APP_SLUG,
      inviteToken: token,
      note: INVITED_NOTE,
      purpose: 'A live invite link to a private project with a sketch, opening for a visitor who is not signed in.',
    },
  ];
}

async function ensureInvitedFixtures({ databaseUrl, slug, runId, side, selfAppSlug, at = null }) {
  assertShotsDatabase(databaseUrl, slug, runId, side);
  return inTransaction(databaseUrl, (client) => installInvitedFixtures(client, { selfAppSlug, runId }), { at });
}

module.exports = {
  assertShotsDatabase,
  pairMoment,
  atMoment,
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
  INVITED_APP_ID,
  INVITED_APP_SLUG,
  INVITE_MAKER_USER_ID,
  INVITE_MAKER_USERNAME,
  INVITED_MEMBER_USER_ID,
  INVITED_MEMBER_USERNAME,
  INVITED_MEMBER_LISTED_USER_ID,
  INVITED_MEMBER_LISTED_USERNAME,
  INVITED_FIRST_VISIT_PROFILE,
  INVITED_LISTED_PROFILE,
  INVITE_LINK_PROFILE,
  invitedInviteToken,
  invitedWaitlistToken,
  canInstallInvitedFixtures,
  installInvitedFixtures,
  ensureInvitedFixtures,
};
