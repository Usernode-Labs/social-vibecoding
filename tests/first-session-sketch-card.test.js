'use strict';

// The project's thumbnail (frontend/src/features/first-session/
// sketch-card.tsx), on the made screen, the App tab and an invite, and the
// build line at its foot (./build-line.tsx).
//
// #4053 and #4041, onboarding test on iPhone, 6 October 2026: the card of
// the idea had diagonal stripes, a "Being made" pill, the points it would do
// with open rings, and "Step 1 of 7: Set up the project" in its footer. Three
// parts of it talked about the build, so it read as the build rather than as
// a thumbnail of the app, and "Step 4 of 7: Build it" read as an instruction.
// Pinned:
//
//   - a THUMBNAIL: the icon on its colour, the name, one line (the sketch's
//     tagline, else the project's description), and nothing else: no
//     stripes, no pill, no points;
//   - the BUILD LINE is its bottom row, under a hairline, when the screen
//     knows where the first version is: the same words on every screen, a
//     spinner that turns, a blue dot only on the line that waits on the
//     reader, a check once it is ready or live, and no step count;
//   - SKETCHING is the same frame with the name in place and a band of light
//     over the line to come: transform and opacity only, off with reduced
//     motion;
//   - its EMOJI is the icon the made screen shows, and the invite sheet's.
//
// Run with: node --test tests/first-session-sketch-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const SRC = read(`${DIR}/sketch-card.tsx`);

const MADE = { slug: 'plant-pal', name: 'Plant Pal', emoji: null, description: null, example: null, conversationId: 12 };
const CARD = { emoji: '🪴', tagline: 'Never forget to water the flat\'s plants', points: ['See which plants need water today', 'Mark one as watered', 'Take turns with your flatmates'] };

const mod = loadTsx(`${DIR}/sketch-card.tsx`);
const lineMod = loadTsx(`${DIR}/build-line.tsx`);
const LINE_SRC = read(`${DIR}/build-line.tsx`);

function sketchCard(props) {
  return renderToHtml(createElement(mod.SketchCard, {
    made: MADE, line: 'planning', note: 'Homeroom is making your app. It will message you when the first version is ready to try, or if it has any questions.',
    ...props,
  }));
}

