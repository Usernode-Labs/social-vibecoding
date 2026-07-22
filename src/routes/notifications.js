const { Router } = require('express');
const { getPool } = require('../db/pool');
const notifications = require('../services/notifications');
const log = require('../services/logger');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const NOTIFICATION_SECTIONS = new Set(['bell', 'work']);

// Request-time staging fixtures for the work drawer. They are presentation
// data only: demo=true tells the browser never to send their synthetic ids to
// Activity's item-read API.
function stagingMockNotifications() {
  const now = Date.now();
  const base = {
    demo: true,
    readAt: null,
    appId: 0,
    appSlug: 'staging-demo',
    appName: 'Staging demo app',
    chatMessageId: null,
    messageContent: null,
    threadType: null,
    threadRef: null,
    sourceUsername: null,
    branchName: null,
    detail: null,
  };
  return [
    {
      ...base,
      id: 990201,
      occurrenceId: 'social.demo-notification:990201',
      kind: 'session_done',
      createdAt: new Date(now - 4 * 60 * 1000).toISOString(),
      sessionId: 990101,
      prTitle: '[Mock] Finished dev session',
      prNumber: null,
      headlessIssueNumber: null,
    },
    {
      ...base,
      id: 990202,
      occurrenceId: 'social.demo-notification:990202',
      kind: 'auto_solve_done',
      detail: 'failed',
      createdAt: new Date(now - 12 * 60 * 1000).toISOString(),
      sessionId: null,
      prTitle: null,
      prNumber: null,
      headlessIssueNumber: 900002,
    },
    {
      ...base,
      id: 990203,
      occurrenceId: 'social.demo-notification:990203',
      kind: 'stale_pr',
      createdAt: new Date(now - 40 * 60 * 1000).toISOString(),
      sessionId: 990103,
      prTitle: '[Mock] Stale proposal going quiet',
      prNumber: 9901,
      headlessIssueNumber: null,
    },
    {
      ...base,
      id: 990204,
      occurrenceId: 'social.demo-notification:990204',
      kind: 'check_failed',
      createdAt: new Date(now - 55 * 60 * 1000).toISOString(),
      sessionId: 990104,
      prTitle: "[Mock] Proposal whose preview won't boot",
      prNumber: 9902,
      headlessIssueNumber: null,
    },
  ];
}

function positiveDecimal(value) {
  const out = String(value ?? '');
  return /^[1-9][0-9]{0,18}$/.test(out) ? out : null;
}

function watermark(value) {
  const out = String(value ?? '');
  return /^(0|[1-9][0-9]{0,18})$/.test(out) ? out : null;
}

function encodeLegacyCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }))
    .toString('base64url');
}

function decodeLegacyCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.createdAt !== 'string' || !positiveDecimal(parsed.id)) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: Number(parsed.id) };
  } catch {
    return null;
  }
}

function pushChanged(userId) {
  try {
    const { pushNotificationToUser } = require('../services/ws');
    pushNotificationToUser(userId, { type: 'notifications_changed' });
  } catch (err) {
    log.warn('notifications', 'cross-tab invalidation failed', { message: err.message });
  }
}

function isExactWorkKindList(value) {
  if (!Array.isArray(value) || value.length !== notifications.WORK_NOTIFICATION_KINDS.length) {
    return false;
  }
  const received = new Set(value);
  return received.size === notifications.WORK_NOTIFICATION_KINDS.length
    && notifications.WORK_NOTIFICATION_KINDS.every((kind) => received.has(kind));
}

// Short rollout compatibility for clients from the new main branch. New
// clients send a stable UI section; the server only recognizes the exact old
// four-kind forms and never turns arbitrary kind arrays into a wider clear.
function requestedSection(body) {
  if (body.section != null) {
    if (body.all === true || body.kinds != null || body.exclude_kinds != null) return 'invalid';
    return NOTIFICATION_SECTIONS.has(body.section) ? body.section : 'invalid';
  }
  if (body.kinds == null && body.exclude_kinds == null) return null;
  if (body.all !== true || (body.kinds != null && body.exclude_kinds != null)) return 'invalid';
  if (isExactWorkKindList(body.kinds)) return 'work';
  if (isExactWorkKindList(body.exclude_kinds)) return 'bell';
  return 'invalid';
}

