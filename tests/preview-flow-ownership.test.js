'use strict';

// test:changed: always (preview projection writes must stay with their owner)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { collectQueryInventory } = require('../scripts/check-sql');
const { collectWriters, checkOwnership } = require('../scripts/check-preview-ownership');

test('preview projection writers match the reviewed shrinking legacy inventory', () => {
  const writers = collectWriters(collectQueryInventory());
  const allowlist = JSON.parse(fs.readFileSync(require.resolve('../src/services/preview-flow/legacy-writers.json'), 'utf8'));
  checkOwnership(writers, allowlist);
  assert.ok(!writers.some(w => w.source === 'src/services/handoff-pipeline.js'));
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
  const allowed = writers.map(w => ({ ...w, reason: 'legacy fixture', migration: 'action owner' }));
  assert.doesNotThrow(() => checkOwnership(writers, allowed));
  assert.throws(() => checkOwnership([], allowed), /Remove migrated/);
  assert.throws(() => checkOwnership([{ ...writers[0], count: 2 }], allowed), /bypass/);
  const dynamic = collectWriters({ queries: [], dynamicOccurrences: [{ source: 'head.js', line: 1,
    expression: '`UPDATE chat_sessions SET ${summaryFields}, staging_url = NULL WHERE id = $1`' }] });
  assert.equal(dynamic.length, 1, 'a dynamic fragment cannot hide a literal owned assignment');
});
