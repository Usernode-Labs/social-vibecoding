'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildMessage, recipientBinding, RECIPIENT_CONTEXT, isPushEnvironment,
} = require('../src/services/mobile-push-policy');
const {
  classifyError, parseServiceAccount,
} = require('../src/services/mobile-push-provider');
const { validateConfiguration } = require('../src/services/mobile-push');

const INPUT = {
  token: 'opaque-fcm-token',
  notificationId: 42,
  kind: 'session_done',
  environment: 'production',
  installationId: '123e4567-e89b-12d3-a456-426614174000',
  userId: 7,
  expiresAt: new Date(Date.now() + 60_000),
};

test('recipient binding exactly matches the Flutter context encoding', () => {
  const expected = crypto.createHash('sha256').update([
    RECIPIENT_CONTEXT, INPUT.installationId, '7', 'production',
  ].join('\n')).digest('hex');
  assert.equal(recipientBinding(INPUT), expected);
});

test('push environments match the mobile build contract', () => {
  assert.equal(isPushEnvironment('production'), true);
  assert.equal(isPushEnvironment('staging_2'), true);
  assert.equal(isPushEnvironment('2production'), false);
  assert.equal(isPushEnvironment('Production'), false);
  assert.equal(isPushEnvironment(''), false);
});

test('FCM data payload keeps the opaque, environment-bound contract', () => {
  const message = buildMessage(INPUT);
  assert.deepEqual(Object.keys(message.data).sort(), [
    'environment', 'notification_id', 'recipient_binding', 'schema', 'source',
  ]);
  assert.equal(message.data.source, 'usernode_social');
  assert.equal(message.data.schema, '1');
  assert.equal(message.data.notification_id, '42');
  assert.equal(message.android.notification.channelId, 'social_activity');
  assert.ok(message.android.ttl > 0 && message.android.ttl <= 24 * 60 * 60 * 1000);
  assert.doesNotMatch(JSON.stringify(message.data), /session_done|user_id|token/);
});

test('reviewed interaction kinds build and unknown kinds stay closed', () => {
  assert.equal(buildMessage({ ...INPUT, kind: 'mention' }).data.notification_id, '42');
  assert.throws(() => buildMessage({ ...INPUT, kind: 'future_kind' }), /kind_not_allowed/);
  assert.throws(() => buildMessage({ ...INPUT, notificationId: 2147483648 }), /id_invalid/);
});

const CONTEXT = {
  appName: 'MyPage',
  sourceUsername: 'alice',
  messageContent: 'hey can you look at the header',
  sessionTitle: 'Fix login redirect loop',
  prTitle: null,
  branchName: null,
  detail: null,
};

test('each kind renders its own title and body from send-time context', () => {
  const cases = [
    ['mention', CONTEXT,
      '@alice mentioned you · MyPage', 'hey can you look at the header'],
    ['reply', CONTEXT,
      '@alice replied to you · MyPage', 'hey can you look at the header'],
    ['reaction', { ...CONTEXT, detail: '👍' },
      '@alice reacted 👍 · MyPage', 'hey can you look at the header'],
    ['kudos', CONTEXT,
      '@alice gave you kudos · MyPage', '"Fix login redirect loop"'],
    ['collab_invite', CONTEXT,
      '@alice invited you to collaborate · MyPage', 'Accept or decline in the app'],
    ['approver_invite', CONTEXT,
      '@alice invited you as an approver · MyPage', 'Accept or decline in the app'],
    ['spec_shared', { ...CONTEXT, detail: '3' },
      '@alice shared a spec with you · MyPage', '"Fix login redirect loop" (v3)'],
    ['session_done', CONTEXT,
      'Session finished · MyPage', '"Fix login redirect loop" is ready to review'],
    ['auto_solve_done', { ...CONTEXT, detail: 'spec_code' },
      'Auto-solve finished · MyPage', '"Fix login redirect loop" — spec and code ready'],
    ['pr_proposed', { ...CONTEXT, prTitle: 'Fix login redirect loop', sessionTitle: null },
      '@alice proposed "Fix login redirect loop" · MyPage', 'Ready for your vote'],
    ['check_failed', CONTEXT,
      'Proposal checks failed · MyPage', '"Fix login redirect loop"'],
    ['stale_pr', CONTEXT,
      'Your proposal needs attention · MyPage', '"Fix login redirect loop" has no votes yet'],
  ];
  for (const [kind, context, title, body] of cases) {
    const message = buildMessage({ ...INPUT, kind, context });
    assert.deepEqual(message.notification, { title, body }, kind);
  }
});

