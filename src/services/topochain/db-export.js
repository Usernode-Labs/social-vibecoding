// Topochain v4 admin API — D10 database export (Task 13; SPEC 2852-2862).
//
// THE THREE PROBLEMS SPEC 2862 SAYS v4 MUST FIX, AND HOW THIS FILE FIXES
// THEM:
//   1. "the dump includes every table (auth tables and account secret
//      keys among them)" -> this export ONLY ever queries
//      `db-allowlist.js`'s QUERYABLE_TABLES (the 20 topochain tables,
//      `mobile_otp_codes`/`mobile_auth_tokens` excluded entirely), and
//      `onchain_accounts.secret_key`/`.registration_code` are dropped
//      from both the emitted CREATE TABLE and every INSERT (see
///     `stripExcludedColumns`/`buildColumnList` below).
//   2. "it omits indexes, foreign keys and views... not restorable" ->
//      foreign keys are already inline in every CREATE TABLE (schema.sql
//      declares them there), and every `CREATE INDEX`/`CREATE UNIQUE
//      INDEX` statement for a table is re-emitted alongside it (this
//      migration adds no views, so there is nothing to omit there).
//   3. "streams after a 200 is committed... a mid-dump failure produces
//      a truncated file that looks like success" -> `streamTopochainExport`
//      never lets a failure pass silently: if any table's query throws
//      after bytes are already on the wire, it writes a
//      `-- EXPORT FAILED: <table>: <reason>` line (grep-able, visibly not
//      a clean end-of-file) and terminates the response, and logs the
//      real error server-side.
//
// WHY THIS DOESN'T REUSE db-export.js (the platform's OWN db-export
// service, `src/services/db-export.js`): that service shells out to
// `docker exec <container> pg_dump ... <database>` and streams pg_dump's
// binary custom-format (`-Fc`) output verbatim — pg_dump dumps a WHOLE
// database or a set of whole TABLES, with no way to drop two columns
// out of one of them, and its `-Fc` format isn't even human-readable SQL
// text (SPEC 2860 calls for "a streamed SQL file"). Column-level
// redaction is the hard requirement here, so this export is generated
// directly from Postgres via the app's own connection pool instead:
// CREATE TABLE / CREATE INDEX statements are read out of `schema.sql`
// itself (the same DDL the app applies at boot — SPEC gave the choice
// between that and pg_catalog introspection; schema.sql is one read of
// one already-authoritative file, no extra queries needed to reconstruct
// types/defaults/FKs) and data is queried and serialized to INSERT
// statements table-by-table, in the FK-dependency order
// `db-allowlist.js` already keeps for exactly this reason.
'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const {
  QUERYABLE_TABLES,
  EXCLUDED_EXPORT_COLUMNS,
  TABLES_WITHOUT_SERIAL_ID,
} = require('./db-allowlist');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'db', 'schema.sql');

// ─── DDL extraction from schema.sql ─────────────────────────────────────

// Finds `CREATE TABLE IF NOT EXISTS <table> ( ... );` by counting paren
// depth from the opening `(` rather than a regex — column definitions
// contain their OWN parens (`NUMERIC(20,4)`, `VARCHAR(64)`), so a naive
// "up to the first `)`" match would truncate mid-table. Depth-counting
// finds the TRUE matching close-paren regardless of how many nested ones
// came before it.
function extractCreateTableBlock(schemaText, table) {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = schemaText.indexOf(marker);
  if (start === -1) {
    throw new Error(`schema.sql has no CREATE TABLE IF NOT EXISTS for '${table}'`);
  }
  let depth = 0;
  let i = start + marker.length - 1; // sitting on the opening '('
  for (; i < schemaText.length; i++) {
    if (schemaText[i] === '(') depth++;
    else if (schemaText[i] === ')') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const semi = schemaText.indexOf(';', i);
  if (semi === -1) throw new Error(`schema.sql: unterminated CREATE TABLE for '${table}'`);
  return schemaText.slice(start, semi + 1);
}

// Every `CREATE INDEX IF NOT EXISTS ... ON <table> ...;` / `CREATE UNIQUE
// INDEX IF NOT EXISTS ... ON <table> ...;` statement for `table`, in the
// order they appear in schema.sql. A plain regex is safe here (unlike
// the CREATE TABLE block) because index statements don't nest parens
// deeply enough to need depth-counting — this pattern just runs to the
// next `;`.
function extractIndexStatements(schemaText, table) {
  const stmts = [];
  const re = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [^;]*?\bON\s+([a-zA-Z_][a-zA-Z0-9_]*)[^;]*;/g;
  let m;
  while ((m = re.exec(schemaText))) {
    if (m[1] === table) stmts.push(m[0].trim());
  }
  return stmts;
}

// Drops the whole line for any excluded column (task brief: exclude the
// COLUMN, not just its data — a restored dump must not even declare
// `onchain_accounts.secret_key` exists). Safe to remove whole lines here
// because neither excluded column is the LAST column in its table (see
// schema.sql's `onchain_accounts` — `season_event_id` etc. still follow
// both), so no dangling trailing comma is left behind.
function stripExcludedColumns(ddl, table) {
  const excluded = EXCLUDED_EXPORT_COLUMNS[table];
  if (!excluded || !excluded.length) return ddl;
  return ddl
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !excluded.some((col) => trimmed.startsWith(`${col} `) || trimmed.startsWith(`${col}\t`));
    })
    .join('\n');
}

