'use strict';

// Tells a person's open tabs that Homeroom bot's work for them moved
// (`homeroom_bot_work_changed`, no payload): their Homeroom bot page and the
// chat with the bot read again under their own session (public/js/app.js
// turns it into the window event frontend/src/features/messages/bot-work.tsx
// and features/ai/live.ts listen for). A request's or a change's stage moving
// is pushed as `work_state` (services/work-state.js); this covers what moves
// no stage: a private thread filed or closed, a plan's draft, a hold.

const log = require('./logger');

/** Announce it to `userId`'s sockets. Resolves how many it reached; never throws. */
function noteWorkChanged(userId, deps = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  try {
    const ws = deps.ws || require('./ws');
    return ws.pushToUser(id, { type: 'homeroom_bot_work_changed' }) || 0;
  } catch (err) {
    log.warn('bot-work-changed', 'Could not announce a work change', { userId: id, err: err.message });
    return 0;
  }
}

module.exports = { noteWorkChanged };
