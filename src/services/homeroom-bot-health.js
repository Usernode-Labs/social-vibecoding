'use strict';

// Rollout health, for the Homeroom bot's dashboard (#admin/homeroom-bot).
//
// An admin needs to see whether the bot is working, not only what it
// spent. Four figures over the last week, read off
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
//              reply-claims.js checkReply), and the ones nothing
//              could answer at all.
//
// And beside them (`rereads`, step 5 of docs/plans/bot-one-model.md, 11
// Nov 2026), the numbers that say whether it reads requests again less and
// says less twice: its reads per request, why it read, by week, how often a
// Main Chat answer had to be repaired, and the taps on its offers that found
// nothing to do (404) or an offer gone (410), by week. Notes said twice per
// request are counted once its posts carry their said-once keys (step 4):
// null until then.
//
// No new tables, and never a person's words: counts, durations and codes.
// A figure with too little behind it (under its threshold's `min`) shows its
// counts and no verdict, so a quiet week does not read as a broken one.

const log = require('./logger');

const DAYS = 7;
// The weeks `rereads` counts by week: this one and the three before it.
const WEEKS = 4;

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
  // Plan cards that fell back to the older unnumbered lines, rather than
  // showing their own (or their own lines without a failing summary).
  cardFallbacks: Object.freeze({ above: 0.2, min: 5 }),
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
    cardFallbacks: past(h.cards.total, share(h.cards.fallback, h.cards.total), THRESHOLDS.cardFallbacks, (v) => v > THRESHOLDS.cardFallbacks.above),
  };
}

/**
 * Step 5: the re-read numbers from their query rows (READS_SQL, one row;
 * READ_WHY_SQL and OFFER_TAPS_SQL, a row per week and code or surface),
 * with the Main Chat answers of the same window (`chat`, CHAT_SQL's
 * figures as shapeHealth reads them). Weeks newest first, only those with
 * something in them. Pure.
 */
function shapeRereads({ reads = {}, why = [], taps = [] } = {}, chat = {}, days = DAYS) {
  const readCount = int(reads.reads);
  const requests = int(reads.requests);
  const kinds = reads.kinds && typeof reads.kinds === 'object' && !Array.isArray(reads.kinds) ? reads.kinds : {};
  const weeks = new Map();
  const weekOf = (w) => {
    const key = String(w || '');
    if (!weeks.has(key)) weeks.set(key, { week: key, reads: 0, why: {}, taps: 0, notFound: 0, gone: 0, surfaces: {} });
    return weeks.get(key);
  };
  for (const r of Array.isArray(why) ? why : []) {
    const w = weekOf(r.week);
    const n = int(r.n);
    w.why[String(r.code || 'unknown')] = n;
    w.reads += n;
  }
  for (const r of Array.isArray(taps) ? taps : []) {
    const w = weekOf(r.week);
    const t = { taps: int(r.taps), notFound: int(r.not_found), gone: int(r.gone) };
    w.taps += t.taps;
    w.notFound += t.notFound;
    w.gone += t.gone;
    if (r.surface) w.surfaces[String(r.surface)] = t;
  }
  const recovered = int(chat.recovered);
  const chatTurns = int(chat.turns);
  return {
    days,
    weeks: WEEKS,
    // Runs that read a request (a triage read, or a reply turn on its
    // change), not a held verdict reused without a read, and of how many
    // requests; the runs that did not read one, by kind (fix, sync,
    // hand_off, retry: homeroom_bot_runs.look_kind).
    reads: readCount,
    requests,
    perRequest: share(readCount, requests),
    otherRuns: Object.fromEntries(Object.entries(kinds).map(([k, n]) => [k, int(n)])),
    byWeek: [...weeks.values()].filter((w) => w.week).sort((a, b) => b.week.localeCompare(a.week)),
    // Main Chat answers that were repaired: a request that failed or a claim
    // caught, and asked again (homeroom_bot_dm_turns), of all of them.
    claimRepair: { recovered, turns: chatTurns, rate: share(recovered, chatTurns) },
    // Step 4 counts these from its said-once keys (kind:subject:version).
    duplicateNotes: null,
  };
}

/** The five figures from their query rows. Pure. */
function shapeHealth({ proposals = {}, questions = {}, turns = {}, chat = {}, cards = {}, rereads = {} } = {}, days = DAYS) {
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
    cards: {
      total: int(cards.total),
      repaired: int(cards.repaired),
      whole: int(cards.whole),
      lines: int(cards.lines_only),
      fallback: int(cards.fallback),
      kinds: cards.kinds && typeof cards.kinds === 'object' && !Array.isArray(cards.kinds) ? cards.kinds : {},
    },
  };
  return { ...h, watch: watchFor(h), thresholds: THRESHOLDS, rereads: shapeRereads(rereads, chat, days) };
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

