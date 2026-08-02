// Tests for the quick-reply pill helpers (src/routes/sessions.js, #285):
// sanitizeQuickReplies — server-side cleanup of the Mayor's suggest_replies
// tool input — and resolveQuickReplies — the same-turn co-occurrence rule
// (pills are dropped when a dispatch/scout OR suggest_answers tool_use
// co-occurs, so the row reflects the final state of the turn). Pure
// functions over tool-call shapes.
//
// Run with: node --test tests/quick-replies.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeQuickReplies,
  resolveQuickReplies,
  shouldFallbackQuickReplies,
} = require('../src/routes/sessions.js');

function input(replies) {
  return { replies };
}

test('garbage input returns null', () => {
  assert.equal(sanitizeQuickReplies(null), null);
  assert.equal(sanitizeQuickReplies(undefined), null);
  assert.equal(sanitizeQuickReplies({}), null);
  assert.equal(sanitizeQuickReplies({ replies: 'not-an-array' }), null);
  assert.equal(sanitizeQuickReplies(input([])), null);
  // Non-stringable entries (objects/arrays) are dropped, not coerced to
  // "[object Object]" — all-dropped returns null.
  assert.equal(sanitizeQuickReplies(input([{}, ['a'], null])), null);
  assert.equal(sanitizeQuickReplies(input(['  ', ''])), null);
});

test('happy path: trims and preserves order', () => {
  const out = sanitizeQuickReplies(input(['  Preview the change ', 'Propose it to the group', 'Make a tweak']));
  assert.deepEqual(out, ['Preview the change', 'Propose it to the group', 'Make a tweak']);
});

test('numbers and booleans coerce to strings', () => {
  const out = sanitizeQuickReplies(input([3, true, 'plain']));
  assert.deepEqual(out, ['3', 'true', 'plain']);
});

test('dedupes case-insensitively, keeping the first occurrence', () => {
  const out = sanitizeQuickReplies(input(['Build it', 'build it', 'BUILD IT', 'Revise the spec']));
  assert.deepEqual(out, ['Build it', 'Revise the spec']);
});

test('caps at 3 replies', () => {
  const out = sanitizeQuickReplies(input(['a', 'b', 'c', 'd', 'e']));
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('reply length is clamped to 80 chars', () => {
  const out = sanitizeQuickReplies(input(['x'.repeat(500), 'short']));
  assert.equal(out[0].length, 80);
  assert.equal(out[1], 'short');
});

test('a dropped entry does not consume a slot', () => {
  const out = sanitizeQuickReplies(input(['', 'a', {}, 'b', 'c', 'd']));
  assert.deepEqual(out, ['a', 'b', 'c']);
});

// ── resolveQuickReplies — co-occurrence rule ─────────────────────────

const REPLIES_CALL = {
  name: 'suggest_replies',
  input: input(['Preview the change', 'Propose it to the group']),
};

test('no suggest_replies call → null', () => {
  assert.equal(resolveQuickReplies([]), null);
  assert.equal(resolveQuickReplies(null), null);
  assert.equal(resolveQuickReplies([{ name: 'dispatch_claude_code', input: {} }]), null);
});

test('pure reply turn keeps sanitized pills', () => {
  assert.deepEqual(resolveQuickReplies([REPLIES_CALL]), ['Preview the change', 'Propose it to the group']);
});

test('pills are dropped when a dispatch or scout tool co-occurs', () => {
  for (const dispatchName of ['dispatch_claude_code', 'dispatch_scout']) {
    assert.equal(
      resolveQuickReplies([REPLIES_CALL, { name: dispatchName, input: { prompt: 'go' } }]),
      null
    );
  }
});

test('pills are dropped when suggest_answers co-occurs (answer chips win)', () => {
  assert.equal(
    resolveQuickReplies([
      REPLIES_CALL,
      { name: 'suggest_answers', input: { questions: [{ question: 'Which?', answers: ['a'] }] } },
    ]),
    null
  );
});

test('read-only issue data tools do not drop pills', () => {
  assert.deepEqual(
    resolveQuickReplies([{ name: 'list_github_issues', input: {} }, REPLIES_CALL]),
    ['Preview the change', 'Propose it to the group']
  );
});

test('malformed suggest_replies input resolves to null', () => {
  assert.equal(resolveQuickReplies([{ name: 'suggest_replies', input: { replies: 'nope' } }]), null);
});

// ── shouldFallbackQuickReplies — the #894 substitution rule ──────────
//
// Whether a phase-1 turn that produced no pills gets the deterministic
// fallback set. The pill sets themselves live in services/recovery-pills.js
// (tests/quick-reply-fallback.test.js); this is only the "does it apply"
// half.

const SUGGESTIONS = [{ question: 'Which?', answers: ['a', 'b'] }];

test('a bare chat turn gets the fallback', () => {
  assert.equal(shouldFallbackQuickReplies(null, null, []), true);
  assert.equal(shouldFallbackQuickReplies(null, null, null), true);
  // Data tools are read-only and end the turn as a chat reply — they must
  // not suppress the fallback (mirrors the resolveQuickReplies rule above).
  assert.equal(
    shouldFallbackQuickReplies(null, null, [{ name: 'list_github_issues', input: {} }]),
    true
  );
});

test('the model\'s own pills always win over the fallback', () => {
  assert.equal(shouldFallbackQuickReplies(['Build it'], null, []), false);
  // Degenerate shapes are "no pills", so they still get the fallback —
  // otherwise an empty array would produce an empty bar.
  assert.equal(shouldFallbackQuickReplies([], null, []), true);
});

test('an answer-chip turn gets NO fallback (inline chips own the turn)', () => {
  assert.equal(shouldFallbackQuickReplies(null, SUGGESTIONS, []), false);
  assert.equal(
    shouldFallbackQuickReplies(null, SUGGESTIONS, [{ name: 'suggest_answers', input: {} }]),
    false
  );
  // An empty suggestions array means the chips never rendered — fall back.
  assert.equal(shouldFallbackQuickReplies(null, [], []), true);
});

test('a dispatch turn gets NO fallback (phase-2 owns its pills)', () => {
  for (const dispatchName of ['dispatch_claude_code', 'dispatch_scout']) {
    assert.equal(
      shouldFallbackQuickReplies(null, null, [{ name: dispatchName, input: { prompt: 'go' } }]),
      false,
      `${dispatchName} defers to the phase-2 wrap-up`
    );
  }
  // Null entries in the tool list must not throw.
  assert.equal(shouldFallbackQuickReplies(null, null, [null, undefined, {}]), true);
});
