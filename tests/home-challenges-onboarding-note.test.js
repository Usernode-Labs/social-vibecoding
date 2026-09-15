'use strict';

// #1915: the challenges block's completion-status line ("Finish these to
// unlock persistent and weekly challenges.") pads both sides. There is no
// hairline above it any more (the block is a flat column on the page ground);
// the padding is the column's one rhythm: every band, the season progress and
// the body included, opens on `pt-2` and closes on `pb-1.5`, so the note keeps
// the same 14px step from its neighbours. Trimming either side breaks that
// step.
//
// S8 (owner decision, 2026-09-15) MOVED the note: it used to sit between the
// season progress and `.home-panel-body`; it now follows the body, under the
// challenges, because it says what finishing them unlocks. That also keeps the
// declared check's `.home-panel-season + .home-panel-body` adjacency true
// while setup is locked. The dashed "N challenges locked" placeholder carries
// the unlock line itself, so the note is drawn only when that card is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/home/panels/challenges.tsx'), 'utf8');

const NOTE = /<p className="([^"]*)"[^>]*>\s*\{view\.onboardingNote\}/;

test('the onboarding status line has top padding as well as bottom', () => {
  const m = SRC.match(NOTE);
  assert.ok(m, 'the onboarding note renders as a <p> with a static className');
  const classes = m[1].split(/\s+/);
  const top = classes.some((c) => /^(pt|py)-(?!0\b)/.test(c));
  const bottom = classes.some((c) => /^(pb|py)-(?!0\b)/.test(c));
  assert.ok(top, `expected top padding, got "${m[1]}"`);
  assert.ok(bottom, `expected bottom padding, got "${m[1]}"`);
});

test('the onboarding status line follows the challenges, not the season progress', () => {
  const note = SRC.search(NOTE);
  // The JSX's own class, not the header comment's mention of it: `hasNote`
  // reads `view.onboardingNote` above the markup.
  const season = SRC.indexOf('home-panel-season pt-2');
  // The body's class is one of two complete literals (it closes on `pb-1.5`
  // only when a band follows it), so find its first spelling.
  const body = SRC.search(/['"]home-panel-body /);
  const locked = SRC.indexOf('<LockedChallengesCard');
  assert.ok(season > 0 && body > season, 'the season progress leads the body');
  assert.ok(locked > body, 'the locked placeholder is inside the body');
  assert.ok(note > locked, 'the note comes after the body and its placeholder');
  assert.doesNotMatch(SRC.slice(season, body), /onboardingNote/,
    'nothing sits between the season progress and the body');
});

test('the note is not drawn beside the placeholder that already says it', () => {
  assert.match(SRC, /const hasNote = !!view\.onboardingNote && !\(lockedCount > 0\);/);
  assert.match(SRC, /\{hasNote \? \(/);
});
