'use strict';

const { Pool } = require('pg');
const { Connection, Client, WorkflowExecutionAlreadyStartedError } = require('@temporalio/client');
const { WorkflowIdReusePolicy } = require('@temporalio/common');
const { event } = require('./database');

async function run() {
  const config = JSON.parse(process.env.C0_CONFIG);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const connection = Connection.lazy({ address: config.temporalAddress });
  const client = new Client({ connection });
  let loseAck = process.env.C0_LOSE_START_ACK === 'true';
  process.send({ ready: true });

  for (;;) {
    const { rows } = await pool.query(`WITH candidates AS (
      SELECT id FROM c0_work WHERE backend = 'temporal' AND NOT dispatched
        AND next_at <= NOW() ORDER BY position LIMIT 25 FOR UPDATE SKIP LOCKED
    ) UPDATE c0_work w SET next_at = NOW() + INTERVAL '300 milliseconds',
      position = nextval('c0_position') FROM candidates c WHERE w.id = c.id RETURNING w.*`);

    for (const row of rows) {
      try {
        try {
          await connection.withDeadline(Date.now() + 1000, () => client.workflow.start(`prepareV${row.version}`, {
            workflowId: `c0-${row.id}`,
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
            taskQueue: `${config.queue}-v${row.version}`,
            priority: { fairnessKey: String(row.input.sessionId), fairnessWeight: 1 },
            args: [row.input],
          }));
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
          await event(pool, row.id, 'duplicate_start');
        }
        if (loseAck) {
          loseAck = false;
          throw new Error('Injected loss after accepted workflow start');
        }
        await pool.query('UPDATE c0_work SET dispatched = TRUE WHERE id = $1', [row.id]);
        await event(pool, row.id, 'dispatched');
      } catch (error) {
        await event(pool, row.id, 'dispatch_retry', { error: error.message });
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

run().catch(error => { console.error(error); process.exit(1); });
