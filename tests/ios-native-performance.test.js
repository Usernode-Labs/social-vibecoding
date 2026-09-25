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

// THE GLASS IS OFF ON EVERY iPHONE. #787 and #3104 dropped it in the app
// only; the product decision since is that Safari and the home-screen PWA
// lose it too (same engine, same hardware, same cost). `.un-ios` is the kit's
// own platform class, so Android and desktop keep the glass.
test('every iPhone removes live blur from shell-owned frosted surfaces', () => {
  const block = performanceBlock();
  const blur = block.match(/((?:html\.un-ios [^,{]+,\s*)+html\.un-ios [^,{]+) \{\s*-webkit-backdrop-filter:\s*none;\s*backdrop-filter:\s*none;\s*\}/);
  assert.ok(blur, 'one rule takes the blur off, scoped to html.un-ios');
  const selectors = blur[1].split(',').map((s) => s.trim());
  assert.deepEqual(selectors, [
    '.platform-chat-header.un-scrolled',
    '.un-navbar',
    '.un-action-card',
    '.un-alert',
    '.un-toast',
  ].map((s) => `html.un-ios ${s}`), 'on every iPhone, not only in the app');
  assert.match(block, /\nhtml\.un-ios \{\s*--un-navbar-bg:\s*var\(--bg-primary\);\s*--un-toast-bg:\s*#1c1c2a;\s*\}/,
    'translucent navigation receives an opaque fallback on every iPhone');
  assert.doesNotMatch(block, /html\.un-ios\.in-native-webview( \.[\w-]+)*(\.un-scrolled)?,?\s*(\{|,)\s*-webkit-backdrop-filter/,
    'no glass opt-out is left scoped to the app alone');
});

test('the kit that sets .un-ios never classes desktop macOS or Android as iOS', () => {
  const kit = fs.readFileSync(path.join(root, 'public/usernode-native/v1/native.js'), 'utf8');
  const detect = kit.slice(kit.indexOf('function detectPlatform()'), kit.indexOf('var platform = detectPlatform();'));
  assert.match(detect, /\/iPhone\|iPad\|iPod\/\.test\(ua\)/);
  // A Mac reports MacIntel too; only an iPad (iPadOS 13+) has touch points.
  assert.match(detect, /navigator\.platform === 'MacIntel' && navigator\.maxTouchPoints > 1/);
  assert.ok(detect.indexOf("return 'ios'") < detect.indexOf('/Android/.test(ua)'),
    'iOS is decided from the UA and touch points alone, before the Android branch');
  assert.match(kit, /document\.documentElement\.classList\.add\('un-' \+ platform\)/);
});

test('native iOS view-transition override is transform-only and shorter', () => {
  const block = performanceBlock();
  // The glass widened to every iPhone; the transition did not. It is about
  // the app's full-page snapshot, so Safari and the PWA keep the kit's own.
  const vt = block.match(/^\s*html\.un-ios[^\n{]*\[data-un-vt[^\n{]*/gm) || [];
  assert.ok(vt.length >= 6, `found ${vt.length} view-transition selectors`);
  for (const sel of vt) {
    assert.match(sel, /^\s*html\.un-ios\.in-native-webview\[data-un-vt/, `stays native-only: ${sel.trim()}`);
  }
  assert.doesNotMatch(css, /html\.un-ios\[data-un-vt/,
    'the shell never overrides the kit\'s iOS transition outside the app');
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
  // Motion is reduced in the app only; Safari and the PWA keep their loops.
  const loops = [...block.matchAll(/^(html[^\n{]*(?:status-dot\.creating|work-cog-spinning|app-version-pill-dot|dc-active-dot-busy)[^\n{]*)/gm)];
  assert.equal(loops.length, 5, 'the five decorative-loop selectors');
  for (const [, sel] of loops) {
    assert.match(sel, /^html\.un-ios\.in-native-webview /, `native-only: ${sel}`);
  }
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

// The pane glass (`--dc-frost`) spread past the surfaces #787 listed: the tab
// bar, the header, the Messages / Settings / Workshop planes and every kit
// sheet, panel and dialog, all of which content scrolls behind or a spring
// moves on every frame. #3104 had the iOS app draw them the way the
// stylesheet already draws them with no backdrop-filter at all; every iPhone
// (Safari and the home-screen PWA too) now does.
const FALLBACK = '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {';
const SCOPE = ':where(html.un-ios) ';

function splitSelectors(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

test('every iPhone turns the pane frost off at its token, and only there', () => {
  assert.match(performanceBlock(), /\nhtml\.un-ios \{\s*--dc-frost:\s*none;\s*\}/);
  assert.equal((css.match(/--dc-frost\s*:/g) || []).length, 2,
    'declared once for everyone and once for every iPhone: Android and desktop keep the glass');
  assert.doesNotMatch(css, /:where\(html\.un-ios\.in-native-webview\)/,
    'no no-glass twin is left scoped to the app alone');
  assert.equal((css.match(/:where\(html\.un-ios\) /g) || []).length, 32,
    'all 32 twins moved to the iPhone scope');
});

test('every no-backdrop-filter fallback has an iPhone twin right after it, with the same rules', () => {
  let at = css.indexOf(FALLBACK);
  let blocks = 0;
  while (at >= 0) {
    const end = css.indexOf('\n}', at);
    const body = css.slice(at + FALLBACK.length, end);
    const after = css.slice(end + 2, end + 2 + 1600);
    for (const [, selectors, decls] of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const twin = splitSelectors(selectors.split(/\s+/).join(' ')).map((s) => SCOPE + s).join(',\n')
        + ` { ${decls.split(/\s+/).join(' ').trim()} }`;
      assert.ok(after.includes(twin), `every iPhone mirrors: ${selectors.trim().slice(0, 60)}`);
      assert.match(decls, /background-color:\s*var\(--dc-(sheet|strip)\)/, 'an opaque plane, as designed');
    }
    blocks += 1;
    at = css.indexOf(FALLBACK, end);
  }
  assert.ok(blocks >= 14, `found ${blocks} fallback blocks`);
});

test('the frosted surfaces with no fallback block go opaque on every iPhone too', () => {
  const glass = css.match(/body:has\(:is\(([^)]*)\):not\(\.hidden\)\) #platform-header \{\s*background-color: var\(--dc-sheet-fill\);/);
  assert.ok(glass, 'the header glass rule');
  const roots = glass[1].split(',').map((s) => s.trim());
  const twin = css.match(/:where\(html\.un-ios\) body:has\(:is\(([^)]*)\):not\(\.hidden\)\) #platform-header,\s*:where\(html\.un-ios\) body:has\(#app-view:not\(\.hidden\)\[data-app-surface="platform"\]\) #platform-header \{\s*background-color: var\(--dc-sheet\);/);
  assert.ok(twin, 'the header takes the tab bar\'s opaque fallback on every iPhone, on both of its glass routes');
  assert.deepEqual(twin[1].split(',').map((s) => s.trim()), roots, 'on exactly the routes the glass rule covers');
  for (const selector of ['.global-chat-composer', '.global-chat-result', '.gc-event-box']) {
    assert.ok(css.includes(`${SCOPE}${selector} { background`), `${selector} is opaque on every iPhone`);
  }
});
