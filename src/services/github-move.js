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
//
// 3. The proposals' links: a moved app's proposals were opened on GitHub, so
//    their pr_url still named GitHub's page for the pull request, dead since
//    the suspension ("Open on GitHub" on the change's Details, `prUrl` from
//    the connector, open, merged and closed alike). Each becomes the change's
//    page in Homeroom, the address a proposal opened on the git host has
//    (native-pulls changeUrl). Only a pull request of the app's own old
//    repository, on an app whose repository is now on the git host: the
//    platform's own repository and an app still on GitHub keep theirs.

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

// Step 3's candidates: proposals with a number on an app whose move was
// applied, whose link is still a pull request on GitHub (as GitHub wrote
// it). Once moved they are not candidates again.
const GITHUB_LINKS_SQL = `
  SELECT cs.id, cs.pr_number, cs.pr_url, a.slug, a.repo_url,
         COALESCE(a.github_repo_url, m.github_repo_url) AS github_repo_url
    FROM git_host_moves m
    JOIN apps a ON a.id = m.app_id
    JOIN chat_sessions cs ON cs.app_id = a.id
   WHERE m.applied_at IS NOT NULL
     AND cs.pr_number > 0
     AND cs.pr_url ILIKE 'https://github.com/%/pull/%'
   ORDER BY cs.id`;

// Unless the link changed since it was read.
const RELINK_SQL = `
  UPDATE chat_sessions cs SET pr_url = l.url
    FROM unnest($1::int[], $2::text[], $3::text[]) AS l(id, was, url)
   WHERE cs.id = l.id AND cs.pr_url = l.was`;

const GITHUB_PULL = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/pull\/\d+(?:[/?#]\S*)?$/i;

/**
 * Which candidates move, and to where: { id, was, url } for each whose link
 * is a pull request of the app's old repository on GitHub and whose app's
 * repository is on the git host now.
 */
function changePages(rows) {
  const out = [];
  for (const row of rows || []) {
    const m = String(row.pr_url || '').trim().match(GITHUB_PULL);
    if (!m || !row.slug || !(Number(row.pr_number) > 0)) continue;
    if (!repoRef.isHosted(row.repo_url) || !repoRef.isGithub(row.github_repo_url)) continue;
    if (!repoRef.sameRepo(m[1], row.github_repo_url)) continue;
    out.push({ id: row.id, was: row.pr_url, url: require('./native-pulls').changeUrl(row.slug, Number(row.pr_number)) });
  }
  return out;
}

// Best effort: a failure logs and boot goes on; the links move next boot.
async function relinkProposals(pool) {
  try {
    const { rows } = await pool.query(GITHUB_LINKS_SQL);
    const moves = changePages(rows);
    if (!moves.length) return 0;
    const r = await pool.query(RELINK_SQL, [moves.map((x) => x.id), moves.map((x) => x.was), moves.map((x) => x.url)]);
    log.info('github-move', 'Proposal links moved from GitHub to their change pages', { count: r.rowCount });
    return r.rowCount;
  } catch (err) {
    log.warn('github-move', 'Proposal links not moved (query failed); tried again next boot', { err: err.message });
    return 0;
  }
}

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
  // After the moves, so a move applied on this boot has its links moved too.
  const links = await relinkProposals(pool);
  return { twins: twins.rowCount, applied, links };
}

module.exports = { migrate, changePages, relinkProposals, TWIN_SQL, PULLS_SQL, GITHUB_LINKS_SQL, RELINK_SQL };
