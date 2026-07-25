// #767: pins the "Graceful shutdown" section of the app conventions.
//
// Text-pinning, the same stance tests/caddy-deploy-grace.test.js takes for
// the Caddyfile: src/prompts/app-conventions.md is not code, but it IS the
// only lever on what every future app's server.js looks like — it's read
// once by services/prompts.js and injected into both the Mayor and Claude
// Code system prompts. A silent deletion or rewrite of this section means
// every app generated afterwards has no shutdown handler again, with no
// symptom other than deploys quietly getting slower and apps being
// force-killed mid-request. Cheap guard, expensive regression.
//
// Run with: node --test tests/app-conventions-shutdown.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const conventions = fs.readFileSync(
  path.join(root, 'src', 'prompts', 'app-conventions.md'), 'utf8'
);

// Slice out just the section so the assertions can't be satisfied by an
// incidental mention somewhere else in a 1600-line document.
function section(src, heading) {
  const start = src.indexOf(`\n## ${heading}\n`);
  assert.notStrictEqual(start, -1, `missing "## ${heading}" section`);
  const next = src.indexOf('\n## ', start + heading.length + 5);
  return src.slice(start, next === -1 ? src.length : next);
}

test('the conventions carry a Graceful shutdown section', () => {
  assert.match(conventions, /\n## Graceful shutdown\n/,
    'app-conventions.md must document the shutdown contract');
});

test('the section prescribes both signals', () => {
  const s = section(conventions, 'Graceful shutdown');
  assert.match(s, /SIGTERM/, 'docker stop sends SIGTERM — the handler must name it');
  assert.match(s, /SIGINT/, 'local dev sends SIGINT; both must be handled');
  assert.match(s, /process\.on\(['"]SIGTERM['"]/);
  assert.match(s, /process\.on\(['"]SIGINT['"]/);
});

test('the section prescribes stop-accepting, drain, close-pool, exit', () => {
  const s = section(conventions, 'Graceful shutdown');
  assert.match(s, /server\.close\(/, 'must stop accepting new connections');
  assert.match(s, /closeIdleConnections/, 'idle keep-alives should be dropped immediately');
  assert.match(s, /pool\.end\(/, 'must close the Postgres pool before exiting');
  assert.match(s, /process\.exit\(/);
});

test('the drain deadline is a literal constant, not an env var', () => {
  // The platform sets no drain env var. An app reading one gets undefined
  // and either never drains or never exits.
  const s = section(conventions, 'Graceful shutdown');
  assert.match(s, /DRAIN_MS\s*=\s*\d+/, 'the deadline must be shown as a literal');
  assert.match(s, /literal constant/i,
    'the section must say explicitly that the deadline is not an env var');
});

test('the section covers idempotency and capturing the listener', () => {
  const s = section(conventions, 'Graceful shutdown');
  assert.match(s, /idempotent/i,
    'a repeat signal during the drain must be a no-op, not a second teardown');
  assert.match(s, /app\.listen/,
    'the handler needs the listener handle — discarding it is the common mistake');
});

test('the section tells pre-existing apps how to adopt it', () => {
  // Apps generated before this convention are never retro-updated (their
  // server.js is vendored), so the doc has to carry the adopt-later note —
  // the same pattern the chromeless-deep-link convention uses.
  const s = section(conventions, 'Graceful shutdown');
  assert.match(s, /before this convention/i);
  assert.match(s, /next time you edit/i);
});

test('the section warns about shell-form CMD swallowing the signal', () => {
  const s = section(conventions, 'Graceful shutdown');
  assert.match(s, /CMD \["node"/, 'exec-form CMD must be shown');
  assert.match(s, /exec-form/i);
});

test('the section sits with the other server-shape conventions', () => {
  // Placed right after Database (it closes the pool) and before the
  // staging/production section, so an agent reading top-to-bottom hits it
  // while it still has the pg.Pool in mind.
  const dbAt = conventions.indexOf('\n## Database\n');
  const shutdownAt = conventions.indexOf('\n## Graceful shutdown\n');
  const stagingAt = conventions.indexOf('\n## Staging vs production');
  assert.ok(dbAt !== -1 && shutdownAt !== -1 && stagingAt !== -1);
  assert.ok(dbAt < shutdownAt && shutdownAt < stagingAt,
    'Graceful shutdown belongs between Database and Staging vs production');
});
