'use strict';

// The made screen's moments (newcomer run five, 13 October 2026): when the
// screen after Make it (frontend/src/features/first-session/made.tsx) first
// showed each thing, when it was tapped, and the maker's tour that follows
// it. Run five could only piece these together from screenshots. One
// `events` row each (event_type 'first_session_moment'), for the person and
// the project, sent by the browser to POST /api/apps/:slug/first-version/
// moments (routes/apps.js) as it happens (made-moments.ts). `metadata.kind`
// is one of KINDS:
//
//   made_shown           the screen opened. { entry: first_session | create }
//   planning_shown       its build line said Homeroom bot is planning it
//   questions_shown      the plan's quick questions. { count }
//   submit_tapped        Submit under them. { count }
//   invite_shown         the invite line and its buttons. { how:
//                        after_questions, once the questions were answered }
//   share_invite_tapped  Share invite (the sheet opened). { how: again, for
//                        Share again }
//   invite_sent          the link went out from the sheet. { how: shared |
//                        copied }
//   invite_later_tapped  Invite people later (nothing went out)
//   continue_tapped      the way on once the link was out (Start the tour, or
//                        Go to from Create)
//   tour_started         the maker's tour. { steps }
//   tour_step_shown      each of its cards. { step, steps }
//   tour_ended           { step, steps, how: done | skipped }
//
// Every row keeps both clocks: `clientAt`, when the browser saw it, and
// `receivedAt`, when the server got it (also the row's created_at).
//
// Recorded for test accounts too: the newcomer runs are theirs. The admin
// Journey reads none of these rows (services/journey.js), so they count
// nowhere there; a reader that counts people fences test accounts out as
// journey.js REAL_PERSON_SQL does. Never for a platform service account or
// somebody who objected to being recorded (ui-telemetry.js isRecordable).
// Nothing anybody typed: a kind, small counts and short codes.

const events = require('./events');
const log = require('./logger');

const KINDS = Object.freeze([
  'made_shown', 'planning_shown', 'questions_shown', 'submit_tapped', 'invite_shown', 'share_invite_tapped',
  'invite_sent', 'invite_later_tapped', 'continue_tapped', 'tour_started', 'tour_step_shown', 'tour_ended',
]);

// The codes `how` and `entry` may hold.
const HOWS = Object.freeze(['after_questions', 'again', 'shared', 'copied', 'done', 'skipped']);
const ENTRIES = Object.freeze(['first_session', 'create']);
// How far the browser's clock may be from the server's for a moment to be
// kept: a day either way (a phone set to the wrong day says nothing true).
const CLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
const COUNT_MAX = 20;
const STEP_MAX = 100;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function boundedInt(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * Pure: a moment as the browser sent it, checked, or null when it is not
 * one: a known kind, the time it happened (an ISO time in UTC within a day
 * of `now`), and only the optional fields below, each well formed when it is
 * there. Resolves { kind, clientAt, ...detail }.
 */
function parseMoment(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!KINDS.includes(body.kind)) return null;
  if (typeof body.clientAt !== 'string' || !ISO_RE.test(body.clientAt)) return null;
  const at = Date.parse(body.clientAt);
  if (!Number.isFinite(at) || Math.abs(at - now) > CLOCK_WINDOW_MS) return null;
  const out = { kind: body.kind, clientAt: new Date(at).toISOString() };
  const fields = {
    count: (v) => boundedInt(v, 0, COUNT_MAX),
    step: (v) => boundedInt(v, 1, STEP_MAX),
    steps: (v) => boundedInt(v, 1, STEP_MAX),
    how: (v) => (HOWS.includes(v) ? v : undefined),
    entry: (v) => (ENTRIES.includes(v) ? v : undefined),
  };
  for (const [key, check] of Object.entries(fields)) {
    if (body[key] === undefined || body[key] === null) continue;
    const value = check(body[key]);
    if (value === undefined) return null;
    out[key] = value;
  }
  return out;
}

/**
 * Keep one moment for `user` on the project `appId`, with the server's
 * receipt time beside the browser's. Resolves whether it was kept: not for
 * an account that is not recorded (isRecordable). Never throws.
 */
async function record(pool, { user, appId, moment, now = new Date(), deps = {} }) {
  try {
    const uiTelemetry = deps.uiTelemetry || require('./ui-telemetry');
    if (!(await uiTelemetry.isRecordable(pool, user))) return false;
    const { rows } = await pool.query(
      `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
       RETURNING id`,
      [Number(user.id), Number(appId), events.EVENT_TYPES.FIRST_SESSION_MOMENT,
        JSON.stringify({ ...moment, receivedAt: now.toISOString() }), now],
    );
    return rows.length > 0;
  } catch (err) {
    log.debug('first-session-moments', 'A made screen moment was not recorded', { appId, err: err && err.message });
    return false;
  }
}

module.exports = {
  KINDS,
  HOWS,
  ENTRIES,
  CLOCK_WINDOW_MS,
  parseMoment,
  record,
};
