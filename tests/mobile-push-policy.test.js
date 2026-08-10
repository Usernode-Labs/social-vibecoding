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

test('FCM message carries only the generic, environment-bound contract', () => {
  const message = buildMessage(INPUT);
  assert.deepEqual(message.notification, {
    title: 'Usernode', body: 'You have new activity',
  });
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

test('reviewed interaction kinds use the generic payload and unknown kinds stay closed', () => {
  assert.equal(buildMessage({ ...INPUT, kind: 'mention' }).data.notification_id, '42');
  assert.throws(() => buildMessage({ ...INPUT, kind: 'future_kind' }), /kind_not_allowed/);
  assert.throws(() => buildMessage({ ...INPUT, notificationId: 2147483648 }), /id_invalid/);
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