test('accepted-invite kinds render a title with no body', () => {
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'collab_invite_accepted', context: CONTEXT }).notification,
    { title: '@alice accepted your invite · MyPage' }
  );
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'approver_invite_accepted', context: CONTEXT }).notification,
    { title: '@alice accepted your approver invite · MyPage' }
  );
});

test('titles and bodies are sanitized, collapsed, and truncated', () => {
  const message = buildMessage({
    ...INPUT,
    kind: 'mention',
    context: {
      ...CONTEXT,
      appName: 'A'.repeat(200),
      messageContent: `line one\n\n  ${'x'.repeat(300)}`,
    },
  });
  assert.equal(message.notification.title.length, 80);
  assert.ok(message.notification.title.endsWith('…'));
  assert.equal(message.notification.body.length, 140);
  assert.ok(message.notification.body.startsWith('line one x'));
  assert.ok(message.notification.body.endsWith('…'));
  assert.doesNotMatch(message.notification.body, /\n/);

  const embedded = buildMessage({
    ...INPUT,
    kind: 'pr_proposed',
    context: { ...CONTEXT, sessionTitle: null, prTitle: 'p'.repeat(200) },
  });
  assert.ok(embedded.notification.title.includes('…'));
  assert.ok(embedded.notification.title.length <= 80);
});

test('missing context degrades to the generic notification, never a throw', () => {
  for (const context of [undefined, {}, { appName: 42, sourceUsername: {} }]) {
    const message = buildMessage({ ...INPUT, kind: 'mention', context });
    assert.deepEqual(message.notification, {
      title: 'Usernode', body: 'You have new activity',
    });
  }
  // System kinds keep their kind-specific title even without app/session data.
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'session_done', context: {} }).notification,
    { title: 'Session finished' }
  );
});

test('context never leaks into the data payload', () => {
  const message = buildMessage({ ...INPUT, kind: 'mention', context: CONTEXT });
  assert.doesNotMatch(JSON.stringify(message.data), /alice|MyPage|header/);
});

test('provider errors distinguish dead tokens from retryable transport failures', () => {
  assert.equal(
    classifyError({ code: 'messaging/registration-token-not-registered' }).action,
    'drop_registration'
  );
  assert.equal(
    classifyError({ code: 'messaging/mismatched-credential' }).action,
    'drop_registration'
  );
  assert.equal(classifyError({ code: 'messaging/server-unavailable' }).action, 'retry');
  assert.deepEqual(classifyError({ code: 'messaging/invalid-payload' }), {
    action: 'dead', code: 'invalid_application_payload',
  });
});

test('enabled delivery requires a matching Firebase project and explicit environment', () => {
  const account = {
    project_id: 'social-prod', client_email: 'firebase@example.test', private_key: 'pem',
  };
  const encoded = Buffer.from(JSON.stringify(account)).toString('base64');
  assert.equal(parseServiceAccount(encoded, 'social-prod').project_id, 'social-prod');
  assert.throws(() => parseServiceAccount(encoded, 'other'), /another project/);
  assert.throws(() => validateConfiguration({
    mobilePushEnabled: true,
    mobilePushEnvironment: '',
  }), /PUSH_ENV/);
  assert.doesNotThrow(() => validateConfiguration({
    mobilePushEnabled: true,
    mobilePushEnvironment: 'production',
    firebaseProjectId: 'social-prod',
    firebaseServiceAccountJsonB64: encoded,
  }));
});
