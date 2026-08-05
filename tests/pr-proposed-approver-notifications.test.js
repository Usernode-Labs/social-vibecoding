'use strict';

// Invited-approver vote requests must reach the exact electorate whose votes
// can merge the proposal, including on the self-app where active-user fanout
// is deliberately disabled. These tests exercise the notification service's
// recipient construction and its existing atomic de-duplication SQL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notificationsPath = require.resolve('../src/services/notifications');
const activeUsersPath = require.resolve('../src/services/active-users');
const governancePath = require.resolve('../src/services/governance');

function loadService({ activeIds = [], approverIds = [], adminFallback = false } = {}) {
  const saved = new Map();
  for (const id of [notificationsPath, activeUsersPath, governancePath]) {
    saved.set(id, require.cache[id]);
    delete require.cache[id];
  }
  require.cache[activeUsersPath] = {
    id: activeUsersPath, filename: activeUsersPath, loaded: true,
    exports: { listActiveUserIds: async () => activeIds },
  };
  require.cache[governancePath] = {
    id: governancePath, filename: governancePath, loaded: true,
    exports: { getApproverSet: async () => ({ ids: approverIds, adminFallback }) },
  };
  const service = require(notificationsPath);
  return {
    service,
    restore() {
      for (const [id, entry] of saved) {
        if (entry) require.cache[id] = entry;
        else delete require.cache[id];
      }
    },
  };
}

function makePool({ selfHosted = false, policy = 'invited', extras = [], visibility = 'public' } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/SELECT self_hosted, approver_policy FROM apps/.test(text)) {
        return { rows: [{ self_hosted: selfHosted, approver_policy: policy }] };
      }
      if (/SELECT created_by AS id FROM apps/.test(text)) return { rows: extras.map((id) => ({ id })) };
      if (/SELECT collab_visibility FROM apps/.test(text)) {
        return { rows: [{ collab_visibility: visibility }] };
      }
      if (/SELECT user_id FROM app_collaborators/.test(text)) {
        return { rows: (params[1] || []).filter((id) => id !== 99).map((user_id) => ({ user_id })) };
      }
      if (/INSERT INTO notifications/.test(text)) {
        return { rows: (params[0] || []).map((user_id, i) => ({
          id: i + 1, user_id, app_id: params[1], session_id: params[2],
          source_user_id: params[3], kind: 'pr_proposed', created_at: new Date().toISOString(),
        })) };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

test('self-app invited electorate receives vote request while proposer stays excluded', async () => {
  const { service, restore } = loadService({ activeIds: [90], approverIds: [7, 8] });
  try {
    const pool = makePool({ selfHosted: true, extras: [6] });
    const rows = await service.createPrProposedNotifications(pool, {
      appId: 10, sessionId: 2991, proposerId: 7,
    });
    assert.deepEqual(rows.map((r) => r.user_id).sort((a, b) => a - b), [6, 8]);
    const insert = pool.calls.find((c) => /INSERT INTO notifications/.test(c.sql));
    assert.doesNotMatch(insert.sql, /active/i);
    assert.match(insert.sql, /ON CONFLICT \(user_id, session_id\) WHERE kind = 'pr_proposed' DO NOTHING/);
  } finally { restore(); }
});

test('non-invited apps preserve active and stakeholder recipients', async () => {
  const { service, restore } = loadService({ activeIds: [2, 3], approverIds: [8] });
  try {
    const pool = makePool({ policy: 'anyone', extras: [4] });
    const rows = await service.createPrProposedNotifications(pool, {
      appId: 11, sessionId: 22, proposerId: 2,
    });
    assert.deepEqual(rows.map((r) => r.user_id).sort((a, b) => a - b), [3, 4]);
  } finally { restore(); }
});

test('private collaboration filtering still applies after electorate union', async () => {
  const { service, restore } = loadService({ activeIds: [], approverIds: [8, 99] });
  try {
    const pool = makePool({ selfHosted: true, visibility: 'private' });
    const rows = await service.createPrProposedNotifications(pool, {
      appId: 12, sessionId: 23, proposerId: 1,
    });
    assert.deepEqual(rows.map((r) => r.user_id), [8]);
  } finally { restore(); }
});

test('private app retains eligible full-admin fallback recipients', async () => {
  const { service, restore } = loadService({ approverIds: [7, 99], adminFallback: true });
  try {
    const pool = makePool({ selfHosted: true, visibility: 'private' });
    const rows = await service.createPrProposedNotifications(pool, {
      appId: 13, sessionId: 24, proposerId: 7,
    });
    assert.deepEqual(rows.map((r) => r.user_id), [99]);
  } finally { restore(); }
});

test('schema enforces one vote request per recipient and proposal', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const cleanup = schema.indexOf('DELETE FROM notifications newer');
  const index = schema.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_pr_proposed_once');
  assert.ok(cleanup >= 0 && index > cleanup, 'historical duplicates are cleaned before the index');
  assert.match(
    schema.slice(index, index + 240),
    /ON notifications \(user_id, session_id\)[\s\S]*WHERE kind = 'pr_proposed'/
  );
});
