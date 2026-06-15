// Tests for the Q/A-mode suggestion helpers (src/routes/sessions.js, #32):
// sanitizeSuggestedAnswers — server-side cleanup of the Mayor's
// suggest_answers tool input — and resolveSuggestedAnswers — the
// same-turn co-occurrence rule (a dispatch/scout tool_use wins and the
// suggestions are dropped). Pure functions over tool-call shapes.
//
// Run with: node --test tests/qa-suggestions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSuggestedAnswers, resolveSuggestedAnswers } = require('../src/routes/sessions.js');

function input(questions) {
  return { questions };
}

test('garbage input returns null', () => {
  assert.equal(sanitizeSuggestedAnswers(null), null);
  assert.equal(sanitizeSuggestedAnswers(undefined), null);
  assert.equal(sanitizeSuggestedAnswers({}), null);
  assert.equal(sanitizeSuggestedAnswers({ questions: 'not-an-array' }), null);
  assert.equal(sanitizeSuggestedAnswers(input([])), null);
  assert.equal(sanitizeSuggestedAnswers(input([null, 42, 'string', []])), null);
});

test('groups with no usable answers are dropped; all-dropped returns null', () => {
  assert.equal(sanitizeSuggestedAnswers(input([{ question: 'Which?', answers: [] }])), null);
  assert.equal(sanitizeSuggestedAnswers(input([{ question: 'Which?', answers: ['  ', ''] }])), null);
  assert.equal(sanitizeSuggestedAnswers(input([{ question: 'Which?' }])), null);
  // Non-string answers (objects/arrays) are dropped rather than coerced
  // to "[object Object]".
  assert.equal(sanitizeSuggestedAnswers(input([{ question: 'Which?', answers: [{}, ['a']] }])), null);
});

test('happy path: trims, keeps order, preserves question labels', () => {
  const out = sanitizeSuggestedAnswers(input([
    { question: '  Which theme?  ', answers: ['  Dark ', 'Light', 'Match system'] },
  ]));
  assert.deepEqual(out, [
    { question: 'Which theme?', answers: ['Dark', 'Light', 'Match system'] },
  ]);
});

test('numbers and booleans coerce to strings; empty question allowed', () => {
  const out = sanitizeSuggestedAnswers(input([
    { question: '', answers: [3, true, 'plain'] },
  ]));
  assert.deepEqual(out, [{ question: '', answers: ['3', 'true', 'plain'] }]);
});

test('caps at 3 questions and 5 answers per question', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    question: `Q${i + 1}`,
    answers: Array.from({ length: 9 }, (_, j) => `A${j + 1}`),
  }));
  const out = sanitizeSuggestedAnswers(input(many));
  assert.equal(out.length, 3);
  for (const group of out) assert.equal(group.answers.length, 5);
  assert.equal(out[0].question, 'Q1');
  assert.equal(out[2].question, 'Q3');
});

test('a dropped group does not consume a question slot', () => {
  const out = sanitizeSuggestedAnswers(input([
    { question: 'bad', answers: [] },
    { question: 'Q1', answers: ['a'] },
    { question: 'Q2', answers: ['b'] },
    { question: 'Q3', answers: ['c'] },
  ]));
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((g) => g.question), ['Q1', 'Q2', 'Q3']);
});

test('answer and question lengths are clamped', () => {
  const out = sanitizeSuggestedAnswers(input([
    { question: 'q'.repeat(500), answers: ['a'.repeat(500), 'short'] },
  ]));
  assert.equal(out[0].question.length, 200);
  assert.equal(out[0].answers[0].length, 80);
  assert.equal(out[0].answers[1], 'short');
});

// ── resolveSuggestedAnswers — co-occurrence rule ─────────────────────

const SUGGEST_CALL = {
  name: 'suggest_answers',
  input: input([{ question: 'Which?', answers: ['Top bar', 'App header'] }]),
};

test('no suggest_answers call → null, not dropped', () => {
  assert.deepEqual(resolveSuggestedAnswers([]), { suggestions: null, droppedForDispatch: false });
  assert.deepEqual(resolveSuggestedAnswers(null), { suggestions: null, droppedForDispatch: false });
  assert.deepEqual(
    resolveSuggestedAnswers([{ name: 'dispatch_claude_code', input: { prompt: 'build it' } }]),
    { suggestions: null, droppedForDispatch: false }
  );
});

test('pure question turn keeps sanitized suggestions', () => {
  const { suggestions, droppedForDispatch } = resolveSuggestedAnswers([SUGGEST_CALL]);
  assert.equal(droppedForDispatch, false);
  assert.deepEqual(suggestions, [{ question: 'Which?', answers: ['Top bar', 'App header'] }]);
});

test('suggestions are dropped when a dispatch or scout tool co-occurs', () => {
  for (const dispatchName of ['dispatch_claude_code', 'dispatch_scout']) {
    const { suggestions, droppedForDispatch } = resolveSuggestedAnswers([
      SUGGEST_CALL,
      { name: dispatchName, input: { prompt: 'do the thing' } },
    ]);
    assert.equal(suggestions, null);
    assert.equal(droppedForDispatch, true);
  }
});

test('read-only issue data tools do not drop suggestions', () => {
  const { suggestions, droppedForDispatch } = resolveSuggestedAnswers([
    { name: 'list_github_issues', input: {} },
    SUGGEST_CALL,
  ]);
  assert.equal(droppedForDispatch, false);
  assert.deepEqual(suggestions, [{ question: 'Which?', answers: ['Top bar', 'App header'] }]);
});

test('malformed suggest_answers input resolves to null without the dropped flag', () => {
  const { suggestions, droppedForDispatch } = resolveSuggestedAnswers([
    { name: 'suggest_answers', input: { questions: 'nope' } },
  ]);
  assert.equal(suggestions, null);
  assert.equal(droppedForDispatch, false);
});
