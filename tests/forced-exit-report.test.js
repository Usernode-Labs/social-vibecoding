'use strict';

// A forced exit does not cut a test file's report short
// (tests/lib/forced-exit.js, loaded by tests/lib/test-net.js).
//
// Both ways the suite runs pass --test-force-exit to each test file's
// process: `npm test` and scripts/test-shard.js. The file here has many
// tests, a failing last one, and a timer and a server left open. It runs 30
// times each way, and every time the failing test's name has to arrive, with
// every other result, and the process has to end.
//
// Run with: node --test tests/forced-exit-report.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { testCommand } = require('../scripts/test-changed');

const ROOT = path.join(__dirname, '..');
const RUNS = 30;
const PASSING = 150;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const LAST = (i) => `run ${i}: the last test fails`;
const body = (i) => `
const test = require('node:test');
for (let t = 0; t < ${PASSING}; t += 1) test('run ${i}: test ' + t, () => {});
test(${JSON.stringify(LAST(i))}, () => { throw new Error('no'); });
setInterval(() => {}, 1000);
require('node:net').createServer().listen(0, '127.0.0.1');
`;

// A repository with this one's own test script, and RUNS copies of the file.
// Its preload is the one module under test: all of test-net.js, once per
// copy, would be most of this suite's time.
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forced-exit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tests', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests', 'baselines'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: pkg.scripts.test } }));
  fs.writeFileSync(path.join(dir, 'tests', 'lib', 'test-net.js'),
    `require(${JSON.stringify(path.join(ROOT, 'tests', 'lib', 'forced-exit.js'))});\n`);
  fs.copyFileSync(path.join(ROOT, 'tests', 'lib', 'shard-ledger.js'), path.join(dir, 'tests', 'lib', 'shard-ledger.js'));
  const files = [];
  for (let i = 1; i <= RUNS; i += 1) {
    const file = `tests/run-${i}.test.js`;
    fs.writeFileSync(path.join(dir, file), body(i));
    files.push(file);
  }
  fs.writeFileSync(path.join(dir, 'tests', 'baselines', 'test-durations.json'), JSON.stringify({
    version: 1, defaultSeconds: 1, files: Object.fromEntries(files.map((f) => [f, [1, 1]])),
  }));
  return { dir, files };
}

// This file runs under node's test runner, whose context a nested runner
// must not inherit.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_SHARD_LEDGER;
  return env;
}

// SIGKILL: a runner reading a report cut in the middle of a message spins
// and never gets to a SIGTERM.
function runIn(dir, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: dir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

function assertComplete(r) {
  const tail = `${r.stdout.slice(-600)}\n${r.stderr.slice(-600)}`;
  assert.equal(r.signal, null, `the run ended by itself\n${tail}`);
  assert.equal(r.code, 1, tail);
  const named = new Set([...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]));
  const unnamed = [];
  for (let i = 1; i <= RUNS; i += 1) if (!named.has(LAST(i))) unnamed.push(i);
  assert.deepEqual(unnamed, [], `${unnamed.length} of ${RUNS} runs did not name their failing test`);
  assert.equal((r.stdout.match(/^ok \d+ - run \d+: test \d+$/gm) || []).length, RUNS * PASSING, 'every passing test is reported');
  assert.match(r.stdout, new RegExp(`^# tests ${RUNS * (PASSING + 1)}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^# fail ${RUNS}$`, 'm'));
}

test('npm test: every run of a long file that fails at its end names the failing test', async (t) => {
  const { dir, files } = repo(t);
  const [, ...args] = testCommand(pkg, ['--test-reporter=tap', ...files]);
  assert.ok(args.includes('--test-force-exit'));
  assertComplete(await runIn(dir, args, childEnv()));
});

test('test:shard: every run of a long file that fails at its end names the failing test', async (t) => {
  const { dir } = repo(t);
  const r = await runIn(dir, [path.join(ROOT, 'scripts', 'test-shard.js')], childEnv({ TEST_SHARD: '1/1' }));
  assertComplete(r);
  assert.match(r.stdout, new RegExp(`^# shard 1/1: ran ${RUNS} of ${RUNS} planned files`, 'm'));
});

test('the preload of every test process loads it, for a forced exit only', () => {
  const closes = (flags) => spawnSync(process.execPath, [
    '--require', path.join(ROOT, 'tests', 'lib', 'test-net.js'), ...flags, '-p', 'typeof process.stdout.close',
  ], { encoding: 'utf8', env: childEnv() }).stdout.trim();
  assert.equal(closes(['--test-force-exit']), 'function');
  assert.equal(closes([]), 'undefined');
});

test('a file that leaves its own write over stdout\'s still ends', async (t) => {
  const { dir } = repo(t);
  const file = path.join(dir, 'tests', 'swallows.test.js');
  fs.writeFileSync(file, "require('node:test')('swallows', () => { process.stdout.write = () => true; });\nsetInterval(() => {}, 1000);\n");
  const [, ...args] = testCommand(pkg, ['--test-reporter=tap', file]);
  const r = await runIn(dir, args, childEnv());
  assert.equal(r.signal, null);
  assert.equal(r.code, 0, r.stdout + r.stderr);
});
