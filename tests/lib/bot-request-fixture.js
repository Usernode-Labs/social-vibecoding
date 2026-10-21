'use strict';

// A bot-request instance for each homeroom_bot_queue row no instance holds,
// as the machine leaves one (src/workflow/bot-request/machine.ts): a debt
// queued since the row's enqueued_at (held until its held_until), or, for a
// row with started_at, a read under way since then. Written as a transition
// writes it (`SET LOCAL app.wf_writer`), for a fixture that needs a request
// owed long ago, held, or being read, which no event sets directly.

const KEY = (appId, n) => `request:${Number(appId)}:${Number(n)}`;

async function seedRequests(pool, { appId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT q.* FROM homeroom_bot_queue q
      WHERE ($1::int IS NULL OR q.app_id = $1)
        AND NOT EXISTS (SELECT 1 FROM wf_instances w WHERE w.machine = 'bot-request'
                         AND w.key = 'request:' || q.app_id || ':' || q.issue_number)`, [appId]);
  const client = await pool.connect();
  try {
    await client.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
    for (const q of rows) {
      const owed = {
        reason: q.reason, priority: q.priority, payer: q.payer_user_id ?? null, requestedBy: q.requested_by ?? null,
        changedBy: q.changed_by ?? null, threadSeenAt: q.thread_seen_at ? q.thread_seen_at.toISOString() : null,
        enqueuedAt: q.enqueued_at.toISOString(), heldUntil: q.held_until ? q.held_until.toISOString() : null,
      };
      const base = {
        appId: q.app_id, issueNumber: q.issue_number, owed, look: null, build: null, slot: null, n: 0,
        backoff: null, fix: null, spentRetry: null, lastRead: null, carried: null,
      };
      const reading = !!q.started_at;
      const data = reading
        ? { ...base, n: 1, look: { n: 1, kind: 'read', sessionId: null, owed, startedAt: q.started_at.toISOString(), interrupted: false } }
        : base;
      const held = !reading && q.held_until && q.held_until > new Date();
      await client.query(
        `INSERT INTO wf_instances (machine, key, app_id, state, data, version, machine_version, deadline_at, deadline_event, deadline_version)
         VALUES ('bot-request', $1, $2, $3, $4::jsonb, 1, 1, $5,
                 CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE '{"type":"Due"}'::jsonb END,
                 CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE 1 END)`,
        [KEY(q.app_id, q.issue_number), q.app_id, reading ? 'reading' : 'queued', JSON.stringify(data), held ? q.held_until : null]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return rows.length;
}

module.exports = { seedRequests };