test('the card in an answer is read strictly, and it stands as sketching while the sketch is on its way', () => {
  assert.deepEqual(mod.sketchCardOf({ status: 'ready', card: CARD }), CARD);
  assert.deepEqual(mod.sketchCardOf({ card: { ...CARD, points: ['a', 7, '', 'b', 'c', 'd', 'e'] } }).points, ['a', 'b', 'c', 'd']);
  for (const bad of [null, {}, { card: null }, { card: { emoji: '', tagline: 'x' } }, { card: { emoji: '🪴' } }, { card: 'card' }]) {
    assert.equal(mod.sketchCardOf(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(['loading', 'pending', 'ready', 'none', 'failed'].map(mod.sketching), [true, true, false, false, false]);
  // The pill, the points and the stripes are gone.
  assert.equal(mod.pillLabel, undefined);
  assert.equal(mod.fitPoints, undefined);
  assert.doesNotMatch(SRC, /repeating-linear-gradient|'Being made'|data-featured-card-stage|border-dashed/);
});

test('the build line: the same words everywhere, a spinner that turns, one blue line, a check when done', () => {
  assert.deepEqual({ ...lineMod.BUILD_LINE_WORDS }, {
    planning: 'Homeroom bot is planning it',
    plan: 'Your plan is ready to review',
    'plan-member': 'Planning it',
    question: 'Homeroom bot has a question for you',
    building: 'Building it',
    testing: 'Testing it',
    ready: 'Ready to try',
    live: 'Live',
  });
  // The server's states (homeroom-bot-progress.js), every one with words.
  const { BUILD_LINE_STATES } = require('../src/services/homeroom-bot-progress');
  assert.deepEqual(Object.keys(lineMod.BUILD_LINE_WORDS), [...BUILD_LINE_STATES]);
  assert.equal(lineMod.buildLineOf('building'), 'building');
  for (const bad of [null, undefined, '', 'Build it', 'toString', 4]) assert.equal(lineMod.buildLineOf(bad), null, String(bad));
  const draw = (state) => renderToHtml(createElement(lineMod.BuildLine, { state }));
  for (const state of ['planning', 'plan-member', 'building', 'testing']) {
    const html = draw(state);
    assert.match(html, new RegExp(`<span role="status" data-build-line="${state}" class="[^"]*text-zinc-500`), state);
    assert.match(html, /animate-spin motion-reduce:animate-none/, `${state}: a spinner that turns`);
    assert.doesNotMatch(html, /status-dot|Step \d/);
  }
  for (const state of ['plan', 'question']) {
    const html = draw(state);
    assert.match(html, /font-semibold text-\[color:var\(--accent\)\]/, `${state}: blue, it waits on the reader`);
    assert.match(html, /rounded-full bg-\[color:var\(--accent\)\]/, `${state}: a dot`);
    assert.doesNotMatch(html, /animate-spin/);
  }
  for (const state of ['ready', 'live']) {
    const html = draw(state);
    assert.match(html, /<path[^>]*d="M5 13l4 4L19 7"/, `${state}: a check`);
    assert.doesNotMatch(html, /animate-spin|--accent/);
  }
  assert.match(draw('plan'), />Your plan is ready to review<\/span>/);
  // Not the dot that only fades (app.css .status-dot.creating, which stands
  // still in the Homeroom app on iPhone).
  assert.doesNotMatch(LINE_SRC, /className="[^"]*status-dot/);
});

test('while it is sketched: the same frame, the name in place, a band of light over the line to come', () => {
  const html = sketchCard({ sketch: { state: 'loading', card: null } });
  assert.match(html, /data-first-session-sketch="loading"/);
  assert.match(html, /data-featured-card="sketching"/);
  assert.match(html, /<h1 id="first-session-made-title" class="truncate text-\[17px\] font-bold leading-\[22px\]">Plant Pal<\/h1>/);
  assert.match(html, /role="status" class="sr-only">Sketching Plant Pal from your description…<\/p>/);
  assert.match(html, /motion-safe:animate-card-sweep/);
  assert.match(html, /pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden/);
  assert.match(html, /data-featured-card-line=""[^>]*><span role="status" data-build-line="planning"/);
  assert.match(html, />Homeroom bot is planning it<\/span>/);
  assert.match(html, /Homeroom is making your app\. It will message you when the first version is ready to try, or if it has any questions\./);
  // No words yet, no frame.
  assert.doesNotMatch(html, /<iframe|data-featured-card-words/);
  // The example's emoji, when one was picked, is already the icon.
  assert.match(sketchCard({ made: { ...MADE, emoji: '🏃' }, sketch: { state: 'pending', card: null } }), /<span class="transition-\[opacity,transform\][^"]*">🏃<\/span>/);
});

test('once it is here: the idea\'s emoji and its one line, with the build line at its foot', () => {
  const html = sketchCard({ sketch: { state: 'ready', card: CARD } });
  assert.match(html, /data-first-session-sketch="ready"/);
  assert.match(html, /data-featured-card="ready"/);
  assert.match(html, />🪴<\/span>/);
  assert.match(html, /<p data-featured-card-words="" class="line-clamp-2 text-\[15px\] leading-5 text-zinc-500[^"]*">Never forget to water the flat&#x27;s plants<\/p>/);
  for (const point of CARD.points) assert.doesNotMatch(html, new RegExp(point), 'no points: a thumbnail, not a plan');
  assert.match(html, /shadow-\[inset_0_1px_0_var\(--app-sheet-line\)\]/, 'the line sits under a hairline');
  assert.doesNotMatch(html, /Sketching|animate-card-sweep|role="status" class="sr-only"/);
  // Each line the made screen can say.
  assert.match(sketchCard({ sketch: { state: 'ready', card: CARD }, line: 'plan' }), />Your plan is ready to review</);
  assert.match(sketchCard({ sketch: { state: 'ready', card: CARD }, line: 'ready' }), />Ready to try</);
  assert.match(sketchCard({ sketch: { state: 'ready', card: CARD }, line: 'live' }), />Live</);
  // Nobody is building it: no line at all.
  const none = sketchCard({ sketch: { state: 'ready', card: CARD }, line: null });
  assert.doesNotMatch(none, /data-build-line|data-featured-card-line/);
  // No sketch (none came, or it failed): the description, and the name's letter for an icon.
  const plain = sketchCard({ made: { ...MADE, description: 'Water the plants together' }, sketch: { state: 'failed', card: null } });
  assert.match(plain, /data-featured-card="ready"/);
  assert.match(plain, />Water the plants together<\/p>/);
  assert.match(plain, />P<\/span>/);
});

test('the thumbnail\'s size, and nothing in it scrolls', () => {
  const html = sketchCard({ sketch: { state: 'ready', card: { ...CARD, tagline: 'word '.repeat(40) } } });
  assert.ok(html.includes('h-[132px]'), 'the art');
  assert.ok(html.includes('h-[76px] w-[76px] rounded-[22px]'), 'the icon tile');
  assert.match(html, /class="relative overflow-hidden rounded-\[20px\] bg-white/);
  assert.doesNotMatch(SRC, /overflow-(?:y-)?(?:auto|scroll)|<iframe/);
  // Motion is transform and opacity only, with none under reduced motion.
  assert.doesNotMatch(SRC, /transition-all|transition-\[(?![^\]]*opacity)[^\]]*\]|animate-pulse rounded-(?:md|lg|xl)/);
  for (const m of SRC.matchAll(/transition-\[([^\]]+)\]/g)) assert.equal(m[1], 'opacity,transform');
  assert.equal((SRC.match(/motion-reduce:transition-none/g) || []).length, 3);
  const config = read('tailwind.config.js');
  assert.match(config, /'card-sweep': \{ from: \{ transform: 'translateX\(-100%\)' \}, to: \{ transform: 'translateX\(250%\)' \} \},/);
  assert.match(config, /animation: \{ 'card-sweep': 'card-sweep 1\.8s ease-in-out infinite' \},/);
  // `compact`: smaller art.
  const compact = renderToHtml(createElement(mod.FeaturedCard, { name: 'Plant Pal', colorKey: 'plant-pal', emoji: '🪴', card: CARD, compact: true }));
  assert.ok(compact.includes('h-[88px]'));
  assert.doesNotMatch(compact, /data-build-line/, 'a screen that cannot know the step draws no line');
});

