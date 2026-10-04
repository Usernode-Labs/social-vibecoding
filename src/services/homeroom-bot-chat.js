'use strict';

// B9: mention Homeroom bot in a project's group chat.
//
// A member writes "@Homeroom bot could it remind us on Sundays?" in the
// project's chat (or picks "Make this a request" on a message of their own).
// The message stays theirs, word for word, and the bot never writes a line
// into the chat. Instead:
//
//   - a quick read (llm.readChatAsk) decides whether it asks for a change.
//     A change is filed at once as a request in their words, through the
//     same path a request offered in the bot's chat is (mayor.fileRequest);
//     a question or a chat is pointed at the bot's own chat; when it could
//     be either, they are asked first. "Make this a request" skips the read:
//     the person chose;
//   - how it is going rides on the message itself, as metadata everybody in
//     the room sees (`botRequest: { issueNumber, status }`, a
//     `bot_request_status` frame): reading, building, ready (Try it), live.
//     When the work stops, the chip goes for everybody else, and the
//     requester's own card and their chat with the bot say what happened;
//   - the requester alone gets a card under their message ("Only you can see
//     this"), pushed to their own sockets and read back from
//     chat_bot_requests (GET /api/apps/:slug/my-bot-requests), never from
//     chat_messages, so no reader of the room can see it.
//
// Only a message a person typed, in the room's main stream, and never an
// edit or a message a connector posted (E7). Membership is the room's own
// gate (communities.chatNeedsJoin). The socket has no rate limit, so filings
// are capped per person by a count.
//
// WP-C: somebody NEW to a project (joined in the last two weeks, nothing
// asked for there yet) need not know to mention the bot. When a message of
// theirs reads as an idea for the app, their card offers to suggest it to the
// group ("Suggest it" / "Not now"); Suggest it files it as a request in their
// name, like any other, whether or not the bot is theirs. At most two offers
// per person per project, never on a message a few words long, and the reads
// behind them are budgeted per person and per hour. The first request
// somebody files says, once, that it stays on the project with their name.

const log = require('./logger');

// "@homeroom_bot" and the display form "@Homeroom bot" are both the bot.
const BOT_MENTION_RE = /(^|[^\w])@(homeroom_bot\b|homeroom\s+bot\b)/i;
const BOT_MENTION_ALL_RE = /(^|[^\w])@(?:homeroom_bot\b|homeroom\s+bot\b)[,:]?\s*/gi;
// Filings one person may make from chats in an hour.
const FILINGS_PER_HOUR = 10;
const MAX_TITLE = 120;

// WP-C: the newcomer's offer.
const OFFER_WITHIN_DAYS = 14;
const OFFERS_PER_PROJECT = 2;
const OFFER_MIN_WORDS = 4;
// The reads an offer costs: per person per day, and for everybody per hour.
const OFFER_READS_PER_DAY = 6;
const OFFER_READS_PER_HOUR = 120;
const offerReads = { people: new Map(), hour: { at: 0, n: 0 } };

/**
 * Pure (on the counters above): take one offer read for `userId` at `now`,
 * or false when their day's or everybody's hour's are spent.
 */
function takeOfferRead(userId, now = Date.now(), budget = offerReads) {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  if (now - budget.hour.at >= HOUR) budget.hour = { at: now, n: 0 };
  let mine = budget.people.get(userId);
  if (!mine || now - mine.at >= DAY) mine = { at: now, n: 0 };
  if (budget.hour.n >= OFFER_READS_PER_HOUR || mine.n >= OFFER_READS_PER_DAY) return false;
  budget.hour.n += 1;
  mine.n += 1;
  budget.people.set(userId, mine);
  if (budget.people.size > 5000) budget.people.delete(budget.people.keys().next().value);
  return true;
}

// What the chip on a message can say. `stopped` takes the chip away.
const STATUSES = new Set(['reading', 'building', 'ready', 'live']);

function dmModule(deps) { return deps.dm || require('./homeroom-bot-dm'); }
function botModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function liveModule(deps) { return deps.liveSvc || require('./homeroom-bot-live'); }
function mayorModule(deps) { return deps.mayor || require('./homeroom-bot-mayor'); }
function wsModule(deps) { return deps.ws || require('./ws'); }

/** Pure: whether a message mentions Homeroom bot. */
function mentionsBot(text) {
  return BOT_MENTION_RE.test(String(text || ''));
}

/** Pure: a message's words without the mention, which is what was asked. */
function askedWords(text) {
  return String(text || '').replace(BOT_MENTION_ALL_RE, '$1').replace(/\s+/g, ' ').trim();
}

