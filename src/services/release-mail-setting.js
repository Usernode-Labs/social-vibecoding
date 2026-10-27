'use strict';

/**
 * Whether admitting somebody from the waitlist sends them the "You're in"
 * email (#5971). Admin → Waitlist's Release email switch.
 *
 * ON unless an admin turns it off, stored as the `waitlist_release_email`
 * platform setting and read through a short cache like the story landing's
 * (services/first-session.js). No row, or a read that fails, is the default:
 * on, because a lost setting must not silently stop every admission mail.
 *
 * Off, Admit, Batch admit and a direct access grant still let the person in;
 * only the email is not sent. It covers the email alone: a phone row's
 * "you're in" text (services/waitlist.js sendReleaseText) and an admin's
 * test release email (services/test-accounts.js sendRelease) are unchanged.
 */

const log = require('./logger');

const RELEASE_MAIL_KEY = 'waitlist_release_email';
const CACHE_MS = 10 * 1000;
const RELEASE_MAIL_DESCRIPTION = 'Whether admitting somebody from the waitlist sends them the '
  + '"You\'re in" email (services/release-mail-setting.js). Switched from Admin → Waitlist.';
const caches = new WeakMap();

/** The stored switch: { enabled, updatedAt, updatedBy }. Cached per pool; on when unset or unreadable. */
async function readReleaseMailSetting(pool) {
  const cached = caches.get(pool);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.setting;
  try {
    const { rows } = await pool.query(
      `SELECT s.value, s.updated_at, u.username AS updated_by
         FROM platform_settings s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.key = $1`,
      [RELEASE_MAIL_KEY]
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
    log.warn('waitlist', 'Release email setting read failed; sending the email', { err: err.message });
    return { enabled: true, updatedAt: null, updatedBy: null };
  }
}

async function releaseMailEnabled(pool) {
  return (await readReleaseMailSetting(pool)).enabled;
}

/** Switch the release email on or off as admin `actorId`. */
async function setReleaseMail(pool, { enabled, actorId = null }) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, description, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [RELEASE_MAIL_KEY, enabled ? 'true' : 'false', RELEASE_MAIL_DESCRIPTION, actorId]
  );
  caches.delete(pool);
}

module.exports = {
  RELEASE_MAIL_KEY,
  readReleaseMailSetting,
  releaseMailEnabled,
  setReleaseMail,
};
