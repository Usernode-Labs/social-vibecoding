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

test('unwraps a 3-backtick markdown wrapper with a BALANCED inner 3-backtick block (sessions 106/151)', () => {
  // The whole doc is wrapped in ```markdown and contains one complete inner
  // ```js…``` block. The wrapper closer is the document's last line and the
  // inner fences balance, so the boundary is unambiguous → unwrap.
  const inner = '# Spec\n\n```js\nconst x = 1;\n```\n\nmore spec';
  const doc = '```markdown\n' + inner + '\n```';
  assert.equal(stripSpecWrapperFence(doc), inner);
});

test('does NOT unwrap when an inner fence is left unbalanced', () => {
  // After pairing inner fences we are still "inside" a block at the last line,
  // so the document's final ``` was closing that inner block, not the wrapper.
  const doc = '```markdown\n# Spec\n\n```js\nconst x = 1;\n```';
  assert.equal(stripSpecWrapperFence(doc), doc);
});

test('unwraps a ```filepath:SPEC.md file-emission wrapper (session 230)', () => {
  const wrapped = '```filepath:SPEC.md\n' + SPEC + '\n```';
  assert.equal(stripSpecWrapperFence(wrapped), SPEC);
});

test('unwraps a bare markdown-file-path wrapper but not a non-markdown one', () => {
  assert.equal(stripSpecWrapperFence('```notes.md\n' + SPEC + '\n```'), SPEC);
  const json = '```filepath:data.json\n{"a":1}\n```';
  assert.equal(stripSpecWrapperFence(json), json);
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