/** Pure: a request's title when the read gave none: its first sentence, trimmed. */
function fallbackTitle(words) {
  const first = String(words || '').split(/(?<=[.!?])\s/)[0].replace(/[?.!]+$/, '').trim();
  const text = first || 'A request from the chat';
  const capped = text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/**
 * Whether Homeroom bot answers `user` on `app`: { builds } (whether it
 * builds on the project, else a request is filed for the group), or null
 * when it is not on for them. Never throws.
 */
async function botFor(pool, { app, user, settings = null, deps = {} }) {
  try {
    if (!app?.id || !user?.id || user.isSynthetic) return null;
    const s = settings || await botModule(deps).readSettings(pool);
    if (!dmModule(deps).hasBot(s, user)) return null;
    return { builds: !!liveModule(deps).isLiveFor(s, app), settings: s };
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not read whether Homeroom bot answers here', { app: app?.slug, err: err.message });
    return null;
  }
}

/**
 * WP-C: whether `user` is new to `app` and has asked for nothing there yet,
 * so a message of theirs that reads as an idea is offered as a request:
 * { builds, settings } for filing it (builds only when the bot is theirs and
 * builds here), or null. Never throws.
 */
async function newcomerHere(pool, { app, user, deps = {} }) {
  try {
    if (!app?.id || !user?.id || user.isSynthetic) return null;
    if (!await isNewcomer(pool, app.id, user.id)) return null;
    return await filingFor(pool, { app, user, deps });
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not read whether somebody is new here', { app: app?.slug, err: err.message });
    return null;
  }
}

/** WP-C: the one query behind newcomerHere, cheap enough for every message. */
async function isNewcomer(pool, appId, userId) {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM chat_bot_requests r WHERE r.app_id = a.id AND r.requester_id = $2) AS asked,
            EXISTS (SELECT 1 FROM issues i WHERE i.app_id = a.id AND i.created_by = $2) AS requested
       FROM apps a
       JOIN community_members m ON m.community_id = a.community_id AND m.user_id = $2
      WHERE a.id = $1 AND a.created_by IS DISTINCT FROM $2
        AND m.joined_at > NOW() - make_interval(days => $3::int)`,
    [appId, userId, OFFER_WITHIN_DAYS],
  );
  const row = rows[0];
  return !!row && !row.requested && row.asked < OFFERS_PER_PROJECT;
}

/**
 * How a request of `user`'s on `app` is filed when they took an offer: as
 * the bot's own when the bot is theirs (botFor), else for the group.
 */
async function filingFor(pool, { app, user, deps = {} }) {
  const here = await botFor(pool, { app, user, deps });
  if (here) return here;
  const settings = await botModule(deps).readSettings(pool);
  return { builds: false, settings };
}

/** The card under a request's message, for its requester alone. Pure. */
function cardOf(row, { builds = true, typicalMinutes = null, first = false } = {}) {
  return {
    messageId: Number(row.chat_message_id),
    kind: row.kind,
    title: row.title || null,
    issueNumber: row.issue_number == null ? null : Number(row.issue_number),
    ...(row.kind === 'filed' && Number.isFinite(typicalMinutes) ? { typicalMinutes } : {}),
    ...(builds === false && row.kind === 'filed' ? { kind: 'group' } : {}),
    // WP-C: their first request on the project, which says it stays.
    ...(first && row.issue_number != null ? { first: true } : {}),
  };
}

/** WP-C: the number of `user`'s first request on `appId`, or null. */
async function firstRequestOf(pool, appId, userId) {
  const { rows } = await pool.query(
    'SELECT MIN(github_issue_number)::int AS n FROM issues WHERE app_id = $1 AND created_by = $2',
    [appId, userId],
  );
  return rows[0]?.n ?? null;
}

/** Send a requester their card, on every tab they have open. */
function pushCard(userId, appSlug, card, deps = {}) {
  try {
    wsModule(deps).pushToUser(userId, { type: 'bot_request_card', appSlug, card });
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not push a chat request card', { userId, err: err.message });
  }
}

/**
 * Set the chip on a request's message for everybody in its room
 * (`status`: reading, building, ready, live; anything else takes it away).
 * The status survives an edit (the edit path keeps metadata). Never throws.
 */
async function setStatus(pool, { appId, messageId, issueNumber, status, sessionId = null, deps = {} }) {
  try {
    const value = STATUSES.has(status)
      ? { issueNumber: Number(issueNumber), status, ...(sessionId ? { sessionId: Number(sessionId) } : {}) }
      : null;
    const { rows } = await pool.query(
      `UPDATE chat_messages
          SET metadata = CASE WHEN $3::jsonb IS NULL THEN COALESCE(metadata, '{}'::jsonb) - 'botRequest'
                              ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('botRequest', $3::jsonb) END
        WHERE id = $1 AND app_id = $2
        RETURNING id`,
      [messageId, appId, value ? JSON.stringify(value) : null],
    );
    if (!rows.length) return false;
    wsModule(deps).broadcast(Number(appId), { type: 'bot_request_status', messageId: Number(messageId), botRequest: value });
    return true;
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not set a chat request\'s status', { appId, messageId, err: err.message });
    return false;
  }
}

/**
 * B4's moments, on the message a request was asked in: its request moved
 * to `status` (reading when the bot starts on it, building, ready with its
 * change, live; `stopped` takes the chip away). Called by the bot wherever
 * those moments happen; a request not asked in a chat is nothing here.
 * Never throws.
 */
async function noteRequestStatus(pool, { appId, issueNumber, status, sessionId = null, deps = {} }) {
  try {
    const { rows } = await pool.query(
      `SELECT chat_message_id FROM chat_bot_requests
        WHERE app_id = $1 AND issue_number = $2 AND kind = 'filed'`,
      [appId, issueNumber],
    );
    for (const row of rows) {
      await setStatus(pool, { appId, messageId: row.chat_message_id, issueNumber, status, sessionId, deps });
    }
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not move a chat request\'s status', { appId, issueNumber, status, err: err.message });
    return 0;
  }
}

/**
 * Record what came of one message, once: the first word on a message wins,
 * and an edit or a second mention files nothing more. Resolves the row as
 * it stands.
 */
async function record(pool, { messageId, appId, userId, kind, issueNumber = null, title = null, replace = false }) {
  const params = [messageId, appId, userId, kind, issueNumber, title ? String(title).slice(0, 300) : null];
  const { rows } = replace
    ? await pool.query(
      `INSERT INTO chat_bot_requests (chat_message_id, app_id, requester_id, kind, issue_number, title)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (chat_message_id) DO UPDATE
         SET kind = EXCLUDED.kind, issue_number = EXCLUDED.issue_number, title = EXCLUDED.title, updated_at = NOW()
       RETURNING *`,
      params,
    )
    : await pool.query(
      `INSERT INTO chat_bot_requests (chat_message_id, app_id, requester_id, kind, issue_number, title)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (chat_message_id) DO NOTHING
       RETURNING *`,
      params,
    );
  return rows[0] || null;
}

/** How many requests this person filed from chats in the last hour. */
async function filedLately(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chat_bot_requests
      WHERE requester_id = $1 AND issue_number IS NOT NULL AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId],
  );
  return rows[0]?.n || 0;
}

/**
 * File one message as a request in its writer's words: the issue, its card
 * in their chat with the bot (whose See progress the chat card opens), and
 * the chip on the message. Resolves the card.
 */
async function fileMessage(pool, config, { app, user, messageId, words, title, here, deps = {} }) {
  const mayor = mayorModule(deps);
  const filed = await mayor.fileRequest(pool, config, {
    user, app, title, details: words, settings: here.settings, deps, askedText: words,
    footer: `Asked in ${app.name || app.slug}'s chat by @${user.username}.`, reason: 'chat_request',
  });
  const row = await record(pool, {
    messageId, appId: app.id, userId: user.id, kind: here.builds ? 'filed' : 'group',
    issueNumber: filed.issueNumber, title, replace: true,
  });
  if (here.builds) {
    await setStatus(pool, { appId: app.id, messageId, issueNumber: filed.issueNumber, status: 'reading', deps });
    if (filed.queueId) {
      const bot = await dmModule(deps).botAccount(pool);
      if (bot) {
        await require('./homeroom-bot-activity').startCard(pool, {
          app, issueNumber: filed.issueNumber, bot, jobKey: filed.queueId, settings: here.settings, filed: true,
          requester: {
            userId: user.id, username: user.username, issueTitle: title, firstVersion: false, askedText: words,
            isSynthetic: !!user.isSynthetic, hasPlatformAccess: !!user.hasPlatformAccess, isAdmin: !!user.isAdmin,
          },
          deps: { dm: dmModule(deps) },
        });
      }
    }
  }
  const typicalMinutes = here.builds ? await dmModule(deps).typicalMinutes(pool).catch(() => null) : null;
  const first = await firstRequestOf(pool, app.id, user.id).catch(() => null);
  log.info('homeroom-bot-chat', 'Filed a request asked for in a project\'s chat', {
    app: app.slug, issueNumber: filed.issueNumber, userId: user.id, builds: here.builds,
  });
  return cardOf(row, { builds: here.builds, typicalMinutes, first: first === Number(filed.issueNumber) });
}

