'use strict';

// #6270, #6346: the guards a turn's answer passes before it is posted, shared
// by the voice (request threads) and the chat's own rounds (homeroom-bot-mayor).
// A model that spent every round reading answers with a stand-in word; it is
// warned before its last round, refused once if the answer is one, and then
// gives up to the fallback line. Pure and dependency-free, so both paths send
// exactly the same words.

// #6270: words a model writes when it has nothing to say, and text with no
// letters at all ("...", "???"). A short real answer ("No.", "Yes.") passes.
const STAND_IN_WORDS = Object.freeze(['placeholder', 'todo', 'tbd', 'text', 'reply']);

/**
 * Pure: whether a reply is a stand-in rather than an answer (#6270): a dummy
 * word the model writes when it has nothing ("placeholder", "TODO", "[TBD]",
 * "text", "reply"), or text with no letter at all ("...", "???", ""). A short
 * real answer such as "No." or "Yes." is not one.
 */
function isStandIn(text) {
  const raw = String(text ?? '').trim();
  if (!/\p{L}/u.test(raw)) return true;
  return STAND_IN_WORDS.includes(raw.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
}

/** Pure: the note before a turn's last round. */
function lastRoundNote(orElse) {
  return `This is your last round. Answer now with what you have${orElse ? `, or ${orElse}` : ''}. You cannot read anything more.`;
}

/** Pure: the note refusing a stand-in reply, which gets one more round. */
function standInNote(orElse) {
  return `That reply is a stand-in, not an answer. Write the real answer to what they said now${orElse ? `, or ${orElse}` : ''}.`;
}

/** Pure: the note answering a read once the turn's reading is spent. */
function readingDoneNote(orElse) {
  return `Your reading for this turn is done. Answer with what you know${orElse ? `, or ${orElse}` : ''}.`;
}

module.exports = {
  STAND_IN_WORDS,
  isStandIn,
  lastRoundNote,
  standInNote,
  readingDoneNote,
};
