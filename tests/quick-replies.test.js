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

// #1001: the dispatch-preamble row now KEEPS the Mayor's pills, so the
// phase-1 call site opts in with { allowWithDispatch: true }. Nothing goes
// stale — the phase-2 wrap-up row is newer and the client's backward scan
// finds it first — and a turn that dies mid-dispatch is left with
// conversation-specific pills instead of the client's generic default.
test('allowWithDispatch keeps a preamble\'s pills, and the default does not', () => {
  for (const dispatchName of ['dispatch_claude_code', 'dispatch_scout']) {
    const calls = [REPLIES_CALL, { name: dispatchName, input: { prompt: 'go' } }];
    // Default: byte-identical to the pre-#1001 behaviour.
    assert.equal(resolveQuickReplies(calls), null);
    assert.equal(resolveQuickReplies(calls, {}), null);
    assert.equal(resolveQuickReplies(calls, { allowWithDispatch: false }), null);
    // Opted in: the sanitized set survives.
    assert.deepEqual(resolveQuickReplies(calls, { allowWithDispatch: true }),
      ['Preview the change', 'Propose it to the group']);
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

// The clarifying-question exclusion is NOT relaxed by allowWithDispatch —
// answer chips own their turn's affordance under both modes.
test('answer chips beat pills even with allowWithDispatch', () => {
  const calls = [
    REPLIES_CALL,
    { name: 'suggest_answers', input: { questions: [{ question: 'Which?', answers: ['a'] }] } },
    { name: 'dispatch_claude_code', input: { prompt: 'go' } },
  ];
  assert.equal(resolveQuickReplies(calls, { allowWithDispatch: true }), null);
  assert.equal(resolveQuickReplies(calls), null);
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

// ── isGenericPillSet — the #1001 all-boilerplate detector ────────────
//
// The trigger for enforcement. Deliberately narrow: it rejects a set only
// when NOTHING in it names anything about the conversation. "Propose it to
// the group" really is the right first pill after a build, so a mixed set
// must pass — otherwise the detector would fight the composition rule it
// exists to enforce.

const { isGenericPillSet, normalizePill, RECOVERY_PILLS: POLICY_SETS } =
  require('../src/services/recovery-pills.js');

test('an all-boilerplate set is generic', () => {
  assert.equal(isGenericPillSet(
    ['Preview the change', 'Propose it to the group', 'Make another tweak']), true,
  'the most-parroted production set');
  assert.equal(isGenericPillSet(
    ['Build it', 'Revise the spec', 'What will this change?']), true);
  assert.equal(isGenericPillSet(
    ['Make a change', "What issues are open right now?", "What's the current state?"]), true);
  // Every set the platform itself ships is by definition generic.
  for (const [kind, pills] of Object.entries(POLICY_SETS)) {
    assert.equal(isGenericPillSet([...pills]), true, `RECOVERY_PILLS.${kind}`);
  }
});

test('one specific pill is enough to pass', () => {
  assert.equal(isGenericPillSet(
    ['Preview the Season 1 default', 'Propose it to the group', 'Make another tweak']), false,
  'a set that names the change is not generic, even with two generic siblings');
  assert.equal(isGenericPillSet(['Build the avatar upload flow']), false);
  assert.equal(isGenericPillSet(['Propose it to the group', 'Also fix the sub-event tabs']), false);
});

test('detection ignores case and trailing punctuation', () => {
  assert.equal(isGenericPillSet(['build it', 'REVISE THE SPEC']), true);
  assert.equal(isGenericPillSet(['Build it.', 'Revise the spec!']), true);
  assert.equal(isGenericPillSet(["What's the current state"]), true,
    'the same phrase without its question mark is still boilerplate');
  assert.equal(isGenericPillSet(['  Propose it to the group  ']), true);
});

test('an empty or absent set is "missing", not "generic"', () => {
  // Callers already handle missing pills as their own case; conflating the
  // two would make the ladder skip rung 1 for a reason that doesn't apply.
  assert.equal(isGenericPillSet([]), false);
  assert.equal(isGenericPillSet(null), false);
  assert.equal(isGenericPillSet(undefined), false);
  assert.equal(isGenericPillSet('Build it'), false);
});

test('normalizePill is total over junk input', () => {
  assert.equal(normalizePill(null), '');
  assert.equal(normalizePill(undefined), '');
  assert.equal(normalizePill(42), '42');
  assert.equal(normalizePill('  a   b  '), 'a b');
});
