'use strict';

// An import's dapp.json decides; the create dialog's answers fill in only
// what it leaves out (src/services/import-manifest.js), and the check reads
// the file so the dialog can say which answers the repo replaces
// (GET /api/github/verify-access). The manifest reader keeps the top-level
// description, which every surface reads off the stored snapshot.
//
// Run with: node --test tests/import-manifest.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const github = require('../src/services/github');
const appManifest = require('../src/services/app-manifest');
const importManifest = require('../src/services/import-manifest');

test('the manifest reader keeps the description, tidied and bounded', () => {
  assert.equal(appManifest.readDescription({ description: '  Pick a book,\n read it  ' }), 'Pick a book, read it');
  assert.equal(appManifest.readDescription({ description: '   ' }), null);
  assert.equal(appManifest.readDescription({ description: 42 }), null);
  assert.equal(appManifest.readDescription({}), null);
  assert.equal(appManifest.readDescription({ description: 'x'.repeat(400) }).length, appManifest.MAX_DESCRIPTION_LENGTH);
  assert.equal(appManifest.read('/nonexistent-dir-for-test').description, null);
});

test('only what the repo leaves out is added, the description first', () => {
  const rule = { approverPolicy: 'invited', approvalsRequired: 2 };
  const both = importManifest.mergeCreateAnswers({ name: 'X', secrets: [] }, { description: ' A line ', governance: rule });
  assert.deepEqual(both.added, ['description', 'governance']);
  assert.deepEqual(Object.keys(both.manifest), ['description', 'name', 'secrets', 'governance']);
  assert.deepEqual(both.manifest.governance, { approvers: 'invited', approvals: { atLeast: 2 } });
  const theirs = importManifest.mergeCreateAnswers({ description: 'Theirs', governance: { approvers: 'anyone' } },
    { description: 'Mine', governance: rule });
  assert.deepEqual(theirs.added, [], 'the repo’s own answers stand');
  assert.equal(importManifest.mergeCreateAnswers({}, { governance: { approverPolicy: 'anyone', approvalsRequired: null } }).added.length, 0,
    'the default rule writes nothing');
  assert.deepEqual(importManifest.mergeCreateAnswers(null, { description: 'Mine' }).manifest, { description: 'Mine', secrets: [] },
    'a repo with no dapp.json gets one');
});

test('the commit reads the file, leaves one that does not parse alone, and pushes only a change', async (t) => {
  const saved = { isEnabled: github.isEnabled, getFileContent: github.getFileContent, pushFiles: github.pushFiles };
  t.after(() => Object.assign(github, saved));
  const pushed = [];
  github.isEnabled = () => true;
  github.pushFiles = async (owner, repo, files, opts) => { pushed.push({ owner, repo, files, opts }); };

  github.getFileContent = async () => JSON.stringify({ secrets: [] });
  const added = await importManifest.commitCreateAnswers({ repoUrl: 'https://github.com/ada/book-club', description: 'Pick a book' });
  assert.deepEqual(added, ['description']);
  assert.equal(pushed.length, 1);
  assert.deepEqual([pushed[0].owner, pushed[0].repo, pushed[0].files[0].path], ['ada', 'book-club', 'dapp.json']);
  assert.deepEqual(JSON.parse(pushed[0].files[0].content), { description: 'Pick a book', secrets: [] });
  assert.match(pushed[0].opts.message, /Add the description chosen when this project was imported to Homeroom/);

  github.getFileContent = async () => '{ not json';
  assert.deepEqual(await importManifest.commitCreateAnswers({ repoUrl: 'https://github.com/ada/x', description: 'Mine' }), []);
  github.getFileContent = async () => JSON.stringify({ description: 'Theirs' });
  assert.deepEqual(await importManifest.commitCreateAnswers({ repoUrl: 'https://github.com/ada/x', description: 'Mine' }), []);
  assert.equal(pushed.length, 1, 'nothing pushed when there is nothing to add');
});

