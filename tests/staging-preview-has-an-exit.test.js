// A staging preview ALWAYS has a way out of it (#1443).
//
// The under-chrome mode is the trap this file exists to keep shut. A preview
// opened from a dev session sits UNDER the header and the session strip, and
// in that arrangement both of the overlay's own exits are deliberately gone:
// app.css puts `display:none` on #staging-back, and .staging-dock-only (the
// ×) is hidden outside docked mode. That is fine, because the strip's pencil
// segment is the way back.
//
// It is fine ONLY while the strip is on screen. `previewActive` — the flag
// the class used to be gated on by itself — is published by
// AppView.ensureStaging for EVERY preview, from a session or not. So a
// preview opened any other way went under-chrome too, hid both exits, and
// handed the job to a control that was not rendered. Nothing on screen closed
// the preview.
//
// Two independent guards now, and this test pins both, because either alone
// is one owner's agreement away from the same dead end:
//
//   1. The CLASS is gated on the session route as well as the flag, which is
//      what "belongs to a session that is still behind it" actually means.
//   2. The CSS refuses to hide the last exit unless the strip is really in
//      the document (`body:has(#dc-session-header)`).
//
// Run with: node --test tests/staging-preview-has-an-exit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const overlay = read('frontend/src/features/staging/staging-overlay.tsx');
const css = read('public/css/app.css');

test('under-chrome needs the session ROUTE, not just the preview flag', () => {
  const at = overlay.indexOf('const underChrome =');
  assert.ok(at !== -1, 'the under-chrome condition is a named constant');
  const line = overlay.slice(at, overlay.indexOf(';', at));

  assert.match(line, /previewActive/,
    'it still requires a preview to be active');
  assert.match(line, /state\.mode !== 'docked'/,
    'and still excludes docked mode, which has its own × close');
  assert.match(line, /onSession/,
    'AND the session route — a preview reached any other way keeps the '
    + 'full-viewport chrome bar, which is the only exit it has');

  // The route pair is the one the rest of the shell reads, so the three
  // components that care about "is a session on screen" agree by
  // construction rather than by three call sites remembering to match.
  const gate = overlay.slice(overlay.indexOf('const onSession ='));
  assert.match(gate.slice(0, 120), /tab === 'dev' && subTab === 'sessions'/,
    "onSession is the shell's own route pair");
});

test('the CSS will not hide the last exit unless the strip is really there', () => {
  // #staging-back is the fullscreen exit. Under-chrome hides it — but only
  // scoped on a body that actually contains the strip whose pencil replaces
  // it. Without the :has(), the two guards could disagree and the preview
  // would again have no way out.
  const rule = css.match(
    /([^\n{}]*)#staging-overlay\.staging-overlay-under-chrome #staging-back\s*\{[^}]*display:\s*none/,
  );
  assert.ok(rule, 'under-chrome still hides #staging-back');
  assert.match(rule[1], /body:has\(#dc-session-header\)/,
    'and only while #dc-session-header is in the document — no strip, no hide');

  // The other half of the trap: the × is hidden outside docked mode, so it
  // is NOT a fallback exit for under-chrome. If this ever changes, the
  // reasoning above needs revisiting rather than silently becoming wrong.
  assert.match(css, /\.staging-dock-only \{ display: none; \}/,
    'the × is hidden by default');
  assert.match(css, /#staging-overlay\.staging-overlay-docked \.staging-dock-only \{ display: inline-flex; \}/,
    'and revealed only in docked mode');
});

test('docked mode keeps its own exit, and it is the ×', () => {
  // Docked hides #staging-back for a different and sound reason — the
  // session never left the screen — and shows the × in its place. That
  // pairing is what makes docked safe, and it is why under-chrome (which
  // shows neither) needed the guards above.
  assert.match(css, /#staging-overlay\.staging-overlay-docked #staging-back \{ display: none; \}/,
    'docked hides the back button');
  assert.match(overlay, /id="staging-dock-close"/, 'the × is rendered');
  assert.match(overlay, /onClick=\{\(\) => stagingHandlers\.onDockClose\?\.\(\)\}/,
    'and wired to a handler app-view.js points at closeStagingOverlay');
});
