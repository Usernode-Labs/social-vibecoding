'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCompiledCodeCache } = require('./lib/compiled-code-cache');

// These fixtures have random names. What render-tsx shares with other test
// processes (lib/shared-bundle-cache.js) goes to a directory of this suite's
// own, set before the helper reads it, so a run leaves no entries behind in
// node_modules/.cache.
const SHARED_BUNDLES = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-test-shared-'));
process.env.TEST_BUNDLE_CACHE_DIR = SHARED_BUNDLES;
test.after(() => fs.rmSync(SHARED_BUNDLES, { recursive: true, force: true }));

const { loadTsx, transpileTs, ROOT } = require('./lib/render-tsx');

function fixture(t, insideRepo = false) {
  const dir = fs.mkdtempSync(path.join(insideRepo ? __dirname : os.tmpdir(), '.compile-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('identical artifacts build once; a source edit, deletion and recreation invalidate them', (t) => {
  const file = path.join(fixture(t), 'source.ts');
  fs.writeFileSync(file, 'first');
  let calls = 0;
  const cache = createCompiledCodeCache();
  const build = () => ({ value: ++calls, bytes: 1, inputs: [file] });
  assert.equal(cache('entry', build), 1);
  assert.equal(cache('entry', build), 1);
  fs.writeFileSync(file, 'second version');
  assert.equal(cache('entry', build), 2);
  fs.unlinkSync(file);
  assert.equal(cache('entry', build), 3);
  assert.equal(cache('entry', build), 3);
  fs.writeFileSync(file, 'again');
  assert.equal(cache('entry', build), 4);
});

test('failed builds are retried, and the uncached path always builds', () => {
  const cache = createCompiledCodeCache();
  assert.throws(() => cache('entry', () => { throw new Error('bad source'); }), /bad source/);
  let calls = 0;
  const build = () => ({ value: ++calls, bytes: 1, inputs: [] });
  assert.equal(cache('entry', build), 1);
  assert.equal(cache('entry', build, { cache: false }), 2);
  assert.equal(cache('entry', build, { cache: false }), 3);
});

test('least recently used artifacts are evicted by count and bytes; oversized entries are not retained', () => {
  for (const limits of [{ maxEntries: 2 }, { maxBytes: 2 }]) {
    const cache = createCompiledCodeCache(limits);
    let calls = 0;
    const build = () => ({ value: ++calls, bytes: 1, inputs: [] });
    assert.equal(cache('a', build), 1);
    assert.equal(cache('b', build), 2);
    assert.equal(cache('a', build), 1);
    assert.equal(cache('c', build), 3);
    assert.equal(cache('b', build), 4);
  }
  const cache = createCompiledCodeCache({ maxBytes: 1 });
  let calls = 0;
  const big = () => ({ value: ++calls, bytes: 2, inputs: [] });
  assert.equal(cache('big', big), 1);
  assert.equal(cache('big', big), 2);
});

test('cached TSX compilation still evaluates fresh modules and top-level effects with current mocks', (t) => {
  const dir = fixture(t, true);
  const entry = path.relative(ROOT, path.join(dir, 'entry.ts'));
  fs.writeFileSync(path.join(dir, 'entry.ts'), `
    import { value } from 'test-mock';
    export const state = { count: 0 };
    export const captured = value;
    export const initialization = ++globalThis.__compileCacheInitializations;
  `);
  globalThis.__compileCacheInitializations = 0;
  t.after(() => { delete globalThis.__compileCacheInitializations; });
  const first = loadTsx(entry, { stubs: { 'test-mock': { value: 'first' } } });
  first.state.count = 123;
  const second = loadTsx(entry, { stubs: { 'test-mock': { value: 'second' } } });
  assert.equal(first.captured, 'first');
  assert.equal(second.captured, 'second');
  assert.equal(second.state.count, 0);
  assert.notEqual(first.state, second.state);
  assert.equal(first.initialization, 1);
  assert.equal(second.initialization, 2);
});

test('different external sets compile separately and bundled dependencies invalidate cached code', (t) => {
  const dir = fixture(t, true);
  const entry = path.relative(ROOT, path.join(dir, 'entry.ts'));
  fs.writeFileSync(path.join(dir, 'entry.ts'), "export { value } from './dependency';");
  fs.writeFileSync(path.join(dir, 'dependency.ts'), "export const value = 'real';");
  assert.equal(loadTsx(entry).value, 'real');
  assert.equal(loadTsx(entry, { stubs: { './dependency': { value: 'mock' } } }).value, 'mock');
  assert.equal(loadTsx(entry).value, 'real');
  fs.writeFileSync(path.join(dir, 'dependency.ts'), "export const value = 'changed';");
  assert.equal(loadTsx(entry).value, 'changed');
  fs.unlinkSync(path.join(dir, 'dependency.ts'));
  assert.throws(() => loadTsx(entry), /Could not resolve/);
  fs.writeFileSync(path.join(dir, 'dependency.ts'), "export const value = 'restored';");
  assert.equal(loadTsx(entry).value, 'restored');
});

test('adding a higher priority resolution candidate invalidates a cached bundle', (t) => {
  const dir = fixture(t, true);
  const entry = path.relative(ROOT, path.join(dir, 'entry.ts'));
  fs.writeFileSync(path.join(dir, 'entry.ts'), "export { value } from './dependency';");
  fs.mkdirSync(path.join(dir, 'dependency'));
  fs.writeFileSync(path.join(dir, 'dependency/index.ts'), "export const value = 'index';");
  assert.equal(loadTsx(entry).value, 'index');
  fs.writeFileSync(path.join(dir, 'dependency.ts'), "export const value = 'file';");
  assert.equal(loadTsx(entry).value, 'file');
});

test('changing an input tsconfig invalidates a cached bundle', (t) => {
  const dir = fixture(t, true);
  const entry = path.relative(ROOT, path.join(dir, 'entry.ts'));
  fs.writeFileSync(path.join(dir, 'entry.ts'), "export { value } from 'choice';");
  fs.writeFileSync(path.join(dir, 'one.ts'), "export const value = 'one';");
  fs.writeFileSync(path.join(dir, 'two.ts'), "export const value = 'two';");
  const config = (file) => JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { choice: [file] } } });
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), config('./one.ts'));
  assert.equal(loadTsx(entry).value, 'one');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), config('./two.ts'));
  assert.equal(loadTsx(entry).value, 'two');
});

test('transform reuse follows source content and does not hide a syntax failure', (t) => {
  const dir = fixture(t, true);
  const file = path.join(dir, 'entry.ts');
  const entry = path.relative(ROOT, file);
  fs.writeFileSync(file, 'export const value: number = 1;');
  const first = transpileTs(entry);
  assert.equal(transpileTs(entry), first);
  fs.writeFileSync(file, 'export const value: number = 2;');
  assert.notEqual(transpileTs(entry), first);
  fs.writeFileSync(file, 'export const = ;');
  assert.throws(() => transpileTs(entry));
});
