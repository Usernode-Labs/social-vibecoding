'use strict';

// Homeroom bot, one model, step 4 (11 Nov 2026, docs/plans/bot-one-model.md,
// decision 6 as Evan amended it): ONE posting function for every word the
// bot says to people, and words once shown never change.
//
// A post is keyed by what it is, `kind:subject:version`:
//
//   build_failed:request:3-12:run-40     a build's failure on request 12 of
//                                        project 3, in run 40
//   checks_retry:change:6564:look-3      a note on change 6564's checks, in
//                                        the third look at it
//   reply:place:3:issue:12:turn-<key>    the voice's answer for one turn
//
// and that key is claimed in bot_posts before anything is sent (claim). A
// post asked for twice (a retry, a restart, two passes at once) is said
// once: the second ask finds the row and says nothing. A post a restart
// caught going out is `pending`, and the retry sends only what its row has
// not recorded. This replaced six ways of saying once (homeroom_bot_posts'
// pending take-up, a look's once for posts, runPosted, the voice's turn mark
// read back, and the two failure rewrites).
//
// The place decides what may be said there (RULES, one table): in a
// request's thread only its question or plan, "built it, up for a vote", a
// failure note, "live", and answers when spoken to. Anything else is
// recorded as `refused` and is never a message there. A change's thread,
// a chat, a reply thread and a person's chat with the bot hear what the bot
// says to them.
//
// Failure notes are never edited. A new failure is a new note, said only
// when its words differ from the place's last failure note, or somebody has
// written there since it, or the bot said something else there since; a
// repeat says nothing at all (outcome `repeat`: the status card already
// shows it), and a newer failure note retires the older one's buttons
// (bot-cards.js retireFor).
//
// The message itself is written with its record: ws.sendBotMessage's and
// sendSystemMessage's `onInsert` name the message on the post's row in the
// message's own transaction, and a person's chat with the bot is recorded
// by homeroom-bot-dm.js sendDm (its DM transport) the same way. A request's
// posts are projected into homeroom_bot_posts once said, for the readers of
// that table (the standing's `said`, the notes `addressed` reads).

const crypto = require('node:crypto');
const log = require('./logger');

// ── The rules: what the bot says where ───────────────────────────────────

/**
 * THE table: for each kind of place, the kinds of post the bot says there,
 * by family. A kind no family lists is refused there, unless the place
 * hears anything (`others`). `failure` is the family the failure rule reads.
 */
const RULES = Object.freeze({
  // A request's thread (decision 6).
  issue: Object.freeze({
    families: Object.freeze({
      // Its question to the requester (an overlap asks them one too).
      question: Object.freeze(['question', 'person', 'empty', 'overlap']),
      // Its plan; and, as a build starts, how it builds it beside or on top
      // of another open change that shares its files (#6423, #6428).
      plan: Object.freeze(['plan', 'spec', 'overlap_stack', 'overlap_parallel']),
      // Built it, up for a vote (a person's change saying it does this
      // request is that too).
      proposal: Object.freeze(['proposal', 'change_claim']),
      failure: Object.freeze(['build_failed', 'followup_failed', 'followup_person', 'blocked']),
      live: Object.freeze(['live']),
      // Answers when spoken to: the voice's replies, the answer to a mention
      // on a request a person holds, a reply turn's "on it", what a "tell me
      // when" owed, a newer plan someone posted taken up, the voice's
      // pointer from another request.
      answer: Object.freeze(['reply', 'going_ahead', 'held_by_person', 'followup_working', 'followup_told', 'newer_plan',
        'overlap_link']),
      // Homeroom's line naming what a person did there.
      line: Object.freeze(['close_proposed', 'moved', 'copied']),
    }),
    others: false,
  }),
  // A change's own thread: every note about the change. Its notes on its
  // checks are failure notes: said again only when they say something new.
  session: Object.freeze({
    families: Object.freeze({
      plan: Object.freeze(['spec']),
      failure: Object.freeze(['followup_failed', 'followup_person', 'checks_synced', 'checks_not_change', 'checks_fixing',
        'checks_revise', 'checks_retry']),
    }),
    others: true,
  }),
  chat: Object.freeze({ families: Object.freeze({}), others: true }),
  category: Object.freeze({ families: Object.freeze({}), others: true }),
  message: Object.freeze({ families: Object.freeze({}), others: true }),
  governance: Object.freeze({ families: Object.freeze({}), others: true }),
  // A person's chat with the bot. Request news is refused there, by
  // homeroom-bot-dm.js sendDm (conversations.js isRequestNewsMeta).
  dm: Object.freeze({ families: Object.freeze({}), others: true }),
});

