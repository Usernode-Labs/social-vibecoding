// Tests for stripSpecWrapperFence (src/routes/sessions.js) — the unwrap that
// undoes a scout/spec-author LLM wrapping its ENTIRE markdown spec in a single
// ```markdown … ``` fence (session 153; ~13% of prod specs rendered as one big
// code block). The helper must be aggressive enough to catch the real failure
// mode but conservative enough never to mangle a legitimate spec.
//
// Run with: node --test tests/spec-wrapper.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripSpecWrapperFence } = require('../src/routes/sessions.js');

const SPEC = '# Spec: Thing\n\n## Goal\n\nDo the thing.\n\n- a\n- b';

test('unwraps a whole-document ```markdown fence (the session 153 case)', () => {
  const wrapped = '```markdown\n' + SPEC + '\n```';
  assert.equal(stripSpecWrapperFence(wrapped), SPEC);
});

test('unwraps an unlabeled ``` fence', () => {
  assert.equal(stripSpecWrapperFence('```\n' + SPEC + '\n```'), SPEC);
});

test('unwraps ```md and ```gfm (and is case-insensitive)', () => {
  assert.equal(stripSpecWrapperFence('```md\n' + SPEC + '\n```'), SPEC);
  assert.equal(stripSpecWrapperFence('```GFM\n' + SPEC + '\n```'), SPEC);
});

test('tolerates surrounding whitespace around the wrapper', () => {
  assert.equal(stripSpecWrapperFence('\n\n```markdown\n' + SPEC + '\n```\n\n'), SPEC);
});

test('leaves a normal spec (no leading fence) untouched', () => {
  assert.equal(stripSpecWrapperFence(SPEC), SPEC);
});

test('does NOT unwrap a non-markdown language wrapper (```json)', () => {
  const wrapped = '```json\n{"a":1}\n```';
  assert.equal(stripSpecWrapperFence(wrapped), wrapped);
});

test('does NOT unwrap when content follows the first closing fence', () => {
  // A spec that merely STARTS with a code block, then has prose after it.
  const doc = '```js\nconst x = 1;\n```\n\nThe code above does X.';
  assert.equal(stripSpecWrapperFence(doc), doc);
});

test('does NOT unwrap an ambiguous 3-backtick wrapper with inner 3-backtick fences (F6)', () => {
  // Inner ``` closes the first block early; boundary is ambiguous, so we bail
  // and leave it for the four-backtick author guidance to prevent upstream.
  const doc = '```markdown\n# Spec\n\n```js\nconst x = 1;\n```\n\nmore spec\n```';
  assert.equal(stripSpecWrapperFence(doc), doc);
});

test('unwraps a 4-backtick wrapper that legitimately contains inner 3-backtick fences', () => {
  const inner = '# Spec\n\n```js\nconst x = 1;\n```\n\nmore spec';
  const wrapped = '````markdown\n' + inner + '\n````';
  assert.equal(stripSpecWrapperFence(wrapped), inner);
});

test('is idempotent — unwrapping an already-clean spec is a no-op', () => {
  const once = stripSpecWrapperFence('```markdown\n' + SPEC + '\n```');
  assert.equal(stripSpecWrapperFence(once), once);
  assert.equal(once, SPEC);
});

test('does not strip an opener with no closing fence', () => {
  const doc = '```markdown\n' + SPEC; // truncated, never closed
  assert.equal(stripSpecWrapperFence(doc), doc);
});

test('handles empty / non-string input gracefully', () => {
  assert.equal(stripSpecWrapperFence(''), '');
  assert.equal(stripSpecWrapperFence('   '), '   ');
  assert.equal(stripSpecWrapperFence(null), null);
  assert.equal(stripSpecWrapperFence(undefined), undefined);
});

test('an empty fenced block is left unchanged rather than reduced to nothing', () => {
  const doc = '```markdown\n```';
  assert.equal(stripSpecWrapperFence(doc), doc);
});
