'use strict';

// Homeroom bot's one entry (docs/plans/bot-one-model.md, step 5): a message
// in a thread is answered by that thread kind's profile (bot-profiles.js),
// run on the turn engine by the surface the profile names. The places that
// hear a message call this, and nothing else picks a surface:
//
//   - a person's chat with the bot (homeroom-bot-dm.js answerUserMessage,
//     once it has done what needs no model: a tap typed as words, an answer
//     to a question, a change to a plan): every private thread runs the
//     chat's turn (homeroom-bot-mayor.js runDmTurn), with all its tools. 15
//     Nov 2026 (#6683): a thread that holds a design runs it too; only the
//     design's own message there (a pinned comment, a reply to one of its
//     versions: homeroom-bot-dm.js designDirect) is the design bot's
//     (design-bot.js answer);
//   - a private thread whose live draft is open (services/live-drafts.js):
//     every message there is the draft bot's (live-draft-bot.js answer) while
//     the draft stays open;
//   - a project's thread (the bot-voice machine's turn, src/workflow/
//     bot-voice/services.ts): the voice's turn for that place
//     (homeroom-bot-voice.js runTurn), which speaks by the kind's rules.
//
// `deps.mayor`, `deps.designBot`, `deps.draftBot` and `deps.voice` stand in for a surface in
// tests, as each caller already took them.

const profiles = require('./bot-profiles');

/**
 * Answer one message in a thread of kind `kind` (bot-profiles.js KINDS),
 * with the surface's own arguments. Resolves what the surface did.
 */
async function answer(pool, config, { kind, ...args }) {
  const profile = profiles.profileOf(kind);
  const deps = args.deps || {};
  switch (profile.surface) {
    case 'design': return (deps.designBot || require('./design-bot')).answer(pool, config, args);
    // A thread whose live draft is open (services/live-drafts.js).
    case 'draft': return (deps.draftBot || require('./live-draft-bot')).answer(pool, config, args);
    case 'chat': return (deps.mayor || require('./homeroom-bot-mayor')).runDmTurn(pool, config, args);
    case 'thread': return (deps.voice || require('./homeroom-bot-voice')).runTurn(pool, config, args);
    default: throw new Error(`thread-bot: no surface ${profile.surface}`);
  }
}

module.exports = { answer };
