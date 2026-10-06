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

// The images run src/workflow/**/*.ts as-is, which needs type stripping on by
// default: Node 22.18+ or 24+. Both floating majors are past that, so every
// Node stage must name one of them (a pinned older line would boot-fail).
test('every Node image stage can strip types', () => {
  const fs = require('node:fs');
  for (const file of ['Dockerfile', 'Dockerfile.kubernetes']) {
    const froms = fs.readFileSync(path.join(ROOT, file), 'utf8').match(/^FROM node:\S+/gm) || [];
    assert.ok(froms.length, `${file} has Node stages`);
    for (const from of froms) {
      const tag = from.slice('FROM node:'.length);
      const [major, minor] = tag.split(/[.-]/).map(Number);
      const ok = major >= 24 || (major === 22 && (Number.isNaN(minor) || minor >= 18));
      assert.ok(ok, `${file}: ${from} cannot run .ts without a build step`);
    }
  }
});
