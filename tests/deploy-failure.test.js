// Unit tests for services/deploy-failure.js (#416): the shared
// build/deploy failure classifier behind apps.last_failure and the
// "View build log" panel. Pins the contracts the UI + persist paths
// rely on: stage detection from the error markers docker.js attaches
// (healthcheckFailed / buildFailed / cloneFailed), last-error-line
// extraction, ANSI stripping, and the 280-char / 16 kB caps. Also
// pins that visuals.summarizeBootFailure still returns the legacy
// string shape after its move here.
//
// Run with: node --test tests/deploy-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const deployFailure = require('../src/services/deploy-failure');

test('healthcheck failure picks the last error-ish container-log line', () => {
  const err = new Error('Healthcheck failed after 30 attempts: usernode-app-x');
  err.healthcheckFailed = true;
  err.containerStatus = 'exited (exit=1)';
  err.containerLogs = [
    '> start',
    '> node server.js',
    "Error: Cannot find module './lib/dapp-server'",
    'Require stack:',
    '- /app/server.js',
  ].join('\n');

  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'healthcheck');
  // Last matching error line wins, with the container status prefixed —
  // same shape the staging checks pipeline stores in check_error_detail.
  assert.equal(out.reason, "[exited (exit=1)] Error: Cannot find module './lib/dapp-server'");
  assert.ok(out.log.includes("Cannot find module './lib/dapp-server'"));
});

test('build failure extracts the stderr tail and prefixes "Build failed:"', () => {
  const err = new Error('Command failed: docker build …');
  err.buildFailed = true;
  err.buildLog = [
    'Step 1/4 : FROM node:20-alpine',
    'Sending build context…',
    'ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory',
  ].join('\n');

  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'build');
  assert.ok(out.reason.startsWith('Build failed:'));
  assert.ok(out.reason.includes('failed to read dockerfile'));
  assert.ok(out.log.includes('Step 1/4'));
});

test('build timeout (err.killed) synthesizes the timeout reason', () => {
  const err = new Error('Command failed');
  err.buildFailed = true;
  err.killed = true;
  err.buildLog = 'Step 3/9 : RUN npm ci';
  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'build');
  assert.equal(out.reason, 'Build timed out after 5 minutes');
});

test('cloneFailed marker maps to the clone stage with err.message fallback', () => {
  const err = new Error("fatal: repository 'https://github.com/x/y.git' not found");
  err.cloneFailed = true;
  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'clone');
  assert.ok(out.reason.includes('not found'));
});

test('unmarked errors classify as other, no .stderr needed (timeout/ENOENT shape)', () => {
  const err = new Error('spawn git ENOENT');
  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'other');
  assert.equal(out.reason, 'spawn git ENOENT');
  assert.equal(out.log, '');
});

test('ANSI escapes are stripped and the log tail is capped at 16 kB', () => {
  const noisy = `\x1b[31mred error line\x1b[0m`;
  assert.equal(deployFailure.truncateLog(noisy), 'red error line');

  const huge = 'x'.repeat(20 * 1024) + '\nfinal line';
  const tail = deployFailure.truncateLog(huge);
  assert.ok(tail.length <= deployFailure.MAX_LOG);
  assert.ok(tail.endsWith('final line'));
});

test('reason is capped at 280 chars with an ellipsis', () => {
  const err = new Error('e'.repeat(500));
  const out = deployFailure.classify(err);
  assert.equal(out.reason.length, deployFailure.MAX_REASON);
  assert.ok(out.reason.endsWith('…'));
});

test('record() carries stage/reason/log plus timestamp and sha', () => {
  const err = new Error('boom');
  err.buildFailed = true;
  err.buildLog = 'ERROR: something failed';
  const rec = deployFailure.record(err, { sha: 'abc1234def' });
  assert.equal(rec.stage, 'build');
  assert.equal(rec.sha, 'abc1234def');
  assert.ok(!Number.isNaN(new Date(rec.at).getTime()));
});

test('syntheticRecord() shapes watchdog/kickoff failures', () => {
  const rec = deployFailure.syntheticRecord('timeout', 'App creation timed out after 5 minutes');
  assert.equal(rec.stage, 'timeout');
  assert.equal(rec.reason, 'App creation timed out after 5 minutes');
  assert.equal(rec.log, '');
  assert.equal(rec.sha, null);
});

test('summarizeBootFailure keeps the legacy string shape (containerStatus prefix, message fallback)', () => {
  // Via the shared module…
  const err = new Error('Healthcheck failed after 30 attempts: x');
  err.containerStatus = 'exited (exit=137)';
  err.containerLogs = 'JavaScript heap out of memory\ncannot allocate';
  const s = deployFailure.summarizeBootFailure(err);
  assert.equal(s, '[exited (exit=137)] cannot allocate');

  // …and no-logs errors fall back to err.message.
  const bare = deployFailure.summarizeBootFailure(new Error('plain failure'));
  assert.equal(bare, 'plain failure');
});
