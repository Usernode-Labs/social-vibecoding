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
