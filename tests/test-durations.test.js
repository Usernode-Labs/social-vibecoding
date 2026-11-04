'use strict';

// `npm run test:durations` must only write numbers measured where the suite
// runs: the worker image with 8 CPUs (one shard's Job) and PostgreSQL up
// (scripts/test-durations.js). On 4 Nov 2026 a 2-CPU run wrote the baseline:
// defaultSeconds went from 0.4 to 1.3 and a 34 s file was recorded at 131 s,
// so the shard plan balanced on numbers that did not describe its runners.
// Pinned here: the refusal and its reason, --force with its reason, and that
// --add is exempt because it writes no measurements. The probes are stubbed,
// so these pass on any machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const td = require('../scripts/test-durations');
const shardPlan = require('../scripts/test-shard-plan');

const reachable = async () => true;
const unreachable = async () => false;

test('the machine check refuses fewer than 8 CPUs, names the worker image and writes nothing', async () => {
  const problem = await td.measurementMachineProblem({
    cpus: 2, postgres: reachable, target: { host: '127.0.0.1', port: 5432 },
  });
  assert.ok(problem, '2 CPUs is not the 8 the suite runs on');
  assert.match(problem, /only 2 of the 8 CPUs the worker image has are available/);
  assert.match(problem, /worker image with 8 CPUs/);
  assert.match(problem, /PostgreSQL up/);
  assert.match(problem, /Nothing was written/);
  assert.match(problem, /--force/);
});

test('the machine check refuses when PostgreSQL is not reachable', async () => {
  const problem = await td.measurementMachineProblem({
    cpus: 8, postgres: unreachable, target: { host: 'db.internal', port: 5433 },
  });
  assert.ok(problem);
  assert.match(problem, /PostgreSQL is not reachable at db\.internal:5433/);
  assert.doesNotMatch(problem, /only \d+ of the 8 CPUs/);
});

test('8 CPUs with PostgreSQL up need no override', async () => {
  assert.equal(await td.measurementMachineProblem({ cpus: 8, postgres: reachable }), null);
});

test('the database target is the test DSN, else 127.0.0.1:5432', () => {
  assert.deepEqual(td.databaseTarget({}), { host: '127.0.0.1', port: 5432 });
  assert.deepEqual(td.databaseTarget({ TEST_DATABASE_URL: 'postgres://u:p@db.example:5433/test' }), { host: 'db.example', port: 5433 });
  assert.deepEqual(td.databaseTarget({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/test' }), { host: '127.0.0.1', port: 5432 });
  assert.deepEqual(td.databaseTarget({ TEST_DATABASE_URL: 'not a connection url' }), { host: '127.0.0.1', port: 5432 });
});

test('postgresReachable is a TCP connect: true for a listening socket, false for a closed port', async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.equal(await td.postgresReachable({ host: '127.0.0.1', port }), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await td.postgresReachable({ host: '127.0.0.1', port }), false);
});

test('--force takes a reason; --add is exempt from the machine check', async () => {
  assert.deepEqual(td.parseForce(['--force', 'restoring the 16 Oct measurement']), {
    argv: [], reason: 'restoring the 16 Oct measurement',
  });
  assert.deepEqual(td.parseForce(['--from', 'records.json', '--force', 'why']), {
    argv: ['--from', 'records.json'], reason: 'why',
  });
  assert.deepEqual(td.parseForce(['--from', 'records.json']), { argv: ['--from', 'records.json'], reason: null });
  assert.throws(() => td.parseForce(['--force']), /--force needs a reason/);

  // --add runs its own validation first, so a 2-CPU machine reaches it and
  // fails on the name it was given, never on the machine.
  const missing = `tests/zz-no-such-${process.pid}.test.js`;
  await assert.rejects(td.main(['--add', missing], { cpus: 2, postgres: unreachable }), /does not exist/);
});

test('a refresh on the wrong machine exits 1 before reading records, and leaves the baseline as it was', async () => {
  const before = fs.readFileSync(shardPlan.DURATIONS_FILE, 'utf8');
  const messages = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { messages.push(String(chunk)); return true; };
  let code;
  try {
    // The records path does not exist: a run that read it before the check
    // would throw instead of refusing.
    code = await td.main(['--from', '/nonexistent/records.json'], { cpus: 2, postgres: reachable });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(code, 1);
  assert.match(messages.join(''), /refusing to write the durations baseline/);
  assert.equal(fs.readFileSync(shardPlan.DURATIONS_FILE, 'utf8'), before, 'nothing was written');
});
