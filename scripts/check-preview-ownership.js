#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collectQueryInventory } = require('./check-sql');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'src/services/preview-flow/store.js';
const ALLOWLIST = path.join(ROOT, 'src/services/preview-flow/legacy-writers.json');
const OWNED_COLUMNS = [
  'staging_url',
  'staging_container_id',
  'staging_image_ref',
  'staging_build_ref',
  'staging_runtime_kind',
  'staging_runtime_name',
  'staging_commit_sha',
];

function collectWriters(inventory, { table = 'chat_sessions', columns = OWNED_COLUMNS } = {}) {
  const writers = new Map();
  const dynamicQueries = (inventory.dynamicOccurrences || []).map(query => ({
    ...query,
    text: query.expression,
  }));
  const queries = [...inventory.queries, ...dynamicQueries];
  const updatePattern = new RegExp(
    `\\bUPDATE\\s+(?:public\\.)?${table}\\b(?:\\s+(?:AS\\s+)?\\w+)?\\s+SET\\s+`
      + '([\\s\\S]*?)(?:\\bWHERE\\b|\\bRETURNING\\b|;|$)',
    'gi',
  );
  const insertPattern = new RegExp(`\\bINSERT\\s+INTO\\s+(?:public\\.)?${table}\\s*\\(([^)]+)\\)`, 'gi');

  for (const query of queries) {
    const text = query.text.replace(/"/g, '');
    const updates = [...text.matchAll(updatePattern)];
    const inserts = [...text.matchAll(insertPattern)];
    const fields = columns.filter(column => {
      const assigned = updates.some(update => new RegExp(`(?:^|,)\\s*${column}\\s*=`, 'i').test(update[1]));
      const inserted = inserts.some(insert => new RegExp(`\\b${column}\\b`, 'i').test(insert[1]));
      return assigned || inserted;
    });
    if (!fields.length || query.source === OWNER) continue;

    const fingerprint = createHash('sha256').update(query.text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 20);
    const key = `${query.source}:${fingerprint}`;
    const existingWriter = writers.get(key);
    if (existingWriter) {
      existingWriter.count += 1;
    } else {
      writers.set(key, {
        source: query.source,
        fingerprint,
        count: 1,
        fields,
        line: query.line,
      });
    }
  }
  return [...writers.values()].sort((a, b) => `${a.source}:${a.fingerprint}`.localeCompare(`${b.source}:${b.fingerprint}`));
}

function checkDecisionOwnership(inventory) {
  const writers = [
    ...collectWriters(inventory, { table: 'preview_flows', columns: ['state'] }),
    ...collectWriters(inventory, { table: 'preview_flow_heads', columns: ['flow_id'] }),
    ...collectWriters(inventory, {
      table: 'preview_flow_resources',
      columns: ['published_at', 'cleanup_started_at', 'cleanup_completed_at', 'cleanup_disposition'],
    }),
  ];
  if (writers.length) {
    const bypass = writers[0];
    throw new Error(`Preview decision bypass at ${bypass.source}:${bypass.line}. Use the action owner.`);
  }
}

function checkOwnership(writers, allowlist) {
  const remainingExceptions = new Map(allowlist.map(entry => [`${entry.source}:${entry.fingerprint}`, entry]));
  for (const writer of writers) {
    const key = `${writer.source}:${writer.fingerprint}`;
    const exception = remainingExceptions.get(key);
    if (!exception || writer.count !== exception.count || JSON.stringify(writer.fields) !== JSON.stringify(exception.fields)) {
      throw new Error(`Preview projection bypass at ${writer.source}:${writer.line}. Use the action owner; review a temporary exception explicitly.`);
    }
    if (!exception.reason || !exception.migration) {
      throw new Error(`Preview exception ${key} needs a reason and migration target`);
    }
    remainingExceptions.delete(key);
  }

  if (remainingExceptions.size) {
    throw new Error(`Remove migrated preview writers from the allowlist: ${[...remainingExceptions.keys()].join(', ')}`);
  }
}

// This checks resolved SQL, alongside lint:sql's reviewed dynamic-query
// inventory. It is a code-ownership guard, not a separate PostgreSQL role.
if (require.main === module) {
  try {
    const inventory = collectQueryInventory();
    const writers = collectWriters(inventory);
    checkOwnership(writers, JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')));
    checkDecisionOwnership(inventory);
    console.log(`Preview projection ownership passed; ${writers.length} explicitly recorded legacy statements remain.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  collectWriters,
  checkOwnership,
  checkDecisionOwnership,
  OWNED_COLUMNS,
};
