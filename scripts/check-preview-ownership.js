#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collectQueryInventory } = require('./check-sql');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'src/services/preview-flow/store.js';
const ALLOWLIST = path.join(ROOT, 'src/services/preview-flow/legacy-writers.json');
const OWNED_COLUMNS = ['staging_url', 'staging_container_id', 'staging_image_ref',
  'staging_build_ref', 'staging_runtime_kind', 'staging_runtime_name', 'staging_commit_sha'];

function collectWriters(inventory) {
  const writers = new Map();
  for (const query of [...inventory.queries,
    ...(inventory.dynamicOccurrences || []).map(q => ({ ...q, text: q.expression }))]) {
    const text = query.text.replace(/"/g, '');
    const updates = [...text.matchAll(/\bUPDATE\s+(?:public\.)?chat_sessions\b(?:\s+(?:AS\s+)?\w+)?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;|$)/gi)];
    const inserts = [...text.matchAll(/\bINSERT\s+INTO\s+(?:public\.)?chat_sessions\s*\(([^)]+)\)/gi)];
    const fields = OWNED_COLUMNS.filter(column => updates.some(update =>
      new RegExp(`(?:^|,)\\s*${column}\\s*=`, 'i').test(update[1]))
      || inserts.some(insert => new RegExp(`\\b${column}\\b`, 'i').test(insert[1])));
    if (!fields.length || query.source === OWNER) continue;
    const fingerprint = createHash('sha256').update(query.text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 20);
    const key = `${query.source}:${fingerprint}`;
    const found = writers.get(key);
    if (found) found.count += 1;
    else writers.set(key, { source: query.source, fingerprint, count: 1, fields, line: query.line });
  }
  return [...writers.values()].sort((a, b) => `${a.source}:${a.fingerprint}`.localeCompare(`${b.source}:${b.fingerprint}`));
}

function checkOwnership(writers, allowlist) {
  const expected = new Map(allowlist.map(entry => [`${entry.source}:${entry.fingerprint}`, entry]));
  for (const writer of writers) {
    const key = `${writer.source}:${writer.fingerprint}`;
    const known = expected.get(key);
    if (!known || writer.count !== known.count || JSON.stringify(writer.fields) !== JSON.stringify(known.fields)) {
      throw new Error(`Preview projection bypass at ${writer.source}:${writer.line}. Use the action owner; review a temporary exception explicitly.`);
    }
    if (!known.reason || !known.migration) throw new Error(`Preview exception ${key} needs a reason and migration target`);
    expected.delete(key);
  }
  if (expected.size) throw new Error(`Remove migrated preview writers from the allowlist: ${[...expected.keys()].join(', ')}`);
}

// This checks resolved SQL, alongside lint:sql's reviewed dynamic-query
// inventory. It is a code-ownership guard, not a separate PostgreSQL role.
if (require.main === module) {
  try {
    const writers = collectWriters(collectQueryInventory());
    checkOwnership(writers, JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')));
    console.log(`Preview projection ownership passed; ${writers.length} explicitly recorded legacy statements remain.`);
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}

module.exports = { collectWriters, checkOwnership, OWNED_COLUMNS };
