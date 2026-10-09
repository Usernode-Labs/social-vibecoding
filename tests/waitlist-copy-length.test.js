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

// The pitch's words are catalog entries; the screen holds their ids in order.
const PITCH_IDS = [
  'auth:waitlist.intro', 'auth:waitlist.points.builtHere', 'auth:waitlist.points.chain', 'auth:waitlist.points.gradual',
];
const pitchText = () => PITCH_IDS.map((id) => message(id)).join(' ');

test('stage 1 leads with one sentence, then a list', () => {
  const from = WAITLIST.indexOf("{t('auth:waitlist.intro')}");
  const to = WAITLIST.indexOf("{t('auth:waitlist.justEmail')}");
  assert.ok(from > 0 && to > from, 'the pitch is still drawn above the one-line ask');
  const pitch = WAITLIST.slice(from, to);
  assert.deepEqual(Array.from(pitch.matchAll(/\{t\('([^']+)'\)\}/g), (m) => m[1]), PITCH_IDS,
    'the pitch is these four messages and nothing else');
  assert.match(pitch, /<ul/, 'the three supporting claims are a list now');
  const items = pitch.match(/<li>/g) || [];
  assert.equal(items.length, 3);
  assert.ok(wordsIn(pitchText()) < 70,
    `the pitch should be well under the original ~75 words, saw ${wordsIn(pitchText())}`);
});

test('and keeps every claim it used to make', () => {
  for (const claim of [
    /Describe the app you want in chat, an AI builds it, and the group votes the changes in\./,
    /built here, by the people who use it/,
    /run on the Homeroom chain, and contributors own a share of what they build/,
    /We're letting people in a few at a time\./,
    /public apps are open to everyone now/,
    /Just your email to join\./,
  ]) {
    assert.match(flat(`${pitchText()} ${message('auth:waitlist.justEmail')}`), claim);
  }
});

test('the heading and the step line are untouched: checks pin them', () => {
  // "Enter your confirmation code" and "Registered with" are declared-check
  // text on ?shot= routes, and the whole pitch hides on `joined` as before.
  assert.match(WAITLIST, /\{t\('auth:waitlist\.title'\)\}/);
  assert.match(message('auth:waitlist.title'), /Join the waitlist/);
  assert.match(WAITLIST, /hiddenLast\(joined, 'mt-3 text-sm font-medium/);
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
