'use strict';

// The moments the admin Journey's creation path reads
// (services/journey.js creationPath), written where they happen.
//
// Three of the path's steps lived nowhere a query could find them:
//
//   * when a new project first ran: apps.last_deploy_at moves on every
//     merge, so it cannot say. markFirstRunning sets apps.first_running_at
//     once, from the first successful deploy (services/app-creator.js), and
//     writes an `app_running` event beside it.
//   * when somebody opened a preview: only the client's telemetry saw it.
//     notePreviewOpened writes `preview_opened` when the server answers a
//     preview as ready (routes/sessions.js, the preview-status read and the
//     ensure-staging click), once per viewer per change.
//   * when a requested change was live: the health-checked answer was kept
//     only in the requester's DM. recordChangeLive writes `change_live` at
//     the merge (routes/votes.js finalizeMerge), once per change, with who
//     asked for it and whether the project answered on what was deployed.
//
// Every one of them is a record beside the act, never part of it: each
// resolves (never rejects, never throws), and a failure is a warning in the
// log, not a failed deploy, preview or merge.

const events = require('./events');
const log = require('./logger');

// Set once, in one statement: the column and its event cannot disagree, and
// a second deploy of the same project (a retry, a fork's finalize) finds the
// column set and writes nothing.
const MARK_FIRST_RUNNING_SQL = `WITH marked AS (
    UPDATE apps SET first_running_at = NOW()
     WHERE id = $1::int AND first_running_at IS NULL
     RETURNING id, created_by, created_at, first_running_at
  )
  INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
  SELECT m.created_by, m.id, $2::text,
         jsonb_build_object('secondsFromCreation',
           GREATEST(0, ROUND(EXTRACT(EPOCH FROM (m.first_running_at - m.created_at))))::int),
         m.first_running_at
    FROM marked m
  RETURNING id`;

/** A project's first successful run. Resolves true when this call marked it. */
async function markFirstRunning(pool, appId) {
  try {
    const id = Number(appId);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    const { rows } = await pool.query(MARK_FIRST_RUNNING_SQL, [id, events.EVENT_TYPES.APP_RUNNING]);
    return rows.length > 0;
  } catch (err) {
    log.warn('journey-events', 'Could not mark a project\'s first run', { appId, err: err && err.message });
    return false;
  }
}

// Who opened it, in relation to the change: its author, the project's
// creator, or anybody else who may see it.
const PREVIEW_OPENED_SQL = `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
  SELECT $1::int, cs.app_id, cs.id, $3::text,
         jsonb_build_object('sessionId', cs.id, 'viewerRole',
           CASE WHEN cs.user_id = $1::int THEN 'author'
                WHEN ap.created_by = $1::int THEN 'creator'
                ELSE 'member' END)
    FROM chat_sessions cs
    JOIN apps ap ON ap.id = cs.app_id
   WHERE cs.id = $2::int
  ON CONFLICT (session_id, user_id) WHERE event_type = 'preview_opened' DO NOTHING
  RETURNING id`;

// A preview is opened over and over; once per viewer per change is the
// record. The unique index is the rule (schema.sql); this only saves a write
// per reopen in this process. Cleared whole when it fills.
const SEEN_MAX = 5000;
const seen = new Set();

/**
 * A preview answered as ready to `viewerId`. Resolves true when this call
 * wrote the record, false when it was already there or could not be written.
 */
async function notePreviewOpened(pool, { sessionId, viewerId } = {}) {
  try {
    const session = Number(sessionId);
    const viewer = Number(viewerId);
    if (!Number.isSafeInteger(session) || session <= 0 || !Number.isSafeInteger(viewer) || viewer <= 0) return false;
    const key = `${session}:${viewer}`;
    if (seen.has(key)) return false;
    if (seen.size >= SEEN_MAX) seen.clear();
    seen.add(key);
    const { rows } = await pool.query(PREVIEW_OPENED_SQL, [viewer, session, events.EVENT_TYPES.PREVIEW_OPENED]);
    return rows.length > 0;
  } catch (err) {
    seen.delete(`${Number(sessionId)}:${Number(viewerId)}`);
    log.warn('journey-events', 'Could not record a preview opened', { sessionId, err: err && err.message });
    return false;
  }
}

