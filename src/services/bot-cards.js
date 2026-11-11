'use strict';

// Homeroom bot's cards, in one store (5 Nov 2026, docs/plans/bot-one-model.md,
// step 2, decisions 2 and 3; migration bot-cards). Every offer it makes with
// something to tap is a bot_cards row:
//
//   place 'dm'      in a person's chat with the bot (Main, a private or a
//                   design thread): its conversation message in message_id,
//                   tapped through POST /api/conversations/homeroom-bot/
//                   actions/:id and the person's bot-dm machine
//                   (homeroom-bot-mayor.js decideOfferTap, actOnTap);
//   place 'thread'  in a project's thread: its chat message in
//                   chat_message_id, tapped through POST /api/apps/:slug/
//                   messages/:id/bot-offer with its id and the place's
//                   bot-voice machine (homeroom-bot-voice.js decideOffer,
//                   actOnOffer).
//
// Step 3 (11 Nov 2026): a card is written IN THE SAME TRANSACTION as the
// message that shows its buttons, its message id set there too
// (ws.sendBotMessage's and homeroom-bot-dm.js sendDm's `card`), so buttons
// on screen always have their card, found by its id. A caller passes what
// the card is (`card`), never a card it made before.
//
// The chat's old offer table is this store, renamed, so its rows carried on
// as they were; a thread's offers made before stay answerable in
// homeroom_bot_voice_offers until answered or 14 days old (voice OFFERS_SQL).
// A card is open 14 days (`expires_at`), and a tap after that is refused and
// its buttons go. Its buttons also go when what it is about moves on
// (retireOnMove, from the standing). At most MAX_PER_REPLY cards go under one
// reply.

const log = require('./logger');

const MAX_PER_REPLY = 3;
const OPEN_DAYS = 14;

/** Pure: whether a stored card can still be decided at `now`. */
function stillOpen(card, now = Date.now()) {
  if (!card || card.status !== 'open') return false;
  const ends = card.expires_at ? new Date(card.expires_at).getTime() : NaN;
  return !Number.isFinite(ends) || ends > now;
}

// ── A thread card's buttons ──────────────────────────────────────────────

const OFFER_WORDS = Object.freeze({
  file_request: { yes: 'File it', no: 'Not now' },
  file_many: { yes: 'File on all', no: 'Not now' },
  withdraw_change: { yes: 'Withdraw it', no: 'Keep it' },
  close_request: { yes: 'Propose to close', no: 'Keep it open' },
  try_again: { yes: 'Let it try again', no: 'Not now' },
  // #6311: the copy beside the move. The original stays open.
  copy_request: { yes: 'Put it on Homeroom\'s board', no: 'Keep it here only' },
  // 5 Nov 2026: the move itself, under the note in the request's thread
  // (its news no longer goes to their chat with the bot, where it was
  // offered): filed on Homeroom's board, the original closed or voted on.
  move_request: { yes: 'Move it to Homeroom', no: 'Keep it here' },
  // #6533: a change's thread, showing what it looks like.
  run_shots: { yes: 'Take the shots', no: 'Not now' },
  post_pictures_plan: { yes: 'Post as a plan', no: 'Not now' },
});

/** Pure (#6211): the words an overlap note's buttons carry, from what it found. */
function overlapWords(args = {}) {
  const other = Number(args.other);
  if (args.overlap === 'duplicate') {
    return { yes: 'Propose to close as a duplicate', no: 'Keep both' };
  }
  if (args.overlap === 'part_of') {
    return { yes: `Fold it into #${other}`, first: 'Build this one first', no: 'Keep separate' };
  }
  return { yes: `Build #${other} first`, first: 'Build this one first', no: 'Keep separate' };
}

