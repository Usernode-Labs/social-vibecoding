'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const state = require('../src/services/visual-evidence-state');
const { intent } = require('./fixtures/visual-evidence');

test('visual evidence lifecycle permits only the documented progression and one repair loop', () => {
  const allowed = [
    ['planned', 'provisioning'],
    ['provisioning', 'exploring'],
    ['exploring', 'replaying'],
    ['replaying', 'reviewing'],
    ['reviewing', 'replaying'],
    ['reviewing', 'verified'],
    ['verified', 'stale'],
  ];
  for (const [from, to] of allowed) assert.doesNotThrow(() => state.assertTransition(from, to));
  for (const [from, to] of [['planned', 'verified'], ['failed', 'planned'], ['stale', 'verified'], ['cancelled', 'planned']]) {
    assert.throws(() => state.assertTransition(from, to), { code: 'invalid_evidence_transition' });
  }
});

test('terminal-state and required-evidence policy distinguish an explicit no-impact rationale', () => {
  assert.equal(state.isTerminal('verified'), true);
  assert.equal(state.isTerminal('reviewing'), false);
  const none = { version: 1, impact: 'none', rationale: 'Backend-only.', stories: [] };
  assert.equal(state.requiredForIntent(none), false);
  assert.equal(state.requiredForIntent(none, { heuristicUi: true }), true);
  assert.equal(state.requiredForIntent({ ...none, impact: 'ui' }), true);
  assert.deepEqual(state.missingIntentDetail({ headSha: 'a'.repeat(40) }), {
    version: 1,
    required: true,
    impact: null,
    rationale: null,
    claims: [],
    headSha: 'a'.repeat(40),
    reason: 'This proposal appears to change the UI but has no visual change preview declaration yet.',
  });
});