// The families that are notes: a second of the same kind on a request is a
// note said twice (duplicateNotes). Answers are not: people ask again.
const NOTE_FAMILIES = Object.freeze(['question', 'plan', 'proposal', 'failure', 'live']);

/** Pure: the family `kind` is in at a place of `placeType`, 'other' where anything goes, or null (refused). */
function familyOf(placeType, kind) {
  const rule = RULES[String(placeType || '')];
  if (!rule) return null;
  for (const [family, kinds] of Object.entries(rule.families)) if (kinds.includes(String(kind || ''))) return family;
  return rule.others ? 'other' : null;
}

/** Pure: whether the bot says a post of `kind` at a place of `placeType`. */
function allowed(placeType, kind) {
  return familyOf(placeType, kind) != null;
}

/** Pure: whether `kind` is a failure note at a place of `placeType` (the failure rule's). */
function isFailure(placeType, kind) {
  return familyOf(placeType, kind) === 'failure';
}

/** Pure: every kind that is a note somewhere, for duplicateNotes. */
function noteKinds() {
  const out = new Set();
  for (const rule of Object.values(RULES)) {
    for (const family of NOTE_FAMILIES) for (const kind of rule.families[family] || []) out.add(kind);
  }
  return [...out].sort();
}

// ── Keys ─────────────────────────────────────────────────────────────────

const positive = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** Pure: a request's subject. */
function requestSubject(appId, issueNumber) {
  return `request:${Number(appId)}-${Number(issueNumber)}`;
}

/** Pure: a change's subject. */
function changeSubject(sessionId) {
  return `change:${Number(sessionId)}`;
}

/** Pure: a place's subject (a thread, a chat). */
function placeSubject(appId, place) {
  return `place:${Number(appId) || 0}:${place?.type || 'none'}:${place?.ref ?? 0}`;
}

/** Pure: the said-once key of a post. */
function keyOf({ kind, subject, version }) {
  return `${String(kind)}:${String(subject)}:${String(version)}`;
}

/** A version no other post has: for a post that is never asked for twice. */
function freshVersion() {
  return `x-${crypto.randomUUID()}`;
}

// ── Words ────────────────────────────────────────────────────────────────

