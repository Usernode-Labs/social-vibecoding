// Tests for HiDPI screenshot capture (issue #360): the
// DEVICE_SCALE_FACTOR → deviceScaleFactor resolution in
// capture/capture.js, and the apps-row → DEVICE_SCALE_FACTOR resolution
// in src/services/visuals.js that feeds it.
//
// Run with: node --test tests/capture-device-scale.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDeviceScaleFactor } = require('../capture/capture');
const { resolveCaptureScale } = require('../src/services/visuals');

// ── capture/capture.js: env string → device scale ─────────────────────

test('unset DEVICE_SCALE_FACTOR defaults to 2× (HiDPI)', () => {
  assert.equal(resolveDeviceScaleFactor(undefined), 2);
  assert.equal(resolveDeviceScaleFactor(''), 2);
  assert.equal(resolveDeviceScaleFactor(null), 2);
});

test('explicit 1 opts out to standard density', () => {
  assert.equal(resolveDeviceScaleFactor('1'), 1);
  assert.equal(resolveDeviceScaleFactor(1), 1);
});

test('2 stays 2×', () => {
  assert.equal(resolveDeviceScaleFactor('2'), 2);
});

test('garbage / out-of-range falls back to 2×', () => {
  assert.equal(resolveDeviceScaleFactor('3'), 2);
  assert.equal(resolveDeviceScaleFactor('0'), 2);
  assert.equal(resolveDeviceScaleFactor('-1'), 2);
  assert.equal(resolveDeviceScaleFactor('nonsense'), 2);
  assert.equal(resolveDeviceScaleFactor('4'), 2);
});

// ── src/services/visuals.js: apps row → device scale ──────────────────

test('captureForSession derives 1× only from an explicit opt-out row', () => {
  assert.equal(resolveCaptureScale({ screenshot_device_scale: 1 }), 1);
});

test('captureForSession defaults to 2× for 2, missing column, or no row', () => {
  assert.equal(resolveCaptureScale({ screenshot_device_scale: 2 }), 2);
  assert.equal(resolveCaptureScale({}), 2);
  assert.equal(resolveCaptureScale(undefined), 2);
  assert.equal(resolveCaptureScale(null), 2);
});
