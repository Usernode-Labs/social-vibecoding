'use strict';

// A change that went live inside another one.
//
// A change can be built on top of another open change: the Homeroom bot
// asked to "fix mark as done in Jordan's first version" built its fix on the
// first version's branch, so the fix's pull request carried the first
// version's commit as well as its own (Flat 4B Chores, 5 Oct 2026: PR 8 built
// on PR 3). When the fix merged, the first version's work went live with it,
// but nothing said so: GitHub squashes, so PR 3's own commit is not on main
// and GitHub never marked it merged. PR 3 stayed open and still asked for
// votes, its lazy window would have tried to merge it again, request #1 stayed
// open, and the App tab kept saying the first version was being built over
// the live app.
//
// So when a change merges, every other change of the app that is up for a
// vote and whose head commit is one of the merged pull request's own commits
// (GitHub's list of the commits on it, which it keeps after a squash merge)
// is INCLUDED in it. The signal is exact and costs one GitHub read per merge,
// and none when nothing else is up for a vote: a head on that list is a
// commit the merged change brought to main, so the included change has
// nothing left that is not live. A head the list does not have (a newer
// revision, a change never built on) is left alone, and a change already on
// main before the merge is never on the list, so the other order (the lower
// change merging first) includes nothing.
//
// An included change is marked merged with the merge it went live in
// (merged_at and merge_commit_sha are that merge's, so its deploy state is
// that merge's) and `included_in_session_id` names the change that carried
// it. Being merged is what every reader already understands: the vote panel,
// Needs you and the lazy window only look at changes up for a vote, a vote on
// it is refused, its requests read "approved and live", and a project's first
// version reads live (homeroom-bot-dm.js firstVersionState). What a merge
// does for a change is then done for it.
//
// The merge-followups workflow machine does all of it (its included.find
// work reads the candidates and compares them here, and each included change
// is an instance of its own); this module keeps the pieces it uses.

const log = require('./logger');
const { reviewedHeadForSession } = require('./pr-vote-revision');

function fullSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Pure: the candidates whose head is one of `commitShas`, the merged pull
 * request's own commits. A candidate with no recorded head is never one.
 */
function containedIn(candidates, commitShas) {
  const listed = new Set((commitShas || []).map(fullSha).filter(Boolean));
  return (candidates || []).filter((c) => {
    const head = fullSha(reviewedHeadForSession(c));
    return !!head && listed.has(head);
  });
}

// The app's other changes up for a vote, with a pull request and a recorded
// head. Not one whose turn is running (a revision may be on its way, and it
// decides), and not one holding a secret value for a variable it declares:
// that value is applied only by the change's own merge
// (services/pending-secrets.js), so it waits for that.
const CANDIDATES_SQL = `SELECT cs.id, cs.source, cs.reviewed_head_sha, cs.imported_pr_head_sha
   FROM chat_sessions cs
  WHERE cs.app_id = $1 AND cs.id <> $2
    AND cs.status = 'promoted' AND cs.is_headless = FALSE
    AND cs.pr_number IS NOT NULL AND cs.active_turn IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pending_secret_declarations p
       WHERE p.session_id = cs.id AND p.status = 'pending'
    )
  ORDER BY cs.id`;

function depsOf(deps = {}) {
  return {
    watcher: deps.watcher || require('./issue-close-watcher'),
  };
}

/**
 * Close the requests it was linked to, as its own merge would have through
 * `Closes #N` (the merge-followups machine pays their bounties in the
 * transition that marks the change merged), and each one closed is then
 * read as closed everywhere (the open-issues cache, its twin row, a
 * close-issue vote on it, the Homeroom bot's proposals built for it alone).
 * Resolves { closed, failed: [{ number, status }] }, so the machine's work
 * retries the ones that failed; with `strict`, a failure to record a close
 * here (twin rows, superseded proposals) throws, for the work to retry.
 */
async function closeRequests({ pool, row, carrier, github, repo, d, strict = false }) {
  const { sanitizeIssueNumbers } = require('./pr-metadata');
  const numbers = sanitizeIssueNumbers(row.linked_issues);
  const answer = (closed, failed) => ({ closed, failed });
  if (!numbers.length) return answer([], []);
  if (!github) return answer([], []);
  github.noteIssuesClosed?.(repo.owner, repo.repo, numbers);
  const closed = [];
  const failed = [];
  for (const n of numbers) {
    try {
      await github.closeIssue(repo.owner, repo.repo, n);
      closed.push(n);
    } catch (err) {
      failed.push({ number: n, status: err.status ?? null });
      log.warn('included-changes', 'Could not close a request of an included change', {
        sessionId: row.id, issueNumber: n, status: err.status, err: err.message,
      });
    }
  }
  if (failed.length) github.unsuppressIssues?.(repo.owner, repo.repo, failed.map((f) => f.number));
  if (closed.length) {
    const prNumber = carrier.pr_number || null;
    d.watcher.bustAndBroadcast({ owner: repo.owner, repo: repo.repo, appSlug: row.app_slug, appId: row.app_id, closed });
    await Promise.all([
      d.watcher.closeTwinRows({ pool, appId: row.app_id, prNumber, numbers: closed, strict }),
      d.watcher.resolveSupersededProposals({ pool, appId: row.app_id, appSlug: row.app_slug, prNumber, numbers: closed, strict }),
      d.watcher.withdrawBotProposals({ pool, appId: row.app_id, prNumber, numbers: closed, strict }),
    ]);
  }
  return answer(closed, failed);
}

module.exports = {
  closeRequests,
  depsOf,
  containedIn,
  CANDIDATES_SQL,
};
