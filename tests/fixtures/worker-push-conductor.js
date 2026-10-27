'use strict';

// A separate workflow process. Only external Git/worker I/O is replaced;
// the machine, claim, handler, current-target checks and result are real.
const { Pool } = require('pg');
const { createRuntime } = require('../../src/workflow/kernel/index.ts');
const { workerPush } = require('../../src/workflow/worker-push/machine.ts');
const { workerPushServices } = require('../../src/workflow/worker-push/services.ts');
const pool = new Pool({ connectionString: process.env.WORKER_PUSH_TEST_DATABASE_URL, max: 5 });
require('../../src/services/github').checkRepoPublic = async () => ({ ok: true, private: false });
require('../../src/services/worker').execPushFromWorker = async sessionId => {
  if (process.env.PROCESS_ROLE !== 'conductor') throw new Error('push outside conductor');
  await pool.query('INSERT INTO wf_test_push_effects (pid, session_id) VALUES ($1, $2)', [process.pid, sessionId]);
  return { sha: 'c'.repeat(40), stderr: '' };
};
const rt = createRuntime({ pool, machines: [workerPush()], services: workerPushServices({ pool }), slots: 1, pollMs: 10 });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await rt.stop(); await pool.end(); process.exit(0);
}
process.on('message', message => { if (message === 'stop') stop().catch(() => process.exit(1)); });
process.on('SIGTERM', () => { stop().catch(() => process.exit(1)); });
rt.start({ loops: true }).then(() => process.send({ ready: true })).catch(error => {
  process.send({ error: error.message }); process.exit(1);
});
