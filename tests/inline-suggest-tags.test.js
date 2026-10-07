// Tests for the #4125 fix: the Mayor's reply text can carry the
// suggest_replies / suggest_answers tool call as literal pseudo-tag markup
// (`<suggest_replies> ["…"] </suggest_replies>`), which used to render raw
// in the chat bubble. stripInlineSuggestTags strips the markup and — when
// the inner text parses as the shape the tool would have received — returns
// the labels through the same sanitizers the real tool path uses;
// mergeInlineSuggestTags is the precedence rule the turn call sites apply.
//
// Run with: node --test tests/inline-suggest-tags.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stripInlineSuggestTags,
  mergeInlineSuggestTags,
  headlessWrapUpMeta,
} = require('../src/routes/sessions.js');

test('paired tag with a valid JSON array yields clean text plus sanitized labels', () => {
  const text = 'PR #39 is up for the group vote. <suggest_replies> ["How is the vote going?", "What\'s left in the spec?"] </suggest_replies>';
  const out = stripInlineSuggestTags(text, { sessionId: 's1' });
  assert.equal(out.text, 'PR #39 is up for the group vote.');
  assert.deepEqual(out.replies, ['How is the vote going?', "What's left in the spec?"]);
  assert.equal(out.suggestions, null);
});

test('multi-line array as in the reported screenshot is stripped whole', () => {
  const text = [
    "PR #39 (change 6782) is now up for the group vote on Lost Starways — it ships only if the group votes it in. When you're ready, we can also open the matching change on Game Corner for Escape from Dracula (request #333).",
    '<suggest_replies> ["Start the Escape from Dracula change on Game Corner",',
    '"How is the vote going?", "What\'s left in the spec?"] </suggest_replies>',
  ].join('\n');
  const out = stripInlineSuggestTags(text);
  assert.equal(out.text, 'PR #39 (change 6782) is now up for the group vote on Lost Starways — it ships only if the group votes it in. When you\'re ready, we can also open the matching change on Game Corner for Escape from Dracula (request #333).');
  assert.deepEqual(out.replies, [
    'Start the Escape from Dracula change on Game Corner',
    'How is the vote going?',
    "What's left in the spec?",
  ]);
});

test('unparseable inner content strips the markup and yields no pills', () => {
  const text = 'Here is my take.\n<suggest_replies> ["unterminated, </suggest_replies>';
  const out = stripInlineSuggestTags(text);
  assert.equal(out.text, 'Here is my take.');
  assert.equal(out.replies, null);
});

// The tool's own sanitizer drops smart quotes (not valid JSON string
// delimiters), so a tag written with them parses as garbage: markup gone,
// no pills.
test('smart quotes in the inner array parse as garbage', () => {
  const text = 'Done. <suggest_replies> [“Build it”, “Later”] </suggest_replies>';
  const out = stripInlineSuggestTags(text);
  assert.equal(out.text, 'Done.');
  assert.equal(out.replies, null);
});

test('suggest_answers with a questions object yields sanitized suggestions', () => {
  const text = 'Which app? <suggest_answers> {"questions":[{"question":"Which app?","answers":["Game Corner","Lost Starways"]}]} </suggest_answers>';
  const out = stripInlineSuggestTags(text);
  assert.equal(out.text, 'Which app?');
  assert.deepEqual(out.suggestions, [{ question: 'Which app?', answers: ['Game Corner', 'Lost Starways'] }]);
  assert.equal(out.replies, null);
});

test('a bare questions array written inline means the same thing', () => {
  const text = '<suggest_answers> [{"question":"Which app?","answers":["Game Corner"]}] </suggest_answers>';
  const out = stripInlineSuggestTags(text);
  assert.deepEqual(out.suggestions, [{ question: 'Which app?', answers: ['Game Corner'] }]);
});

test('text without tags passes through byte-identical', () => {
  const text = 'Plain prose.\n\nMentions suggest_replies in passing, without markup.\n  ';
  assert.equal(stripInlineSuggestTags(text).text, text);
  const out = stripInlineSuggestTags(text);
  assert.equal(out.replies, null);
  assert.equal(out.suggestions, null);
});

test('a dangling unclosed opener is stripped through the end of the text', () => {
  const text = 'Building it now. <suggest_replies> ["How is it going"';
  const out = stripInlineSuggestTags(text);
  assert.equal(out.text, 'Building it now.');
  assert.equal(out.replies, null);
});

