'use strict';

// Homeroom bot's account notices, in the bell (14 Nov 2026).
//
// Three things the bot tells a person about their account, once a week each,
// were messages in Main Chat. Main Chat is gone, and a notice about the
// account belongs to no thread, so each is a bell row now:
//
//   allowance_low  "You're close to this week's building time."
//   allowance      "On hold until Monday: your building time for this week
//                  is used up." (with how many of their requests wait)
//   paused         "On hold until Monday: I've used my budget for this week."
//
// Each is a `build_stopped` notification with no chat message behind it, as
// a request's stage already rings one (services/work-state.js bellPushes;
// notifications.js STAGE_BELL_SQL lists such a row). Its words come from its
// detail (homeroom-bot-notify-copy.js: moment `on_hold`, said `low`,
// `allowance` or `paused`), so the bell, the phone's push and the "Your
// builds" push switch treat it as they treated the message's own
// notification. No email: it stands in for no "ready to try".
//
// Once a week: the (person, kind, week) row in `homeroom_bot_notices` is
// the once, written in the bell row's own transaction. A notice the bot
// already said in the chat this week, before this change, is not said again
// (`legacyKey`, that message's idempotency key).

const log = require('./logger');
const notifyCopy = require('./homeroom-bot-notify-copy');

const KINDS = Object.freeze(['allowance_low', 'allowance', 'paused']);

/** The week a notice is for: its Monday, in UTC, as YYYYMMDD (homeroom-bot-dm.js weekKey). */
function weekKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Pure: a notice's detail, the words its bell row and push are read from
 * (homeroom-bot-notify-copy.js botMomentCopy). `fields` are the story's:
 * appName, appSlug, issueNumber, requestTitle, firstVersion, count.
 */
function detailFor(kind, fields = {}) {
  const said = kind === 'allowance_low' ? 'low' : kind;
  return notifyCopy.botNotificationDetail({ ...fields, moment: 'on_hold', said });
}

// $1 the person, $2 the kind, $3 the week, $4 the bot, $5 the key the notice
// had as a chat message. Claims the week's one notice, unless it was said in
// their chat with the bot already this week.
const CLAIM_SQL = `
  INSERT INTO homeroom_bot_notices (user_id, kind, week)
  SELECT $1::int, $2::text, $3::text
   WHERE NOT EXISTS (
     SELECT 1 FROM conversation_direct_pairs d
       JOIN conversation_messages m ON m.conversation_id = d.conversation_id
      WHERE d.user_low_id = LEAST($1::int, $4::int) AND d.user_high_id = GREATEST($1::int, $4::int)
        AND m.sender_id = $4::int AND m.idempotency_key = $5::text)
  ON CONFLICT (user_id, kind, week) DO NOTHING
  RETURNING user_id`;

// The bell row. Never to somebody who blocked the bot, as a message of its
// own would not have reached them. `mailed_at` is set: no email is owed.
const RING_SQL = `
  INSERT INTO notifications (user_id, source_user_id, kind, detail, app_id, mailed_at)
  SELECT $1::int, $2::int, 'build_stopped', $3::text, $4::int, NOW()
   WHERE NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1::int AND b.blocked_user_id = $2::int)
  RETURNING id, user_id, source_user_id, kind, detail, app_id, created_at`;

/**
 * Ring one notice for `userId`, once this week. Resolves { notificationId }
 * when it rang now, { duplicate: true } when this week's was said already,
 * or null when there is nobody to tell (no bot, a person who blocked it).
 * Throws on a failure the caller may retry: nothing is half-written.
 */
async function ring(pool, { bot, userId, kind, fields = {}, appId = null, legacyKey = null, now = new Date(), deps = {} }) {
  if (!bot?.id || !userId || !KINDS.includes(kind)) return null;
  const detail = detailFor(kind, fields);
  if (!detail) return null;
  const client = await pool.connect();
  let row = null;
  try {
    await client.query('BEGIN');
    const { rows: claimed } = await client.query(CLAIM_SQL, [
      Number(userId), kind, weekKey(now), Number(bot.id), legacyKey || '',
    ]);
    if (!claimed.length) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }
    const { rows } = await client.query(RING_SQL, [Number(userId), Number(bot.id), detail, appId == null ? null : Number(appId)]);
    row = rows[0] || null;
    if (row) {
      await client.query(
        'UPDATE homeroom_bot_notices SET notification_id = $4 WHERE user_id = $1 AND kind = $2 AND week = $3',
        [Number(userId), kind, weekKey(now), Number(row.id)],
      );
    }
    // The week's claim stands even when nothing rang (they blocked the bot):
    // it is not asked again each time work of theirs comes up.
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!row) return null;
  try {
    await (deps.notifications || require('./notifications')).hydrateAndPush(pool, row);
  } catch (err) {
    // The row is in: an open tab catches up on its next read.
    log.warn('homeroom-bot-notices', 'Could not push a notice live', { userId, kind, err: err.message });
  }
  return { notificationId: Number(row.id), kind };
}

module.exports = { KINDS, weekKey, detailFor, ring };
