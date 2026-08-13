'use strict';

// Direct coverage for the notification creators that had none of their own:
// the four invite kinds, stale_pr, check_failed, the pr_proposed fan-out
// targeting rules, and the filterToCollaborators visibility scope. Every
// kind asserted here is also checked against the closed push policy
// (ALLOWED_KINDS) so a dispatch site cannot drift out of the reviewed
// kind/category registry without this file noticing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ALLOWED_KINDS } = require('../src/services/mobile-push-preferences');

// createPrProposedNotifications destructures listActiveUserIds at module
// load, so the stub must be in the require cache before notifications.js is.
const activeUsersPath = require.resolve('../src/services/active-users');
const activeUsers = { ids: [], calls: [] };
require.cache[activeUsersPath] = {
  id: activeUsersPath,
  filename: activeUsersPath,
  loaded: true,
  exports: {
    listActiveUserIds: async (pool, appId) => {
      activeUsers.calls.push(appId);
      return activeUsers.ids;
    },
  },
};
const notifications = require('../src/services/notifications');

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

// Minimal recording pool for the creator queries. Unexpected SQL throws so a
// creator picking up a new query shape fails loudly here.
function fakePool(state = {}) {
  state.queries = [];
  state.inserts = [];
  return {
    state,
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      state.queries.push({ sql, params });
      if (/^SELECT self_hosted FROM apps/i.test(sql)) {
        return { rows: [{ self_hosted: !!state.selfHosted }] };
      }
      if (/^SELECT created_by AS id FROM apps/i.test(sql)) {
        return { rows: (state.stakeholders || []).map((id) => ({ id })) };
      }
      if (/^SELECT collab_visibility FROM apps/i.test(sql)) {
        return { rows: [{ collab_visibility: state.visibility || 'public' }] };
      }
      if (/^SELECT user_id FROM app_collaborators/i.test(sql)) {
        const members = state.members || [];
        return {
          rows: params[1].filter((id) => members.includes(id)).map((user_id) => ({ user_id })),
        };
      }
      if (/^INSERT INTO notifications/i.test(sql)) {
        state.inserts.push({ sql, params });
        const recipients = Array.isArray(params[0]) ? params[0] : [params[0]];
        return { rows: recipients.map((userId, i) => ({ id: i + 1, user_id: userId })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

// ── filterToCollaborators ───────────────────────────────────────────────

test('filterToCollaborators passes a public-collab app through untouched', async () => {
  const pool = fakePool({ visibility: 'public' });
  assert.deepEqual(await notifications.filterToCollaborators(pool, 10, [1, 2, 3]), [1, 2, 3]);
  // Membership was never consulted — only the visibility read ran.
  assert.equal(pool.state.queries.length, 1);
});

test('filterToCollaborators restricts a collab-private app to members, order preserved', async () => {
  const pool = fakePool({ visibility: 'private', members: [3, 1] });
  assert.deepEqual(await notifications.filterToCollaborators(pool, 10, [1, 2, 3]), [1, 3]);
  const membership = pool.state.queries[1];
  assert.deepEqual(membership.params, [10, [1, 2, 3]]);
});

test('filterToCollaborators short-circuits without an app or candidates', async () => {
  const pool = fakePool({});
  assert.deepEqual(await notifications.filterToCollaborators(pool, null, [1]), [1]);
  assert.deepEqual(await notifications.filterToCollaborators(pool, 10, []), []);
  assert.equal(pool.state.queries.length, 0);
});

// ── Invite creators ─────────────────────────────────────────────────────

const INVITE_CREATORS = [
  ['collab_invite', notifications.createCollabInviteNotification,
    { appId: 10, recipientId: 7, inviterId: 3 }, [7, 10, 3]],
  ['collab_invite_accepted', notifications.createCollabInviteAcceptedNotification,
    { appId: 10, recipientId: 3, accepterId: 7 }, [3, 10, 7]],
  ['approver_invite', notifications.createApproverInviteNotification,
    { appId: 10, recipientId: 7, inviterId: 3 }, [7, 10, 3]],
  ['approver_invite_accepted', notifications.createApproverInviteAcceptedNotification,
    { appId: 10, recipientId: 3, accepterId: 7 }, [3, 10, 7]],
];

test('each invite creator inserts its reviewed push-eligible kind for the right recipient', async () => {
  for (const [kind, creator, input, params] of INVITE_CREATORS) {
    assert.ok(ALLOWED_KINDS.has(kind), `${kind} is in the closed push policy`);
    const pool = fakePool({});
    const rows = await creator(pool, input);
    assert.equal(pool.state.inserts.length, 1, kind);
    const insert = pool.state.inserts[0];
    assert.match(insert.sql, new RegExp(`VALUES \\(\\$1, \\$2, \\$3, '${kind}'\\)`));
    assert.deepEqual(insert.params, params, kind);
    assert.equal(rows.length, 1, `${kind} returns the row for hydrateAndPush`);
  }
});

test('invite creators are no-ops without a recipient or app', async () => {
  for (const [kind, creator] of INVITE_CREATORS) {
    for (const input of [{ appId: 10 }, { recipientId: 7 }, {}]) {
      const pool = fakePool({});
      assert.deepEqual(await creator(pool, input), [], kind);
      assert.equal(pool.state.queries.length, 0, kind);
    }
  }
});

test('a missing inviter degrades to a system notification, not a failure', async () => {
  const pool = fakePool({});
  await notifications.createCollabInviteNotification(pool, { appId: 10, recipientId: 7 });
  assert.deepEqual(pool.state.inserts[0].params, [7, 10, null]);
});

// ── stale_pr / check_failed ─────────────────────────────────────────────

test('stale_pr is a system notification addressed to the proposal author', async () => {
  assert.ok(ALLOWED_KINDS.has('stale_pr'));
  const pool = fakePool({});
  const rows = await notifications.createStalePrNotification(pool, {
    userId: 7, appId: 10, sessionId: 55,
  });
  const insert = pool.state.inserts[0];
  assert.match(insert.sql, /VALUES \(\$1, \$2, \$3, NULL, 'stale_pr'\)/);
  assert.deepEqual(insert.params, [7, 10, 55]);
  assert.equal(rows.length, 1);

  const empty = fakePool({});
  assert.deepEqual(await notifications.createStalePrNotification(empty, { appId: 10 }), []);
  assert.equal(empty.state.queries.length, 0);
});

test('check_failed dedups atomically on an unread row for the same user and session', async () => {
  assert.ok(ALLOWED_KINDS.has('check_failed'));
  const pool = fakePool({});
  await notifications.createCheckFailedNotification(pool, { userId: 7, appId: 10, sessionId: 55 });
  const insert = pool.state.inserts[0];
  assert.match(insert.sql, /SELECT \$1, \$2, \$3, NULL, 'check_failed' WHERE NOT EXISTS/);
  assert.match(insert.sql,
    /n\.user_id = \$1 AND n\.session_id = \$3 AND n\.kind = 'check_failed' AND n\.read_at IS NULL/);
  assert.deepEqual(insert.params, [7, 10, 55]);

  for (const input of [{ userId: 7, appId: 10 }, { appId: 10, sessionId: 55 }]) {
    const empty = fakePool({});
    assert.deepEqual(await notifications.createCheckFailedNotification(empty, input), []);
    assert.equal(empty.state.queries.length, 0);
  }
});

// ── pr_proposed fan-out targeting ───────────────────────────────────────

test('pr_proposed targets active users plus creator and favoriters, never the proposer', async () => {
  assert.ok(ALLOWED_KINDS.has('pr_proposed'));
  activeUsers.ids = [2, 3];
  activeUsers.calls = [];
  const pool = fakePool({ selfHosted: false, stakeholders: [4, 5, 3] });
  const rows = await notifications.createPrProposedNotifications(pool, {
    appId: 10, sessionId: 55, proposerId: 2,
  });
  assert.deepEqual(activeUsers.calls, [10]);
  const insert = pool.state.inserts[0];
  // Proposer 2 dropped, stakeholder 3 deduped against the active list.
  assert.deepEqual(insert.params, [[3, 4, 5], 10, 55, 2]);
  assert.match(insert.sql, /FROM UNNEST\(\$1::int\[\]\) AS u/);
  assert.match(insert.sql,
    /WHERE NOT EXISTS \( SELECT 1 FROM notifications n WHERE n\.user_id = u AND n\.session_id = \$3 AND n\.kind = 'pr_proposed' \)/,
    're-promotes cannot re-spam recipients already pinged for this session');
  assert.equal(rows.length, 3);
});

test('the platform self-app never fans out to the global active-user base', async () => {
  activeUsers.ids = [991, 992, 993];
  activeUsers.calls = [];
  const pool = fakePool({ selfHosted: true, stakeholders: [4, 5] });
  await notifications.createPrProposedNotifications(pool, {
    appId: 1, sessionId: 55, proposerId: 4,
  });
  assert.deepEqual(activeUsers.calls, [], 'active users are not even consulted');
  assert.deepEqual(pool.state.inserts[0].params[0], [5],
    'only opt-in stakeholders minus the proposer remain');
});

test('pr_proposed on a collab-private app only nudges members who can vote', async () => {
  activeUsers.ids = [2, 3];
  activeUsers.calls = [];
  const pool = fakePool({
    selfHosted: false, stakeholders: [4], visibility: 'private', members: [3],
  });
  await notifications.createPrProposedNotifications(pool, {
    appId: 10, sessionId: 55, proposerId: 2,
  });
  assert.deepEqual(pool.state.inserts[0].params[0], [3],
    'the favoriter who cannot vote is not asked to');
});

test('pr_proposed with nobody left to notify inserts nothing', async () => {
  activeUsers.ids = [];
  const pool = fakePool({ selfHosted: true, stakeholders: [4] });
  const rows = await notifications.createPrProposedNotifications(pool, {
    appId: 1, sessionId: 55, proposerId: 4,
  });
  assert.deepEqual(rows, []);
  assert.equal(pool.state.inserts.length, 0);

  const invalid = fakePool({});
  assert.deepEqual(
    await notifications.createPrProposedNotifications(invalid, { sessionId: 55 }), []);
  assert.equal(invalid.state.queries.length, 0);
});