test('recordIntentInTransaction reuses its caller-owned client without reconnecting or releasing it', async () => {
  const queries = [];
  let connectCalls = 0;
  let releaseCalls = 0;
  const client = {
    async connect() {
      connectCalls += 1;
      throw new Error('a checked-out PoolClient must not be connected again');
    },
    release() { releaseCalls += 1; },
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      if (/SELECT visual_evidence_state/.test(String(sql))) {
        return {
          rows: [{
            visual_evidence_state: null,
            visual_evidence_run_id: null,
            visual_evidence_detail: null,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const result = await state.recordIntentInTransaction(
    client, 42, intent(), { headSha: 'a'.repeat(40) }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.state, 'planned');
  assert.equal(connectCalls, 0, 'the route already checked this client out');
  assert.equal(releaseCalls, 0, 'the route retains ownership of its client');
  assert.deepEqual(
    queries.map(({ sql }) => sql.trim().split(/\s+/)[0]),
    ['SELECT', 'UPDATE', 'UPDATE'],
    'only the evidence statements run inside the existing transaction'
  );
  assert.ok(!queries.some(({ sql }) => /^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())),
    'the caller owns the surrounding transaction boundary');
});

test('the UI heuristic durably enrolls a missing declaration instead of allowing a gate bypass', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      if (/SELECT visual_evidence_state/.test(String(sql))) {
        return { rows: [{ visual_evidence_state: null, visual_evidence_run_id: null, visual_evidence_detail: null }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const result = await state.requireIntentForUiChange(pool, 42, { headSha: 'b'.repeat(40) });
  assert.equal(result.changed, true);
  assert.equal(result.required, true);
  assert.equal(result.detail.headSha, 'b'.repeat(40));
  assert.match(queries[1].sql, /UPDATE visual_evidence_runs/);
  assert.match(queries[2].sql, /visual_evidence_state = 'planned'/);
  assert.equal(JSON.parse(queries[2].values[1]).required, true);
});

test('schema carries private revision-scoped runs, artifacts, session pointers and stale uniqueness', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS visual_evidence_runs/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS visual_evidence_artifacts/);
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS visual_evidence_state/);
  assert.match(schema, /idx_visual_evidence_runs_current_head[\s\S]*state NOT IN \('stale', 'cancelled'\)/);
  assert.match(schema, /COMMENT ON TABLE visual_evidence_runs IS 'staging:private'/);
  assert.match(schema, /COMMENT ON TABLE visual_evidence_artifacts IS 'staging:private'/);
});

test('public run summary includes claims and artifact metadata but no executable plan or internal fixture', () => {
  const summary = state.runSummary({
    state: 'verified', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    intent: {
      version: 1, impact: 'ui', rationale: 'Visible change',
      stories: [{
        id: 'dialog', claim: 'The dialog is usable.', persona: 'member',
        viewports: [{ name: 'desktop' }],
        intent: { steps: ['Open dialog'], animation: 'none' },
      }],
    },
    semantic_verdict: { relevant: true, focusAccurate: true, reason: 'The pair shows the dialog.' },
    trace_summary: { runs: 2, relativePointer: true },
    repair_attempt: 1, plan_hash: 'c'.repeat(64), updated_at: new Date('2026-09-17T00:00:00Z'),
    replay_plan: { secret: 'must not escape' }, fixture_fingerprint: 'private-fixture',
  }, [{ id: 'd'.repeat(32), storyId: 'dialog', side: 'base', variant: 'focus', media: 'png' }]);
  assert.equal(summary.state, 'verified');
  assert.equal(summary.claims[0].claim, 'The dialog is usable.');
  assert.equal(summary.artifactSummary.length, 1);
  assert.equal(summary.replayCount, 2);
  assert.equal(summary.repairCount, 1);
  assert.equal(summary.relativePointer, true);
  assert.equal(Object.hasOwn(summary, 'replayPlan'), false);
  assert.equal(Object.hasOwn(summary, 'fixtureFingerprint'), false);
});

test('ids and revision checks are strict', () => {
  assert.match(state.newId(), /^[0-9a-f]{32}$/);
  assert.equal(state.validSha('a'.repeat(40)), true);
  assert.equal(state.validSha('A'.repeat(40)), false);
  assert.equal(state.validSha('a'.repeat(39)), false);
});

// ── #2601/#2558: recording why a run never started ───────────────────────
test('the not-started note is fenced to a planned session and never restarts the idle clock', async () => {
  const seen = [];
  const pool = { query: async (sql, values) => { seen.push({ sql: String(sql), values }); return { rows: [{ id: 42 }] }; } };

  const written = await state.recordNotStarted(pool, 42, '  Previews are switched off here.  ');
  assert.equal(written.recorded, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].values, [42, 'Previews are switched off here.']);
  // Only while the session still reads 'planned': a run that has moved on
  // owns its own state and must not be annotated by a late refusal.
  assert.match(seen[0].sql, /visual_evidence_state = 'planned'/);
  // The idle rule the reviewer surfaces apply is measured off this column.
  // Touching it on every refusal would keep a stuck run looking fresh for
  // as long as anything kept refusing it — which is the bug, not the fix.
  assert.ok(!/visual_evidence_updated_at/.test(seen[0].sql),
    'the note must not bump the timestamp the idle rule measures');
  // The same reason twice is not a write.
  assert.match(seen[0].sql, /IS DISTINCT FROM/);
  // And it merges into the detail rather than replacing it.
  assert.match(seen[0].sql, /COALESCE\(visual_evidence_detail, '\{\}'::jsonb\)\s*\|\|/);
});

test('an empty reason or a bad session id writes nothing at all', async () => {
  const pool = { query: async () => { throw new Error('must not query'); } };
  for (const reason of ['', '   ', null, undefined]) {
    assert.deepEqual(await state.recordNotStarted(pool, 42, reason), { recorded: false });
  }
  for (const id of [0, -1, NaN, null, 'nope']) {
    assert.deepEqual(await state.recordNotStarted(pool, id, 'a reason'), { recorded: false });
  }
});

test('a run that starts drops the note the attempt before it left', async () => {
  const seen = [];
  const pool = { query: async (sql, values) => { seen.push({ sql: String(sql), values }); return { rows: [{ id: 42 }] }; } };
  assert.deepEqual(await state.clearNotStarted(pool, 42), { cleared: true });
  assert.match(seen[0].sql, /visual_evidence_detail - 'notStartedReason'/);
  // The function form, never the `?` containment operator: nothing in the
  // driver or the SQL tooling can then read it as a placeholder.
  assert.match(seen[0].sql, /jsonb_exists\(visual_evidence_detail, 'notStartedReason'\)/);
  assert.deepEqual(seen[0].values, [42]);
  assert.ok(!/visual_evidence_updated_at/.test(seen[0].sql));
});

test('a stored reason is bounded, so no log line or upstream message can grow the row', async () => {
  const seen = [];
  const pool = { query: async (_sql, values) => { seen.push(values); return { rows: [] }; } };
  await state.recordNotStarted(pool, 42, 'x'.repeat(5000));
  assert.equal(seen[0][1].length, 300);
});
