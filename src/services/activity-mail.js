'use strict';

// WP-E: the email that stands in for a push somebody cannot get.
//
// Two moments only: something they asked Homeroom bot for is ready to try
// (`build_ready`), and the first of a day's news about the people their
// invite link brought (`invite_activity`, services/invite-activity.js). Sent
// only when ALL of these hold:
//   - they have no phone that could take the push (no live registration,
//     the same test schema.sql enqueue_mobile_push_deliveries makes). A
//     phone with the category switched off is a choice, not a gap: no mail.
//   - their email is confirmed;
//   - they have not turned these emails off (users.activity_email, which the
//     unsubscribe link in every one of them clears; routes/activity-mail.js).
// Activity mail has its own hourly budget (mail/rate-limit.js), so a busy
// hour of it can never use up the one sign-in codes need.
//
// Never throws, and never waits on the send: the moment it rides on has
// already happened.

const crypto = require('crypto');
const log = require('./logger');
const { PRODUCTION_ORIGIN } = require('./cli-auth-constants');

const KINDS = Object.freeze(['build_ready', 'invite_activity']);

// The platform config, for the mail transport and the secret the
// unsubscribe links are signed with. server.js hands it over at boot; until
// then (and in a test that never does), nothing is sent.
let config = null;
function init(next) { config = next || null; }

function secret() {
  return (config && config.sessionSecret) || null;
}

/** The token in a person's unsubscribe link: theirs alone, and unguessable. */
function unsubscribeToken(userId, key = secret()) {
  if (!key || !Number.isInteger(Number(userId))) return null;
  return crypto.createHmac('sha256', key).update(`activity-mail:${Number(userId)}`).digest('base64url').slice(0, 32);
}

function tokenMatches(userId, token, key = secret()) {
  const want = unsubscribeToken(userId, key);
  if (!want || typeof token !== 'string' || token.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

function origin() {
  return PRODUCTION_ORIGIN;
}

function unsubscribeUrl(userId) {
  const token = unsubscribeToken(userId);
  return token ? `${origin()}/mail/unsubscribe?u=${Number(userId)}&t=${token}` : null;
}

/** Whether a push could reach `userId` on some phone right now. */
async function canPush(pool, userId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM mobile_push_registrations r
       JOIN mobile_push_deployment_state s ON s.environment = r.environment
      WHERE r.user_id = $1
        AND r.session_expires_at > NOW()
        AND r.permission_status IN ('authorized', 'provisional')
        AND s.send_enabled AND s.send_not_before IS NOT NULL
      LIMIT 1`,
    [userId],
  );
  return rows.length > 0;
}

/** Where the mail's button goes: the bot's chat for a build, else the project. */
function openUrl({ appSlug, conversationId = null }) {
  if (Number.isInteger(Number(conversationId)) && Number(conversationId) > 0) {
    return `${origin()}/#messages/${Number(conversationId)}`;
  }
  return appSlug ? `${origin()}/app/${encodeURIComponent(appSlug)}` : origin();
}

/**
 * Send `kind` to `userId` when a push cannot reach them (see the top of this
 * file). Resolves 'sent' (handed to the mailer, which keeps its own record),
 * or why not. Never throws.
 */
async function emailIfNoPush(pool, {
  userId, kind, appName = null, appSlug = null, line = null, conversationId = null, notWorking = false,
}) {
  try {
    if (!config || !KINDS.includes(kind) || !userId) return 'off';
    const unsubscribe = unsubscribeUrl(userId);
    if (!unsubscribe) return 'off';
    const { rows } = await pool.query(
      `SELECT email, email_confirmed, activity_email, is_synthetic FROM users WHERE id = $1`,
      [userId],
    );
    const user = rows[0];
    if (!user || user.is_synthetic || !user.email || !user.email_confirmed) return 'no_email';
    if (user.activity_email === false) return 'turned_off';
    if (await canPush(pool, userId)) return 'push';
    const mail = require('./mail');
    void mail.send(config, {
      kind,
      to: user.email,
      appName: appName || 'Your project',
      line,
      ...(notWorking ? { notWorking: true } : {}),
      url: openUrl({ appSlug, conversationId }),
      unsubscribeUrl: unsubscribe,
    });
    return 'sent';
  } catch (err) {
    log.warn('activity-mail', 'Could not decide on an activity email', { kind, userId, err: err.message });
    return 'failed';
  }
}

/** The unsubscribe link: turns these emails off for good. */
async function turnOff(pool, { userId, token }) {
  if (!tokenMatches(userId, token)) return false;
  const { rowCount } = await pool.query(
    'UPDATE users SET activity_email = FALSE WHERE id = $1',
    [Number(userId)],
  );
  return rowCount > 0;
}

module.exports = {
  KINDS,
  init,
  unsubscribeToken,
  tokenMatches,
  unsubscribeUrl,
  canPush,
  openUrl,
  emailIfNoPush,
  turnOff,
};
