#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadPlan, ensureSchema } = require('../src/db/schema-source');

function record(id, root = path.join(__dirname, '..', 'src/db')) {
  const dir = path.join(root, 'migrations');
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const number = String(manifest.migrations.length + 1).padStart(4, '0');
  if (!new RegExp(`^${number}-[a-z][a-z0-9-]*$`).test(id)) {
    throw new Error(`Migration ID must start with ${number}- and contain only lowercase letters, digits and hyphens`);
  }
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const sql = fs.readFileSync(path.join(dir, `${id}.sql`), 'utf8');
  const prefix = manifest.migrations.map(m => fs.readFileSync(path.join(dir, `${m.id}.sql`), 'utf8'));
  prefix.push(sql);
  const candidate = { ...manifest, migrations: [...manifest.migrations, {
    id, sha256: hash(sql), schemaSha256: hash(prefix.join('\n')),
  }] };
  // Validate previous checksums, every file, ordering and transaction rules
  // before writing. This tool cannot silently bless an edited old migration.
  loadPlan(dir, candidate);
  fs.writeFileSync(manifestPath, JSON.stringify(candidate, null, 2) + '\n');
  ensureSchema(dir);
}
if (require.main === module) {
  try { record(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { record };
