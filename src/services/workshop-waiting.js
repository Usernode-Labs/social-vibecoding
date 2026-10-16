'use strict';

// #4772: what Homeroom bot is waiting on ONE viewer for, on one project, for
// the Workshop tab's "Waiting on you" (AppView._workshopView). Two kinds:
//
//   - plans: the bot's plan for a request of theirs (homeroom_bot_requesters)
//     that waits for their Build it: the request's newest run has
//     awaiting_go_at set and nothing built from it yet, the same reading
//     homeroom-bot-progress.js stageOf calls the 'plan' stage. A plan nobody
//     taps for a week stops waiting (homeroom-bot.js settleStalePlans), and
//     then it is not listed.
//   - questions: a question the bot asked them in their DM about a request
//     that is still open (homeroom_bot_dm_messages.question_status). A
//     question on the request's own discussion rides the request list as
//     `botAwaits` already (homeroom-bot-addressed.js waitingOn).
//
// A back and forth with the bot on a change or a request is not listed
// (#5229): whoever spoke last, the viewer is not the one being waited on.
// When they wrote last it is the bot's turn, and when the bot did, a real
// question is already one of the kinds above.
//
// Only the viewer's own: every row is a request recorded as theirs or a
// question asked of them. Never throws: a read that fails is nothing
// waiting, never a failed board.

const log = require('./logger');

/** The most of each kind one answer carries. */
const MAX_EACH = 10;

const PLANS_SQL = `
  SELECT q.issue_number, run.awaiting_go_at AS at
    FROM homeroom_bot_requesters q
    JOIN LATERAL (
      SELECT awaiting_go_at, build_ok, build_session_id, proposal_session_id
        FROM homeroom_bot_runs
       WHERE app_id = q.app_id AND issue_number = q.issue_number
       ORDER BY id DESC LIMIT 1
    ) run ON TRUE
   WHERE q.app_id = $1 AND q.user_id = $2
     AND run.awaiting_go_at IS NOT NULL AND run.build_ok IS NULL
     AND run.build_session_id IS NULL AND run.proposal_session_id IS NULL
   ORDER BY run.awaiting_go_at DESC
   LIMIT $3`;

const QUESTIONS_SQL = `
  SELECT issue_number, MAX(created_at) AS at
    FROM homeroom_bot_dm_messages
   WHERE app_id = $1 AND user_id = $2 AND question_status = 'open'
   GROUP BY issue_number
   ORDER BY at DESC
   LIMIT $3`;

const iso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);

/** Nothing waiting. */
function none() {
  return { plans: [], questions: [] };
}

/**
 * What the bot waits on `userId` for on `appId` ({ plans, questions },
 * newest first).
 */
async function waitingOnViewer(pool, { appId, userId }) {
  const out = none();
  if (!appId || !userId) return out;
  try {
    const { rows: plans } = await pool.query(PLANS_SQL, [appId, userId, MAX_EACH]);
    out.plans = plans.map((r) => ({ number: Number(r.issue_number), at: iso(r.at) }));
    const { rows: questions } = await pool.query(QUESTIONS_SQL, [appId, userId, MAX_EACH]);
    out.questions = questions.map((r) => ({ number: Number(r.issue_number), at: iso(r.at) }));
  } catch (err) {
    log.warn('workshop', 'Could not read what Homeroom bot waits on the viewer for', { appId, err: err.message });
    return none();
  }
  return out;
}

/**
 * The ?demo=1 staging answer (routes/issues.js): one of each on the mock
 * requests, so the Workshop's Waiting on you is reviewable in a preview: a
 * plan on 900016 and a question on 900015.
 */
function demoWaiting(now = Date.now()) {
  const ago = (h) => new Date(now - h * 3600 * 1000).toISOString();
  return {
    plans: [{ number: 900016, at: ago(1) }],
    questions: [{ number: 900015, at: ago(3) }],
  };
}

module.exports = { MAX_EACH, waitingOnViewer, demoWaiting, PLANS_SQL, QUESTIONS_SQL };
