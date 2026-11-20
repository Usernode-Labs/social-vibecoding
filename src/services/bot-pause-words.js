'use strict';

// What Homeroom bot says to people while OpenRouter refuses its key, when
// the cause is its weekly budget.
//
// The one stored outage (services/openrouter-credit.js) says which of two
// figures ran out: the account's CREDIT, or the bot's weekly BUDGET (its
// key's own limit, which starts again every Monday). To the people waiting
// on the bot they are different things. "I'm out of building credit, an
// admin has been told" is right when somebody has to add money. It is wrong
// for a budget that comes back by itself on a day everybody can name, and
// it sent admins to add credit to an account that had $1,900 in it.
//
// Every surface keeps its credit wording where it has always been (each has
// tests pinning it). This module holds the budget wording of each, so the
// two cannot drift between surfaces, and the one question they all ask:
// which cause is it? Asked of whatever the surface already has in hand: the
// answer `noteOutage` gave the turn that met the refusal, or `creditState`,
// the stored outage as every turn reads it before calling a model.
//
// The day is the real one: the day the bot's week turns
// (services/limits.js weeklyResetAt, Monday 00:00 UTC, which is also its
// key's weekly reset at OpenRouter), named in UTC because a stored message
// has no one reader's time zone.

const BUDGET = 'budget';

/** The day the bot's week turns, by name ("Monday"). Pure but for the clock it is handed. */
function resetDay(now = new Date()) {
  const at = new Date(require('./limits').weeklyResetAt(now));
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(at);
}

/** Pure: whether an answer of `noteOutage` or `creditState` says the weekly budget ran out. */
function isBudget(answer) {
  return !!answer && answer.cause === BUDGET;
}

/**
 * Whether the pause standing now is the weekly budget's. `credit` is the
 * credit module, or the stand-in a caller was handed in its place: one with
 * no `creditState` of its own is not asked (and the store is not read
 * behind its back), which answers false, the credit wording. Never throws.
 */
async function budgetNow(pool, credit = null) {
  try {
    const source = credit || require('./openrouter-credit');
    if (typeof source.creditState !== 'function') return false;
    const state = await source.creditState(pool);
    return !!state && state.out === true && state.cause === BUDGET;
  } catch {
    return false;
  }
}

// "on Monday, or sooner if an admin raises it": when it comes back.
const back = (day) => `on ${day}, or sooner if an admin raises it`;
const USED_UP = 'I\'ve used up this week\'s building budget';

// The chat with the bot (homeroom-bot-mayor.js CREDIT_TEXT and the two lines
// its last try says). No "an admin has been told": nothing is broken, and
// the day is the answer.
const chat = Object.freeze({
  now: (day) => `${USED_UP}, so I couldn't answer yet. I'll answer this here ${back(day)}; you don't need to send it again.`,
  gaveUp: (day) => `This week's building budget is still used up, so I couldn't answer your message above yet. I'll answer it here ${back(day)}.`,
  gaveUpOwed: (day) => 'This week\'s building budget is still used up, so I couldn\'t answer your message above, '
    + `or the ones you sent before it that I said I'd come back to. I'll answer them all here ${back(day)}.`,
});

// A project's thread (homeroom-bot-voice.js HELD_TEXT, #6920): the ask is
// kept and answered once the key can spend again.
const threadHeld = (day) => `${USED_UP}. I'll answer this here ${back(day)}.`;

// A look (homeroom-bot-thread-tools/look-into.js). LOOK_HELD opens a held
// look's stored words, which is how one is told from a look that failed
// (isHeldLook), so both openings are read there.
const LOOK_HELD = USED_UP;
const lookHeldText = (project, day) => `${LOOK_HELD}, so I couldn't look into it in ${project} yet. `
  + `I'll run the look and post what I find here ${back(day)}.`;
const lookRefused = (what, day) => `Homeroom bot has used up this week's building budget, so it cannot ${what}. `
  + `Ask again on ${day}, or sooner if an admin raises it.`;