/**
 * One message asked Homeroom bot for something: decide what it is (unless
 * `chosen`, the person picked "Make this a request" or File it) and act.
 * Resolves { ok, card } or { ok: false, status, error, code }.
 */
async function askFromMessage(pool, config, { app, user, messageId, content, chosen = false, deps = {} }) {
  const { rows: [already] } = await pool.query('SELECT * FROM chat_bot_requests WHERE chat_message_id = $1', [messageId]);
  // WP-C: Suggest it, under an offer this person was made, files it whether
  // or not the bot is theirs.
  const offered = chosen && already?.kind === 'offer' && Number(already.requester_id) === Number(user.id);
  const here = offered
    ? await filingFor(pool, { app, user, deps })
    : await botFor(pool, { app, user, deps });
  if (!here) return { ok: false, status: 403, error: 'Homeroom bot is not on for you yet.', code: 'not_enabled' };
  if (already && (already.issue_number != null || !chosen)) {
    return { ok: true, card: cardOf(already, { builds: here.builds }), already: true };
  }
  const words = askedWords(content);
  if (!words) return { ok: false, status: 400, error: 'There is nothing in the message to ask for.', code: 'empty' };
  if (await filedLately(pool, user.id) >= FILINGS_PER_HOUR) {
    const card = { messageId: Number(messageId), kind: 'busy', title: null, issueNumber: null };
    pushCard(user.id, app.slug, card, deps);
    return { ok: false, status: 429, error: 'You\'ve asked me for a lot in the last hour. Try again in a little while.', code: 'busy', card };
  }
  let kind = 'change';
  // WP-C: File it / Suggest it keeps the title the card already showed.
  let title = chosen && already?.title ? already.title : null;
  if (!chosen) {
    try {
      const read = await (deps.readAsk || require('./llm').readChatAsk)({ text: words, appName: app.name || app.slug });
      kind = read?.kind || 'unsure';
      title = read?.title || null;
    } catch (err) {
      // No read: ask them, rather than file something they may not have meant.
      log.warn('homeroom-bot-chat', 'Could not read a message to Homeroom bot (asking first)', { app: app.slug, err: err.message });
      kind = 'unsure';
    }
  }
  if (kind === 'question' || kind === 'unsure') {
    const row = await record(pool, {
      messageId, appId: app.id, userId: user.id, kind, title: kind === 'unsure' ? (title || fallbackTitle(words)) : null,
    });
    const card = cardOf(row || { chat_message_id: messageId, kind, title: null, issue_number: null });
    pushCard(user.id, app.slug, card, deps);
    return { ok: true, card };
  }
  try {
    const card = await fileMessage(pool, config, {
      app, user, messageId, words, title: title || fallbackTitle(words), here, deps,
    });
    pushCard(user.id, app.slug, card, deps);
    return { ok: true, card };
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not file a request asked for in a chat', { app: app.slug, userId: user.id, err: err.message });
    const card = { messageId: Number(messageId), kind: 'failed', title: null, issueNumber: null };
    pushCard(user.id, app.slug, card, deps);
    return { ok: false, status: 502, error: 'I couldn\'t file it just now. Try again in a minute.', code: 'file_failed', card };
  }
}