/** Pure: a note's words, without the people it tags at its start, spaces folded. */
function wordsOf(text) {
  return String(text || '')
    .replace(/^(?:@[A-Za-z0-9_.-]+\s+)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pure: the digest of a note's words (wordsOf), or null for none. */
function digestOf(text) {
  const words = wordsOf(text);
  return words ? crypto.createHash('sha256').update(words).digest('hex').slice(0, 32) : null;
}

// ── The record ───────────────────────────────────────────────────────────

const CLAIM_SQL = `
  INSERT INTO bot_posts (said_key, kind, subject, version, place_type, app_id, place_ref, issue_number, session_id,
                         run_id, words_digest)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (said_key) DO UPDATE SET asked = bot_posts.asked + 1
  RETURNING id, outcome, (xmax = 0) AS fresh, chat_message_id, conversation_message_id, github_comment_id,
            github_created_at, request_post_id, created_at`;

const MARK_SQL = `
  UPDATE bot_posts
     SET chat_message_id = COALESCE($2, chat_message_id),
         conversation_message_id = COALESCE($3, conversation_message_id),
         github_comment_id = COALESCE($4, github_comment_id),
         github_created_at = COALESCE($5, github_created_at)
   WHERE id = $1`;

const SETTLE_SQL = `
  UPDATE bot_posts
     SET outcome = $2, why = $3, request_post_id = COALESCE($4, request_post_id),
         said_at = CASE WHEN $2 = 'said' THEN COALESCE(said_at, NOW()) ELSE said_at END
   WHERE id = $1`;

// What a place's bot said last as a note (NOTE_FAMILIES' kinds), still
// shown: the failure rule's "the last failure note", when it is one.
const LAST_NOTE_SQL = `
  SELECT p.id, p.kind, p.chat_message_id, p.words_digest
    FROM bot_posts p
    JOIN chat_messages m ON m.id = p.chat_message_id AND m.deleted_at IS NULL
   WHERE p.app_id = $1 AND p.place_type = $2 AND p.place_ref = $3 AND p.outcome = 'said'
     AND p.kind = ANY($4::text[]) AND p.id <> $5
   ORDER BY p.id DESC LIMIT 1`;

// Whether anybody but the bot has written in the thread since `messageId`.
const REPLIED_SINCE_SQL = `
  SELECT 1 FROM chat_messages r
   WHERE r.app_id = $1 AND r.id > $2 AND r.deleted_at IS NULL
     AND r.thread_type = $3 AND r.thread_ref = $4
     AND r.user_id IS NOT NULL AND ($5::int IS NULL OR r.user_id <> $5::int)
   LIMIT 1`;

const PROJECT_SQL = `
  INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind, github_comment_id, thread_message_id)
  VALUES ($1, $2, $3, $4, $5, $6)
  RETURNING id`;

const PROJECT_AGAIN_SQL = `
  UPDATE homeroom_bot_posts
     SET github_comment_id = COALESCE($2, github_comment_id), thread_message_id = COALESCE($3, thread_message_id),
         pending = NULL
   WHERE id = $1`;

const SAID_SQL = `
  SELECT id, outcome, chat_message_id, conversation_message_id, github_comment_id, github_created_at
    FROM bot_posts WHERE said_key = $1`;

/**
 * Claim a post's key. Resolves { id, fresh, row }: `fresh` for a key asked
 * for the first time, else `row` is what the first ask recorded (its
 * outcome, its message, its GitHub comment). With nothing recorded (a
 * database that answered no row) it is fresh and unrecorded (`id` null).
 * `strict` (a durable caller, which retries): a failed claim throws, so the
 * retry claims it; otherwise it is said unrecorded, as before keys.
 */
async function claim(db, spec, { strict = false } = {}) {
  const place = spec.place || {};
  try {
    const { rows: [row] = [] } = await db.query(CLAIM_SQL, [
      spec.key, String(spec.kind), String(spec.subject), String(spec.version), String(place.type || 'none'),
      positive(spec.appId), place.ref == null || !Number.isFinite(Number(place.ref)) ? null : Number(place.ref),
      positive(spec.issueNumber), positive(spec.sessionId), positive(spec.runId), spec.digest || null,
    ]);
    if (!row) return { id: null, fresh: true, row: null };
    return { id: Number(row.id), fresh: row.fresh === true || row.fresh === 't', row };
  } catch (err) {
    if (strict) throw err;
    log.warn('bot-post', 'Could not claim a post\'s key (saying it unrecorded)', { key: spec.key, err: err.message });
    return { id: null, fresh: true, row: null };
  }
}

/** Record what of a post has gone out (its message, its GitHub comment), as it goes. */
async function mark(db, id, { chatMessageId = null, conversationMessageId = null, githubCommentId = null, githubCreatedAt = null } = {}) {
  if (!id) return;
  await db.query(MARK_SQL, [id, positive(chatMessageId), positive(conversationMessageId), githubCommentId ?? null, githubCreatedAt || null])
    .catch((err) => log.warn('bot-post', 'Could not record what a post sent', { id, err: err.message }));
}

/** Settle a post: said, refused (with why) or a repeat. */
async function settle(db, id, outcome, { why = null, requestPostId = null, strict = false } = {}) {
  if (!id) return;
  try {
    await db.query(SETTLE_SQL, [id, outcome, why, positive(requestPostId)]);
  } catch (err) {
    if (strict) throw err;
    log.warn('bot-post', 'Could not settle a post', { id, outcome, err: err.message });
  }
}

/** The post a key names, or null: what it said and where. */
async function saidFor(db, key) {
  try {
    const { rows: [row] = [] } = await db.query(SAID_SQL, [key]);
    return row || null;
  } catch {
    return null;
  }
}

/**
 * The request's projection (homeroom_bot_posts), once a post about it is
 * said or recorded: a row its readers know, or the row a post from before
 * keys left pending, finished. Resolves its id, or null.
 */
async function project(db, { requestPostId = null, appId, issueNumber, runId = null, kind, githubCommentId = null, threadMessageId = null }, { strict = false } = {}) {
  if (!positive(appId) || !positive(issueNumber)) return null;
  try {
    if (positive(requestPostId)) {
      await db.query(PROJECT_AGAIN_SQL, [positive(requestPostId), githubCommentId ?? null, positive(threadMessageId)]);
      return positive(requestPostId);
    }
    const { rows: [row] = [] } = await db.query(PROJECT_SQL, [
      positive(appId), positive(issueNumber), positive(runId), String(kind), githubCommentId ?? null, positive(threadMessageId),
    ]);
    return row ? Number(row.id) : null;
  } catch (err) {
    if (strict) throw err;
    log.warn('bot-post', 'Could not record a request\'s post', { appId, issueNumber, kind, err: err.message });
    return null;
  }
}

// ── The failure rule ─────────────────────────────────────────────────────

/**
 * Whether a failure note at `place` says nothing new: the bot's last note
 * there is a failure note with the same words (`digest`), and nobody has
 * written there since it. Resolves { repeat, last }: `last` is that older
 * note ({ id, chat_message_id }) whenever the bot's last note there is a
 * failure note, so a new one can retire its buttons. A failed read is not a
 * repeat: the note is said.
 */
async function failureRepeats(db, { appId, place, digest, botId = null, postId = null }) {
  try {
    const { rows: [last] = [] } = await db.query(LAST_NOTE_SQL, [
      positive(appId), String(place.type), Number(place.ref), noteKinds(), positive(postId) || 0,
    ]);
    if (!last || !isFailure(place.type, last.kind)) return { repeat: false, last: null };
    if (!digest || last.words_digest !== digest) return { repeat: false, last };
    const { rows: replied } = await db.query(REPLIED_SINCE_SQL, [
      positive(appId), Number(last.chat_message_id), String(place.type), Number(place.ref), positive(botId),
    ]);
    return { repeat: replied.length === 0, last };
  } catch (err) {
    log.warn('bot-post', 'Could not read the place\'s last failure note (saying it)', { appId, place, err: err.message });
    return { repeat: false, last: null };
  }
}

/**
 * A newer note's card supersedes older open cards of its kind about the
 * same item, and the older failure note's buttons go (`messageIds`), in
 * place: bot-cards.js retireFor, its pushes published at once. Never throws.
 */
async function retireOlder(db, { appId, issueNumber = null, sessionId = null, cardId = null, messageIds = [] } = {}) {
  const keep = positive(cardId) ? [positive(cardId)] : null;
  const older = (messageIds || []).map(positive).filter(Boolean);
  if (!keep && !older.length) return;
  try {
    const cards = require('./bot-cards');
    const pushes = await cards.retireFor(db, {
      appId, issueNumber: positive(issueNumber), sessionId: positive(issueNumber) ? null : positive(sessionId),
      keep, messageIds: older,
    });
    await require('./work-state').publish(db, pushes);
  } catch (err) {
    log.warn('bot-post', 'Could not retire an older note\'s buttons', { appId, issueNumber, err: err.message });
  }
}

// ── The posting function ─────────────────────────────────────────────────

/**
 * Say one post. `spec`:
 *   place      { type, ref }: the thread it is said in ('issue', 'session',
 *              'message', 'chat', 'category', 'governance'), or { type: 'dm',
 *              userId } for a person's chat with the bot;
 *   appId, kind, words (the message, as shown), author (the bot's user; a
 *              post with none is Homeroom's own line), msgType, metadata,
 *              card (bot-cards.js: written with the message), attachments;
 *   subject, version (the key's: version left out says it fresh), or key;
 *   issueNumber, sessionId, runId: what it is about (a request's post is
 *              projected into homeroom_bot_posts once said);
 *   mentions   usernames whose bell it rings (never parsed from the words);
 *   strict     a durable caller's: what could not be done throws.
 * `deps`: { ws, notifications, dm }.
 *
 * Resolves { outcome, id, messageId, cardId, createdAt, again }: `said`,
 * `refused` (the place's rules), `repeat` (the failure rule) or `again`
 * (the key was said, or refused, before: nothing is said). Throws only when
 * `strict`.
 */
async function post(db, spec, deps = {}) {
  const place = spec.place || {};
  const kind = String(spec.kind || 'note');
  const subject = spec.subject || (positive(spec.issueNumber) && positive(spec.appId)
    ? requestSubject(spec.appId, spec.issueNumber)
    : positive(spec.sessionId) ? changeSubject(spec.sessionId) : placeSubject(spec.appId, place));
  const version = spec.version == null || spec.version === '' ? freshVersion() : String(spec.version);
  const key = spec.key || keyOf({ kind, subject, version });
  const words = String(spec.words || '').trim();
  const digest = digestOf(words);
  const strict = !!spec.strict;
  if (place.type === 'dm') return postDm(db, { ...spec, kind, key, words }, deps);
  const thread = place.type && place.ref != null ? { type: String(place.type), ref: Number(place.ref) } : null;
  if (!thread || !words || !positive(spec.appId)) return { outcome: 'refused', id: null, messageId: null, why: 'nothing_to_say' };
  const claimed = await claim(db, { ...spec, key, kind, subject, version, digest, place: thread }, { strict });
  const had = claimed.fresh ? null : claimed.row;
  if (had && had.outcome !== 'pending') {
    return {
      outcome: 'again', again: true, id: claimed.id, was: had.outcome,
      messageId: positive(had.chat_message_id), githubCreatedAt: had.github_created_at || null,
    };
  }
  const projectIt = (messageId) => project(db, {
    requestPostId: had?.request_post_id, appId: spec.appId, issueNumber: spec.issueNumber, runId: spec.runId, kind,
    threadMessageId: messageId,
  }, { strict });
  // The place's rules: anything else is recorded, never a message there.
  if (!allowed(thread.type, kind)) {
    const requestPostId = spec.record === false ? null : await projectIt(null);
    await settle(db, claimed.id, 'refused', { why: 'not_in_place', requestPostId, strict });
    log.info('bot-post', 'Not said: the place does not have the bot say that', { appId: spec.appId, place: thread, kind });
    return { outcome: 'refused', id: claimed.id, messageId: null, why: 'not_in_place' };
  }
  // Taken up after a restart: its message went out already.
  if (positive(had?.chat_message_id)) {
    const requestPostId = spec.record === false ? null : await projectIt(positive(had.chat_message_id));
    await settle(db, claimed.id, 'said', { requestPostId, strict });
    return { outcome: 'said', id: claimed.id, messageId: positive(had.chat_message_id), again: true };
  }
  // The failure rule: the same words again, with nobody writing since,
  // say nothing; anything new is a new note, and the older one's buttons go.
  let olderFailure = null;
  if (isFailure(thread.type, kind)) {
    const judged = await failureRepeats(db, {
      appId: spec.appId, place: thread, digest, botId: spec.author?.id ?? null, postId: claimed.id,
    });
    if (judged.repeat) {
      await settle(db, claimed.id, 'repeat', { why: 'same_words', strict });
      log.info('bot-post', 'A failure note not said again: the last one says the same and nobody wrote since', {
        appId: spec.appId, place: thread, kind, last: Number(judged.last.chat_message_id),
      });
      return { outcome: 'repeat', id: claimed.id, messageId: positive(judged.last.chat_message_id), repeated: true };
    }
    olderFailure = judged.last;
  }
  const ws = deps.ws || require('./ws');
  const onInsert = claimed.id
    ? (tx, { messageId }) => tx.query('UPDATE bot_posts SET chat_message_id = $2 WHERE id = $1', [claimed.id, messageId])
    : null;
  let sent = null;
  try {
    sent = spec.author
      ? await ws.sendBotMessage(db, Number(spec.appId), {
        user: spec.author, content: words, metadata: spec.metadata || null, thread, msgType: spec.msgType || 'message',
        ...(Array.isArray(spec.attachments) && spec.attachments.length ? { attachmentIds: spec.attachments } : {}),
        ...(spec.card ? { card: spec.card } : {}),
        ...(onInsert ? { onInsert } : {}),
      })
      : await ws.sendSystemMessage(db, Number(spec.appId), words, spec.msgType || 'system', spec.metadata || null, thread,
        onInsert ? { onInsert } : {});
  } catch (err) {
    if (strict) throw err;
    log.warn('bot-post', 'Could not say a post', { appId: spec.appId, place: thread, kind, err: err.message });
    return { outcome: 'failed', id: claimed.id, messageId: null, error: err.message };
  }
  const messageId = positive(sent?.id);
  if (!messageId) {
    if (strict) throw new Error(`Could not say the ${kind} post in its thread`);
    return { outcome: 'failed', id: claimed.id, messageId: null };
  }
  await mark(db, claimed.id, { chatMessageId: messageId });
  // A newer failure note supersedes the older one: its card the older
  // cards of its kind about the same item, and the older note's buttons
  // whatever they were. A question beside another (two overlaps, each with
  // its own other request) supersedes nothing.
  const cardId = positive(sent.cardId);
  if (isFailure(thread.type, kind) && (cardId || olderFailure)) {
    await retireOlder(db, {
      appId: spec.appId, issueNumber: spec.issueNumber, sessionId: spec.sessionId, cardId,
      messageIds: olderFailure ? [olderFailure.chat_message_id] : [],
    });
  }
  const mentions = [...new Set((spec.mentions || []).filter(Boolean).map(String))];
  if (mentions.length) {
    try {
      const notify = deps.notifications || require('./notifications');
      const rows = await notify.createMentionNotifications(db, {
        appId: Number(spec.appId), chatMessageId: messageId, senderId: spec.author?.id ?? null,
        content: mentions.map((n) => `@${n}`).join(' '),
      });
      await Promise.all((rows || []).map((row) => notify.hydrateAndPush(db, row)));
    } catch (err) {
      log.warn('bot-post', 'Could not ring the people a post tags (post kept)', { appId: spec.appId, kind, err: err.message });
    }
  }
  const requestPostId = spec.record === false ? null : await projectIt(messageId);
  await settle(db, claimed.id, 'said', { requestPostId, strict });
  return {
    outcome: 'said', id: claimed.id, messageId, createdAt: sent.createdAt || null, message: sent,
    ...(cardId ? { cardId } : {}),
  };
}

/**
 * A post in a person's chat with the bot: homeroom-bot-dm.js sendDm, its
 * DM transport, which keys and records it in the message's transaction
 * (recordDm). The key is its idempotency key.
 */
async function postDm(db, spec, deps = {}) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const sent = await dm.sendDm(db, {
    bot: spec.author, userId: spec.place.userId, content: spec.words, metadata: spec.metadata || null,
    idempotencyKey: spec.key, ...(spec.card ? { card: spec.card } : {}), postKind: spec.kind,
  });
  if (!sent?.messageId) return { outcome: 'refused', id: null, messageId: null, why: 'not_sent' };
  return {
    outcome: sent.duplicate ? 'again' : 'said', again: !!sent.duplicate, id: null,
    messageId: Number(sent.messageId), conversationId: sent.conversationId,
    ...(sent.cardId ? { cardId: sent.cardId } : {}),
  };
}

const RECORD_DM_SQL = `
  INSERT INTO bot_posts (said_key, kind, subject, version, place_type, place_ref, app_id, issue_number,
                         conversation_message_id, words_digest, outcome, said_at)
  VALUES ($1, $2, $3, $4, 'dm', $5, $6, $7, $8, $9, $10, CASE WHEN $10 = 'said' THEN NOW() END)
  ON CONFLICT (said_key) DO UPDATE SET asked = bot_posts.asked + 1,
    conversation_message_id = COALESCE(bot_posts.conversation_message_id, EXCLUDED.conversation_message_id)`;

/**
 * Record a message in a person's chat with the bot (homeroom-bot-dm.js
 * sendDm), in its transaction when `db` is the message's: keyed by its
 * idempotency key in that conversation (or its message), `refused` for
 * request news the chat does not hear. Never throws.
 */
async function recordDm(db, { userId, conversationId = null, kind = 'dm', key = null, messageId = null, words = '', appId = null, issueNumber = null, outcome = 'said' }) {
  const subject = `dm:${Number(userId) || 0}`;
  const version = key ? `key-${key}` : positive(messageId) ? `msg-${positive(messageId)}` : freshVersion();
  try {
    await db.query(RECORD_DM_SQL, [
      keyOf({ kind, subject, version }), String(kind), subject, version, positive(conversationId),
      positive(appId), positive(issueNumber), positive(messageId), digestOf(words), outcome,
    ]);
  } catch (err) {
    log.warn('bot-post', 'Could not record a message in a chat with the bot', { userId, kind, err: err.message });
  }
}

// ── The admin's count ────────────────────────────────────────────────────

// Notes the bot was asked to say about one request more than once: for
// each request and kind of note, every post past the first (said, or not
// said again as a repeat), and every ask for a key already said.
const DUPLICATE_NOTES_SQL = `
  SELECT COALESCE(SUM(GREATEST(t.n - 1, 0)), 0)::int AS duplicates
    FROM (
      SELECT p.app_id, p.issue_number, p.kind,
             COUNT(*) + SUM(p.asked - 1) AS n
        FROM bot_posts p
       WHERE p.issue_number IS NOT NULL AND p.created_at >= $1 AND p.kind = ANY($2::text[])
         AND p.place_type IN ('issue', 'session') AND p.outcome IN ('said', 'repeat')
       GROUP BY p.app_id, p.issue_number, p.kind
    ) t`;

/**
 * How many of the bot's notes on requests since `since` (a Date or ISO
 * string) were said twice or asked for twice: within a request, the posts
 * of one kind past its first (repeats the failure rule dropped and newer
 * notes said), and the asks for a key already said. For the admin's
 * re-read numbers (homeroom-bot-health.js). Resolves a number, or null when
 * it cannot be counted.
 */
async function duplicateNotes(pool, { since } = {}) {
  const from = since instanceof Date ? since : new Date(since || Date.now() - 7 * 86400 * 1000);
  if (!Number.isFinite(from.getTime())) return null;
  try {
    const { rows: [row] = [] } = await pool.query(DUPLICATE_NOTES_SQL, [from.toISOString(), noteKinds()]);
    return row ? Number(row.duplicates) || 0 : 0;
  } catch (err) {
    log.warn('bot-post', 'Could not count notes said twice', { err: err.message });
    return null;
  }
}

module.exports = {
  RULES,
  NOTE_FAMILIES,
  familyOf,
  allowed,
  isFailure,
  noteKinds,
  requestSubject,
  changeSubject,
  placeSubject,
  keyOf,
  freshVersion,
  wordsOf,
  digestOf,
  claim,
  mark,
  settle,
  saidFor,
  project,
  failureRepeats,
  retireOlder,
  post,
  recordDm,
  duplicateNotes,
};
