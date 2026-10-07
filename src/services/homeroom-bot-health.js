'use strict';

// Rollout health, for the Homeroom bot's dashboard (#admin/homeroom-bot).
//
// Before the bot is on for everyone, an admin needs to see whether it is
// working, not only what it spent. Four figures over the last week, read off
// what the bot already records, each with the line past which it is worth a
// look (THRESHOLDS):
//
//   proposals  what became of the proposals it put up: merged, closed
//              without merging, still open; and how long a request waited
//              from being filed to the bot's proposal going up.
//   questions  the questions it asked in DMs: answered, settled another
//              way, still waiting; and the oldest still waiting, whenever
//              it was asked.
//   turns      its triage and build turns that failed.
//   chat       its DM answers that the model could not write, the ones that
//              said something the turn had not done (caught and redone,
//              homeroom-bot-mayor.js claimProblems), and the ones nothing
//              could answer at all.
//
// No new tables, and never a person's words: counts, durations and codes.
// A figure with too little behind it (under its threshold's `min`) shows its
// counts and no verdict, so a quiet week does not read as a broken one.

const log = require('./logger');

const DAYS = 7;

const THRESHOLDS = Object.freeze({
  // Settled proposals (merged or closed) that merged.
  mergeRate: Object.freeze({ below: 0.5, min: 4 }),
  // Median hours from a request being filed to the bot's proposal for it.
  hoursToProposal: Object.freeze({ above: 24, min: 3 }),
  // The week's questions still waiting on an answer.
  questionsWaiting: Object.freeze({ above: 0.5, min: 4 }),
  // Triage, follow-up and build turns that failed (a budget stop is not one).
  turnFailures: Object.freeze({ above: 0.1, min: 10 }),
  // DM answers the model could not write.
  chatFailures: Object.freeze({ above: 0.1, min: 10 }),
});

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v) => num(v) || 0;

/** `part / whole`, or null when there is no whole. Pure. */
function share(part, whole) {
  return whole > 0 ? part / whole : null;
}

/**
 * Whether each figure is past its line: true, false, or null when it has
 * too little behind it to say. Pure.
 */
function watchFor(h) {
  const past = (n, value, t, cmp) => (n < t.min || value == null ? null : cmp(value));
  return {
    mergeRate: past(h.proposals.settled, h.proposals.mergeRate, THRESHOLDS.mergeRate, (v) => v < THRESHOLDS.mergeRate.below),
    hoursToProposal: past(h.proposals.timed, h.proposals.medianHoursToProposal, THRESHOLDS.hoursToProposal,
      (v) => v > THRESHOLDS.hoursToProposal.above),
    questionsWaiting: past(h.questions.asked, share(h.questions.waitingOfAsked, h.questions.asked), THRESHOLDS.questionsWaiting,
      (v) => v > THRESHOLDS.questionsWaiting.above),
    turnFailures: past(h.turns.runs + h.turns.builds, share(h.turns.failed + h.turns.buildsFailed, h.turns.runs + h.turns.builds),
      THRESHOLDS.turnFailures, (v) => v > THRESHOLDS.turnFailures.above),
    chatFailures: past(h.chat.turns, share(h.chat.failed, h.chat.turns), THRESHOLDS.chatFailures, (v) => v > THRESHOLDS.chatFailures.above),
  };
}

/** The four figures from their query rows. Pure. */
function shapeHealth({ proposals = {}, questions = {}, turns = {}, chat = {} } = {}, days = DAYS) {
  const up = int(proposals.up);
  const merged = int(proposals.merged);
  const open = int(proposals.open);
  const closed = Math.max(0, up - merged - open);
  const median = num(proposals.median_secs);
  const slowest = num(proposals.slowest_secs);
  const h = {
    days,
    proposals: {
      up,
      merged,
      closed,
      open,
      settled: merged + closed,
      mergeRate: share(merged, merged + closed),
      timed: int(proposals.timed),
      medianHoursToProposal: median == null ? null : median / 3600,
      slowestHoursToProposal: slowest == null ? null : slowest / 3600,
    },
    questions: {
      asked: int(questions.asked),
      answered: int(questions.answered),
      settledOtherwise: int(questions.closed),
      waitingOfAsked: int(questions.waiting_of_asked),
      medianMinutesToAnswer: num(questions.median_answer_secs) == null ? null : num(questions.median_answer_secs) / 60,
      waiting: int(questions.waiting),
      oldestWaitingAt: questions.oldest_waiting_at ? new Date(questions.oldest_waiting_at).toISOString() : null,
    },
    turns: {
      runs: int(turns.runs),
      failed: int(turns.failed),
      builds: int(turns.builds),
      buildsFailed: int(turns.builds_failed),
    },
    chat: {
      turns: int(chat.turns),
      failed: int(chat.failed),
      unanswered: int(chat.broken),
      recovered: int(chat.recovered),
      claimsCaught: int(chat.claims),
    },
  };
  return { ...h, watch: watchFor(h), thresholds: THRESHOLDS };
}

