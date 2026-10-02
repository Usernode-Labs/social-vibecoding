'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { sanitizedEnvironment } = require('./isolated-kpack-fixture');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { GATE } = require('../../src/services/cli-preview-handoff/settlement');
const { CONTINUE } = require('../../src/services/cli-preview-handoff/work');

async function interrupt(t, f, phase) {
  const child = fork(require.resolve('./cli-checks-child'), [], {
    execArgv: [], env: sanitizedEnvironment(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const observed = new Promise((resolve, reject) => {
    child.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message));
    child.once('exit', code => reject(new Error(`Checks child exited ${code} before ${phase}`)));
  });
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for actual ${phase}`)), 240000);
  });
  child.send({ databaseUrl: f.url, phase });
  let message;
  try { message = await Promise.race([observed, deadline]); }
  catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    throw error;
  }
  finally { clearTimeout(timeout); }
  assert.equal(message.phase, phase);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await f.pool.query(`UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second',
    due_at = clock_timestamp() WHERE status = 'running'`);
  return message.identity;
}

async function tick(work) {
  const worker = createExecutionWorker({ store: work.store, handlers: { [CONTINUE]: work.handlers[CONTINUE] }, concurrency: 1 });
  await worker.tick();
  await worker.drain();
}

async function deliverGates(f, work) {
  const worker = createExecutionWorker({ store: work.store, handlers: { [GATE]: work.handlers[GATE] }, concurrency: 4 });
  await worker.tick();
  await worker.drain();
  const gates = (await f.pool.query('SELECT * FROM execution_work_requests WHERE workflow = $1', [GATE])).rows;
  assert.ok(gates.length, 'Verdict must durably hand off its required gate work');
  assert.ok(gates.every(gate => gate.status === 'succeeded'), 'Gate delivery must survive completion of checks continuation');
  return gates;
}

async function wake(f) {
  await f.pool.query(`UPDATE execution_work_requests SET due_at = clock_timestamp()
    WHERE workflow = $1 AND status = 'queued'`, [CONTINUE]);
}

async function orphan(f) {
  // Accelerate eligibility only after observing the killed process's exit.
  await f.pool.query("UPDATE check_runs SET heartbeat_at = NOW() - INTERVAL '5 minutes'");
}

async function snapshot(f) {
  return {
    session: (await f.pool.query(`SELECT checks_commit_sha, check_state, test_results,
      capture_state, capture_detail, console_check_state, console_errors, staging_runtime_name
      FROM chat_sessions WHERE id = $1`, [f.sessionId])).rows[0],
    visuals: (await f.pool.query('SELECT id, commit_hash FROM session_visuals ORDER BY id')).rows,
    history: (await f.pool.query('SELECT * FROM app_check_history ORDER BY id')).rows,
  };
}

module.exports = { interrupt, tick, wake, orphan, snapshot, deliverGates };
