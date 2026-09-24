'use strict';

const log = require('./logger');

async function perform(task, config) {
  switch (task.kind) {
    case 'openrouter_key':
      return require('./openrouter-management-client').deleteKey({
        apiKey: config.openrouterManagementApiKey, baseUrl: config.openrouterApiBase,
        origin: config.openrouterOrigin, hash: task.target,
      });
    case 'worker':
      return require('./worker').eraseAccountWorkspace(Number(task.target));
    case 'object': {
      const store = require('./app-files').getStore(config);
      if (!store) throw new Error('storage_unavailable');
      const [appId, fileId] = task.target.split('/');
      return store.removeFile(Number(appId), fileId);
    }
    default: throw new Error('manual_review_required');
  }
}

// Atomic leasing permits several pods to drain this queue. A crash returns
// the task to service after five minutes. Every operation is idempotent.
async function sweep(pool, config, { run = perform, limit = 20 } = {}) {
  for (let i = 0; i < limit; i++) {
    const { rows } = await pool.query(`WITH due AS (
      SELECT id FROM account_deletion_tasks WHERE
        (state = 'pending' AND next_attempt_at <= NOW()) OR
        (state = 'processing' AND locked_at < NOW() - INTERVAL '5 minutes')
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE account_deletion_tasks t SET state = 'processing', locked_at = NOW(), attempts = attempts + 1
      FROM due WHERE t.id = due.id RETURNING t.*`);
    const task = rows[0];
    if (!task) break;
    try {
      await run(task, config);
      await pool.query(`UPDATE account_deletion_tasks SET state = 'completed', completed_at = NOW(),
        error_code = NULL, locked_at = NULL,
        target = CASE WHEN kind = 'worker' THEN target ELSE 'erased:' || id END
        WHERE id = $1 AND attempts = $2`, [task.id, task.attempts]);
    } catch {
      // Provider errors can contain credentials or content; never store them.
      await pool.query(`UPDATE account_deletion_tasks SET state = 'pending', locked_at = NULL,
        error_code = 'cleanup_failed', next_attempt_at = NOW() + INTERVAL '5 minutes'
        WHERE id = $1 AND attempts = $2`, [task.id, task.attempts]);
      log.warn('account-deletion', 'Cleanup will retry', { taskId: task.id, kind: task.kind });
    }
  }
  await pool.query(`UPDATE account_deletions d SET completed_at = NOW() WHERE completed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM account_deletion_tasks t WHERE t.deletion_id = d.id AND t.state <> 'completed')`);
}

// An already-running bootstrap can finish after teardown on another pod.
// Re-arm its receipt before refusing to use that late-created workspace.
async function assertWorkerAllowed(pool, sessionId) {
  const { rows } = await pool.query(`UPDATE account_deletion_tasks SET state = 'pending',
    next_attempt_at = NOW(), completed_at = NULL, attempts = attempts + 1
    WHERE kind = 'worker' AND target = $1 RETURNING deletion_id`, [String(sessionId)]);
  if (!rows.length) return;
  await pool.query('UPDATE account_deletions SET completed_at = NULL WHERE id = $1', [rows[0].deletion_id]);
  throw new Error('account_deleted');
}

async function list(pool) {
  const { rows } = await pool.query(`SELECT d.id, d.user_id, d.created_at,
    CASE WHEN COUNT(*) FILTER (WHERE t.state <> 'completed') > 0 THEN NULL ELSE d.completed_at END AS completed_at,
    COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'state', t.state,
      'attempts', t.attempts, 'errorCode', t.error_code)) FILTER (WHERE t.id IS NOT NULL), '[]') AS tasks
    FROM account_deletions d LEFT JOIN account_deletion_tasks t ON t.deletion_id = d.id
    GROUP BY d.id ORDER BY d.created_at DESC LIMIT 100`);
  return rows;
}

module.exports = { perform, sweep, list, assertWorkerAllowed };
