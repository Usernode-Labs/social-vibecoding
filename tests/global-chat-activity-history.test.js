'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  historyLimit,
  queryUserHistory,
} = require('../src/services/global-chat/activity-history');
const { CapabilityRegistry } = require('../src/services/global-chat/capability-registry');
const { classicCapabilityDefinitions } = require('../src/services/global-chat/classic-capabilities');

function poolWithHistory() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/WITH linked AS/.test(sql)) {
        return { rows: [{
          session_id: 91,
          issue_number: 2377,
          pr_number: 2591,
          pr_title: 'Improve Global Chat',
          closed_at: '2026-09-19T10:00:00.000Z',
          app_slug: 'usernode-2d5619',
          app_name: 'Homeroom',
          issue_id: 44,
          issue_title: 'Make chats global',
          description: 'Conversational interface',
          status: 'closed',
        }] };
      }
      return { rows: [{
        id: 91,
        pr_number: 2591,
        pr_title: 'Improve Global Chat',
        session_title: 'Global Chat work',
        status: 'merged',
        merged_at: '2026-09-19T10:00:00.000Z',
        created_at: '2026-09-18T10:00:00.000Z',
        linked_issues: [2377],
        app_slug: 'usernode-2d5619',
        app_name: 'Homeroom',
      }] };
    },
  };
}

test('semantic history reads return exact cross-app issue and merge identities', async () => {
  const pool = poolWithHistory();
  const closed = await queryUserHistory(pool, 7, 'closed_issues', { limit: 6 });
  const merged = await queryUserHistory(pool, 7, 'merged_work', { limit: 8 });

  assert.deepEqual(
    pool.calls.map((entry) => entry.params),
    [[7, 6, false, false], [7, 8, false, false]],
  );
  assert.ok(pool.calls.every((entry) => /apps\.view_visibility = 'public'/.test(entry.sql)));
  assert.ok(pool.calls.every((entry) => /membership\.status = 'member'/.test(entry.sql)));
  assert.ok(pool.calls.every((entry) => /NOT apps\.self_hosted/.test(entry.sql)));
  assert.deepEqual(closed.items[0], {
    id: 44,
    number: 2377,
    title: 'Make chats global',
    description: 'Conversational interface',
    status: 'closed',
    appSlug: 'usernode-2d5619',
    appName: 'Homeroom',
    closedAt: '2026-09-19T10:00:00.000Z',
    closedBySessionId: 91,
    mergedPrNumber: 2591,
    mergedPrTitle: 'Improve Global Chat',
  });
  assert.equal(merged.items[0].sessionId, 91);
  assert.equal(merged.items[0].appSlug, 'usernode-2d5619');
  assert.deepEqual(merged.items[0].linkedIssues, [2377]);
});

test('history reads enforce a small bounded count and stay behind signed-in access', async () => {
  assert.equal(historyLimit(), 10);
  assert.throws(() => historyLimit(0), /1 to 50/);
  assert.throws(() => historyLimit(51), /1 to 50/);

  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const signedOut = { actor: { signedIn: false } };
  const signedIn = {
    actor: { signedIn: true },
    queryUserHistory: async () => ({ items: [] }),
  };
  assert.equal(registry.get('issues.closed_by_me').access(signedOut), false);
  assert.equal(registry.get('issues.closed_by_me').access(signedIn), true);
  assert.equal(registry.get('governance.merged_by_me').access(signedIn), true);
  assert.equal(registry.get('governance.completed').access(signedIn), true);
  const result = await registry.execute('issues.closed_by_me', { limit: 10 }, signedIn);
  assert.equal(result.renderer, 'issue');
  assert.deepEqual(result.authoritativeResult.data.items, []);

  const completed = await registry.execute('governance.completed', { limit: 10 }, signedIn);
  assert.equal(completed.renderer, 'proposal');
  assert.deepEqual(completed.authoritativeResult.data.items, []);
});
