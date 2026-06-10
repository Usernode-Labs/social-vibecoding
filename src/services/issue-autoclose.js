'use strict';

// Post-merge issue auto-close (#135).
//
// GitHub closes issues referenced via closing keywords (`Closes #N`,
// `Fixes #N`, `Resolves #N`) in a merged PR's body, but that native
// handling runs asynchronously on GitHub's side and sometimes lags the
// merge by long enough that the platform's "Open Issues" panel — and the
// 5-minute fetchPublicIssues cache behind it — re-learns the issue as
// still open. This service makes the close deterministic: after the
// platform merges a PR it parses the merged PR body for closing keywords,
// gives GitHub a short grace period to do its own close, then explicitly
// closes whatever is still open via the API, retrying each issue with
// exponential backoff.
//
// Everything here is best-effort. autoCloseIssuesForMergedPR is
// fired-and-forgotten from the merge path (routes/votes.js checkAndMerge)
// and must never throw into, slow down, or roll back the merge flow —
// failures are logged and abandoned, and an issue GitHub already closed
// natively is skipped, not double-closed.

const log = require('./logger');
const github = require('./github');
const { parseClosingKeywords, sanitizeIssueNumbers } = require('./pr-metadata');

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Tunables (env-overridable so tests can zero the delays):
// - GRACE: wait before the first state check, giving GitHub's native
//   auto-close a chance to win — the common case, which we detect via
//   getIssue and skip without an extra write.
// - ATTEMPTS / BACKOFF: per-issue close attempts; the delay doubles after
//   each failed attempt (4s, 8s by default).
const GRACE_DELAY_MS = envInt('ISSUE_AUTOCLOSE_GRACE_MS', 5000);
const MAX_ATTEMPTS = envInt('ISSUE_AUTOCLOSE_ATTEMPTS', 3);
const BACKOFF_BASE_MS = envInt('ISSUE_AUTOCLOSE_BACKOFF_MS', 4000);

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Resolve the set of issue numbers the merged PR closes: the session's
// linked_issues (the deterministic source behind the PR body's `Closes #N`
// block) unioned with whatever closing keywords the merged body actually
// carries — a hand-edited body can reference issues the session never
// linked. Falls back to linkedIssues alone if the PR fetch fails.
async function resolveIssueNumbers({ owner, repo, prNumber, linkedIssues }) {
  let parsed = [];
  try {
    const pr = await github.getPR(owner, repo, prNumber);
    parsed = parseClosingKeywords(pr && pr.body);
  } catch (err) {
    log.warn('issue-autoclose', 'Failed to fetch merged PR body; using linked_issues only', {
      repo: `${owner}/${repo}`, pr: prNumber, err: err.message,
    });
  }
  const linked = Array.isArray(linkedIssues) ? linkedIssues : [];
  return sanitizeIssueNumbers([...linked, ...parsed]);
}

// Close a single issue, verifying its state first and retrying with
// backoff. Returns one of:
//   'closed'         — we closed it
//   'already-closed' — GitHub's native auto-close (or someone else) won
//   'skipped'        — #N is a PR, or the issue is gone (404/410)
//   'failed'         — all attempts exhausted
async function closeIssueWithRetry(owner, repo, issueNumber) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const issue = await github.getIssue(owner, repo, issueNumber);
      // The closing-keyword regex can't tell "#N is an issue" from "#N is
      // a PR" — GitHub numbers both in one sequence. Never close PRs here.
      if (issue && issue.pull_request) return 'skipped';
      if (issue && issue.state === 'closed') return 'already-closed';
      await github.closeIssue(owner, repo, issueNumber);
      return 'closed';
    } catch (err) {
      const status = err.status || (err.response && err.response.status);
      // Deleted / transferred / never existed — retrying can't help.
      if (status === 404 || status === 410) return 'skipped';
      if (attempt === MAX_ATTEMPTS) {
        log.warn('issue-autoclose', 'Giving up closing issue', {
          repo: `${owner}/${repo}`, issue: issueNumber, attempts: attempt, err: err.message,
        });
        return 'failed';
      }
      const delayMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      log.warn('issue-autoclose', 'Close attempt failed; retrying', {
        repo: `${owner}/${repo}`, issue: issueNumber, attempt, delayMs, err: err.message,
      });
      await sleep(delayMs);
    }
  }
  return 'failed';
}

// Entry point, fired-and-forgotten from the merge path. Returns the
// per-bucket outcome (useful for tests); never throws past its own logging
// except for truly unexpected programming errors, which the caller's
// .catch() absorbs.
async function autoCloseIssuesForMergedPR({ owner, repo, prNumber, linkedIssues, appSlug, appId }) {
  const empty = { closed: [], alreadyClosed: [], skipped: [], failed: [] };
  if (!github.isEnabled() || !owner || !repo || !prNumber) return empty;

  await sleep(GRACE_DELAY_MS);

  const numbers = await resolveIssueNumbers({ owner, repo, prNumber, linkedIssues });
  if (!numbers.length) return empty;

  const result = { closed: [], alreadyClosed: [], skipped: [], failed: [] };
  for (const n of numbers) {
    const outcome = await closeIssueWithRetry(owner, repo, n);
    if (outcome === 'closed') result.closed.push(n);
    else if (outcome === 'already-closed') result.alreadyClosed.push(n);
    else if (outcome === 'skipped') result.skipped.push(n);
    else result.failed.push(n);
  }

  log.info('issue-autoclose', 'Post-merge issue auto-close done', {
    repo: `${owner}/${repo}`, pr: prNumber, ...result,
  });

  // The merge path already busted the open-issues cache, but that happened
  // before our grace delay — a panel reload in between may have re-cached
  // the issue as open. If we closed anything ourselves, bust again and tell
  // clients to refetch (same event the merge path broadcasts).
  if (result.closed.length) {
    try {
      github.invalidateIssuesCache(owner, repo);
      const { pushIssueUpdate } = require('./ws');
      pushIssueUpdate({
        action: 'github_synced',
        appSlug: appSlug || null,
        appId: appId || null,
        source: 'issue_autoclose',
      });
    } catch (err) {
      log.warn('issue-autoclose', 'Cache bust / broadcast after auto-close failed', {
        repo: `${owner}/${repo}`, err: err.message,
      });
    }
  }

  return result;
}

module.exports = { autoCloseIssuesForMergedPR, closeIssueWithRetry, resolveIssueNumbers };
