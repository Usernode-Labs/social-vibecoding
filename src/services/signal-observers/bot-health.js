'use strict';

// bot_health: a figure of the Homeroom bot's rollout health past its line,
// one item per figure (services/homeroom-bot-health.js, the panel Admin ›
// Homeroom bot shows).
//
// The health service already says, for each figure over the last 7 days,
// whether it is past its line (watchFor: true), within it (false), or has
// too little behind it to say (null, under its threshold's `min`). Only
// `true` is a problem: a quiet week is not a broken one.
//
// The dashboard reads each figure soft, to zeros, so it still draws when
// one query fails. Here a zero would read as "fine" and clear a problem
// that is still there, so the observer reads them with `failSoft: false`:
// a pass that could not look throws, and clears nothing.
//
// Everything said is typed: rates, counts, hours and the lines.

const health = require('../homeroom-bot-health');

const BOT_USERNAME = 'homeroom_bot';

const pct = (v) => `${Math.round(v * 100)}%`;
const hours = (v) => `${Math.round(v * 10) / 10} hours`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Each figure: what it is called, its value and line in words, its sample,
// and what being past it means. `t` is its threshold, `h` the health.
const FIGURES = Object.freeze({
  mergeRate: {
    title: (t) => `proposals merging below ${pct(t.below)}`,
    value: (h) => `${h.proposals.merged} of ${plural(h.proposals.settled, 'settled proposal', 'settled proposals')} merged (${pct(h.proposals.mergeRate)})`,
    line: (t) => `below ${pct(t.below)}`,
    sample: (h) => plural(h.proposals.settled, 'settled proposal', 'settled proposals'),
    unit: 'settled proposals',
    detail: (h) => `${h.proposals.up} put up: ${h.proposals.merged} merged, ${h.proposals.closed} closed without merging, ${h.proposals.open} still open.`,
    summary: 'Fewer than half of the bot\'s settled proposals merged over the last week. The closed ones say what the groups turned down.',
  },
  hoursToProposal: {
    title: (t) => `request to proposal above ${t.above} hours`,
    value: (h) => `the median from a request to its proposal was ${hours(h.proposals.medianHoursToProposal)}`,
    line: (t) => `above ${t.above} hours`,
    sample: (h) => plural(h.proposals.timed, 'timed proposal', 'timed proposals'),
    unit: 'timed proposals',
    detail: (h) => (h.proposals.slowestHoursToProposal == null ? null : `The slowest took ${hours(h.proposals.slowestHoursToProposal)}.`),
    summary: 'Half of the bot\'s proposals took more than a day from the request. The queue and the builds say where the time went.',
  },
  questionsWaiting: {
    title: (t) => `questions waiting above ${pct(t.above)}`,
    value: (h) => `${h.questions.waitingOfAsked} of ${plural(h.questions.asked, 'question', 'questions')} asked are still waiting (${pct(health.share(h.questions.waitingOfAsked, h.questions.asked))})`,
    line: (t) => `above ${pct(t.above)}`,
    sample: (h) => plural(h.questions.asked, 'question', 'questions'),
    unit: 'questions',
    detail: (h) => `${h.questions.answered} answered, ${h.questions.settledOtherwise} settled another way; ${h.questions.waiting} waiting in all.`,
    summary: 'More than half of the questions the bot asked this week are still waiting on an answer.',
  },
  turnFailures: {
    title: (t) => `turn failures above ${pct(t.above)}`,
    value: (h) => {
      const all = h.turns.runs + h.turns.builds;
      const failed = h.turns.failed + h.turns.buildsFailed;
      return `${failed} of ${plural(all, 'turn', 'turns')} failed (${pct(health.share(failed, all))})`;
    },
    line: (t) => `above ${pct(t.above)}`,
    sample: (h) => plural(h.turns.runs + h.turns.builds, 'turn', 'turns'),
    unit: 'turns',
    detail: (h) => `${h.turns.failed} of ${plural(h.turns.runs, 'triage and follow-up turn', 'triage and follow-up turns')}, `
      + `${h.turns.buildsFailed} of ${plural(h.turns.builds, 'build', 'builds')}. A turn stopped on its budget is not counted.`,
    summary: 'More than 1 in 10 of the bot\'s turns failed over the last week. Admin › Homeroom bot › Verdicts, filtered to Failed, has the errors.',
  },
  chatFailures: {
    title: (t) => `DM answer failures above ${pct(t.above)}`,
    value: (h) => `${h.chat.failed} of ${plural(h.chat.turns, 'DM answer', 'DM answers')} could not be written (${pct(health.share(h.chat.failed, h.chat.turns))})`,
    line: (t) => `above ${pct(t.above)}`,
    sample: (h) => plural(h.chat.turns, 'DM answer', 'DM answers'),
    unit: 'DM answers',
    detail: (h) => `${h.chat.unanswered} answered by nothing at all, ${h.chat.recovered} answered after a retry, `
      + `${h.chat.claimsCaught} said it had done something it had not and were written again.`,
    summary: 'More than 1 in 10 of the bot\'s DM answers could not be written over the last week.',
  },
});

/** The items for the figures past their lines. Pure. */
function healthItems(h) {
  const items = [];
  for (const [figure, f] of Object.entries(FIGURES)) {
    if (h?.watch?.[figure] !== true) continue;
    const t = health.THRESHOLDS[figure];
    items.push({
      kind: 'bot_health',
      key: figure,
      topic: 'homeroom-bot',
      subject: { figure },
      title: `Homeroom bot health: ${f.title(t)}`,
      summary: `${f.summary} Admin › Homeroom bot (Rollout health) shows the figure.`,
      evidence: {
        lines: [
          `Over the last ${plural(h.days, 'day', 'days')}, ${f.value(h)}.`,
          `Its line is ${f.line(t)}, judged from ${t.min} ${f.unit} or more; this is from ${f.sample(h)}.`,
          f.detail(h),
        ].filter(Boolean),
        where: ['src/services/homeroom-bot-health.js'],
      },
    });
  }
  return items;
}

async function run(pool) {
  return healthItems(await health.rolloutHealth(pool, { botUsername: BOT_USERNAME, failSoft: false }));
}

module.exports = { run, healthItems, FIGURES, BOT_USERNAME };
