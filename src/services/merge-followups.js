'use strict';

// Durable work after a GitHub merge. The plan precedes the merge call, so a
// lost response or a process replacement cannot make the work invisible.
const github = require('./github');
const log = require('./logger');

const ACTIONS = [
  'pending_secrets', 'production_deploy', 'staging_teardown',
  'merge_event', 'merge_notification', 'bounty_payout',
  'merge_announcement', 'main_check',
];
const SOURCE_REVISION_LABEL = 'social.usernode.io/source-revision';
const MERGE_FOLLOWUP_LOCK = 0x4d465550; // MFUP, separate from other two-key advisory locks.

async function prepare(pool, sessionId, context = {}) {
  await pool.query(
    `INSERT INTO merge_followup_actions (session_id, action, context)
     SELECT $1, unnest($2::varchar[]), $3::jsonb
     ON CONFLICT (session_id, action)
     DO UPDATE SET context = EXCLUDED.context`,
    [sessionId, ACTIONS, JSON.stringify(context)]
  );
}

async function markComplete(pool, sessionId, action) {
  await pool.query(
    `UPDATE merge_followup_actions
        SET completed_at = COALESCE(completed_at, NOW()), last_error = NULL
      WHERE session_id = $1 AND action = $2`,
    [sessionId, action]
  );
}

// `observe` must read the external outcome before a retry. This closes the
// inevitable crash window between an external success and the completion
// UPDATE; the database marker alone cannot provide exactly-once effects.
async function run(pool, sessionId, action, effect, { observe = null, complete = () => true } = {}) {
  const { rows } = await pool.query(
    `SELECT completed_at FROM merge_followup_actions
      WHERE session_id = $1 AND action = $2`,
    [sessionId, action]
  );
  // Older direct-finalizer callers and isolated tests have no plan. New
  // production merges always do, because prepare() runs before mergePR().
  if (!rows.length) return { state: 'legacy', value: await effect() };
  if (rows[0].completed_at) return { state: 'completed', value: null };
  try {
    if (observe) {
      const observed = await observe();
      if (observed) {
        await markComplete(pool, sessionId, action);
        return { state: 'observed', value: observed };
      }
    }
    const value = await effect();
    if (complete(value)) await markComplete(pool, sessionId, action);
    else await pool.query(
      `UPDATE merge_followup_actions SET attempted_at = NOW(), last_error = $3
        WHERE session_id = $1 AND action = $2`,
      [sessionId, action, 'Effect did not complete']
    );
    return { state: 'performed', value };
  } catch (err) {
    await pool.query(
      `UPDATE merge_followup_actions SET attempted_at = NOW(), last_error = $3
        WHERE session_id = $1 AND action = $2`,
      [sessionId, action, String(err.message || err).slice(0, 2000)]
    ).catch(() => {});
    throw err;
  }
}

function fullSha(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
}

// The runtime's source-revision label is written with the deployment, ahead
// of the apps.main_sha update. It therefore proves success even if the
// process died in precisely that gap. A newer running revision also proves
// delivery when the merge commit is its ancestor.
async function observedProduction(config, app, mergeSha) {
  if (app.self_hosted) return { sha: mergeSha, selfHosted: true };
  const target = fullSha(mergeSha);
  if (!target) return null;
  const runtime = require('./application-runtime');
  const observed = await runtime.inspect(config, runtime.productionRef(config, app));
  if (observed?.status !== 'running' || observed.rolloutReady === false) return null;
  const runningSha = fullSha(observed.labels?.[SOURCE_REVISION_LABEL]);
  if (!runningSha) return null;
  if (runningSha === target) return { sha: runningSha };
  const repo = github.parseGithubUrl(app.repo_url);
  if (!repo) return null;
  const mirror = require('./repo-mirror');
  const dir = await mirror.ensureMirror(repo.owner, repo.repo);
  return await mirror.isAncestor(dir, target, runningSha) ? { sha: runningSha, superseded: true } : null;
}