test('the small size, for a row: the tile on its colour, the name, and the line or the build line', () => {
  const row = (props) => renderToHtml(createElement(mod.ThumbRow, { name: 'Plant Pal', colorKey: 'plant-pal', emoji: '🪴', ...props }));
  const quiet = row({ tagline: 'Never forget to water the plants' });
  assert.match(quiet, /data-thumb-row=""/);
  assert.match(quiet, /h-14 w-14 shrink-0[^"]*rounded-2xl/);
  assert.match(quiet, /h-10 w-10[^"]*rounded-xl/);
  assert.match(quiet, />Plant Pal<\/span>/);
  assert.match(quiet, /text-\[13px\][^"]*">Never forget to water the plants<\/span>/);
  const building = row({ tagline: 'Never forget to water the plants', line: 'building' });
  assert.match(building, /data-build-line="building"/);
  assert.doesNotMatch(building, /Never forget/, 'the build line takes the one line\'s place');
});

test('the made screen draws the thumbnail with its line, its emoji is the screen\'s icon, and nothing is framed', () => {
  const made = read(`${DIR}/made.tsx`);
  assert.match(made, /import \{ SketchCard, useSketch \} from '\.\/sketch-card';/);
  assert.match(made, /<SketchCard made=\{made\} sketch=\{sketch\} line=\{line\} note=\{note\} \/>/);
  assert.match(made, /made=\{sketch\.card \? \{ \.\.\.made, emoji: sketch\.card\.emoji \} : made\}/, 'the invite sheet shows it too');
  assert.doesNotMatch(made, /<iframe|sketch\.html|sketchCaption|status-dot|Step \$\{/);
  // Rendered with nothing read yet: the card being sketched, Homeroom bot planning it.
  const { MadeScreen } = loadTsx(`${DIR}/made.tsx`);
  const html = renderToHtml(createElement(MadeScreen, { made: MADE, me: 'Maya', onContinue() {}, onOpenChat() {} }));
  assert.match(html, /data-featured-card="sketching"/);
  assert.match(html, /data-build-line="planning"/);
  // The poll asks past the service worker's cache.
  assert.match(SRC, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/sketch`, \{ credentials: 'same-origin', cache: 'no-store' \}\)/);
});

test('an invite to a project still being built shows the same thumbnail, drawn from its words, without a line', () => {
  const { MadeForYou } = loadTsx('frontend/src/features/auth/invite-card.tsx');
  const preview = {
    live: true, reason: null, inviter: 'maya', inviterName: 'Maya', inviterMadeIt: true, building: true, note: null, memberCount: 1,
    project: { name: 'Plant Pal', iconEmoji: '🪴', iconUrl: null, description: null, picture: { kind: 'sketch', url: null, darkUrl: null, card: CARD } },
  };
  const html = renderToHtml(createElement(MadeForYou, { preview, primaryClass: 'x', onJoin() {} }));
  assert.match(html, /data-landing-invite-picture="sketch"/);
  assert.match(html, /data-featured-card="ready"/);
  assert.match(html, /Never forget to water the flat&#x27;s plants/);
  // The invite knows that it is on its way, not where: no line (#4053).
  assert.doesNotMatch(html, /data-build-line|Being made|<iframe|first-session-made-title/);
  const plain = renderToHtml(createElement(MadeForYou, { preview: { ...preview, building: false }, primaryClass: 'x', onJoin() {} }));
  assert.match(plain, /data-featured-card="ready"/);
  assert.doesNotMatch(plain, /data-build-line/);
  // A picture without a usable card is the plain tile.
  const none = renderToHtml(createElement(MadeForYou, { preview: { ...preview, project: { ...preview.project, picture: { kind: 'sketch', card: null } } }, primaryClass: 'x', onJoin() {} }));
  assert.match(none, /data-landing-invite-picture="tile"/);
});
