const { Router } = require('express');
const { getPool } = require('../db/pool');
const notifications = require('../services/notifications');
const messageBookmarks = require('../services/message-bookmarks');
const mobilePushPreferences = require('../services/mobile-push-preferences');
const log = require('../services/logger');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ── Staging mock data ──────────────────────────────────────────────────
// Request-time (?demo=1) injection of the four session-related
// notification kinds — session_done, auto_solve_done (failed), stale_pr,
// check_failed — so the header cog's pinned "Needs attention" section,
// its green badge, and the bell's EXCLUSION of these kinds are all
// reviewable in a staging preview without waiting for a real session to
// finish. Same conventions as the other mock feeds (stagingMockProposals
// in votes.js): fixed 99xxxx ids, "[Mock]" titles, never persisted,
// strictly a no-op outside staging. Mark-read calls on these ids match
// no DB row and no-op harmlessly.
function stagingMockNotifications() {
  const now = Date.now();
  const base = {
    readAt: null,
    appId: 0,
    appSlug: 'staging-demo',
    appName: 'Staging demo app',
    chatMessageId: null,
    messageContent: null,
    threadType: null,
    threadRef: null,
    sourceUsername: null,
    sessionTitle: null,
    branchName: null,
    detail: null,
  };
  return [
    // #971: the issue's exact case — a session that finished BEFORE it was
    // promoted, so it has a session title but no PR title. The row must show
    // the title, never the `dev/…` branch name beside it.
    {
      ...base,
      id: 990201, kind: 'session_done',
      createdAt: new Date(now - 4 * 60 * 1000).toISOString(),
      sessionId: 990101,
      sessionTitle: '[Mock] Session titled but not yet proposed',
      prTitle: null, branchName: 'dev/mockuser-1700000000000',
      prNumber: null, headlessIssueNumber: null,
    },
    {
      ...base,
      id: 990202, kind: 'auto_solve_done', detail: 'failed',
      createdAt: new Date(now - 12 * 60 * 1000).toISOString(),
      sessionId: null, prTitle: null, prNumber: null,
      headlessIssueNumber: 900002,
    },
    {
      ...base,
      id: 990203, kind: 'stale_pr',
      createdAt: new Date(now - 40 * 60 * 1000).toISOString(),
      sessionId: 990103,
      sessionTitle: '[Mock] Stale proposal going quiet',
      prTitle: '[Mock] Stale proposal going quiet',
      prNumber: 9901, headlessIssueNumber: null,
    },
    {
      ...base,
      id: 990204, kind: 'check_failed',
      createdAt: new Date(now - 55 * 60 * 1000).toISOString(),
      sessionId: 990104,
      sessionTitle: "[Mock] Proposal whose preview won't boot",
      prTitle: "[Mock] Proposal whose preview won't boot",
      prNumber: 9902, headlessIssueNumber: null,
    },
    // #971: the untitled tail of the ladder — a session that finished before
    // its title was generated still falls back to the branch name, so the row
    // can never render blank.
    {
      ...base,
      id: 990205, kind: 'session_done',
      createdAt: new Date(now - 70 * 60 * 1000).toISOString(),
      sessionId: 990105,
      sessionTitle: null, prTitle: null,
      branchName: 'dev/mockuser-1700000000001',
      prNumber: null, headlessIssueNumber: null,
    },
    // An ALREADY-READ row. The drawer lists unread notifications and parks the
    // read ones behind "See N older notifications", so without one of these a
    // staging preview has nothing behind that button — it does not render at
    // all, the "you're all caught up" state can never be reached, and the two
    // things a reviewer is being asked to look at are both invisible.
    //
    // `readAt` in the past is the whole point of the row, and it is the only
    // thing that distinguishes it from the four above. Same conventions as
    // they use: a fixed 99xxxx id, a "[Mock]" title, request-time only, never
    // persisted, and a no-op outside staging — marking it read again matches
    // no DB row and harmlessly does nothing.
    {
      ...base,
      id: 990206, kind: 'session_done',
      createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      readAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      sessionId: 990106,
      sessionTitle: '[Mock] Something you already read',
      prTitle: null, branchName: 'dev/mockuser-1700000000002',
      prNumber: null, headlessIssueNumber: null,
    },
  ];
}

