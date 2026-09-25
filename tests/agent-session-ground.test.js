'use strict';

// #3082: an agent session in the side panel beside an app drew on a gray
// ground instead of the wallpaper it has in Messages.
//
// The session's panel is `.dc-lift dc-lift-strip` — translucent glass that
// frosts whatever the body paints. The body paints the wallpaper only while
// one of the roots in app.css's `body:has(:is(…):not(.hidden))` list shows;
// otherwise it keeps its `bg-zinc-100` / `dark:bg-zinc-950` utility. On a
// desktop a session is drawn inside #messages-screen (listed). The side panel
// is phone-width, so app.js swaps `messages/agent/<id>` for `agent/<id>` and
// the session shows in #agent-session-screen — which was not on the list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const css = read('public/css/app.css');

// Every rule whose selector is `…body:has(:is(<roots>):not(.hidden))…`.
function routeRules(predicate) {
  const out = [];
  const re = /([^{}]*body:has\(:is\(([^)]*)\):not\(\.hidden\)\)[^{]*)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const roots = m[2].split(',').map((s) => s.trim());
    if (predicate(m[1], m[3])) out.push({ selector: m[1].trim(), roots });
  }
  return out;
}

test('#3082: every wallpaper rule lists the agent session screen beside Messages', () => {
  const rules = routeRules((sel, body) => /--home-wallpaper:|--home-ground:|background-color: var\(--home-ground\)/.test(body)
    && !/#platform-header/.test(sel));
  // The light and dark ground, their 640px layer sets, and the body's colour.
  assert.equal(rules.length, 5, 'the five ground rules are found');
  for (const { selector, roots } of rules) {
    assert.ok(roots.includes('#messages-screen'), `${selector.slice(0, 60)}… is a ground rule`);
    assert.ok(roots.includes('#agent-session-screen'),
      `${selector.slice(0, 60)}… paints the wallpaper under an agent session`);
  }
});

test('#3082: the bar over an agent session is cleared and frosted as it is over Messages', () => {
  // The iPhone's opaque twin of the glass rule is pinned with the other
  // #787 fallbacks (tests/ios-native-performance.test.js).
  const bars = routeRules((sel) => /#platform-header\s*$/.test(sel.trim()) && !/:where\(html\.un-ios\)/.test(sel));
  assert.equal(bars.length, 2, 'the clear rule and the glass rule');
  for (const { roots } of bars) {
    assert.ok(roots.includes('#messages-screen'));
    assert.ok(roots.includes('#agent-session-screen'), 'the session screen matches Messages\' bar');
  }
});

test('#3082: the session panel is still the translucent strip that needs that ground', () => {
  const panel = read('frontend/src/features/agent-session/index.tsx');
  assert.match(panel, /embedded \? '' : 'dc-lift dc-lift-strip'/,
    'the screen host wears the glass strip; if that changes, revisit this ground');
  assert.match(panel, /id="agent-session-screen"/);
});
