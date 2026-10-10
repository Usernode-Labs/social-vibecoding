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
  assert.match(SOURCE, /useLayoutEffect\(\(\) => \{\s+const story = storyRef\.current;\s+const group = groupRef\.current;\s+if \(!story \|\| !group \|\| !story\.offsetHeight\) return;/);
  // The group's auto margins are the room left: zero means the story is
  // taller than its screen, the cue for the next step.
  assert.match(SOURCE, /const room = group\.getBoundingClientRect\(\)\.top - story\.getBoundingClientRect\(\)\.top;\s+if \(room < 1 && fit < FIT_STEPS\) setFit\(fit \+ 1\);/);
  assert.match(SOURCE, /<div ref=\{groupRef\} className=\{`my-auto flex flex-col items-center \$\{s\.group\}`\}>/);
  // A turned phone or a resized window starts again from full size; Safari's
  // toolbar coming and going does not.
  assert.match(SOURCE, /const TOOLBAR_SLACK = 120;/);
  assert.match(SOURCE, /if \(window\.innerWidth !== at\.width \|\| window\.innerHeight - at\.height >= TOOLBAR_SLACK\) setFit\(0\);\s+setMeasure\(\(n\) => n \+ 1\);/);
  // The two examples left are the first two: the tier list and the game.
  assert.match(SOURCE, /TEMPLATES\.slice\(0, s\.count\)\.map/);
});