// #1280: staging demo rows for the drawer's pinned "Saved" section.
// `message_bookmarks` is `staging:private` (it is one person's private
// feed), so a staging clone has the table and none of the rows and the
// section would render empty in every preview — the same problem
// stagingMockNotifications above solves for the session kinds, solved the
// same way: request-time (?demo=1) injection, never persisted, a strict
// no-op outside staging. Unsaving one of these hits a message id that
// matches no row and no-ops harmlessly, exactly like a mark-read on a mock
// notification.
function stagingMockSavedMessages() {
  const now = Date.now();
  return [
    {
      messageId: 990301,
      appId: 0,
      appSlug: 'staging-demo',
      appName: 'Staging demo app',
      author: 'staging-demo-user',
      content: '[Mock] The deploy runbook lives in docs/deploy.md — '
        + 'saving this so I can find it again on Friday.',
      threadType: null,
      threadRef: null,
      savedAt: new Date(now - 8 * 60 * 1000).toISOString(),
      messageCreatedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    },
    {
      messageId: 990302,
      appId: 0,
      appSlug: 'staging-demo',
      appName: 'Staging demo app',
      author: 'staging-demo-reviewer',
      content: '[Mock] Decision from the thread: we ship the smaller '
        + 'version first and revisit the picker next week.',
      threadType: 'issue',
      threadRef: 990001,
      savedAt: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
      messageCreatedAt: new Date(now - 27 * 60 * 60 * 1000).toISOString(),
    },
  ];
}

