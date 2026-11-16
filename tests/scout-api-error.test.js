// #1204 — "Often getting spec result of 'API Error: Connection lost
// mid-response. The response above may be incomplete.'"
//
// A scout turn's product is the agent's FINAL message: the host stores it
// verbatim as the session's spec doc. When the Anthropic stream drops
// mid-answer, Claude Code exhausts its own retries and closes the turn with
// that notice as its last words — while still exiting 0 and writing its
// __USERNODE_RESULT__ line, so nothing downstream of the exit code notices.
// The notice was then persisted AS the spec: it overwrote the previous
// draft and froze as an immutable version in chat_session_specs.
//
// Covered here: agentApiFailure (src/services/agent-result-text.js), the
// anchored detector Homeroom bot's spec and build turns read before they
// keep a final message (services/homeroom-bot-live.js), including the
// false-positive cases it must NOT fire on.
//
// Run with: node --test tests/scout-api-error.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { agentApiFailure } = require('../src/services/agent-result-text');

// ── The detector ────────────────────────────────────────────────────────

const CONNECTION_LOST =
  'API Error: Connection lost mid-response. The response above may be incomplete.';

const REAL_SPEC = [
  '# Cache the app manifest',
  '',
  '## User-facing changes',
  '',
  'Apps open faster on a warm cache.',
  '',
  '## Technical implementation',
  '',
  '`src/services/app-manifest.js` grows a 60s memo.',
].join('\n');

test('the reported message is caught as a whole-message API failure', () => {
  const failure = agentApiFailure(CONNECTION_LOST);
  assert.equal(failure.kind, 'api_error');
  assert.match(failure.line, /Connection lost mid-response/);
});

test('other API Error shapes are caught too', () => {
  for (const text of [
    'API Error: 500 {"type":"error","error":{"type":"api_error"}}',
    'API Error (Request timed out.)',
    '  ⎿  API Error: Connection error.',
    'api error: overloaded_error',
  ]) {
    assert.ok(agentApiFailure(text), `expected a failure for: ${text}`);
  }
});

test('bare one-line transport notices are caught', () => {
  assert.equal(agentApiFailure('Connection error.').kind, 'api_error');
  assert.equal(agentApiFailure('Request timed out').kind, 'api_error');
});

test('partial content followed by the truncation notice is "truncated"', () => {
  const partial = `${REAL_SPEC}\n\n${CONNECTION_LOST}`;
  const failure = agentApiFailure(partial);
  assert.equal(failure.kind, 'truncated');
});

test('a real spec is never flagged', () => {
  assert.equal(agentApiFailure(REAL_SPEC), null);
  assert.equal(agentApiFailure(''), null);
  assert.equal(agentApiFailure(null), null);
  assert.equal(agentApiFailure(undefined), null);
});

test('a spec that DISCUSSES API errors is never flagged', () => {
  // The whole point of anchoring to the first/last line: a spec about error
  // handling quotes these strings legitimately, and eating it would be a
  // worse bug than the one this detector fixes.
  const spec = [
    '# Surface API failures in the dev chat',
    '',
    '## User-facing changes',
    '',
    'Instead of a blank card, the chat says what broke.',
    '',
    '## Technical implementation',
    '',
    'The runtime emits `API Error: Connection lost mid-response. The response',
    'above may be incomplete.` as its final assistant message; detect it and',
    'render the failure state.',
    '',
    '### Considerations',
    '',
    'Connection error. handling stays in one place.',
  ].join('\n');
  assert.equal(agentApiFailure(spec), null);
});

test('a bare trailing "API Error" line without transport wording is left alone', () => {
  // The trailing-line rule needs the runtime's own incomplete/lost/aborted
  // wording — a document that simply ends on a sentence about API errors is
  // still a document.
  const spec = `${REAL_SPEC}\n\nAPI Error handling is out of scope for this change.`;
  assert.equal(agentApiFailure(spec), null);
});

test('long notices are clipped rather than pasted whole into the chat', () => {
  const failure = agentApiFailure(`API Error: ${'x'.repeat(500)}`);
  assert.ok(failure.line.length <= 200);
  assert.ok(failure.line.endsWith('…'));
});
