'use strict';

// Two processes for the workflow machines: the test process is the web side
// (it appends events and waits for their outcomes, and decides nothing), and
// a child process it starts is the workflow side (pipeline slots, timers and
// work handlers: platform.ts with its loops). A machine passes only if
// nothing it decides depends on being in the web process; a restart test
// kills the child mid-flow with SIGKILL, starts another, and compares the end
// state with an uninterrupted run.
//
// Only outside services are faked, in the child, by a fixture module
// (tests/fixtures/workflow-outside-fakes.js): every platform module is real,
// so state a machine reaches in its own process's memory is really there,
// and really lost. A fake keeps what the outside service would remember
// (a comment GitHub created) in the database, in wf_test_effects, so a
// restarted child sees it, and can stop at a named point
// (wf_test_pauses) until the test releases it, so the test can kill the
// child there.

const { fork } = require('node:child_process');
const path = require('node:path');

const CHILD = path.join(__dirname, 'workflow-child.js');

const HARNESS_SQL = `
  CREATE TABLE IF NOT EXISTS wf_test_effects (
    id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', pid INT, at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS wf_test_pauses (
    name TEXT PRIMARY KEY, reached_at TIMESTAMPTZ, released BOOLEAN NOT NULL DEFAULT FALSE);`;

async function prepare(pool) {
  await pool.query(HARNESS_SQL);
}

// Start the workflow side. `config` is what server.js would build (the
// flags, the data key); the child adds the database URL.
function startWorkflowProcess({ databaseUrl, config, fixture, env = {} }) {
  let stderr = '';
  const child = fork(CHILD, [], {
    env: { ...process.env, ...env, WF_TEST_CHILD: JSON.stringify({ databaseUrl, config, fixture }) },
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (d) => { if (process.env.WF_DEBUG) process.stdout.write(`[workflow ${child.pid}] ${d}`); });
  child.stderr.on('data', (d) => { stderr += d; if (process.env.WF_DEBUG) process.stderr.write(`[workflow ${child.pid}] ${d}`); });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.on('message', (m) => { if (m?.ready) resolve(); });
    exited.then(({ code, signal }) => reject(new Error(`the workflow process exited (${signal || code}) before it was ready\n${stderr.slice(-4000)}`)));
  });
  return {
    pid: child.pid,
    ready,
    exited,
    // A crash: nothing is flushed, nothing is stopped.
    async kill() {
      child.kill('SIGKILL');
      await exited;
    },
    // A clean stop, as a release's SIGTERM gives one.
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.send({ stop: true });
      const t = setTimeout(() => child.kill('SIGKILL'), 20000);
      await exited;
      clearTimeout(t);
    },
  };
}

// The leases of the dead process's work run out (time passing, without the
// test waiting a minute for it): the next process claims that work again.
async function expireLeases(pool) {
  await pool.query(`UPDATE wf_work SET lease_until = now() - interval '1 second' WHERE status = 'running'`);
}

// A named point a fake stops at: arm it, wait until a fake reached it,
// then release it (or kill the process stopped there).
async function arm(pool, name) {
  await pool.query(
    `INSERT INTO wf_test_pauses (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET reached_at = NULL, released = FALSE`, [name]);
}
async function reached(pool, name, timeoutMs = 20000) {
  await until(async () => (await pool.query('SELECT reached_at FROM wf_test_pauses WHERE name = $1', [name])).rows[0]?.reached_at,
    `the workflow process to reach ${name}`, timeoutMs);
}
async function release(pool, name) {
  await pool.query('UPDATE wf_test_pauses SET released = TRUE WHERE name = $1', [name]);
}

// What the fakes saw, oldest first.
async function effects(pool, kind) {
  const { rows } = await pool.query('SELECT kind, data, pid FROM wf_test_effects WHERE kind = $1 ORDER BY id', [kind]);
  return rows;
}

async function until(check, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

module.exports = { prepare, startWorkflowProcess, expireLeases, arm, reached, release, effects, until };
