'use strict';

// #21 helpers: deriving the "version currently live on prod" for an app.
//
// The source of truth is `apps.main_sha` (populated by app-creator and
// staging.deployProduction, and by the drift poller for a row that has
// none). This module provides getAppVersion(pool, slug): a join with
// chat_sessions for PR context, so the UI can show a tooltip like
// "PR #42 · Add leaderboard · @evan".

const repoRef = require('./repo-ref');

async function getAppVersion(pool, slug) {
  const { rows } = await pool.query(
    `SELECT id, slug, repo_url, main_sha, main_pr_number
       FROM apps
      WHERE slug = $1`,
    [slug]
  );
  if (!rows.length) return null;
  const app = rows[0];

  let prTitle = null;
  let prUrl = null;
  let mergedBy = null;
  let mergedAt = null;
  if (app.main_pr_number) {
    const { rows: prRows } = await pool.query(
      `SELECT cs.pr_number, cs.pr_url, cs.pr_title, u.username, cs.created_at
         FROM chat_sessions cs
         LEFT JOIN users u ON u.id = cs.user_id
        WHERE cs.app_id = $1 AND cs.pr_number = $2
        ORDER BY cs.id DESC
        LIMIT 1`,
      [app.id, app.main_pr_number]
    );
    if (prRows.length) {
      prTitle = prRows[0].pr_title;
      prUrl = prRows[0].pr_url;
      mergedBy = prRows[0].username;
      mergedAt = prRows[0].created_at;
    }
  }

  const { owner, repo } = repoRef.ownerRepo(app.repo_url) || {};
  const commitUrl = repoRef.commitUrl(app.repo_url, app.main_sha);

  return {
    sha: app.main_sha || null,
    shortSha: app.main_sha ? app.main_sha.slice(0, 7) : null,
    prNumber: app.main_pr_number || null,
    prUrl: prUrl || (app.main_pr_number && owner && repo
      ? `https://github.com/${owner}/${repo}/pull/${app.main_pr_number}`
      : null),
    prTitle,
    mergedBy,
    mergedAt,
    commitUrl,
  };
}

module.exports = { getAppVersion };
