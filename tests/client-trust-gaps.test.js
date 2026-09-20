'use strict';

// #2514: three client-side trust asymmetries, each with its own fix.
//
// 1. THE DEV-CONSOLE LISTENER took any message carrying the right sentinel.
//    The sentinel is a routing tag, not a credential — an app frame can read
//    it and send it back — so any frame able to reach the shell could post a
//    forged console entry. The impact is log spoofing rather than injection
//    (index.tsx renders `args` as an escaped React text child), but a
//    developer reading a console they cannot trust is what the console is
//    for. It now applies the `e.source === iframe.contentWindow` gate every
//    other bridge handler already used.
//
// 2. THE STAGING PREVIEW's `setSrc` was a bare `el.src = src`, while the
//    production app frame has always checked `_isSafeAppIframeSrc`. The
//    staging URL carries the app-identity JWT as `?token=`, so a server-side
//    regression setting `staging_url` to the platform origin would have
//    framed the shell inside itself with that token in the address — in a
//    document that can also read the session cookie.
//
// 3. BRIDGE REPLIES went to `targetOrigin: '*'`. The REQUEST side is
//    source-gated so an app cannot forge one, but a reply broadcast to `'*'`
//    lands wherever the frame has navigated by the time it arrives. No reply
//    carries a token (checked), but directory lookups and file URLs go out
//    this way.
//
// Run with: node --test tests/client-trust-gaps.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');

// ── 1. The dev-console listener ────────────────────────────────────────

test('the dev-console listener checks the sender, not only the sentinel', () => {
  const src = stripComments(read('frontend/src/features/dev-console/store.ts'));
  assert.match(src, /isOwnedFrameWindow\(event\.source\)/,
    'the sentinel is a routing tag an app frame can read and echo back');
  // And the gate must run BEFORE the entry is stored.
  const gate = src.indexOf('isOwnedFrameWindow(event.source)');
  const store = src.indexOf('this._store(entry)');
  assert.ok(gate > 0 && gate < store, 'a forged entry must not reach the store');
});

test('the ownership helper fails closed', () => {
  const src = read('frontend/src/features/dev-console/store.ts');
  const body = src.slice(
    src.indexOf('function isOwnedFrameWindow'),
    src.indexOf('export class')
  );
  assert.match(body, /if \(!source \|\| typeof document === 'undefined'\) return false;/,
    'no document means refuse, not allow');
  assert.match(body, /catch \{\s*return false;\s*\}/,
    'an un-enumerable frame list means refuse');
});

// ── 2. The staging iframe src ──────────────────────────────────────────

const { isSafeAppIframeSrc } = require('../frontend/src/features/app-frame/app-frame-policy.js');

test('the shared policy refuses the platform origin and non-http schemes', () => {
  const platform = 'https://my.example';
  assert.equal(isSafeAppIframeSrc('https://app.example/x', platform), true);
  assert.equal(isSafeAppIframeSrc('http://localhost:5173/', 'http://localhost:3000'), true,
    'a different port is a different origin');

  assert.equal(isSafeAppIframeSrc('https://my.example/anything', platform), false,
    'the platform must never be framed in its own app frame');
  assert.equal(isSafeAppIframeSrc('javascript:alert(1)', platform), false);
  assert.equal(isSafeAppIframeSrc('data:text/html,<p>x', platform), false);
  assert.equal(isSafeAppIframeSrc('', platform), false);
  assert.equal(isSafeAppIframeSrc('/relative', platform), false, 'relative resolves to us');
  assert.equal(isSafeAppIframeSrc('https://app.example', ''), false, 'no platform origin, no answer');
});

