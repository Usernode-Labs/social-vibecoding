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

// Derive `owner/repo` from a github.com URL. The route does this at
// route-factory load, so a malformed USERNODE_PLATFORM_REPO fails the
// platform fast at startup rather than 500-ing the first time a user clicks
// "Send feedback".
function parseGitHubRepo(url) {
  const u = new URL(url);
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') {
    throw new Error(`Expected github.com URL, got: ${url}`);
  }
  const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Expected /<owner>/<repo> path, got: ${url}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Pure: the words a failed platform-issue call is explained with. The status
 * alone, never GitHub's body (it can leak repo metadata), but enough to tell
 * "bot has no access to the feedback repo" (404) from "PAT revoked" (401)
 * from rate limiting (403) without reading server logs.
 */
function platformIssueHint(status) {
  if (status === 404) {
    return 'feedback repo not visible to the bot. Add usernode-bot as a collaborator or install the GitHub App on it';
  }
  if (status === 401) return 'GITHUB_BOT_TOKEN is invalid or expired';
  if (status === 403) return 'bot lacks Issues:write on the feedback repo, or is rate-limited';
  return `GitHub returned ${status}`;
}

/**
 * File one issue into the platform's feedback repository with the bot's
 * token. A hand-rolled call that bypasses github.js's write helpers, so the
 * title and body go through safeMention here: they are free text a person
 * (or the bot, for a person) wrote, and could carry live @mentions (#723).
 * Resolves { ok: true, issue } or { ok: false, status, hint }.
 */
async function createPlatformIssue({ owner, repo, title, body, pat = process.env.GITHUB_BOT_TOKEN, fetchImpl = null }) {
  const send = fetchImpl || globalThis.fetch;
  const ghRes = await send(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `token ${pat}`,
      'User-Agent': 'usernode-social-vibecoding',
    },
    body: JSON.stringify({
      title: github.safeMention(title),
      body: github.safeMention(body),
      labels: ['usernode'],
    }),
  });
  if (!ghRes.ok) {
    const err = await ghRes.text();
    log.error('feedback', 'GitHub API error', { status: ghRes.status, body: err });
    return { ok: false, status: ghRes.status, hint: platformIssueHint(ghRes.status) };
  }
  return { ok: true, issue: await ghRes.json() };
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
async function recordFeedbackReport(pool, { user, app, owner, repo, issueNumber, title, description, source = null }) {
  if (!user?.id) return;
  try {
    await pool.query(
      `INSERT INTO feedback_reports
         (user_id, target, app_id, issue_owner, issue_repo, issue_number, title, description, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [user.id, app ? 'app' : 'platform', app ? app.id : null,
        owner || null, repo || null,
        Number.isSafeInteger(issueNumber) ? issueNumber : null,
        title ? String(title).slice(0, 512) : null, description, source]
    );
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
  user, title, body, description, source, via = null, fetchImpl = null,
}) {
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (!user?.id || !pat || !config?.platformRepoUrl) return { ok: false, error: 'not_configured' };
  try {
    const { owner, repo } = parseGitHubRepo(config.platformRepoUrl);
    const who = user.isAdmin ? `Homeroom admin (${user.username})` : `Homeroom user (${user.username})`;
    const created = await createPlatformIssue({
      owner, repo, title, body: `**Source:** ${who}${via ? `, ${via}` : ''}\n\n${body}`, pat, fetchImpl,
    });
    if (!created.ok) return { ok: false, error: 'github', hint: created.hint };
    const issue = created.issue;
    await require('./issue-announce').announceIssueCreated(pool, owner, repo, issue, null);
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