const LOOK_NOTE = 'say in one short line that the look runs once this week\'s building budget starts again, or an admin raises it, and is posted here';

// An update of somebody's change (homeroom-bot-takeover.js CREDIT_WHY): a
// clause, "I couldn't make that change: <why>."
const TAKEOVER_WHY = `${USED_UP}, so nothing was changed`;

// A request's own page and its GitHub issue, about the bot
// (homeroom-bot-live.js buildCreditText); homeroom-bot-words.js says the
// same in the bot's own voice where Homeroom shows it.
const buildNote = ({ queued = true } = {}, day) => (queued
  ? `Homeroom bot has used up this week's building budget. It will pick this up again by itself on ${day}, or sooner if an admin raises the budget.`
  : 'Homeroom bot has used up this week\'s building budget, and it could not keep this request\'s place in line. '
    + `On ${day}, or once an admin raises the budget, reply here and it will build this.`);

// The note in the requester's chat and on the request, when a build or an
// update stopped for it (homeroom-bot-dm.js FAILED_SAID `credit`).
const stopped = Object.freeze({
  me: (d, it, day) => `I used up this week's building budget while ${d.starting} ${it}. I'll pick it up again by myself ${back(day)}.`,
  bot: (d, it, day) => `Homeroom bot used up this week's building budget while ${d.starting} ${it}. `
    + `It picks it up again by itself on ${day}, or sooner if an admin raises the budget.`,
});

// The bell and the push for that note (homeroom-bot-notify-copy.js
// `build_budget`, beside `build_credit`).
const notify = (day) => `Paused: I've used up this week's building budget. I'll pick it up again on ${day}.`;

// A check-in of a longer investigation that did not run
// (homeroom-bot-thread-tools/investigate.js SKIP_LINES).
const CHECKIN_SKIPPED = 'Skipped: Homeroom bot has used up this week\'s building budget.';

// A platform turn that is not the bot's own and is paid with the same key
// (openrouter-messages.js platformKey): the before and after shots of a
// change, and the turn that resolves a change's conflicts with main. Each
// used to end as "stopped with an error" or "ended without a result (exit
// 1)" when the key was refused, which told its reader nothing true.
const PLATFORM_TURNS = Object.freeze({
  shots: Object.freeze({
    budget: (day) => 'Homeroom\'s building budget for this week is used up, so the before and after shots could not be taken. '
      + `They can be taken again on ${day}, or once an admin raises the budget.`,
    credit: 'Homeroom\'s AI credit ran out, so the before and after shots could not be taken. '
      + 'They can be taken again once an admin adds credit.',
  }),
  sync: Object.freeze({
    budget: (day) => 'Homeroom\'s building budget for this week is used up, so the conflicts with main could not be resolved. '
      + `Sync again on ${day}, or once an admin raises the budget.`,
    credit: 'Homeroom\'s AI credit ran out, so the conflicts with main could not be resolved. '
      + 'Sync again once an admin adds credit.',
  }),
});

/**
 * Pure: what such a turn says when its result shows the provider refused the
 * key, or null when it failed for any other reason. The refusal is read as
 * every bot turn's is (openrouter-credit.js creditOut: the worker's own
 * codes and the runtime's error notice, never the model's words). `budget`
 * is the stored outage's cause when the caller has read it (budgetNow); the
 * refusal's own words decide when they name the key's limit.
 */
function platformTurnRefused(result, kind, { budget = false, now = new Date() } = {}) {
  const words = PLATFORM_TURNS[kind];
  const credit = require('./openrouter-credit');
  if (!words || !result || !credit.creditOut(result)) return null;
  return budget || credit.refusalCause(result) === BUDGET ? words.budget(resetDay(now)) : words.credit;
}

module.exports = {
  BUDGET,
  platformTurnRefused,
  resetDay,
  isBudget,
  budgetNow,
  chat,
  threadHeld,
  LOOK_HELD,
  lookHeldText,
  lookRefused,
  LOOK_NOTE,
  TAKEOVER_WHY,
  buildNote,
  stopped,
  notify,
  CHECKIN_SKIPPED,
};
