'use strict';

// When a merge into Homeroom itself went live: chat_sessions.platform_live_at.
//
// A project's merge goes live inside the merge (its deploy is a step of it),
// but Homeroom's own release is cut from main afterwards and rolled out on
// its own, so the merge cannot say when production first ran it. The build
// can: every production process boots with the commit it was built from
// (GIT_SHA), and proposals are squash-merged, so main is a line of merges
// and a build at merge B carries every merge ordered at or before B, the
// rule release-watch.js's carriedBy already uses. On boot, the first
// process to serve a build stamps every merge it carries that has no stamp
// yet; a later process, a restart or a re-release of the same build finds
// them stamped and changes nothing, and a rollback stamps nothing new.
//
// A build whose commit is no merge's (a push straight to main) stamps
// nothing; the next build that is one stamps the merges it carries, so
// those read a little long rather than not at all. Staging never stamps:
// its previews boot with a proposal's commit, not production's.
//
// Read by the Infra topic's Merge → live (services/topic-figures.js).

const log = require('./logger');

const STAMP_SQL = `
  WITH boundary AS (
    SELECT COALESCE(cs.merged_at, cs.created_at) AS at, cs.id
      FROM chat_sessions cs
      JOIN apps ap ON ap.id = cs.app_id AND ap.self_hosted = TRUE
     WHERE cs.status = 'merged' AND LOWER(cs.merge_commit_sha) = $1::text
     ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC, cs.id DESC
     LIMIT 1
  ), since AS (
    SELECT s.value::timestamptz AS at
      FROM platform_settings s
     WHERE s.key = 'platform_live_tracked_since'
  )
  UPDATE chat_sessions cs SET platform_live_at = NOW()
    FROM boundary b, since t, apps ap
   WHERE ap.id = cs.app_id AND ap.self_hosted = TRUE
     AND cs.status = 'merged' AND cs.platform_live_at IS NULL
     AND cs.merged_at >= t.at
     AND (COALESCE(cs.merged_at, cs.created_at), cs.id) <= (b.at, b.id)
  RETURNING cs.id`;

/**
 * Stamp the merges the running build carries. Never throws: a failure is
 * logged and the figure goes without this release.
 * @returns {Promise<number>} how many merges were stamped
 */
async function recordRunning(pool, { sha = process.env.GIT_SHA, env = process.env.USERNODE_ENV } = {}) {
  const commit = String(sha || '').toLowerCase();
  if (env === 'staging' || !/^[0-9a-f]{40}$/.test(commit)) return 0;
  try {
    const { rows } = await pool.query(STAMP_SQL, [commit]);
    if (rows.length) log.info('platform-release', 'Merges now live', { sha: commit.slice(0, 7), merges: rows.length });
    return rows.length;
  } catch (err) {
    log.warn('platform-release', 'Could not record which merges went live', { sha: commit.slice(0, 7), err: err.message });
    return 0;
  }
}

module.exports = { recordRunning, STAMP_SQL };
