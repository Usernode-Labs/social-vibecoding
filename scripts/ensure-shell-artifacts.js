#!/usr/bin/env node
// Materialize ignored shell artifacts for root tests and native local runs.
// Docker builds the same files in its lockfile-pinned shell/CSS stages and
// never calls this helper.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const FRONTEND_LOCK = path.join(FRONTEND, 'package-lock.json');
const DEPENDENCY_MARKER = path.join(FRONTEND, 'node_modules', '.usernode-shell-lock');

const {
  expectedStamp,
  readHtmlStamp,
  readJsStamp,
  readBuildMeta,
  normalizeBuildSha,
  HTML_OUTPUT,
  JS_OUTPUT,
} = require('./shell-stamp');

const htmlOnly = process.argv.includes('--html-only');
const runtime = process.argv.includes('--runtime');
const prebuilt = process.env.USERNODE_SHELL_ASSETS_PREBUILT === '1';

function read(pathname) {
  try {
    return fs.readFileSync(pathname, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function frontendLockDigest() {
  return crypto.createHash('sha256').update(fs.readFileSync(FRONTEND_LOCK)).digest('hex');
}

function frontendDependenciesAreCurrent(digest) {
  if (read(DEPENDENCY_MARKER)?.trim() !== digest) return false;
  try {
    require.resolve('vite/package.json', { paths: [FRONTEND] });
    require.resolve('react/package.json', { paths: [FRONTEND] });
    return true;
  } catch {
    return false;
  }
}

function installFrontendDependencies() {
  const digest = frontendLockDigest();
  if (frontendDependenciesAreCurrent(digest)) return;

  console.log('[ensure-shell] installing lockfile-pinned frontend dependencies');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--ignore-scripts', '--include=dev'], {
    cwd: FRONTEND,
    stdio: 'inherit',
  });
  fs.writeFileSync(DEPENDENCY_MARKER, `${digest}\n`);
}

function runNode(script) {
  execFileSync(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

const { stamp } = expectedStamp();
const htmlPath = path.join(ROOT, HTML_OUTPUT);
const jsPath = path.join(ROOT, JS_OUTPUT);
const html = read(htmlPath) || '';
// Fresh means sources unchanged AND generated for THIS build. A document
// carries the GIT_SHA it was built with — its <meta name="platform-build">,
// and since the build-scoped asset URLs every script src too — so one built
// under a different id (the tests' `dev` document under a GIT_SHA'd `npm
// start`, or the reverse) is stale here even though its stamp says the
// sources match.
const htmlFresh = readHtmlStamp(html) === stamp
  && readBuildMeta(html) === normalizeBuildSha(process.env.GIT_SHA);
const jsFresh = readJsStamp(read(jsPath) || '') === stamp;
const needsShell = !htmlFresh || (!htmlOnly && !jsFresh);

if (prebuilt) {
  const cssPath = path.join(ROOT, 'public', 'css', 'tailwind.css');
  if (needsShell || read(cssPath) === null) {
    throw new Error(
      '[ensure-shell] immutable image is missing build-time shell assets; rebuild the image'
    );
  }
  console.log('[ensure-shell] using immutable build-time shell assets');
  process.exit(0);
}

if (needsShell) {
  installFrontendDependencies();
  runNode('frontend/scripts/build-shell.mjs');

  const builtHtmlStamp = readHtmlStamp(read(htmlPath) || '');
  const builtJsStamp = readJsStamp(read(jsPath) || '');
  if (builtHtmlStamp !== stamp || builtJsStamp !== stamp) {
    throw new Error('[ensure-shell] shell build completed without the expected HTML/JS stamp');
  }
} else {
  console.log(`[ensure-shell] ${htmlOnly ? 'HTML is' : 'shell artifacts are'} current`);
}

// CSS also scans public/js/**, which is outside the shell stamp. Recompile on
// every runtime preflight so a locally changed legacy module cannot keep a
// stale utility set just because the React shell itself was unchanged.
if (runtime) {
  runNode('scripts/build-tailwind.js');
}
