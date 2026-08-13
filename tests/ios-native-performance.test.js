'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
const kitCss = fs.readFileSync(path.join(root, 'public/usernode-native/v1/native.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

function performanceBlock() {
  const start = css.indexOf('Native iOS performance baseline (#787)');
  const end = css.indexOf('/* Pressed-state opt-outs:', start);
  assert.ok(start >= 0 && end > start, 'native iOS performance block is present');
  return css.slice(start, end);
}

test('native iOS performance mode uses existing first-paint platform signals', () => {
  const bridge = index.indexOf('<script src="/usernode-bridge.js"></script>');
  const marker = index.indexOf("classList.add('in-native-webview')");
  const styles = index.indexOf('<link rel="stylesheet" href="/usernode-native/v1/native.css">');

  assert.ok(bridge >= 0 && marker > bridge && styles > marker,
    'native marker is applied after the bridge and before styles load');
  assert.match(performanceBlock(), /html\.un-ios\.in-native-webview/);
  assert.doesNotMatch(performanceBlock(), /userAgent|hardwareConcurrency|deviceMemory/,
    'the optimization must not rely on brittle device scoring');
});

test('native iOS removes live blur from shell-owned frosted surfaces', () => {
  const block = performanceBlock();
  for (const selector of [
    '.platform-chat-header.un-scrolled',
    '.un-navbar',
    '.un-action-card',
    '.un-alert',
    '.un-toast',
  ]) {
    assert.ok(block.includes(selector), `covers ${selector}`);
  }
  assert.match(block, /-webkit-backdrop-filter:\s*none/);
  assert.match(block, /backdrop-filter:\s*none/);
  assert.match(block, /--un-navbar-bg:\s*var\(--bg-primary\)/,
    'translucent navigation receives an opaque fallback');
});

test('native iOS view-transition override is transform-only and shorter', () => {
  const block = performanceBlock();
  assert.match(block, /animation-duration:\s*260ms/);
  assert.match(block, /un-vt-native-ios-parallax-out-left/);
  assert.match(block, /un-vt-native-ios-parallax-in-left/);

  const keyframes = block.slice(block.indexOf('@keyframes un-vt-native-ios-parallax-out-left'));
  assert.match(keyframes, /translateX\(-30%\)/);
  assert.doesNotMatch(keyframes, /filter\s*:/,
    'native override must not animate a full-page filter');
  assert.match(kitCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?::view-transition-new\(root\)[\s\S]*?animation:\s*none/,
    'the hosted kit disables view transitions under system Reduce Motion');
  assert.match(block, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?html\.un-ios\.in-native-webview\[data-un-vt\][\s\S]*?animation:\s*none/,
    'the later, higher-specificity native optimization preserves Reduce Motion');
});

test('only decorative loops stop; progress indicators and other platforms retain motion', () => {
  const block = performanceBlock();
  for (const selector of [
    '.status-dot.creating',
    '.work-cog-spinning',
    '.app-version-pill--stale .app-version-pill-dot',
    '.dc-active-dot-busy.dc-active-dot-active',
    '.dc-active-dot-busy.dc-active-dot-promoted',
  ]) {
    assert.ok(block.includes(selector), `stops decorative loop ${selector}`);
  }
  assert.match(block, /dc-active-dot-busy[\s\S]*?box-shadow:/,
    'busy state keeps a non-motion affordance');
  assert.doesNotMatch(block, /dc-send-spinner|app-version-pill-spinner|import-spinner|\.spin\b/,
    'functional progress spinners stay animated');
  assert.doesNotMatch(block, /un-android|un-desktop/,
    'Android and desktop are outside the optimization scope');
});

test('the native-iOS scope is reachable from a URL so checks and screenshots can see it', () => {
  // The real signal is the Flutter-injected JS channel, which a headless
  // browser can never have. Without a URL override the whole optimization is
  // unverifiable by proposal checks and invisible in before/after captures.
  const marker = index.indexOf("classList.add('in-native-webview')");
  assert.ok(marker >= 0, 'the native-webview class is still applied in the shell');

  const block = index.slice(index.indexOf('<script src="/usernode-bridge.js"></script>'), marker);
  assert.match(block, /un-native-webview/,
    'the shell honors a ?un-native-webview=1 override');
  assert.match(block, /===\s*'1'/,
    'the override opts in on an explicit value rather than mere presence');
  assert.match(block, /window\.usernode\s*&&\s*window\.usernode\.isNative/,
    'the genuine native JS-channel signal still applies');
  // Comments here legitimately discuss staging; only the executable code
  // must be free of an environment gate.
  const code = block.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /USERNODE_ENV|IS_STAGING/,
    'a pure presentation flag must not be environment-gated, or the ' +
    '"before" screenshot can never render it');

  const tests = require(path.join(root, 'dapp.json')).tests || [];
  const scoped = tests.filter((t) => /un-native-webview=1/.test(t.path || ''));
  assert.ok(scoped.length > 0,
    'at least one dapp.json test must exercise the native-iOS scope');
  assert.ok(
    scoped.some((t) => /un-platform=ios/.test(t.path || '')),
    'the scope needs BOTH .un-ios and .in-native-webview to match',
  );
  assert.ok(
    scoped.some((t) => /in-native-webview/.test(t.expectSelector || '')),
    'a test must assert the scoping class actually landed on <html>',
  );
});