// Who asked for a change: its author, whoever the Homeroom bot built it for
// (homeroom_bot_requesters, through the run that turned into this proposal),
// and whoever filed the requests it answers. Accounts the platform runs
// (the bot itself) never asked for anything. `firstVersion`: the change is
// a project's first version, built from what its creator described.
const CHANGE_LIVE_SQL = `WITH asked AS (
    SELECT x.id FROM (
      SELECT $4::int AS id
      UNION SELECT q.user_id FROM homeroom_bot_runs r
        JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
       WHERE r.proposal_session_id = $1::int
      UNION SELECT i.created_by FROM issues i
       WHERE i.app_id = $2::int AND i.github_issue_number = ANY($3::int[])
    ) x
    JOIN users u ON u.id = x.id
   WHERE u.is_synthetic IS NOT TRUE
  ), first AS (
    SELECT (
      EXISTS (SELECT 1 FROM homeroom_bot_first_versions f
               WHERE f.app_id = $2::int AND f.issue_number IS NOT NULL
                 AND (f.issue_number = ANY($3::int[])
                      OR f.issue_number IN (SELECT r.issue_number FROM homeroom_bot_runs r
                                             WHERE r.proposal_session_id = $1::int)))
      OR EXISTS (SELECT 1 FROM homeroom_bot_runs r
                   JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
                  WHERE r.proposal_session_id = $1::int AND q.first_version)
    ) AS yes
  )
  INSERT INTO events (user_id, app_id, session_id, event_type, metadata, created_at)
  SELECT $4::int, $2::int, $1::int, $5::text,
         jsonb_build_object(
           'sessionId', $1::int,
           'requesterIds', COALESCE((SELECT jsonb_agg(a.id ORDER BY a.id) FROM asked a), '[]'::jsonb),
           'firstVersion', (SELECT f.yes FROM first f),
           'live', $6::boolean,
           'sha', $7::text),
         $8::timestamptz
  ON CONFLICT (session_id) WHERE event_type = 'change_live' DO NOTHING
  RETURNING metadata`;

const APP_FOR_LIVE_SQL = `SELECT id, slug, self_hosted, runtime_kind, runtime_name FROM apps WHERE id = $1::int`;

/** The request numbers a change answers: its linked issues and the one it was started from. */
function requestNumbers(session) {
  const out = new Set();
  for (const raw of [...(Array.isArray(session.linked_issues) ? session.linked_issues : []), session.created_from_issue_number]) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

/**
 * A change merged and was deployed (`sha`, what the merge deployed; null for
 * Homeroom's own project, which is released outside this process). `live`
 * is whether the project answered its health check on that build, read the
 * way the bot's DM reads it (homeroom-bot-dm.js liveAfterMerge); `deps.live`
 * replaces that reading in tests. Recorded at the moment of the merge, not
 * after the reading. Resolves the metadata written, or null.
 */
async function recordChangeLive(pool, { config = null, session, sha = null, at = new Date(), deps = {} } = {}) {
  try {
    const sessionId = Number(session && session.id);
    const appId = Number(session && session.app_id);
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !Number.isSafeInteger(appId) || appId <= 0) return null;
    let live = false;
    if (typeof deps.live === 'function') {
      live = !!(await deps.live());
    } else if (sha && config) {
      const { rows } = await pool.query(APP_FOR_LIVE_SQL, [appId]);
      if (rows[0]) {
        live = await require('./homeroom-bot-dm').liveAfterMerge(config, rows[0], { sha, deps })
          .catch(() => false);
      }
    }
    const author = Number(session.user_id);
    const { rows } = await pool.query(CHANGE_LIVE_SQL, [
      sessionId, appId, requestNumbers(session),
      Number.isSafeInteger(author) && author > 0 ? author : null,
      events.EVENT_TYPES.CHANGE_LIVE, !!live, sha || null, at,
    ]);
    return rows[0] ? rows[0].metadata : null;
  } catch (err) {
    log.warn('journey-events', 'Could not record a change going live', {
      sessionId: session && session.id, err: err && err.message,
    });
    return null;
  }
}

// The first session's first reward: the sketch of a project made from the
// first session, the moment its maker is shown it. Once per project (the
// unique index in schema.sql is the rule), only for its maker, and only
// while the project is young enough for this to be the first session.
const FIRST_ARTEFACT_SQL = `INSERT INTO events (user_id, app_id, event_type, metadata)
  SELECT ap.created_by, ap.id, $3::text,
         jsonb_build_object('artefact', 'sketch', 'secondsFromCreation',
           GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - ap.created_at))))::int)
    FROM apps ap
   WHERE ap.id = $1::int AND ap.created_by = $2::int
     AND ap.created_at > NOW() - INTERVAL '1 day'
  ON CONFLICT (app_id) WHERE event_type = 'first_artefact_shown' DO NOTHING
  RETURNING id`;

