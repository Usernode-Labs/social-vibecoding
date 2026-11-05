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
//                   messages/:id/bot-offer and the place's bot-voice machine
//                   (homeroom-bot-voice.js decideOffer, actOnOffer).
//
// The chat's old offer table is this store, renamed, so its rows carried on
// as they were; a thread's offers made before stay answerable in
// homeroom_bot_voice_offers until answered or 14 days old (voice OFFERS_SQL).
// A card is open 14 days (`expires_at`), and a tap after that is refused and
// its buttons go. At most MAX_PER_REPLY cards go under one reply.

const MAX_PER_REPLY = 3;
const OPEN_DAYS = 14;

/** Pure: whether a stored card can still be decided at `now`. */
function stillOpen(card, now = Date.now()) {
  if (!card || card.status !== 'open') return false;
  const ends = card.expires_at ? new Date(card.expires_at).getTime() : NaN;
  return !Number.isFinite(ends) || ends > now;
}

module.exports = { MAX_PER_REPLY, OPEN_DAYS, stillOpen };
