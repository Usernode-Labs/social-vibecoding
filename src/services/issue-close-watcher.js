'use strict';

// What a merge does about the requests it closes (#135), for the
// merge-followups machine's issues.closeAfterMerge work.
//
// When a PR merges, GitHub itself closes the issues referenced via closing
// keywords (`Closes #N`, `Fixes #N`, `Resolves #N`) in the PR body, but it
// does so asynchronously, often a few seconds after the merge reports
// success, and on 2026-09-30 it stopped applying them to merged PRs for
// hours. So the machine looks twice: at the first look a linked request
// still open is left to GitHub, and the machine asks for a second look a
// little later (machine.ts ISSUES_SECOND_LOOK_MS); at the second, the
// session's LINKED issues still open are closed here (closeLinkedIssues
// below), and only those, and only after re-reading the PR as merged into
// the repo's default branch. Numbers that come solely from a hand-edited
// PR body are looked at but never closed here.
//
// Every number seen closed, or closed here, also closes the platform's own
// `general` twin row for that request (closeTwinRows below), and withdraws
// the Homeroom bot's proposals that were built for it alone
// (withdrawBotProposals below). The close proposals whose target it was are
// the governance machine's: the work names them (targets), and the
// transition that applies its result tells each one. Every web process
// forgets its copy of the open issues from the transition's push, too.
// Nothing here waits or keeps anything between looks: a look is one pass.

const log = require('./logger');
const github = require('./github');
const { parseClosingKeywords, sanitizeIssueNumbers } = require('./pr-metadata');

// Fetch the merged PR once: its body feeds resolveIssueNumbers and its merge
// state gates closeLinkedIssues. Null when the fetch fails.
async function fetchPr(owner, repo, prNumber) {
  try {
    return await github.getPR(owner, repo, prNumber);
  } catch (err) {
    log.warn('issue-close-watcher', 'Failed to fetch merged PR body; using linked_issues only', {
      repo: `${owner}/${repo}`, pr: prNumber, err: err.message,
    });
    return null;
  }
}

// Resolve the set of issue numbers the merged PR closes: the session's
// linked_issues (the deterministic source behind the PR body's `Closes #N`
// block) unioned with whatever closing keywords the merged body actually
// carries — a hand-edited body can reference issues the session never
// linked. Falls back to linkedIssues alone if the PR fetch fails. `pr`, when
// passed, is the already-fetched PR (null = the fetch failed).
async function resolveIssueNumbers({ owner, repo, prNumber, linkedIssues, pr }) {
  const fetched = pr === undefined ? await fetchPr(owner, repo, prNumber) : pr;
  const parsed = parseClosingKeywords(fetched && fetched.body);
  const linked = Array.isArray(linkedIssues) ? linkedIssues : [];
  return sanitizeIssueNumbers([...linked, ...parsed]);
}

