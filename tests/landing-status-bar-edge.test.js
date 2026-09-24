// The installed landing's top edge is ONE colour (public/css/app.css).
//
// From iOS 26 an installed web app whose status bar is black-translucent gets
// a Liquid Glass blur over the status-bar strip that runs ~38pt below the
// clock, through #landing-header's content row. It is reported to appear only
// when iOS cannot sample a single colour at the page's top edge, so in
// installed mode the bar paints the page ground solid through the inset and
// its top pad. Pinned here: the premise (the page owns the strip), the rule,
// and that it stays inside the standalone display mode — a browser tab and
// the native WebView have their own treatment of this bar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');
const head = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'head.html'), 'utf8');

// The body of the first `@media (display-mode: standalone)` block that styles
// #landing-header, found by brace matching.
function standaloneLandingBlock() {
  const re = /@media \(display-mode: standalone\) \{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    const body = css.slice(m.index + m[0].length, i - 1);
    if (body.includes('#landing-header')) return body;
  }
  return null;
}

test('the page still owns the status-bar strip (the premise of this rule)', () => {
  assert.match(head, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
});

test('installed mode paints the ground solid through the inset, then fades', () => {
  const block = standaloneLandingBlock();
  assert.ok(block, 'a standalone-only #landing-header rule exists');
  const flat = block.replace(/\s+/g, ' ');
  assert.match(flat,
    /background-image: linear-gradient\( var\(--home-ground\) calc\(var\(--un-safe-inset-top, env\(safe-area-inset-top, 0px\)\) \+ 0\.5rem\), transparent \);/,
    'solid page ground to the inset plus the 8px pad, transparent by the bar\'s foot');
});

test('no other #landing-header rule sets a background image outside that media query', () => {
  const outside = css.replace(standaloneLandingBlock(), '');
  assert.doesNotMatch(outside, /#landing-header[^{}]*\{[^}]*background-image/,
    'browser tabs and the native WebView keep their own treatment of the bar');
});
