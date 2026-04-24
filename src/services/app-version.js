'use strict';

// #21 helpers: deriving the "version currently live on prod" for an app.
//
// The source of truth is `apps.main_sha` (populated by app-creator and
// staging.rebuildProduction). This module provides:
//   - getAppVersion(pool, slug): join with chat_sessions for PR context
//     so the UI can show a tooltip like "PR #42 · Add leaderboard · @evan".
//   - backfillMainShas(pool): one-shot at server boot to fill in nulls
//     for apps created before this column existed.

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const log = require('./logger');
const github = require('./github');

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

  const [, owner, repo] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  const commitUrl = app.main_sha && owner && repo
    ? `https://github.com/${owner}/${repo}/commit/${app.main_sha}`
    : null;

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

// For apps that existed before #21 added `main_sha`, hit the remote
// default branch and record its tip. We skip apps already in a
// terminal error state or with no repo_url — nothing to pin there.
//
// Runs best-effort: a single failing repo logs a warning and the
// loop keeps going, so a revoked token or deleted repo can't block
// the whole backfill.
async function backfillMainShas(pool) {
  if (!github.isEnabled()) return;

  const { rows } = await pool.query(
    `SELECT id, slug, repo_url FROM apps
      WHERE main_sha IS NULL
        AND repo_url IS NOT NULL
        AND status IN ('running', 'creating')`
  );
  if (!rows.length) return;

  log.info('app-version', 'Backfilling main_sha', { count: rows.length });
  for (const app of rows) {
    const [, owner, repo] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) continue;
    try {
      const cloneUrl = await github.getCloneUrl(owner, repo);
      // `git ls-remote HEAD` gives us the tip SHA of the remote's
      // default branch without needing a working copy. Much faster
      // than cloning.
      const { stdout } = await execFileAsync('git', ['ls-remote', cloneUrl, 'HEAD'], {
        timeout: 15000,
      });
      const sha = (stdout || '').split(/\s+/)[0]?.trim();
      if (sha && /^[0-9a-f]{40}$/i.test(sha)) {
        await pool.query('UPDATE apps SET main_sha = $1 WHERE id = $2 AND main_sha IS NULL', [sha, app.id]);
      }
    } catch (err) {
      log.warn('app-version', 'ls-remote failed', { slug: app.slug, err: err.message });
    }
  }
  log.info('app-version', 'Backfill complete');
}

module.exports = { getAppVersion, backfillMainShas };