test('the import check returns what the repo’s dapp.json says, and the creator commits before the clone', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  assert.match(route, /const manifest = await readImportManifest\(parsed\);/);
  assert.match(route, /manifest: invalid \? \{\} : manifest,\s*\n\s*\.\.\.\(invalid \? \{ manifestInvalid: true \} : \{\}\),\s*\n\s*warnings: await importManifest\.readRepoRuntimeWarnings\(parsed\),/);
  assert.match(route, /name: appManifest\.readName\(json\),\s*description: appManifest\.readDescription\(json\),\s*visibility: appManifest\.readVisibility\(json\),/);
  const creator = fs.readFileSync(path.join(__dirname, '../src/services/app-creator.js'), 'utf8');
  const commit = creator.indexOf("require('./import-manifest').commitCreateAnswers(");
  assert.ok(commit > 0 && commit < creator.indexOf('// 3. Clone (or write) the working tree'), 'before the clone reads the file');
});

test('the runtime warnings say what a package.json cannot do, and stay silent when it can', () => {
  const { packageRuntimeWarnings } = importManifest;
  // Next.js detected, no build script: nothing compiles it.
  assert.deepEqual(packageRuntimeWarnings({
    scripts: { dev: 'next dev', start: 'next start' },
    dependencies: { next: '^15.0.0', react: '^19.0.0' },
  }), ['This repo uses Next.js but has no "build" script, so nothing compiles it. Add "build": "next build" to its package.json.']);
  // Next.js detected, no start script.
  assert.deepEqual(packageRuntimeWarnings({
    scripts: { build: 'next build' },
    devDependencies: { next: '15.0.0' },
  }), ['Its package.json has no "start" script, so Homeroom can\'t start the app after it builds. Add a start script; for Next.js that is "start": "next start".']);
  // A plain repo without a start script: only the start warning, no Next.js line.
  assert.deepEqual(packageRuntimeWarnings({ scripts: { build: 'vite build' }, dependencies: { vite: '^5.0.0' } }), [
    'Its package.json has no "start" script, so Homeroom can\'t start the app after it builds. Add a start script; for Next.js that is "start": "next start".',
  ]);
  // Both scripts present: nothing to say, Next.js or not.
  assert.deepEqual(packageRuntimeWarnings({
    scripts: { build: 'next build', start: 'next start' },
    dependencies: { next: '^15.0.0' },
  }), []);
  assert.deepEqual(packageRuntimeWarnings({
    scripts: { build: 'vite build', start: 'node server.js' },
    dependencies: { vite: '^5.0.0' },
  }), []);
});

test('the runtime warnings come off the repo’s package.json, missing and unparseable included', async (t) => {
  const saved = { readFileForVerify: github.readFileForVerify };
  t.after(() => Object.assign(github, saved));
  const parsed = { owner: 'ada', repo: 'site' };

  github.readFileForVerify = async () => null;
  assert.deepEqual(await importManifest.readRepoRuntimeWarnings(parsed), [
    'The repo has no package.json, so Homeroom can\'t tell how to build and start it.',
  ]);

  github.readFileForVerify = async () => '{ not json';
  assert.deepEqual(await importManifest.readRepoRuntimeWarnings(parsed), [
    'The repo\'s package.json doesn\'t parse, so Homeroom can\'t tell how it builds or starts.',
  ]);

  github.readFileForVerify = async () => JSON.stringify({
    scripts: { build: 'next build', start: 'next start' },
    dependencies: { next: '^15.0.0' },
  });
  assert.deepEqual(await importManifest.readRepoRuntimeWarnings(parsed), []);

  // A read that fails after its retry yields no warning rather than a wrong one.
  github.readFileForVerify = async () => { throw new Error('GitHub is having trouble right now. Wait a moment and check again.'); };
  assert.deepEqual(await importManifest.readRepoRuntimeWarnings(parsed), []);
});