test('tag names match case-insensitively', () => {
  const out = stripInlineSuggestTags('A. <SUGGEST_REPLIES> ["One"] </SUGGEST_REPLIES> B.');
  assert.equal(out.text, 'A.  B.');
  assert.deepEqual(out.replies, ['One']);
});

test('caps and dedupe flow through the existing sanitizer', () => {
  const out = stripInlineSuggestTags('<suggest_replies> ["a", "A", "' + 'x'.repeat(500) + '", "b", "c", "d"] </suggest_replies>');
  assert.equal(out.replies.length, 3);
  assert.deepEqual(out.replies, ['a', 'x'.repeat(80), 'b']);
});

test('a reply that is nothing but the tag empties the text, labels intact', () => {
  const out = stripInlineSuggestTags('<suggest_replies> ["What next?"] </suggest_replies>');
  assert.equal(out.text, '');
  assert.deepEqual(out.replies, ['What next?']);
});

test('both tag kinds in one reply parse independently', () => {
  const text = [
    'Which way?',
    '<suggest_answers> {"questions":[{"question":"Which way?","answers":["Left","Right"]}]} </suggest_answers>',
    '<suggest_replies> ["Go left"] </suggest_replies>',
  ].join('\n');
  const out = stripInlineSuggestTags(text);
  assert.equal(out.text, 'Which way?');
  assert.deepEqual(out.suggestions, [{ question: 'Which way?', answers: ['Left', 'Right'] }]);
  assert.deepEqual(out.replies, ['Go left']);
});

// ── mergeInlineSuggestTags: the precedence rule the turn call sites apply ──

test('a real suggest_answers call wins over the parsed inline one', () => {
  const merged = mergeInlineSuggestTags(
    { suggestions: [{ question: 'real', answers: ['a'] }], droppedForDispatch: false },
    { text: '', suggestions: [{ question: 'inline', answers: ['b'] }], replies: ['pill'] },
  );
  assert.deepEqual(merged.suggestions, [{ question: 'real', answers: ['a'] }]);
  // The chips own the turn: the parsed pills do not fill in.
  assert.equal(merged.quickReplies, null);
});

test('the parsed pills fill in when no real suggest_replies call resolved', () => {
  const merged = mergeInlineSuggestTags(
    { suggestions: null, droppedForDispatch: false, quickReplies: null },
    { text: '', suggestions: null, replies: ['From inline markup'] },
  );
  assert.equal(merged.suggestions, null);
  assert.deepEqual(merged.quickReplies, ['From inline markup']);
});

test('a real suggest_replies call wins over the parsed inline pills', () => {
  const merged = mergeInlineSuggestTags(
    { suggestions: null, droppedForDispatch: false, quickReplies: ['Real call'] },
    { text: '', suggestions: null, replies: ['Inline markup'] },
  );
  assert.deepEqual(merged.quickReplies, ['Real call']);
});

test('the inline chips do not fill in when the clarity gate dropped the real call', () => {
  const merged = mergeInlineSuggestTags(
    { suggestions: null, droppedForDispatch: true },
    { text: '', suggestions: [{ question: 'inline', answers: ['b'] }], replies: ['pill'] },
  );
  assert.equal(merged.suggestions, null);
  // With no chips owning the turn, the parsed pills may still surface.
  assert.deepEqual(merged.quickReplies, ['pill']);
});

// ── headlessWrapUpMeta: the parsed set beats the fixed recovery list ──

test('headlessWrapUpMeta prefers a parsed model-authored pill set over the static one', () => {
  const meta = headlessWrapUpMeta('code', { quickReplies: ['Parsed from the turn'] });
  assert.deepEqual(meta.quickReplies, ['Parsed from the turn']);
  assert.equal(meta.quickRepliesSource, 'model');
  assert.equal(meta.quickRepliesKind, undefined);
});

test('headlessWrapUpMeta keeps its static fallback when nothing parsed', () => {
  const meta = headlessWrapUpMeta('code');
  assert.equal(meta.quickRepliesSource, 'static');
  assert.ok(meta.quickRepliesKind);
});

test('headlessWrapUpMeta keeps chips ahead of pills, static or parsed', () => {
  const meta = headlessWrapUpMeta('question', {
    suggestions: [{ question: 'q', answers: ['a'] }],
    quickReplies: ['Parsed from the turn'],
  });
  assert.deepEqual(meta.suggestions, [{ question: 'q', answers: ['a'] }]);
  assert.equal(meta.quickReplies, undefined);
});