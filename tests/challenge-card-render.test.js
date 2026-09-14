// The Challenges tab's card parts (ITERATION 03), rendered.
//
// WHAT THIS PINS. The rail and the reward chip share one row on a
// phone-width card, and the defect this exists for is copy that wraps or
// clips there — including a 320px phone, where a chip width cap left "D…". It is a render property, not a string property, so the parts
// are rendered (tests/lib/render-tsx.js) and the classes that keep the copy
// on one line are asserted on the markup they end up in:
//   * the rail is `min-w-0 flex-auto` and its label `truncate`s;
//   * the chip never shrinks and has no width cap, and the card row wraps the
//     chip to a second line instead of squeezing either pill;
//   * the rail is a progressbar, with aria-valuenow ONLY when the fill is a
//     number (indeterminate otherwise).
//
// Run with: node --test tests/challenge-card-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const Card = loadTsx('frontend/src/features/leaderboard/challenge-card.tsx');

const rail = (props) => renderToHtml(createElement(Card.ProgressRail, props));
const classOf = (html, marker) => {
  const m = html.match(new RegExp(`<[^>]*${marker}[^>]*class="([^"]*)"|<[^>]*class="([^"]*)"[^>]*${marker}`));
  return m ? (m[1] || m[2]) : '';
};

test('the rail is a progressbar; indeterminate rails omit aria-valuenow', () => {
  const counted = rail({ state: 'progress', label: '3/8 tried', fill: 0.375, name: 'Try apps' });
  assert.match(counted, /role="progressbar"/);
  assert.match(counted, /aria-valuenow="38"/);
  assert.match(counted, /aria-label="Try apps: 3\/8 tried"/);
  assert.match(counted, /aria-valuetext="3\/8 tried"/, 'the spoken value is the visible count, not a rounded percent');
  assert.match(counted, /style="width:38%"/, 'the fill is drawn at the same fraction');

  const open = rail({ state: 'progress', label: 'Started', fill: null, name: 'Produce blocks' });
  assert.match(open, /role="progressbar"/);
  assert.doesNotMatch(open, /aria-valuenow/, 'no number to announce');
  assert.doesNotMatch(open, /style="width/, 'and no fill to draw');

  assert.match(rail({ state: 'new', label: 'Not started', fill: 0, name: 'x' }), /aria-valuenow="0"/);

  const bare = rail({ state: 'new', label: '', fill: null, name: 'Produce your first block' });
  assert.doesNotMatch(bare, /aria-valuenow/, 'a rail that cannot see progress announces no value');
  assert.doesNotMatch(bare, /truncate/, 'and draws no label span');
  assert.match(bare, /aria-label="Produce your first block"/, 'but is still named');
  assert.match(rail({ state: 'done', label: 'Done', fill: 1, name: 'x' }), /aria-valuenow="100"/);
});

test('rail copy never wraps: the rail may shrink and its label truncates', () => {
  const html = rail({ state: 'progress', label: '180/500 blocks produced this week', fill: 0.36, name: 'x' });
  const railClass = classOf(html, 'role="progressbar"');
  for (const cls of ['min-w-0', 'shrink', 'grow-[999]', 'basis-auto', 'overflow-hidden', 'h-9']) {
    assert.ok(railClass.split(' ').includes(cls), `rail has ${cls}`);
  }
  assert.match(html, /<span class="relative min-w-0 truncate">180\/500 blocks produced this week<\/span>/,
    'the label is a single truncating line');
});

test('the chip holds its own width, and the row wraps it rather than squeezing a pill', () => {
  const html = renderToHtml(createElement(Card.RewardChip, { text: 'Up to 2,000 pts' }));
  const cls = html.match(/^<span class="([^"]*)"/)[1].split(' ');
  for (const c of ['shrink-0', 'grow', 'max-w-full', 'h-9', 'bg-white', 'text-amber-800']) {
    assert.ok(cls.includes(c), `chip has ${c}`);
  }
  assert.match(html, /<span class="min-w-0 truncate">Up to 2,000 pts<\/span>/);
  const earned = renderToHtml(createElement(Card.RewardChip, { text: 'Earned 500 pts', earned: true }));
  assert.match(earned, /text-emerald-700/, 'an earned reward reads as done, not as a reward on offer');
  const cardTsx = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'frontend/src/features/leaderboard/challenge-card.tsx'), 'utf8');
  assert.match(cardTsx, /const CAPSULE = 'flex flex-wrap items-stretch gap-0\.5 rounded-lg bg-zinc-100 p-0\.5 dark:bg-zinc-800'/,
    'rail and reward share one padded capsule that wraps the reward to a second row inside it');
  assert.match(cardTsx, /<div className=\{CAPSULE\}>\s*<ProgressRail/);
});

test('each state has its own rail tone, and only the accent/emerald/zinc scales', () => {
  const tones = ['new', 'progress', 'done'].map((state) =>
    classOf(rail({ state, label: 'l', fill: state === 'done' ? 1 : 0, name: 'x' }), 'role="progressbar"'));
  assert.equal(new Set(tones).size, 3, 'three distinct recipes');
  assert.match(tones[2], /bg-emerald-500\/10/);
  for (const t of tones) assert.doesNotMatch(t, /\b(gray|indigo)-/, 'no banned scales');
});

test('the tile is an empty neutral face: the group headings carry the category', () => {
  const html = renderToHtml(createElement(Card.ChallengeTile, {}));
  assert.match(html, /h-20 w-20 rounded-2xl/, 'the xl IconTile');
  assert.match(html, /aria-hidden="true"/, 'decorative until it holds artwork');
  assert.doesNotMatch(html, /<span/, 'no category text inside it');
});

test('ChallengeCard is one card for both surfaces: tile, title, rail and chip — no task line', () => {
  const view = {
    goal: 'Try apps', task: 'Open three apps', reward: '500 pts', icon: '🧪',
    state: 'progress', stateLabel: '2/3 tried', fill: 2 / 3, earned: null,
  };
  const html = renderToHtml(createElement(Card.ChallengeCard, {
    view, className: 'home-challenge-card', 'data-challenge-id': '7',
  }));
  assert.match(html, /^<div class="home-challenge-card flex items-center gap-3 bg-white/, 'the surface class leads');
  assert.match(html, /data-challenge-id="7"/);
  assert.match(html, />🧪<\/span>/, 'the kind icon sits in the tile');
  assert.doesNotMatch(html, /Open three apps/, 'the card holds no description, even when handed one');
  assert.doesNotMatch(html, /<p /, 'and no second text line at all');
  // Title and rail are one group, centred beside the tile rather than
  // stretched to its edges.
  assert.match(html, /<div class="flex min-w-0 flex-1 flex-col gap-2">/);
  assert.doesNotMatch(html, /justify-between|self-stretch/);
  assert.match(html, /class="flex flex-wrap items-stretch gap-0\.5 rounded-lg bg-zinc-100 p-0\.5 dark:bg-zinc-800"><div role="progressbar"/,
    'the rail opens the capsule');
  assert.match(html, /truncate text-base font-medium leading-6/);
  assert.match(html, /aria-valuetext="2\/3 tried"/);
  assert.match(html, />500 pts</);
  assert.doesNotMatch(html, /title=/, 'no tooltips');
  const bare = renderToHtml(createElement(Card.ChallengeCard, {
    view: { ...view, icon: null, reward: null },
  }));
  assert.doesNotMatch(bare, /bg-amber-500/, 'no empty reward chip');
});
