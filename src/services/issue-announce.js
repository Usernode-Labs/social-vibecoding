const log = require('./logger');
const { pushIssueUpdate } = require('./ws');
const repoRef = require('./repo-ref');
// ACCESS_COLUMNS only; app-access.js depends on nothing but the logger, so
// there is no cycle back through here.
const { ACCESS_COLUMNS } = require('./app-access');

// Resolve the app row backed by a given repo, or undefined. The
// platform repo is itself an app on self-hosted instances, which is why a
// caller that only knows `owner/repo` can still find a target. Matching is
// case-insensitive and tolerant of a trailing `.git`, mirroring how repo_url
// is written across the fleet.
//
// Extracted so the feedback route's bounty placement targets the SAME app row
// this file broadcasts to — a bounty attached to one app while the
// issue_update went to another would render a pill no panel ever refreshes.
//
// The projection carries ACCESS_COLUMNS, not just the id/slug this file's own
// broadcast needs: routes/feedback.js runs the returned row through
// appAccess.checkAppAccess for the bounty's collab gate, and that function
// THROWS on a row whose visibility columns were trimmed away. Selecting them
// here keeps every caller safe rather than making the next one rediscover it.
async function findAppByRepo(pool, owner, repo) {
  const { rows } = await pool.query(`SELECT ${ACCESS_COLUMNS}, repo_url FROM apps`);
  return rows.find((r) => {
    const ref = repoRef.ownerRepo(r.repo_url);
    return ref
      && ref.owner.toLowerCase() === owner.toLowerCase()
      && ref.repo.toLowerCase() === repo.replace(/\.git$/, '').toLowerCase();
  });
}

// After an issue lands through a platform path, broadcast an issue_update
// so connected clients re-pull the request board
// (App.handleIssueUpdate → AppView.loadVotePanel). `app` is the known
// target row for app feedback, or null when the caller only knows the
// repo — in that case we look the app up by repo, since the platform repo
// is itself an app on self-hosted instances. Best-effort: a failure here
// must never fail the request (the issue is already filed).
//
// Shared by the feedback routes (routes/feedback.js) and the
// platform-issue draft confirm path (routes/sessions.js).
async function announceIssueCreated(pool, owner, repo, rawIssue, app) {
  try {
    const target = app || await findAppByRepo(pool, owner, repo);
    if (target) {
      pushIssueUpdate({
        action: 'created',
        source: 'github',
        appSlug: target.slug,
        appId: target.id,
        issueNumber: rawIssue.number,
      });
    }
  } catch (err) {
    log.warn('issue-announce', 'Failed to announce new issue', { repo: `${owner}/${repo}`, message: err.message });
  }
}

module.exports = { announceIssueCreated, findAppByRepo };
