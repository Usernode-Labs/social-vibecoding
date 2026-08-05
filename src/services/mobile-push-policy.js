'use strict';

const crypto = require('crypto');

const ALLOWED_KINDS = new Set(['session_done', 'auto_solve_done']);
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const RECIPIENT_CONTEXT = 'usernode-social-push-recipient-v1';
const PUSH_ENV_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function isPushEnvironment(value) {
  return typeof value === 'string' && PUSH_ENV_RE.test(value);
}

function recipientBinding({ installationId, userId, environment }) {
  const installation = String(installationId || '').toLowerCase();
  const user = String(userId || '');
  if (!installation || !/^[1-9]\d*$/.test(user) || !environment) {
    throw new Error('mobile_push_recipient_binding_invalid');
  }
  return crypto.createHash('sha256')
    .update([RECIPIENT_CONTEXT, installation, user, environment].join('\n'))
    .digest('hex');
}

function buildMessage({
  token, notificationId, kind, environment, installationId, userId,
  expiresAt, now = new Date(),
}) {
  if (typeof token !== 'string' || !token) throw new Error('mobile_push_registration_missing');
  if (!ALLOWED_KINDS.has(kind)) throw new Error('mobile_push_kind_not_allowed');
  const id = Number(notificationId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw new Error('mobile_push_notification_id_invalid');
  }
  const remaining = new Date(expiresAt).getTime() - new Date(now).getTime();
  const ttl = Math.min(MAX_TTL_MS, remaining);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('mobile_push_delivery_expired');

  const collapseId = `usernode-social-${id}`;
  return {
    token,
    notification: { title: 'Usernode', body: 'You have new activity' },
    data: {
      source: 'usernode_social',
      schema: '1',
      environment: String(environment),
      notification_id: String(id),
      recipient_binding: recipientBinding({ installationId, userId, environment }),
    },
    android: {
      ttl,
      collapseKey: collapseId,
      notification: { channelId: 'social_activity', tag: collapseId },
    },
    apns: {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor((new Date(now).getTime() + ttl) / 1000)),
        'apns-collapse-id': collapseId,
      },
      payload: { aps: { category: 'USERNODE_SOCIAL', threadId: 'usernode-social' } },
    },
  };
}

module.exports = {
  ALLOWED_KINDS,
  MAX_TTL_MS,
  RECIPIENT_CONTEXT,
  PUSH_ENV_RE,
  isPushEnvironment,
  recipientBinding,
  buildMessage,
};
