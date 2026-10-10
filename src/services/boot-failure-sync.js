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
//   - at most once per head (chat_sessions.boot_failure_sync_head). After a
//     sync the new head contains main, so a preview that still will not
//     start is the change's own failure, and nothing here runs again until
//     main moves.
//
// A clean sync is a mechanical merge, so the approval epoch does not move and
// the votes the proposal has keep counting (services/pr-vote-revision.js).

const log = require('./logger');

// A failure recorded at the end of a dev-chat turn arrives while that turn's
// tail still holds the session. runSyncMain adds and then deletes the
// session in the shared activeWorkers set, so running it inside somebody
// else's turn would clear their marker. Wait for the session to be idle.
const IDLE_POLL_MS = 3000;
const IDLE_WAIT_MS = 10 * 60 * 1000;

// One waiter per session in this process. The claim is what stops a second
// sync; this only stops a burst of backoff retries from each starting one.
const _pending = new Set();

function sameSha(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// Required lazily: staging-recovery calls in on every boot failure, and only
// a sync needs the worker and the merge queue loaded at all.
function defaultDeps() {
  return {
    get integration() { return require('./integration'); },
    get syncMain() { return require('./sync-main'); },
    get activeWorkers() { return require('./active-workers'); },
    get mergeQueue() { return require('./merge-queue'); },
    votes: () => require('../routes/votes'),
    sleep: (ms) => new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (t && typeof t.unref === 'function') t.unref();
    }),
    now: () => Date.now(),
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

// Busy here, or with the session-activity machine on, in any process.
async function waitForIdle(sessionId, deps) {
  const deadline = deps.now() + IDLE_WAIT_MS;
  const sessionActivity = deps.sessionActivity || require('./session-activity');
  while (deps.activeWorkers.isSessionBusy(Number(sessionId)) || await sessionActivity.isBusy(Number(sessionId))) {
    if (deps.now() >= deadline) return false;
    await deps.sleep(IDLE_POLL_MS);
  }
  return true;
}

// The one write that makes this once per head. Conditional on the row still
// describing the failed commit, so a push that landed while this waited, or
// a second process, finds nothing to claim.
async function claim(pool, sessionId, commitHash) {
  const { rows } = await pool.query(
    `UPDATE chat_sessions
        SET boot_failure_sync_head = $2
      WHERE id = $1 AND status = 'promoted'
        AND checks_commit_sha = $2
        AND boot_failure_sync_head IS DISTINCT FROM $2
      RETURNING id`,
    [sessionId, commitHash]
  );
  return rows.length > 0;
}

/**
 * Bring the proposal up to date with main and start the run for its new head.
 * Waits for the session to be idle, measures again, and claims the head
 * before it syncs. Never throws; resolves to what happened.
 */
async function run({ config, pool, sessionId, commitHash }, deps = defaultDeps()) {
  const id = Number(sessionId);
  if (!(await waitForIdle(id, deps))) return { synced: false, why: 'busy' };
  if (deps.mergeQueue.isIntegratingSession(id)) return { synced: false, why: 'integrating' };

  const now = await plan({ pool, sessionId: id, commitHash }, deps);
  if (!now.sync) return { synced: false, why: now.why };
  // The sync is claimed as a turn on the session before the head is
  // (session-activity.js): a refusal leaves the head unclaimed, so the next
  // failure of that head tries again. The sync's own turn joins this claim.
  const sessionActivity = deps.sessionActivity || require('./session-activity');
  const gate = await sessionActivity.tryBegin(id, 'turn', { label: 'boot-failure sync' });
  if (gate.refused) return { synced: false, why: 'busy' };
  gate.activity?.enter();
  try {
    return await syncClaimed({ config, pool, id, commitHash, now }, deps);
  } finally {
    await gate.activity?.end();
  }
}

async function syncClaimed({ config, pool, id, commitHash, now }, deps) {
  if (!(await claim(pool, id, commitHash))) return { synced: false, why: 'claimed' };

  log.info('boot-failure-sync', 'Preview failed to start on a proposal behind main; syncing it', {
    sessionId: id, headSha: commitHash, behindBy: now.behindBy,
  });
  let result;
  try {
    result = await deps.syncMain.runSyncMain(config, pool, id, {
      // runSyncMain narrates only when it believes the branch is behind, and
      // behind_main is a turn's count, which a proposal untouched since
      // promotion may never have had. The measurement is the current answer.
      sessionRow: { ...now.row, behind_main: now.behindBy },
      trigger: 'boot_failure',
    });
  } catch (err) {
    log.warn('boot-failure-sync', 'Sync after a preview failure threw', { sessionId: id, err: err.message });
    return { synced: false, why: 'sync_threw' };
  }
  const pushed = !!result && result.pushOk
    && (result.syncResult === 'clean' || result.syncResult === 'resolved');
  if (!pushed) {
    log.info('boot-failure-sync', 'Sync after a preview failure pushed nothing', {
      sessionId: id, syncResult: result ? result.syncResult : null,
    });
    return { synced: false, why: (result && result.syncResult) || 'not_pushed' };
  }

  // What the merge queue does after its own sync (reconcileResolvedHead):
  // measure the pushed head so the columns describe it, then install it as
  // the reviewed revision and start its run. A mechanical merge keeps the
  // approvals; the preview and checks run on the new head.
  try {
    const fresh = await loadRow(pool, id);
    if (fresh && fresh.status === 'promoted') {
      await deps.integration.measure({ pool, session: fresh }, { force: true }).catch(() => {});
      await deps.votes().reconcileNativeReviewedHead({
        config, pool, session: fresh, fresh: true, notify: false,
      });
    }
  } catch (err) {
    log.warn('boot-failure-sync', 'Synced, but could not start the new head\'s run', {
      sessionId: id, err: err.message,
    });
  }
  return { synced: true, why: null, sha: result.sha || null };
}

/**
 * Called by staging-recovery.recordStagingBootFailure. Measures, starts the
 * sync in the background when it applies, and returns the plan so the
 * failure note can say what is happening. Never throws.
 */
async function afterBootFailure({ config, pool, session, commitHash, err }, deps = null) {
  if (!err || err.healthcheckFailed !== true) return null;
  if (!session || session.source === 'imported' || !commitHash) return null;
  deps = deps || defaultDeps();
  const id = Number(session.id);
  const found = await plan({ pool, sessionId: id, commitHash }, deps);
  if (found.sync && !_pending.has(id)) {
    _pending.add(id);
    Promise.resolve()
      .then(() => run({ config, pool, sessionId: id, commitHash }, deps))
      .catch((e) => log.warn('boot-failure-sync', 'unexpected rejection', { sessionId: id, err: e.message }))
      .finally(() => _pending.delete(id));
  }
  const { row: _row, ...answer } = found;
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
  run,
  explain,
  IDLE_POLL_MS,
  IDLE_WAIT_MS,
  _pending,
};
