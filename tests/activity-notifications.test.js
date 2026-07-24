const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

const notifications = require('../src/services/notifications');
const { createActivityService, mapActivityItem } = require('../src/services/activity');

const TEST_ASSERTION_KEY = Buffer.alloc(32, 7).toString('base64url');

test('Activity outbox is truncated from staging database clones', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.match(
    schema,
    /COMMENT ON TABLE activity_notification_outbox IS 'staging:private';/
  );
});

function activityConfig(overrides = {}) {
  return {
    activityBaseUrl: 'http://activity',
    activityProducerToken: 'producer',
    activityLedgerId: 'activity-development',
    activitySocialAssertionKey: TEST_ASSERTION_KEY,
    activityNotificationsReadPath: 'activity',
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function hydratedNotification(overrides = {}) {
  return {
    id: 1201,
    user_id: 42,
    kind: 'mention',
    created_at: '2026-07-22T15:04:05Z',
    app_id: 7,
    app_slug: 'example-app',
    app_name: 'Example App',
    chat_message_id: 9001,
    message_content: 'Hello @bruno',
    thread_type: null,
    thread_ref: null,
    session_id: null,
    pr_title: null,
    pr_number: null,
    headless_issue_number: null,
    branch_name: null,
    source_user_id: 88,
    source_username: 'alice',
    detail: null,
    ...overrides,
  };
}

test('one generic occurrence freezes renderer facts and opaque read scopes', () => {
  const event = notifications.buildActivityEvent(hydratedNotification());
  assert.equal(event.sourceEventId, 'social.notification:1201');
  assert.equal(event.aggregateKey, 'social.notification:1201');
  assert.deepEqual(event.resource, { type: 'notification', id: '1201', version: 1 });
  assert.deepEqual(event.recipient, {
    relation: 'social.user', subject: '42', scope: 'account',
  });
  assert.equal(event.kind, 'social.notification.occurred');
  assert.equal(event.facts.kind, 'mention');
  assert.equal(event.facts.sourceUserId, '88');
  assert.deepEqual(event.facts.readScopes, [
    'social.app:7',
    'social.chat-engagement:7',
    'social.chat-message:9001',
    'social.notification-surface:2',
  ]);
});

test('all existing Social notification kinds use the same occurrence builder', () => {
  const kinds = [
    'mention', 'reply', 'reaction', 'kudos', 'stale_pr', 'check_failed',
    'pr_proposed', 'session_done', 'auto_solve_done', 'spec_shared',
    'collab_invite', 'collab_invite_accepted', 'approver_invite',
    'approver_invite_accepted',
  ];
  for (const [index, kind] of kinds.entries()) {
    const event = notifications.buildActivityEvent(hydratedNotification({
      id: 1201 + index,
      kind,
      chat_message_id: ['mention', 'reply', 'reaction'].includes(kind) ? 9001 : null,
      session_id: ['stale_pr', 'check_failed', 'pr_proposed', 'session_done',
        'auto_solve_done', 'spec_shared', 'kudos'].includes(kind) ? 33 : null,
    }));
    assert.equal(event.kind, 'social.notification.occurred');
    assert.equal(event.facts.kind, kind);
    const surfaceScopes = event.facts.readScopes.filter((scope) =>
      scope.startsWith('social.notification-surface:')
    );
    assert.equal(surfaceScopes.length, 1, `${kind} has exactly one presentation scope`);
  }
});

test('read scopes cover the existing consumer gestures without family APIs', () => {
  const cases = [
    ['mention', ['social.app:7', 'social.chat-engagement:7', 'social.chat-message:9001', 'social.notification-surface:2']],
    ['pr_proposed', ['social.app:7', 'social.notification-surface:2', 'social.vote-request:33']],
    ['stale_pr', ['social.app:7', 'social.notification-surface:1', 'social.vote-request:33']],
    ['session_done', ['social.app:7', 'social.notification-surface:1', 'social.session-completion:33']],
    ['auto_solve_done', ['social.app:7', 'social.auto-solve-completion:33', 'social.notification-surface:1']],
    ['collab_invite', ['social.app:7', 'social.collab-invite:7', 'social.notification-surface:2']],
    ['approver_invite', ['social.app:7', 'social.approver-invite:7', 'social.notification-surface:2']],
    ['kudos', ['social.app:7', 'social.notification-surface:2']],
  ];
  for (const [kind, expected] of cases) {
    const event = notifications.buildActivityEvent(hydratedNotification({
      kind,
      session_id: 33,
    }));
    assert.deepEqual(event.facts.readScopes, expected, kind);
  }
});

test('Activity mode commits only the frozen outbox occurrence', async (t) => {
  notifications.configureActivity({}, 'activity');
  t.after(() => notifications.configureActivity(null, 'legacy'));
  const calls = [];
  let released = false;
  const inserted = {
    id: 1201, user_id: 42, app_id: 7, chat_message_id: 9001,
    source_user_id: 88, kind: 'mention', created_at: '2026-07-22T15:04:05Z',
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (String(sql) === 'BEGIN' || String(sql) === 'COMMIT') return { rows: [] };
      if (/^INSERT INTO notifications/.test(String(sql))) return { rows: [inserted] };
      if (/SELECT n\.id, n\.user_id, n\.kind/.test(String(sql))) {
        return { rows: [hydratedNotification()] };
      }
      if (/INSERT INTO activity_notification_outbox/.test(String(sql))) {
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM notifications/.test(String(sql))) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { released = true; },
  };
  const pool = { connect: async () => client };

  const rows = await notifications.insertNotificationRows(
    pool,
    'INSERT INTO notifications VALUES ($1) RETURNING *',
    [42]
  );
  assert.deepEqual(rows, [inserted]);
  assert.deepEqual(calls.map((c) => c.sql === 'BEGIN' || c.sql === 'COMMIT'
    ? c.sql
    : c.sql.match(/^(INSERT|SELECT|DELETE)/)?.[1]),
  ['BEGIN', 'INSERT', 'SELECT', 'INSERT', 'DELETE', 'COMMIT']);
  const frozen = JSON.parse(
    calls.find((c) => /INSERT INTO activity_notification_outbox/.test(c.sql)).params[0]
  );
  assert.equal(frozen[0].notification_id, 1201);
  assert.equal(frozen[0].recipient_user_id, 42);
  assert.equal(frozen[0].event.sourceEventId, 'social.notification:1201');
  assert.deepEqual(
    calls.find((c) => /DELETE FROM notifications/.test(c.sql)).params[0],
    [1201]
  );
  assert.equal(released, true);
});

test('Activity outbox failure rolls back the staged Social row', async (t) => {
  notifications.configureActivity({}, 'activity');
  t.after(() => notifications.configureActivity(null, 'legacy'));
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (/^INSERT INTO notifications/.test(text)) {
        return {
          rows: [{
            id: 1201, user_id: 42, app_id: 7, chat_message_id: 9001,
            source_user_id: 88, kind: 'mention', created_at: '2026-07-22T15:04:05Z',
          }],
        };
      }
      if (/SELECT n\.id, n\.user_id, n\.kind/.test(text)) {
        return { rows: [hydratedNotification()] };
      }
      if (/INSERT INTO activity_notification_outbox/.test(text)) {
        throw new Error('outbox unavailable');
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { released = true; },
  };

  await assert.rejects(
    notifications.insertNotificationRows(
      { connect: async () => client },
      'INSERT INTO notifications VALUES ($1) RETURNING *',
      [42]
    ),
    /outbox unavailable/
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.includes('COMMIT'), false);
  assert.equal(released, true);
});

test('legacy notification insert does not enqueue an Activity occurrence', async () => {
  notifications.configureActivity(null, 'legacy');
  const calls = [];
  let released = false;
  const inserted = {
    id: 1201, user_id: 42, app_id: 7, chat_message_id: 9001,
    source_user_id: 88, kind: 'mention', created_at: '2026-07-22T15:04:05Z',
  };
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (String(sql) === 'BEGIN' || String(sql) === 'COMMIT') return { rows: [] };
      if (/^INSERT INTO notifications/.test(String(sql))) return { rows: [inserted] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { released = true; },
  };

  const rows = await notifications.insertNotificationRows(
    { connect: async () => client },
    'INSERT INTO notifications VALUES ($1) RETURNING *',
    [42]
  );

  assert.deepEqual(rows, [inserted]);
  assert.deepEqual(calls, [
    'BEGIN',
    'INSERT INTO notifications VALUES ($1) RETURNING *',
    'COMMIT',
  ]);
  assert.equal(released, true);
});

test('pr_proposed keeps durable de-dupe only in legacy mode', async (t) => {
  t.after(() => notifications.configureActivity(null, 'legacy'));
  const insertCalls = [];
  const inserted = {
    id: 1201, user_id: 42, app_id: 7, session_id: 33,
    source_user_id: 88, kind: 'pr_proposed', created_at: '2026-07-22T15:04:05Z',
  };
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT') return { rows: [] };
      if (/^INSERT INTO notifications/.test(text)) {
        insertCalls.push({ sql: text, params });
        return { rows: [inserted] };
      }
      if (/SELECT n\.id, n\.user_id, n\.kind/.test(text)) {
        return {
          rows: [hydratedNotification({
            kind: 'pr_proposed', chat_message_id: null, session_id: 33,
          })],
        };
      }
      if (/INSERT INTO activity_notification_outbox/.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM notifications/.test(text)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected client SQL: ${sql}`);
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    async query(sql) {
      const text = String(sql);
      if (/SELECT self_hosted FROM apps/.test(text)) {
        return { rows: [{ self_hosted: true }] };
      }
      if (/SELECT created_by AS id FROM apps/.test(text)) return { rows: [{ id: 42 }] };
      if (/SELECT collab_visibility FROM apps/.test(text)) {
        return { rows: [{ collab_visibility: 'public' }] };
      }
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
  };

  notifications.configureActivity({}, 'activity');
  await notifications.createPrProposedNotifications(pool, {
    appId: 7, sessionId: 33, proposerId: 88,
  });
  notifications.configureActivity(null, 'legacy');
  await notifications.createPrProposedNotifications(pool, {
    appId: 7, sessionId: 33, proposerId: 88,
  });

  assert.equal(insertCalls.length, 2);
  assert.match(insertCalls[0].sql, /WHERE \$5::boolean OR NOT EXISTS/);
  assert.equal(insertCalls[0].params[4], true,
    'Activity treats a re-promotion as a new occurrence');
  assert.equal(insertCalls[1].params[4], false,
    'legacy mode retains the existing durable notification de-dupe');
});

function publisherPool(row) {
  const updates = [];
  let served = false;
  return {
    updates,
    reset() { served = false; },
    async query(sql, params = []) {
      const text = String(sql);
      if (/SELECT notification_id, recipient_user_id, event, attempt_count/.test(text)) {
        if (served) return { rows: [] };
        served = true;
        return { rows: [row] };
      }
      updates.push({ sql: text, params });
      if (/RETURNING recipient_user_id/.test(text)) {
        return { rows: [{ recipient_user_id: row.recipient_user_id }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

test('publisher treats accepted and exact replay as delivered', async () => {
  for (const status of [200, 201]) {
    const row = {
      notification_id: 1201,
      recipient_user_id: 42,
      event: notifications.buildActivityEvent(hydratedNotification()),
      attempt_count: 0,
    };
    const pool = publisherPool(row);
    let sentBody;
    const service = createActivityService(activityConfig(), {
      pool,
      fetchImpl: async (_url, options) => {
        sentBody = JSON.parse(options.body);
        return jsonResponse(status, { result: status === 200 ? 'replayed' : 'accepted' });
      },
    });
    await service.drainPublisher();
    assert.deepEqual(sentBody, row.event);
    assert.match(pool.updates[0].sql, /DELETE FROM activity_notification_outbox/);
  }
});

test('publisher retries transient/unbound failures and parks permanent contract failures', async () => {
  const row = {
    notification_id: 1201,
    recipient_user_id: 42,
    event: notifications.buildActivityEvent(hydratedNotification()),
    attempt_count: 2,
  };
  for (const [status, code, shouldRetry] of [
    [422, 'recipient_not_bound', true],
    [429, 'rate_limited', true],
    [503, 'internal_error', true],
    [400, 'invalid_social_notification_event', false],
    [409, 'source_event_identity_conflict', false],
  ]) {
    const pool = publisherPool(row);
    const service = createActivityService(activityConfig(), {
      pool,
      random: () => 0.5,
      fetchImpl: async () => jsonResponse(status, { error: code }),
    });
    await service.drainPublisher();
    assert.equal(pool.updates[0].params[1] != null, shouldRetry, `${status} retry classification`);
  }
});

test('a fresh publisher process resumes an outbox row left retryable', async () => {
  const row = {
    notification_id: 1201,
    recipient_user_id: 42,
    event: notifications.buildActivityEvent(hydratedNotification()),
    attempt_count: 0,
  };
  const pool = publisherPool(row);
  const config = activityConfig();
  await createActivityService(config, {
    pool,
    fetchImpl: async () => { throw new Error('offline'); },
  }).drainPublisher();
  assert.ok(pool.updates[0].params[1] > 0, 'first process leaves a due retry');

  pool.reset();
  await createActivityService(config, {
    pool,
    fetchImpl: async () => jsonResponse(201, { result: 'accepted' }),
  }).drainPublisher();
  assert.match(pool.updates.at(-1).sql, /DELETE FROM activity_notification_outbox/);
});

test('legacy authority cannot start or drain the Activity publisher', async () => {
  let queried = false;
  const service = createActivityService(activityConfig({
    activityNotificationsReadPath: 'legacy',
  }), {
    pool: {
      async query() {
        queried = true;
        return { rows: [] };
      },
    },
  });

  assert.equal(service.publisherEnabled(), false);
  assert.equal(service.startPublisher(), false);
  await service.drainPublisher();
  assert.equal(queried, false);
});

test('Activity authority fails fast without a producer token', () => {
  assert.throws(
    () => createActivityService(activityConfig({ activityProducerToken: '' })),
    /ACTIVITY_PRODUCER_TOKEN/
  );
});

test('consumer assertion exchange is cached and feed/read use string identities', async () => {
  const rawKey = Buffer.alloc(32, 7);
  const now = Date.parse('2026-07-22T15:00:00Z');
  const calls = [];
  const sourceEvent = notifications.buildActivityEvent(hydratedNotification());
  const item = {
    inboxSequence: '845',
    syncSequence: '846',
    defaultAttention: 'unread',
    readAt: null,
    activityEvent: { sourceEvent },
  };
  const service = createActivityService(activityConfig({
    activitySocialAssertionKey: rawKey.toString('base64url'),
  }), {
    now: () => now,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/v1/auth/exchanges')) {
        const assertion = JSON.parse(options.body).assertion;
        const header = jwt.decode(assertion, { complete: true }).header;
        const claims = jwt.verify(assertion, rawKey, {
          algorithms: ['HS256'], audience: 'activity-development',
          clockTimestamp: now / 1000,
        });
        assert.deepEqual(header, { alg: 'HS256', typ: 'activity-inbox-assertion+jwt' });
        assert.equal(claims.iss, 'social/social-dev');
        assert.equal(claims.sub, '42');
        return jsonResponse(200, {
          accessToken: `act1_${'a'.repeat(43)}`,
          tokenType: 'Bearer',
          expiresAt: '2026-07-22T16:00:00Z',
        });
      }
      assert.equal(options.headers.authorization, `Bearer act1_${'a'.repeat(43)}`);
      if (url.includes('/v1/me/activity?')) {
        return jsonResponse(200, {
          items: [item], nextCursor: 'opaque-cursor', hasMore: true,
          readThroughInboxSequence: '845',
        });
      }
      if (url.endsWith('/v1/me/unread-count')) {
        return jsonResponse(200, { unreadCount: 1, readThroughInboxSequence: '845' });
      }
      if (url.endsWith('/v1/me/activity/read')) {
        assert.deepEqual(JSON.parse(options.body), {
          selector: {
            type: 'scope', readScope: 'social.app:7', throughInboxSequence: '845',
          },
        });
        return jsonResponse(200, { changed: 1, unreadCount: 0 });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const page = await service.feed(42, { limit: 100 });
  assert.equal(page.notifications[0].id, '845');
  assert.equal(page.notifications[0].occurrenceId, 'social.notification:1201');
  assert.equal(page.notifications[0].appId, '7');
  assert.equal(page.readThroughInboxSequence, '845');
  const read = await service.readScope(42, 'social.app:7');
  assert.deepEqual(read, { changed: 1, unreadCount: 0 });
  assert.equal(calls.filter((c) => c.url.endsWith('/v1/auth/exchanges')).length, 1);
});

test('Activity item mapping ignores ledger-owned wrapping details', () => {
  const mapped = mapActivityItem({
    inboxSequence: '999999999999999999',
    readAt: null,
    activityEvent: { sourceEvent: notifications.buildActivityEvent(hydratedNotification()) },
  });
  assert.equal(mapped.id, '999999999999999999');
  assert.equal(mapped.occurrenceId, 'social.notification:1201');
  assert.equal(mapped.kind, 'mention');
  assert.equal(mapped.createdAt, '2026-07-22T15:04:05.000Z');
});

test('existing auto-dismiss actions translate to generic Activity scopes', async () => {
  const calls = [];
  notifications.configureActivity({
    readScope: async (userId, scope) => {
      calls.push({ userId, scope });
      return { changed: 2, unreadCount: 0 };
    },
  }, 'activity');
  try {
    assert.equal(await notifications.markReadForAction({}, 42, 'vote_cast', 10), 2);
    assert.equal(await notifications.markReadForAction({}, 42, 'message_sent', 7), 2);
    assert.equal(await notifications.markReadForAction({}, 42, 'session_opened', 10), 2);
    assert.equal(await notifications.markReadForAction({}, 42, 'headless_cloned', 11), 2);
    assert.deepEqual(calls, [
      { userId: 42, scope: 'social.vote-request:10' },
      { userId: 42, scope: 'social.chat-engagement:7' },
      { userId: 42, scope: 'social.session-completion:10' },
      { userId: 42, scope: 'social.auto-solve-completion:11' },
    ]);
  } finally {
    notifications.configureActivity(null, 'legacy');
  }
});
