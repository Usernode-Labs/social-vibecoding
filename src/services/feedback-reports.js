'use strict';

// What POST /api/feedback (routes/feedback.js) files, as a service: the
// platform repository's issue, and the local receipt that says who on this
// platform it came from. #11 (WP3): the Homeroom bot's report_problem
// (homeroom-bot-mayor.js) files a report to the Homeroom team for the person
// it is talking to, and it calls this, not the HTTP route: the route is a
// browser's door, with a browser's rate limiter, screenshots, bounties and
// title generation, none of which a report the bot writes has.

const log = require('./logger');
const github = require('./github');
const repoRef = require('./repo-ref');

// Derive `owner/repo` from a github.com URL (the platform's own repository:
// its feedback is filed as GitHub issues). The route does this at
// route-factory load, so a malformed USERNODE_PLATFORM_REPO fails the
// platform fast at startup rather than 500-ing the first time a user clicks
// "Send feedback".
function parseGitHubRepo(url) {
  const ref = repoRef.parse(url);
  if (!ref || ref.host !== 'github') {
    throw new Error(`Expected github.com URL, got: ${url}`);
  }
  return { owner: ref.owner, repo: ref.repo };
}

/**
 * Pure: the words a failed platform filing is explained with, from its
 * status: no app has the platform's repository (404), a request it would
 * not take (422), anything else.
 */
function platformIssueHint(status) {
  if (status === 404) return 'no app has the platform repository (USERNODE_PLATFORM_REPO)';
  if (status === 422) return 'the request was refused (it needs a title)';
  return status ? `the request store answered ${status}` : 'the request store could not be reached';
}

/**
 * File one request on the platform's own board: a request row, like an
 * app's (services/requests.js, through github.createIssue).
 * Resolves { ok: true, issue } or { ok: false, status, hint }.
 */
async function createPlatformIssue({ owner, repo, title, body, labels = ['usernode'], createdBy = null }) {
  try {
    const issue = await github.createIssue(owner, repo, { title, body, labels, createdBy });
    return { ok: true, issue };
  } catch (err) {
    log.error('feedback', 'Could not file a platform request', { status: err.status || null, message: err.message });
    return { ok: false, status: err.status || 0, hint: platformIssueHint(err.status || 0) };
  }
}

// A local receipt for a report that reached GitHub.
//
// The issue is still the real output; this row exists because the issue
// cannot answer the two questions the season's feedback challenge asks. It
// was filed by the platform's bot account, so GitHub does not know WHO on
// this platform wrote it, and reading every issue back over the API once a
// tick to find out would be absurd. Written only after the issue exists, so
// the scorer can never pay for feedback that reached nobody.
//
// Best-effort like the acknowledgement after it: the report is filed and the
// person has been helped, so a bookkeeping failure must not turn their
// submission into an error and invite a duplicate. `source` is null for the
// feedback dialog, and 'homeroom_bot' for a report the bot filed for them.
async function recordFeedbackReport(pool, { user, app, owner, repo, issueNumber, title, description, source = null,
  bodyPrefix = null, bodySuffix = null }) {
  if (!user?.id) return;
  try {
    const { rows } = await pool.query(
      `INSERT INTO feedback_reports
         (user_id, target, app_id, issue_owner, issue_repo, issue_number, title, description, source, body_prefix, body_suffix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [user.id, app ? 'app' : 'platform', app ? app.id : null,
        owner || null, repo || null,
        Number.isSafeInteger(issueNumber) ? issueNumber : null,
        title ? String(title).slice(0, 512) : null, description, source, bodyPrefix, bodySuffix]
    );
    return rows[0] || null;
  } catch (err) {
    log.warn('feedback', 'Feedback report record failed', { issueNumber, message: err.message });
  }
}

/**
 * How many reports `userId` has filed through `source` since `hours` ago:
 * what a door that files for somebody else rate-limits them by.
 */
async function recentReports(pool, { userId, source, hours = 24 }) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM feedback_reports
      WHERE user_id = $1 AND source = $2 AND created_at > NOW() - make_interval(hours => $3)`,
    [userId, source, hours],
  );
  return rows[0]?.n || 0;
}

/**
 * #11 (WP3): file a report to the Homeroom team for `user`, as the feedback
 * dialog files platform feedback: an issue in the platform repository whose
 * Source line names them (routes/issues.js creatorFromSourceLine reads it),
 * the open-issue panels told, and its receipt under their name with
 * `source`. `body` is everything under the Source line, and is PUBLIC (the
 * platform repository's issues are); `description` is the receipt's, which
 * is private (feedback_reports is staging:private) and may say more than
 * the issue does. Resolves { ok: true, issueNumber, url } or
 * { ok: false, error } ('not_configured', 'github', 'failed'). Never throws.
 */
async function filePlatformReport(pool, config, {
  user, title, body, description, source, via = null,
}) {
  if (!user?.id || !config?.platformRepoUrl) return { ok: false, error: 'not_configured' };
  try {
    const { owner, repo } = parseGitHubRepo(config.platformRepoUrl);
    const who = user.isAdmin ? `Homeroom admin (${user.username})` : `Homeroom user (${user.username})`;
    const created = await createPlatformIssue({
      owner, repo, title, body: `**Source:** ${who}${via ? `, ${via}` : ''}\n\n${body}`, createdBy: user.id,
    });
    if (!created.ok) return { ok: false, error: 'github', hint: created.hint };
    const issue = created.issue;
    await require('./issue-announce').announceIssueCreated(pool, owner, repo, issue, null);
    // #3952: the people the report names with @. Never rejects.
    require('./notifications').notifyIssueMentions?.(pool, {
      owner, repo, issueNumber: issue.number, authorId: user.id, text: `${title}\n\n${body}`,
    });
    await recordFeedbackReport(pool, {
      user, app: null, owner, repo, issueNumber: issue.number, title, description, source,
    });
    log.info('feedback', 'Filed a report for a person', { userId: user.id, source, issueNumber: issue.number });
    return { ok: true, issueNumber: Number(issue.number) || null, url: issue.html_url || null };
  } catch (err) {
    log.warn('feedback', 'Could not file a report for a person', { userId: user.id, source, message: err.message });
    return { ok: false, error: 'failed' };
  }
}

module.exports = {
  parseGitHubRepo,
  platformIssueHint,
  createPlatformIssue,
  recordFeedbackReport,
  recentReports,
  filePlatformReport,
};
