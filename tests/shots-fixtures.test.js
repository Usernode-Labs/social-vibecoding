'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('../src/services/shots-fixtures');

test('shots identities and rows cannot be created, inspected, or copied outside the run database', async () => {
  const input = {
    databaseUrl: 'postgres://usernode:localdev@127.0.0.1:5440/usernode',
    slug: 'usernode-2d5619', runId: '1'.repeat(32), side: 'base',
    selfAppSlug: 'usernode-2d5619',
  };
  await assert.rejects(fixtures.ensureFullAdminIdentity(input), /isolated shots database/);
  await assert.rejects(fixtures.ensureHostedAppFixture(input), /isolated shots database/);
  await assert.rejects(fixtures.canCopyMemberAgentSession(input), /isolated shots database/);
  await assert.rejects(fixtures.copyMemberAgentSession(input), /isolated shots database/);
  await assert.rejects(fixtures.copyFullAdminAgentSession(input), /isolated shots database/);
});

test('the full admin gets its own copy of the fixture agent session, with its change and a message', async () => {
  // Without one, a list drawn only for a viewer with sessions (the menu's
  // Agent sessions) is missing on the before build of a full-admin change.
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/INSERT INTO agent_sessions/.test(sql)) return { rowCount: 1, rows: [{ id: params[0], title: 'Fixture session' }] };
      return { rowCount: 1, rows: [{ id: params?.[0] }] };
    },
  };
  const session = await fixtures.copyAgentSession(client, {
    userId: fixtures.FULL_ADMIN_USER_ID, appId: 7, sessionId: fixtures.FULL_ADMIN_SESSION_ID,
    changeId: fixtures.FULL_ADMIN_CHANGE_ID, branch: 'shots-fixture/full-admin-agent-session', persona: 'full admin',
  });
  assert.equal(session.title, 'Fixture session');
  const insert = queries.find(({ sql }) => /INSERT INTO agent_sessions/.test(sql));
  assert.deepEqual(insert.params, [fixtures.FULL_ADMIN_SESSION_ID, fixtures.FULL_ADMIN_USER_ID, 7, fixtures.SOURCE_SESSION_ID]);
  assert.match(insert.sql, /u\.username = 'usernode-capture-admin'/, 'copied from the staging fixture\'s own session');
  const change = queries.find(({ sql }) => /INSERT INTO chat_sessions/.test(sql));
  assert.equal(change.params[0], fixtures.FULL_ADMIN_CHANGE_ID);
  assert.equal(change.params[6], 'shots-fixture/full-admin-agent-session');
  assert.ok(queries.some(({ sql }) => /INSERT INTO chat_session_messages/.test(sql)));
  assert.notEqual(fixtures.FULL_ADMIN_SESSION_ID, fixtures.MEMBER_SESSION_ID);
  assert.notEqual(fixtures.FULL_ADMIN_CHANGE_ID, fixtures.MEMBER_CHANGE_ID);
});

test('the hosted-app fixture is a public running row bound to the exact shots run', async () => {
  const queries = [];
  const runId = 'a'.repeat(32);
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id, slug, manifest_snapshot FROM apps/.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const installed = await fixtures.installHostedAppFixture(client, runId);
  const insert = queries.find(({ sql }) => /INSERT INTO apps/.test(sql));
  assert.equal(installed.id, fixtures.HOSTED_APP_PROFILE);
  assert.equal(installed.appSlug, fixtures.hostedAppSlug(runId));
  assert.match(insert.sql, /'running'/);
  assert.match(insert.sql, /'public', 'public'/);
  assert.deepEqual(JSON.parse(insert.params[2]).usernode_shots_fixture, {
    version: 1, runId, kind: 'hosted-app-bridge',
  });
});

test('the hosted-app fixture refuses a cloned row that occupies its reserved identity', async () => {
  const runId = 'd'.repeat(32);
  const client = {
    async query(sql) {
      if (/SELECT id, slug, manifest_snapshot FROM apps/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: fixtures.HOSTED_APP_ID,
            slug: fixtures.hostedAppSlug(runId),
            manifest_snapshot: null,
          }],
        };
      }
      throw new Error('Fixture installation must stop before writing the conflicting row.');
    },
  };
  await assert.rejects(fixtures.installHostedAppFixture(client, runId),
    /conflicts with cloned data/);
});

test('the isolated full-admin fixture includes self-app membership for channel shots', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id FROM apps/.test(sql)) return { rowCount: 1, rows: [{ id: 42 }] };
      if (/SELECT id, username FROM users/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
  const installed = await fixtures.installFullAdminFixture(client, 'usernode-2d5619');
  const membership = queries.find(({ sql }) => /INSERT INTO app_collaborators/.test(sql));
  assert.match(fixtures.FULL_ADMIN_PROFILE, /self-member-v2$/);
  assert.deepEqual(membership.params, [42, fixtures.FULL_ADMIN_USER_ID]);
  assert.deepEqual(installed.appMembership,
    { appId: 42, slug: 'usernode-2d5619', status: 'member' });
});

test('the invited-member fixtures cannot be created, inspected, or copied outside the run database', async () => {
  const input = {
    databaseUrl: 'postgres://usernode:localdev@127.0.0.1:5440/usernode',
    slug: 'usernode-2d5619', runId: '1'.repeat(32), side: 'base',
    selfAppSlug: 'usernode-2d5619',
  };
  await assert.rejects(fixtures.canInstallInvitedFixtures(input), /isolated shots database/);
  await assert.rejects(fixtures.ensureInvitedFixtures(input), /isolated shots database/);
});

