// Short and odd-shaped screens (overnight UI audit, 1 to 2 November 2026,
// batch 4). Each test names the finding it pins; the layout itself is
// checked on every shape by `npm run audit:layout` (scripts/layout-audit),
// whose made-up world now carries a request page and an install strip.
//
// Run with: node --test tests/short-screens.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_CSS = read('public/css/app.css');

// The declarations of the first rule whose selector is exactly `selector`.
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = APP_CSS.match(new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `no rule for ${selector}`);
  return m[1];
}

test('L01: the strips above the header are reserved on every screen, not only a paged one', () => {
  // Communities, Messages, the bot and a request are the fixed shell: the
  // token was 0 there, so the rail started a strip's height too high and its
  // Home row was printed over the page's title.
  assert.match(rule('body.has-install-strip'), /--browser-banner-h: var\(--install-strip-h\);/);
  assert.match(rule('body.is-offline'), /--browser-banner-h: var\(--offline-strip-h\);/);
  assert.match(rule('body.is-offline.has-install-strip'), /--browser-banner-h: calc\(var\(--offline-strip-h\) \+ var\(--install-strip-h\)\);/);
  // Declared before the paged rules, which say the same and outrank it.
  assert.ok(APP_CSS.indexOf('body.has-install-strip { --browser-banner-h') < APP_CSS.indexOf('html[data-browser-scroller] body.has-install-strip {'));
  // The rail reads it, as it always did.
  assert.match(APP_CSS, /\.platform-tabs \{[\s\S]{0,400}top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\)/);
});

test('L01: the bot\'s columns start under the strips too', () => {
  for (const sel of ['#ai-screen .ai-main-pane', '#ai-screen .ai-preview-pane', '#ai-main-divider']) {
    assert.match(rule(sel), /top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\) - \.5rem\);/, sel);
  }
  assert.doesNotMatch(APP_CSS, /\n\s*top: calc\(var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\) - \.5rem\);/,
    'nothing under the header starts from it without the strips');
});

test('the layout audit\'s world has a request page and a phone browser\'s install strip', async () => {
  const { answer, SCREENS } = await import(path.join(ROOT, 'scripts/layout-audit/fixtures.mjs'));
  const { PROFILES } = await import(path.join(ROOT, 'scripts/layout-audit/profiles.mjs'));
  const get = (p) => answer('GET', new URL(`https://homeroom.test${p}`));
  assert.equal(get('/api/public/mobile-app').status, 200);
  assert.equal(get('/api/apps/audit-garden/github-issues/21').json.issue.number, 21);
  const request = SCREENS.find((s) => s.id === 'request');
  assert.ok(request && request.composer, 'the keyboard pass types a reply on it');
  const android = PROFILES.find((p) => p.id === 'android-chrome');
  assert.deepEqual([android.width, android.height, android.native, android.keyboard > 0], [360, 560, false, true]);
});
