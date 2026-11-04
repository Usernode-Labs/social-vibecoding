'use strict';

// #6149: a preview refused because another build of Homeroom made its data is
// the release window, not the change's fault, while a newer build serves, so
// its checks take the platform-fault retries; with no newer build the refusal
// stays immediate, as it is for every other policy refusal. The newer-build
// test is the one the newest-only clock jobs use (workflow/clock/services.ts
// newestBuild): the live non-web process that started serving last, by
// release. The same query is exercised against PostgreSQL in
// tests/preview-retirement-rollout-postgres.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/services/platform-preview-data-policy');

const release = (value) => ({
  async query(sql, params) {
    assert.match(sql, /FROM platform_processes/);
    assert.deepEqual(params, [45], 'the 45-second liveness the clock jobs use');
    return { rows: value === '' ? [] : [{ release: value }] };
  },
});
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

const ownRelease = async (sha, fn) => {
  const saved = process.env.GIT_SHA;
  try { process.env.GIT_SHA = sha; return await fn(); } finally {
    if (saved === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = saved;
  }
};

test('a newer build registered is a rollout; this build being newest is not', async () => {
  await ownRelease(OLD, async () => {
    assert.equal(await policy.newerBuildServing(release(NEW)), true, 'a different release is newer');
    assert.equal(await policy.newerBuildServing(release(OLD)), false, 'the newest is this build');
    assert.equal(await policy.newerBuildServing(release('')), false, 'no live process: no rollout');
  });
});

test('no process, or a roster that cannot be read, never invents a rollout', async () => {
  assert.equal(await policy.newerBuildServing(release('')), false);
  assert.equal(await policy.newerBuildServing({ async query() { throw new Error('relation does not exist'); } }), false,
    'the refusal is immediate rather than waiting on an unknown roster');
});

test('the refusal carries the skew marker only where another build made the data', () => {
  const skewed = policy.refuse('database was made by another policy', { policySkew: true });
  assert.equal(skewed.policySkew, true);
  assert.equal(skewed.noFallback, true, 'still an immediate refusal without a rollout');
  assert.equal(skewed.platformPreviewPolicy, true);
  const plain = policy.refuse('invalid preview user identity');
  assert.equal(plain.policySkew, undefined);
  assert.equal(plain.noFallback, true);
});

test('the rollout sentence is the plain one people see', () => {
  assert.equal(policy.ROLLOUT_DETAIL,
    'Homeroom was updating itself while this preview was copied; the checks will run again when it finishes');
});
