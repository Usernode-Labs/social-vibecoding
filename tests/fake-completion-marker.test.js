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
  advanceSharedReviewAfterSync,
  CODING_AGENT_COMPLETED_MARKER,
} = require('../src/routes/sessions.js');

const M = CODING_AGENT_COMPLETED_MARKER; // '[CODING AGENT COMPLETED]'

test('a successful web sync advances a shared CLI proposal review without changing provenance', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1, rows: [{ reviewed_head_sha: params[0] }] };
  } };
  const session = {
    id: 7,
    source: 'cli_handoff',
    handoff_head_sha: 'a'.repeat(40),
    checks_commit_sha: 'b'.repeat(40),
    reviewed_head_sha: 'b'.repeat(40),
  };
  const synced = { syncResult: 'clean', pushOk: true, sha: 'c'.repeat(40) };
  assert.equal(await advanceSharedReviewAfterSync(pool, session, synced), true);
  assert.equal(session.source, 'cli_handoff');
  assert.equal(session.checks_commit_sha, synced.sha);
  assert.equal(session.reviewed_head_sha, synced.sha);
  assert.match(calls[0].sql, /UPDATE chat_sessions[\s\S]*checks_commit_sha = \$1/);
  assert.match(calls[0].sql, /reviewed_head_sha = CASE/);
  assert.match(calls[0].sql, /UPDATE pr_votes SET head_sha = \$1/);
  assert.match(calls[0].sql,
    /checks_commit_sha IS NOT DISTINCT FROM \$4::varchar/,
    'the sync cannot overwrite a checked head advanced by another reconciler');
  assert.deepEqual(calls[0].params, [
    synced.sha, 7, 'b'.repeat(40), 'b'.repeat(40),
  ]);
});

test('a sync finishing after withdrawal cannot move the archived handoff review', async () => {
  const session = {
    id: 7,
    source: 'cli_handoff',
    handoff_head_sha: 'a'.repeat(40),
    checks_commit_sha: 'b'.repeat(40),
    reviewed_head_sha: 'b'.repeat(40),
  };
  const pool = { query: async (sql) => {
    assert.match(sql, /status IN \('active', 'promoted', 'merging'\)/);
    return { rowCount: 0, rows: [] };
  } };
  assert.equal(await advanceSharedReviewAfterSync(pool, session, {
    syncResult: 'clean', pushOk: true, sha: 'c'.repeat(40),
  }), false);
  assert.equal(session.checks_commit_sha, 'b'.repeat(40));
  assert.equal(session.reviewed_head_sha, 'b'.repeat(40));
});

test('a sync result cannot overwrite a concurrently advanced checked head', async () => {
  const session = {
    id: 7,
    source: 'cli_handoff',
    handoff_head_sha: 'a'.repeat(40),
    checks_commit_sha: 'b'.repeat(40),
    reviewed_head_sha: null,
  };
  const pool = { query: async (sql, params) => {
    assert.match(sql, /checks_commit_sha IS NOT DISTINCT FROM \$4::varchar/);
    assert.equal(params[3], session.checks_commit_sha);
    return { rowCount: 0, rows: [] };
  } };
  assert.equal(await advanceSharedReviewAfterSync(pool, session, {
    syncResult: 'resolved', pushOk: true, sha: 'c'.repeat(40),
  }), false);
  assert.equal(session.checks_commit_sha, 'b'.repeat(40));
});

test('failed syncs and ordinary native sessions do not move the reviewed head', async () => {
  const pool = { query: async () => { throw new Error('must not query'); } };
  assert.equal(await advanceSharedReviewAfterSync(
    pool,
    { id: 7, source: 'cli_handoff' },
    { syncResult: 'conflict', pushOk: false, sha: null }
  ), false);
  assert.equal(await advanceSharedReviewAfterSync(
    pool,
    { id: 8, source: 'native' },
    { syncResult: 'clean', pushOk: true, sha: 'c'.repeat(40) }
  ), false);
  assert.equal(await advanceSharedReviewAfterSync(
    pool,
    { id: 9, source: 'cli_handoff' },
    { syncResult: 'clean', pushOk: true, sha: 'not-a-commit' }
  ), false);
});

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

test('buildMayorMessages labels native CLI summaries as local-agent handoffs', () => {
  const out = buildMayorMessages([
    { role: 'user', content: 'Build it locally.' },
    {
      role: 'assistant',
      content: 'Implemented and tested the feature.',
      metadata: { handoffSummary: true, phase: 'build' },
    },
  ]);
  assert.equal(out[1].role, 'assistant');
  assert.match(out[1].content, /^\[LOCAL AGENT HANDOFF — build\]\n/);
  assert.match(out[1].content, /Implemented and tested/);
});
