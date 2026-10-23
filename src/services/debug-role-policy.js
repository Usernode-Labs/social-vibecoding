'use strict';

// Catalog-only acceptance check, shared by release setup and lint:sql's
// already-migrated shadow database. No application rows are read here.
// Changes to approved types or CHECK constraints require an explicit review
// of debug-access-schema.json; never regenerate it just to make a check pass.
const crypto = require('node:crypto');
const schemaContract = require('./debug-access-schema.json');

// CHECK constraints are unordered. PostgreSQL's collation can order their
// deparsed definitions differently; compare both lists in locale-free order.
const sameChecks = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());

async function verifyDebugRole(pool, { role, readableColumns, requireAllColumns = false }) {
  const started = performance.now();
  const problems = [];
  const approved = new Set(Object.entries(readableColumns).flatMap(([table, columns]) =>
    columns.map(column => `${table}.${column}`)));
  for (const key of approved) {
    if (!Object.hasOwn(schemaContract, key)) problems.push(`unreviewed column definition: ${key}`);
  }
  for (const key of Object.keys(schemaContract)) {
    if (!approved.has(key)) problems.push(`retired column definition: ${key}`);
  }

  const { rows: [identity] } = await pool.query(
    `SELECT oid::text AS oid, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
            rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [role]);
  if (!identity) throw new Error(`debug role missing: ${role}`);
  for (const flag of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls']) {
    if (identity[flag]) problems.push(`unsafe role attribute: ${flag}`);
  }
  const values = [identity.oid];
  const memberships = await pool.query(`SELECT parent.rolname AS role FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid = m.roleid WHERE m.member = $1::oid`, values);
  const columns = await pool.query(`SELECT n.nspname AS schema, c.relname AS table, c.relkind AS kind,
        a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
        has_column_privilege($1::oid, c.oid, a.attnum, 'SELECT') AS readable,
        (has_table_privilege($1::oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_column_privilege($1::oid, c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES')) AS writable,
        CASE WHEN n.nspname = 'public' AND (c.relname || '.' || a.attname) = ANY($2::text[])
          THEN ARRAY(SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k
            WHERE k.conrelid = c.oid AND k.contype = 'c' AND a.attnum = ANY(k.conkey)
            ORDER BY pg_get_constraintdef(k.oid)) ELSE ARRAY[]::text[] END AS checks
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped`,
    [identity.oid, [...approved]]);
  const surfaces = await pool.query(`SELECT 'schema' AS kind, n.nspname AS name FROM pg_namespace n
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND (has_schema_privilege($1::oid, n.oid, 'CREATE')
          OR (n.nspname <> 'public' AND has_schema_privilege($1::oid, n.oid, 'USAGE')))
      UNION ALL
      SELECT 'table-wide privilege', n.nspname || '.' || c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND CASE WHEN c.relkind IN ('r', 'p', 'v', 'm', 'f') THEN
          has_table_privilege($1::oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE FALSE END
      UNION ALL
      SELECT 'sequence', n.nspname || '.' || c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND CASE WHEN c.relkind = 'S'
        THEN has_sequence_privilege($1::oid, c.oid, 'SELECT,UPDATE,USAGE') ELSE FALSE END
      UNION ALL
      SELECT 'privileged function', p.oid::regprocedure::text FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND (p.proowner = $1::oid
          OR (p.prosecdef AND has_function_privilege($1::oid, p.oid, 'EXECUTE')))
      UNION ALL
      SELECT 'database CREATE', datname FROM pg_database
      WHERE datname = current_database() AND has_database_privilege($1::oid, oid, 'CREATE')`, values);
  const defaults = await pool.query(`SELECT d.defaclobjtype AS kind, COALESCE(n.nspname, '*') AS schema
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
      WHERE d.defaclobjtype IN ('r', 'S') AND acl.grantee IN (0, $1::oid)`, values);
  for (const row of memberships.rows) problems.push(`role membership: ${row.role}`);
  for (const row of surfaces.rows) problems.push(`${row.kind} authority: ${row.name}`);
  for (const row of defaults.rows) problems.push(`future object grant: ${row.schema} (${row.kind})`);

  const found = new Set();
  for (const column of columns.rows) {
    const key = `${column.table}.${column.column}`;
    const allowed = column.schema === 'public' && ['r', 'p'].includes(column.kind) && approved.has(key);
    if (column.readable !== allowed) problems.push(`${column.readable ? 'unexpected' : 'missing'} SELECT: ${column.schema}.${key}`);
    if (column.writable) problems.push(`write privilege: ${column.schema}.${key}`);
    if (!allowed) continue;
    found.add(key);
    const expected = schemaContract[key];
    if (expected && (column.type !== expected.type || !sameChecks(column.checks, expected.checks))) {
      problems.push(`review column type/constraints: ${key}`);
    }
  }
  // Missing fields are harmless at runtime (no grant was made). CI checks the
  // complete schema strictly so removed/renamed fields cannot silently drift.
  if (requireAllColumns) {
    for (const key of approved) if (!found.has(key)) problems.push(`missing reviewed column: ${key}`);
  }
  if (problems.length) {
    const error = new Error(`debug role policy mismatch (${problems.length}): ${problems.slice(0, 10).join('; ')}`);
    error.code = 'DEBUG_POLICY_MISMATCH';
    throw error;
  }
  const policyHash = crypto.createHash('sha256')
    .update(JSON.stringify([...approved].sort().map(key => [key, schemaContract[key]])))
    .digest('hex').slice(0, 16);
  return { columns: found.size, policyHash, durationMs: Math.round(performance.now() - started) };
}

module.exports = { verifyDebugRole };
