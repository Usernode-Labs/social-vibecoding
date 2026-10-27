'use strict';

// A proposal merged by Homeroom itself, for an app on the git host.
//
// GitHub's `pulls.merge` (squash, pinned to the reviewed commit) was the
// only thing that moved an app's main for a proposal, and it went with the
// suspended account (25 Oct 2026). This does the same thing with git:
//
//   1. a fresh look at the mirror (services/repo-mirror.js): the head
//      branch and main as they stand on the git host;
//   2. the head must be exactly the reviewed commit, or it is refused as
//      GitHub refused it: a 409, the `headMoved` sentinel (HeadMovedError);
//   3. `git merge-tree --write-tree main head`: a conflict is refused with
//      GitHub's wording ("merge conflict"), which routes/votes.js refusalKind
//      reads as one;
//   4. `git commit-tree <tree> -p main`: one commit, the squash, its message
//      the proposal's title and number;
//   5. main moved from the main read in step 1 to that commit with a
//      compare-and-swap (services/git-host.js casUpdateRef). If main moved
//      in between, it is refused as GitHub's "Base branch was modified",
//      which the proposal machine retries once against the new main.
//
// The pull request's row records the merge (merged, merge_commit_sha, the
// head it merged). Asking again for a merged one answers the same merge, so
// a retried attempt after a lost answer is not a second merge.

const log = require('./logger');
const gitHost = require('./git-host');
const repoMirror = require('./repo-mirror');
const appNumbers = require('./app-numbers');
const codeMissing = require('./code-missing');

function db() { return appNumbers.getPool(); }

function refusal(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function headMoved(message) {
  // The sentinel the merge path reads (services/github.js HeadMovedError).
  const { HeadMovedError } = require('./github');
  const e = new HeadMovedError(message);
  e.status = 409;
  return e;
}

function messageFor(row) {
  const title = String(row.title || '').trim() || `Proposal #${row.number}`;
  const body = String(row.body || '').trim();
  return `${title} (#${row.number})${body ? `\n\n${body}` : ''}\n`;
}

async function squashMerge({ owner, repo, number, pinnedSha = null }) {
  const app = await require('./requests').appFor(owner, repo);
  if (!app) throw refusal(`No app has the repository ${owner}/${repo}`, 404);
  const { rows: [row] } = await db().query(
    `SELECT number, title, body, head_branch, base_branch, draft, state, merged, merge_commit_sha, merged_head_sha
       FROM native_pulls WHERE app_id = $1 AND number = $2`, [app.id, Number(number)]);
  if (!row) throw refusal(`Pull request #${number} not found`, 404);

  // Already merged (an attempt whose answer was lost): the same merge.
  if (row.merged) {
    if (pinnedSha && row.merged_head_sha && row.merged_head_sha !== String(pinnedSha).toLowerCase()) {
      throw headMoved('Pull request was merged at a different head');
    }
    return { sha: row.merge_commit_sha, merged: true, message: 'Pull Request successfully merged' };
  }
  if (row.state !== 'open') throw refusal('Pull Request is not mergeable: it is closed', 405);
  if (row.draft) throw refusal('Pull Request is not mergeable: it is still a draft', 405);

  const dir = await repoMirror.ensureMirror(owner, repo, { fresh: true });
  const head = await repoMirror.resolveBranch(dir, row.head_branch);
  const base = await repoMirror.resolveBranch(dir, row.base_branch);
  // The branch is not on the git host while main is: the proposal's code did
  // not come across from GitHub (services/code-missing.js). Refused with that
  // reason and its code, never worded as "not mergeable", which the merge
  // path reads as a conflict to resolve.
  if (!head && base) throw codeMissing.error(codeMissing.MERGE_REFUSAL, { status: 405, branch: row.head_branch });
  if (!head) throw refusal(`Pull Request is not mergeable: its branch ${row.head_branch} is gone`, 405);
  if (!base) throw refusal(`Pull Request is not mergeable: ${row.base_branch} does not exist`, 405);
  if (pinnedSha && head !== String(pinnedSha).toLowerCase()) {
    log.info('native-merge', 'Merge refused: the head moved since the reviewed commit', {
      app: app.slug, number: row.number, pinnedSha, head,
    });
    throw headMoved(`Head branch was modified. Review and try the merge again (now ${head.slice(0, 8)}).`);
  }

  const merged = await repoMirror.mergeTree(dir, base, head);
  if (!merged.clean) {
    const e = refusal(`Pull Request is not mergeable: merge conflict in ${merged.conflicts.slice(0, 10).join(', ')}`, 405);
    e.conflicts = merged.conflicts;
    throw e;
  }
  if (merged.tree === await repoMirror.treeOf(dir, base)) {
    throw refusal('Pull Request is not mergeable: it changes nothing on main', 405);
  }

  const author = gitHost.defaultAuthor();
  const { stdout } = await gitHost.git([
    '-C', dir,
    '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,
    'commit-tree', merged.tree, '-p', base, '-F', '-',
  ], { input: messageFor(row) });
  const mergeSha = stdout.trim().toLowerCase();

  try {
    await gitHost.casUpdateRef({ owner, name: repo }, dir, row.base_branch, base, mergeSha);
  } catch (err) {
    if (err && err.refMoved) throw refusal('Base branch was modified. Review and try the merge again.', 405);
    throw err;
  }

  await db().query(
    `UPDATE native_pulls
        SET merged = TRUE, merged_at = NOW(), merge_commit_sha = $3, merged_head_sha = $4,
            state = 'closed', closed_at = NOW(), updated_at = NOW()
      WHERE app_id = $1 AND number = $2`, [app.id, row.number, mergeSha, head]);
  log.info('native-merge', 'Proposal merged', { app: app.slug, number: row.number, head, mergeSha });
  return { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' };
}

module.exports = { squashMerge, _messageFor: messageFor };
