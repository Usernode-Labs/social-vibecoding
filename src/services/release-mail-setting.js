'use strict';

/**
 * Two switches in Admin → Waitlist, each its own platform setting, read
 * through a short cache like the story landing's (services/first-session.js).
 * Each is ON unless an admin turns it off. No row, or a read that fails, is
 * the default: on, because a lost setting must not silently stop mail.
 *
 * Release email (#5971): whether admitting somebody from the waitlist sends
 * them the "You're in" email, stored as `waitlist_release_email`. Off, Admit,
 * Batch admit and a direct access grant still let the person in; only the
 * email is not sent. It covers the email alone: a phone row's "you're in" text
 * (services/waitlist.js sendReleaseText) and an admin's test release email
 * (services/test-accounts.js sendRelease) are unchanged.
 *
 * Reminders: whether the waitlist-reminders clock emails people let in who
 * have not signed in (services/waitlist-reminders.js), stored as
 * `waitlist_reminder_email`. Off, the clock sends nothing; an admin's "Send a
 * reminder now" on one row still sends. The two switches are independent:
 * either can be off with the other on.
 */

const log = require('./logger');

const CACHE_MS = 10 * 1000;

const RELEASE_MAIL_KEY = 'waitlist_release_email';
const RELEASE_MAIL_DESCRIPTION = 'Whether admitting somebody from the waitlist sends them the '
  + '"You\'re in" email (services/release-mail-setting.js). Switched from Admin → Waitlist.';

const REMINDER_MAIL_KEY = 'waitlist_reminder_email';
const REMINDER_MAIL_DESCRIPTION = 'Whether people admitted from the waitlist who have not signed in '
  + 'get the two reminder emails (services/waitlist-reminders.js). Switched from Admin → Waitlist.';

function makeSwitch(key, description, what) {
  const caches = new WeakMap();

  /** The stored switch: { enabled, updatedAt, updatedBy }. Cached per pool; on when unset or unreadable. */
  async function read(pool) {
    const cached = caches.get(pool);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.setting;
    try {
      const { rows } = await pool.query(
        `SELECT s.value, s.updated_at, u.username AS updated_by
           FROM platform_settings s
           LEFT JOIN users u ON u.id = s.updated_by
          WHERE s.key = $1`,
        [key]
      );
      const row = rows[0];
      const setting = {
        enabled: row ? row.value !== 'false' : true,
        updatedAt: row ? row.updated_at || null : null,
        updatedBy: row ? row.updated_by || null : null,
      };
      caches.set(pool, { at: Date.now(), setting });
      return setting;
    } catch (err) {
      log.warn('waitlist', `${what} setting read failed; sending the email`, { err: err.message });
      return { enabled: true, updatedAt: null, updatedBy: null };
    }
  }

  /** Switch it on or off as admin `actorId`. */
  async function set(pool, { enabled, actorId = null }) {
    await pool.query(
      `INSERT INTO platform_settings (key, value, description, updated_at, updated_by)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, enabled ? 'true' : 'false', description, actorId]
    );
    caches.delete(pool);
  }

  return { read, enabled: async (pool) => (await read(pool)).enabled, set };
}

const release = makeSwitch(RELEASE_MAIL_KEY, RELEASE_MAIL_DESCRIPTION, 'Release email');
const reminders = makeSwitch(REMINDER_MAIL_KEY, REMINDER_MAIL_DESCRIPTION, 'Reminder email');

module.exports = {
  RELEASE_MAIL_KEY,
  readReleaseMailSetting: release.read,
  releaseMailEnabled: release.enabled,
  setReleaseMail: release.set,
  REMINDER_MAIL_KEY,
  readReminderMailSetting: reminders.read,
  reminderMailEnabled: reminders.enabled,
  setReminderMail: reminders.set,
};
