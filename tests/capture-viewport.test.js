// Tests for the per-target capture viewport (#768): the TARGETS-entry
// `viewport` → page frame resolution in capture/capture.js that lets a
// `@mobile`-annotated testing path shoot in a phone-sized frame, and the
// platform-side MOBILE_VIEWPORT constant in src/services/visuals.js that
// feeds it.
//
// Run with: node --test tests/capture-viewport.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTargetViewport, resolveTargets } = require('../capture/capture');
const { MOBILE_VIEWPORT } = require('../src/services/visuals');

// ── capture/capture.js: TARGETS entry → viewport override ─────────────

test('a well-formed viewport parses to integer width/height', () => {
  assert.deepEqual(parseTargetViewport({ width: 390, height: 844 }), { width: 390, height: 844 });
  assert.deepEqual(parseTargetViewport({ width: '390', height: '844' }), { width: 390, height: 844 });
});

test('absent / non-object viewports resolve to null (desktop default)', () => {
  assert.equal(parseTargetViewport(undefined), null);
  assert.equal(parseTargetViewport(null), null);
  assert.equal(parseTargetViewport('390x844'), null);
  assert.equal(parseTargetViewport(390), null);
});

test('degenerate or absurd dimensions are rejected', () => {
  assert.equal(parseTargetViewport({ width: 0, height: 844 }), null);
  assert.equal(parseTargetViewport({ width: 390, height: -1 }), null);
  assert.equal(parseTargetViewport({ width: 199, height: 844 }), null);
  assert.equal(parseTargetViewport({ width: 390, height: 4001 }), null);
  assert.equal(parseTargetViewport({ width: 'wide', height: 844 }), null);
  assert.equal(parseTargetViewport({ width: 390 }), null);
});

test('resolveTargets carries a valid per-target viewport through', () => {
  const env = {
    TARGETS: JSON.stringify([
      { index: 0, afterUrl: 'http://a/', viewport: { width: 390, height: 844 } },
      { index: 1, afterUrl: 'http://a/board' },
      { index: 2, afterUrl: 'http://a/x', viewport: { width: 1, height: 1 } },
    ]),
  };
  const t = resolveTargets(env);
  assert.deepEqual(t[0].viewport, { width: 390, height: 844 });
  assert.equal(t[1].viewport, null);
  assert.equal(t[2].viewport, null); // out-of-bounds → desktop default
});

test('the legacy scalar-env fallback never carries a viewport', () => {
  const t = resolveTargets({ AFTER_URL: 'http://a/' });
  assert.equal(t.length, 1);
  assert.equal(t[0].viewport, null);
});

// ── src/services/visuals.js: the mobile frame it resolves @mobile to ──

test('MOBILE_VIEWPORT is a phone-sized portrait frame the container accepts', () => {
  assert.deepEqual(parseTargetViewport(MOBILE_VIEWPORT), MOBILE_VIEWPORT);
  assert.ok(MOBILE_VIEWPORT.width < MOBILE_VIEWPORT.height, 'portrait orientation');
  assert.ok(MOBILE_VIEWPORT.width < 640, 'narrow enough to trigger mobile breakpoints');
});
