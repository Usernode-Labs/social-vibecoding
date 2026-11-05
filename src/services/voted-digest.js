'use strict';

/**
 * The Monday "changes you voted on" row (#5404): once a week, one line in the
 * bell (and on the phone) saying how many changes you voted on were decided
 * in the last week. A tap opens Your votes, which lists each one and how it
 * ended (`#profile/your-votes`, GET /api/me/history).
 *
 * ── What it says ───────────────────────────────────────────────────────
 *
 * A count and nothing else: no app and no change on the row (both NULL), so
 * it cannot name a project, whoever reads it. Decided means what Your votes'
 * Decided group means: merged (merged_at), or closed without merging (status
 * 'archived', archived_at). Someone with nothing decided gets nothing.
 *
 * A voter is a row in pr_votes, the same people voted_change_merged tells
 * (rules/change-notifications.ts): someone whose vote a new version cleared,
 * or who took it back, has no standing vote and is not counted, although
 * Your votes still lists the cast from the events log.
 *
 * A change only counts while its reader may still see its project: a public
 * one, or a private one they are still a member of, not suspended, not
 * blocked. Someone who has left a private project is not counted for it.
 *
 * ── Shape ──────────────────────────────────────────────────────────────
 *
 * weekly-digest.js's clock: hourly, nothing until Monday at POST_HOUR_UTC, no
 * query at all on any other hour. vote-digest.js's write: one query for the
 * platform, then each row under its person's transaction lock by an INSERT
 * that checks again, so two sweeps at once send one.
 *
 * The week is a fixed window, one Monday's POST_HOUR_UTC to the next, so a
 * change is counted in exactly one week and every sweep of a Monday sees the
 * same answer. A person's week is taken once they have a row made at or after
 * this Monday's start. If the clock does not run at all on a Monday, that
 * week is skipped rather than sent late.
 *
 * ── Cost ───────────────────────────────────────────────────────────────
 *
 * The query starts from the week's decided changes, a few hundred at most,
 * through chat_sessions_merged_at_idx and chat_sessions_archived_idx, and only
 * then reads their votes by pr_votes' UNIQUE (session_id, user_id). It never
 * walks pr_votes, however many votes the platform has, nor the events log,
 * whose session_id has no index. The check for a row already made reads
 * idx_notifications_user_recent per voter.
 */

const log = require('./logger');
const { VOTED_DIGEST_LOCK } = require('./advisory-locks');

const INTERVAL_MS = 60 * 60 * 1000;      // swept hourly (the voted-digest clock)
const POST_DAY_UTC = 1;                  // Monday
const POST_HOUR_UTC = 13;                // from 13:00 UTC; no timezone is stored
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// The row is a glance, as the vote digest's is.
const MAX_COUNT = 99;

/** Monday at or after the posting hour, in UTC. */
function isPostingTime(now) {
  return now.getUTCDay() === POST_DAY_UTC && now.getUTCHours() >= POST_HOUR_UTC;
}

/** The most recent Monday POST_HOUR_UTC at or before `now`: the week's mark. */
function weekStart(now) {
  const daysSince = (now.getUTCDay() - POST_DAY_UTC + 7) % 7;
  const mark = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSince, POST_HOUR_UTC));
  return mark.getTime() > now.getTime() ? new Date(mark.getTime() - WEEK_MS) : mark;
}

/**
 * One sweep: a pass of the `voted-digest` clock (src/workflow/clock/services.ts).
 * `now` is a parameter so a test can make it Monday.
 */
async function sweep(pool, now = new Date()) {
  if (!isPostingTime(now)) return { skipped: true };
  const result = { candidates: 0, sent: 0 };
  const until = weekStart(now);
  const since = new Date(until.getTime() - WEEK_MS);

  const { rows } = await pool.query(
    `
    WITH decided AS (
      SELECT cs.id, cs.app_id FROM chat_sessions cs
       WHERE cs.merged_at >= $1 AND cs.merged_at < $2
      UNION
      SELECT cs.id, cs.app_id FROM chat_sessions cs
       WHERE cs.status = 'archived' AND cs.merged_at IS NULL
         AND cs.archived_at >= $1 AND cs.archived_at < $2
    )
    SELECT v.user_id, COUNT(*) AS decided
      FROM decided d
      JOIN pr_votes v ON v.session_id = d.id
      JOIN apps a ON a.id = d.app_id
     WHERE v.user_id IS NOT NULL
       AND a.moderation_suspended_at IS NULL
       AND (a.view_visibility = 'public' OR EXISTS (
         SELECT 1 FROM app_collaborators c
          WHERE c.app_id = a.id AND c.user_id = v.user_id AND c.status = 'member'))
       AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.user_id = v.user_id AND b.app_id = a.id)
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
          WHERE n.user_id = v.user_id AND n.kind = 'voted_digest' AND n.created_at >= $2)
     GROUP BY v.user_id`,
    [since.toISOString(), until.toISOString()]
  );
  result.candidates = rows.length;
  if (!rows.length) return result;

  // Lazily, as vote-digest.js: a top-level require drags the notification
  // stack into every context that wants this module's constants.
  const notificationPreferences = require('./notification-preferences');
  const notifications = require('./notifications');
  const { withTransaction } = require('./cli-auth');

  const allowed = new Set(await notificationPreferences.filterUsersByCategory(pool, {
    userIds: rows.map((row) => Number(row.user_id)),
    appId: null,
    categoryKey: 'voted_digest',
  }));

  for (const row of rows) {
    const userId = Number(row.user_id);
    if (!allowed.has(userId)) continue;
    const count = Math.min(Number(row.decided) || 0, MAX_COUNT);
    if (!count) continue;
    try {
      const created = await withTransaction(pool, async (db) => {
        await db.query('SELECT pg_advisory_xact_lock($1, $2)', [VOTED_DIGEST_LOCK, userId]);
        // created_at is this sweep's `now`, the clock the week is read by.
        // mailed_at NOW(): it owes no email, bell and phone only (#5794).
        const { rows: made } = await db.query(
          `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail, mailed_at, created_at)
           SELECT $1, NULL, NULL, NULL, 'voted_digest', $2, NOW(), $3
            WHERE NOT EXISTS (
              SELECT 1 FROM notifications n
               WHERE n.user_id = $1 AND n.kind = 'voted_digest' AND n.created_at >= $4)
           RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
          [userId, String(count), now.toISOString(), until.toISOString()]
        );
        return made[0] || null;
      });
      if (created) {
        result.sent += 1;
        await notifications.hydrateAndPush(pool, created);
      }
    } catch (err) {
      // One person's row failing must not end the sweep for those behind them.
      log.warn('voted-digest', 'Digest insert failed', { userId, err: err.message });
    }
  }
  if (result.sent) log.info('voted-digest', 'Digests sent', result);
  return result;
}

module.exports = {
  sweep,
  isPostingTime,
  weekStart,
  INTERVAL_MS,
  POST_DAY_UTC,
  POST_HOUR_UTC,
  MAX_COUNT,
};