async function observedTeardown(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT staging_url, staging_container_id, staging_runtime_name
       FROM chat_sessions WHERE id = $1`, [sessionId]
  );
  const row = rows[0];
  return row && !row.staging_url && !row.staging_container_id && !row.staging_runtime_name
    ? { removed: true } : null;
}

async function observedMainCheck(pool, appId, mergeSha) {
  if (!mergeSha) return null;
  const { rows } = await pool.query(
    `SELECT main_check_sha, main_check_state, repo_url FROM apps WHERE id = $1`, [appId]
  );
  const row = rows[0];
  if (!row?.main_check_state) return null;
  const checkedSha = fullSha(row.main_check_sha);
  const targetSha = fullSha(mergeSha);
  if (checkedSha === targetSha) return { state: row.main_check_state };
  if (!checkedSha || !targetSha) return null;
  const repo = github.parseGithubUrl(row.repo_url);
  if (!repo) throw new Error('Cannot compare the newer combined-main check without a repository');
  const mirror = require('./repo-mirror');
  const dir = await mirror.ensureMirror(repo.owner, repo.repo);
  if (await mirror.isAncestor(dir, targetSha, checkedSha)) {
    return { state: row.main_check_state, supersededBy: checkedSha };
  }
  throw new Error('A different combined-main check owns this app');
}

// Both the normal finalizer and recovery take the same session lock. A crash
// releases it automatically, while a concurrent sweep waits for the live
// finalizer instead of duplicating its external effects.
async function withSessionLock(pool, sessionId, work) {
  if (typeof pool.connect !== 'function') return work();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [MERGE_FOLLOWUP_LOCK, sessionId]);
    return await work();
  } finally {
    let unlockError = null;
    try {
      await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [MERGE_FOLLOWUP_LOCK, sessionId]);
    } catch (err) { unlockError = err; }
    client.release(unlockError);
  }
}

async function recover(config, { pool = null, githubClient = github, finalize = null } = {}) {
  const db = pool || require('../db/pool').getPool(config);
  const { rows } = await db.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.self_hosted AS app_self_hosted,
            plan.context AS merge_followup_context
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
       LEFT JOIN LATERAL (
         SELECT context FROM merge_followup_actions
          WHERE session_id = cs.id LIMIT 1
       ) plan ON true
      WHERE EXISTS (
        SELECT 1 FROM merge_followup_actions m
         WHERE m.session_id = cs.id AND m.completed_at IS NULL
      )
      ORDER BY cs.id ASC`
  );
  const results = [];
  for (const session of rows) {
    try {
      let mergeSha = session.merge_commit_sha;
      if (session.status !== 'merged' || !mergeSha) {
        const repo = githubClient.parseGithubUrl(session.repo_url);
        if (!repo || !session.pr_number || !githubClient.isEnabled()) continue;
        const pr = await githubClient.getPR(repo.owner, repo.repo, session.pr_number);
        if (!pr?.merged) {
          if (session.status === 'merged') continue;
          if (session.status === 'merging') {
            await db.query(
              `UPDATE chat_sessions SET status = 'promoted'
                WHERE id = $1 AND status = 'merging'`, [session.id]
            );
          }
          await db.query('DELETE FROM merge_followup_actions WHERE session_id = $1', [session.id]);
          continue;
        }
        mergeSha = pr.merge_commit_sha || mergeSha;
        await db.query(
          `UPDATE chat_sessions SET status = 'merged',
              merged_at = COALESCE(merged_at, $2::timestamptz, NOW()),
              merge_commit_sha = COALESCE(merge_commit_sha, $3)
            WHERE id = $1`,
          [session.id, pr.merged_at || null, mergeSha || null]
        );
      }
      const finish = finalize || require('../routes/votes').finalizeMerge;
      const context = session.merge_followup_context || {};
      await finish({
        config, pool: db, session: { ...session, status: 'merged' },
        mergeCommitSha: mergeSha, required: context.required ?? session.votes_required ?? null,
        activeCount: context.activeCount ?? session.active_users_at_merge ?? null,
        yesCount: context.yesCount ?? null, majority: context.majority ?? null,
        force: !!context.force, forceBy: context.forceBy ? { username: context.forceBy } : null,
        dstep: () => {}, dend: () => {}, recovering: true,
      });
      results.push(session.id);
    } catch (err) {
      log.warn('merge-followups', 'Post-merge recovery failed; will retry', {
        sessionId: session.id, err: err.message,
      });
    }
  }
  return results;
}

module.exports = {
  ACTIONS, prepare, run, withSessionLock, observedProduction,
  observedTeardown, observedMainCheck, recover,
};
