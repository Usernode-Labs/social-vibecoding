'use strict';

// #6228: what the bot is doing with a person's reply on a request, as a
// thread can say it live. It reads the records that already exist (the
// request's newest run and queue row, the bot voice's turns, the bot's own
// messages) and answers one of three states:
//
//   will_read   the bot will read the reply in a moment (the read started or
//               is queued, or the reply is new enough that its refresh sees it)
//   reading     a read of the reply is under way
//   quiet       the bot was spoken to, read the reply, and had nothing to add
//
// Nothing here decides anything: the turn and the look read the same records
// they always did, and this only says out loud where they stand. It never
// throws: it is called from message handling and from the bot's own turn on
// best-effort paths.

const log = require('./logger');

const QUIET_MS = 60 * 1000;

const ms = (value) => {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Pure (#6228): the status a request's thread shows for one reply, or null
 * when there is nothing to say.
 *
 *   stage      stageOf's answer for the request ({ stage, reply, waiting })
 *   replyId    the newest person's reply on the request
 *   replyAt    when that reply was written
 *   botAfter   whether the bot posted in the thread after that reply
 *   voice      the place's newest voice turns, newest first
 *   voiceOwed  whether the bot would answer that reply (gate)
 *   now        the clock
 */
function statusOf({ stage = null, replyId = null, replyAt = null, botAfter = false, voice = [], voiceOwed = false, now = new Date() }) {
  const id = Number(replyId);
  if (!Number.isInteger(id) || id <= 0) return null;
  // The answer is there: nothing left to say about the reply.
  if (botAfter) return null;
  const turns = Array.isArray(voice) ? voice : [];
  const replyTime = ms(replyAt);
  // A turn running since the reply: the bot is reading it now.
  const running = turns.find((t) => !t.finished_at && (replyTime == null || (ms(t.started_at) ?? 0) >= replyTime));
  const reading = !!(stage && stage.stage === 'reading' && stage.reply === true && stage.waiting !== true);
  if (running || reading) return 'reading';
  // The read is queued (or about to be): the bot will read it in a moment.
  const waiting = !!(stage && stage.stage === 'reading' && stage.reply === true && stage.waiting === true);
  if (waiting || voiceOwed) return 'will_read';
  // The newest finished turn read the reply and chose not to answer, having
  // been spoken to (speaker_id), in the last minute.
  const last = turns.find((t) => t.finished_at);
  const nowMs = ms(now) ?? Date.now();
  if (last && last.outcome === 'quiet' && Number(last.speaker_id) > 0
    && Number(last.through_message_id) >= id
    && nowMs - (ms(last.finished_at) ?? 0) <= QUIET_MS) {
    return 'quiet';
  }
  return null;
}

/** Latest two voice turns of a request's place, newest first. */
async function voiceTurns(pool, placeKeyValue) {
  const { rows } = await pool.query(
    `SELECT started_at, finished_at, outcome, speaker_id, through_message_id
       FROM homeroom_bot_voice_turns
      WHERE place_key = $1
      ORDER BY id DESC LIMIT 2`,
    [placeKeyValue],
  );
  return rows;
}

/**
 * Read where the bot stands on one request's newest reply: `{ status,
 * replyId, authorId }`. `status` is statusOf's, or null.
 */
async function readStatus(pool, { appId, issueNumber, now = new Date() }) {
  const id = Number(appId);
  const number = Number(issueNumber);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(number) || number <= 0) {
    return { status: null, replyId: null, authorId: null };
  }
  const progress = require('./homeroom-bot-progress');
  const { REQUEST_ROWS_SQL } = require('./homeroom-bot-track');
  const { placeKey } = require('./homeroom-bot-voice');
  const { rows } = await pool.query(REQUEST_ROWS_SQL, [id, [number]]);
  const row = rows[0];
  if (!row) return { status: null, replyId: null, authorId: null };
  const replyId = row.reply_id == null ? null : Number(row.reply_id);
  if (!replyId) return { status: null, replyId: null, authorId: null };
  const stage = progress.stageOf(row, { now });
  const [turns, after] = await Promise.all([
    voiceTurns(pool, placeKey(id, { type: 'issue', ref: number })),
    pool.query(
      `SELECT 1 FROM chat_messages m JOIN users u ON u.id = m.user_id
        WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
          AND m.id > $3 AND m.deleted_at IS NULL AND u.is_synthetic = TRUE
        LIMIT 1`,
      [id, number, replyId],
    ),
  ]);
  return {
    status: statusOf({
      stage,
      replyId,
      replyAt: row.reply_at,
      botAfter: after.rows.length > 0,
      voice: turns,
      now,
    }),
    replyId,
    authorId: row.reply_user_id == null ? null : Number(row.reply_user_id),
  };
}

async function appRow(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, repo_url, created_by, self_hosted, community_id,
            collab_visibility, view_visibility, moderation_suspended_at
       FROM apps WHERE id = $1`,
    [Number(appId)],
  );
  return rows[0] || null;
}

async function personRow(pool, userId) {
  if (!userId) return null;
  const { rows } = await pool.query(
    `SELECT id, username, is_synthetic, has_platform_access, is_admin, private_member_since
       FROM users WHERE id = $1`,
    [Number(userId)],
  );
  const u = rows[0];
  if (!u) return null;
  return {
    id: Number(u.id),
    username: u.username,
    isSynthetic: !!u.is_synthetic,
    hasPlatformAccess: !!u.has_platform_access,
    isAdmin: !!u.is_admin,
    privateMember: !u.has_platform_access && !u.is_admin && u.private_member_since != null,
  };
}

/**
 * Whether the bot would answer `messageId` on the request (the voice's own
 * gate), which tells a "nothing to add" from a message nobody wrote to it.
 * A read or a gate failure counts as false.
 */
async function wouldAnswer(pool, { appId, issueNumber, messageId }) {
  try {
    const voice = require('./homeroom-bot-voice');
    const dm = require('./homeroom-bot-dm');
    const botSvc = require('./homeroom-bot');
    const place = { type: 'issue', ref: Number(issueNumber) };
    const { rows } = await pool.query(
      `SELECT m.id, m.user_id, m.content, m.msg_type, m.metadata, m.created_at, m.posted_via,
              m.thread_type, m.thread_ref, NULL::timestamptz AS deleted_at
         FROM chat_messages m WHERE m.id = $1 AND m.app_id = $2 AND m.deleted_at IS NULL`,
      [Number(messageId), Number(appId)],
    );
    const row = rows[0];
    if (!row) return false;
    const [app, bot, settings, speaker] = await Promise.all([
      appRow(pool, appId),
      dm.botAccount(pool),
      botSvc.readSettings(pool),
      personRow(pool, row.user_id),
    ]);
    if (!app || !bot) return false;
    const decided = await voice.gate(pool, { app, place, row, bot, settings, speaker });
    return decided.speak === true;
  } catch (err) {
    log.warn('homeroom-bot-reply-status', 'Could not tell whether the bot would answer', {
      appId, issueNumber, err: err.message,
    });
    return false;
  }
}

/**
 * Say where the bot stands on the request's newest reply: broadcast it to
 * the project's chat sockets and nudge the Homeroom bot page's lists for the
 * requester and the person who replied. Best-effort: a failure is logged,
 * never thrown.
 */
async function publish(pool, { appId, issueNumber, voiceOwed = false, deps = {} }) {
  const id = Number(appId);
  const number = Number(issueNumber);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(number) || number <= 0) return;
  try {
    const ws = deps.ws || require('./ws');
    const read = await readStatus(pool, { appId: id, issueNumber: number });
    // A reply the bot would answer, while no stage reads as waiting for it,
    // is still "will read": the refresh has not queued it yet.
    const status = read.status || (voiceOwed && read.replyId ? 'will_read' : null);
    ws.broadcast(id, {
      type: 'bot_status',
      thread: { type: 'issue', ref: number },
      status,
      authorId: read.authorId,
      replyId: read.replyId,
    });
    if (!read.replyId) return;
    const tray = deps.workChanged || require('./bot-work-changed');
    const dm = deps.dm || require('./homeroom-bot-dm');
    const people = new Set();
    try {
      const requester = await dm.requesterOf(pool, id, number);
      if (requester?.userId) people.add(Number(requester.userId));
      else if (requester?.id) people.add(Number(requester.id));
    } catch { /* the requester is not known: the reply's author still hears */ }
    if (read.authorId) people.add(Number(read.authorId));
    for (const userId of people) tray.noteWorkChanged(userId, { ws });
  } catch (err) {
    log.warn('homeroom-bot-reply-status', 'Could not publish the reply status', {
      appId, issueNumber, err: err.message,
    });
  }
}

module.exports = {
  QUIET_MS,
  statusOf,
  readStatus,
  wouldAnswer,
  publish,
};
