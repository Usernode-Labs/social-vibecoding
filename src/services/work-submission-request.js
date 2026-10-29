'use strict';

// The web side can stop waiting while its submission keeps running. Bind
// the operation to the task until its PR has been imported and the task is
// submitted, so another HTTP attempt adopts that same operation and answer.
const { randomUUID } = require('node:crypto');
const operations = require('./platform-operations');

async function request(pool, p) {
  const proposed = { requestId: randomUUID(), input: p.input };
  const { rows: [row] } = await pool.query(
    `UPDATE external_agent_tasks SET submit_operation = COALESCE(submit_operation, $4::jsonb)
      WHERE id = $1 AND user_id = $2 AND app_id = $3 AND status = 'open'
      RETURNING submit_operation`,
    [p.input.taskId, p.userId, p.appId, JSON.stringify(proposed)]
  );
  if (!row) return { ok: false, status: 409, code: 'unknown_task', message: 'That piece of work is no longer open.' };
  const { result: completed, ...kept } = row.submit_operation;
  if (completed?.ok) return { ...completed, requestId: kept.requestId };
  const out = await operations.request({ ...p, ...kept }, { waitMs: require('./fork-operations').WAIT_MS });
  // Unknown outcomes and successful PRs remain adoptable. A definite refusal
  // releases this request so corrected work can be submitted on the same task.
  if (!out.ok && !out.pending) {
    await pool.query(
      `UPDATE external_agent_tasks SET submit_operation = NULL
        WHERE id = $1 AND user_id = $2 AND submit_operation->>'requestId' = $3`,
      [p.input.taskId, p.userId, kept.requestId]
    );
  }
  return out;
}

module.exports = { request };
