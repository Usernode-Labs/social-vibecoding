'use strict';

// #7281: the display name is tidied (spaces at either end, and a full stop at
// the end) and checked (no line breaks, within the limit) before it is saved,
// in every form that edits it. The rules are EXECUTED through
// tests/lib/render-tsx.js, because a static render can reach neither a blur
// nor a submit, and getting either wrong saves a name the person did not mean.
//
// Run with: node --test tests/profile-display-name.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const { cleanDisplayName, displayNameProblem } = loadTsx('frontend/src/features/profile/display-name.ts');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('spaces at either end and full stops at the end are removed', () => {
  assert.equal(cleanDisplayName('iqiyi.'), 'iqiyi');
  assert.equal(cleanDisplayName(' Ada '), 'Ada');
  assert.equal(cleanDisplayName('a...'), 'a');
  assert.equal(cleanDisplayName('...'), '');
  assert.equal(cleanDisplayName(' Jr. '), 'Jr');
  assert.equal(cleanDisplayName(null), '');
  assert.equal(cleanDisplayName('Ada Lovelace'), 'Ada Lovelace', 'a name without a trailing stop is untouched');
});

test('a name that cannot be saved says why', () => {
  assert.equal(displayNameProblem('Ada', 40), null);
  assert.equal(displayNameProblem('a'.repeat(40), 40), null, 'exactly the limit is fine');
  assert.equal(displayNameProblem('a'.repeat(41), 40), 'tooLong');
  assert.equal(displayNameProblem('Ada\nLovelace', 40), 'lineBreaks');
  assert.equal(displayNameProblem('Ada\rLovelace', 40), 'lineBreaks');
});

test('every form that edits the name tidies and checks it first', () => {
  for (const file of ['profile-details-card.tsx', 'profile-edit-sheet.tsx', 'identity-inline-edit.tsx']) {
    const source = read(path.join('frontend', 'src', 'features', 'profile', file));
    assert.match(source, /cleanDisplayName\(/, `${file} tidies the name`);
    assert.match(source, /displayNameProblem\(/, `${file} checks the name`);
  }
});
