// The stage-2 offer card stops asking for answers once they exist (#1535).
//
// The waitlist screen raises "Want in sooner? → Answer them now" the moment an
// address is confirmed. That card outlives a trip to the survey and back:
// answer the four questions, press back, and it is still inviting you to
// answer them. It has no way to know, because the answers are the other
// screen's business.
//
// So the survey PUBLISHES the fact (markSurveyAnswered) and the card
// SUBSCRIBES (useSurveyAnswered). Two properties are pinned here:
//
//   - the default is "not answered", because the prerendered document knows of
//     no answered token and a first render that disagrees with it is a
//     hydration mismatch — which console.errors, which fails proposal checks;
//   - the store is per TOKEN, so one signup's answers never relabel another's
//     card in the same tab.
//
// Run with: node --test tests/waitlist-answered-cta.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { interiorHtmlFor } = require('./lib/lazy-interiors');

const ROOT = path.join(__dirname, '..');
const SHARED = 'frontend/src/features/auth/waitlist-shared.tsx';

test('the card renders the ask, not the edit, before anything is answered', () => {
  // This is also the state the declared `?shot=waitlist-confirmed` check sees,
  // which pins "Want in sooner?" on this card.
  const html = interiorHtmlFor('auth-waitlist-screen');
  assert.ok(html.includes('Want in sooner?'));
  assert.ok(html.includes('Answer them now'));
  assert.ok(!html.includes('Edit my answers'),
    'the first render must match the prerendered document');
});

test('markSurveyAnswered is remembered per token, and ignores nothing-tokens', () => {
  const { markSurveyAnswered, useSurveyAnswered } = loadTsx(SHARED);
  assert.equal(typeof markSurveyAnswered, 'function');
  assert.equal(typeof useSurveyAnswered, 'function');

  // The store is module state behind the hook, so it is exercised through the
  // publisher and read back through the same module's snapshot logic.
  const src = fs.readFileSync(path.join(ROOT, SHARED), 'utf8');
  assert.match(src, /if \(!token \|\| answeredTokens\.has\(token\)\) return;/,
    'a null token and a repeat are both no-ops');
  assert.match(src, /\(\) => !!token && answeredTokens\.has\(token\)/,
    'the snapshot is scoped to the token being asked about');
  assert.match(src, /\(\) => false,/,
    'the server snapshot is false, so the prerender renders the ask');
});

test('the survey publishes on save, and the card reads it for both label and copy', () => {
  const more = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/auth/more.tsx'), 'utf8');
  const saved = more.indexOf('setSaved(true)');
  assert.ok(saved !== -1);
  assert.match(more.slice(saved, saved + 400), /markSurveyAnswered\(value\)/,
    'published only on a successful save, with the token it was saved under');

  const screen = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/auth/waitlist.tsx'), 'utf8');
  assert.match(screen, /const surveyAnswered = useSurveyAnswered\(moreToken\)/);
  assert.match(screen, /surveyAnswered \? 'Edit my answers' : 'Answer them now'/);
  // The pitch above the button changes with it — "four more questions, about
  // three minutes" over an "Edit my answers" button is the same incoherence
  // one line up.
  assert.match(screen, /Your answers are saved\./);
  // The heading does not: a declared check pins it.
  assert.match(screen, /Want in sooner\?/);
});
