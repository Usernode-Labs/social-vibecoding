// The signed-out story fits its screen (frontend/src/features/auth/story.tsx).
//
// Evan, 10 Oct 2026, iPhone Safari: Get started fell below the fold, under
// the toolbar, and the foot that #4682 pinned over the story looked wrong.
// The owner's ruling, from a comparison at four iPhone sizes: unpin it and
// shrink the story instead, in this order and only as far as the screen
// needs: the picture, the spacing, the headline, then two examples instead
// of three. A screen that already fits keeps the story as it was.
//
// Run with: node --test tests/story-fit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const STORY = 'frontend/src/features/auth/story.tsx';
const SOURCE = fs.readFileSync(path.join(__dirname, '..', STORY), 'utf8');

test('each step adds to the last, in the owner\'s order', () => {
  const { fitStyle, FIT_STEPS } = loadTsx(STORY);
  assert.equal(FIT_STEPS, 4);
  // Step 0 is the story as it was, so a screen it fits sees no change.
  assert.deepEqual(fitStyle(0), {
    picture: 'w-[200px]',
    group: 'py-6',
    label: 'mt-4',
    examples: 'mt-7',
    row: 'py-2.5',
    foot: 'pt-6',
    headline: 'text-[28px] leading-[33px]',
    count: 3,
  });
  const changed = (n) => Object.keys(fitStyle(n)).filter((k) => fitStyle(n)[k] !== fitStyle(n - 1)[k]);
  assert.deepEqual(changed(1), ['picture'], '1: the people');
  assert.deepEqual(changed(2), ['group', 'label', 'examples', 'row', 'foot'], '2: the spacing');
  assert.deepEqual(changed(3), ['headline'], '3: the headline');
  assert.deepEqual(changed(4), ['count'], '4: two examples');
  assert.deepEqual(fitStyle(4), {
    picture: 'w-[136px]',
    group: 'py-2',
    label: 'mt-3',
    examples: 'mt-[18px]',
    row: 'py-2',
    foot: 'pt-4',
    headline: 'text-[23px] leading-[28px]',
    count: 2,
  });
  // Every class is a whole literal in the source, where Tailwind finds it.
  for (let n = 0; n <= FIT_STEPS; n += 1) {
    for (const [k, v] of Object.entries(fitStyle(n))) {
      if (k !== 'count') assert.ok(SOURCE.includes(`'${v}'`), `${v} is written out`);
    }
  }
});

test('the first render is step 0, with all three examples and nothing pinned', () => {
  const html = renderComponent(STORY, 'Story', { primaryClass: 'pill', onStart() {}, onSignIn() {} });
  assert.match(html, /<img[^>]*class="mx-auto block h-auto w-\[200px\] max-w-full"/);
  assert.match(html, /<h1 class="mt-2 text-\[28px\] leading-\[33px\] font-extrabold text-balance">/);
  assert.equal((html.match(/<li /g) || []).length, 3);
  assert.doesNotMatch(html, /sticky/);
  assert.match(html, /<div class="w-full max-w-sm md:max-w-md mx-auto flex flex-col gap-3 pt-6 pb-3"><a href="#signup" data-landing-story-start=""/);
});

test('it steps before the browser paints, while the story is taller than its room', () => {
  // A layout effect, so the steps are never seen; measured only once the
  // story is laid out (a hidden screen has no height).
  assert.match(SOURCE, /useLayoutEffect\(\(\) => \{\s+const story = storyRef\.current;\s+const group = groupRef\.current;\s+const foot = footRef\.current;\s+if \(!story \|\| !group \|\| !foot \|\| !story\.offsetHeight\) return;/);
  // The group's auto margins are the room left: zero means the story is
  // taller than its screen, the cue for the next step.
  assert.match(SOURCE, /const room = group\.getBoundingClientRect\(\)\.top - story\.getBoundingClientRect\(\)\.top;\s+if \(room < 1\) \{\s+if \(fit < FIT_STEPS\) setFit\(fit \+ 1\);/);
  assert.match(SOURCE, /<div ref=\{groupRef\} className=\{`my-auto flex flex-col items-center \$\{s\.group\}`\}>/);
  // What may run under the foot: the story's own padding (Safari's toolbar
  // allowance) and the page's bottom air under it.
  assert.match(SOURCE, /const under = parseFloat\(getComputedStyle\(story\)\.paddingBottom\)\s+\+ \(story\.parentElement \? parseFloat\(getComputedStyle\(story\.parentElement\)\.paddingBottom\) : 0\);/);
  // A turned phone or a resized window starts again from full size; Safari's
  // toolbar coming and going does not.
  assert.match(SOURCE, /const TOOLBAR_SLACK = 120;/);
  assert.match(SOURCE, /if \(window\.innerWidth === f\.width && Math\.abs\(window\.innerHeight - f\.height\) < TOOLBAR_SLACK\) return;\s+fitting\.current = null;\s+setFit\(0\);/);
  // The two examples left are the first two: the tier list and the game.
  assert.match(SOURCE, /TEMPLATES\.slice\(0, s\.count\)\.map/);
});

// Evan, 10 Oct 2026, iPhone 13 mini in Safari: the fit took all four steps
// and dropped the third example with about 100px empty above the toolbar,
// because it counted the space under the foot as out of bounds.
test('a fit may use the space under the foot, keeping "Sign in" clear of the bottom', () => {
  const { settledStep } = loadTsx(STORY);
  assert.match(SOURCE, /const FOOT_AIR = 18;/);
  // That phone's story, measured at each step (the third row is 60px), with
  // step 4 the first to fit and 3px of room either side of its group.
  const heights = [636, 588, 528, 485, 425];
  // Safari: the toolbar allowance (52) and the page's bottom air (34) under
  // the foot. Step 3 runs 54px into that 86, leaving more than FOOT_AIR.
  assert.equal(settledStep(heights, 4, 3, 52 + 34), 3);
  // In the app there is only the bottom air: 54px is too far, so step 4.
  assert.equal(settledStep(heights, 4, 3, 34), 4);
  // Never past the step that fit, never earlier than the room allows.
  assert.equal(settledStep(heights, 2, 40, 34), 1, '588 <= 528 + 80 + 16');
  assert.equal(settledStep(heights, 0, 10, 86), 0);
  assert.equal(settledStep([700, 650], 1, 0.5, 0), 1);
});
