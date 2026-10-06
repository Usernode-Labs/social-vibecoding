'use strict';

// The workflow foundation is plain TypeScript loaded through Node's type
// stripping (src/workflow/**/*.ts). Nothing compiles it, so this is where
// its types are checked: tsc --noEmit over tsconfig.server.json, which also
// holds the erasable-syntax rules that keep type stripping sufficient.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('src/workflow type-checks under tsconfig.server.json', () => {
  const tsc = require.resolve('typescript/bin/tsc');
  try {
    execFileSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.server.json')], { cwd: ROOT, stdio: 'pipe' });
  } catch (err) {
    assert.fail(`tsc reported errors:\n${err.stdout || ''}${err.stderr || ''}`);
  }
});

test('src/workflow modules are ESM loaded by type stripping, with erasable syntax only', () => {
  const config = require(path.join(ROOT, 'tsconfig.server.json'));
  const o = config.compilerOptions;
  assert.equal(o.noEmit, true, 'no generated .js twins');
  assert.equal(o.erasableSyntaxOnly, true);
  assert.equal(o.verbatimModuleSyntax, true);
  assert.equal(o.allowImportingTsExtensions, true);
  assert.equal(require(path.join(ROOT, 'src/workflow/package.json')).type, 'module');
  const kernel = require(path.join(ROOT, 'src/workflow/kernel/index.ts'));
  assert.equal(typeof kernel.createRuntime, 'function');
});
