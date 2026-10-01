'use strict';

const { createSteps } = require('./steps');
const { event } = require('./database');

const config = JSON.parse(process.env.C0_CONFIG);
const version = Number(process.env.C0_VERSION || 1);
const { step, pool } = createSteps(config, 'bounded');
const phases = version === 1 ? ['reserve', 'clone', 'build', 'checks', 'publish']
  : ['reserve', 'clone', 'audit', 'build', 'checks', 'publish'];

async function attempt(row) {
  const work = row.input;
  const heartbeat = setInterval(() => {
    pool.query(`UPDATE c0_work SET lease_until = NOW() + INTERVAL '800 milliseconds'
      WHERE id = $1 AND token = $2`, [row.id, row.token]).catch(() => {});
  }, 100);

  try {
    const result = await step(row.stage, work, { token: row.token, attempt: row.attempts });
    let next = row.stage;
    if (result.retired) next = 'cleanup';
    else if (!result.pending && !result.busy) next = phases[phases.indexOf(row.stage) + 1] || 'done';

    const updated = await pool.query(`UPDATE c0_work SET stage = $3, done = ($3 = 'done'),
      token = NULL, lease_until = NULL, next_at = NOW() + INTERVAL '100 milliseconds',
      position = nextval('c0_position'), last_error = NULL WHERE id = $1 AND token = $2`, [row.id, row.token, next]);
    if (!updated.rowCount) throw new Error('Execution checkpoint lease changed');
    await event(pool, work.id, next === 'done' ? 'finished' : 'checkpoint', { backend: 'bounded', next, token: row.token });
  } catch (error) {
    await pool.query(`UPDATE c0_work SET token = NULL, lease_until = NULL,
      next_at = NOW() + INTERVAL '300 milliseconds', position = nextval('c0_position'),
      last_error = $3 WHERE id = $1 AND token = $2`, [row.id, row.token, error.message]);
    await event(pool, work.id, 'execution_retry', { backend: 'bounded', stage: row.stage, error: error.message });
  } finally {
    clearInterval(heartbeat);
  }
}

async function run() {
  process.send({ ready: true });
  for (;;) {
    // A small fixed sequence, not an extensible workflow engine. Claim/lease,
    // due-work discovery, queue rotation and retry are all application code.
    const { rows } = await pool.query(`WITH candidates AS (
      SELECT id FROM c0_work WHERE backend = 'bounded' AND version = $1 AND NOT done
        AND next_at <= NOW() AND (lease_until IS NULL OR lease_until < NOW())
        ORDER BY position LIMIT 5 FOR UPDATE SKIP LOCKED
    ) UPDATE c0_work w SET token = gen_random_uuid(), lease_until = NOW() + INTERVAL '800 milliseconds',
      position = nextval('c0_position'), attempts = attempts + 1 FROM candidates c
      WHERE w.id = c.id RETURNING w.*`, [version]);
    await Promise.all(rows.map(attempt));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

run().catch(error => { console.error(error); process.exit(1); });
