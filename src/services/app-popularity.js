'use strict';

// Hearts and plays: how much an app is liked and used, as a project's hub,
// its signed-out page and the Communities cards say it
// (frontend/src/features/popularity/).
//
// A PLAY is one person using an app on one day, however many times they
// open it. Two kinds of people are counted, from two places:
//
//   signed in   app_activity already keeps one row per person, app and day
//               (services/app-activity.js: the time they spent there), so
//               their plays are those rows, counted. Nothing new is written
//               for them, and the count reaches back as far as that table.
//   signed out  a visitor has no such row. The landing's viewer reports an
//               app that stayed open (features/auth/landing.tsx) to
//               POST /api/public/apps/:slug/plays, and recordVisitorPlay
//               adds one to that app's count for the day, once per source.
//
// The source is ui-telemetry.js anonymousSource: a keyed hash of the
// address's network and the day. It names nobody, changes every day and is
// kept only to refuse a second count; pruneMarks deletes it two days on. A
// visit to an app's own address, outside Homeroom, is not counted at all:
// only an app opened here is.
//
// A HEART is an account saying it likes an app. Any signed-in account that
// can see the app can give one and take it back, a member or not. It is not
// a pin (app_favorites) and joins nothing.

const log = require('./logger');

// How long a visitor's mark is kept: its own day and the one after, so a
// request that arrives across midnight still finds it.
const MARK_DAYS = 2;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
let nextPruneAt = 0;

const toCount = (value) => Math.max(0, parseInt(value, 10) || 0);

/**
 * One app's counts, and whether `viewerId` has hearted it. The directory's
 * cards read the same two numbers for every public app in one query
 * (public-app-directory.js listPublicApps); the two count alike. `played` says
 * which word the count takes: a game is played, anything else is opened
 * (the directory's own kind: dapp.json's category, else the inferred one).
 */
async function summaryFor(pool, appId, viewerId = null) {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM app_activity aa JOIN users pu ON pu.id = aa.user_id
              WHERE aa.app_id = a.id AND pu.is_synthetic IS NOT TRUE) AS member_plays,
            (SELECT COALESCE(SUM(plays), 0) FROM app_visitor_plays vp WHERE vp.app_id = a.id) AS visitor_plays,
            (SELECT COUNT(*) FROM app_hearts ah JOIN users hu ON hu.id = ah.user_id
              WHERE ah.app_id = a.id AND hu.is_synthetic IS NOT TRUE) AS hearts,
            EXISTS (SELECT 1 FROM app_hearts mine
                     WHERE mine.app_id = a.id AND mine.user_id = $2::int) AS hearted,
            a.manifest_snapshot->>'category' AS category,
            (SELECT ic.category FROM app_inferred_categories ic
              WHERE ic.app_id = a.id
                AND ic.source_description = COALESCE(a.manifest_snapshot->>'description', '')) AS inferred_category
       FROM apps a WHERE a.id = $1`,
    [appId, viewerId || null]
  );
  const row = rows[0];
  if (!row) return null;
  const { directoryCategory } = require('./public-app-directory');
  return {
    plays: toCount(row.member_plays) + toCount(row.visitor_plays),
    hearts: toCount(row.hearts),
    hearted: !!viewerId && row.hearted === true,
    played: directoryCategory(row.category, row.inferred_category) === 'games',
  };
}

/**
 * Give or take back one account's heart. Idempotent either way; answers how
 * things stand afterwards.
 */
async function setHeart(pool, { appId, userId, hearted }) {
  if (hearted) {
    await pool.query(
      `INSERT INTO app_hearts (app_id, user_id) VALUES ($1, $2)
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [appId, userId]
    );
  } else {
    await pool.query('DELETE FROM app_hearts WHERE app_id = $1 AND user_id = $2', [appId, userId]);
  }
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM app_hearts ah JOIN users hu ON hu.id = ah.user_id
              WHERE ah.app_id = $1 AND hu.is_synthetic IS NOT TRUE) AS hearts,
            EXISTS (SELECT 1 FROM app_hearts WHERE app_id = $1 AND user_id = $2) AS hearted`,
    [appId, userId]
  );
  return { hearted: rows[0]?.hearted === true, hearts: toCount(rows[0]?.hearts) };
}

/**
 * One visitor's play of one app today. The mark and the count are one
 * statement: the count goes up only when the mark was new, so the same
 * source reporting again (a reload, a second tab, a script) adds nothing.
 */
async function recordVisitorPlay(pool, { appId, source }) {
  if (!appId || !source) return { counted: false };
  const { rowCount } = await pool.query(
    `WITH mark AS (
       INSERT INTO app_visitor_play_marks (app_id, day, source)
       VALUES ($1, CURRENT_DATE, $2)
       ON CONFLICT (app_id, day, source) DO NOTHING
       RETURNING app_id
     )
     INSERT INTO app_visitor_plays (app_id, day, plays)
     SELECT app_id, CURRENT_DATE, 1 FROM mark
     ON CONFLICT (app_id, day) DO UPDATE SET plays = app_visitor_plays.plays + 1`,
    [appId, String(source).slice(0, 64)]
  );
  pruneMarksSoon(pool);
  return { counted: rowCount > 0 };
}

/** The marks past their use, deleted. */
async function pruneMarks(pool, { days = MARK_DAYS } = {}) {
  const { rowCount } = await pool.query(
    'DELETE FROM app_visitor_play_marks WHERE day < CURRENT_DATE - $1::int',
    [Math.max(1, Math.floor(Number(days)) || MARK_DAYS)]
  );
  return rowCount || 0;
}

// Every few hours, from whichever process next counts a play: no clock of
// its own, and a failure is only a table that is tidied later.
function pruneMarksSoon(pool, now = Date.now()) {
  if (now < nextPruneAt) return;
  nextPruneAt = now + PRUNE_EVERY_MS;
  pruneMarks(pool).catch((err) => {
    log.warn('app-popularity', 'Could not prune visitor play marks', { message: err.message });
  });
}

module.exports = {
  MARK_DAYS,
  summaryFor,
  setHeart,
  recordVisitorPlay,
  pruneMarks,
};
