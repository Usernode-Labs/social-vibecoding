'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_CAPTURE_BYTES,
  classify,
  parseArgs,
  repositoryRootsForRedaction,
  runProcess,
  sanitizeOutput,
  usage,
  writeArtifact,
} = require('../scripts/readiness-evidence');

test('parseArgs accepts bounded explicit options', () => {
  assert.deepEqual(parseArgs([
    '--target', 'release/candidate-1',
    '--timeout-ms', '5000',
    '--output', 'artifacts/report.json',
  ]), {
    target: 'release/candidate-1',
    timeoutMs: 5000,
    output: 'artifacts/report.json',
    help: false,
  });
});

test('parseArgs rejects arbitrary, duplicate, and unbounded options', () => {
  assert.throws(() => parseArgs(['--command', 'curl example.test']), /Unknown option/);
  assert.throws(() => parseArgs(['--target', 'one', '--target', 'two']), /Duplicate option/);
  assert.throws(() => parseArgs(['--timeout-ms', '99999999']), /must be between/);
  assert.throws(() => parseArgs(['--target', '../unsafe label']), /--target must be/);
});

test('sanitizeOutput redacts common secrets and repository paths', () => {
  const value = [
    '/work/repository/tests/a.test.js',
    'API_TOKEN=top-secret',
    'Authorization: Bearer abc.def.ghi',
    'https://alice:password@example.test/path',
    'ghp_1234567890abcdefghij',
  ].join('\n');
  const sanitized = sanitizeOutput(value, '/work/repository');
  assert.match(sanitized, /<repo>\/tests\/a\.test\.js/);
  assert.match(sanitized, /API_TOKEN=\[REDACTED\]/);
  assert.match(sanitized, /Bearer \[REDACTED\]/);
  assert.match(sanitized, /https:\/\/\[REDACTED\]@example\.test/);
  assert.doesNotMatch(sanitized, /top-secret|password|1234567890abcdefghij/);
});

test('repositoryRootsForRedaction includes symlinked dependency parents', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-roots-test-'));
  const repository = path.join(directory, 'checkout');
  const shared = path.join(directory, 'shared');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(repository);
  fs.mkdirSync(path.join(shared, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(shared, 'node_modules'), path.join(repository, 'node_modules'));
  assert.deepEqual(repositoryRootsForRedaction(repository), [repository, shared]);
});

test('classify never reports failures, errors, or timeouts as passed', () => {
  assert.equal(classify({ timedOut: false, error: null, exitCode: 0 }), 'passed');
  assert.equal(classify({ timedOut: false, error: null, exitCode: 2 }), 'failed');
  assert.equal(classify({ timedOut: false, error: 'spawn failed', exitCode: null }), 'error');
  assert.equal(classify({ timedOut: true, error: null, exitCode: null }), 'timed_out');
});

test('runProcess terminates and classifies a hung child at the timeout', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: __dirname,
    timeoutMs: 50,
  });
  assert.equal(result.timedOut, true);
  assert.equal(classify(result), 'timed_out');
  assert.notEqual(result.signal, null);
});

test('runProcess captures only the bounded output tail', async () => {
  const result = await runProcess(process.execPath, [
    '-e',
    `process.stdout.write('x'.repeat(${MAX_CAPTURE_BYTES + 100})); process.stderr.write('tail')`,
  ], {
    cwd: __dirname,
    timeoutMs: 1000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputTruncated, true);
  assert.equal(Buffer.byteLength(result.output), MAX_CAPTURE_BYTES);
  assert.match(result.output, /tail$/);
});

test('writeArtifact creates private JSON and refuses to overwrite it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-evidence-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'report.json');
  writeArtifact(destination, { schemaVersion: 1, result: 'passed' });
  const mode = fs.statSync(destination).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), {
    schemaVersion: 1,
    result: 'passed',
  });
  assert.throws(() => writeArtifact(destination, { result: 'failed' }), /Refusing to overwrite/);
});

test('help is parsed without accepting a command', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.match(usage(), /repository-only npm test contract once/);
});
