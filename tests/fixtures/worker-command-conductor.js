'use strict';

// A separate workflow process for worker-command tests. Only final I/O is
// replaced; admission, claims, handlers and current-state checks are real.
const { Pool } = require('pg');
const { createRuntime } = require('../../src/workflow/kernel/index.ts');
const { workerPush } = require('../../src/workflow/worker-push/machine.ts');
const { workerPushServices } = require('../../src/workflow/worker-push/services.ts');
const { workerRelease } = require('../../src/workflow/worker-release/machine.ts');
const { workerReleaseServices } = require('../../src/workflow/worker-release/services.ts');
const { workerStop } = require('../../src/workflow/worker-stop/machine.ts');
const { workerStopServices, workerInterruptServices } = require('../../src/workflow/worker-stop/services.ts');
const { workerInterrupt } = require('../../src/workflow/worker-stop/interrupt.ts');
const spec = JSON.parse(process.env.WORKER_COMMAND_TEST);
if (!['push', 'release', 'stop', 'interrupt'].includes(spec.kind) || process.env.PROCESS_ROLE !== 'conductor') throw new Error('invalid test conductor');
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
} else if (spec.kind === 'interrupt') {
  worker.stopTurnByJournal = async (sessionId, _journal, options) => {
    if (options.force !== false) throw new Error('ordinary Stop must preserve the graceful signal');
    await pool.query(`INSERT INTO wf_test_interrupt_effects (pid, session_id, action) VALUES ($1, $2, 'signal')`, [process.pid, sessionId]);
    return 'signalled';
  };
  worker.isWorkerExecuting = async () => {
    await pool.query(`INSERT INTO wf_test_interrupt_effects (pid, session_id, action) VALUES ($1, $2, 'probe')`, [process.pid, spec.sessionId]);
    return false;
  };
} else if (spec.kind === 'stop') {
  worker.stopTurnByJournal = async (sessionId, journal) => {
    await pool.query('INSERT INTO wf_test_stop_effects (pid, session_id, journal) VALUES ($1, $2, $3)', [process.pid, sessionId, journal]);
    return 'stopped';
  };
  require('../../src/services/session-bus').publish = () => {};
  require('../../src/services/ws').broadcastGlobal = () => {};
} else {
  require('../../src/services/github').checkRepoPublic = async () => ({ ok: true, private: false });
  worker.execPushFromWorker = async sessionId => {
    await pool.query('INSERT INTO wf_test_push_effects (pid, session_id) VALUES ($1, $2)', [process.pid, sessionId]);
    return { sha: 'c'.repeat(40), stderr: '' };
  };
}
const commands = { release: [workerRelease, workerReleaseServices], push: [workerPush, workerPushServices], stop: [workerStop, workerStopServices], interrupt: [workerInterrupt, workerInterruptServices] };
const [machine, services] = commands[spec.kind];
const rt = createRuntime({ pool, machines: [machine()], services: services({ pool }), slots: 1, pollMs: 10 });
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
