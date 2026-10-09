'use strict';

// #4530: the Homeroom bot stays quiet on a request nobody is talking to it.
//
// Every new word on a request is a look again (classifyIssue reasons it
// 'changed'), and every look repeated its conclusion: the same question, the
// same "a person needs to decide this one", the same "couldn't find anything
// to build". On a request where people are working something out among
// themselves that was noise, and it tagged them each time.
//
// Now a look that would only repeat one of those notes speaks again only
// when the words since the bot's last note were for the bot:
//
//   - a mention of @homeroom_bot, in the discussion or on the GitHub issue;
//   - a Reply (homeroom-bot-dm wording) to one of the bot's messages there;
//   - anything written after a question the bot asked, which is taken as
//     the answer to it.
//
// When none of those happened the bot still reads and records what was said
// (the run's thread_seen_at, set with the run), so it does not read the same
// conversation over and over; it just posts nothing, and relays nothing to
// the requester's DM. The first look always speaks, and a look that
// concludes the request is ready to build still acts as before: only the
// repeat notes are held back. Never throws: when the check cannot be made
// the bot speaks as it did before this existed.

const log = require('./logger');
const { mentionPattern } = require('./homeroom-bot-holds');

// The note verdicts the gate covers (homeroom-bot.js actOnVerdict). A ready
// verdict always acts, and 'looking' is the once-per-issue announcement.
const NOTE_KINDS = Object.freeze(['question', 'person', 'empty']);

const LAST_NOTE_SQL = `
  SELECT kind, created_at FROM homeroom_bot_posts
   WHERE app_id = $1 AND issue_number = $2 AND kind <> 'looking'
   ORDER BY created_at DESC, id DESC LIMIT 1`;

// What people have said on the request since the bot's last note, oldest
// first. The bot's own messages and every synthetic writer are left out, so
// its own note and its later posts cannot answer themselves. A Reply is
// stored as metadata.quote.refMsgId (ws.js quote handling), joined to the
// row it quotes; quotes_bot is true when that row is one of the bot's.
const MESSAGES_SQL = `
  SELECT m.id, m.content, m.created_at, (q.user_id = $4) AS quotes_bot
    FROM chat_messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN chat_messages q
      ON (m.metadata->'quote'->>'refMsgId') ~ '^[0-9]+$'
     AND q.id = (m.metadata->'quote'->>'refMsgId')::int
   WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
     AND m.msg_type = 'message' AND m.deleted_at IS NULL
     AND u.is_synthetic IS NOT TRUE AND m.user_id <> $4
     AND m.created_at > $3
   ORDER BY m.created_at, m.id`;

/**
 * Pure: does anything since the bot's last note speak to the bot?
 *
 *   { speak: true,  why: 'first_note' }    the bot never posted a note here
 *   { speak: true,  why: 'mention' }       somebody mentioned @homeroom_bot
 *   { speak: true,  why: 'reply' }         somebody replied to its message
 *   { speak: true,  why: 'answer' }        an answer to a question it asked
 *   { speak: false, why: 'not_addressed' } people talking among themselves
 *
 * `messages` are the discussion rows since the note ({ body, createdAt,
 * quotesBot }); `comments` the GitHub issue's ({ author, body, createdAt }),
 * with its own comments skipped. Only words after the note count.
 */
function addressed({ lastNote, messages = [], comments = [], botLogin = '' }) {
  if (!lastNote) return { speak: true, why: 'first_note' };
  const sinceMs = Date.parse(lastNote.created_at);
  const since = Number.isFinite(sinceMs) ? sinceMs : 0;
  const after = (at) => Number.isFinite(Date.parse(at)) && Date.parse(at) > since;
  const mention = new RegExp(mentionPattern(), 'i');
  // The bot's GitHub login, without its [bot] suffix: a mention of it counts
  // on the issue as well, where its platform handle means nothing.
  const base = String(botLogin || '').toLowerCase().replace(/\[bot\]$/, '').trim();
  const loginMention = base
    ? new RegExp(`(^|[^a-z0-9_])@${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_-]|$)`, 'i')
    : null;
  const asked = lastNote.kind === 'question';
  let answered = false;
  for (const msg of messages) {
    if (!after(msg.createdAt)) continue;
    if (mention.test(String(msg.body || ''))) return { speak: true, why: 'mention' };
    if (msg.quotesBot) return { speak: true, why: 'reply' };
    answered = true;
  }
  for (const comment of comments) {
    if (!after(comment?.createdAt)) continue;
    const author = String(comment?.author || '').toLowerCase().replace(/\[bot\]$/, '');
    if (base && author === base) continue;
    const body = String(comment?.body || '');
    if (mention.test(body) || (loginMention && loginMention.test(body))) return { speak: true, why: 'mention' };
    answered = true;
  }
  if (asked && answered) return { speak: true, why: 'answer' };
  return { speak: false, why: 'not_addressed' };
}

/** The bot's last note on a request and the words since it, for addressed(). Never throws on empty. */
async function loadAddressed(pool, { appId, issueNumber, botId }) {
  const note = await pool.query(LAST_NOTE_SQL, [appId, issueNumber]);
  const lastNote = note.rows[0] || null;
  if (!lastNote) return { lastNote: null, messages: [] };
  const { rows } = await pool.query(MESSAGES_SQL, [appId, issueNumber, lastNote.created_at, botId]);
  const messages = rows.map((row) => ({ body: row.content, createdAt: row.created_at, quotesBot: !!row.quotes_bot }));
  return { lastNote, messages };
}

/**
 * Combined: should the bot repeat its note on this request? The two queries
 * of loadAddressed, then addressed(). Never throws: a query that fails
 * speaks, keeping the behaviour this change found.
 */
async function shouldSpeak(pool, { appId, issueNumber, botId, comments = [], botLogin = '' }) {
  try {
    const { lastNote, messages } = await loadAddressed(pool, { appId, issueNumber, botId });
    return addressed({ lastNote, messages, comments, botLogin });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not check whether the request addressed the bot; speaking as before', {
      appId, issueNumber, err: err.message,
    });
    return { speak: true, why: 'unknown' };
  }
}

module.exports = {
  NOTE_KINDS,
  addressed,
  loadAddressed,
  shouldSpeak,
};