test('the invited-member fixture writes the project, its two private members and a live invite, marked as its own', async () => {
  // The users' accounts must exist before their collaborator rows do (the
  // collaborator table points at users), the community membership the
  // trigger writes is verified, and every write is idempotent.
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id FROM users WHERE username = 'usernode-capture'/.test(sql)) {
        return { rowCount: 1, rows: [{ id: 7 }] };
      }
      if (/FOR UPDATE/.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT id, community_id FROM apps/.test(sql)) {
        return { rowCount: 1, rows: [{ id: fixtures.INVITE_PROJECT_ID, community_id: 77 }] };
      }
      if (/SELECT user_id FROM community_members/.test(sql)) return { rowCount: 2, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
  const installed = await fixtures.installInvitedFixtures(client, 'a'.repeat(32));
  const order = queries.map(({ sql }) => sql);
  const firstUser = order.findIndex((sql) => /INSERT INTO users \(/.test(sql));
  const firstCollab = order.findIndex((sql) => /INSERT INTO app_collaborators/.test(sql));
  assert.ok(firstUser !== -1 && firstCollab !== -1 && firstUser < firstCollab,
    'the accounts exist before the collaborator rows point at them');
  const app = queries.find(({ sql }) => /INSERT INTO apps/.test(sql));
  assert.equal(app.params[0], fixtures.INVITE_PROJECT_ID);
  assert.equal(app.params[1], '[shots fixture] Book swap');
  assert.equal(app.params[2], 'shots-fixture-book-swap');
  assert.deepEqual(JSON.parse(app.params[4]), {
    usernode_shots_fixture: { version: 1, runId: 'a'.repeat(32), kind: 'invite-project' },
  });
  const userUpserts = queries.filter(({ sql }) => /INSERT INTO users \(/.test(sql));
  assert.deepEqual(userUpserts.map(({ params }) => [Number(params[0]), params[1]]), [
    [fixtures.INVITED_USER_ID, fixtures.INVITED_USERNAME],
    [fixtures.WAITLISTED_USER_ID, fixtures.WAITLISTED_USERNAME],
  ]);
  assert.ok(userUpserts.every(({ sql }) => /has_platform_access,\s+private_member_since/.test(sql)
    && /FALSE, NOW\(\) - INTERVAL '1 day', FALSE\)/.test(sql)), 'both are private members, not let in');
  const waitlist = queries.find(({ sql }) => /INSERT INTO waitlist_signups/.test(sql));
  assert.equal(waitlist.params[0], 'shots-fixture-waitlisted@example.invalid');
  assert.match(waitlist.sql, /released_at,\s+linked_user_id/, 'columns line up with the values');
  assert.match(waitlist.sql, /NOW\(\) - INTERVAL '1 hour', NULL,/, 'confirmed, not released');
  assert.equal(Number(waitlist.params[1]), fixtures.WAITLISTED_USER_ID);
  const invite = queries.find(({ sql }) => /INSERT INTO community_invites/.test(sql));
  assert.equal(invite.params[0], fixtures.INVITE_TOKEN);
  assert.match(invite.params[4], /^\[shots fixture\]/);
  const sketch = queries.find(({ sql }) => /INSERT INTO app_sketches/.test(sql));
  assert.match(sketch.sql, /status, design, ready_at\)\s+VALUES \(\$1, \$2, 'ready', \$3::jsonb/);
  assert.equal(Number(sketch.params[1]), 7, 'made by the shots member');
  assert.match(sketch.params[2], /\[shots fixture\]/);
  assert.equal(queries.filter(({ sql }) => /SELECT user_id FROM community_members/.test(sql)).length, 1);
  assert.ok(queries.every(({ sql }) => !/INSERT INTO (?!apps|users|app_collaborators|waitlist_signups|app_sketches|community_invites)/.test(sql)));
  // The project row's re-run is the update branch (the SELECT FOR UPDATE
  // before it); every other write carries its own ON CONFLICT.
  for (const insert of queries.filter(({ sql }) => /^INSERT INTO/.test(sql)
    && !/INSERT INTO apps/.test(sql))) {
    assert.match(insert.sql, /ON CONFLICT/, 'every write can be run again');
  }
  assert.deepEqual(installed.map((entry) => [entry.id, entry.persona, entry.path]), [
    [fixtures.INVITED_PROFILE, 'invited_member', `/#app/${fixtures.INVITE_PROJECT_SLUG}`],
    [fixtures.WAITLISTED_PROFILE, 'waitlisted_member', '/#home'],
    [fixtures.INVITE_LINK_PROFILE, 'guest', `/invite/${fixtures.INVITE_TOKEN}`],
  ]);
});

test('the invited-member fixture refuses a clone whose community memberships the trigger did not write', async () => {
  const client = {
    async query(sql) {
      if (/SELECT id FROM users WHERE username = 'usernode-capture'/.test(sql)) {
        return { rowCount: 1, rows: [{ id: 7 }] };
      }
      if (/FOR UPDATE/.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT id, community_id FROM apps/.test(sql)) {
        return { rowCount: 1, rows: [{ id: fixtures.INVITE_PROJECT_ID, community_id: 77 }] };
      }
      if (/SELECT user_id FROM community_members/.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
  await assert.rejects(fixtures.installInvitedFixtures(client, 'a'.repeat(32)),
    /community memberships from the collaborator trigger/);
});
