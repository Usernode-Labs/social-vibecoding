'use strict';

// Compiled bundles shared between test processes: tests/lib/shared-bundle-cache.js
// and the way tests/lib/render-tsx.js uses it.
//
// The first half drives the cache directly. The second half runs render-tsx in
// real child processes, because "another process" is the thing under test: each
// child reports what it loaded and how many times it had to ask for esbuild.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createSharedBundleCache, contentStamp } = require('./lib/shared-bundle-cache');

const ROOT = path.join(__dirname, '..');

// A directory outside the repository: a cache, or sources no bundler reads.
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-bundle-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Sources for render-tsx to bundle: a writer and the repo-relative entry path.
//
// Inside the repository esbuild resolves the way it does for a real suite,
// and the bundle is built from the directories above the entry as well, up to
// the repository root. Those are shared ground: another suite running at the
// same moment may add a scratch directory to tests/, and that is rightly a
// change. So a test that needs a bundle to stay exactly as it was between two
// processes keeps its sources outside the repository, where the bundle is
// built from the entry alone.
function fixture(t, { insideRepo = false } = {}) {
  const dir = insideRepo ? fs.mkdtempSync(path.join(__dirname, '.shared-bundle-test-')) : scratch(t);
  if (insideRepo) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  return { write, entry: path.relative(ROOT, path.join(dir, 'entry.ts')) };
}

// One render-tsx load in a process of its own. `builds` counts how often the
// helper asked for esbuild, which it only does when it is about to build.
const CHILD = `
  const Module = require('node:module');
  const path = require('node:path');
  const esbuild = require.resolve('esbuild', { paths: [path.join(process.cwd(), 'frontend')] });
  let builds = 0;
  const load = Module._load;
  Module._load = function counted(request, ...rest) {
    if (request === esbuild) builds += 1;
    return load.call(this, request, ...rest);
  };
  const { loadTsx, transpileTs } = require('./tests/lib/render-tsx');
  const job = JSON.parse(process.env.JOB);
  const out = job.transpile ? { code: transpileTs(job.entry) } : { value: loadTsx(job.entry, job.options).value };
  process.stdout.write(JSON.stringify({ ...out, builds }));
`;

function inAnotherProcess(job, cacheDir, env = {}) {
  const childEnv = { ...process.env, TEST_BUNDLE_CACHE_DIR: cacheDir, ...env, JOB: JSON.stringify(job) };
  // The runner's own marker for its children; this one is not a test file.
  delete childEnv.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, ['-e', CHILD], { cwd: ROOT, env: childEnv, encoding: 'utf8' }));
}

test('a stored bundle is reused until the content it was built from changes', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'source.ts');
  fs.writeFileSync(file, 'one');
  let calls = 0;
  const build = () => ({ code: `build ${++calls}`, inputs: [file] });
  const shared = createSharedBundleCache({ dir: path.join(dir, 'cache') });
  assert.deepEqual(shared('entry', build), { code: 'build 1', inputs: [file] });
  // A second cache over the same directory stands in for another process.
  const other = createSharedBundleCache({ dir: path.join(dir, 'cache') });
  assert.deepEqual(other('entry', build), { code: 'build 1', inputs: [file] });

  // Different bytes behind the same size and the same timestamps.
  const { atime, mtime } = fs.statSync(file);
  fs.writeFileSync(file, 'two');
  fs.utimesSync(file, atime, mtime);
  assert.equal(other('entry', build).code, 'build 2');

  fs.unlinkSync(file);
  assert.equal(shared('entry', build).code, 'build 3');
  assert.equal(shared('entry', build).code, 'build 3', 'an input that stays absent is unchanged');
  fs.writeFileSync(file, 'two');
  assert.equal(shared('entry', build).code, 'build 4');

  assert.equal(shared('another entry', build).code, 'build 5');
  assert.equal(shared('entry', build).code, 'build 4', 'each key keeps its own bundle');
});

test('a new name in a watched directory, or a config file that appears, is a change', (t) => {
  const dir = scratch(t);
  const watched = path.join(dir, 'src');
  const config = path.join(dir, 'tsconfig.json');
  fs.mkdirSync(watched);
  fs.writeFileSync(path.join(watched, 'a.ts'), 'a');
  let calls = 0;
  const build = () => ({ code: `build ${++calls}`, inputs: [watched, config] });
  const shared = createSharedBundleCache({ dir: path.join(dir, 'cache') });
  assert.equal(shared('entry', build).code, 'build 1');
  assert.match(contentStamp(watched), /^dir:/);
  assert.equal(contentStamp(config), 'missing');

  // A directory is its names. Rewriting a file it already holds is that
  // file's change to report, not the directory's.
  fs.writeFileSync(path.join(watched, 'a.ts'), 'rewritten');
  assert.equal(shared('entry', build).code, 'build 1');
  fs.writeFileSync(path.join(watched, 'b.ts'), 'b');
  assert.equal(shared('entry', build).code, 'build 2');
  fs.writeFileSync(config, '{}');
  assert.equal(shared('entry', build).code, 'build 3');
  assert.match(contentStamp(config), /^file:/);
});

