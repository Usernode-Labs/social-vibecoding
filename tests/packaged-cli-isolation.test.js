'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function invoke(environment) {
  return spawnSync(process.execPath, ['--test', '--test-force-exit',
    'tests/packaged-cli-entrypoints-integration.test.js'], {
    encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, RUN_ISOLATED_PACKAGED_CLI_TEST: '1', ...environment },
  });
}

test('direct packaged suite refuses a test flag without verified fixture destinations', () => {
  const result = invoke({});
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /KPACK_RECOVERY_TEST_CONFIG required; no ambient fallback/);
});

test('direct packaged suite rejects a supplied database URL without disposable ownership', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-cli-rejection-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'fixture.json');
  fs.writeFileSync(filename, JSON.stringify({ isolation: { version: 1, fixtureId: 'not-a-fixture' } }));
  const result = invoke({ KPACK_RECOVERY_TEST_CONFIG: filename,
    PREVIEW_FLOW_TEST_DATABASE_URL: 'postgresql://unused@production.invalid/usernode' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /fresh fixture UUID required/);
});

function retirementFixture(t, { recordedId = 'original', observedId = recordedId } = {}) {
  const { randomUUID } = require('node:crypto');
  const { LABEL } = require('./lib/isolated-kpack-fixture');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-retirement-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'packaged'));
  const fixtureId = randomUUID();
  const requestId = randomUUID();
  const createdAt = new Date().toISOString();
  const journal = {
    fixtureId, imageId: 'owned-image', requests: [{
      requestId, name: 'owned-process', id: recordedId, createdAt,
    }],
  };
  fs.writeFileSync(path.join(directory, 'packaged/resources.json'), JSON.stringify(journal));
  const commands = [];
  const docker = async args => {
    commands.push(args);
    if (args[0] === 'ps') return observedId;
    if (args[0] === 'inspect') return JSON.stringify([{
      Id: observedId, Name: '/owned-process', Image: journal.imageId, Created: createdAt,
      Config: { Labels: { [LABEL]: fixtureId, 'social.usernode.io/packaged-fixture-request': requestId } },
    }]);
    return '';
  };
  return { state: { directory, fixtureId }, docker, commands };
}

test('packaged retirement preserves a successor with a replaced container identity', async t => {
  const f = retirementFixture(t, { observedId: 'successor' });
  await assert.rejects(require('./lib/packaged-cli-fixture').retirePackagedResources(f.state, f.docker),
    /Do not delete a successor container/);
  assert.equal(f.commands.some(args => args[0] === 'rm'), false);
});

test('packaged retirement recovers creation acknowledgment loss from the persisted request identity', async t => {
  const f = retirementFixture(t, { recordedId: null, observedId: 'created-original' });
  await require('./lib/packaged-cli-fixture').retirePackagedResources(f.state, f.docker);
  assert.ok(f.commands.some(args => args[0] === 'rm' && args[2] === 'created-original'));
});
