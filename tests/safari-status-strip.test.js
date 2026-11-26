'use strict';

// The strip behind the status bar follows the bar home (onboarding run
// three, 12 Oct 2026, iPhone 17 Safari 26).
//
// In a browser tab Safari colours that strip from the fixed bar's own
// `background-color`, and only an opaque one. Measured on a copy of the bar
// in the simulator: green turned the strip green; transparent afterwards
// left it green; an opaque colour took it back at once. The project's pages
// paint the bar green (the community tint), and Home's bar is transparent
// with its glass drawn by a layer, so after a project's hub the strip stayed
// green on Home, Messages and everywhere else.
//
// Run with: node --test tests/safari-status-strip.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');

test('in an iOS browser tab the glass bar has an opaque ground, so the strip follows it off a tinted page', () => {
  const block = APP_CSS.slice(APP_CSS.indexOf('/* THE STRIP OVER THE BAR FOLLOWS IT HOME'));
  const rule = block.slice(block.indexOf('*/') + 2, block.indexOf('}') + 1);
  // Only an iOS browser tab, and never over the project's own tint.
  const scope = 'html.un-ios.web-browser-chrome:not([data-community-tint])';
  assert.equal(rule.split(scope).length - 1, 2, 'both of the glass bar\'s routes, each scoped');
  assert.match(rule, /body:has\(#app-view:not\(\.hidden\)\[data-app-surface="platform"\]\) #platform-header \{\s+background-color: var\(--platform-header-solid, var\(--dc-sheet-solid\)\);\s+\}/);
  // The same routes the faked glass covers, so the colour is always under
  // a layer that hides it.
  const glass = APP_CSS.slice(APP_CSS.indexOf('/* …AND THE HEADER, faked the same way as the tab bar'));
  const glassRoutes = /body:has\(:is\(([^)]*)\):not\(\.hidden\)\) #platform-header,/.exec(glass)[1].replace(/\s+/g, ' ');
  const stripRoutes = /body:has\(:is\(([^)]*)\):not\(\.hidden\)\) #platform-header,/.exec(rule)[1].replace(/\s+/g, ' ');
  assert.equal(stripRoutes, glassRoutes);
  // That layer is opaque: its washes end on the ground colour.
  assert.match(APP_CSS, /rgba\(253, 232, 228, 0\) 250px\) 0 0 \/ 100% 100% no-repeat var\(--home-ground\);/);
  assert.match(APP_CSS, /var\(--home-washes, var\(--dc-sheet-solid\)\);\n\}/);
  // The tinted bar keeps its colour: the rule above never matches it.
  assert.match(APP_CSS, /html\[data-community-tint\] body:has\(#app-view:not\(\.hidden\)\) #platform-header \{[^}]*background-color: var\(--community-tint\);/);
});

// Mobile 01 (24 Nov 2026): on a phone the top-level bar is the tab bar's
// blue, flat. Safari colours the strip from the rule above, which outranks
// the blue bar's own rule, so the blue bar names its ground in the variable
// that rule reads, and the strip turns blue with it rather than staying the
// plane's white over a blue bar.
test('on a phone the strip takes the blue bar\'s colour, through the variable the strip rule reads', () => {
  const at = APP_CSS.indexOf("/* ── THE PHONE'S TOP BAR IS THE TAB BAR'S BLUE, FLAT");
  assert.ok(at > 0, 'the phone bar\'s rule is where its comment says');
  const block = APP_CSS.slice(at, APP_CSS.indexOf('/* THE BAND: the place bar', at));
  const rule = /@media \(max-width: 767\.98px\) \{\s+([^{]*)\{([^}]*)\}/.exec(block);
  assert.ok(rule, 'a phone-only rule');
  assert.match(rule[2], /--platform-header-solid: var\(--wip-nav-bg\);/);
  assert.match(rule[2], /background-color: var\(--wip-nav-bg\);/, 'and the bar\'s own ground, for a browser that draws no layer');
  assert.match(rule[1], /data-app-surface="platform"/);
});
