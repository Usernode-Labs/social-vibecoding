// The profile's token-allocation card says what the number is (#1552).
//
// It showed a label, a figure blurred behind a "Reveal" button, and one line
// of fine print about the program terms. Two things made that confusing:
//
//   1. It never said what the figure was a quantity OF. The only sentence on
//      the card described what the number is SUBJECT to, not what it is.
//   2. `total_tokens` sums this user's `token_allocation.allocated_tokens`
//      across seasons, so it is 0 for everyone who has not been allocated
//      any — which is most people. They were offered a dramatic blurred
//      figure and a Reveal button that revealed a zero.
//
// The gated branch is untouched: the backend zeroes `total_tokens` until the
// terms are accepted, so a gated allocation must keep showing the terms
// notice and never a "nothing allocated" claim it cannot support.
//
// Run with: node --test tests/profile-token-card.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');

const STORE = 'frontend/src/features/profile/profile-store.js';

test('an un-accepted terms gate still wins over everything else', () => {
  const { tokenView } = loadTsx(STORE);
  // Gated is checked FIRST, so a gated user is never told "nothing allocated
  // yet" — the zero is the gate's doing, not the allocation's.
  assert.deepEqual(tokenView({ terms_accepted: false, total_tokens: 0 }, false), { gated: true });
  assert.deepEqual(tokenView({ terms_accepted: false, total_tokens: 5000 }, true), { gated: true });
});

test('nothing allocated is its own state, not a zero to reveal', () => {
  const { tokenView } = loadTsx(STORE);
  for (const ranking of [{}, { total_tokens: 0 }, { total_tokens: null }, { total_tokens: '0' }]) {
    const view = tokenView(ranking, false);
    assert.equal(view.gated, false);
    assert.equal(view.empty, true, `expected empty for ${JSON.stringify(ranking)}`);
  }
});

test('a real allocation is unchanged: formatted, and blurred until revealed', () => {
  const { tokenView } = loadTsx(STORE);
  const view = tokenView({ total_tokens: 12500 }, false);
  assert.equal(view.empty, false);
  assert.equal(view.revealed, false);
  // Thousands are grouped, as before.
  assert.match(view.amount, /^12[,.   ]?500$/);
  assert.equal(tokenView({ total_tokens: 12500 }, true).revealed, true);
});

test('the card names what the figure is, not only what it is subject to', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'frontend/src/features/profile/profile-view.tsx'),
    'utf8');
  // The allocated card explains the quantity …
  assert.match(src, /Your share of the season&rsquo;s token pool\./);
  // … and the empty one says there is none, rather than blurring a 0.
  assert.match(src, /Nothing allocated to you yet\./);
  const empty = src.slice(src.indexOf('if (token.empty)'));
  const untilReturn = empty.slice(0, empty.indexOf('return (', empty.indexOf('}')));
  assert.doesNotMatch(untilReturn, /blur-md/, 'the empty card blurs nothing');
  assert.doesNotMatch(untilReturn, /Reveal/, 'and offers no reveal');
});
