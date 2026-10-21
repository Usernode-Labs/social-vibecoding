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
  await assert.rejects(fixtures.canInstallInvitedFixtures(input), /isolated shots database/);
  await assert.rejects(fixtures.ensureInvitedFixtures(input), /isolated shots database/);
});

test('the invite link\'s token is a 22-character community-invite token, the same on both sides of a run', () => {
  const { TOKEN_RE } = require('../src/services/community-invites');
  for (const runId of ['1'.repeat(32), 'a'.repeat(32), 'shots-run-42']) {
    const token = fixtures.invitedInviteToken(runId);
    assert.match(token, TOKEN_RE, runId);
    assert.equal(token, fixtures.invitedInviteToken(runId), 'derived from the run, never random');
  }
  assert.notEqual(fixtures.invitedInviteToken('1'.repeat(32)), fixtures.invitedInviteToken('2'.repeat(32)));
});

test('the invited fixtures are one private project, two invited members, a live link and a listed waitlist row', async () => {
  const runId = 'b'.repeat(32);
  const token = fixtures.invitedInviteToken(runId);
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id FROM users WHERE id = \$1 AND username = \$2/.test(sql)) {
        return { rowCount: 1, rows: [{ id: fixtures.INVITE_MAKER_USER_ID }] };
      }
      if (/SELECT id FROM apps WHERE slug/.test(sql)) return { rowCount: 1, rows: [{ id: 42 }] };
      if (/SELECT id, slug FROM apps/.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT community_id FROM apps/.test(sql)) return { rowCount: 1, rows: [{ community_id: 77 }] };
      return { rowCount: 1, rows: [] };
    },
  };
  const installed = await fixtures.installInvitedFixtures(client, {
    selfAppSlug: 'usernode-2d5619', runId,
  });
  assert.deepEqual(installed.map((entry) => entry.id), [
    fixtures.INVITED_FIRST_VISIT_PROFILE, fixtures.INVITED_LISTED_PROFILE, fixtures.INVITE_LINK_PROFILE,
  ]);
  // One made-up private project, created without community_id: the boot
  // trigger makes its community, as for every app.
  const app = queries.find(({ sql }) => /INSERT INTO apps/.test(sql));
  assert.equal(app.params[0], fixtures.INVITED_APP_ID);
  assert.equal(app.params[1], '[shots fixture] Picnic planner');
  assert.equal(app.params[2], fixtures.INVITED_APP_SLUG);
  assert.doesNotMatch(app.sql, /community_id/);
  assert.match(app.sql, /'private', 'private'/);
  assert.equal(app.params[4], '🧺');
  // Both members: no platform access, unusable password, joined an hour ago.
  const userInserts = queries.filter(({ sql }) => /INSERT INTO users/.test(sql));
  assert.deepEqual(userInserts.flatMap(({ params }) => [params[0], params[1]]), [
    fixtures.INVITED_MEMBER_USER_ID, fixtures.INVITED_MEMBER_USERNAME,
    fixtures.INVITED_MEMBER_LISTED_USER_ID, fixtures.INVITED_MEMBER_LISTED_USERNAME,
  ]);
  for (const { sql } of userInserts) {
    assert.match(sql, /FALSE, FALSE, FALSE,/, 'not an admin, cannot create apps, no platform access');
    assert.match(sql, /'__shots_not_a_login__'/);
  }
  // The members join as collaborators invited by the maker, community
  // members and pinned on Home; the maker keeps the standing to grant.
  const collaborator = queries.find(({ sql }) => /INSERT INTO app_collaborators/.test(sql));
  assert.deepEqual(collaborator.params, [fixtures.INVITED_APP_ID, fixtures.INVITED_MEMBER_USER_ID,
    fixtures.INVITE_MAKER_USER_ID]);
  assert.match(queries.find(({ sql }) => /INSERT INTO community_members/.test(sql)).sql, /'joined'/);
  assert.ok(queries.some(({ sql, params }) => /INSERT INTO app_favorites/.test(sql)
    && params[0] === fixtures.INVITED_APP_ID));
  assert.ok(queries.some(({ sql, params }) => /INSERT INTO app_collaborators/.test(sql)
    && params[0] === fixtures.INVITED_APP_ID && params[1] === fixtures.INVITE_MAKER_USER_ID),
  'the maker keeps the standing the link grants from');
  // The sketch the FeaturedCard is drawn from: kind card, ready.
  const sketch = queries.find(({ sql }) => /INSERT INTO app_sketches/.test(sql));
  assert.match(sketch.sql, /'ready'/);
  const design = JSON.parse(sketch.params[2]);
  assert.equal(design.kind, 'card');
  assert.equal(design.emoji, '🧺');
  assert.ok(design.tagline.length > 0 && Array.isArray(design.points) && design.points.length > 0);
  // The link: no end date, no use limit, the maker's note, and the waitlist
  // row for the listed member only.
  const invite = queries.find(({ sql }) => /INSERT INTO community_invites/.test(sql));
  assert.deepEqual(invite.params, [token, 77, fixtures.INVITED_APP_ID, fixtures.INVITE_MAKER_USER_ID,
    '[shots fixture] Come help us plan the summer picnic!']);
  assert.match(invite.sql, /NULL, 0, NULL, NULL,/, 'no end date, no use limit');
  const waitlist = queries.find(({ sql }) => /INSERT INTO waitlist_signups/.test(sql));
  assert.match(waitlist.sql, /'shots-invited-listed@shots-fixture\.invalid'/);
  assert.equal(waitlist.params[0], fixtures.INVITED_MEMBER_LISTED_USER_ID);
  assert.equal(waitlist.params[1], fixtures.invitedWaitlistToken(runId));
  assert.match(waitlist.sql, /released_at/, 'listed, not released');
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

