// src/services/waitlist-signals.js — the countable facts about a waitlist
// signup, derived in ONE place so the admin screen and any future ranking
// read the same thing.
//
// Contracts guarded here:
//
//   1. It reports FACTS, never a score. There is deliberately no total and
//      no weighting: what each signal is worth decides who gets in first,
//      and that is an unmade product decision. Baking a number in here
//      would quietly make it, in the place nobody would think to look.
//   2. A section counts as answered only when it holds real content, so an
//      empty object left behind by a partial save is not a signal.
//   3. It never throws on a malformed, null or non-object answers blob —
//      these rows come from a public endpoint and predate several versions
//      of this schema.
//
// Run with: node --test tests/waitlist-signals.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { signalsFor, SECTIONS } = require('../src/services/waitlist-signals');

// ─── 1. Facts, not a score ────────────────────────────────────────────

test('an empty signup has no signals at all', () => {
  assert.deepEqual(signalsFor({}), {
    confirmed: false, verified: [], sections: [], invited: 0,
  });
});

test('there is no score — adding one is a product decision, not a refactor', () => {
  const s = signalsFor({ confirmed_at: '2026-08-01T00:00:00Z', invited_count: 9 });
  assert.equal(s.score, undefined);
  assert.equal(s.total, undefined);
  assert.equal(s.rank, undefined);
  assert.deepEqual(Object.keys(s).sort(), ['confirmed', 'invited', 'sections', 'verified']);
});

test('confirmation and invite count come off the row, not the answers', () => {
  const s = signalsFor({ confirmed_at: '2026-08-01T00:00:00Z', invited_count: 3 });
  assert.equal(s.confirmed, true);
  assert.equal(s.invited, 3);
});

test('a missing or unparseable invite count reads as zero, never NaN', () => {
  assert.equal(signalsFor({}).invited, 0);
  assert.equal(signalsFor({ invited_count: null }).invited, 0);
  assert.equal(signalsFor({ invited_count: 'nonsense' }).invited, 0);
  // Postgres COUNT comes back as a string through some drivers.
  assert.equal(signalsFor({ invited_count: '4' }).invited, 4);
});

// ─── 2. A section counts only when it holds content ───────────────────

test('sections count only when they hold real content', () => {
  assert.deepEqual(signalsFor({ answers: { group: {} } }).sections, []);
  assert.deepEqual(signalsFor({ answers: { group: { name: 'Chess club' } } }).sections, ['group']);
  assert.deepEqual(signalsFor({ answers: { loss: {} } }).sections, []);
  assert.deepEqual(signalsFor({ answers: { handles: {} } }).sections, []);
});

test('every section is recognised, and the list is sorted', () => {
  const answers = {
    made_url: 'https://example.com',
    country: 'DE',
    discovery: { source: 'x' },
    group: { name: 'Chess club' },
    loss: { had: 'yes' },
    handles: { discord: 'someone#1' },
  };
  assert.deepEqual(signalsFor({ answers }).sections,
    ['found', 'group', 'handles', 'loss', 'made', 'where']);
  assert.equal(signalsFor({ answers }).sections.length, SECTIONS.length);
});

test('a city with no country still counts as a "where"', () => {
  assert.deepEqual(signalsFor({ answers: { city: 'Berlin' } }).sections, ['where']);
});

test('a discovery object with no source does not count as "found"', () => {
  assert.deepEqual(signalsFor({ answers: { discovery: {} } }).sections, []);
  assert.deepEqual(signalsFor({ answers: { discovery: { detail: 'alice' } } }).sections, []);
});

// ─── 3. Verified providers ────────────────────────────────────────────

test('verified handles are listed by provider, sorted', () => {
  const answers = { verified: { x: '@someone', github: 'someone', linkedin: 'Some One' } };
  assert.deepEqual(signalsFor({ answers }).verified, ['github', 'linkedin', 'x']);
});

test('an empty verified value is not a verified provider', () => {
  assert.deepEqual(signalsFor({ answers: { verified: { x: '', github: 'someone' } } }).verified,
    ['github']);
});

// ─── 4. Nothing here may throw on a hostile or ancient row ────────────

test('a null or malformed answers blob is survivable', () => {
  for (const answers of [null, undefined, 'nonsense', 42, [], [1, 2, 3], true]) {
    const s = signalsFor({ answers });
    assert.deepEqual(s.sections, [], `answers=${JSON.stringify(answers)}`);
    assert.deepEqual(s.verified, []);
  }
});

test('a malformed verified blob is survivable', () => {
  for (const verified of [null, 'nonsense', 42, ['github']]) {
    assert.deepEqual(signalsFor({ answers: { verified } }).verified, []);
  }
});

test('no row at all is survivable', () => {
  assert.deepEqual(signalsFor(null), { confirmed: false, verified: [], sections: [], invited: 0 });
  assert.deepEqual(signalsFor(undefined).sections, []);
});
