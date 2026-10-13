'use strict';

// test:changed: always (reads every test file's source; fast)
//
// A test that runs a worker runner (worker/run-cc.sh, run-codex-agent.sh)
// must give it RUNNER_TEST_ENV (tests/lib/runner-env.js). The runner pushes
// through usernode-push, which waits out about two minutes of pauses when
// the platform cannot be reached, and a test's platform never can be: four
// runner suites ran into the 180 s timeout that way and turned main red.
// Naming a runner's path anywhere but a readFileSync (a constant, a spawn's
// argument, an env's RUNNER) counts as running it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RUNNER_TEST_ENV } = require('./lib/runner-env');

const RUNNER_PATH = /(readFileSync\(\s*)?path\.join\([^()]*'(?:[^'()]*\/)?run-(?:cc|codex-agent)\.sh'\)/g;

function runsARunner(source) {
  return [...source.matchAll(RUNNER_PATH)].some((m) => !m[1]);
}

test('every test that runs a worker runner gives it no push pauses', () => {
  const dir = __dirname;
  const missing = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    if (runsARunner(source) && !source.includes('RUNNER_TEST_ENV')) missing.push(name);
  }
  assert.deepEqual(missing, [], 'spread RUNNER_TEST_ENV from tests/lib/runner-env.js into the runner\'s env');
});

test('the override is a pause of nothing, which usernode-push does not read as unset', () => {
  assert.equal(RUNNER_TEST_ENV.USERNODE_PUSH_BACKOFF, '0');
  const script = fs.readFileSync(path.join(__dirname, '..', 'worker', 'usernode-push'), 'utf8');
  assert.match(script, /BACKOFF="\$\{USERNODE_PUSH_BACKOFF:-\$DEFAULT_BACKOFF\}"/);
});

test('the guard sees a runner run, and not one only read', () => {
  assert.equal(runsARunner("const RUNNER = path.join(ROOT, 'worker', 'run-cc.sh');"), true);
  assert.equal(runsARunner("spawnSync('sh', [path.join(__dirname, '..', 'worker/run-codex-agent.sh')])"), true);
  assert.equal(runsARunner("fs.readFileSync(path.join(ROOT, 'worker', 'run-cc.sh'), 'utf8')"), false);
});
