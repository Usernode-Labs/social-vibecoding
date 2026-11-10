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
const net = require('node:net');
const path = require('node:path');
const { Client } = require('pg');

const CHILD = path.join(__dirname, 'workflow-child.js');

const HARNESS_SQL = `
  CREATE TABLE IF NOT EXISTS wf_test_effects (
    id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', pid INT, at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS wf_test_pauses (
    name TEXT PRIMARY KEY, reached_at TIMESTAMPTZ, released BOOLEAN NOT NULL DEFAULT FALSE, pid INT);`;

async function prepare(pool) {
  await pool.query(HARNESS_SQL);
}

// A port nobody listens on, for a workflow process's own listener.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// A boot that dies before it is ready is tried again on a fresh port. The
// port is free only until the child binds it, which it does after its whole
// boot (server.js's startup queries, its process row, its listener), so a
// parallel test file can take it in between; and a refused database
// connection during any startup query is fatal too. Both exit 1 before
// `ready`, and neither is a reason for the check to fail.
const BOOT_ATTEMPTS = 3;

// One boot: server.js forked as a conductor on `PORT`. `env` is what the chart
// would set for it (the data key, the workflow's slots and pool, the shots and
// phone-push switches); the child adds the database URL, and this adds its
// own port.
function launch({ databaseUrl, fixture, env, port }) {
  let stderr = '';
  const child = fork(CHILD, [], {
    env: { ...process.env, WF_TEST_CHILD: JSON.stringify({ databaseUrl, env: { ...env, PORT: String(port) }, fixture }) },
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
  return { child, port, exited, ready, stderr: () => stderr };
}

// A boot that dies before it is ready may already have run startup work
// against this database (a retirement inventory, a refused outside call),
// because losing its port fails at the very end of server.start(). That work
// belongs to a process that never served: drop what its pid recorded, so the
// boot that becomes ready is the one whose effects the check's assertions
// count once. Its platform_processes row stays, as it does for a killed child.
async function forgetBoot(databaseUrl, pid) {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('DELETE FROM wf_test_effects WHERE pid = $1', [pid]);
  } catch {
    // The harness tables may not exist yet, or the connection may be what
    // refused; the retry itself does not depend on this cleanup.
  } finally {
    await client.end().catch(() => {});
  }
}

// Start the workflow side: server.js booted as a conductor. A boot that exits
// before saying it is ready is tried again, up to BOOT_ATTEMPTS, on a fresh
// port; the first boot that becomes ready is the one this returns. If every
// boot fails, the error names each attempt and carries its stderr, so a real
// startup bug says what it is.
async function startWorkflowProcess({ databaseUrl, fixture, env = {} }) {
  const failures = [];
  let lastExit = null;
  for (let n = 1; n <= BOOT_ATTEMPTS; n += 1) {
    const port = await freePort();
    const attempt = launch({ databaseUrl, fixture, env, port });
    try {
      await attempt.ready;
    } catch {
      lastExit = await attempt.exited;
      failures.push(`attempt ${n} (pid ${attempt.child.pid}, port ${port}) exited (${lastExit.signal || lastExit.code})\n${attempt.stderr().slice(-4000)}`);
      await forgetBoot(databaseUrl, attempt.child.pid);
      continue;
    }
    const { child, exited } = attempt;
    return {
      pid: child.pid,
      port,
      ready: Promise.resolve(),
      exited,
      // A crash: nothing is flushed, nothing is stopped.
      async kill() {
        child.kill('SIGKILL');
        await exited;
      },
      // A clean stop, as a release's SIGTERM gives one (server.js cleanup).
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const t = setTimeout(() => child.kill('SIGKILL'), 30000);
        await exited;
        clearTimeout(t);
      },
    };
  }
  const code = lastExit ? (lastExit.signal || lastExit.code) : 'unknown';
  throw new Error(`the workflow process exited (${code}) before it was ready\n${failures.join('\n\n')}`);
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
// Resolves the pid of the process that reached it (with two running, the
// one to kill).
async function reached(pool, name, timeoutMs = 20000) {
  const row = await until(async () => {
    const { rows: [r] } = await pool.query('SELECT reached_at, pid FROM wf_test_pauses WHERE name = $1', [name]);
    return r?.reached_at ? r : null;
  }, `the workflow process to reach ${name}`, timeoutMs);
  return row.pid;
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
