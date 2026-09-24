// Source guards for pointer-lock delegation (#356).
//
// The shell hosts app content in three iframes, and an embedded app's
// requestPointerLock() must not be denied in any of them:
//   1. The production App-tab iframe (#app-iframe), built in
//      public/js/app-view.js renderAppTab() and the React app frame. It is
//      sandboxed, so it needs the `allow-pointer-lock` sandbox token.
//   2. The staging / dev-session preview iframe (#staging-iframe). It is NOT
//      sandboxed, which leaves pointer lock unrestricted, and it must NOT
//      gain a sandbox attribute.
//   3. The signed-out landing viewer (#app-viewer-frame), likewise
//      unsandboxed.
//
// QA 2026-09-24 Q35: `pointer-lock` USED to be written into each frame's
// `allow` as well. No browser recognises it as a Permissions Policy feature,
// so that delegated nothing, and Chrome logged "Unrecognized feature:
// 'pointer-lock'." on every page (the staging frame is in the shell
// document). It is still an UNGATED capability, so an app asking the shell
// about it is told "granted", but it no longer appears in any `allow`
// value. The sandbox token is the whole of the delegation, and that is what
// these now pin. See tests/app-permissions.test.js for the catalogue.
//
// These are plain string assertions on the source so a refactor can't
// silently drop the delegation.
//
// Run with: node --test tests/iframe-pointer-lock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('App-tab iframe sandbox carries allow-pointer-lock', () => {
  const policy = read('frontend/src/features/app-frame/app-frame-policy.js');
  const fallback = read('public/js/app-view.js');
  assert.match(
    policy,
    /allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock/
  );
  assert.match(fallback,
    /_appIframeSandbox: 'allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock'/,
    'the DOM-only fallback keeps the same app sandbox');
});

test('pointer-lock stays ungated, but the App-tab allow value leaves it out', () => {
  // #2219 turned the flat constant into `_allowAttribute(granted)`. Both
  // ungated capabilities still reach every app; pointer-lock does it through
  // the sandbox token above, so the adapter filters it out of `allow`.
  const src = read('public/js/app-view.js');
  assert.match(src, /_appIframeUngated: \['clipboard-write', 'pointer-lock'\]/);
  assert.match(src, /_appIframeSandboxDelegated: \['pointer-lock'\]/);
  assert.match(src, /\.filter\(\(c\) => !AppView\._appIframeSandboxDelegated\.includes\(c\)\)/);
  assert.match(src, /allow="\$\{AppView\._allowAttribute\(\[\]\)\}"/);
  const policy = read('frontend/src/features/app-frame/app-frame-policy.js');
  assert.match(policy, /export const SANDBOX_DELEGATED = \['pointer-lock'\];/);
  assert.match(policy, /export const BASE_ALLOW = ALLOW_BASE\.join\('; '\);/);
});

test('staging preview iframe stays unsandboxed and writes no pointer-lock policy', () => {
  const html = read('public/index.html');
  const line = html
    .split('\n')
    .find((l) => l.includes('id="staging-iframe"'));
  assert.ok(line, 'staging-iframe element should exist');
  // #2219: the ungated base. A staging preview shows a build the group has
  // not voted in yet, so it delegates no gated capability at all.
  assert.match(line, /allow="clipboard-write"/);
  // It is intentionally not sandboxed: that is what leaves pointer lock
  // available here, and adding a sandbox attribute would restrict a frame
  // that is currently unrestricted.
  assert.ok(!/\bsandbox=/.test(line), 'staging-iframe must not be sandboxed');
});

test('no shell frame writes the unrecognised pointer-lock policy token', () => {
  // The console warning this removed came from ANY frame carrying it.
  for (const rel of [
    'public/index.html',
    'frontend/src/features/auth/landing.tsx',
    'frontend/src/features/staging/staging-overlay.tsx',
  ]) {
    assert.doesNotMatch(read(rel), /allow="[^"]*pointer-lock/, `${rel} has no pointer-lock in an allow attribute`);
  }
});
