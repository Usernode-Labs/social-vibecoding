// Where a feedback report's request lives, shared by the two readers that
// have to resolve it: the Me screen's own feedback list (#3186,
// src/routes/feedback.js) and the challenge page's itemized report list
// (#7152, ./challenge-items.js). Kept here rather than in the route so a
// service needing it does not import route-to-service.
'use strict';

const repoRef = require('../repo-ref');

// Platform feedback files into the platform repo, which is the self-hosted
// app's own repository, so its requests live on that app's board. Read once
// per request, and used only when its repo is the one the report went to.
const SELF_APP_SQL = `
  SELECT slug, name, repo_url
    FROM apps
   WHERE self_hosted = TRUE
   ORDER BY id ASC
   LIMIT 1
`;

// Pure (exported for tests): whether `repoUrl` is <owner>/<repo>'s address,
// with the case and `.git` tolerance findAppByRepo applies.
function repoMatches(repoUrl, owner, repo) {
  const { owner: o, repo: r } = repoRef.ownerRepo(repoUrl) || {};
  if (!o || !r || !owner || !repo) return false;
  const norm = (s) => String(s).replace(/\.git$/, '').toLowerCase();
  return norm(o) === norm(owner) && norm(r) === norm(repo);
}

module.exports = { SELF_APP_SQL, repoMatches };
