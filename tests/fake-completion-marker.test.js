// Unit tests for the #358 fix: the "[CODING AGENT COMPLETED]" chat marker
// must never originate from the Mayor itself, and the harness's own
// fold-in label must reflect the real run outcome.
//
//  - stripFakeCompletionMarker: removes a hallucinated completion marker
//    (and everything after it) from Mayor-authored text, leaving
//    marker-free text untouched.
//  - buildMayorMessages: folds a REAL coding-agent run under the completed
//    marker, but labels no-op / error runs distinctly so the Mayor never
//    sees a "completed" entry for work that never landed.
//
// Both are pure functions exported from src/routes/sessions.js.
//
// Run with: node --test tests/fake-completion-marker.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stripFakeCompletionMarker,
  buildMayorMessages,
  CODING_AGENT_COMPLETED_MARKER,
} = require('../src/routes/sessions.js');

const M = CODING_AGENT_COMPLETED_MARKER; // '[CODING AGENT COMPLETED]'

test('stripFakeCompletionMarker leaves marker-free text unchanged', () => {
  const text = 'I can build that — want me to dispatch the coding agent?';
  assert.equal(stripFakeCompletionMarker(text), text);
});

test('stripFakeCompletionMarker removes the marker and everything after it', () => {
  const text = `Sure, here's what I did.\n\n${M}:\nAdded the widget and a test.`;
  assert.equal(stripFakeCompletionMarker(text), "Sure, here's what I did.");
});

test('stripFakeCompletionMarker on a marker-only message returns empty string', () => {
  assert.equal(stripFakeCompletionMarker(`${M}:`), '');
  assert.equal(stripFakeCompletionMarker(`${M}:\nfabricated summary`), '');
});

test('stripFakeCompletionMarker is case-insensitive', () => {
  const text = 'Done. [coding agent completed]: fake stuff';
  assert.equal(stripFakeCompletionMarker(text), 'Done.');
});

test('stripFakeCompletionMarker tolerates non-string input', () => {
  assert.equal(stripFakeCompletionMarker(null), '');
  assert.equal(stripFakeCompletionMarker(undefined), '');
});

test('buildMayorMessages folds a successful CC run under the completed marker', () => {
  const out = buildMayorMessages([
    { role: 'user', content: 'add a widget' },
    { role: 'system', metadata: { ccOutput: 'Added the widget.', ccOutcome: 'success' } },
  ]);
  assert.deepEqual(out[0], { role: 'user', content: 'add a widget' });
  assert.equal(out[1].role, 'assistant');
  assert.ok(out[1].content.startsWith(`${M}:\n`));
  assert.match(out[1].content, /Added the widget\./);
});

test('buildMayorMessages keeps the legacy completed label when ccOutcome is absent', () => {
  const out = buildMayorMessages([
    { role: 'system', metadata: { ccOutput: 'Legacy run summary.' } },
  ]);
  assert.ok(out[0].content.startsWith(`${M}:\n`));
});

test('buildMayorMessages labels a no-op run distinctly (not "completed")', () => {
  const out = buildMayorMessages([
    { role: 'system', metadata: { ccOutput: 'Nothing needed changing.', ccOutcome: 'no_changes' } },
  ]);
  assert.match(out[0].content, /^\[CODING AGENT RAN — NO CHANGES\]:/);
  assert.ok(!out[0].content.includes(M));
});

test('buildMayorMessages labels an errored run distinctly (not "completed")', () => {
  const out = buildMayorMessages([
    { role: 'system', metadata: { ccOutput: 'Worker crashed.', ccOutcome: 'error' } },
  ]);
  assert.match(out[0].content, /^\[CODING AGENT FAILED\]:/);
  assert.ok(!out[0].content.includes(M));
});

test('buildMayorMessages merges a CC fold-in into the preceding assistant turn', () => {
  const out = buildMayorMessages([
    { role: 'assistant', content: 'Working on it.' },
    { role: 'system', metadata: { ccOutput: 'Done.', ccOutcome: 'success' } },
  ]);
  // Consecutive assistant rows are merged to preserve alternating roles.
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.match(out[0].content, /Working on it\./);
  assert.match(out[0].content, new RegExp(M.replace(/[[\]]/g, '\\$&')));
});
