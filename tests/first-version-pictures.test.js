'use strict';

// #7118: a first version gives the app its own logo and card picture.
//
// What this pins:
//   1. cardToneFor maps every palette hue of the icon style to a card colour,
//      and anything else to null (the card then keeps its slug's hash).
//   2. A first version's build prompt carries the two picture instructions;
//      a later change's build prompt does not.
//   3. The first request says the bot makes the pictures when the bot builds
//      it, and says nothing of them when a person builds it.

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../src/services/homeroom-bot-live');
const dm = require('../src/services/homeroom-bot-dm');
const { cardToneFor } = require('../src/services/first-version-pictures');

test('cardToneFor maps the icon style\'s eleven hues to a card colour', () => {
  const hues = [
    ['#FFA552', 'orange'], ['#E05A12', 'orange'],
    ['#FBB43C', 'yellow'], ['#C9570A', 'yellow'],
    ['#C98C5E', 'cream'], ['#6E3F22', 'cream'],
    ['#FF7163', 'coral'], ['#D1321F', 'coral'],
    ['#FF6AB8', 'pink'], ['#CF1F74', 'pink'],
    ['#B574FF', 'purple'], ['#7327DB', 'purple'],
    ['#8577FF', 'indigo'], ['#4432D1', 'indigo'],
    ['#5B9BFF', 'blue'], ['#1F57E6', 'blue'],
    ['#34D3C3', 'teal'], ['#0B7D84', 'teal'],
    ['#3DD68A', 'mint'], ['#0E8A4C', 'mint'],
    ['#6A7B93', 'gray'], ['#27313F', 'gray'],
  ];
  for (const [hex, tone] of hues) assert.equal(cardToneFor(hex), tone, hex);
  // The twelve card colours are the only answers, and case does not matter.
  assert.equal(cardToneFor('#ffa552'), 'orange');
  assert.equal(cardToneFor('  #3DD68A '), 'mint');
});

test('cardToneFor answers null for no colour, an unknown one, or a legacy tint', () => {
  for (const value of [null, undefined, '', 'rebeccapurple', '#123456', 3, {}]) {
    assert.equal(cardToneFor(value), null, String(value));
  }
});

test('a first version\'s build prompt asks for the logo and the card picture; a later change does not', () => {
  const first = live.buildPrompt({ seed: 'ISSUE #1', buildNote: 'plan', firstVersion: true });
  assert.ok(first.includes(live.FIRST_VERSION_PICTURES_LINES.join('\n')));
  assert.match(first, /brand\/icon\.png/);
  assert.match(first, /brand\/card\.png/);
  assert.match(first, /brand\/card-dark\.png/);
  const later = live.buildPrompt({ seed: 'ISSUE #2', buildNote: 'plan' });
  assert.ok(!later.includes(live.FIRST_VERSION_PICTURES_LINES.join('\n')));
  assert.ok(!later.includes('brand/card.png'));
});

test('the first request says the bot makes the pictures when the bot builds it', () => {
  const botBuilt = dm.firstVersionIssue({ name: 'Plant Pal', username: 'ada', brief: 'Watering reminders' }).body;
  assert.ok(botBuilt.includes('Homeroom bot also makes its logo (`brand/icon.png`) and its card picture (`brand/card.png`, `brand/card-dark.png`).'));
  const personBuilt = dm.firstVersionIssue({ name: 'Plant Pal', username: 'ada', brief: 'Watering reminders', botBuilds: false }).body;
  assert.ok(!personBuilt.includes('brand/card.png'), 'a first version a person builds keeps whatever it makes');
});