// Routes for the top-right notifications dropdown. All routes assume
// authMiddleware has already attached `req.user`.
function notificationsRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Account-level mobile-push policy. This is intentionally a browser-
  // session surface rather than a phone-registration surface: any signed-in
  // Social browser may configure the account, while each phone keeps its
  // independent Activity notifications master switch.
  router.get('/api/me/mobile-push-preferences', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const preferences = await mobilePushPreferences.readPreferences(pool, req.user.id);
      return res.json({ preferences });
    } catch (err) {
      log.error('mobile-push-preferences', 'read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/me/mobile-push-preferences', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { details, values } = mobilePushPreferences.validatePreferencePatch(req.body);
    if (Object.keys(details).length) {
      return res.status(422).json({
        error: 'The given data was invalid.',
        details,
      });
    }
    try {
      const preferences = await mobilePushPreferences.writePreferences(
        pool, req.user.id, values
      );
      return res.json({ preferences });
    } catch (err) {
      log.error('mobile-push-preferences', 'update failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Full dropdown payload: recent notifications (read and unread) + an
  // unread count so the badge and list stay in sync on initial page load.
  //
  // Pagination (#84 scroll-to-load-more): the client passes
  // `?before=<createdAt>&before_id=<id>&limit=<n>` to fetch the page
  // strictly older than that keyset cursor. We over-fetch nothing — a
  // returned page exactly `limit` long means there may be more, so we
  // hand back `nextBefore` (the cursor for the next page) and `hasMore`.
  // The unread count is omitted on paginated follow-up requests (it's a
  // whole-account aggregate the client already has from the first page).
  router.get('/api/notifications', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'private, no-store');
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
        : 100;

      let before = null;
      if (req.query.before) {
        const beforeId = Number(req.query.before_id);
        before = {
          createdAt: req.query.before,
          id: Number.isFinite(beforeId) ? beforeId : 0,
        };
      }

      const rows = await notifications.listForUser(pool, req.user.id, { limit, before });
      const serialized = rows.map(notifications.serialize);

      const hasMore = rows.length === limit;
      const last = rows[rows.length - 1];
      const nextBefore = hasMore && last
        ? { createdAt: last.created_at, id: last.id }
        : null;

      // Only compute the account-wide unread aggregate on the first page;
      // follow-up (cursor) fetches just append older rows.
      const payload = {
        notifications: serialized,
        hasMore,
        nextBefore,
      };
      if (!before) {
        payload.unread = await notifications.countUnread(pool, req.user.id);
        // Pending collaborator invites for the drawer's pinned Invites
        // section. Sourced from app_collaborators (authoritative about
        // what's still actionable), not from collab_invite notification
        // rows. First page only — like `unread`, it's an account-wide
        // aggregate the client already has on cursor follow-ups.
        payload.pendingInvites = await notifications.listPendingInvites(pool, req.user.id);
        // #1280: this user's saved messages, for the drawer's pinned
        // "Saved" section. First page only for the same reason as the two
        // aggregates above — the section is pinned, not paginated, so a
        // cursor follow-up would only re-send what the client already has.
        // Best-effort: a failure here renders an empty section rather than
        // 500ing the whole dropdown.
        payload.savedMessages = await messageBookmarks.listForUserSafe(
          pool, req.user.id, { isAdmin: !!req.user.isAdmin }
        );
        // Staging-only demo rows (?demo=1) — see stagingMockNotifications.
        // First page only (they'd duplicate on cursor follow-ups), unread
        // count bumped to match so the client's red-badge subtraction
        // (account unread minus loaded session-kind unread) stays honest.
        //
        // Only the UNREAD mocks are counted. This used to add `mocks.length`
        // outright, which was right while every mock was unread; one of them
        // now ships with a `readAt` (so the drawer's "older notifications"
        // view has something behind it), and counting that one would claim an
        // already-read row as unread — inflating the red badge by one and
        // leaving "Mark all read" enabled with nothing left to mark.
        if (IS_STAGING && req.query.demo === '1') {
          const mocks = stagingMockNotifications();
          payload.notifications = [...mocks, ...payload.notifications];
          payload.unread += mocks.filter((m) => !m.readAt).length;
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
          // Pinned saved-message demo rows (#1280) — see
          // stagingMockSavedMessages. Prepended, so a staging clone that
          // somehow does carry real saves still shows them below.
          payload.savedMessages = [
            ...stagingMockSavedMessages(),
            ...(payload.savedMessages || []),
          ];
        }
      }
      res.json(payload);
    } catch (err) {
      log.error('notifications', 'list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Native push carries no notification copy or route, only an opaque id.
  // Resolve that id through the authenticated Social session and deliberately
  // return the same 404 for an absent row and another user's row.
  router.get('/api/notifications/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'private, no-store');
    const rawId = String(req.params.id || '');
    if (!/^[1-9]\d{0,9}$/.test(rawId)) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id > 2147483647) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    try {
      const row = await notifications.getForUser(pool, req.user.id, id);
      if (!row) {
        return res.status(404).json({ error: 'Notification not found' });
      }
      return res.json({ notification: notifications.serialize(row) });
    } catch (err) {
      log.error('notifications', 'exact lookup failed', {
        id,
        message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/notifications/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'private, no-store');
    const {
      id, all, chat_message_id: chatMessageId, app_id: appId,
      conversation_id: conversationId,
      kinds, exclude_kinds: excludeKinds,
    } = req.body || {};
    // Kind scoping for the split drawers (cog vs bell). Sanitize to
    // string arrays; anything else is treated as absent.
    const kindList = Array.isArray(kinds) ? kinds.filter((k) => typeof k === 'string') : null;
    const excludeList = Array.isArray(excludeKinds) ? excludeKinds.filter((k) => typeof k === 'string') : null;
    try {
      // Platform conversations are a separate notification domain from app
      // chats. A dedicated scope prevents equal integer ids from clearing
      // one another and gives conversation groups one atomic mark-read path.
      if (conversationId != null) {
        const rawConversationId = String(conversationId);
        if (!/^[1-9]\d{0,9}$/.test(rawConversationId)) {
          return res.status(400).json({ error: 'Invalid conversation id' });
        }
        const parsedConversationId = Number(rawConversationId);
        if (!Number.isSafeInteger(parsedConversationId) || parsedConversationId > 2147483647) {
          return res.status(400).json({ error: 'Invalid conversation id' });
        }
        const cleared = await notifications.markReadForConversation(
          pool, req.user.id, parsedConversationId
        );
        const unread = await notifications.countUnread(pool, req.user.id);
        if (cleared > 0) {
          try {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          } catch (err) {
            log.warn('notifications', 'cross-tab push failed', { message: err.message });
          }
        }
        return res.json({ unread, cleared });
      }

      // `{ app_id }` is the per-group "Mark read" path (#84 grouping):
      // clear every unread notification this user has for one app, in a
      // single round-trip. Mirrors the chat_message_id branch below —
      // returns the fresh unread count and fans out a cross-tab refresh
      // when something actually changed.
      if (appId != null) {
        const cleared = await notifications.markReadForApp(
          pool, req.user.id, Number(appId)
        );
        const unread = await notifications.countUnread(pool, req.user.id);
        if (cleared > 0) {
          try {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          } catch (err) {
            log.warn('notifications', 'cross-tab push failed', { message: err.message });
          }
        }
        return res.json({ unread, cleared });
      }

      // `{ chat_message_id }` is the in-chat "click a dotted message" path:
      // clear the user's unread mention/reply/reaction notification(s) for
      // that one message. Falls through to the existing single-id / all
      // behavior otherwise.
      if (chatMessageId != null) {
        const cleared = await notifications.markReadForMessage(
          pool, req.user.id, Number(chatMessageId)
        );
        const unread = await notifications.countUnread(pool, req.user.id);
        // Sync this user's other tabs (bell badge + the same message's dot
        // in another open chat tab) only when something actually changed.
        if (cleared > 0) {
          try {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          } catch (err) {
            log.warn('notifications', 'cross-tab push failed', { message: err.message });
          }
        }
        return res.json({ unread, cleared });
      }

      // Single-id / mark-all path. Mark-all (#449) previously skipped the
      // `notifications_changed` fan-out every other clearing branch does,
      // so the clicking tab's in-chat unread dots and the user's other
      // open tabs/devices kept showing unread state until a full reload —
      // making "Mark all read" look like it did nothing. Fan out exactly
      // like the branches above whenever something actually changed.
      const cleared = await notifications.markRead(pool, req.user.id, {
        id, all: !!all, kinds: kindList, excludeKinds: excludeList,
      });
      const unread = await notifications.countUnread(pool, req.user.id);
      if (cleared > 0) {
        try {
          const { pushNotificationToUser } = require('../services/ws');
          pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
        } catch (err) {
          log.warn('notifications', 'cross-tab push failed', { message: err.message });
        }
      }
      res.json({ unread, cleared });
    } catch (err) {
      log.error('notifications', 'markRead failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  notificationsRoutes, stagingMockNotifications, stagingMockSavedMessages,
};