// The bot's proposals put up in the window, as chat_sessions it owns that
// went through /promote (promoted_at); each one's request is read off the
// runs that point at it. 'promoted' and 'merging' are still up for a vote,
// as openBotProposalTotal counts them, and 'active' is one being worked on
// again before it is proposed again: not settled either. Anything else that
// is not merged was closed without merging: withdrawn (archived), or closed
// on GitHub (paused, routes/votes.js).
const PROPOSALS_SQL = `
  WITH props AS (
    SELECT cs.status, cs.promoted_at,
           (SELECT MIN(i.created_at)
              FROM homeroom_bot_runs pr
              JOIN issues i ON i.app_id = pr.app_id AND i.github_issue_number = pr.issue_number
             WHERE pr.proposal_session_id = cs.id) AS filed_at
      FROM chat_sessions cs
      JOIN users u ON u.id = cs.user_id
     WHERE u.username = $1 AND u.is_synthetic = TRUE
       AND cs.promoted_at >= NOW() - make_interval(days => $2::int)
  )
  SELECT COUNT(*)::int AS up,
         COUNT(*) FILTER (WHERE status = 'merged')::int AS merged,
         COUNT(*) FILTER (WHERE status IN ('promoted', 'merging', 'active'))::int AS open,
         COUNT(*) FILTER (WHERE promoted_at >= filed_at)::int AS timed,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM promoted_at - filed_at))
           FILTER (WHERE promoted_at >= filed_at))::float8 AS median_secs,
         (MAX(EXTRACT(EPOCH FROM promoted_at - filed_at)) FILTER (WHERE promoted_at >= filed_at))::float8 AS slowest_secs
    FROM props`;

// The questions it asked in DMs (homeroom_bot_dm_messages, a question is a
// row with question_status): the window's, by how they ended, and every one
// still open, however old.
const QUESTIONS_SQL = `
  SELECT COUNT(*) FILTER (WHERE created_at >= NOW() - make_interval(days => $1::int))::int AS asked,
         COUNT(*) FILTER (WHERE created_at >= NOW() - make_interval(days => $1::int) AND question_status = 'answered')::int AS answered,
         COUNT(*) FILTER (WHERE created_at >= NOW() - make_interval(days => $1::int) AND question_status = 'closed')::int AS closed,
         COUNT(*) FILTER (WHERE created_at >= NOW() - make_interval(days => $1::int) AND question_status = 'open')::int AS waiting_of_asked,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM answered_at - created_at))
           FILTER (WHERE created_at >= NOW() - make_interval(days => $1::int) AND question_status = 'answered'
                     AND answered_at >= created_at))::float8 AS median_answer_secs,
         COUNT(*) FILTER (WHERE question_status = 'open')::int AS waiting,
         MIN(created_at) FILTER (WHERE question_status = 'open') AS oldest_waiting_at
    FROM homeroom_bot_dm_messages
   WHERE question_status IS NOT NULL`;

// Its turns: a failed verdict that was not a budget stop (as the totals
// count it), and the builds that finished, by whether they worked.
const TURNS_SQL = `
  SELECT COUNT(*)::int AS runs,
         COUNT(*) FILTER (WHERE verdict = 'failed' AND budget_stop IS NULL)::int AS failed,
         COUNT(*) FILTER (WHERE build_ok IS NOT NULL)::int AS builds,
         COUNT(*) FILTER (WHERE build_ok = FALSE)::int AS builds_failed
    FROM homeroom_bot_runs
   WHERE created_at >= NOW() - make_interval(days => $1::int)`;

// Its DM answers (homeroom_bot_dm_turns): `error` is why the model could
// not write one, and a fallback answered instead; 'broken' is the fallback
// that could not answer either. A claims:* failure is a reply that said
// something the turn had not done, caught and asked again.
const CHAT_SQL = `
  SELECT COUNT(*)::int AS turns,
         COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS failed,
         COUNT(*) FILTER (WHERE fallback = 'broken')::int AS broken,
         COUNT(*) FILTER (WHERE error IS NULL AND cardinality(failures) > 0)::int AS recovered,
         COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(failures) AS f(code) WHERE f.code LIKE 'claims:%'))::int AS claims
    FROM homeroom_bot_dm_turns
   WHERE created_at >= NOW() - make_interval(days => $1::int)`;

/**
 * The dashboard's rollout health. Each figure fails soft on its own, to
 * zeros, like the rest of the dashboard's reads.
 */
async function rolloutHealth(pool, { botUsername, days = DAYS } = {}) {
  // Each query names its SQL constant where it is called, so
  // scripts/check-sql.js resolves and checks it against the schema.
  const read = async (name, query) => {
    try {
      const { rows } = await query();
      return rows[0] || {};
    } catch (err) {
      log.warn('homeroom-bot', 'Rollout health read failed', { figure: name, err: err.message });
      return {};
    }
  };
  const [proposals, questions, turns, chat] = await Promise.all([
    read('proposals', () => pool.query(PROPOSALS_SQL, [botUsername, days])),
    read('questions', () => pool.query(QUESTIONS_SQL, [days])),
    read('turns', () => pool.query(TURNS_SQL, [days])),
    read('chat', () => pool.query(CHAT_SQL, [days])),
  ]);
  return shapeHealth({ proposals, questions, turns, chat }, days);
}

module.exports = {
  DAYS,
  THRESHOLDS,
  share,
  watchFor,
  shapeHealth,
  rolloutHealth,
};
