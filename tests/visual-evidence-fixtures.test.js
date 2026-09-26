'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('../src/services/visual-evidence-fixtures');

test('evidence identities and rows cannot be created, inspected, or copied outside the run database', async () => {
  const input = {
    databaseUrl: 'postgres://usernode:localdev@127.0.0.1:5440/usernode',
    slug: 'usernode-2d5619', runId: '1'.repeat(32), side: 'base',
    selfAppSlug: 'usernode-2d5619',
  };
  await assert.rejects(fixtures.ensureFullAdminIdentity(input), /isolated evidence database/);
  await assert.rejects(fixtures.canCopyMemberAgentSession(input), /isolated evidence database/);
  await assert.rejects(fixtures.copyMemberAgentSession(input), /isolated evidence database/);
});

test('the isolated full-admin fixture includes self-app membership for channel evidence', async () => {
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
