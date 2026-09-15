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
// Both values moved behind the permission catalogue in #2219, but
// pointer-lock itself did not move: it is in the UNGATED base, delegated to
// every app frame with no grant required. See tests/app-permissions.test.js
// for the catalogue contract and tests/iframe-geolocation.test.js for the
// capability that DID become gated.
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

test('App-tab iframe allow merges pointer-lock with clipboard-write', () => {
  // #2219 turned the flat constant into `_allowAttribute(granted)`. Both
  // capabilities this test exists for are in the UNGATED base, so both still
  // reach every app; what left is `geolocation`, which is now a grant.
  const src = read('public/js/app-view.js');
  assert.match(src, /_appIframeUngated: \['clipboard-write', 'pointer-lock'\]/);
  assert.match(src, /allow="\$\{AppView\._allowAttribute\(\[\]\)\}"/);
});

test('staging preview iframe delegates pointer-lock', () => {
  const html = read('public/index.html');
  const line = html
    .split('\n')
    .find((l) => l.includes('id="staging-iframe"'));
  assert.ok(line, 'staging-iframe element should exist');
  // #2219: the ungated base. A staging preview shows a build the group has
  // not voted in yet, so it delegates no gated capability at all.
  assert.match(line, /allow="clipboard-write; pointer-lock"/);
  // It is intentionally not sandboxed; adding a sandbox attribute would
  // restrict a frame that is currently unrestricted.
  assert.ok(!/\bsandbox=/.test(line), 'staging-iframe must not be sandboxed');
});
