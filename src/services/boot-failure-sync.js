'use strict';

// A promoted proposal whose preview will not start because MAIN moved on
// underneath it, not because of anything in the proposal.
//
// Previews boot against a copy of production's database, and production runs
// main. So a schema change on main that an older branch's schema.sql cannot
// run against stops every older proposal's preview at once. On 7 Oct 2026
// #4172 replaced the single "one current bot configuration" index with one
// per scope and seeded a second current row; #4186, two commits behind,
// still created the single index, and its preview died on startup with
// "could not create unique index" (23505). Its checks recorded 'error', its
// card said the build needed fixing, and nothing in #4186 was broken: a
// sync with main was the whole fix.
//
// The merge queue does not bring a clean proposal up to date, on purpose
// (services/merge-queue.js): a proposal that merges cleanly merges as it
// stands, judged on its own head. That holds while there is a verdict to
// judge it on. A preview that never started gives none, and the proposal
// waits until somebody notices. So here, and only here, the platform runs
// its own sync:
//
//   - the preview failed to START (a healthcheck failure, not a failed image
//     build, which depends on the branch alone, and not a failing test,
//     which is the author's verdict to read), and was not the fleet's own
//     infrastructure (deploy-failure.bootFailureIsInfrastructure);
//   - the proposal is promoted and native, so its branch is the platform's to
//     push to. A draft is left alone: whoever is still working on it would
//     find its branch moved under them, and a local agent's next upload
//     refused;
//   - the failed commit is still the head, and it is behind main and merges
//     with it cleanly, measured from the mirror (services/integration.js);
//   - at most once per head (chat_sessions.boot_failure_sync_head, written
//     by the proposal machine with the sync's own work, so a restart never
//     strands it as tried: merge trace bug 9). After a sync the new head
//     contains main, so a preview that still will not start is the change's
//     own failure, and nothing here runs again until main moves.
//
// This file only measures, in the preview's prepare work: the failure note
// says what it found, and when it says sync, the preview machine asks the
// proposal machine for one (SyncRequested, reason boot_failure).
//
// A clean sync is a mechanical merge, so the approval epoch does not move and
// the votes the proposal has keep counting (services/pr-vote-revision.js).

const log = require('./logger');

function sameSha(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// Required lazily: the preview's prepare calls in on every boot failure.
function defaultDeps() {
  return {
    get integration() { return require('./integration'); },
  };
}

async function loadRow(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

// Why the platform will not sync this row, read off the row alone, or null.
function ineligible(row, commitHash) {
  if (!row) return 'gone';
  if (row.status !== 'promoted') return 'not_promoted';
  if (row.source === 'imported') return 'imported';
  if (!row.branch_name || !row.repo_url) return 'no_branch';
  // The failure is about an older commit: the new head has its own build.
  if (!sameSha(row.checks_commit_sha, commitHash)) return 'head_moved';
  if (sameSha(row.boot_failure_sync_head, commitHash)) return 'already_tried';
  return null;
}

/**
 * What a preview that failed to start means for this proposal, measured now.
 * Never throws.
 *
 * @returns {Promise<{ sync: boolean, why: string|null, behindBy: number|null }>}
 *   sync=true  behind main, merges cleanly, not yet tried for this head.
 *   sync=false why: 'level' (it already contains main), 'conflict',
 *              'already_tried', or a reason the platform cannot act
 *              ('not_promoted', 'imported', 'head_moved', 'unmeasured', …).
 */
async function plan({ pool, sessionId, commitHash }, deps = defaultDeps()) {
  try {
    const row = await loadRow(pool, sessionId);
    const not = ineligible(row, commitHash);
    if (not && not !== 'already_tried') return { sync: false, why: not, behindBy: null };
    const measured = await deps.integration.measure({ pool, session: row }, { force: true });
    if (!measured || measured.error || measured.skipped) {
      return { sync: false, why: 'unmeasured', behindBy: null };
    }
    if (!sameSha(measured.headSha, commitHash)) return { sync: false, why: 'head_moved', behindBy: null };
    const behindBy = Number.isFinite(measured.behindBy) ? measured.behindBy : null;
    if (behindBy == null) return { sync: false, why: 'unmeasured', behindBy: null };
    if (behindBy === 0) return { sync: false, why: 'level', behindBy };
    if (not) return { sync: false, why: not, behindBy };
    if (measured.mergesClean !== true) return { sync: false, why: 'conflict', behindBy };
    return { sync: true, why: null, behindBy, row };
  } catch (err) {
    log.warn('boot-failure-sync', 'could not measure a proposal whose preview failed to start', {
      sessionId, err: err.message,
    });
    return { sync: false, why: 'unmeasured', behindBy: null };
  }
}

/**
 * Called by the preview machine's prepare work (src/workflow/preview/
 * services.ts) when a preview failed to start: what that means for the
 * proposal, measured now, for the failure note; `sync: true` when the
 * preview machine should ask for a sync. Never throws.
 */
async function afterBootFailure({ pool, session, commitHash, err }, deps = null) {
  if (!err || err.healthcheckFailed !== true) return null;
  if (!session || session.source === 'imported' || !commitHash) return null;
  const { row: _row, ...answer } = await plan({ pool, sessionId: Number(session.id), commitHash }, deps || defaultDeps());
  return answer;
}

function plural(n) {
  return `${n} commit${n === 1 ? '' : 's'}`;
}

/**
 * What the failure note in the proposal's thread adds about main, from the
 * plan: '' when there is nothing to add. staging-recovery keeps the sentence
 * everybody has read before and puts this after it, so nobody is sent to
 * debug a change that main broke, and a change that already contains main is
 * told so. A plan that syncs replaces the "can't merge yet" with this.
 */
function explain(found) {
  if (!found) return '';
  if (found.sync) {
    return `This proposal is ${plural(found.behindBy)} behind main, and a change on main can stop an older `
      + 'branch\'s preview from starting, so Homeroom is merging main into it and will build the preview again.';
  }
  if (found.why === 'level') return 'It already includes everything on main, so the cause is in this change.';
  if (found.behindBy > 0) return `It is ${plural(found.behindBy)} behind main; syncing it with main may fix this.`;
  return '';
}

module.exports = {
  afterBootFailure,
  plan,
  explain,
};
