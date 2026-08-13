'use strict';

// Platform-wide messaging notification/realtime contract. These tests keep
// the new private conversation domain separate from legacy app chat: wire
// fields, access-gated hydration/counts, #messages routing, mobile-push copy,
// and member-scoped global-event fan-out must move together.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifications = require('../src/services/notifications');
const ws = require('../src/services/ws');

const ROOT = path.join(__dirname, '..');
const FE = fs.readFileSync(path.join(
  ROOT, 'frontend/src/features/notifications/notifications.js'
), 'utf8');
const WS = fs.readFileSync(path.join(ROOT, 'src/services/ws.js'), 'utf8');

const KINDS = [
  'conversation_invite',
  'conversation_message',
  'conversation_mention',
  'conversation_reply',
  'conversation_reaction',
];

function conversationRow(kind) {
  return {
    id: 91,
    kind,
    read_at: null,
    created_at: '2026-08-13T12:00:00.000Z',
    // Deliberately hostile legacy refs: serialization must suppress them for
    // a conversation kind rather than leaking/routing through an app.
    app_id: 4,
    app_slug: 'private-app',
    app_name: 'Private app',
    chat_message_id: 12,
    message_content: 'legacy app body',
    thread_type: 'issue',
    thread_ref: 88,
    session_id: 99,
    session_title: 'private session',
    pr_title: 'private PR',
    pr_number: 10,
    headless_issue_number: 11,
    branch_name: 'private-branch',
    conversation_id: 73,
    conversation_kind: 'group',
    conversation_title: 'Design crew',
    conversation_message_id: 82,
    conversation_message_content: 'Please review @bob',
    source_username: 'alice',
    detail: kind === 'conversation_reaction' ? '👍' : null,
  };
}

test('all conversation kinds serialize only conversation routing and content', () => {
  assert.deepEqual([...notifications.CONVERSATION_NOTIFICATION_KINDS], KINDS);
  for (const kind of KINDS) {
    const out = notifications.serialize(conversationRow(kind));
    assert.equal(out.kind, kind);
    assert.equal(out.conversationId, 73);
    assert.equal(out.conversationKind, 'group');
    assert.equal(out.conversationTitle, 'Design crew');
    assert.equal(out.conversationMessageId, 82);
    assert.equal(out.messageContent, 'Please review @bob');
    for (const field of [
      'appId', 'appSlug', 'appName', 'chatMessageId', 'threadType',
      'threadRef', 'sessionId', 'sessionTitle', 'prTitle', 'prNumber',
      'headlessIssueNumber', 'branchName',
    ]) assert.equal(out[field], null, `${kind}.${field}`);
  }
});

test('list, exact lookup, count, and conversation mark-read share the membership gate', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/COUNT\(\*\)::int AS c/.test(sql)) return { rows: [{ c: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 2 };
    },
  };
  await notifications.listForUser(pool, 7, { limit: 10 });
  await notifications.getForUser(pool, 7, 91);
  assert.equal(await notifications.countUnread(pool, 7), 0);
  assert.equal(await notifications.markReadForConversation(pool, 7, 73), 2);

  assert.equal(calls.length, 4);
  for (const { sql } of calls) {
    assert.match(sql, /conversation_members notification_member/);
    assert.match(sql, /notification_member\.user_id = n\.user_id/);
    assert.match(sql, /notification_member\.status = 'member'/);
    assert.match(sql, /n\.kind = 'conversation_invite'[\s\S]*status = 'invited'/);
    assert.match(sql, /n\.kind NOT IN \('conversation_invite'/,
      'malformed conversation kinds without a conversation ref fail closed');
  }
  for (const { sql } of calls.slice(0, 2)) {
    assert.match(sql, /LEFT JOIN conversations c ON c\.id = n\.conversation_id/);
    assert.match(sql, /LEFT JOIN conversation_messages conversation_message/);
  }
  assert.deepEqual(calls[3].params, [7, 73]);
});

test('live hydration uses the stored recipient and suppresses removed members', async () => {
  const wsId = require.resolve('../src/services/ws');
  const original = require.cache[wsId];
  const pushes = [];
  require.cache[wsId] = {
    id: wsId,
    filename: wsId,
    loaded: true,
    exports: {
      pushNotificationToUser(userId, payload) { pushes.push({ userId, payload }); },
    },
  };
  try {
    let mode = 'member';
    const pool = {
      async query(sql) {
        assert.match(sql, /conversation_members notification_member/);
        return { rows: mode === 'member' ? [{ ...conversationRow('conversation_message'), user_id: 7 }] : [] };
      },
    };
    await notifications.hydrateAndPush(pool, { id: 91, user_id: 999 });
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].userId, 7, 'recipient comes from the access-gated DB row');
    assert.equal(pushes[0].payload.type, 'notification_new');
    assert.equal(pushes[0].payload.notification.conversationId, 73);

    mode = 'removed';
    await notifications.hydrateAndPush(pool, { id: 91, user_id: 7 });
    assert.equal(pushes.length, 1, 'no event after membership disappears');
  } finally {
    if (original) require.cache[wsId] = original;
    else delete require.cache[wsId];
  }
});

test('bell copy, grouping, mark-read, and clicks are conversation-native', () => {
  for (const kind of KINDS) {
    assert.match(FE, new RegExp(`case '${kind}'|${kind}:`), `${kind} has explicit copy`);
  }
  assert.match(FE, /`conversation:\$\{n\.conversationId\}`/);
  assert.match(FE, /\{ conversation_id: numericConversationId \}/);
  assert.match(FE, /window\.UsernodeReact\?\.messages/);
  assert.match(FE, /`#messages\/\$\{conversationId\}`/);
  assert.doesNotMatch(
    FE.match(/if \(CONVERSATION_NOTIF_KINDS\.has\(item\.kind\)\)[\s\S]*?\n    \}/)?.[0] || '',
    /openAppTab|#app\//,
    'conversation click path never falls back to app navigation'
  );
});

test('conversation realtime accepts only reviewed member-scoped event shapes', () => {
  const TYPES = [
    'conversation_message_created',
    'conversation_message_updated',
    'conversation_reaction_updated',
    'conversation_read',
    'conversation_membership_changed',
    'conversation_typing',
  ];
  for (const type of TYPES) assert.match(WS, new RegExp(`'${type}'`));
  assert.match(WS, /sent \+= pushToUser\(userId, payload\)/);
  const helper = WS.match(/function pushConversationEvent[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(helper, /broadcast\(|broadcastGlobal/);

  assert.equal(ws.pushConversationEvent([], {
    type: 'conversation_message_created', conversationId: 5,
  }), 0);
  assert.equal(ws.pushConversationEvent([7], {
    type: 'unreviewed_private_event', conversationId: 5,
  }), 0);
  assert.equal(ws.pushConversationEvent([7], {
    type: 'conversation_message_created', conversationId: 2147483648,
  }), 0);
});

