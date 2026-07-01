// Tests for the software-WebGL Chromium launch flags in the headless
// capture browser and the in-loop Playwright MCP browser.
//
// WebGL / Three.js apps used to crash on load in the checks/screenshot
// browser with "Could not create a WebGL context" — a console error that
// fails their proposal checks and blanks the before/after shots — because
// Chromium launched with --disable-gpu (no GPU stack at all, so no WebGL
// context, hardware or software). The fix routes WebGL to SwiftShader
// (CPU) via ANGLE and opts modern Chromium into unaccelerated SwiftShader.
// These assertions are a units-level smoke test of the flag set (the real
// getContext() probe needs Chromium, which the platform test env lacks);
// they also pin that the non-WebGL-affecting flags are untouched, so
// ordinary captures behave exactly as before.
//
// Run with: node --test tests/capture-webgl-flags.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CHROMIUM_LAUNCH_ARGS } = require('../capture/capture');

// ── capture/capture.js: SwiftShader software-WebGL flags ─────────────────

test('capture launch args enable software WebGL via SwiftShader/ANGLE', () => {
  assert.ok(CHROMIUM_LAUNCH_ARGS.includes('--use-gl=angle'));
  assert.ok(CHROMIUM_LAUNCH_ARGS.includes('--use-angle=swiftshader'));
  assert.ok(CHROMIUM_LAUNCH_ARGS.includes('--enable-unsafe-swiftshader'));
});

test('capture launch args no longer disable the GPU stack', () => {
  // --disable-gpu makes ANY WebGL context impossible; it must be gone.
  assert.ok(!CHROMIUM_LAUNCH_ARGS.includes('--disable-gpu'));
});

test('capture launch args keep the unrelated flags (non-WebGL captures unaffected)', () => {
  for (const flag of [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
  ]) {
    assert.ok(CHROMIUM_LAUNCH_ARGS.includes(flag), `missing ${flag}`);
  }
});

// ── worker/worker-run.sh: in-loop MCP browser gets the same flags ────────

test('worker-run.sh seeds a Playwright config with the SwiftShader args', () => {
  const wr = fs.readFileSync(
    path.join(__dirname, '..', 'worker', 'worker-run.sh'), 'utf8');
  // A dedicated Playwright config carrying the browser launch args.
  assert.match(wr, /BROWSER_PW_CONFIG=\/home\/node\/\.usernode-playwright\.json/);
  assert.match(wr, /"launchOptions"/);
  assert.match(wr, /--use-gl=angle/);
  assert.match(wr, /--use-angle=swiftshader/);
  assert.match(wr, /--enable-unsafe-swiftshader/);
  // …and the MCP server is pointed at it via --config.
  assert.match(wr, /"--config", "\$BROWSER_PW_CONFIG"/);
  // The existing headless/isolated wiring is preserved.
  assert.match(wr, /--headless/);
  assert.match(wr, /--isolated/);
});
