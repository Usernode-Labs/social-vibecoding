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