// One rollout flag selects the entire notification authority. Activity-mode
// requests never fall back to Social after an upstream failure.
function notificationsRoutes(config, activityService) {
  const router = Router();
  const pool = getPool(config);
  const activityMode = config.activityNotificationsReadPath === 'activity';

  router.get('/api/notifications', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
      : 100;
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor
      ? req.query.cursor
      : null;

    try {
      let payload;
      if (activityMode) {
        if (!activityService) throw new Error('Activity service is not configured');
        payload = await activityService.feed(req.user.id, { limit, before: cursor });
        if (!cursor) {
          const snapshot = await activityService.unread(req.user.id);
          payload.unread = snapshot.unreadCount;
        }
      } else {
        const before = cursor ? decodeLegacyCursor(cursor) : null;
        if (cursor && !before) {
          return res.status(400).json({ error: 'Invalid notification cursor' });
        }
        const rows = await notifications.listForUser(pool, req.user.id, { limit, before });
        const hasMore = rows.length === limit;
        payload = {
          notifications: rows.map(notifications.serialize),
          hasMore,
          nextCursor: hasMore && rows.length ? encodeLegacyCursor(rows[rows.length - 1]) : null,
          readThroughInboxSequence: null,
        };
        if (!cursor) payload.unread = await notifications.countUnread(pool, req.user.id);
      }

      if (!cursor) {
        payload.pendingInvites = await notifications.listPendingInvites(pool, req.user.id);
        if (IS_STAGING && req.query.demo === '1') {
          const mocks = stagingMockNotifications();
          payload.notifications = [...mocks, ...payload.notifications];
          payload.unread = Number(payload.unread || 0) + mocks.length;
          // Pinned-invite demo row: drives the drawer's Invites section
          // and its swipe Accept/Decline path in a staging preview.
          // Obviously fake (staging-demo-*); acting on it hits a
          // nonexistent app and surfaces a normal error toast.
          payload.pendingInvites = [
            {
              appId: 990001,
              appSlug: 'staging-demo',
              appName: 'Staging demo app',
              invitedBy: 'staging-demo-user',
              kind: 'collab',
              createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            },
            ...(payload.pendingInvites || []),
          ];
        }
      }
      return res.json(payload);
    } catch (err) {
      log.error('notifications', 'list failed', {
        authority: activityMode ? 'activity' : 'legacy',
        message: err.message,
      });
      return res.status(activityMode ? 502 : 500).json({
        error: activityMode ? 'Activity service unavailable' : 'Internal server error',
      });
    }
  });

  router.post('/api/notifications/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const body = req.body || {};
    const section = requestedSection(body);
    if (section === 'invalid') {
      return res.status(400).json({ error: 'Invalid notification section selector' });
    }
    const choices = [
      body.all === true && section == null,
      body.id != null,
      body.app_id != null,
      body.chat_message_id != null,
      section != null,
    ].filter(Boolean).length;
    if (choices !== 1) {
      return res.status(400).json({ error: 'Choose exactly one notification read selector' });
    }

    try {
      let cleared;
      let unread;
      if (activityMode) {
        if (!activityService) throw new Error('Activity service is not configured');
        let selector;
        if (body.id != null) {
          const id = positiveDecimal(body.id);
          if (!id) return res.status(400).json({ error: 'Invalid notification id' });
          selector = { type: 'items', inboxSequences: [id] };
        } else {
          const through = watermark(body.through_inbox_sequence);
          if (through == null) {
            return res.status(400).json({ error: 'Missing or invalid read watermark' });
          }
          if (section != null) {
            selector = {
              type: 'scope',
              readScope: notifications.readScopeForNotificationSection(section),
              throughInboxSequence: through,
            };
          } else if (body.all === true) {
            selector = { type: 'all', throughInboxSequence: through };
          } else if (body.app_id != null) {
            const appId = positiveDecimal(body.app_id);
            if (!appId) return res.status(400).json({ error: 'Invalid app id' });
            selector = {
              type: 'scope',
              readScope: `social.app:${appId}`,
              throughInboxSequence: through,
            };
          } else {
            const messageId = positiveDecimal(body.chat_message_id);
            if (!messageId) return res.status(400).json({ error: 'Invalid chat message id' });
            selector = {
              type: 'scope',
              readScope: `social.chat-message:${messageId}`,
              throughInboxSequence: through,
            };
          }
        }
        const result = await activityService.setRead(req.user.id, selector);
        cleared = result.changed;
        unread = result.unreadCount;
      } else if (body.app_id != null) {
        cleared = await notifications.markReadForApp(pool, req.user.id, Number(body.app_id));
        unread = await notifications.countUnread(pool, req.user.id);
      } else if (body.chat_message_id != null) {
        cleared = await notifications.markReadForMessage(
          pool, req.user.id, Number(body.chat_message_id)
        );
        unread = await notifications.countUnread(pool, req.user.id);
      } else if (section === 'work') {
        cleared = await notifications.markRead(pool, req.user.id, {
          all: true,
          kinds: notifications.WORK_NOTIFICATION_KINDS,
        });
        unread = await notifications.countUnread(pool, req.user.id);
      } else if (section === 'bell') {
        cleared = await notifications.markRead(pool, req.user.id, {
          all: true,
          excludeKinds: notifications.WORK_NOTIFICATION_KINDS,
        });
        unread = await notifications.countUnread(pool, req.user.id);
      } else {
        cleared = await notifications.markRead(pool, req.user.id, {
          id: body.id,
          all: body.all === true,
        });
        unread = await notifications.countUnread(pool, req.user.id);
      }

      if (cleared > 0) pushChanged(req.user.id);
      return res.json({ unread, cleared });
    } catch (err) {
      log.error('notifications', 'mark read failed', {
        authority: activityMode ? 'activity' : 'legacy',
        message: err.message,
      });
      return res.status(activityMode ? 502 : 500).json({
        error: activityMode ? 'Activity service unavailable' : 'Internal server error',
      });
    }
  });

  return router;
}

module.exports = { notificationsRoutes, stagingMockNotifications };
