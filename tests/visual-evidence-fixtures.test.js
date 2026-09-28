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
  await assert.rejects(fixtures.ensureHostedAppFixture(input), /isolated evidence database/);
  await assert.rejects(fixtures.canCopyMemberAgentSession(input), /isolated evidence database/);
  await assert.rejects(fixtures.copyMemberAgentSession(input), /isolated evidence database/);
});

test('the hosted-app fixture is a public running row bound to the exact evidence run', async () => {
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
  assert.deepEqual(JSON.parse(insert.params[2]).usernode_evidence_fixture, {
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
