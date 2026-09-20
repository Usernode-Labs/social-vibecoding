'use strict';

// #2504: a failed deploy's logs were persisted to `apps.last_failure`
// exactly as captured, and `GET /api/apps/:slug` hands that whole object —
// `log` included — to any collaborator, the creator, or any admin.
//
// Two things were wrong, and this file covers both.
//
// 1. NOTHING REDACTED THE RECORD. `#30` built a redactor
//    (`SENSITIVE_PATTERNS` / `redactString` in services/logger.js) precisely
//    so that "a single `log.warn('docker', err.message)` where `err.cmd`
//    happens to contain a key shouldn't be a security incident" — but
//    services/deploy-failure.js never called it. Its output goes to the
//    DATABASE, not through the logger, so it took none of that protection.
//
//    What lands in there is not hypothetical. `classify()` builds its record
//    from `err.buildLog`, `err.containerLogs` and `err.stderr`, and
//    `stripCommandFailedPrefix`'s own comment in that file says "a rejected
//    execFile puts its entire argv in front of the real message, and
//    `docker run`'s argv is long enough to consume the whole 280-char
//    budget". That argv is built at services/docker.js by
//    `Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])` — every
//    environment variable the container gets, which for a child app is every
//    secret its dapp.json declares.
//
// 2. THE REDACTOR COULD NOT HAVE COVERED IT ANYWAY. Its patterns name
//    specific vendors — `sk-ant-`, `sk-or-v1-`, `ghp_` — plus URI-embedded
//    credentials. A child app's secrets are arbitrary and user-named, so
//    `STRIPE_KEY=sk_live_…`, `SENDGRID_API_KEY=SG.…`, `ADMIN_TOKEN=…` and a
//    bare `MY_APP_SECRET=…` all passed through in cleartext. Measured before
//    the fix, against the real redactor.
//
// The fix redacts AT CAPTURE TIME, so the database never holds the secret at
// all rather than hiding it on read — and adds a name-shaped rule for the
// arbitrary case, which helps the logger and the /status ring buffer too.
//
// Run with: node --test tests/deploy-failure-redaction.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const deployFailure = require('../src/services/deploy-failure');
const log = require('../src/services/logger');
const { redactValues, redactEnvAssignments } = require('../src/services/log-redaction');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// A realistic rejected `docker run`: execFile puts the whole argv in the
// message, and services/docker.js puts every env var on that argv.
const SECRETS = {
  STRIPE_KEY: 'sk_live_51ABCdefGHIjklMNO',
  SENDGRID_API_KEY: 'SG.xyzXYZ.abcABC',
  ADMIN_TOKEN: 'qwerty-admin-0001',
  MY_APP_SECRET: 'topsecret123',
  SESSION_PASSWORD: 'hunter2hunter2',
  DB_PASS: 'p4ssw0rd-live',
};
const DB_PASSWORD = 'hunter2';

function dockerArgvMessage() {
  const envArgs = Object.entries(SECRETS)
    .map(([k, v]) => `-e ${k}=${v}`)
    .join(' ');
  return 'Command failed: docker run -d --name app-x '
    + `-e DATABASE_URL=postgres://approle:${DB_PASSWORD}@db:5432/app_x `
    + `-e USERNODE_ENV=production ${envArgs} registry/app-x:abc123\n`
    + 'docker: Error response from daemon: driver failed programming external '
    + 'connectivity on endpoint app-x: address already in use.';
}

// Every secret value that must never survive into a persisted record.
const ALL_SECRET_VALUES = [...Object.values(SECRETS), DB_PASSWORD];

function assertNoSecrets(blob, label) {
  const text = typeof blob === 'string' ? blob : JSON.stringify(blob);
  for (const secret of ALL_SECRET_VALUES) {
    assert.doesNotMatch(text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${label}: the value of a secret survived (${secret.slice(0, 6)}…)`);
  }
}

// ── The record that reaches the database ───────────────────────────────

test('a failed docker run does not persist its argv secrets', () => {
  const err = Object.assign(new Error(dockerArgvMessage()), {
    stderr: dockerArgvMessage(),
  });
  const record = deployFailure.record(err, { stage: 'deploy', sha: 'abc123' });
  assertNoSecrets(record, 'record');
  // And it is still a useful record — redaction must not blank it.
  assert.equal(record.stage, 'deploy');
  assert.ok(record.reason, 'a reason survives');
  assert.match(JSON.stringify(record), /address already in use/,
    'the actual diagnosis must survive redaction');
});

test('a build log does not persist its secrets', () => {
  const err = Object.assign(new Error('build failed'), {
    buildFailed: true,
    buildLog: `Step 7/9 : RUN npm ci\n${dockerArgvMessage()}\nnpm ERR! code E401`,
  });
  const record = deployFailure.record(err);
  assertNoSecrets(record, 'build record');
  assert.equal(record.stage, 'build');
  assert.match(record.log, /npm ERR! code E401/, 'the build diagnosis survives');
});

test('container boot logs do not persist their secrets', () => {
  const err = Object.assign(new Error('boot failed'), {
    healthcheckFailed: true,
    containerLogs: `Booting…\nenv: ADMIN_TOKEN=${SECRETS.ADMIN_TOKEN}\n`
      + `DATABASE_URL=postgres://approle:${DB_PASSWORD}@db:5432/app_x\n`
      + 'Error: relation "users" does not exist',
  });
  const record = deployFailure.record(err);
  assertNoSecrets(record, 'healthcheck record');
  assert.match(record.log, /relation "users" does not exist/,
    'the boot diagnosis survives');
});

