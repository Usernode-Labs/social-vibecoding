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
  assert.match(route, /manifest: read\.manifest,/);
  assert.match(route, /importManifest\.readRepoShape\(parsed\.owner, parsed\.repo\)/);
  assert.match(route, /importManifest\.repoWarnings\(\{ \.\.\.shape, manifestInvalid: read\.invalid \}\)/);
  assert.match(route, /name: appManifest\.readName\(json\),\s*description: appManifest\.readDescription\(json\),\s*visibility: appManifest\.readVisibility\(json\),/);
  const creator = fs.readFileSync(path.join(__dirname, '../src/services/app-creator.js'), 'utf8');
  const commit = creator.indexOf("require('./import-manifest').commitCreateAnswers(");
  assert.ok(commit > 0 && commit < creator.indexOf('// 3. Clone (or write) the working tree'), 'before the clone reads the file');
});

// ── The shape and Next.js warnings (repoWarnings) ──────────────────────

// A Next.js repo with a build and a start script on the default port: the
// shape everything else is measured against.
const HEALTHY_NEXT = {
  files: ['package.json'],
  packageText: JSON.stringify({
    dependencies: { next: '15.0.0', react: '19.0.0' },
    scripts: { build: 'next build', start: 'next start' },
  }),
};

const codes = (out) => out.warnings.map((w) => w.code);

test('a Next.js app that builds and starts on 3000 warns of nothing', () => {
  const out = importManifest.repoWarnings(HEALTHY_NEXT);
  assert.equal(out.framework, 'nextjs');
  assert.deepEqual(out.warnings, []);
});

test('a Next.js app without a build script is told what to add', () => {
  const out = importManifest.repoWarnings({
    ...HEALTHY_NEXT,
    packageText: JSON.stringify({
      dependencies: { next: '15.0.0' },
      scripts: { start: 'next start' },
    }),
  });
  assert.deepEqual(codes(out), ['next_no_build']);
  assert.match(out.warnings[0].message, /Add "build": "next build" to its package\.json scripts\./);
});

test('a Next.js app without a start script is told what to add, and next in devDependencies counts', () => {
  const out = importManifest.repoWarnings({
    ...HEALTHY_NEXT,
    packageText: JSON.stringify({
      devDependencies: { next: '15.0.0' },
      scripts: { build: 'next build' },
    }),
  });
  assert.equal(out.framework, 'nextjs');
  assert.deepEqual(codes(out), ['next_no_start']);
  assert.match(out.warnings[0].message, /Add "start": "next start" to its package\.json scripts\./);
});

test('a start script running the dev server is named', () => {
  const out = importManifest.repoWarnings({
    ...HEALTHY_NEXT,
    packageText: JSON.stringify({
      dependencies: { next: '15.0.0' },
      scripts: { build: 'next build', start: 'next dev' },
    }),
  });
  assert.deepEqual(codes(out), ['next_dev_start']);
  assert.match(out.warnings[0].message, /Change it to "next start"\./);
});

test('a start script pinned to another port is named; port 3000 is left alone', () => {
  const out = importManifest.repoWarnings({
    ...HEALTHY_NEXT,
    packageText: JSON.stringify({
      dependencies: { next: '15.0.0' },
      scripts: { build: 'next build', start: 'next start -p 8080' },
    }),
  });
  assert.deepEqual(codes(out), ['wrong_port']);
  assert.match(out.warnings[0].message, /uses port 8080/);
  assert.match(out.warnings[0].message, /port 3000/);

  const on3000 = importManifest.repoWarnings({
    ...HEALTHY_NEXT,
    packageText: JSON.stringify({
      dependencies: { next: '15.0.0' },
      scripts: { build: 'next build', start: 'next start -p 3000' },
    }),
  });
  assert.deepEqual(on3000.warnings, []);
});

test('a plain Node app with no start script and no server file is told what to add; a server file answers', () => {
  const out = importManifest.repoWarnings({
    files: ['package.json'],
    packageText: JSON.stringify({ scripts: {} }),
  });
  assert.equal(out.framework, null);
  assert.deepEqual(codes(out), ['no_start']);
  assert.match(out.warnings[0].message, /starts the server on port 3000/);

  const withServer = importManifest.repoWarnings({
    files: ['package.json', 'server.js'],
    packageText: JSON.stringify({ scripts: {} }),
  });
  assert.deepEqual(withServer.warnings, []);
});

test('no package.json and no Dockerfile at the root says so; a truncated tree does not guess', () => {
  const out = importManifest.repoWarnings({ files: ['README.md', 'src/index.js'], packageText: null });
  assert.deepEqual(codes(out), ['no_package']);
  assert.match(out.warnings[0].message, /no package\.json or Dockerfile/);

  const truncated = importManifest.repoWarnings({ files: ['README.md'], packageText: null, truncated: true });
  assert.deepEqual(truncated.warnings, []);
});

test('a root Dockerfile silences the package.json findings but the dapp.json finding stands', () => {
  const out = importManifest.repoWarnings({
    ...HEALTHY_NEXT,
    files: ['package.json', 'Dockerfile'],
    packageText: JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: {} }),
  });
  assert.equal(out.framework, 'nextjs');
  assert.deepEqual(out.warnings, []);

  const withManifest = importManifest.repoWarnings({
    files: ['package.json', 'Dockerfile'],
    packageText: JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: {} }),
    manifestInvalid: 'Unexpected token } in JSON',
  });
  assert.deepEqual(codes(withManifest), ['manifest_invalid']);
});

test('a package.json that does not parse is named, unless a Dockerfile decides instead', () => {
  const out = importManifest.repoWarnings({ files: ['package.json'], packageText: '{ not json' });
  assert.equal(out.framework, null);
  assert.deepEqual(codes(out), ['package_invalid']);

  const withDockerfile = importManifest.repoWarnings({
    files: ['package.json', 'Dockerfile.kubernetes'], packageText: '{ not json',
  });
  assert.deepEqual(withDockerfile.warnings, []);
});

test('an invalid dapp.json is the first warning, ahead of the package findings', () => {
  const out = importManifest.repoWarnings({
    ...HEALTHY_NEXT,
    packageText: JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: {} }),
    manifestInvalid: 'Unexpected token < in JSON',
  });
  assert.deepEqual(codes(out), ['manifest_invalid', 'next_no_build', 'next_no_start']);
});