/** Pure: an offer's buttons, as the thread draws them under its message. */
function offerActions(kind, offerId, args = {}) {
  // #6211: an overlap's three choices for the requester. Duplicate is the
  // two the close vote's own note has; the rest offer the order as well.
  if (kind === 'overlap') {
    const words = overlapWords(args);
    return [
      { id: 'yes', label: words.yes, style: 'primary', offerId: Number(offerId) },
      ...(words.first ? [{ id: 'first', label: words.first, style: 'secondary', offerId: Number(offerId) }] : []),
      { id: 'no', label: words.no, style: 'secondary', offerId: Number(offerId) },
    ];
  }
  const words = OFFER_WORDS[kind];
  if (!words) return [];
  // #6533: the plan offer names its request, as the change page does.
  const yes = kind === 'post_pictures_plan' && Number(args.issueNumber) > 0
    ? `${words.yes} on request #${Number(args.issueNumber)}` : words.yes;
  return [
    { id: 'yes', label: yes, style: 'primary', offerId: Number(offerId) },
    { id: 'no', label: words.no, style: 'secondary', offerId: Number(offerId) },
  ];
}

/**
 * Pure: a thread message's metadata with its card in it: the offer (its id,
 * kind, who it is for, a many-project offer's rows) and its buttons, each
 * naming the card. The note is the bot's voice, whatever it was before.
 */
function withThreadCard(metadata, card) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const bot = meta.homeroomBot && typeof meta.homeroomBot === 'object' ? meta.homeroomBot : {};
  const args = card.args || {};
  return {
    ...meta,
    homeroomBot: {
      ...bot,
      kind: 'voice',
      offer: {
        id: Number(card.id), kind: card.kind, status: 'open', forUserId: Number(card.user_id) || null,
        // #6305: a many-project offer's rows travel with it, so a thread
        // draws the same card a private chat does.
        ...(Array.isArray(args.rows) ? { rows: args.rows } : {}),
      },
      actions: offerActions(card.kind, card.id, args),
    },
  };
}

// ── Written with its message ─────────────────────────────────────────────

/**
 * Run `fn(db)` in one transaction: its own on a pool; inside the caller's
 * on a client already checked out (or a stand-in with only `query`).
 */
