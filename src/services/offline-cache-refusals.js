'use strict';

// Offline apps (services/offline-cache.js): an app whose page did not open
// at the cacheable address, learned for the app's current build.
//
// The shell frames a public app at one address with the token after `#`, and
// the bridge tells the shell the page opened. When it never does online (a
// page that loads no bridge, or one that answers 401 without a token), that
// device falls back to the old, tokened address for a week
// (public/js/app-view.js _offlineCacheDidNotOpen). Every OTHER device still
// had to find out for itself, opening the app signed out once before it
// reloaded, and again a week later. The shell now reports the fallback here.
// Once two different people report it on the same build, the app is framed
// the tokened way on every device until its next deploy: forApp reads
// apps.offline_cache_off_sha against apps.main_sha.
//
// Two people, not one, so a single device's oddity (an extension blocking
// the bridge, a page that failed to load once) does not switch an app's
// offline opening off for everybody. Either way the app still works: the
// tokened address is how every app was framed before offline caching.
//
// A report names the build it saw. A report for another build (a tab still
// on the old one after a deploy) is ignored, so a fallback seen on the old
// build never carries over to the new one.

const log = require('./logger');

const PEOPLE_THRESHOLD = 2;
const SHA_RE = /^[0-9a-f]{40}$/;

// Pure: the build a report names, or null when it is not a full commit sha.
function parseBuild(value) {
  const sha = String(value || '').trim().toLowerCase();
  return SHA_RE.test(sha) ? sha : null;
}

/**
 * Record that `userId` saw `app` not open at the cacheable address on build
 * `build`. `app` carries id, slug and main_sha. Returns
 * { recorded, people, off } (`recorded` false for a report on another build).
 */
async function recordRefusal(pool, { app, userId, build }) {
  const sha = parseBuild(build);
  const current = parseBuild(app && app.main_sha);
  if (!app || !app.id || !userId || !sha || sha !== current) {
    return { recorded: false, people: 0, off: false };
  }
  // Only the current build's rows are kept: an older build's never count.
  await pool.query(
    'DELETE FROM app_offline_cache_refusals WHERE app_id = $1 AND main_sha <> $2',
    [app.id, sha]
  );
  await pool.query(
    `INSERT INTO app_offline_cache_refusals (app_id, main_sha, user_id)
       VALUES ($1, $2, $3)
     ON CONFLICT (app_id, main_sha, user_id) DO NOTHING`,
    [app.id, sha, userId]
  );
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS people FROM app_offline_cache_refusals WHERE app_id = $1 AND main_sha = $2',
    [app.id, sha]
  );
  const people = rows[0] ? Number(rows[0].people) || 0 : 0;
  let off = false;
  if (people >= PEOPLE_THRESHOLD) {
    // Only while the app is still on that build: a deploy that landed in
    // between keeps its own chance.
    const { rowCount } = await pool.query(
      `UPDATE apps SET offline_cache_off_sha = $2
        WHERE id = $1 AND main_sha = $2 AND offline_cache_off_sha IS DISTINCT FROM $2`,
      [app.id, sha]
    );
    off = true;
    if (rowCount) {
      log.info('offline-cache', 'Cacheable address switched off for this build', {
        slug: app.slug, sha: sha.slice(0, 7), people,
      });
    }
  }
  return { recorded: true, people, off };
}

module.exports = { PEOPLE_THRESHOLD, parseBuild, recordRefusal };