test('a damaged entry is rebuilt and replaced, and a build that throws stores nothing', (t) => {
  const cache = path.join(scratch(t), 'cache');
  let calls = 0;
  const build = () => ({ code: `build ${++calls}`, inputs: [] });
  const shared = createSharedBundleCache({ dir: cache });
  shared('entry', build);
  const stored = fs.readdirSync(cache);
  assert.equal(stored.length, 1, 'one entry, and no temporary file left beside it');
  assert.match(stored[0], /^[0-9a-f]{64}\.json$/);

  const damaged = [
    '',
    '{"format":1,"code":',
    JSON.stringify({ format: 0, code: 'another layout', inputs: [] }),
    JSON.stringify({ format: 1, code: 'x', inputs: [[7, 'missing']] }),
  ];
  for (const text of damaged) {
    fs.writeFileSync(path.join(cache, stored[0]), text);
    const next = `build ${calls + 1}`;
    assert.equal(shared('entry', build).code, next);
    assert.equal(shared('entry', build).code, next, 'the rebuilt entry replaced the damaged one');
  }

  assert.throws(() => shared('broken', () => { throw new Error('bad source'); }), /bad source/);
  assert.deepEqual(fs.readdirSync(cache), stored);
  const corrected = `build ${calls + 1}`;
  assert.equal(shared('broken', build).code, corrected, 'a corrected source builds on the next attempt');
});

test('switched off, or unable to store, it builds every time and still answers', (t) => {
  const dir = scratch(t);
  let calls = 0;
  const build = () => ({ code: `build ${++calls}`, inputs: [] });
  const off = createSharedBundleCache({ dir: path.join(dir, 'off'), enabled: false });
  assert.equal(off('entry', build).code, 'build 1');
  assert.equal(off('entry', build).code, 'build 2');
  assert.equal(fs.existsSync(path.join(dir, 'off')), false);

  // A file where the directory should be: nothing can be stored there.
  fs.writeFileSync(path.join(dir, 'blocked'), '');
  const blocked = createSharedBundleCache({ dir: path.join(dir, 'blocked') });
  assert.equal(blocked('entry', build).code, 'build 3');
  assert.equal(blocked('entry', build).code, 'build 4');
});

test('a second process reuses the first one\'s bundle without esbuild, as a fresh module with its own stubs', (t) => {
  const cache = scratch(t);
  const { write, entry } = fixture(t);
  write('entry.ts', "export { value } from 'test-mock';");
  const stubbed = (value) => ({ entry, options: { stubs: { 'test-mock': { value } } } });
  assert.deepEqual(inAnotherProcess(stubbed('first'), cache), { value: 'first', builds: 1 });
  assert.deepEqual(inAnotherProcess(stubbed('second'), cache), { value: 'second', builds: 0 });
});

test('the next process re-checks what a bundle was built from', (t) => {
  const cache = scratch(t);
  const { write, entry } = fixture(t, { insideRepo: true });
  write('entry.ts', "export { value } from './dependency';");
  write('dependency/index.ts', "export const value = 'index';");
  assert.deepEqual(inAnotherProcess({ entry }, cache), { value: 'index', builds: 1 });

  write('dependency/index.ts', "export const value = 'edited';");
  assert.deepEqual(inAnotherProcess({ entry }, cache), { value: 'edited', builds: 1 });

  // A candidate that resolves ahead of dependency/index.ts appears.
  write('dependency.ts', "export const value = 'file';");
  assert.deepEqual(inAnotherProcess({ entry }, cache), { value: 'file', builds: 1 });
});

test('a tsconfig that changes reaches the next process', (t) => {
  const cache = scratch(t);
  const { write, entry } = fixture(t, { insideRepo: true });
  const config = (file) => JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { choice: [file] } } });
  write('entry.ts', "export { value } from 'choice';");
  write('one.ts', "export const value = 'one';");
  write('two.ts', "export const value = 'two';");
  write('tsconfig.json', config('./one.ts'));
  assert.deepEqual(inAnotherProcess({ entry }, cache), { value: 'one', builds: 1 });
  write('tsconfig.json', config('./two.ts'));
  assert.deepEqual(inAnotherProcess({ entry }, cache), { value: 'two', builds: 1 });
});

test('`cache: false` and TEST_BUNDLE_CACHE=0 build every time and share nothing', (t) => {
  const cache = path.join(scratch(t), 'cache');
  const { write, entry } = fixture(t);
  write('entry.ts', "export const value = 'plain';");
  const uncached = { entry, options: { cache: false } };
  assert.deepEqual(inAnotherProcess(uncached, cache), { value: 'plain', builds: 1 });
  assert.deepEqual(inAnotherProcess({ entry }, cache, { TEST_BUNDLE_CACHE: '0' }), { value: 'plain', builds: 1 });
  assert.equal(fs.existsSync(cache), false, 'neither wrote a bundle');

  assert.deepEqual(inAnotherProcess({ entry }, cache), { value: 'plain', builds: 1 });
  assert.equal(fs.readdirSync(cache).length, 1);
  assert.deepEqual(inAnotherProcess(uncached, cache), { value: 'plain', builds: 1 }, 'nor reads one that is there');
  assert.deepEqual(inAnotherProcess({ entry }, cache, { TEST_BUNDLE_CACHE: '0' }), { value: 'plain', builds: 1 });
});

test('a transform is shared the same way and follows its source', (t) => {
  const cache = scratch(t);
  const { write, entry } = fixture(t);
  write('entry.ts', 'export const value: number = 1;');
  const first = inAnotherProcess({ entry, transpile: true }, cache);
  assert.equal(first.builds, 1);
  assert.match(first.code, /const value = 1;/);
  assert.deepEqual(inAnotherProcess({ entry, transpile: true }, cache), { code: first.code, builds: 0 });
  write('entry.ts', 'export const value: number = 2;');
  const edited = inAnotherProcess({ entry, transpile: true }, cache);
  assert.equal(edited.builds, 1);
  assert.match(edited.code, /const value = 2;/);
});