// Its plan cards that failed a check (#6269): how many were repaired, how
// many kept their numbered lines without a failing summary, how many fell
// back to the older unnumbered lines, and each rule that broke, by code
// (events BOT_PLAN_CARD, homeroom-bot-live.js draftSpec).
const CARDS_SQL = `
  WITH cards AS (
    SELECT metadata
      FROM events
     WHERE event_type = 'bot_plan_card'
       AND created_at >= NOW() - make_interval(days => $1::int)
  )
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE metadata->>'repaired' = 'true')::int AS repaired,
         COUNT(*) FILTER (WHERE metadata->>'used' = 'whole')::int AS whole,
         COUNT(*) FILTER (WHERE metadata->>'used' = 'lines')::int AS lines_only,
         COUNT(*) FILTER (WHERE metadata->>'used' = 'fallback')::int AS fallback,
         COALESCE(
           (SELECT jsonb_object_agg(kind, n)
              FROM (SELECT k AS kind, COUNT(*)::int AS n
                      FROM cards c, LATERAL jsonb_array_elements_text(COALESCE(c.metadata->'kinds', '[]'::jsonb)) AS k
                     GROUP BY k) per_kind),
           '{}'::jsonb) AS kinds
    FROM cards`;

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

// Step 5: its reads over the window. A read is a run that read its request
// (a triage read, or a reply turn on its change: look_kind is null), never a
// held verdict reused without one (reused_run_id); with how many requests
// they were of, and the runs that read none, by their kind.
const READS_SQL = `
  SELECT COUNT(*) FILTER (WHERE look_kind IS NULL)::int AS reads,
         COUNT(DISTINCT (app_id, issue_number)) FILTER (WHERE look_kind IS NULL)::int AS requests,
         COALESCE(
           (SELECT jsonb_object_agg(kind, n)
              FROM (SELECT k.look_kind AS kind, COUNT(*)::int AS n
                      FROM homeroom_bot_runs k
                     WHERE k.created_at >= NOW() - make_interval(days => $1::int)
                       AND k.reused_run_id IS NULL AND k.look_kind IS NOT NULL
                     GROUP BY k.look_kind) per_kind),
           '{}'::jsonb) AS kinds
    FROM homeroom_bot_runs
   WHERE created_at >= NOW() - make_interval(days => $1::int)
     AND reused_run_id IS NULL`;

// Why it read, by week: each read's read_reason code (homeroom-bot.js
// readReasonOf: checks_failing, changed:discussion, changed:voice, new, ...),
// this week and the WEEKS - 1 before it.
const READ_WHY_SQL = `
  SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
         COALESCE(read_reason, 'unknown') AS code,
         COUNT(*)::int AS n
    FROM homeroom_bot_runs
   WHERE created_at >= date_trunc('week', NOW()) - make_interval(weeks => $1::int - 1)
     AND reused_run_id IS NULL AND look_kind IS NULL
   GROUP BY 1, 2`;

// The taps on its offers and cards, by week and where they were (events
// BOT_OFFER_TAP, written by the three routes that take them), and those
// answered 404 (nothing to decide) or 410 (the offer gone or expired).
const OFFER_TAPS_SQL = `
  SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
         COALESCE(metadata->>'surface', '') AS surface,
         COUNT(*)::int AS taps,
         COUNT(*) FILTER (WHERE metadata->>'status' = '404')::int AS not_found,
         COUNT(*) FILTER (WHERE metadata->>'status' = '410')::int AS gone
    FROM events
   WHERE event_type = 'bot_offer_tap'
     AND created_at >= date_trunc('week', NOW()) - make_interval(weeks => $1::int - 1)
   GROUP BY 1, 2`;

/**
 * The dashboard's rollout health. Each figure fails soft on its own, to
 * zeros, like the rest of the dashboard's reads. With `failSoft: false` a
 * failed read rejects instead: the platform signals' observer
 * (signal-observers/bot-health.js) must not read a zero it could not look
 * at as a figure back within its line. The re-read numbers watch nothing,
 * so they always read soft.
 */
async function rolloutHealth(pool, { botUsername, days = DAYS, failSoft = true } = {}) {
  // Each query names its SQL constant where it is called, so
  // scripts/check-sql.js resolves and checks it against the schema.
  const read = async (name, query, { all = false, soft = failSoft } = {}) => {
    try {
      const { rows } = await query();
      return all ? rows : rows[0] || {};
    } catch (err) {
      log.warn('homeroom-bot', 'Rollout health read failed', { figure: name, err: err.message });
      if (!soft) throw err;
      return all ? [] : {};
    }
  };
  const [proposals, questions, turns, chat, cards, reads, why, taps] = await Promise.all([
    read('proposals', () => pool.query(PROPOSALS_SQL, [botUsername, days])),
    read('questions', () => pool.query(QUESTIONS_SQL, [days])),
    read('turns', () => pool.query(TURNS_SQL, [days])),
    read('chat', () => pool.query(CHAT_SQL, [days])),
    read('cards', () => pool.query(CARDS_SQL, [days])),
    read('reads', () => pool.query(READS_SQL, [days]), { soft: true }),
    read('read_why', () => pool.query(READ_WHY_SQL, [WEEKS]), { all: true, soft: true }),
    read('offer_taps', () => pool.query(OFFER_TAPS_SQL, [WEEKS]), { all: true, soft: true }),
  ]);
  return shapeHealth({ proposals, questions, turns, chat, cards, rereads: { reads, why, taps } }, days);
}

module.exports = {
  DAYS,
  WEEKS,
  THRESHOLDS,
  share,
  watchFor,
  shapeRereads,
  shapeHealth,
  rolloutHealth,
};
