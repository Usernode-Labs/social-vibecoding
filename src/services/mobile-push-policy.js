'use strict';

const crypto = require('crypto');
const { ALLOWED_KINDS } = require('./mobile-push-preferences');

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

// ── Contextual notification copy (#3289) ───────────────────────────────
// The visible title/body are built per kind from send-time context loaded
// by the worker (same joins as the in-app dropdown). The `data` payload
// stays opaque — context feeds ONLY the display strings. Anything missing
// or malformed degrades to the generic copy; copy assembly never throws,
// so a context problem can never kill a delivery.

const TITLE_MAX = 80;
const BODY_MAX = 140;
const EMBED_TITLE_MAX = 60;
const GENERIC_COPY = Object.freeze({ title: 'Usernode', body: 'You have new activity' });

// Push text is plain and single-line: drop control chars, collapse runs of
// whitespace. Returns '' for anything that is not a usable string.
function cleanText(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

const AUTO_SOLVE_OUTCOMES = Object.freeze({
  spec: 'spec ready',
  code: 'code ready',
  spec_code: 'spec and code ready',
  question: 'needs your answer',
  failed: 'run failed',
});

// Kind-specific {title, body}, or null when the kind's essential context is
// missing (e.g. a mention without a sender) — null means the generic copy.
function buildCopy(kind, context) {
  const app = cleanText(context.appName);
  const actor = cleanText(context.sourceUsername);
  const message = cleanText(context.messageContent);
  const detail = cleanText(context.detail);
  // #971 preference order, same as the in-app dropdown renderers.
  const label = cleanText(context.sessionTitle)
    || cleanText(context.prTitle) || cleanText(context.branchName);
  const withApp = (text) => (app ? `${text} · ${app}` : text);
  const quoted = label ? `"${truncate(label, EMBED_TITLE_MAX)}"` : '';
  switch (kind) {
    case 'mention':
      return actor && { title: withApp(`@${actor} mentioned you`), body: message };
    case 'reply':
      return actor && { title: withApp(`@${actor} replied to you`), body: message };
    case 'reaction':
      return actor && {
        title: withApp(detail ? `@${actor} reacted ${detail}` : `@${actor} reacted`),
        body: message,
      };
    case 'kudos':
      return actor && { title: withApp(`@${actor} gave you kudos`), body: quoted };
    case 'collab_invite':
      return {
        title: withApp(actor ? `@${actor} invited you to collaborate` : 'You have a collaboration invite'),
        body: 'Accept or decline in the app',
      };
    case 'collab_invite_accepted':
      return actor && { title: withApp(`@${actor} accepted your invite`), body: '' };
    case 'approver_invite':
      return {
        title: withApp(actor ? `@${actor} invited you as an approver` : 'You have an approver invite'),
        body: 'Accept or decline in the app',
      };
    case 'approver_invite_accepted':
      return actor && { title: withApp(`@${actor} accepted your approver invite`), body: '' };
    case 'spec_shared':
      return {
        title: withApp(actor ? `@${actor} shared a spec with you` : 'A spec was shared with you'),
        body: quoted && detail ? `${quoted} (v${detail})` : quoted,
      };
    case 'session_done':
      return { title: withApp('Session finished'), body: quoted && `${quoted} is ready to review` };
    case 'auto_solve_done': {
      const outcome = AUTO_SOLVE_OUTCOMES[detail] || '';
      return {
        title: withApp('Auto-solve finished'),
        body: quoted && outcome ? `${quoted} — ${outcome}` : (quoted || outcome),
      };
    }
    case 'pr_proposed':
      return actor && {
        title: withApp(quoted ? `@${actor} proposed ${quoted}` : `@${actor} proposed a change`),
        body: 'Ready for your vote',
      };
    case 'check_failed':
      return { title: withApp('Proposal checks failed'), body: quoted };
    case 'stale_pr':
      return {
        title: withApp('Your proposal needs attention'),
        body: quoted && `${quoted} has no votes yet`,
      };
    default:
      return null;
  }
}

function buildNotificationCopy(kind, context) {
  try {
    const copy = buildCopy(kind, context && typeof context === 'object' ? context : {});
    const title = copy ? truncate(cleanText(copy.title), TITLE_MAX) : '';
    if (!title) return { ...GENERIC_COPY };
    const body = truncate(cleanText(copy.body), BODY_MAX);
    return body ? { title, body } : { title };
  } catch {
    return { ...GENERIC_COPY };
  }
}

function buildMessage({
  token, notificationId, kind, environment, installationId, userId,
  expiresAt, context, now = new Date(),
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
    notification: buildNotificationCopy(kind, context),
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
