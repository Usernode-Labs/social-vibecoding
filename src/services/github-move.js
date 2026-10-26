'use strict';

// The boot migration of the move off GitHub (docs/plans/
// github-independence-build.md), run by src/db/migrate.js after the schema.
// Every step is idempotent, so it runs on every boot and does work only once.
//
// 1. Requests from their twins: each `issues` row that recorded a request
//    as first filed (kind 'general', its GitHub number) becomes a request
//    row, 'twin' and `recovered_partial`, unless the request is already
//    there (filed here since, or imported from the rescued boards, which
//    carry the current text and win).
//
// 2. Each recorded move (git_host_moves, written by the recovery tool once
//    the app's repository on the git host holds main), applied once:
//      - apps.repo_url becomes the git host's address, apps.main_sha the
//        main it holds there, the GitHub address goes to github_repo_url;
//      - every key on the old owner/repo moves to the new one
//        (issue_screenshots, issue_videos, feedback_reports,
//        title_heal_queue);
//      - every proposal of the app with a GitHub pull request number gets
//        its native pull request row (services/native-pulls.js), open,
//        merged or closed as the proposal stands, so getPR and the merge
//        path find it by the same number.
//    An app with no recorded move is left on GitHub, untouched: the order
//    (repository first, then repoint) cannot be got wrong silently.

const log = require('./logger');
const repoRef = require('./repo-ref');

const TWIN_SQL = `
  INSERT INTO requests (app_id, number, title, body, state, created_by, created_at, updated_at, closed_at,
                        source, recovered_partial)
  SELECT DISTINCT ON (i.app_id, i.github_issue_number)
         i.app_id, i.github_issue_number, LEFT(i.title, 512), COALESCE(i.description, ''),
         CASE WHEN i.status = 'closed' THEN 'closed' ELSE 'open' END,
         i.created_by, COALESCE(i.created_at, NOW()), COALESCE(i.created_at, NOW()),
         CASE WHEN i.status = 'closed' THEN COALESCE(i.created_at, NOW()) END,
         'twin', TRUE
    FROM issues i
    JOIN apps a ON a.id = i.app_id
   WHERE i.kind = 'general' AND i.github_issue_number > 0
   ORDER BY i.app_id, i.github_issue_number, i.id DESC
  ON CONFLICT (app_id, number) DO NOTHING`;

// A proposal's pull request as the row stands: open while it is underway or
// up for a vote, merged once merged, else closed.
const PULLS_SQL = `
  INSERT INTO native_pulls (app_id, number, title, body, head_branch, state, merged, merged_at,
                            merge_commit_sha, created_at, updated_at, closed_at)
  SELECT DISTINCT ON (cs.pr_number)
         cs.app_id, cs.pr_number, COALESCE(cs.pr_title, ''), COALESCE(cs.pr_body, ''),
         COALESCE(NULLIF(cs.branch_name, ''), 'proposal/' || cs.id),
         CASE WHEN cs.status IN ('active', 'paused', 'promoted') THEN 'open' ELSE 'closed' END,
         cs.status = 'merged' OR cs.merge_commit_sha IS NOT NULL, cs.merged_at, cs.merge_commit_sha,
         COALESCE(cs.created_at, NOW()), NOW(),
         CASE WHEN cs.status IN ('active', 'paused', 'promoted') THEN NULL ELSE COALESCE(cs.merged_at, NOW()) END
    FROM chat_sessions cs
   WHERE cs.app_id = $1 AND cs.pr_number > 0
   ORDER BY cs.pr_number, cs.id DESC
  ON CONFLICT (app_id, number) DO NOTHING`;

const KEYED = [
  ['issue_screenshots', 'issue_owner', 'issue_repo'],
  ['issue_videos', 'issue_owner', 'issue_repo'],
  ['feedback_reports', 'issue_owner', 'issue_repo'],
  ['title_heal_queue', 'owner', 'repo'],
];

async function applyMove(client, move) {
  const { rows: [app] } = await client.query(
    'SELECT id, slug, repo_url, github_repo_url FROM apps WHERE id = $1 FOR UPDATE', [move.app_id]);
  if (!app) return null;
  const from = repoRef.ownerRepo(move.github_repo_url || app.github_repo_url || app.repo_url);
  const to = repoRef.ownerRepo(move.repo_url);
  if (!to || !repoRef.isHosted(move.repo_url)) {
    log.warn('github-move', 'A recorded move does not name the git host; left as it is', { app: app.slug, repoUrl: move.repo_url });
    return null;
  }
  await client.query(
    `UPDATE apps SET github_repo_url = COALESCE(github_repo_url, $2), repo_url = $3, main_sha = $4 WHERE id = $1`,
    [app.id, move.github_repo_url || app.repo_url, move.repo_url, move.main_sha]);
  let rekeyed = 0;
  if (from && (from.owner.toLowerCase() !== to.owner.toLowerCase() || from.repo.toLowerCase() !== to.repo.toLowerCase())) {
    for (const [table, ownerCol, repoCol] of KEYED) {
      const r = await client.query(
        `UPDATE ${table} SET ${ownerCol} = $3, ${repoCol} = $4
          WHERE LOWER(${ownerCol}) = LOWER($1) AND LOWER(${repoCol}) = LOWER($2)`,
        [from.owner, from.repo, to.owner, to.repo]);
      rekeyed += r.rowCount;
    }
  }
  const pulls = await client.query(PULLS_SQL, [app.id]);
  await client.query('UPDATE git_host_moves SET applied_at = NOW() WHERE app_id = $1', [app.id]);
  return { slug: app.slug, rekeyed, pulls: pulls.rowCount, outcome: move.outcome };
}

async function migrate(pool) {
  const twins = await pool.query(TWIN_SQL);
  if (twins.rowCount) log.info('github-move', 'Requests copied from their twins', { count: twins.rowCount });

  const { rows: moves } = await pool.query(
    `SELECT app_id, repo_url, github_repo_url, main_sha, outcome FROM git_host_moves
      WHERE applied_at IS NULL ORDER BY app_id`);
  const applied = [];
  for (const move of moves) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const done = await applyMove(client, move);
      await client.query('COMMIT');
      if (done) applied.push(done);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('github-move', 'Could not apply a recorded move; it is tried again next boot', { appId: move.app_id, err: err.message });
    } finally {
      client.release();
    }
  }
  if (applied.length) {
    log.info('github-move', 'Apps moved to the git host', {
      count: applied.length, rekeyed: applied.reduce((n, a) => n + a.rekeyed, 0), pulls: applied.reduce((n, a) => n + a.pulls, 0),
    });
    try { require('./requests').invalidateApps(); } catch (_) { /* not loaded yet */ }
  }
  return { twins: twins.rowCount, applied };
}

module.exports = { migrate, TWIN_SQL, PULLS_SQL };
