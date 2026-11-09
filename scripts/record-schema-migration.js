#!/usr/bin/env node
'use strict';

// Records schema migrations in src/db/migrations/manifest.json.
//
//   node scripts/record-schema-migration.js <name>
//     Appends src/db/migrations/<name>.sql to the history.
//   node scripts/record-schema-migration.js --onto <ref>
//     Rebuilds the history as <ref>'s (main's) followed by this branch's own
//     migrations, recorded again on top of it. This is how a manifest
//     conflict is resolved, by a person or by Homeroom's sync; the manifest
//     is never merged by hand.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { loadPlan, ensureSchema, NAME } = require('../src/db/schema-source');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sqlOf = (dir, id) => fs.readFileSync(path.join(dir, `${id}.sql`), 'utf8');

// The manifest with one more migration on the end, its history checksum
// covering every migration before it.
function append(dir, manifest, id) {
  const sql = sqlOf(dir, id);
  const prefix = manifest.migrations.map(m => sqlOf(dir, m.id));
  prefix.push(sql);
  return { ...manifest, migrations: [...manifest.migrations, {
    id, sha256: hash(sql), schemaSha256: hash(prefix.join('\n')),
  }] };
}

// Validate previous checksums, every file, IDs and transaction rules before
// writing. This tool cannot silently bless an edited old migration.
function write(dir, candidate) {
  loadPlan(dir, candidate);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(candidate, null, 2) + '\n');
  ensureSchema(dir);
}

function record(id, root = path.join(__dirname, '..', 'src/db')) {
  const dir = path.join(root, 'migrations');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  // A name, not a number: the manifest keeps the order, and a number would
  // be wrong as soon as another branch records first.
  if (!NAME.test(id)) {
    throw new Error('Name the migration for what it does: lowercase letters, digits and hyphens, starting with a letter (no number; the manifest keeps the order)');
  }
  if (manifest.migrations.some(m => m.id === id)) throw new Error(`Migration ${id} is already recorded`);
  write(dir, append(dir, manifest, id));
}

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// This branch's versions of the manifest: the working tree's when it is
// whole, else both sides of the conflict git left in the index (a merge's
// and a rebase's sides are swapped, so both are read).
function branchVersions(dir) {
  try { return [JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))]; }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const sides = [];
  for (const stage of [2, 3]) {
    try { sides.push(JSON.parse(git(dir, ['show', `:${stage}:./manifest.json`]))); }
    catch { /* that side deleted the file, or there is no conflict */ }
  }
  if (!sides.length) throw new Error('manifest.json is not valid JSON and git has no conflict versions of it');
  return sides;
}

function onto(ref, root = path.join(__dirname, '..', 'src/db')) {
  const dir = path.join(root, 'migrations');
  const base = JSON.parse(git(dir, ['show', `${ref}:./manifest.json`]));
  const known = new Set(base.migrations.map(m => m.id));
  const own = [];
  for (const version of branchVersions(dir)) {
    for (const m of version.migrations) if (!known.has(m.id) && !own.includes(m.id)) own.push(m.id);
  }
  // Main's history stays exactly as main recorded it (loadPlan refuses a
  // branch that edited one of those files); this branch's migrations follow
  // in their own order, each checksum now covering main's.
  write(dir, own.reduce((manifest, id) => append(dir, manifest, id), base));
  return own;
}

if (require.main === module) {
  try {
    const [first, second] = process.argv.slice(2);
    if (first === '--onto') {
      if (!second) throw new Error('Usage: record-schema-migration.js --onto <ref>');
      const own = onto(second);
      console.log(own.length ? `Recorded on top of ${second}: ${own.join(', ')}` : `No migrations of this branch's; the history is ${second}'s`);
    } else {
      if (!first) throw new Error('Usage: record-schema-migration.js <name> | --onto <ref>');
      record(first);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { record, onto };
