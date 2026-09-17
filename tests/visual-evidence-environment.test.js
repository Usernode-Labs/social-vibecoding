'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const environment = require('../src/services/visual-evidence-environment');

test('evidence resource names are deterministic, side-specific, and bounded', () => {
  const runId = '0123456789abcdef0123456789abcdef';
  assert.equal(environment.runtimeName(runId, 'base', 'docker'), 'usernode-evidence-0123456789abcdef-base');
  assert.equal(environment.runtimeName(runId, 'head', 'kubernetes'), 'sv-evidence-0123456789abcdef-h');
  assert.ok(environment.runtimeName(runId, 'base', 'kubernetes').length <= 63);
  assert.notEqual(environment.runtimeName(runId, 'base'), environment.runtimeName(runId, 'head'));
  assert.throws(() => environment.runtimeName(runId, 'other'), /invalid/i);
});

test('evidence image tags key the exact revision and recipe', () => {
  const sha = 'a'.repeat(40);
  const tag = environment.dockerImageName({ id: 42 }, sha);
  assert.equal(tag, `usernode-evidence-42:${'a'.repeat(16)}-${environment.IMAGE_RECIPE}`);
  assert.throws(() => environment.dockerImageName({ id: 42 }, 'main'), /exact 40-character/);
});

test('only canonical HTTPS GitHub repositories are accepted', () => {
  assert.deepEqual(environment.repoParts('https://github.com/Usernode-Labs/example.git'), {
    owner: 'Usernode-Labs', repo: 'example',
  });
  assert.throws(() => environment.repoParts('git@github.com:owner/repo.git'), /HTTPS GitHub/);
  assert.throws(() => environment.repoParts('https://example.com/owner/repo'), /HTTPS GitHub/);
});

test('parallel cleanup waits for every sibling before surfacing a failure', async () => {
  const order = [];
  let release;
  const slow = new Promise((resolve) => { release = () => { order.push('slow'); resolve('ok'); }; });
  const pending = environment.allSettledValues([
    slow,
    Promise.reject(new Error('boom')),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  pending.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await assert.rejects(pending, /boom/);
  assert.deepEqual(order, ['slow']);
});