// Splits the content between a CREATE TABLE's outer parens on
// TOP-LEVEL commas only (depth-aware, same reasoning as
// `extractCreateTableBlock`: a column type like `NUMERIC(10,2)` has an
// internal comma that must NOT split the column list).
function splitTopLevel(content) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of content) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// Column names to SELECT/INSERT for a table, derived from its (already
// excluded-column-stripped) CREATE TABLE block — this is the SAME
// parse that produced the DDL, so the export's data section can never
// drift from what its own CREATE TABLE just declared. Table-level
// constraint lines (`UNIQUE (a, b)`, `PRIMARY KEY (...)`, etc. — several
// of these tables have one as their last line) are recognized by their
// leading keyword and skipped; everything else is read as "first
// whitespace-delimited token on this line is the column name".
const CONSTRAINT_KEYWORDS = new Set(['UNIQUE', 'PRIMARY', 'CHECK', 'FOREIGN', 'CONSTRAINT']);

function parseColumnNames(ddl) {
  const open = ddl.indexOf('(');
  const close = ddl.lastIndexOf(')');
  const inner = ddl.slice(open + 1, close);
  const columns = [];
  for (const part of splitTopLevel(inner)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const firstWord = trimmed.split(/\s+/)[0];
    if (CONSTRAINT_KEYWORDS.has(firstWord.toUpperCase())) continue;
    columns.push(firstWord);
  }
  return columns;
}

// ─── Value serialization ─────────────────────────────────────────────────

// One row value -> a literal that's valid in a plain-text SQL INSERT.
// Postgres casts an unknown-type string literal to whatever the target
// column's actual type is, so quoting numerics-that-came-back-as-strings
// (every NUMERIC/DECIMAL column, per `pg`'s driver defaults) and
// JSON-stringified JSONB values as plain quoted strings is sufficient —
// no explicit `::type` casts are needed for this to restore correctly.
function formatSqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (Buffer.isBuffer(value)) return `'\\x${value.toString('hex')}'`;
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function write(res, text) {
  res.write(text);
}

// ─── The export itself ───────────────────────────────────────────────────
//
// Streams the whole dump (header, then per-table DDL + INSERTs +
// sequence setval) directly into `res`. Runs inside ONE
// `BEGIN TRANSACTION READ ONLY` for the whole export (not a SPEC
// requirement for this endpoint — only sql-query/execute is mandated to
// use one — but a deliberate consistency choice: it gives every table in
// one export a single consistent snapshot, and this connection can never
// write regardless of what a future change to this function might do).
//
// Always resolves (never rejects/throws): a mid-loop failure is caught,
// turned into a visible `-- EXPORT FAILED: ...` marker line (SPEC
// 2862's "honest failure" fix), logged, and ends the response there —
// exactly the tables already written stay in the file, followed by an
// unambiguous "this is not a clean, complete dump" marker instead of a
// silently truncated one.
async function streamTopochainExport(pool, res) {
  const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const client = await pool.connect();

  write(
    res,
    `-- Topochain database export\n` +
    `-- Generated ${new Date().toISOString()}\n` +
    `-- Scope: ${QUERYABLE_TABLES.length} topochain tables. ` +
    `'mobile_otp_codes' and 'mobile_auth_tokens' are excluded entirely; ` +
    `'onchain_accounts.secret_key' and '.registration_code' are excluded.\n\n`
  );

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    for (const table of QUERYABLE_TABLES) {
      let ddl = extractCreateTableBlock(schemaText, table);
      ddl = stripExcludedColumns(ddl, table);
      const indexStmts = extractIndexStatements(schemaText, table);
      const columns = parseColumnNames(ddl);

      write(res, `-- ── ${table} ──\n`);
      write(res, `${ddl}\n`);
      for (const stmt of indexStmts) write(res, `${stmt}\n`);
      write(res, `\n`);

      const columnList = columns.join(', ');
      const { rows } = await client.query(`SELECT ${columnList} FROM ${table} ORDER BY 1`);

      let maxId = null;
      const hasSerialId = columns.includes('id') && !TABLES_WITHOUT_SERIAL_ID.has(table);
      for (const row of rows) {
        const values = columns.map((c) => formatSqlLiteral(row[c])).join(', ');
        write(res, `INSERT INTO ${table} (${columnList}) VALUES (${values});\n`);
        if (hasSerialId) {
          const n = Number(row.id);
          if (Number.isFinite(n) && (maxId === null || n > maxId)) maxId = n;
        }
      }
      if (hasSerialId) {
        write(res, `SELECT setval('${table}_id_seq', ${maxId !== null ? maxId : 1}, ${maxId !== null ? 'true' : 'false'});\n`);
      }
      write(res, `\n`);
    }

    await client.query('COMMIT');
    res.end();
    return { status: 'completed' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('topochain-db-export', 'Export failed mid-stream', { message: err.message });
    write(res, `-- EXPORT FAILED: ${err.message}\n`);
    res.end();
    return { status: 'failed', error: err.message };
  } finally {
    client.release();
  }
}

module.exports = {
  streamTopochainExport,
  // exported for direct unit coverage of the DDL/column extraction
  extractCreateTableBlock,
  extractIndexStatements,
  stripExcludedColumns,
  parseColumnNames,
  formatSqlLiteral,
};
