'use strict';

// #21 helpers: deriving the "version currently live on prod" for an app.
//
// The source of truth is `apps.main_sha` (populated by app-creator and
// staging.deployProduction, and by the drift poller for a row that has
// none). This module provides getAppVersion(pool, slug): a join with
// chat_sessions for PR context, so the UI can show a tooltip like
// "PR #42 · Add leaderboard · @evan".

const repoRef = require('./repo-ref');

/**
 * Where the change that made `number` the live version is, when no proposal
 * row says: its pull request on GitHub for a repository still there, else its
 * change page in Homeroom (services/native-pulls.js changeUrl) for one on the
 * git host. It used to be a github.com address for every repository, which,
 * since the move, named a pull request GitHub never had.
 */
function mergedPrUrl(app, number) {
  const n = Number(number);
  if (!app || !Number.isInteger(n) || n <= 0) return null;
  const ref = repoRef.parse(app.repo_url);
  if (!ref) return null;
  if (ref.host === 'github') return `https://github.com/${ref.owner}/${ref.repo}/pull/${n}`;
  return app.slug ? require('./native-pulls').changeUrl(app.slug, n) : null;
}

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

  const commitUrl = repoRef.commitUrl(app.repo_url, app.main_sha);

  return {
    sha: app.main_sha || null,
    shortSha: app.main_sha ? app.main_sha.slice(0, 7) : null,
    prNumber: app.main_pr_number || null,
    prUrl: prUrl || mergedPrUrl(app, app.main_pr_number),
    prTitle,
    mergedBy,
    mergedAt,
    commitUrl,
  };
}

module.exports = { getAppVersion, mergedPrUrl };
