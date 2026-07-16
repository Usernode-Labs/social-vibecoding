const log = require('./logger');
const github = require('./github');
const { pushIssueUpdate } = require('./ws');

// #125: after an issue lands in a repo through a platform path, make the
// "Open Issues" panel of any app backed by that repo update without a
// reload. Two halves: seed the server-side open-issues cache with the new
// issue (warm path — no extra GitHub list call, no read-after-write lag;
// the #192 recently-created overlay inside noteIssueCreated also covers
// the cold-cache / eventually-consistent-list cases), then broadcast an
// issue_update so connected clients re-pull the panel
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
    github.noteIssueCreated(owner, repo, rawIssue);
    let target = app;
    if (!target) {
      const { rows } = await pool.query('SELECT id, slug, repo_url FROM apps');
      target = rows.find((r) => {
        const [, o, rp] = (r.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        return o && rp
          && o.toLowerCase() === owner.toLowerCase()
          && rp.replace(/\.git$/, '').toLowerCase() === repo.replace(/\.git$/, '').toLowerCase();
      });
    }
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

module.exports = { announceIssueCreated };