test('one moment for both sides: every NOW() a fixture writes is the pair\'s moment, bound as a parameter', async () => {
  const at = '2026-10-09T10:00:00.000Z';
  assert.equal(fixtures.pairMoment(new Date(at)), at);
  assert.equal(fixtures.pairMoment(at), at);
  assert.throws(() => fixtures.pairMoment('not a time'), /valid moment/);
  assert.throws(() => fixtures.pairMoment(new Date(NaN)), /valid moment/);
  // The same writes on two sides, at different instants, reach both
  // databases as the same statements with the same values.
  const sides = {};
  for (const side of ['base', 'head']) {
    const queries = [];
    sides[side] = queries;
    const client = fixtures.atMoment({
      async query(sql, params) {
        queries.push({ sql, params });
        if (/INSERT INTO agent_sessions/.test(sql)) return { rowCount: 1, rows: [{ id: params[0], title: 'Fixture session' }] };
        return { rowCount: 1, rows: [{ id: params?.[0] }] };
      },
    }, at);
    await client.query('BEGIN');
    await fixtures.copyAgentSession(client, {
      userId: 2, appId: 7, sessionId: fixtures.MEMBER_SESSION_ID, changeId: fixtures.MEMBER_CHANGE_ID,
      branch: 'shots-fixture/member-agent-session', persona: 'member',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(sides.base, sides.head);
  const writes = sides.base.filter(({ sql }) => /INSERT/.test(sql));
  assert.equal(writes.length, 3);
  for (const { sql, params } of writes) {
    assert.doesNotMatch(sql, /\bnow\(\)/i, 'no statement reads either side\'s own clock');
    assert.equal(params.at(-1), at);
    assert.match(sql, new RegExp(`\\$${params.length}::timestamptz - INTERVAL`));
  }
  // A statement without NOW() is passed through as it was.
  assert.deepEqual(sides.base[0], { sql: 'BEGIN', params: undefined });
  const update = sides.base.find(({ sql }) => /UPDATE agent_sessions/.test(sql));
  assert.deepEqual(update.params, [fixtures.MEMBER_SESSION_ID, fixtures.MEMBER_CHANGE_ID]);
});
