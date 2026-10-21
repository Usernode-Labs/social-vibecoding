'use strict';

// WP-E: the email that stands in for a push somebody cannot get.
//
// Four moments only: something they asked Homeroom bot for is ready to try
// (`build_ready`; for a project's first version, its going live instead, the
// moment its maker was promised: homeroom-bot-dm.js sendDm), the first
// of a day's news about the people their invite link brought
// (`invite_activity`, services/invite-activity.js), a project they joined
// while it was made opening (`project_opened`, services/project-opened.js),
// and the day's changes waiting on their vote (`votes_owed`,
// services/vote-digest.js). Each is a moment the notification ask promises
// "Until then, we'll email you" for (frontend/src/features/notify-ask/
// decide.ts EMAILED_MOMENTS). Sent only when ALL of these hold:
//   - they have no phone that could take the push (no live registration,
//     the same test schema.sql enqueue_mobile_push_deliveries makes). A
//     phone with the category switched off is a choice, not a gap: no mail.
//   - their email is confirmed;
//   - they have not turned these emails off (users.activity_email, which the
//     unsubscribe link in every one of them clears; routes/activity-mail.js).
// Activity mail has its own hourly budget (mail/rate-limit.js), so a busy
// hour of it can never use up the one sign-in codes need.
//
// Each one is owed by the transaction that decides it and sent as work: a
// build's by the bot-dm machine (`dm.mail`, appended with the message that
// rang), an invite's day by the invite-activity clock (its row's
// `mailed_at`). So it throws when it cannot decide, and its work tries again;
// sent after the commit instead, a restart in between lost it for good.

const crypto = require('crypto');
const { PRODUCTION_ORIGIN } = require('./cli-auth-constants');

const KINDS = Object.freeze(['build_ready', 'invite_activity', 'project_opened', 'votes_owed']);

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

/**
 * Where the mail's button goes: for a build, the request's thread in the
 * bot's chat (its root), or the message it rang for, or the chat; else the
 * project.
 */
function openUrl({ appSlug, conversationId = null, threadRootId = null, messageId = null }) {
  const valid = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0;
  if (valid(conversationId)) {
    if (valid(threadRootId)) return `${origin()}/#messages/${Number(conversationId)}/thread/${Number(threadRootId)}`;
    if (valid(messageId)) return `${origin()}/#messages/${Number(conversationId)}/m/${Number(messageId)}`;
    return `${origin()}/#messages/${Number(conversationId)}`;
  }
  return appSlug ? `${origin()}/app/${encodeURIComponent(appSlug)}` : origin();
}

// "One story": the notification a "ready to try" rang as, for the words and
// the thread: the one the message that rang made (`messageId`), else the
// newest build_ready row of theirs in the bot's chat. Null when there is
// none.
async function readyRow(pool, { userId, conversationId, messageId = null }) {
  if (!Number.isSafeInteger(Number(conversationId)) || Number(conversationId) <= 0) return null;
  const { rows } = await pool.query(
    `SELECT n.detail, n.conversation_message_id, m.thread_root_id
       FROM notifications n
       LEFT JOIN conversation_messages m ON m.id = n.conversation_message_id
      WHERE n.user_id = $1 AND n.conversation_id = $2 AND n.kind = 'build_ready'
      ORDER BY n.conversation_message_id IS NOT DISTINCT FROM $3::int DESC, n.id DESC LIMIT 1`,
    [userId, Number(conversationId), Number(messageId) > 0 ? Number(messageId) : null],
  );
  return rows[0] || null;
}

/**
 * Send `kind` to `userId` when a push cannot reach them (see the top of this
 * file). Resolves 'sent' (the mailer has it and keeps its own record), or why
 * not; throws when it cannot tell. A `build_ready` is worded as its push is
 * (homeroom-bot-notify-copy.js botEmailCopy), from `detail` when given, else
 * from the notification it rang as.
 */
