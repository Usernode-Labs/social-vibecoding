'use strict';

// 14 Nov 2026 (#6674): what Homeroom bot is doing, as another process sees it.
//
// The bot's typing lives in one process's memory (homeroom-bot-dm.js
// typingNow), and the card a returning page draws used to wait for the next
// renewal to reach it. A page that comes back now asks the server, and the
// read can land on a different pod: this is the short-lived copy the typing
// publishes carry across the bus (services/ws.js `bot_typing`). It is live
// state only: nothing is stored, and an entry older than three renewals is
// gone, so a pod that stopped hearing from the bot cannot answer "working"
// for work that ended.
const MIRROR_TTL_MS = 12000;

const places = new Map();

const placeKey = (conversationId, threadRootId) => `${Number(conversationId)}:${Number(threadRootId) || 0}`;

function prune(now) {
  for (const [key, entry] of places) {
    if (now - entry.at > MIRROR_TTL_MS) places.delete(key);
  }
}

function cleanDoing(doing) {
  return doing && typeof doing === 'object' && typeof doing.kind === 'string' ? doing : null;
}

function cleanAnswering(answering) {
  const id = Number(answering);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Record what another process said the bot is doing in one place.
 * `typing: false` forgets the place; anything else is a renewal.
 * `threadRootId` null is the conversation's main stream.
 */
function note({ conversationId, threadRootId, typing, doing, answering } = {}) {
  const conversation = Number(conversationId);
  if (!Number.isSafeInteger(conversation) || conversation <= 0) return;
  const root = Number(threadRootId);
  const key = placeKey(conversation, Number.isSafeInteger(root) && root > 0 ? root : 0);
  const now = Date.now();
  prune(now);
  if (typing === false) {
    places.delete(key);
    return;
  }
  if (typing !== true) return;
  places.set(key, { doing: cleanDoing(doing), answering: cleanAnswering(answering), at: now });
}

/** What another process last said, or null once it is older than three renewals. */
function get(conversationId, threadRootId = null) {
  const conversation = Number(conversationId);
  if (!Number.isSafeInteger(conversation) || conversation <= 0) return null;
  const root = Number(threadRootId);
  const key = placeKey(conversation, Number.isSafeInteger(root) && root > 0 ? root : 0);
  const now = Date.now();
  prune(now);
  return places.get(key) || null;
}

/** For tests: forget everything. */
function _reset() {
  places.clear();
}

module.exports = { note, get, _reset, MIRROR_TTL_MS };
