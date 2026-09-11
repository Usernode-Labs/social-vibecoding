'use strict';

// #1915: the challenges block's completion-status line ("2 of 5 onboarding
// challenges completed…") had bottom padding only, so it sat flush against the
// season ring's hairline directly above it. It now pads both sides.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/home/panels/challenges.tsx'), 'utf8');

test('the onboarding status line has top padding as well as bottom', () => {
  const m = SRC.match(/<p className="([^"]*)"[^>]*>\s*\{view\.onboardingNote\}/);
  assert.ok(m, 'the onboarding note renders as a <p> with a static className');
  const classes = m[1].split(/\s+/);
  const top = classes.some((c) => /^(pt|py)-(?!0\b)/.test(c));
  const bottom = classes.some((c) => /^(pb|py)-(?!0\b)/.test(c));
  assert.ok(top, `expected top padding, got "${m[1]}"`);
  assert.ok(bottom, `expected bottom padding, got "${m[1]}"`);
});