async function inTransaction(db, fn) {
  if (!db || typeof db.connect !== 'function' || typeof db.release === 'function') return fn(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const positive = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/**
 * A card, open, inside its message's transaction, before the message: its
 * row ({ id, kind, args, user_id }). `place` 'thread' (a project's thread:
 * `forUserId`, or nobody in particular, and `args`) or 'dm' (a person's chat
 * with the bot: `userId`, `conversationId` and the columns its kind reads).
 * The message's id is set by the same transaction once it is written
 * (ws.sendBotMessage, homeroom-bot-dm.js sendDm).
 */
async function insertCard(db, spec) {
  const thread = spec.place === 'thread';
  const { rows: [row] } = await db.query(
    `INSERT INTO bot_cards (place, app_id, kind, args, user_id, conversation_id, title, details, session_id,
                           source_issue_number, target_message_id, private_thread_id, design_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, kind, args, user_id`,
    [thread ? 'thread' : 'dm', positive(spec.appId), String(spec.kind), JSON.stringify(spec.args || {}),
      thread ? positive(spec.forUserId) : positive(spec.userId), thread ? null : positive(spec.conversationId),
      String(spec.title || ''), spec.details == null ? null : String(spec.details),
      positive(spec.sessionId), positive(spec.sourceIssueNumber), positive(spec.targetMessageId),
      positive(spec.privateThreadId), positive(spec.designVersion)],
  );
  return row;
}

// ── Retired by the standing ──────────────────────────────────────────────

// Why a card's buttons went, as its message says it (the line the buttons
// leave behind: frontend chat.json / messages.json `retired.*`).
const RETIRED_REASONS = Object.freeze(['close_vote', 'closed', 'building', 'moved_on', 'superseded']);

// The stages a request is in before anybody builds it.
const NOT_UNDER_WAY = new Set(['reading', 'planning', 'waiting_for_you', 'stopped']);
// A request ready to build that waits its turn: in the bot's line, or held
// for the project's builds or its changes up for a vote (work-state.js
// READY, "Ready to build"). Nothing is being built yet.
const WAITS_TO_BUILD = new Set(['queued', 'held_builds', 'held_waiting']);
// The stages in which a change is past withdrawing.
const PAST_CHANGING = new Set(['going_live', 'live', 'closed']);

const closeVoteOf = (s) => !!(s && s.standing && s.standing.asks && s.standing.asks.closeVote);
/** Pure: whether nobody is building a request yet, by its standing (it may wait its turn to be built). */
function notBuildingYet(s) {
  if (!s) return false;
  return NOT_UNDER_WAY.has(s.stage) || (s.stage === 'building' && WAITS_TO_BUILD.has(s.line && s.line.code));
}
const notYetBuilt = {
  keep: notBuildingYet,
  why: (s) => (s.stage === 'closed' ? 'closed' : 'building'),
};

/**
 * THE table: which kinds of card stay worth a tap for which standing of
 * what they are about: the request (a card naming one), else the change. A
 * kind not listed is never retired by the standing (a draft to file, a
 * design's plan, a change's pictures, a nudge: their buttons are about
 * words, not about where the work stands).
 */
const STILL_WORTH = Object.freeze({
  // Propose to close: while the request is open and no vote on closing it is.
  close_request: {
    keep: (s) => s.stage !== 'closed' && !closeVoteOf(s),
    why: (s) => (s.stage === 'closed' ? 'closed' : 'close_vote'),
  },
  // Let it try again: while it is stopped.
  try_again: { keep: (s) => s.stage === 'stopped', why: (s) => (s.stage === 'closed' ? 'closed' : 'moved_on') },
  // An overlap, a copy or a move to Homeroom's board, a request to file:
  // while nobody is building it yet and it is open.
  overlap: notYetBuilt,
  file_request: notYetBuilt,
  copy_request: notYetBuilt,
  move_request: notYetBuilt,
  // A plan's Build it: while the plan waits for its requester.
  build_plan: {
    keep: (s) => s.stage === 'waiting_for_you' && s.why === 'plan',
    why: (s) => (s.stage === 'closed' ? 'closed' : s.stage === 'building' ? 'building' : 'moved_on'),
  },
  // Withdraw it: while the change can still be withdrawn.
  withdraw_change: { keep: (s) => !PAST_CHANGING.has(s.stage), why: (s) => (s.stage === 'closed' ? 'closed' : 'moved_on') },
  withdraw_proposal: { keep: (s) => !PAST_CHANGING.has(s.stage), why: (s) => (s.stage === 'closed' ? 'closed' : 'moved_on') },
});

/**
 * Pure: whether an item's standing moved since `prev` (its stage, why or
 * reason, a vote on closing it opened, or a build that waited its turn
 * started: building, ready to build, to building under way). Buttons are
 * judged on a move only, so a card made a moment before its item's stage
 * catches up is not taken back for a stage it was never meant for.
 */
function moved(prev, s) {
  if (!prev || !s) return false;
  return prev.stage !== s.stage || (prev.why || null) !== (s.why || null) || (prev.reason || null) !== (s.reason || null)
    || (!prev.closeVote && closeVoteOf(s))
    || (prev.line !== undefined && notBuildingYet(prev) !== notBuildingYet(s));
}

/** Pure: why a card on an item standing at `s` should go, or null while it stays. */
function retireReason(kind, s) {
  const rule = STILL_WORTH[kind];
  if (!rule || !s) return null;
  return rule.keep(s) ? null : rule.why(s);
}

// The request a card is about (its column, the request it was made from, or
// its args), and the change, as the work-state trigger reads them.
const CARD_REQUEST_SQL = `COALESCE(c.issue_number, c.source_issue_number,
  CASE WHEN (c.args->>'issueNumber') ~ '^[0-9]{1,9}$' THEN (c.args->>'issueNumber')::int END)`;

/** The open cards about one item: a request's, or a change's that name no request. */
async function openCardsOf(db, { appId, issueNumber, sessionId }) {
  if (positive(appId) && positive(issueNumber)) {
    const { rows } = await db.query(
      `SELECT c.id, c.kind, c.place, c.user_id, c.chat_message_id, c.message_id, c.conversation_id
         FROM bot_cards c
        WHERE c.status = 'open' AND c.app_id = $1 AND ${CARD_REQUEST_SQL} = $2
        ORDER BY c.id`,
      [positive(appId), positive(issueNumber)],
    );
    return rows;
  }
  if (!positive(sessionId)) return [];
  const { rows } = await db.query(
    `SELECT c.id, c.kind, c.place, c.user_id, c.chat_message_id, c.message_id, c.conversation_id
       FROM bot_cards c
      WHERE c.status = 'open' AND (c.session_id = $1 OR (c.args->>'sessionId') = $1::text)
        AND ${CARD_REQUEST_SQL} IS NULL
      ORDER BY c.id`,
    [positive(sessionId)],
  );
  return rows;
}

/**
 * The buttons of `cards` go, for `reason`: each card retired (once: only an
 * open one), and its message updated in place (its words never change), in
 * `db`'s transaction. Resolves the pushes that tell everybody reading,
 * to publish once that transaction commits (work-state.js publish).
 */
async function retireCards(db, cards, reason) {
  return (await retireCounted(db, cards, reason)).pushes;
}

/**
 * retireCards, and the ids of the cards it retired. A card somebody's tap holds
 * this moment is left to that tap (SKIP LOCKED): it is being decided, and
 * waiting on it could close a circle of waits with the work-state drain (a
 * tap's own mark waits on the drain's taken marks).
 */
async function retireCounted(db, cards, reason) {
  const pushes = [];
  const retired = [];
  for (const card of cards) {
    const { rows: [done] } = await db.query(
      `UPDATE bot_cards SET status = 'retired', retired_reason = $2
        WHERE id = (SELECT c.id FROM bot_cards c WHERE c.id = $1 AND c.status = 'open' FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [Number(card.id), reason],
    );
    if (!done) continue;
    retired.push(Number(card.id));
    if (card.place === 'thread' && card.chat_message_id) {
      const { rows: [m] } = await db.query(
        `UPDATE chat_messages
            SET metadata = jsonb_set(jsonb_set(jsonb_set(metadata,
                  '{homeroomBot,offer,status}', '"retired"'::jsonb, true),
                  '{homeroomBot,offer,retired}', to_jsonb($2::text), true),
                  '{homeroomBot,actions}', '[]'::jsonb, true)
          WHERE id = $1 AND jsonb_typeof(metadata->'homeroomBot'->'offer') = 'object'
          RETURNING id, app_id, metadata, thread_type, thread_ref`,
        [Number(card.chat_message_id), reason],
      );
      if (m) {
        pushes.push({
          kind: 'room', routing: { appId: Number(m.app_id) },
          data: {
            type: 'chat_message_updated', id: Number(m.id), metadata: m.metadata,
            thread: m.thread_type ? { type: m.thread_type, ref: Number(m.thread_ref) } : null,
          },
        });
      }
    } else if (card.place === 'dm' && card.message_id) {
      // A plan a newer plan replaced reads so (bot-plan.tsx planState).
      const patch = { status: 'closed', retired: reason, ...(card.kind === 'build_plan' && reason === 'superseded' ? { replaced: true } : {}) };
      const { rows: [m] } = await db.query(
        `UPDATE conversation_messages
            SET metadata = jsonb_set(metadata, '{homeroomBot}', COALESCE(metadata->'homeroomBot', '{}'::jsonb) || $2::jsonb, true)
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, conversation_id, sender_id, thread_root_id`,
        [Number(card.message_id), JSON.stringify(patch)],
      );
      if (m) {
        for (const userId of new Set([Number(m.sender_id), Number(card.user_id)].filter((id) => id > 0))) {
          pushes.push({
            kind: 'user', routing: { userId, actorUserId: Number(m.sender_id) || null },
            data: {
              type: 'conversation_message_updated', conversationId: Number(m.conversation_id), messageId: Number(m.id),
              threadRootId: m.thread_root_id ? Number(m.thread_root_id) : null,
            },
          });
        }
      }
    }
    log.info('bot-cards', 'A card\'s buttons went: what it is about moved on', { cardId: Number(card.id), kind: card.kind, reason });
  }
  return { pushes, retired };
}

/**
 * The one place a card's buttons go because what it is about moved on.
 * `standing` is the item's row as work-state stores it (stage, why, reason,
 * and its `standing`: the open vote on closing it), `prev` the row before
 * (work-state.js upsert): on a move (moved), every open card about the item
 * that STILL_WORTH no longer keeps is retired, with why. `keep` (card ids,
 * for the posting function: a newer note supersedes an older one) retires
 * every other open card of the kept cards' kinds about the item, as
 * 'superseded'. `messageIds` (step 4, the posting function's: the older
 * notes a newer one takes the place of, bot-post.js) retires every open
 * card on those messages, whatever its kind, as 'superseded' too: a newer
 * failure note leaves the older one's buttons behind as a line. The item is
 * a request (`appId`, `issueNumber`), or a change (`sessionId`) for its
 * cards that name no request. Resolves the pushes that tell everybody
 * reading, to publish once `db`'s transaction commits.
 *
 * A retire marks nothing by itself (the work-state trigger skips it), so
 * this marks the items of the cards it retired: their standings list their
 * open cards (asks.offers), and the drain derives them again. The standing's
 * own move retires through retireOnMove instead, which derives them at once.
 */
async function retireFor(db, opts = {}) {
  const out = await retireOf(db, opts);
  if (out.cards.length) {
    await db.query(
      `SELECT work_state_mark(c.app_id, ${CARD_REQUEST_SQL}, NULL) AS request,
              work_state_mark(NULL, NULL, COALESCE(c.session_id,
                CASE WHEN (c.args->>'sessionId') ~ '^[0-9]{1,9}$' THEN (c.args->>'sessionId')::int END)) AS change
         FROM bot_cards c WHERE c.id = ANY($1::int[])`,
      [out.cards],
    );
  }
  return out.pushes;
}

/**
 * retireFor for an item's own move (work-state.js settleCards): the same
 * table, marking nothing. Resolves { pushes, retired } (how many cards went),
 * so the caller derives the item again when any did.
 */
async function retireOnMove(db, opts = {}) {
  const out = await retireOf(db, opts);
  return { pushes: out.pushes, retired: out.cards.length };
}

async function retireOf(db, {
  appId = null, issueNumber = null, sessionId = null, standing = null, prev = null, keep = null, messageIds = null,
} = {}) {
  const none = { pushes: [], cards: [] };
  const kept = new Set((Array.isArray(keep) ? keep : []).map(Number).filter((id) => id > 0));
  const older = (Array.isArray(messageIds) ? messageIds : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  const judge = standing && moved(prev, standing);
  if (!judge && !kept.size && !older.length) return none;
  const cards = await openCardsOf(db, { appId, issueNumber, sessionId });
  if (older.length) {
    // The older notes' own cards, about this item or not (a card that names
    // no request sits on a request's note too).
    const { rows: onThem } = await db.query(
      `SELECT c.id, c.kind, c.place, c.user_id, c.chat_message_id, c.message_id, c.conversation_id
         FROM bot_cards c
        WHERE c.status = 'open' AND c.place = 'thread' AND c.chat_message_id = ANY($1::int[])
        ORDER BY c.id`,
      [older],
    );
    for (const card of onThem) if (!cards.some((c) => Number(c.id) === Number(card.id))) cards.push(card);
  }
  if (!cards.length) return none;
  const olderSet = new Set(older);
  const byReason = new Map();
  const add = (reason, card) => {
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(card);
  };
  let superseding = new Set();
  if (kept.size) {
    const { rows } = await db.query('SELECT kind FROM bot_cards WHERE id = ANY($1::int[])', [[...kept]]);
    superseding = new Set(rows.map((r) => r.kind));
  }
  for (const card of cards) {
    if (kept.has(Number(card.id))) continue;
    const reason = judge ? retireReason(card.kind, standing) : null;
    if (reason) add(reason, card);
    else if (superseding.has(card.kind) || olderSet.has(Number(card.chat_message_id))) add('superseded', card);
  }
  const pushes = [];
  const gone = [];
  for (const [reason, list] of byReason) {
    const out = await retireCounted(db, list, reason);
    pushes.push(...out.pushes);
    gone.push(...out.retired);
  }
  return { pushes, cards: gone };
}

module.exports = {
  MAX_PER_REPLY,
  OPEN_DAYS,
  stillOpen,
  OFFER_WORDS,
  overlapWords,
  offerActions,
  withThreadCard,
  inTransaction,
  insertCard,
  RETIRED_REASONS,
  STILL_WORTH,
  moved,
  retireReason,
  retireCards,
  retireFor,
  retireOnMove,
};
