'use strict';

// #3120 — a Settings cog beside Me at the foot of the desktop rail, straight
// to #settings.
//
// Four things are pinned, each a way the cog can be wrong while the rail
// still renders:
//
//   1. IT IS THERE, AND IT GOES TO SETTINGS: #platform-rail-settings inside
//      #platform-tabs, after Me, href="#settings", named "Settings".
//   2. THE PRERENDER AND THE FIRST CLIENT RENDER AGREE: unlit, because the
//      nav store's INITIAL has no screen — a lit cog on first render would
//      be a hydration mismatch.
//   3. IT LIGHTS ON SETTINGS, AND ONLY THERE, the way a rail row lights.
//   4. DESKTOP ONLY: app.css hides it on the phone's bar and gives it a box
//      only inside the rail's `min-width: 768px` block.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/app.css');

const ui = loadTsx('tests/fixtures/tab-bar-api.ts');
const render = (patch = {}) => {
  const before = ui.navStore.get();
  ui.navStore.set(patch);
  try {
    return renderToHtml(createElement(ui.PlatformTabs, {}));
  } finally {
    ui.navStore.set(before);
  }
};
const cog = (html) => {
  const at = html.indexOf('id="platform-rail-settings"');
  assert.ok(at > 0, '#platform-rail-settings renders');
  return html.slice(html.lastIndexOf('<a', at), html.indexOf('</a>', at) + 4);
};

test('the rail carries a Settings cog after Me, linking straight to #settings', () => {
  const html = render();
  const a = cog(html);
  assert.match(a, /href="#settings"/, 'it goes straight to Settings');
  assert.match(a, /aria-label="Settings"/, 'it is named for assistive tech');
  assert.match(a, /title="Settings"/, 'and carries a tooltip');
  assert.match(a, /class="platform-rail-settings"/);
  assert.doesNotMatch(a, /class="platform-tab"/,
    'it is not a tab — the phone bar\'s grid and marker count those');
  assert.match(a, /<svg[^>]*class="platform-rail-settings-glyph"[^>]*aria-hidden="true"/,
    'the cog glyph is decorative; the link carries the name');
  assert.match(a, /d="M10\.325 4\.317/, 'and it is the shell\'s own CogIcon');

  const me = html.indexOf('id="platform-tab-me"');
  const at = html.indexOf('id="platform-rail-settings"');
  assert.ok(me > 0 && at > me, 'it follows Me: "you, then your settings"');
  assert.ok(at < html.indexOf('</nav>'), 'inside #platform-tabs');
});

test('the prerender ships it unlit, exactly as the first client render draws it', () => {
  assert.equal(ui.navStore.get().screen, null, 'no screen before the router runs');
  const first = cog(render());
  assert.doesNotMatch(first, /aria-current/);
  const shipped = cog(read('public/index.html'));
  assert.equal(first, shipped, 'hydration sees the markup the document carries');
});

test('it lights on the Settings screen and nowhere else', () => {
  assert.match(cog(render({ screen: 'settings-screen', tab: 'me' })), /aria-current="page"/);
  for (const screen of ['profile-screen', 'home-screen', 'admin-screen', 'leaderboard-screen']) {
    assert.doesNotMatch(cog(render({ screen, tab: 'me' })), /aria-current/,
      `${screen} does not light the cog`);
  }
});

test('desktop only: hidden on the phone bar, drawn above Me at the strip\'s foot', () => {
  const base = CSS.indexOf('\n.platform-rail-settings {\n  display: none;\n}');
  assert.ok(base > 0, 'the phone bar never shows it (top-level display: none)');
  // #4417: a 76px strip has no row for the cog to end, so it stands above
  // you, in the flow: your settings, then you, at the foot.
  const desk = CSS.indexOf('\n  .platform-rail-settings {\n    position: relative;');
  assert.ok(desk > 0, 'the strip draws it');
  const media = CSS.lastIndexOf('@media (min-width: 768px) {', desk);
  assert.ok(media > 0 && media > base, 'inside the desktop media query');
  const order = CSS.indexOf('  .platform-rail-settings {\n    order: 2;\n  }\n  #platform-tab-me {\n    order: 3;\n  }');
  assert.ok(order > media && order < desk, 'the cog, then you, after the rule, in the same desktop block');
  assert.doesNotMatch(CSS, /#platform-tab-me \{\s*margin-right: 48px;/, 'Me gives up no room to it any more');
  assert.match(CSS, /\.platform-rail-settings\[aria-current="page"\] \{\s*background: var\(--lit-tint\);/,
    'lit like a rail row');
});
