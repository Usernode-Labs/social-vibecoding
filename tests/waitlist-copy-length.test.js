// The waitlist screens say the same things in less reading (#1541).
//
// The report was "text heavy - too much reading" on the waitlist and the
// want-in-sooner screens. Stage 1 opened with two paragraphs of around
// seventy-five words carrying four separate claims — what the place is, who
// built the apps, what the chain and the share mean, and how access opens —
// and a reader scanning for "what is this, and what does joining cost me" had
// to take all four as prose.
//
// Nothing was dropped. The claims are pinned individually below, precisely so
// that "cut the copy" cannot quietly become "cut the facts" in a later pass.
//
// Run with: node --test tests/waitlist-copy-length.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WAITLIST = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/auth/waitlist.tsx'), 'utf8');
const MORE = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/auth/more.tsx'), 'utf8');

/** Collapse JSX source whitespace so a wrapped sentence still matches. */
function flat(text) {
  return text.replace(/\s+/g, ' ');
}

/** The rendered words of a JSX text run, comments and markup excluded. */
function wordsIn(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&rsquo;/g, "'")
    .split(/\s+/)
    .filter(Boolean).length;
}

// #5261 retired the join form, and its pitch went with it: Continue joins
// now, and the screen left is check your status, which pitches nothing.
test('the status check carries no join pitch', () => {
  for (const id of ['auth:waitlist.intro', 'auth:waitlist.justEmail', 'auth:waitlist.title']) {
    assert.ok(!WAITLIST.includes(`t('${id}')`), `${id} is not drawn`);
  }
  assert.doesNotMatch(WAITLIST, /<ul/);
});

test('want-in-sooner drops the sentence that said it twice', () => {
  // One message between the heading and the invalid-link notice, and no other.
  const between = MORE.slice(MORE.indexOf("{t('auth:more.title')}"), MORE.indexOf('id="more-invalid"'));
  assert.deepEqual(Array.from(between.matchAll(/\bt\('([^']+)'/g), (m) => m[1]), ['auth:more.title', 'auth:more.intro']);
  const intro = message('auth:more.intro');
  assert.match(intro, /^Four questions, about three minutes/);
  assert.ok(wordsIn(intro) < 40, `saw ${wordsIn(intro)} words`);
  // What it must still say.
  assert.match(flat(intro), /what we read when we pick who gets in next/);
  assert.match(flat(intro), /come back and add to them any time/);
  // The retired half restated the first clause, and "every one is optional"
  // is the label above the heading already. Asserted on the RENDERED intro
  // rather than the file: the change's own doc comment quotes the sentence it
  // removed, which is exactly the sort of prose a whole-file grep trips on.
  assert.doesNotMatch(flat(intro), /worth more than the order/);
  assert.doesNotMatch(flat(intro), /Every one is optional/);
  assert.match(MORE, /\{t\('auth:more\.eyebrow'\)\}/);
  assert.match(message('auth:more.eyebrow'), /Optional \(moves you up the list\)/,
    'the optional label is still there, which is why the sentence could go');
});

test('the "Want in sooner?" heading survives, because a check asserts it', () => {
  assert.match(MORE, /\{t\('auth:more\.title'\)\}/);
  assert.match(message('auth:more.title'), /Want in sooner\?/);
});