async function emailIfNoPush(pool, {
  userId, kind, appName = null, appSlug = null, line = null, conversationId = null, notWorking = false,
  detail = null, threadRootId = null, messageId: rangFor = null, count = null, hashRoute = null,
}) {
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
  let words = null;
  let root = threadRootId;
  let messageId = null;
  if (kind === 'build_ready') {
    const row = await readyRow(pool, { userId, conversationId, messageId: rangFor });
    const copy = require('./homeroom-bot-notify-copy');
    const said = detail || row?.detail || null;
    words = said ? copy.botEmailCopy(said) : null;
    root = root || copy.parseBotDetail(said)?.threadRootId || row?.thread_root_id || null;
    // The message that rang, when the sender said which (a first
    // version's live is not the newest build_ready row's message).
    messageId = rangFor || row?.conversation_message_id || null;
  }
  const mail = require('./mail');
  await mail.send(config, {
    kind,
    to: user.email,
    appName: appName || 'Your project',
    line,
    ...(count != null ? { count } : {}),
    ...(notWorking ? { notWorking: true } : {}),
    ...(words ? { subject: words.subject, lead: words.lead } : {}),
    // `hashRoute`: a shell screen of no one project (the vote digest's
    // Needs you), as `#communities`.
    url: typeof hashRoute === 'string' && /^#[a-z][a-z0-9/_-]*$/.test(hashRoute)
      ? `${origin()}/${hashRoute}`
      : openUrl({ appSlug, conversationId, threadRootId: root, messageId }),
    unsubscribeUrl: unsubscribe,
  });
  return 'sent';
}

// ── Emails owed by a notice ─────────────────────────────────────────────
//
// A notice that rang somebody (an invite moment's day's first, a project
// they joined opening, the vote digest) owes this email in its own insert:
// `notifications.mailed_at` NULL. The notice-mail clock
// (src/workflow/clock/services.ts) sends each as a target of its own
// (noticeMailTargets), whose item sends it once and marks it handled
// (mailNotice). Past a day it is not news any more, and is not sent. Each was
// a call after the notice's commit, which a restart lost.

const NOTICE_MAIL_KINDS = new Set(['member_joined', 'first_message', 'project_opened', 'vote_digest']);
const NOTICE_MAIL_WITHIN_HOURS = 24;

async function noticeMailTargets(pool, { limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM notifications
      WHERE mailed_at IS NULL AND kind = ANY($1::text[])
        AND created_at > NOW() - make_interval(hours => $2::int)
      ORDER BY id LIMIT $3`,
    [[...NOTICE_MAIL_KINDS], NOTICE_MAIL_WITHIN_HOURS, limit],
  );
  return { owed: rows.length, items: rows.map((r) => ({ target: `notification:${r.id}`, input: { notificationId: r.id } })) };
}

// The email a notice stands for, from the notice: its kind, words and link.
function noticeEmail(row) {
  const app = { appName: row.app_name || null, appSlug: row.app_slug || null };
  if (row.kind === 'first_message') return { kind: 'invite_activity', ...app, line: `@${row.username} said hi in ${row.app_name}.` };
  if (row.kind === 'member_joined') {
    return { kind: 'invite_activity', ...app, line: `${row.username ? `@${row.username}` : 'Someone'} joined ${row.app_name} through your invite.` };
  }
  if (row.kind === 'project_opened') return { kind: 'project_opened', ...app };
  // The vote digest: how many wait on them; several open Needs you, which
  // lists them all (no one project).
  const count = Number(row.detail) || null;
  return { kind: 'votes_owed', count, ...(row.app_slug ? app : { hashRoute: '#communities' }) };
}

/**
 * Send notice `notificationId`'s email when no phone could take its push,
 * then mark it handled. `steps` (the item's, kernel/steps.ts) keeps the send
 * to once across tries; a send cut off before it was kept may be sent again.
 * Resolves what was said, or why nothing was sent.
 */
async function mailNotice(pool, notificationId, steps) {
  const { rows: [row] } = await pool.query(
    `SELECT n.id, n.user_id, n.kind, n.detail, n.mailed_at, n.created_at > NOW() - make_interval(hours => $2::int) AS recent,
            a.slug AS app_slug, a.name AS app_name, u.username
       FROM notifications n
       LEFT JOIN apps a ON a.id = n.app_id
       LEFT JOIN users u ON u.id = n.source_user_id
      WHERE n.id = $1`,
    [notificationId, NOTICE_MAIL_WITHIN_HOURS],
  );
  if (!row || row.mailed_at || !NOTICE_MAIL_KINDS.has(row.kind)) return { said: 'settled' };
  const said = !row.recent ? 'stale'
    : await steps.once('sent', () => module.exports.emailIfNoPush(pool, { userId: row.user_id, ...noticeEmail(row) }));
  await pool.query('UPDATE notifications SET mailed_at = NOW() WHERE id = $1 AND mailed_at IS NULL', [row.id]);
  return { said };
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
  NOTICE_MAIL_KINDS,
  noticeMailTargets,
  mailNotice,
  turnOff,
};
