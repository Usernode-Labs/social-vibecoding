'use strict';

// A separate workflow process for worker-command tests. Only final I/O is
// replaced; admission, claims, handlers and current-state checks are real.
const { Pool } = require('pg');
const { createRuntime } = require('../../src/workflow/kernel/index.ts');
const { workerPush } = require('../../src/workflow/worker-push/machine.ts');
const { workerPushServices } = require('../../src/workflow/worker-push/services.ts');
const { workerRelease } = require('../../src/workflow/worker-release/machine.ts');
const { workerReleaseServices } = require('../../src/workflow/worker-release/services.ts');
const spec = JSON.parse(process.env.WORKER_COMMAND_TEST);
if (!['push', 'release'].includes(spec.kind) || process.env.PROCESS_ROLE !== 'conductor') throw new Error('invalid test conductor');
const pool = new Pool({ connectionString: spec.databaseUrl, max: 5 });
require('../../src/db/pool').getPool = () => pool;
const worker = require('../../src/services/worker');
if (spec.kind === 'release') {
  worker.rescueUnpushedCommit = async () => ({ attempted: false });
  worker.removeWorker = async (sessionId, options) => {
    if (!(await options.proceed())) return { skipped: true };
    await options.renew();
    await pool.query('INSERT INTO wf_test_release_effects (pid, session_id) VALUES ($1, $2)', [process.pid, sessionId]);
    return { removed: true };
  };
} else {
  require('../../src/services/github').checkRepoPublic = async () => ({ ok: true, private: false });
  worker.execPushFromWorker = async sessionId => {
    await pool.query('INSERT INTO wf_test_push_effects (pid, session_id) VALUES ($1, $2)', [process.pid, sessionId]);
    return { sha: 'c'.repeat(40), stderr: '' };
  };
}
const releasing = spec.kind === 'release';
const rt = createRuntime({ pool, machines: [releasing ? workerRelease() : workerPush()],
  services: releasing ? workerReleaseServices({ pool }) : workerPushServices({ pool }), slots: 1, pollMs: 10 });
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
