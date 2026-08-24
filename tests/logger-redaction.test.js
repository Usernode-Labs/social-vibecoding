// #30's secret scrubber: every log line and every ring-buffer entry the
// /status dashboard serves goes through redactString first.
//
// The case that prompted this file: a staging boot failure logged its own
// DATABASE_URL, so a live database role's password sat in cleartext in the
// ring buffer, readable from the admin dashboard. The pattern list had
// rules for API-key *shapes* and for `password=` assignments, but a
// password embedded in a URI's authority section matches neither.
//
// The masking is deliberately partial — scheme, role, host, port and
// database name survive, because a redacted-to-nothing connection string
// makes the log line it appears in useless for diagnosis.
//
// Run with: node --test tests/logger-redaction.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const log = require('../src/services/logger');

test('a URI-embedded password is masked, its context is not', () => {
  const line = 'Staging heal failed for app 883: '
    + 'postgres://wq_owner:001e1edb9161a8ed5f7a9fce111fcb104db166aed1bb9ffa@usernode-postgres:5432/wq_db';
  const out = log.redactString(line);

  assert.ok(!out.includes('001e1edb9161a8ed5f7a9fce111fcb104db166aed1bb9ffa'),
    'the password must not survive into the ring buffer');
  assert.equal(
    out,
    'Staging heal failed for app 883: postgres://wq_owner:****@usernode-postgres:5432/wq_db'
  );
});

test('credential-free URLs are left alone', () => {
  // host:port looks superficially like user:password — it is not, and
  // mangling ordinary URLs would make logs harder to read for no gain.
  for (const url of [
    'postgres://usernode-postgres:5432/wq_db',
    'http://usernode:3000/api/app-llm',
    'https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js',
  ]) {
    assert.equal(log.redactString(`fetching ${url} now`), `fetching ${url} now`);
  }
});

test('other schemes and non-postgres URIs are covered too', () => {
  assert.equal(
    log.redactString('redis://default:hunter2@cache:6379/0'),
    'redis://default:****@cache:6379/0'
  );
  assert.equal(
    log.redactString('mongodb://svc:p@ssless@db'),   // first @ ends the match
    'mongodb://svc:****@ssless@db'
  );
});

test('the pre-existing patterns still fire', () => {
  const ghs = `ghs_${'a'.repeat(30)}`;
  assert.ok(!log.redactString(`token ${ghs} used`).includes(ghs));
  assert.ok(!log.redactString(`key sk-ant-abc123def456 used`).includes('sk-ant-abc123'));
  assert.ok(!log.redactString('key sk-or-v1-zzz999 used').includes('sk-or-v1-zzz999'));
  assert.equal(log.redactString('password: hunter2'), '****');

  // A credentialed git URL is scrubbed by the x-access-token rule before the
  // new URI rule ever sees it — the whole authority goes, token and all.
  const git = `https://x-access-token:${ghs}@github.com/usernodelabs/x.git`;
  const out = log.redactString(git);
  assert.ok(!out.includes(ghs));
  assert.ok(!out.includes('x-access-token'));
});

test('redactDeep applies the same rule inside nested objects', () => {
  const out = log.redactDeep({
    msg: 'boot failed',
    env: { DATABASE_URL: 'postgres://role:s3cr3t@host:5432/db' },
    args: ['-e', 'DATABASE_URL=postgres://role:s3cr3t@host:5432/db'],
  });
  assert.ok(!JSON.stringify(out).includes('s3cr3t'));
  assert.equal(out.env.DATABASE_URL, 'postgres://role:****@host:5432/db');
  assert.equal(out.args[1], 'DATABASE_URL=postgres://role:****@host:5432/db');
});
