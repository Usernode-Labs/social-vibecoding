'use strict';

// Post-merge issue-close watcher (#135).
//
// When a PR merges, GitHub itself closes the issues referenced via closing
// keywords (`Closes #N`, `Fixes #N`, `Resolves #N`) in the PR body — but it
// does so asynchronously, often a few seconds after the merge reports
// success. The platform's "Open Issues" panel in the group chat area busts
// its cache and refetches at merge time, which races that delay: the
// refetch can see the issue still open and re-cache it as open for the
// 5-minute fetchPublicIssues TTL, so the panel keeps showing a closed
// issue.
//
// This watcher closes the gap WITHOUT writing anything to GitHub (closing
// is GitHub's job and it does it reliably — just late): it polls the
// referenced issues with retry/backoff until they read as closed (or
// attempts run out), and once closes are observed it busts the open-issues
// cache and broadcasts the same `github_synced` refresh event the merge
// path uses, so every group-chat panel refetches and drops the issue.
//
// Everything here is best-effort. watchIssuesClosedAfterMerge is
// fired-and-forgotten from the merge path (routes/votes.js checkAndMerge)
// and must never block, slow down, or roll back the merge flow — failures
// are logged and abandoned.

const log = require('./logger');
const github = require('./github');
const { parseClosingKeywords, sanitizeIssueNumbers } = require('./pr-metadata');

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Tunables (env-overridable so tests can zero the delays):
// - GRACE: wait before the first poll — GitHub's auto-close usually lands
//   within a couple of seconds, so the first check often already sees
//   everything closed.
// - ATTEMPTS / BACKOFF: poll rounds; the delay between rounds doubles each
//   time (3s, 6s, 12s, 24s by default → ~45s of total patience).
const GRACE_DELAY_MS = envInt('ISSUE_CLOSE_WATCH_GRACE_MS', 2000);
const MAX_ATTEMPTS = envInt('ISSUE_CLOSE_WATCH_ATTEMPTS', 5);
const BACKOFF_BASE_MS = envInt('ISSUE_CLOSE_WATCH_BACKOFF_MS', 3000);

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
    log.warn('issue-close-watcher', 'Failed to fetch merged PR body; using linked_issues only', {
      repo: `${owner}/${repo}`, pr: prNumber, err: err.message,
    });
  }
  const linked = Array.isArray(linkedIssues) ? linkedIssues : [];
  return sanitizeIssueNumbers([...linked, ...parsed]);
}

// Check one issue's state. Returns:
//   'closed'  — GitHub's auto-close has landed
//   'open'    — not yet; keep polling
//   'skipped' — #N is a PR (issue/PR numbers share one sequence and the
//               closing-keyword regex can't tell them apart), or the issue
//               is gone (404/410) — either way, stop watching it
//   'error'   — transient fetch failure; keep polling
async function checkIssueState(owner, repo, issueNumber) {
  try {
    const issue = await github.getIssue(owner, repo, issueNumber);
    if (issue && issue.pull_request) return 'skipped';
    return issue && issue.state === 'closed' ? 'closed' : 'open';
  } catch (err) {
    const status = err.status || (err.response && err.response.status);
    if (status === 404 || status === 410) return 'skipped';
    log.warn('issue-close-watcher', 'Issue state check failed; will retry', {
      repo: `${owner}/${repo}`, issue: issueNumber, err: err.message,
    });
    return 'error';
  }
}

// Bust this repo's open-issues cache and tell every client viewing the
// app's group chat to refetch (App.handleIssueUpdate → loadVotePanel).
// Same event shape the merge path broadcasts at merge time. `closed`
// carries the numbers whose closure was just observed — they're
// recorded on the known-closed suppression list (#144) so the refetch
// can't resurrect them even when GitHub's eventually-consistent
// anonymous list endpoint still reports them open.
function bustAndBroadcast({ owner, repo, appSlug, appId, closed }) {
  try {
    if (Array.isArray(closed) && closed.length) {
      github.noteIssuesClosed(owner, repo, closed);
    }
    github.invalidateIssuesCache(owner, repo);
    const { pushIssueUpdate } = require('./ws');
    pushIssueUpdate({
      action: 'github_synced',
      appSlug: appSlug || null,
      appId: appId || null,
      source: 'issue_close_watcher',
    });
  } catch (err) {
    log.warn('issue-close-watcher', 'Cache bust / broadcast failed', {
      repo: `${owner}/${repo}`, err: err.message,
    });
  }
}

// Entry point, fired-and-forgotten from the merge path. Polls until every
// referenced issue reads as closed (or attempts are exhausted), busting
// the cache + broadcasting whenever new closes are observed. Returns the
// per-bucket outcome (useful for tests); unexpected throws are absorbed by
// the caller's .catch().
async function watchIssuesClosedAfterMerge({ owner, repo, prNumber, linkedIssues, appSlug, appId }) {
  const empty = { closed: [], skipped: [], stillOpen: [] };
  if (!github.isEnabled() || !owner || !repo || !prNumber) return empty;

  await sleep(GRACE_DELAY_MS);

  const numbers = await resolveIssueNumbers({ owner, repo, prNumber, linkedIssues });
  if (!numbers.length) return empty;

  // #144: optimistically suppress every referenced number up front. The
  // merge path already did this for linked_issues, but the resolved set
  // can be wider (hand-edited `Closes #N` in the PR body), and when this
  // watch is RESUMED after a platform restart (server.js
  // resumeIssueCloseWatches — the self-edits app's GHA deploy rolls the
  // platform right after merge, killing the original watcher) the fresh
  // process has an empty suppression list. Anything that turns out to
  // still be open is unsuppressed below.
  try {
    github.noteIssuesClosed(owner, repo, numbers);
  } catch (err) {
    log.warn('issue-close-watcher', 'Optimistic issue suppression failed', {
      repo: `${owner}/${repo}`, err: err.message,
    });
  }

  const closed = [];
  const skipped = [];
  let pending = numbers;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length; attempt++) {
    const stillPending = [];
    const newlyClosed = [];
    for (const n of pending) {
      const state = await checkIssueState(owner, repo, n);
      if (state === 'closed') newlyClosed.push(n);
      else if (state === 'skipped') skipped.push(n);
      else stillPending.push(n); // 'open' or transient 'error'
    }
    if (newlyClosed.length) {
      closed.push(...newlyClosed);
      bustAndBroadcast({ owner, repo, appSlug, appId, closed: newlyClosed });
    }
    pending = stillPending;
    if (pending.length && attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }

  if (pending.length) {
    log.warn('issue-close-watcher', 'Gave up waiting for GitHub to close issues', {
      repo: `${owner}/${repo}`, pr: prNumber, stillOpen: pending, attempts: MAX_ATTEMPTS,
    });
    // These are genuinely still open on GitHub — lift the optimistic
    // suppression so they aren't hidden from the panel for the full
    // suppression TTL.
    try {
      github.unsuppressIssues(owner, repo, pending);
    } catch (err) {
      log.warn('issue-close-watcher', 'Unsuppress failed', {
        repo: `${owner}/${repo}`, err: err.message,
      });
    }
  }
  log.info('issue-close-watcher', 'Post-merge close watch done', {
    repo: `${owner}/${repo}`, pr: prNumber, closed, skipped, stillOpen: pending,
  });

  return { closed, skipped, stillOpen: pending };
}

module.exports = { watchIssuesClosedAfterMerge, resolveIssueNumbers };
