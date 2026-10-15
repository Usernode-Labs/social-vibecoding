'use strict';
// The daily security bot's own account (#4678), modelled on homeroom-bot.js's
// ensureBotUser: a synthetic `security_bot` user that nobody can sign in as
// (routes/auth.js skips synthetic accounts before comparing a password, and
// the stored password is a random value that is hashed and thrown away), with
// no admin bit, no app-creation right and finite spend limits of its own.
//
// Unlike ensureBotUser this module never provisions an OpenRouter key and
// never makes a model call: issuing the bot's key is a separate, explicit
// operator step. Nothing calls ensureSecurityBotUser at startup; a status
// read uses findSecurityBotUser, which only reads.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('../logger');

const USERNAME = 'security_bot';
const DISPLAY_NAME = 'Security bot';
// The service's own caps, in cents: the spec's $5 a day and $35 a week.
const DAILY_LIMIT_CENTS = 500;
const WEEKLY_LIMIT_CENTS = 3500;

const COLUMNS = 'id, username, is_synthetic, is_admin, can_create_apps, daily_limit_cents, weekly_limit_cents';

class SecurityBotIdentityError extends Error {
  constructor(message) {
    super(message);
    this.code = 'security_bot_name_taken';
  }
}

/**
 * Every account wearing the name, case-insensitively (usernames are unique
 * regardless of case, so this is at most one row in practice).
 */
async function rowsForName(pool) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM users WHERE LOWER(username) = LOWER($1) ORDER BY id`,
    [USERNAME],
  );
  return rows;
}

function assertAdoptable(rows) {
  const other = rows.find((r) => r.username !== USERNAME || r.is_synthetic !== true);
  if (other) {
    // A person registered the name first. Never adopt a real account.
    throw new SecurityBotIdentityError(
      `Configuration error: the username '${other.username}' belongs to an account that is not the synthetic security bot. `
      + 'Rename that account or remove it before the security bot can run.',
    );
  }
}

/**
 * The security bot's account, or null when it has not been created. Reads
 * only: safe for a status view. Throws SecurityBotIdentityError when the name
 * belongs to a real account.
 */
async function findSecurityBotUser(pool) {
  const rows = await rowsForName(pool);
  assertAdoptable(rows);
  return rows[0] || null;
}

/**
 * Create the security bot's account, or find it. Idempotent. Answers the
 * account row. Throws SecurityBotIdentityError when the name belongs to a
 * real account. An existing bot row that somehow gained the admin bit or the
 * app-creation right, or lost its limits, is put back.
 */
async function ensureSecurityBotUser(pool) {
  let bot = await findSecurityBotUser(pool);
  if (!bot) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      `INSERT INTO users (username, password, display_name, is_admin, can_create_apps, is_synthetic,
                          daily_limit_cents, weekly_limit_cents)
       VALUES ($1, $2, $3, FALSE, FALSE, TRUE, $4, $5)
       ON CONFLICT (username) DO NOTHING`,
      [USERNAME, hash, DISPLAY_NAME, DAILY_LIMIT_CENTS, WEEKLY_LIMIT_CENTS],
    );
    // A concurrent caller may have won the insert; re-read and re-check.
    bot = await findSecurityBotUser(pool);
    if (!bot) throw new Error(`Could not create the ${USERNAME} user`);
    log.info('security-bot', 'Security bot user created', { userId: bot.id });
  }
  if (bot.is_admin || bot.can_create_apps || bot.daily_limit_cents == null || bot.weekly_limit_cents == null) {
    const { rows } = await pool.query(
      `UPDATE users
          SET is_admin = FALSE,
              can_create_apps = FALSE,
              daily_limit_cents = COALESCE(daily_limit_cents, $2),
              weekly_limit_cents = COALESCE(weekly_limit_cents, $3)
        WHERE id = $1 AND is_synthetic = TRUE
        RETURNING ${COLUMNS}`,
      [bot.id, DAILY_LIMIT_CENTS, WEEKLY_LIMIT_CENTS],
    );
    log.warn('security-bot', 'Security bot user rights reset', { userId: bot.id });
    bot = rows[0] || bot;
  }
  return bot;
}

module.exports = {
  USERNAME, DISPLAY_NAME, DAILY_LIMIT_CENTS, WEEKLY_LIMIT_CENTS,
  SecurityBotIdentityError, findSecurityBotUser, ensureSecurityBotUser,
};
