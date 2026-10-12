'use strict';

// worker/usernode-push asks the platform to push the session branch. A push
// that lands while the platform restarts used to fail on its one try, and
// the turn ended with its commit unpushed (push_ok=0), which the bot's
// restart recovery then read as "no change to propose". It now tries again,
// with pauses, on a curl failure, a 5xx or a 429, and never on another
// answer or on a failure the platform marks permanent. Its output keeps the
// lines run-cc.sh and the host read. The retry is opt-in: every real turn
// sets USERNODE_PUSH_RETRY=1 (worker.js), and anything else tries once, so a
// test whose platform is never there does not wait out two minutes of pauses.
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
// "exit <n>" fails as curl does, anything else is "<code> <body>". A fake
// sleep records each pause and returns at once. An env value of null leaves
// that variable unset.
function run(answers, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-push-'));
  try {
    fs.writeFileSync(path.join(dir, 'answers'), `${answers.join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'sleep'), [
      '#!/bin/sh',
      `echo "$1" >> ${JSON.stringify(path.join(dir, 'pauses'))}`,
      '',
    ].join('\n'), { mode: 0o755 });
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
    const merged = {
      PATH: `${dir}:${process.env.PATH}`,
      WORKER_JWT: 'secret-jwt', SESSION_ID: '42', PLATFORM_URL: 'http://usernode:3000',
      USERNODE_PUSH_BACKOFF: '0 0 0 0 0',
      ...env,
    };
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
    const out = spawnSync('sh', [SCRIPT], { env: merged, encoding: 'utf8' });
    const tries = Number(fs.readFileSync(path.join(dir, 'count'), 'utf8').trim());
    const pausesFile = path.join(dir, 'pauses');
    const pauses = fs.existsSync(pausesFile) ? fs.readFileSync(pausesFile, 'utf8').trim().split('\n') : [];
    return { status: out.status, stdout: out.stdout, stderr: out.stderr, tries, pauses };
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

test('without the opt-in, a push that cannot land is tried once and fails at once', () => {
  const started = Date.now();
  const r = run(Array(8).fill('exit 7'), { USERNODE_PUSH_BACKOFF: null, USERNODE_PUSH_RETRY: null });
  assert.equal(r.status, 1);
  assert.equal(r.tries, 1);
  assert.deepEqual(r.pauses, []);
  assert.match(r.stdout, /^__USERNODE_WARN__ usernode-push: curl failed: /m);
  assert.ok(Date.now() - started < 10000, 'no pauses without the opt-in');
});

test('with the opt-in, a real turn waits out about two minutes of pauses between six tries', () => {
  const r = run(Array(8).fill('exit 7'), { USERNODE_PUSH_BACKOFF: null, USERNODE_PUSH_RETRY: '1' });
  assert.equal(r.status, 1);
  assert.equal(r.tries, 6);
  assert.deepEqual(r.pauses, ['5', '10', '20', '30', '45']);
});

test('every turn the platform runs in a worker opts in', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');
  const perTurn = src.indexOf("COMMIT_MSG: commitMsg || 'Changes via Homeroom'");
  assert.ok(perTurn > 0, 'the per-turn env literal is where it was');
  const literal = src.slice(perTurn, src.indexOf('};', perTurn));
  assert.match(literal, /USERNODE_PUSH_RETRY: '1'/);
});
