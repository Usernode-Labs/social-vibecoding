'use strict';

// A first version's timeline (newcomer run five, 13 October 2026): one
// `events` row (event_type 'first_version_stage') each time a project's
// first version moves to a new stage, written by the pipeline at the moment
// it moves, never worked out afterwards from a read. Run five's timings
// (when the plan was written, when the build took its slot, when each
// review round began, when it went live) could only be pieced together from
// screenshots and a polling watcher; these rows are what a run report reads
// instead. `metadata.stage` is one of STAGES:
//
//   plan_written      its plan exists: written at Make it (source 'make_it',
//                     first-version-plan.js startEarlyPlan, before there is a
//                     run), or by the triage of its request (source
//                     'triage', homeroom-bot.js awaitGo). { source, questions }
//   go_ahead          Build it, or the made screen's Submit (goAhead).
//                     { answers: how many were chosen }
//   picked_up         its build took its slot (buildLive's claim on the run).
//                     { waitedMs: since the go-ahead, runs.go_ahead_at }
//   spec_started      the spec turn is dispatched: the screens are drawn
//   first_look_saved  its first look was drawn and kept
//                     (first-version-screens.js). { from: 'saved_screen' |
//                     'spec' }; or its EARLY first look, drawn from the plan
//                     at Make it before there is a run
//                     (first-version-early-look.js). { from: 'early',
//                     drawMs: the drawing, ms: drawing and picture }
//   build_started     the build turn is dispatched
//   build_done        the build turn (and any nudge) pushed. { partial }
//   review_round      a review round began (homeroom-bot-live.js
//                     reviewLanded). { round, rounds }
//   testing_started   it was proposed, so its checks start. { prNumber,
//                     recovered: proposed by restart recovery }
//   merged            its proposal merged (homeroom-bot-dm.js
//                     noteProposalMerged)
//   live              its app answered on the build that was deployed.
//                     { late: answered on a later look, not at the merge }
//
// Every row also carries { runId, issueNumber } (no runId for a plan written
// at Make it or an early first look), the first version's maker as user_id and its project as
// app_id, and, where there is one, the build's session as session_id.
//
// Only a first version's: the insert reads the run's first-version row, so a
// run that is not one writes nothing. Nothing private: stages, numbers and
// the platform's own short codes, never what anybody wrote. Best effort: it
// never throws, and a row that could not be written is a debug line, never a
// change to the build.

const events = require('./events');
const log = require('./logger');

const STAGES = Object.freeze([
  'plan_written', 'go_ahead', 'picked_up', 'spec_started', 'first_look_saved', 'build_started',
  'build_done', 'review_round', 'testing_started', 'merged', 'live',
]);

// The build's step boundaries (homeroom-bot-live.js buildAndPropose's
// `onStep`, homeroom-bot-checkpoint.js STEPS) that are stages.
const STAGE_OF_STEP = Object.freeze({
  spec_turn: 'spec_started',
  build_turn: 'build_started',
  landed: 'build_done',
  proposed: 'testing_started',
});

const BY_RUN_SQL = `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
  SELECT f.user_id, f.app_id, $2::int, $3::text,
         $4::jsonb || jsonb_build_object('runId', r.id, 'issueNumber', r.issue_number)
    FROM homeroom_bot_runs r
    JOIN homeroom_bot_first_versions f
      ON f.app_id = r.app_id AND f.issue_number = r.issue_number AND f.bot_builds
   WHERE r.id = $1::int AND r.mode = 'live'
  RETURNING id`;

const BY_APP_SQL = `INSERT INTO events (user_id, app_id, event_type, metadata)
  SELECT f.user_id, f.app_id, $2::text, $3::jsonb || jsonb_build_object('issueNumber', f.issue_number)
    FROM homeroom_bot_first_versions f
   WHERE f.app_id = $1::int AND f.bot_builds
  RETURNING id`;

const DETAIL_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const DETAIL_CODE_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Pure: a stage's detail kept to what the timeline may hold: finite numbers,
 * booleans and short lower-case codes, under plain keys. Anything else is
 * left out.
 */
function cleanDetail(detail) {
  const out = {};
  if (!detail || typeof detail !== 'object') return out;
  for (const [key, value] of Object.entries(detail)) {
    if (!DETAIL_KEY_RE.test(key) || key === 'stage' || key === 'runId' || key === 'issueNumber') continue;
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && DETAIL_CODE_RE.test(value)) out[key] = value;
  }
  return out;
}

function positive(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Record that a first version reached `stage`: by its run (`runId`), or,
 * for a plan written at Make it, by its project (`appId`). Resolves whether
 * a row was written; never throws.
 */
async function record(pool, { runId = null, appId = null, stage, sessionId = null, detail = null } = {}) {
  try {
    if (!pool || !STAGES.includes(stage)) return false;
    const run = positive(runId);
    const app = positive(appId);
    if (!run && !app) return false;
    const metadata = JSON.stringify({ ...cleanDetail(detail), stage });
    const { rows } = run
      ? await pool.query(BY_RUN_SQL, [run, positive(sessionId), events.EVENT_TYPES.FIRST_VERSION_STAGE, metadata])
      : await pool.query(BY_APP_SQL, [app, events.EVENT_TYPES.FIRST_VERSION_STAGE, metadata]);
    return rows.length > 0;
  } catch (err) {
    log.debug('first-version-timeline', 'A first version\'s stage was not recorded', { runId, appId, stage, err: err && err.message });
    return false;
  }
}

/**
 * The stage a build's step boundary is, recorded for its run when it is one
 * (STAGE_OF_STEP). Never throws.
 */
function recordStep(pool, { runId, step, sessionId = null, detail = null }) {
  const stage = STAGE_OF_STEP[step];
  return stage ? record(pool, { runId, stage, sessionId, detail }) : Promise.resolve(false);
}

module.exports = {
  STAGES,
  STAGE_OF_STEP,
  BY_RUN_SQL,
  BY_APP_SQL,
  cleanDetail,
  record,
  recordStep,
};
