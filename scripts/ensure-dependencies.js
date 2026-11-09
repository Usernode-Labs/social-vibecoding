#!/usr/bin/env node
// The platform's staging/preview runner starts the app from a fresh checkout of
// the committed tree. `node_modules` is gitignored — and deliberately excluded
// from the kpack source — so a runner that does not install dependencies of its
// own starts `server.js` with an empty tree and dies on the first
// `require('express')`, before a single route exists.
//
// This step runs before that: when the production dependency tree is absent it
// installs the lockfile's exact tree, and when it is present (every image build
// bakes one in) it does nothing. Only production dependencies are checked on
// purpose: a runtime image installs with `--omit=dev`, so a missing devDependency
// is not a reason to reinstall anything, and an offline production boot must
// never be tempted into a network call it does not need.
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function dependenciesAreInstalled() {
  try {
    require.resolve('express/package.json', { paths: [ROOT] });
    return true;
  } catch {
    return false;
  }
}

if (dependenciesAreInstalled()) process.exit(0);

console.log('[ensure-dependencies] no node_modules in this checkout — running npm ci');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' });
if (result.error) {
  console.error('[ensure-dependencies] could not run npm ci:', result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[ensure-dependencies] npm ci exited with ${result.status}`);
  process.exit(result.status || 1);
}
if (!dependenciesAreInstalled()) {
  console.error('[ensure-dependencies] npm ci finished but express is still missing');
  process.exit(1);
}
