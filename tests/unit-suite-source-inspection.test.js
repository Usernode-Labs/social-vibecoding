'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const github = require('../src/services/github');
const unitSuite = require('../src/services/unit-suite');

const revision = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const source = { repoOwner: 'fixture', repoName: 'app', ref: revision };

function installSource(t, {
  content = '{"scripts":{}}', absent = false, inaccessible = false,
  file404 = false, truncated = false, commitMismatch = false,
  response = null,
} = {}) {
  const calls = [];
  const bytes = Buffer.from(content);
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  const client = { rest: {
    git: {
      async getCommit(params) {
        calls.push('commit');
        assert.equal(params.commit_sha, revision);
        if (inaccessible) throw notFound();
        return { data: { sha: commitMismatch ? 'c'.repeat(40) : revision, tree: { sha: treeSha } } };
      },
      async getTree(params) {
        calls.push('tree');
        assert.equal(params.tree_sha, treeSha);
        assert.equal(params.recursive, undefined, 'A complete root tree needs no recursive scan');
        return { data: { sha: treeSha, truncated, tree: absent ? [] : [{
          path: 'package.json', type: 'blob', mode: '100644', sha: blobSha,
        }] } };
      },
    },
    repos: {
      async getContent(params) {
        calls.push('contents');
        assert.equal(params.path, 'package.json');
        assert.equal(params.ref, revision);
        if (inaccessible || absent || file404) throw notFound();
        return { data: response || {
          type: 'file', sha: blobSha, encoding: 'base64', content: bytes.toString('base64'),
        } };
      },
    },
  } };
  github._setOctokitFactoryForTests(() => client);
  t.after(() => github._setOctokitFactoryForTests(null));
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getCloneUrl', async () => assert.fail('Inspection must not start a unit runner'));
  return calls;
}

test('actual helper: an inaccessible-source 404 remains legacy null but cannot exempt enrolled units', async t => {
  const calls = installSource(t, { inaccessible: true });
  assert.equal(await github.getFileContent('fixture', 'app', 'package.json', revision), null);
  assert.equal(await unitSuite.maybeRunUnitSuite(source), null, 'Legacy unavailable source still skips');
  await assert.rejects(unitSuite.inspectRequirement(source), { status: 404 });
  assert.deepEqual(calls, ['contents', 'contents', 'commit']);
});

test('actual helper: a readable exact commit and complete root tree establish genuine file absence', async t => {
  const calls = installSource(t, { absent: true });
  assert.equal(await github.getFileContent('fixture', 'app', 'package.json', revision), null);
  assert.equal(await unitSuite.maybeRunUnitSuite(source), null);
  assert.deepEqual(await unitSuite.inspectRequirement(source), {
    version: 1, state: 'not-required', reason: 'package_absent',
  });
  assert.deepEqual(calls, ['contents', 'contents', 'commit', 'tree']);
});

test('actual helper: listed package with a contents 404 is unreadable, not absent', async t => {
  installSource(t, { file404: true });
  assert.equal(await github.getFileContent('fixture', 'app', 'package.json', revision), null);
  await assert.rejects(unitSuite.inspectRequirement(source), { status: 404 });
});

for (const content of ['{}', '{"scripts":{}}', '{"scripts":{"test":""}}',
  '{"scripts":{"test":"echo no test specified && exit 1"}}']) {
  test(`actual helper: verified package without a runnable test preserves exemption (${content})`, async t => {
    installSource(t, { content });
    assert.deepEqual(await unitSuite.inspectRequirement(source), {
      version: 1, state: 'not-required', reason: 'no_runnable_script',
    });
  });
}

test('actual helper: verified runnable script requires the companion at that exact revision', async t => {
  installSource(t, { content: '{"scripts":{"test":"node --test"}}' });
  assert.deepEqual(await unitSuite.inspectRequirement(source), {
    version: 1, state: 'submitted', source,
  });
});

for (const content of ['{invalid', 'null', '[]', '{"scripts":[]}', '{"scripts":{"test":7}}']) {
  test(`actual helper: malformed package metadata cannot exempt enrolled units (${content})`, async t => {
    installSource(t, { content });
    assert.equal(await unitSuite.maybeRunUnitSuite(source), null, 'Legacy malformed metadata remains best effort');
    await assert.rejects(unitSuite.inspectRequirement(source), { code: 'UNIT_SUITE_REQUIREMENT_UNAVAILABLE' });
  });
}

for (const scenario of [
  { truncated: true, absent: true },
  { commitMismatch: true },
  { response: [] },
  { response: { type: 'file', sha: 'c'.repeat(40), encoding: 'base64', content: '' } },
]) {
  test(`actual helper: unverified source cannot authorize an exemption (${JSON.stringify(scenario)})`, async t => {
    installSource(t, scenario);
    await assert.rejects(unitSuite.inspectRequirement(source), { code: 'GITHUB_SOURCE_UNVERIFIED' });
  });
}

test('actual helper: matching declared blob SHA with wrong bytes is rejected', async t => {
  const content = '{}';
  const blobSha = createHash('sha1').update('blob 2\0').update(content).digest('hex');
  installSource(t, { content, response: {
    type: 'file', sha: blobSha, encoding: 'base64', content: Buffer.from('different').toString('base64'),
  } });
  await assert.rejects(unitSuite.inspectRequirement(source), { code: 'GITHUB_SOURCE_UNVERIFIED' });
});
