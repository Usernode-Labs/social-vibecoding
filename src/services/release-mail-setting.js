'use strict';

/**
 * Two settings in Admin → Waitlist, each its own platform setting, read
 * through a short cache like the story landing's (services/first-session.js).
 *
 * Release email (#5971): whether admitting somebody from the waitlist sends
 * them the "You're in" email, stored as `waitlist_release_email`. Off, Admit,
 * Batch admit and a direct access grant still let the person in; only the
 * email is not sent. It covers the email alone: a phone row's "you're in" text
 * (services/waitlist.js sendReleaseText) and an admin's test release email
 * (services/test-accounts.js sendRelease) are unchanged. ON unless an admin
 * turns it off: no row, or a read that fails, is on, because a lost setting
 * must not silently stop every admission mail.
 *
 * Reminders: whether the waitlist-reminders clock emails people let in who
 * have not signed in (services/waitlist-reminders.js), stored as
 * `waitlist_reminder_email`, one of three modes:
 *   on       the clock sends them;
 *   dry_run  the clock sends nothing and logs how many are owed, and Admin →
 *            Waitlist lists who would get which reminder now: exactly what
 *            On would send;
 *   off      the clock sends nothing.
 * In every mode an admin's "Send a reminder now" on one row still sends. No
 * row, or a read that fails, is DRY RUN: the reminders start there, and an
 * admin turns them on once the list looks right; a lost setting sends
 * nothing. The two settings are independent of each other.
 */

const log = require('./logger');

const CACHE_MS = 10 * 1000;

const RELEASE_MAIL_KEY = 'waitlist_release_email';
const RELEASE_MAIL_DESCRIPTION = 'Whether admitting somebody from the waitlist sends them the '
  + '"You\'re in" email (services/release-mail-setting.js). Switched from Admin → Waitlist.';

const REMINDER_MAIL_KEY = 'waitlist_reminder_email';
const REMINDER_MAIL_DESCRIPTION = 'Whether people admitted from the waitlist who have not signed in '
  + 'get the two reminder emails: on, dry_run (none sent, the owed listed) or off '
  + '(services/waitlist-reminders.js). Set from Admin → Waitlist.';

// One stored setting: `parse` turns its stored value (null with no row) into
// the facts callers read, `fallback` is what a failed read answers.
function makeSetting(key, description, what, { parse, fallback, unreadable }) {
  const caches = new WeakMap();

  /** The stored setting: parse's facts, with { updatedAt, updatedBy }. Cached per pool. */
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
        ...parse(row ? row.value : null),
        updatedAt: row ? row.updated_at || null : null,
        updatedBy: row ? row.updated_by || null : null,
      };
      caches.set(pool, { at: Date.now(), setting });
      return setting;
    } catch (err) {
      log.warn('waitlist', `${what} setting read failed; ${unreadable}`, { err: err.message });
      return { ...fallback, updatedAt: null, updatedBy: null };
    }
  }

  /** Store `value` as admin `actorId`. */
  async function store(pool, { value, actorId = null }) {
    await pool.query(
      `INSERT INTO platform_settings (key, value, description, updated_at, updated_by)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, value, description, actorId]
    );
    caches.delete(pool);
  }

  return { read, store };
}

const release = makeSetting(RELEASE_MAIL_KEY, RELEASE_MAIL_DESCRIPTION, 'Release email', {
  parse: (value) => ({ enabled: value !== 'false' }),
  fallback: { enabled: true },
  unreadable: 'sending the email',
});

/** The reminders' modes, and the one with no row (and on a failed read). */
const REMINDER_MODES = Object.freeze(['off', 'dry_run', 'on']);
const REMINDER_DEFAULT_MODE = 'dry_run';
const reminderModeOf = (value) => (REMINDER_MODES.includes(value) ? value : REMINDER_DEFAULT_MODE);

const reminders = makeSetting(REMINDER_MAIL_KEY, REMINDER_MAIL_DESCRIPTION, 'Reminder email', {
  parse: (value) => {
    const mode = reminderModeOf(value);
    return { mode, enabled: mode === 'on' };
  },
  fallback: { mode: REMINDER_DEFAULT_MODE, enabled: false },
  unreadable: 'sending none (dry run)',
});

async function releaseMailEnabled(pool) {
  return (await release.read(pool)).enabled;
}

/** Switch the release email on or off as admin `actorId`. */
async function setReleaseMail(pool, { enabled, actorId = null }) {
  await release.store(pool, { value: enabled ? 'true' : 'false', actorId });
}

/** The reminders' mode: 'on', 'dry_run' or 'off'. */
async function reminderMode(pool) {
  return (await reminders.read(pool)).mode;
}

/** Whether the clock sends reminders: the mode is 'on'. */
async function reminderMailEnabled(pool) {
  return (await reminderMode(pool)) === 'on';
}

/** Set the reminders' mode as admin `actorId`. Throws on anything but the three modes. */
async function setReminderMail(pool, { mode, actorId = null }) {
  if (!REMINDER_MODES.includes(mode)) throw new TypeError(`Unknown reminders mode: ${mode}`);
  await reminders.store(pool, { value: mode, actorId });
}

module.exports = {
  RELEASE_MAIL_KEY,
  readReleaseMailSetting: release.read,
  releaseMailEnabled,
  setReleaseMail,
  REMINDER_MAIL_KEY,
  REMINDER_MODES,
  REMINDER_DEFAULT_MODE,
  readReminderMailSetting: reminders.read,
  reminderMode,
  reminderMailEnabled,
  setReminderMail,
};
