'use strict';

// When Homeroom has asked somebody to turn notifications on, and what they
// said (the notification ask, frontend/src/features/notify-ask/).
//
// An ask comes at a MOMENT, when the person has just started waiting on
// something and can be told what they will hear about:
//
//   app_building   Homeroom bot is making their new project.
//   invite_sent    an invite link of theirs just went out.
//   suggestion     Homeroom bot is building something they suggested.
//   reply          they wrote to somebody, who may answer.
//   community      a project they are a member of, but did not make.
//   project_opens  a project they joined that is still being made.
//
// Each is asked at most once per SURFACE: `app` is the Homeroom app on a
// phone, where the answer is the OS permission, and `web` is a browser,
// where Homeroom has no push and the ask is to get the app. A web ask does
// not use up the app's: somebody who said "Not now" to installing the app
// is still asked in context once they have it. Two "Not now"s on a surface
// stop its asking altogether, and a "yes" on the web does too (they were
// given the app; a phone that can take the push then hides every web ask).
//
// Kept per account, so one Not now holds on every device, and so the asks
// can be counted. The rules themselves are the client's
// (frontend/src/features/notify-ask/decide.ts): this module only records.

const activityMail = require('./activity-mail');

const MOMENTS = Object.freeze([
  'app_building', 'invite_sent', 'suggestion', 'reply', 'community', 'project_opens',
]);
const SURFACES = Object.freeze(['app', 'web']);
const ANSWERS = Object.freeze(['yes', 'not_now']);

const MOMENT_SET = new Set(MOMENTS);
const SURFACE_SET = new Set(SURFACES);
const ANSWER_SET = new Set(ANSWERS);

/**
 * What the client needs to decide an ask: every answer this account gave,
 * whether a phone of theirs can take a push now (then no web ask is needed),
 * and whether Homeroom would email them instead (a confirmed address, and
 * activity email not turned off).
 */
async function readAsks(pool, userId) {
  const [{ rows }, phone, { rows: mail }] = await Promise.all([
    pool.query(
      `SELECT surface, moment, answer
         FROM notification_asks
        WHERE user_id = $1
        ORDER BY answered_at`,
      [userId],
    ),
    activityMail.canPush(pool, userId),
    pool.query(
      `SELECT (email IS NOT NULL AND email_confirmed AND activity_email) AS email
         FROM users
        WHERE id = $1`,
      [userId],
    ),
  ]);
  return {
    asks: rows.map((row) => ({ surface: row.surface, moment: row.moment, answer: row.answer })),
    phone: !!phone,
    email: !!(mail[0] && mail[0].email),
  };
}

/** `{ details, value }`: details names each field that is wrong. */
function validateAsk(body) {
  const details = {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!SURFACE_SET.has(b.surface)) details.surface = ['The surface must be app or web.'];
  if (!MOMENT_SET.has(b.moment)) details.moment = ['This moment is not recognized.'];
  if (!ANSWER_SET.has(b.answer)) details.answer = ['The answer must be yes or not_now.'];
  if (Object.keys(details).length) return { details, value: null };
  return { details, value: { surface: b.surface, moment: b.moment, answer: b.answer } };
}

/**
 * Record an answer. A later answer to the same ask replaces the earlier one
 * (a Not now on one device, then Notify me on another, reads as yes).
 */
async function recordAsk(pool, userId, { surface, moment, answer }) {
  await pool.query(
    `INSERT INTO notification_asks (user_id, surface, moment, answer)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, surface, moment) DO UPDATE
       SET answer = EXCLUDED.answer,
           answered_at = NOW()`,
    [userId, surface, moment, answer],
  );
  return readAsks(pool, userId);
}

module.exports = {
  MOMENTS,
  SURFACES,
  ANSWERS,
  readAsks,
  validateAsk,
  recordAsk,
};
