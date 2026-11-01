'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REFERENCE_STATEMENTS } = require('./reference-data');
const directory = path.join(__dirname, 'migrations');
const digest = sql => crypto.createHash('sha256').update(sql).digest('hex');

// Mask PostgreSQL strings, quoted identifiers, dollar bodies and nested
// comments before checking top-level statements. A line-only regexp misses
// `SELECT 1; COMMIT;`, and a raw keyword scan rejects valid function bodies.
function transactional(sql) {
  let code = '';
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end;
      code += ' '; continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) return false;
      code += ' '; continue;
    }
    // PostgreSQL allows dollar signs AFTER an unquoted identifier's first
    // character. Consume the whole identifier before considering a dollar
    // quote, including identifiers containing non-ASCII characters.
    const identifier = sql.slice(i).match(/^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/)?.[0];
    if (identifier) {
      code += identifier; i += identifier.length; continue;
    }
    const tag = sql.slice(i).match(/^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/)?.[0];
    if (tag) {
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) return false;
      i = end + tag.length; code += ' '; continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      const escaped = quote === "'" && /[eE]/.test(sql[i - 1] || '') && !/[\w$]/.test(sql[i - 2] || '');
      let closed = false; i++;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue; }
        if (sql[i++] === quote) { closed = true; break; }
      }
      if (!closed) return false;
      code += ' '; continue;
    }
    code += sql[i++];
  }
  return !code.split(';').some(statement => /^\s*(?:BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|ROLLBACK\b|END\b|ABORT\b|PREPARE\s+TRANSACTION\b|SET\s+(?:LOCAL\s+)?TRANSACTION\b|(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX\s+CONCURRENTLY\b|VACUUM\b)/i.test(statement));
}

function loadPlan(dir = directory,
  manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))) {
  if (manifest.version !== 1 || !Array.isArray(manifest.migrations) || !manifest.migrations.length) {
    throw new Error('Invalid schema migration manifest');
  }
  const prefix = [];
  const migrations = manifest.migrations.map((entry, index) => {
    if (!new RegExp(`^${String(index + 1).padStart(4, '0')}-[a-z][a-z0-9-]*$`).test(entry.id)
        || !/^[a-f0-9]{64}$/.test(entry.schemaSha256)) {
      throw new Error('Schema migrations must have consecutive, ordered IDs and schema checksums');
    }
    const sql = fs.readFileSync(path.join(dir, `${entry.id}.sql`), 'utf8');
    if (digest(sql) !== entry.sha256) throw new Error(`Schema migration checksum mismatch: ${entry.id}`);
    // The runner owns the transaction and commits its receipt with the DDL.
    // No independently committed work or concurrent index builds in these files.
    if (!transactional(sql)) {
      throw new Error(`Schema migration must be transactional: ${entry.id}`);
    }
    prefix.push(sql);
    if (digest(prefix.join('\n')) !== entry.schemaSha256) {
      throw new Error(`Schema migration history checksum mismatch: ${entry.id}`);
    }
    return { ...entry, sql };
  });
  const files = fs.readdirSync(dir).filter(file => file.endsWith('.sql')).sort();
  if (JSON.stringify(files) !== JSON.stringify(migrations.map(m => `${m.id}.sql`))) {
    throw new Error('Every schema migration SQL file must appear in the manifest');
  }
  return migrations;
}


function renderSchema(plan, references = REFERENCE_STATEMENTS) {
  return '-- Generated from migrations and reference-data.js. Do not edit.\n'
    + plan.map(m => m.sql + '\n;\n').join('\n')
    + references.map(sql => sql + '\n;\n').join('\n');
}

function schemaSql(dir = directory) { return renderSchema(loadPlan(dir)); }

function ensureSchema(dir = directory) {
  const target = path.join(path.dirname(dir), 'schema.sql');
  const sql = schemaSql(dir);
  try { if (fs.readFileSync(target, 'utf8') === sql) return target; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Test processes may start together. Readers see a complete file, never a
  // partially written concatenation. An up-to-date immutable image is read only.
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, sql); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
  return target;
}

module.exports = { loadPlan, renderSchema, schemaSql, ensureSchema };
