'use strict';

// Homeroom bot's cards: every offer it makes and every card it draws with
// something to tap, in one store (docs/plans/bot-one-model.md, step 2,
// decisions 2 and 3). A card is said on one message (a conversation message
// in Main, a private or design thread; a chat message on a project's
// thread), for one person or for anybody its kind allows, open until it is
// decided or expires (14 days; an admin's confirm, 15 minutes).
//
// One tap handler (`decide`): the card must be open, not expired, and the
// tapper's; it is claimed with one UPDATE, so two taps decide it once, and
// then its kind's `settle` runs (the function each old store's route called).
// The old stores (homeroom_bot_dm_actions, homeroom_bot_voice_offers,
// chat_bot_requests, homeroom_bot_admin_actions, message-metadata cards) are
// written no more; what they hold stays answerable through their own routes
// until it is answered or 14 days old.
//
// At most MAX_PER_REPLY cards on one reply, across kinds (`capCards`).

const log = require('./logger');

const MAX_PER_REPLY = 3;
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const STATUSES = Object.freeze(['open', 'done', 'declined', 'expired']);

const KINDS = new Map();

/**
 * Define a kind once: { kind, choices (the answers a tap may give),
 * declines? (those of them that turn it down: the card is 'declined', not
 * 'done'), ttlMs?, anybody? (anyone who may see the place may decide it,
 * else only its person), settle(pool, card, { choice, user, deps }) → what
 * the tap answers }. A second definition throws.
 */
function defineKind(def) {
  if (!def || typeof def.kind !== 'string' || !/^[a-z][a-z_]{1,39}$/.test(def.kind)) throw new Error('bot-cards: a kind needs a name');
  if (KINDS.has(def.kind)) throw new Error(`bot-cards: ${def.kind} is defined twice`);
  if (!Array.isArray(def.choices) || !def.choices.length) throw new Error(`bot-cards: ${def.kind} has no choices`);
  if (typeof def.settle !== 'function') throw new Error(`bot-cards: ${def.kind} needs settle`);
  KINDS.set(def.kind, Object.freeze({ ttlMs: DEFAULT_TTL_MS, anybody: false, ...def, choices: Object.freeze([...def.choices]) }));
  return KINDS.get(def.kind);
}

function kindOf(kind) {
  return KINDS.get(String(kind || '')) || null;
}

/** Pure: a reply's cards, at most MAX_PER_REPLY, in the order they were made; the rest are not offered. */
function capCards(cards) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  return { kept: list.slice(0, MAX_PER_REPLY), dropped: list.slice(MAX_PER_REPLY) };
}

/**
 * Write a new card, open, before the message that says it (its id goes in
 * that message's metadata as `cardId`); `attach` names the message once it
 * is sent. Resolves { id, expiresAt }.
 */
async function offer(db, { kind, forUserId = null, appId = null, payload = {}, ttlMs = null }) {
  const def = kindOf(kind);
  if (!def) throw new Error(`bot-cards: no kind ${kind}`);
  const ms = Number(ttlMs) > 0 ? Number(ttlMs) : def.ttlMs;
  const { rows: [row] } = await db.query(
    `INSERT INTO bot_cards (kind, for_user_id, app_id, payload, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW() + make_interval(secs => $5::double precision / 1000))
     RETURNING id, expires_at`,
    [kind, forUserId ? Number(forUserId) : null, appId ? Number(appId) : null, JSON.stringify(payload || {}), ms],
  );
  return { id: Number(row.id), expiresAt: row.expires_at };
}

/** Name the message a card was said on: a conversation message, or a project thread's chat message. */
async function attach(db, cardId, { conversationMessageId = null, chatMessageId = null }) {
  await db.query(
    'UPDATE bot_cards SET conversation_message_id = COALESCE($2, conversation_message_id), chat_message_id = COALESCE($3, chat_message_id) WHERE id = $1',
    [Number(cardId), conversationMessageId ? Number(conversationMessageId) : null, chatMessageId ? Number(chatMessageId) : null],
  );
}

/** One card as stored, or null. */
async function read(db, cardId) {
  const id = Number(cardId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const { rows: [row] } = await db.query(
    `SELECT id, kind, for_user_id, app_id, conversation_message_id, chat_message_id, payload, status, choice,
            decided_by, decided_at, expires_at, expires_at <= NOW() AS expired, created_at
       FROM bot_cards WHERE id = $1`,
    [id],
  );
  return row || null;
}

/**
 * The one tap handler. Resolves { ok: true, choice, ...what settle said },
 * or a refusal { ok: false, status, code }: 404 no such card, 403 not theirs
 * to decide, 409 decided already, 410 expired, 400 not one of its answers.
 * Claimed before it is settled, so a second tap gets the 409; a settle that
 * throws puts the card back open, for a retry.
 */
async function decide(pool, { cardId, choice, user, deps = {} }) {
  const card = await read(pool, cardId);
  if (!card) return { ok: false, status: 404, code: 'no_card' };
  const def = kindOf(card.kind);
  if (!def) return { ok: false, status: 404, code: 'no_card' };
  if (!user?.id) return { ok: false, status: 401, code: 'signed_out' };
  if (!def.anybody && card.for_user_id != null && Number(card.for_user_id) !== Number(user.id)) {
    return { ok: false, status: 403, code: 'not_yours' };
  }
  if (!def.choices.includes(choice)) return { ok: false, status: 400, code: 'bad_choice' };
  if (card.status !== 'open') return { ok: false, status: 409, code: 'decided', choice: card.choice };
  if (card.expired) {
    await pool.query("UPDATE bot_cards SET status = 'expired' WHERE id = $1 AND status = 'open'", [card.id]);
    return { ok: false, status: 410, code: 'expired' };
  }
  const { rows: [claimed] } = await pool.query(
    `UPDATE bot_cards SET status = $3, choice = $2, decided_by = $4, decided_at = NOW()
      WHERE id = $1 AND status = 'open' AND expires_at > NOW()
      RETURNING id`,
    [card.id, choice, def.declines?.includes(choice) ? 'declined' : 'done', Number(user.id)],
  );
  if (!claimed) return { ok: false, status: 409, code: 'decided' };
  try {
    const said = await def.settle(pool, { ...card, status: 'open' }, { choice, user, deps });
    return { ok: true, choice, ...(said && typeof said === 'object' ? said : {}) };
  } catch (err) {
    log.warn('bot-cards', 'A card could not be settled; it is open again', { cardId: card.id, kind: card.kind, err: err.message });
    await pool.query(
      "UPDATE bot_cards SET status = 'open', choice = NULL, decided_by = NULL, decided_at = NULL WHERE id = $1",
      [card.id],
    ).catch(() => {});
    throw err;
  }
}

/** Mark open cards past their time expired, oldest first. Resolves how many. */
async function expireOld(pool, { limit = 500 } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE bot_cards SET status = 'expired'
      WHERE id IN (SELECT id FROM bot_cards WHERE status = 'open' AND expires_at <= NOW() ORDER BY expires_at LIMIT $1)`,
    [limit],
  );
  return rowCount;
}

module.exports = {
  MAX_PER_REPLY,
  DEFAULT_TTL_MS,
  STATUSES,
  defineKind,
  kindOf,
  capCards,
  offer,
  attach,
  read,
  decide,
  expireOld,
};
