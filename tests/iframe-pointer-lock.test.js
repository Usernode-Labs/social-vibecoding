// Source guards for pointer-lock permission delegation (#356).
//
// The shell hosts app content in exactly two iframes; both must delegate
// pointer-lock so embedded apps' requestPointerLock() isn't denied:
//   1. The production App-tab iframe (#app-iframe), built in
//      public/js/app-view.js renderAppTab(). It is sandboxed, so it needs
//      both the `allow-pointer-lock` sandbox token AND `pointer-lock`
//      merged into the existing `allow` value (without dropping
//      `clipboard-write`).
//   2. The staging / dev-session preview iframe (#staging-iframe) in
//      public/index.html. It is NOT sandboxed, so it only needs
//      `allow="pointer-lock"` — and must NOT gain a sandbox attribute.
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
  const src = read('public/js/app-view.js');
  assert.match(
    src,
    /sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock"/
  );
});

test('App-tab iframe allow merges pointer-lock with clipboard-write', () => {
  const src = read('public/js/app-view.js');
  assert.match(src, /allow="clipboard-write; pointer-lock"/);
});

test('staging preview iframe delegates pointer-lock', () => {
  const html = read('public/index.html');
  const line = html
    .split('\n')
    .find((l) => l.includes('id="staging-iframe"'));
  assert.ok(line, 'staging-iframe element should exist');
  assert.match(line, /allow="pointer-lock"/);
  // It is intentionally not sandboxed; adding a sandbox attribute would
  // restrict a frame that is currently unrestricted.
  assert.ok(!/\bsandbox=/.test(line), 'staging-iframe must not be sandboxed');
});