/** A project's sketch shown to `userId`. Resolves true when this call wrote the record. */
async function noteFirstArtefactShown(pool, { appId, userId }) {
  try {
    const app = Number(appId);
    const user = Number(userId);
    if (!Number.isSafeInteger(app) || app <= 0 || !Number.isSafeInteger(user) || user <= 0) return false;
    const { rows } = await pool.query(FIRST_ARTEFACT_SQL, [app, user, events.EVENT_TYPES.FIRST_ARTEFACT_SHOWN]);
    return rows.length > 0;
  } catch (err) {
    log.warn('journey-events', 'Could not record a first artefact shown', { appId, err: err && err.message });
    return false;
  }
}

// The invite funnel's middle step (journey.js firstSession): `userId` has a
// live invite link in hand signed in. Once per person per link (the unique
// index in schema.sql is the rule), and only for somebody it could still
// bring in: not its maker, not already in its community, which is also why
// a sign-in records it before following the link. `$4` is whether the
// sign-in carried the link; an account made by that sign-in (within the
// hour, as standing() reads a new account) signed up, any other signed in.
//
// `how` is which of the funnel's two ways it was (#4272): 'signed_up' and
// 'signed_in' the link brought about (opened signed out, then a sign-in
// carrying it, whether or not that sign-in follows it), 'was_signed_in'
// was signed in when they opened it (the standing read, or the waiting
// room's redeem). The first record stands: every sign-in that carries a
// link records it before it answers, so the shell's read after it cannot
// take that person for somebody already signed in.
const INVITE_SIGNED_IN_SQL = `INSERT INTO events (user_id, app_id, event_type, metadata)
  SELECT u.id, ci.app_id, $3::text,
         jsonb_build_object('inviteId', ci.id, 'how',
           CASE WHEN NOT $4::boolean THEN 'was_signed_in'
                WHEN u.created_at > NOW() - INTERVAL '1 hour' THEN 'signed_up'
                ELSE 'signed_in' END)
    FROM community_invites ci
    JOIN users u ON u.id = $2::int
   WHERE ci.token = $1::text AND ci.revoked_at IS NULL
     AND (ci.expires_at IS NULL OR ci.expires_at > NOW())
     AND (ci.max_uses IS NULL OR ci.uses < ci.max_uses)
     AND ci.created_by IS DISTINCT FROM u.id
     AND NOT EXISTS (SELECT 1 FROM community_members m
                      WHERE m.community_id = ci.community_id AND m.user_id = u.id)
  ON CONFLICT (user_id, (metadata->>'inviteId')) WHERE event_type = 'invite_signed_in' DO NOTHING
  RETURNING metadata->>'how' AS how`;

/**
 * `userId` signed up or in carrying the invite link `token` (`carried`,
 * communityInvites.redeemCarried, or dropCarried when the sign-in does not
 * follow it), or opened it already signed in. Resolves how ('signed_up',
 * 'signed_in' or 'was_signed_in') when this call wrote the record, else null.
 */
async function noteInviteSignedIn(pool, { token, userId, carried = false } = {}) {
  try {
    const user = Number(userId);
    if (typeof token !== 'string' || !token || !Number.isSafeInteger(user) || user <= 0) return null;
    const { rows } = await pool.query(INVITE_SIGNED_IN_SQL, [token, user, events.EVENT_TYPES.INVITE_SIGNED_IN, !!carried]);
    return rows[0] ? rows[0].how : null;
  } catch (err) {
    log.warn('journey-events', 'Could not record a sign-in through an invite', { err: err && err.message });
    return null;
  }
}

module.exports = {
  APP_FOR_LIVE_SQL,
  FIRST_ARTEFACT_SQL,
  INVITE_SIGNED_IN_SQL,
  noteFirstArtefactShown,
  noteInviteSignedIn,
  CHANGE_LIVE_SQL,
  MARK_FIRST_RUNNING_SQL,
  PREVIEW_OPENED_SQL,
  markFirstRunning,
  notePreviewOpened,
  recordChangeLive,
  requestNumbers,
  _seen: seen,
};