// Whether `pr` is merged into the default branch of owner/repo itself — the
// condition under which GitHub's own `Closes #N` would have fired. A PR from
// another repository's base, an unmerged PR, or a payload missing any of
// these fields answers false, and nothing is closed.
function mergedIntoDefaultBranch(pr, owner, repo) {
  if (!pr || pr.merged !== true) return false;
  const base = pr.base || {};
  const baseRepo = base.repo || {};
  const norm = (s) => String(s || '').replace(/\.git$/i, '').toLowerCase();
  if (!baseRepo.full_name || norm(baseRepo.full_name) !== norm(`${owner}/${repo}`)) return false;
  return !!base.ref && base.ref === baseRepo.default_branch;
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

// Tell clients to re-read the request board after a closure is observed.
function broadcastClosed({ owner, repo, appSlug, appId }) {
  try {
    const { pushIssueUpdate } = require('./ws');
    pushIssueUpdate({
      action: 'github_synced',
      appSlug: appSlug || null,
      appId: appId || null,
      source: 'issue_close_watcher',
    });
  } catch (err) {
    log.warn('issue-close-watcher', 'Request closure broadcast failed', {
      repo: `${owner}/${repo}`, err: err.message,
    });
  }
}

// Close the platform's own record of each request just observed closed: the
// `general` twin row a platform-filed request keeps beside its GitHub issue
// to remember who filed it (services/governance-kinds.js). Until this, the
// only path that closed a twin was an applied close-issue vote
// (routes/issues.js), so every request a merged proposal closed kept an open
// twin for good, and every reader counting open rows counted it (Plant Pal's
// #1 still read open after PR #2 closed it). Only numbers GitHub reported
// closed, or that the watcher closed itself, land here. Same contract as
// resolveSupersededProposals: a no-op without a pool, fired-and-forgotten,
// and a failure never touches the poll loop. `strict` as there.
function closeTwinRows({ pool, appId, prNumber, numbers, strict = false }) {
  if (!pool || !appId || !Array.isArray(numbers) || !numbers.length) return Promise.resolve();
  try {
    return Promise.resolve(pool.query(
      `UPDATE issues SET status = 'closed'
        WHERE app_id = $1 AND kind = 'general' AND status = 'open'
          AND github_issue_number = ANY($2::int[])`,
      [appId, numbers]
    )).then(() => {}, (err) => {
      if (strict) throw err;
      log.warn('issue-close-watcher', 'Closing request twin rows failed', {
        pr: prNumber, issues: numbers, err: err.message,
      });
    });
  } catch (err) {
    if (strict) return Promise.reject(err);
    log.warn('issue-close-watcher', 'Closing request twin rows failed', {
      pr: prNumber, issues: numbers, err: err.message,
    });
    return Promise.resolve();
  }
}

// Withdraw the Homeroom bot's proposals up for a vote whose requests are now
// all closed (homeroom-bot-closed-requests.js). A request a person's change
// shipped otherwise kept the bot's proposal for it up, and holding one of the
// bot's per-project proposal slots, for good. Lazy require, same reason as
// resolveSupersededProposals. Same contract as closeTwinRows: a no-op without
// a pool, never a reason the watch fails unless `strict`.
// The requesters' "done another way" DM is best effort here: a DM that keeps
// failing must not keep the requests a merge closes from closing.
function withdrawBotProposals({ pool, appId, prNumber, numbers, strict = false }) {
  if (!pool || !appId || !Array.isArray(numbers) || !numbers.length) return Promise.resolve();
  try {
    const { noteRequestsClosed } = require('./homeroom-bot-closed-requests');
    return noteRequestsClosed(pool, { appId, closed: numbers, strict, tellStrict: false }).then(() => {}, (err) => {
      if (strict) throw err;
      log.warn('issue-close-watcher', 'Withdrawing the bot\'s proposals for closed requests failed', {
        pr: prNumber, issues: numbers, err: err.message,
      });
    });
  } catch (err) {
    if (strict) return Promise.reject(err);
    log.warn('issue-close-watcher', 'Withdrawing the bot\'s proposals for closed requests failed', {
      pr: prNumber, issues: numbers, err: err.message,
    });
    return Promise.resolve();
  }
}

// Close, on GitHub, the linked issues GitHub left open after the grace polls.
// Returns { closed, failed }.
//
// Why this is safe to do without a vote of its own: the numbers are the
// session's linked_issues, never the PR body's keywords and never anything a
// request supplies here. Only the proposal's author (or a write admin) can
// link an issue (proposal_start / prepare_work / update_proposal_issues), the
// link is shown on the proposal the group votes on, and the platform writes
// it into the PR body as `Closes #N` — so closing it on merge is exactly what
// GitHub itself would have done. It runs only from the merge path (and its
// post-restart resume), only for a PR re-read as merged into this repo's
// default branch, and only in owner/repo, the app's own repository, parsed
// from repo_url the same way the close-issue vote parses it.
async function closeLinkedIssues({ owner, repo, prNumber, pr, linkedIssues, stillOpen }) {
  const linked = new Set(sanitizeIssueNumbers(linkedIssues));
  const targets = stillOpen.filter((n) => linked.has(n));
  const closed = [];
  const failed = [];
  if (!targets.length) return { closed, failed };
  if (!mergedIntoDefaultBranch(pr, owner, repo)) {
    log.warn('issue-close-watcher', 'Not closing linked issues: PR not verified as merged into the default branch', {
      repo: `${owner}/${repo}`, pr: prNumber, issues: targets,
    });
    return { closed, failed: targets };
  }
  for (const n of targets) {
    try {
      await github.closeIssue(owner, repo, n);
      closed.push(n);
      log.info('issue-close-watcher', 'Closed linked issue GitHub left open after merge', {
        repo: `${owner}/${repo}`, pr: prNumber, issue: n,
      });
    } catch (err) {
      failed.push(n);
      log.warn('issue-close-watcher', 'Closing linked issue after merge failed', {
        repo: `${owner}/${repo}`, pr: prNumber, issue: n, status: err.status, err: err.message,
      });
    }
  }
  return { closed, failed };
}

// The open close proposals of the app whose target is one of `numbers`:
// what the governance machine is told was closed (or is gone).
async function closeProposalTargets(pool, appId, numbers) {
  if (!pool || !appId || !numbers.length) return [];
  const { rows } = await pool.query(
    `SELECT id, (payload->>'issueNumber')::int AS number FROM issues
      WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
        AND (payload->>'issueNumber')::int = ANY($2::int[])
      ORDER BY id`, [appId, numbers]);
  return rows.map((r) => ({ issueId: Number(r.id), number: Number(r.number) }));
}

// One look at the requests a merged PR closes (the merge-followups
// machine's issues.closeAfterMerge). `look` 1: what GitHub has closed;
// a linked request still open is left to it, and `waiting` asks for the
// second look. `look` 2: the linked ones still open are closed here. A
// failure to record a close (twin rows, the bot's proposals) throws, for
// the work to retry. Answers { closed, skipped, stillOpen, waiting,
// targets }: `targets` are the close proposals to supersede.
async function closeAfterMerge({ owner, repo, prNumber, linkedIssues, appId, pool, look = 1 }) {
  const empty = { closed: [], skipped: [], stillOpen: [], waiting: false, targets: [] };
  // #6019: the first of competing changes to go live closes the others in
  // its thread (threads.js closeRivals, which never throws). A vote to close
  // that competed with it was filed on a request it closes, so it is
  // superseded below, as any close proposal is, once that request is seen
  // closed.
  if (look === 1 && pool && appId && prNumber) await require('./threads').closeRivals(pool, { appId, prNumber });
  if (!github.isEnabled() || !owner || !repo || !prNumber) return empty;
  const pr = await fetchPr(owner, repo, prNumber);
  const numbers = await resolveIssueNumbers({ owner, repo, prNumber, linkedIssues, pr });
  if (!numbers.length) return empty;
  const closed = [];
  const skipped = [];
  let open = [];
  for (const n of numbers) {
    const state = await checkIssueState(owner, repo, n);
    if (state === 'closed') closed.push(n);
    else if (state === 'skipped') skipped.push(n);
    else open.push(n); // 'open' or a transient 'error'
  }
  const linked = new Set(sanitizeIssueNumbers(linkedIssues));
  let waiting = false;
  if (open.some((n) => linked.has(n))) {
    if (look < 2) waiting = true;
    else {
      const { closed: selfClosed } = await closeLinkedIssues({ owner, repo, prNumber, pr, linkedIssues, stillOpen: open });
      closed.push(...selfClosed);
      open = open.filter((n) => !selfClosed.includes(n));
    }
  }
  if (closed.length) {
    await closeTwinRows({ pool, appId, prNumber, numbers: closed, strict: true });
    await withdrawBotProposals({ pool, appId, prNumber, numbers: closed, strict: true });
  }
  // A request gone (404, 410) never closes later, and a number that is a
  // pull request can never be a close proposal's target.
  const targets = await closeProposalTargets(pool, appId, [...closed, ...skipped]);
  log.info('issue-close-watcher', 'Looked at the requests a merge closes', {
    repo: `${owner}/${repo}`, pr: prNumber, look, closed, skipped, stillOpen: open, waiting,
  });
  return { closed, skipped, stillOpen: open, waiting, targets };
}

// The requests of a change that went live inside another one: its own pull
// request never merges, so nothing closes them but this (the merge-followups
// machine's issues.closeAfterMerge with closeOnly). Answers { closed,
// failed: [{ number, status }], targets }; a failure to record a close
// throws.
async function closeIncluded({ owner, repo, prNumber, linkedIssues, appId, pool }) {
  const numbers = sanitizeIssueNumbers(linkedIssues);
  const closed = [];
  const failed = [];
  if (!numbers.length || !github.isEnabled()) return { closed, failed, targets: [] };
  for (const n of numbers) {
    try {
      await github.closeIssue(owner, repo, n);
      closed.push(n);
    } catch (err) {
      failed.push({ number: n, status: err.status ?? null });
      log.warn('issue-close-watcher', 'Could not close a request of an included change', {
        repo: `${owner}/${repo}`, issueNumber: n, status: err.status, err: err.message,
      });
    }
  }
  if (closed.length) {
    await closeTwinRows({ pool, appId, prNumber, numbers: closed, strict: true });
    await withdrawBotProposals({ pool, appId, prNumber, numbers: closed, strict: true });
  }
  // A request that is gone (404, 410) never closes later: its close
  // proposals are superseded as for a closed one.
  const gone = failed.filter((f) => f.status === 404 || f.status === 410).map((f) => f.number);
  return { closed, failed, targets: await closeProposalTargets(pool, appId, [...closed, ...gone]) };
}

module.exports = {
  closeAfterMerge, closeIncluded, resolveIssueNumbers, mergedIntoDefaultBranch,
  // What an observed close does, for a close made elsewhere (the Homeroom
  // bot's own closes, homeroom-bot-closed-requests.js).
  broadcastClosed, closeTwinRows,
};
