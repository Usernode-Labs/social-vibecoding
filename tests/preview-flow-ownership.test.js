'use strict';

// test:changed: always (preview projection writes must stay with their owner)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { collectQueryInventory } = require('../scripts/check-sql');
const { collectWriters, checkOwnership, checkDecisionOwnership } = require('../scripts/check-preview-ownership');

test('preview projection writers match the reviewed shrinking legacy inventory', () => {
  const inventory = collectQueryInventory();
  const writers = collectWriters(inventory);
  const allowlist = JSON.parse(fs.readFileSync(require.resolve('../src/services/preview-flow/legacy-writers.json'), 'utf8'));
  checkOwnership(writers, allowlist);
  checkDecisionOwnership(inventory);
  assert.ok(!writers.some(writer => writer.source === 'src/services/handoff-pipeline.js'));
});

test('supersession and retirement writes belong to the action store; queue scheduling remains in execution', () => {
  for (const text of [
    "UPDATE preview_flows SET state = 'superseded' WHERE id = $1",
    'INSERT INTO preview_flow_heads (session_id, flow_id) VALUES ($1,$2)',
    'UPDATE preview_flow_resources SET published_at = NOW() WHERE flow_id = $1',
    'UPDATE public."preview_flow_resources" AS r SET "cleanup_started_at" = NOW() WHERE flow_id = $1',
    'UPDATE preview_flow_resources SET cleanup_completed_at = NOW(), cleanup_disposition = $2 WHERE flow_id = $1',
    'INSERT INTO preview_flow_resources (flow_id, cleanup_started_at) VALUES ($1,NOW())',
  ]) {
    assert.throws(() => checkDecisionOwnership({
      queries: [{ source: 'executor.js', line: 1, text }],
    }), /decision bypass/);
  }

  assert.doesNotThrow(() => checkDecisionOwnership({
    queries: [{
      source: 'src/services/preview-flow/cleanup.js',
      line: 1,
      text: 'UPDATE preview_flow_resources SET cleanup_queue_position = DEFAULT WHERE flow_id = $1',
    }],
  }));
  assert.doesNotThrow(() => checkDecisionOwnership({
    queries: [{
      source: 'src/services/preview-flow/store.js',
      line: 1,
      text: "UPDATE preview_flows SET state = 'superseded' WHERE id = $1",
    }],
  }));
  assert.throws(() => checkDecisionOwnership({
    queries: [],
    dynamicOccurrences: [{
      source: 'executor.js',
      line: 1,
      expression: '`UPDATE preview_flow_resources SET ${patch}, cleanup_started_at = NOW() WHERE flow_id = $1`',
    }],
  }), /decision bypass/);
});

test('ownership inventory recognizes updates, inserts, aliases and quoted columns', () => {
  const queries = [
    { source: 'new.js', line: 1, text: 'UPDATE chat_sessions SET staging_url = $1 WHERE id = $2' },
    { source: 'new.js', line: 2, text: 'UPDATE public."chat_sessions" AS cs SET "staging_runtime_name" = $1 WHERE id = $2' },
    { source: 'new.js', line: 3, text: 'INSERT INTO chat_sessions (status, staging_image_ref) VALUES ($1,$2)' },
  ];
  const writers = collectWriters({ queries });
  assert.equal(writers.length, 3);
  assert.throws(() => checkOwnership(writers, []), /Preview projection bypass/);
  const allowed = writers.map(writer => ({ ...writer, reason: 'legacy fixture', migration: 'action owner' }));
  assert.doesNotThrow(() => checkOwnership(writers, allowed));
  assert.throws(() => checkOwnership([], allowed), /Remove migrated/);
  assert.throws(() => checkOwnership([{ ...writers[0], count: 2 }], allowed), /bypass/);
  const dynamic = collectWriters({
    queries: [],
    dynamicOccurrences: [{
      source: 'head.js',
      line: 1,
      expression: '`UPDATE chat_sessions SET ${summaryFields}, staging_url = NULL WHERE id = $1`',
    }],
  });
  assert.equal(dynamic.length, 1, 'a dynamic fragment cannot hide a literal owned assignment');
});
