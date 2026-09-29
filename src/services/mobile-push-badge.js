'use strict';

// #2904: keep the iOS app-icon badge equal to the in-app unread count.
//
// iOS only changes the icon when a push carries `aps.badge` or when the app
// itself sets it. Alert pushes stamp the unread total at send time (#1445),
// and the WebView republishes the bell's count while it is running — but
// nothing lowered the icon when notifications were read somewhere the phone
// could not see: on the desktop site, in another tab, or by an auto-dismiss
// (a vote, a chat send, opening a session). The icon then sat on the last
// pushed number indefinitely while the bell said zero.
//
// Every read path already fans out `notifications_changed` to the user's
// sockets (see pushToUser in ./ws.js), so that is the hook: schedule a
// debounced sync for the user, recount with the same countUnread the bell
// and the alert payload use, and send a badge-only push to each of the
// user's live iOS registrations. Best-effort throughout — a sync failure
// is logged and dropped, never retried or surfaced; the next change or
// alert push carries the right number again.
//
// #3050: not every clear announced itself (a kudos retraction, leaving or
// being removed from a conversation, an un-reaction, cascades), and the app
// shell cannot set the icon itself, so the bell's first-page load
// (GET /api/notifications) schedules a sync too — opening Homeroom anywhere
// re-badges the phone to the number the bell is showing.

const { decrypt } = require('./secrets');
const { buildBadgeMessage } = require('./mobile-push-policy');
const { countUnread } = require('./notifications');
const log = require('./logger');

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_SEND_TIMEOUT_MS = 5000;

class MobilePushBadgeSync {
  constructor({ pool, config, provider, options = {} }) {
    this.pool = pool;
    this.config = config;
    this.provider = provider;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.timers = new Map();
  }

  // Coalesce a burst (mark-all, several tabs clearing at once) into one
  // push per user carrying the settled count.
  schedule(userId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    if (this.timers.has(id)) clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.syncUser(id).catch((err) => {
        log.warn('mobile-push', 'badge sync failed', {
          code: typeof err?.code === 'string' ? err.code : 'unknown',
        });
      });
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(id, timer);
    return true;
  }

  // Live iOS registrations for this deployment only — the same gates the
  // alert worker applies at send time (environment, Firebase project, the
  // sender being enabled, an unexpired native session, OS permission).
  async loadRegistrations(userId) {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.registration_enc
         FROM mobile_push_registrations r
         JOIN mobile_push_deployment_state state ON state.environment = r.environment
        WHERE r.user_id = $1
          AND r.environment = $2
          AND r.platform = 'ios'
          AND r.permission_status IN ('authorized', 'provisional')
          AND r.session_expires_at > NOW()
          AND state.firebase_project_id = $3
          AND state.send_enabled`,
      [userId, this.config.mobilePushEnvironment, this.config.firebaseProjectId]
    );
    return rows;
  }

  async syncUser(userId) {
    if (!this.provider) return 0;
    const registrations = await this.loadRegistrations(userId);
    if (!registrations.length) return 0;
    const unreadCount = await countUnread(this.pool, userId);
    let sent = 0;
    for (const row of registrations) {
      const token = decrypt(row.registration_enc, this.config.dataEncryptionKey);
      if (!token) continue;
      try {
        const message = buildBadgeMessage({ token, unreadCount });
        await this.sendWithDeadline(message);
        sent += 1;
      } catch (err) {
        log.warn('mobile-push', 'badge push failed', {
          code: typeof err?.code === 'string' ? err.code : 'unknown',
        });
      }
    }
    return sent;
  }

  sendWithDeadline(message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('Push provider deadline exceeded');
        err.code = 'provider_timeout';
        reject(err);
      }, this.sendTimeoutMs);
    });
    return Promise.race([
      Promise.resolve().then(() => this.provider.send(message)),
      timeout,
    ]).finally(() => clearTimeout(timer));
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

module.exports = { MobilePushBadgeSync, DEFAULT_DEBOUNCE_MS };