/** A project, as filing a request on it reads it. */
async function appRow(pool, appId) {
  const { rows } = await pool.query('SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = $1', [appId]);
  return rows[0] || null;
}

/** A person, as hasBot and filing read them. */
async function personRow(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess", is_admin AS "isAdmin"
       FROM users WHERE id = $1 AND anonymised_at IS NULL`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * Called by the room (services/ws.js) after a person's message is stored
 * and broadcast. When it mentions Homeroom bot, in the main stream, typed by
 * a person, it is asked; anything else is nothing here. Never throws.
 */
async function noteChatMessage(pool, config, { appId, userId, messageId, content, thread = null, postedVia = null, deps = {} }) {
  try {
    if (thread || postedVia === 'agent' || !appId || !userId) return null;
    const mentioned = mentionsBot(content);
    // WP-C: an unmentioned message is read only for somebody new (maybeOffer).
    if (!mentioned && (wordCount(content) < OFFER_MIN_WORDS || !await isNewcomer(pool, appId, userId))) return null;
    // The room's socket knows little of either: read what filing needs.
    const [app, user] = await Promise.all([appRow(pool, appId), personRow(pool, userId)]);
    if (!app || !user) return null;
    if (!mentioned) return await maybeOffer(pool, { app, user, messageId, content, deps });
    return await askFromMessage(pool, config, { app, user, messageId, content, deps });
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not hand a chat message to Homeroom bot', { app: app?.slug, messageId, err: err.message });
    return null;
  }
}

/** Pure: how many words a message has. */
function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * WP-C: a message from somebody new to the project, not addressed to the
 * bot. When it reads as an idea for the app, their card offers to suggest it
 * to the group. Resolves the card, or null. Never throws.
 */
async function maybeOffer(pool, { app, user, messageId, content, deps = {} }) {
  try {
    const words = String(content || '').replace(/\s+/g, ' ').trim();
    if (wordCount(words) < OFFER_MIN_WORDS) return null;
    const here = await newcomerHere(pool, { app, user, deps });
    if (!here) return null;
    if (!(deps.takeOfferRead || takeOfferRead)(Number(user.id))) return null;
    const read = await (deps.readAsk || require('./llm').readChatAsk)({
      text: words, appName: app.name || app.slug, toBot: false,
    });
    if (read?.kind !== 'change') return null;
    const row = await record(pool, {
      messageId, appId: app.id, userId: user.id, kind: 'offer', title: read.title || fallbackTitle(words),
    });
    if (!row) return null;
    const card = cardOf(row);
    pushCard(user.id, app.slug, card, deps);
    log.info('homeroom-bot-chat', 'Offered to suggest a newcomer\'s idea', { app: app.slug, userId: user.id, messageId });
    return card;
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not offer to suggest a message', { app: app?.slug, messageId, err: err.message });
    return null;
  }
}

/**
 * "Make this a request" (or File it under the card that asked first), on a
 * message of the person's own in the room's main stream: the same as a
 * mention, without the read, since they chose. `dismiss` is Not now.
 */
async function requestFromMessage(pool, config, { app, user, messageId, dismiss = false, deps = {} }) {
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 404, error: 'Message not found' };
  const { rows: [message] } = await pool.query(
    `SELECT id, user_id, content, thread_type, msg_type, deleted_at, posted_via
       FROM chat_messages WHERE id = $1 AND app_id = $2`,
    [id, app.id],
  );
  if (!message || message.deleted_at) return { ok: false, status: 404, error: 'Message not found' };
  if (Number(message.user_id) !== Number(user.id) || message.msg_type !== 'message' || message.thread_type) {
    return { ok: false, status: 403, error: 'Only a message of your own in the chat can be made a request.' };
  }
  if (dismiss) {
    await pool.query(
      `UPDATE chat_bot_requests SET kind = 'dismissed', updated_at = NOW()
        WHERE chat_message_id = $1 AND requester_id = $2 AND kind IN ('unsure', 'question', 'offer')`,
      [id, user.id],
    );
    return { ok: true, dismissed: true };
  }
  return askFromMessage(pool, config, { app, user, messageId: id, content: message.content, chosen: true, deps });
}

/**
 * The cards of one person's requests asked in one project's chat, for their
 * chat to draw under their own messages again after a reload. Theirs alone.
 */
async function myRequests(pool, { app, user, deps = {} }) {
  const here = await botFor(pool, { app, user, deps });
  const { rows } = await pool.query(
    `SELECT * FROM chat_bot_requests
      WHERE app_id = $1 AND requester_id = $2 AND kind <> 'dismissed'
      ORDER BY chat_message_id DESC LIMIT 100`,
    [app.id, user.id],
  );
  const typicalMinutes = here?.builds ? await dmModule(deps).typicalMinutes(pool).catch(() => null) : null;
  const first = rows.some((row) => row.issue_number != null)
    ? await firstRequestOf(pool, app.id, user.id).catch(() => null) : null;
  return {
    bot: !!here,
    builds: !!here?.builds,
    cards: rows.map((row) => cardOf(row, {
      builds: row.kind === 'group' ? false : true, typicalMinutes,
      first: first != null && Number(row.issue_number) === first,
    })),
  };
}

module.exports = {
  appRow,
  personRow,
  BOT_MENTION_RE,
  FILINGS_PER_HOUR,
  OFFER_WITHIN_DAYS,
  OFFERS_PER_PROJECT,
  OFFER_MIN_WORDS,
  OFFER_READS_PER_DAY,
  OFFER_READS_PER_HOUR,
  takeOfferRead,
  newcomerHere,
  isNewcomer,
  maybeOffer,
  wordCount,
  mentionsBot,
  askedWords,
  fallbackTitle,
  botFor,
  cardOf,
  setStatus,
  noteRequestStatus,
  noteChatMessage,
  askFromMessage,
  requestFromMessage,
  myRequests,
};