test('the staging preview applies it before assigning src', () => {
  const src = stripComments(read('frontend/src/features/staging/staging-bridge.js'));
  assert.match(src, /isSafeAppIframeSrc\(src,/, 'staging had no gate at all');
  const gate = src.indexOf('isSafeAppIframeSrc(src,');
  const assign = src.indexOf('el.src = src;');
  assert.ok(gate > 0 && gate < assign, 'the check must precede the navigation');
});

// The production copy lives in a classic public/js script that cannot
// import, so there are two — the same arrangement the `allow` policy has.
// This is what stops them drifting.
test('the two copies of the policy agree', () => {
  const legacy = read('public/js/app-view.js');
  const body = legacy.slice(
    legacy.indexOf('_isSafeAppIframeSrc(src, platformOrigin = location.origin) {'),
    legacy.indexOf('// The DOM-only fallback mounts')
  );
  for (const rule of [
    /target\.protocol !== 'http:' && target\.protocol !== 'https:'/,
    /platform\.protocol !== 'http:' && platform\.protocol !== 'https:'/,
    /return target\.origin !== platform\.origin;/,
  ]) {
    assert.match(body, rule, 'the legacy copy must still say the same thing');
    assert.match(read('frontend/src/features/app-frame/app-frame-policy.js'), rule,
      'and so must the bundle copy');
  }
});

// ── 3. Bridge replies ──────────────────────────────────────────────────

const APP_VIEW = read('public/js/app-view.js');

test('replies go to the origin that asked', () => {
  const src = stripComments(APP_VIEW);
  assert.match(src, /_replyToFrame\(e, payload\)/, 'a single helper, not ten spellings');
  // Every response and ack goes through it.
  for (const kind of ['llm', 'permission', 'storage', 'directory', 'locale', 'safe_area']) {
    assert.match(src, new RegExp(`_replyToFrame\\(e,[\\s\\S]{0,120}__usernode_${kind}`),
      `the ${kind} bridge still broadcasts its reply`);
  }
});

test('the helper addresses the reply when it can, and only then broadcasts', () => {
  const body = APP_VIEW.slice(
    APP_VIEW.indexOf('_replyToFrame(e, payload) {'),
    APP_VIEW.indexOf('_isSafeAppIframeSrc(src, platformOrigin')
  );
  assert.match(body, /addressable \? origin : '\*'/,
    'a real http(s) origin is used; an opaque one has no address to use');
  // Dropping the reply would be the more secure-LOOKING choice and the wrong
  // one: an opaque-origin frame cannot be addressed at all, so refusing is
  // not a narrower reply, it is no reply. This file already carries the scar
  // of an over-tight frame gate that left an app waiting fifteen seconds to
  // be told it was not running inside the platform.
  assert.doesNotMatch(body, /if \(!addressable\) return false/,
    'an unanswerable frame must not be left unanswered');
});

// What is left is genuinely different, and saying so keeps the next reader
// from "finishing the job" incorrectly.
test('the remaining wildcard posts are BROADCASTS, not replies', () => {
  // The helper itself is the ONE place a '*' may appear on a reply, and
  // every site now goes through it — so it is excluded by line range rather
  // than by pattern, which would have exempted the very thing being checked.
  const helperStart = APP_VIEW.indexOf('_replyToFrame(e, payload) {');
  const helperEnd = APP_VIEW.indexOf('_isSafeAppIframeSrc(src, platformOrigin');
  const lines = APP_VIEW.split('\n');
  const offenders = [];
  let offset = 0;
  lines.forEach((line, i) => {
    const at = offset;
    offset += line.length + 1;
    if (at >= helperStart && at < helperEnd) return;
    if (!/postMessage\(/.test(line)) return;
    const window = lines.slice(i, i + 4).join('\n');
    if (!/'\*'/.test(window)) return;
    // A reply answers an inbound event and therefore has one to read.
    if (/e\.source\.postMessage/.test(line)) offenders.push(i + 1);
  });
  assert.deepEqual(offenders, [],
    `these answer an inbound message and must reply to its origin: ${offenders}`);
});

test('a broadcast has no inbound origin to use, which is why it is not fixed here', () => {
  // `notifyLocaleChanged`, the safe-area re-broadcast and the issue-state
  // collect are pushes INTO a frame with no request to answer. Addressing
  // them needs the shell to record which origin belongs in which frame —
  // the registration lifecycle #2503 already documents as its own work.
  const src = stripComments(APP_VIEW);
  assert.match(src, /notifyLocaleChanged\(locale\)/);
  assert.match(src, /__usernode_issue_state: 'collect'/);
});