// The 280-char `reason` is the field shown on the app card's tooltip to the
// widest audience, so it matters at least as much as the log.
test('the reason line is redacted too, not just the log', () => {
  const err = Object.assign(new Error(`Error: auth failed with ADMIN_TOKEN=${SECRETS.ADMIN_TOKEN}`), {
    stderr: `Error: auth failed with ADMIN_TOKEN=${SECRETS.ADMIN_TOKEN}`,
  });
  const record = deployFailure.record(err);
  assertNoSecrets(record.reason, 'reason');
  assert.match(record.reason, /auth failed/, 'the reason is still meaningful');
});

test('a synthetic record is unaffected and still empty-logged', () => {
  const record = deployFailure.syntheticRecord('clone', 'The clone timed out');
  assert.equal(record.log, '');
  assert.equal(record.reason, 'The clone timed out');
});

test('an innocent log is passed through unchanged', () => {
  const clean = 'Step 3/9 : COPY . .\nnpm WARN deprecated foo@1.0.0\n'
    + 'Error: Cannot find module \'./missing\'';
  const err = Object.assign(new Error('build failed'), {
    buildFailed: true, buildLog: clean,
  });
  assert.equal(deployFailure.record(err).log, clean,
    'redaction must not damage a log that carries no secret');
});

// ── The underlying rule ────────────────────────────────────────────────

test('a secret-shaped assignment is masked whatever the vendor', () => {
  // The gap measured before this fix: the redactor knew specific vendor
  // prefixes, but a child app's secrets are named by whoever wrote its
  // dapp.json.
  for (const [name, value] of Object.entries(SECRETS)) {
    const out = log.redact(`starting with ${name}=${value} set`);
    assert.doesNotMatch(out, new RegExp(value), `${name} value survived`);
    assert.match(out, new RegExp(`${name}=`),
      `${name} itself should survive — knowing WHICH variable is the diagnosis`);
  }
});

test('the URI rule still wins over the generic one, keeping a URL diagnosable', () => {
  const out = log.redact(`DATABASE_URL=postgres://approle:${DB_PASSWORD}@db:5432/app_x`);
  assert.doesNotMatch(out, new RegExp(DB_PASSWORD));
  // Scheme, role, host, port and database name are what make the line
  // diagnosable; #30's comment is explicit that a flat mask throws them away.
  assert.match(out, /postgres:\/\/approle:\*+@db:5432\/app_x/);
});

test('ordinary assignments are left alone', () => {
  for (const line of [
    'NODE_ENV=production',
    'PORT=3000',
    'USERNODE_ENV=staging',
    'npm ERR! code=E401',
    'exit status=1',
  ]) {
    assert.equal(log.redact(line), line, `${line} must not be redacted`);
  }
});

// ── The wiring ─────────────────────────────────────────────────────────

