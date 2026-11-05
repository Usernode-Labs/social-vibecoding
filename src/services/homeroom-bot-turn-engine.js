'use strict';

// One engine for Homeroom bot's in-process model turns (5 Nov 2026, step 1 of
// one bot per thread): the chat (homeroom-bot-mayor.js), the voice in
// request, change and chat threads (homeroom-bot-voice.js), the design bot
// (design-bot.js) and the look at each project before a request is filed on
// several (homeroom-bot-already-done.js). Each used to count its rounds, pick
// its last round's tools, keep its calls and results, and record its spend in
// a loop of its own, with the same mechanics written four ways.
//
// Each is now a PROFILE on this engine: its limits and tools, and hooks for
// what only it does (the chat's compaction and preamble nudges, the design
// bot's reading budget and forced first drawing, the voice's stand-in rule).
// The engine owns the round itself:
//
//   1. count it (state.rounds) and let the profile see it (onRound,
//      beforeRound);
//   2. decide whether it is the last (isLast, by default rounds >= limit);
//   3. ask the profile what this round offers (offer: tools, tool choice, a
//      note said before it, the request's own options), and ask the model;
//   4. an answer with no calls goes to onWords, which keeps going or stops;
//   5. calls are kept as the assistant's message, each run through `call`,
//      and each result kept as a tool message, cut as the profile cuts it;
//   6. afterCalls may stop the turn.
//
// `state` ({ rounds, limit }) is the caller's: a profile moves its limit (one
// more round for a refused stand-in, two for a claims correction) and reads
// its rounds when it records the turn. Behaviour is each loop's own, as it
// was: this module decides nothing a profile did not decide before.

const log = require('./logger');

/** Pure: a tool result as the model reads it, cut at `max` characters. */
function resultText(result, max, cut) {
  const text = JSON.stringify(result);
  return typeof cut === 'function' ? cut(text, max) : String(text ?? '').slice(0, max);
}

/**
 * One round of a turn. Resolves true when the turn is to stop after it.
 * `override` replaces what the profile offers this round ({ tools,
 * toolChoice, note, options, onWords, afterCalls }): the voice's one forced
 * reply when it queued a change and said nothing.
 */
async function runRound(state, profile, override = null) {
  state.rounds += 1;
  const round = { rounds: state.rounds, limit: state.limit, last: false };
  if (typeof profile.onRound === 'function') profile.onRound(round);
  if (typeof profile.beforeRound === 'function') profile.beforeRound(round);
  round.last = typeof profile.isLast === 'function' ? !!profile.isLast(round) : state.rounds >= state.limit;
  const offered = override || profile.offer(round);
  if (offered.note) profile.messages.push({ role: 'user', content: offered.note });
  const res = await profile.ask({
    messages: profile.messages,
    tools: offered.tools,
    toolChoice: offered.toolChoice,
    where: profile.where(state.rounds),
    ...(offered.options || {}),
  });
  const calls = profile.normalize(res?.toolCalls, state.rounds, profile.ids);
  if (!calls.length) {
    const onWords = offered.onWords || profile.onWords;
    return onWords(res, round) === 'stop';
  }
  if (typeof profile.onCalls === 'function' && profile.onCalls(res, calls, round) === 'stop') return true;
  profile.messages.push({ role: 'assistant', content: res.content || null, tool_calls: calls });
  for (const call of calls) {
    const name = call.function.name;
    const args = profile.parseArgs(call.function.arguments);
    const result = await profile.call(call, name, args, round);
    profile.messages.push({
      role: 'tool', tool_call_id: call.id, content: resultText(result, profile.resultChars, profile.cut),
    });
  }
  const afterCalls = override && 'afterCalls' in override ? override.afterCalls : profile.afterCalls;
  return typeof afterCalls === 'function' ? afterCalls(round) === 'stop' : false;
}

/** The turn's rounds, until the profile has its answer, a hook stops it, or the limit is reached. */
async function runRounds(state, profile) {
  while (state.rounds < state.limit && !profile.done()) {
    if (await runRound(state, profile)) break;
  }
}

/**
 * The bot's own weekly cap counts a turn, as it counts every turn of the
 * bot's. Only a turn on the bot's included OpenRouter key is debited (a key
 * of the person's own is theirs). Never throws.
 */
async function chargeTurn(pool, botId, costUsd, { what = 'a turn', category = 'homeroom-bot', deps = {} } = {}) {
  if (!(costUsd > 0) || !botId) return;
  try {
    const managed = deps.managedOpenRouter || require('./openrouter-managed-keys');
    if (await managed.usesIncludedKey(pool, botId)) {
      await (deps.limits || require('./limits')).recordSpend(pool, botId, Math.round(costUsd * 1e6) / 1e4, { byok: false });
    }
  } catch (err) {
    log.warn(category, `Could not record ${what}'s spend`, { err: err.message });
  }
}

module.exports = {
  runRound,
  runRounds,
  chargeTurn,
  resultText,
};
