'use strict';

// worker/usernode-push asks the platform to push the session branch. A push
// that lands while the platform restarts used to fail on its one try, and
// the turn ended with its commit unpushed (push_ok=0), which the bot's
// restart recovery then read as "no change to propose". It now tries again,
// with pauses, on a curl failure, a 5xx or a 429, and never on another
// answer or on a failure the platform marks permanent. Its output keeps the
// lines run-cc.sh and the host read.
//
// Run with: node --test tests/usernode-push-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'worker', 'usernode-push');

// A fake curl that answers, one try at a time, from `answers`: a line
// "exit <n>" fails as curl does, anything else is "<code> <body>".
function run(answers, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-push-'));
  try {
    fs.writeFileSync(path.join(dir, 'answers'), `${answers.join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'curl'), [
      '#!/bin/sh',
      `D=${JSON.stringify(dir)}`,
      'n=$(cat "$D/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$D/count"',
      'line=$(sed -n "${n}p" "$D/answers")',
      'case "$line" in',
      '  exit\\ *) echo "curl: (7) Failed to connect to usernode port 3000: Connection refused" >&2; printf "\\n000"; exit "${line#exit }" ;;',
      'esac',
      'code=${line%% *}; body=${line#* }',
      'printf "%s\\n%s" "$body" "$code"',
      '',
    ].join('\n'), { mode: 0o755 });
    const out = spawnSync('sh', [SCRIPT], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        WORKER_JWT: 'secret-jwt', SESSION_ID: '42', PLATFORM_URL: 'http://usernode:3000',
        USERNODE_PUSH_BACKOFF: '0 0 0 0 0',
        ...env,
      },
      encoding: 'utf8',
    });
    const tries = Number(fs.readFileSync(path.join(dir, 'count'), 'utf8').trim());
    return { status: out.status, stdout: out.stdout, stderr: out.stderr, tries };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a push that lands on the first try is reported as before', () => {
  const r = run(['200 {"ok":true,"branch":"dev/x","sha":"abc"}']);
  assert.equal(r.status, 0);
  assert.equal(r.tries, 1);
  assert.equal(r.stdout.trim(), 'usernode-push: ok ({"ok":true,"branch":"dev/x","sha":"abc"})');
});

test('a platform mid-restart (connection refused, then 502, then 503) is tried again until it pushes', () => {
  const r = run(['exit 7', '502 {"ok":false,"code":"push_failed"}', '503 Service Unavailable', '200 {"ok":true,"sha":"def"}']);
  assert.equal(r.status, 0);
  assert.equal(r.tries, 4);
  assert.match(r.stdout, /^usernode-push: ok \(\{"ok":true,"sha":"def"\}\)$/m);
  assert.doesNotMatch(r.stdout, /__USERNODE_WARN__/, 'a push that went through in the end warns of nothing');
  assert.doesNotMatch(r.stdout + r.stderr, /secret-jwt/);
});

test('six tries at most, then the push fails with the last answer, as before', () => {
  const r = run(Array(8).fill('exit 7'));
  assert.equal(r.status, 1);
  assert.equal(r.tries, 6);
  assert.match(r.stdout, /^__USERNODE_WARN__ usernode-push: curl failed: /m);
});

test('an answer that will not change is not tried again', () => {
  for (const answer of ['403 {"ok":false,"code":"session_mismatch"}', '409 {"ok":false,"code":"session_inactive"}',
    '502 {"ok":false,"code":"bad_branch","permanent":true}']) {
    const r = run([answer, '200 {"ok":true}']);
    assert.equal(r.status, 1, answer);
    assert.equal(r.tries, 1, answer);
    assert.equal(r.stdout.trim(), `__USERNODE_WARN__ usernode-push: HTTP ${answer.replace(' ', ': ')}`);
  }
});

test('a rate-limited push is tried again', () => {
  const r = run(['429 {"ok":false,"code":"rate_limited"}', '200 {"ok":true}']);
  assert.equal(r.status, 0);
  assert.equal(r.tries, 2);
});

// The unit suite runs in the worker image, where run-cc.sh and
// run-codex-agent.sh call the real script; a test pointing a runner at a
// platform that is not there sat out every pause (110 s a run) until four
// files timed out. Set but empty, the backoff is one try, and the suite's
// preload gives every child a test starts that value.
test('set but empty, the backoff is one try', () => {
  const r = run(['exit 7', '200 {"ok":true}'], { USERNODE_PUSH_BACKOFF: '' });
  assert.equal(r.status, 1);
  assert.equal(r.tries, 1);
  assert.match(r.stdout, /^__USERNODE_WARN__ usernode-push: curl failed: /m);
});

test('the unit suite\'s preload gives a child one push try unless the test set its own backoff', () => {
  // Loaded here too, so the file also passes under a bare `node --test`.
  require('./lib/test-net.js');
  const childProcess = require('node:child_process');
  const backoff = (env) => childProcess.spawnSync('sh', ['-c', 'printf "[%s]" "${USERNODE_PUSH_BACKOFF-unset}"'],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).stdout;
  assert.equal(backoff({}), '[]', 'an env built from scratch');
  assert.equal(backoff({ USERNODE_PUSH_BACKOFF: '0 0' }), '[0 0]', 'a test that set its own');
  assert.equal(process.env.USERNODE_PUSH_BACKOFF, '');
});