test('deploy-failure redacts at capture time, not on read', () => {
  const src = read('src/services/deploy-failure.js');
  assert.match(src, /require\('\.\/log-redaction'\)/,
    'the redactor already exists (#30) — reuse it rather than writing a second');
  assert.match(src, /redactString\(/,
    'classify/record must redact before the record reaches the database');
  // It must NOT come through the logger facade: dozens of suites stub that
  // module with a bare {info,warn,error,debug}, which would silently delete
  // the redactor and put the secrets straight back.
  assert.doesNotMatch(src, /log\.redactString/,
    'reach the rules directly, not through a module that tests stub away');
});

// ── The residual gap Codex found, and how it is closed ─────────────────
//
// The pattern list infers a secret from its SHAPE, and that inference has a
// floor: `app-secrets.normalizeValue()` only TRIMS, so a secret may legally
// contain interior whitespace, and on an execFile argv
// `-e ADMIN_TOKEN=alpha beta gamma` is indistinguishable from three separate
// arguments. No regex can know where the value ends.
//
// services/docker.js HOLDS the values, so it masks the literals before the
// error can propagate — and then there is nothing to infer.

test('a quoted secret value is consumed whole', () => {
  const out = log.redact('MY_APP_SECRET="alpha beta gamma" NEXT=1');
  assert.doesNotMatch(out, /alpha|beta|gamma/);
  assert.match(out, /NEXT=1/, 'the next argument survives');
});

test('a name that IS the secret word is covered, not just a prefixed one', () => {
  for (const name of ['TOKEN', 'SECRET', 'PASSWORD', 'KEY']) {
    const out = log.redact(`${name}=abcdef123456`);
    assert.doesNotMatch(out, /abcdef123456/, `bare ${name} was not masked`);
  }
});

test('redactValues masks a secret whatever shape it has', () => {
  const env = { ADMIN_TOKEN: 'alpha beta gamma', OTHER: 'plain-value-here' };
  const argv = 'docker run -e ADMIN_TOKEN=alpha beta gamma -e OTHER=plain-value-here img';
  const out = redactValues(argv, Object.values(env));
  assert.doesNotMatch(out, /alpha|beta|gamma/, 'interior whitespace is no obstacle');
  assert.doesNotMatch(out, /plain-value-here/);
  assert.match(out, /docker run/, 'the command itself survives');
});

test('redactValues skips values too short to be distinguishable', () => {
  const { MIN_LITERAL_LENGTH } = require('../src/services/log-redaction');
  const short = 'a'.repeat(MIN_LITERAL_LENGTH - 1);
  // Blanking every occurrence of a very short string would destroy the log.
  assert.equal(redactValues(`a build started ${short}`, [short]),
    `a build started ${short}`);
  const long = 'a'.repeat(MIN_LITERAL_LENGTH);
  assert.doesNotMatch(redactValues(`x ${long} y`, [long]), new RegExp(long));
});

test('redactValues masks the longest secret first', () => {
  // A secret that contains another must mask completely, not leave a tail.
  const out = redactValues('V=supersecretvalue', ['supersecretvalue', 'secretvalue']);
  assert.equal(out, 'V=****');
});

test('docker.js masks its own env out of a failed run', () => {
  const src = read('src/services/docker.js');
  assert.match(src, /function scrubEnvFromError/,
    'the argv carries every -e NAME=value, so the error must be scrubbed');
  // Both entry points, not just one.
  for (const fn of ['runContainer', 'runOneShot']) {
    assert.match(src, new RegExp(`async function ${fn}\\(name, opts = \\{\\}\\)`),
      `${fn} must go through the scrubbing wrapper`);
    assert.match(src, new RegExp(`${fn}Inner\\(name, opts\\)`),
      `${fn} must still call its original body`);
  }
  assert.match(src, /require\('\.\/log-redaction'\)/);
});

test('the logger still works and still fills its ring buffer', () => {
  // The redaction rules moved to their own module; the ring buffer is logger
  // STATE and had to stay behind. Moving it too made every log call throw
  // ReferenceError after printing once — caught in review, pinned here.
  assert.doesNotThrow(() => log.info('test', 'a line'), 'log calls must not throw');
  assert.ok(typeof log.tail === 'function', 'the /status dashboard reads tail()');
  const before = log.tail().length;
  log.warn('test', 'another line');
  assert.ok(log.tail().length > before, 'entries must still reach the ring buffer');
});

// Codex's third finding: the length floor on redactValues is necessary — a
// 3-character secret blanked everywhere would destroy the log — but it left
// a legitimate SHORT secret exposed when its variable name is not
// secret-shaped. An app secret is only required to be non-empty.
//
// redactEnvAssignments has no such tension, because the value AND its
// position are both known, so it carries no floor.
test('a known short secret with an innocuous name is still masked', () => {
  const env = { FOO: 'abc123', TINY: 'x1', ADMIN_TOKEN: 'alpha beta gamma' };
  const argv = 'docker run -e FOO=abc123 -e TINY=x1 -e ADMIN_TOKEN=alpha beta gamma img';
  const out = redactValues(redactEnvAssignments(argv, env), Object.values(env));
  for (const [name, value] of Object.entries(env)) {
    assert.doesNotMatch(out, new RegExp(`${name}=${value.split(' ')[0]}`),
      `${name} (${value.length} chars) survived`);
  }
  assert.match(out, /docker run/, 'the command survives');
  assert.match(out, /FOO=\*{4}/, 'the variable NAME survives — it is the diagnosis');
});

test('redactEnvAssignments carries no length floor at all', () => {
  assert.equal(redactEnvAssignments('A=b', { A: 'b' }), 'A=****');
  assert.equal(redactEnvAssignments('NOPE=x', { OTHER: 'x' }), 'NOPE=x',
    'only the named assignment, not every occurrence of the value');
  assert.equal(redactEnvAssignments('A=b', { A: '' }), 'A=b', 'an empty value is skipped');
});

test('scrubEnvFromError runs assignments before loose values', () => {
  const src = read('src/services/docker.js');
  assert.match(src, /redactValues\(redactEnvAssignments\(/,
    'the precise rule must be applied first');
});
