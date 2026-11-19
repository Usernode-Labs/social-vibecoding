'use strict';

// Homeroom bot's one entry (docs/plans/bot-one-model.md, step 5): a message
// in a thread is answered by that thread kind's profile (bot-profiles.js),
// run on the turn engine by the surface the profile names. The places that
// hear a message call this, and nothing else picks a surface:
//
//   - a person's chat with the bot (homeroom-bot-dm.js answerUserMessage,
//     once it has done what needs no model: a tap typed as words, a tapped
//     suggested answer, a reply quoting a question or a plan): every private
//     thread runs the chat's turn (homeroom-bot-mayor.js runDmTurn), with all
//     its tools. Step 6 (19 Nov 2026): one agent per private thread. A
//     thread that holds a design, or whose live draft is open, is answered
//     by that same turn, which loads the design's or the draft's tools and
//     prompt section as capabilities (bot-profiles.js CAPABILITIES): no
//     designer or draft bot answers in its place;
//   - a project's thread (the bot-voice machine's turn, src/workflow/
//     bot-voice/services.ts): the voice's turn for that place
//     (homeroom-bot-voice.js runTurn), which speaks by the kind's rules.
//
// `deps.mayor` and `deps.voice` stand in for a surface in tests, as each
// caller already took them.

const profiles = require('./bot-profiles');

/**
 * Answer one message in a thread of kind `kind` (bot-profiles.js KINDS),
 * with the surface's own arguments. Resolves what the surface did.
 */
async function answer(pool, config, { kind, ...args }) {
  const profile = profiles.profileOf(kind);
  const deps = args.deps || {};
  switch (profile.surface) {
    case 'chat': return (deps.mayor || require('./homeroom-bot-mayor')).runDmTurn(pool, config, args);
    case 'thread': return (deps.voice || require('./homeroom-bot-voice')).runTurn(pool, config, args);
    default: throw new Error(`thread-bot: no surface ${profile.surface}`);
  }
}

module.exports = { answer };
