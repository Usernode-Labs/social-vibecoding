// Topochain v4 admin API — D10 `GET /sql-query/schema` (Task 13; SPEC
// 2895-2912).
//
// Also filters out every column in `db-allowlist.js`'s
// `EXCLUDED_EXPORT_COLUMNS` (`onchain_accounts.secret_key`/
// `.registration_code`) — not because the schema endpoint returns
// secret VALUES (it never does; this is metadata only), but because
// this router's `sql-query/execute` denies queries that reference those
// columns by name (sql-console.js), so advertising them here would be
// actively misleading: an admin would see a column in the schema
// browser that every query against it then gets rejected for touching.
//
// SPEC 2912's two findings this fixes:
//   1. "`estimated_rows` is a lifetime write counter, not a row count" ->
//      this reads `pg_class.reltuples` (Postgres's own row-count
//      estimate, refreshed by autovacuum/ANALYZE — the same number
//      `EXPLAIN` and the query planner use), not an app-level counter.
//   2. "columns appearing in several constraints are listed more than
//      once" -> the column query below is `DISTINCT ON (table_name,
//      column_name)`, which makes "at most one row per (table, column)"
//      a property of the query itself rather than something the caller
//      has to de-dupe after the fact; a `key_type` priority (primary >
//      foreign > unique > none) picks ONE constraint to report when a
//      column is covered by more than one.
'use strict';

const { QUERYABLE_TABLES, EXCLUDED_EXPORT_COLUMNS } = require('./db-allowlist');

function isExcludedColumn(tableName, columnName) {
  const excluded = EXCLUDED_EXPORT_COLUMNS[tableName];
  return !!excluded && excluded.includes(columnName);
}

// One row per queryable table with its live row estimate + table comment
// (NULL for tables with no `COMMENT ON TABLE`, which is most of them —
// `obj_description` returns NULL rather than erroring in that case).
const TABLE_INFO_SQL = `
  SELECT c.relname AS name,
         obj_description(c.oid, 'pg_class') AS comment,
         c.reltuples AS estimated_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)
`;

// One row per (table, column), guaranteed by `DISTINCT ON` — the ORDER
// BY's leading two expressions match the DISTINCT ON list (required by
// Postgres), then a key-type priority, then ordinal position, so the
// "kept" row for a multiply-constrained column is deterministic (its
// PRIMARY KEY row wins over its FOREIGN KEY or UNIQUE row, if it has
// more than one).
const COLUMN_INFO_SQL = `
  SELECT DISTINCT ON (c.table_name, c.column_name)
         c.table_name AS table_name,
         c.column_name AS column_name,
         c.data_type AS data_type,
         (c.is_nullable = 'YES') AS nullable,
         c.column_default AS default_value,
         col_description(pgc.oid, c.ordinal_position) AS comment,
         CASE tc.constraint_type
           WHEN 'PRIMARY KEY' THEN 'primary'
           WHEN 'FOREIGN KEY' THEN 'foreign'
           WHEN 'UNIQUE' THEN 'unique'
           ELSE NULL
         END AS key_type
    FROM information_schema.columns c
    JOIN pg_class pgc ON pgc.relname = c.table_name AND pgc.relnamespace = 'public'::regnamespace
    LEFT JOIN information_schema.key_column_usage kcu
      ON kcu.table_schema = 'public' AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name
    LEFT JOIN information_schema.table_constraints tc
      ON tc.table_schema = 'public' AND tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
   WHERE c.table_schema = 'public' AND c.table_name = ANY($1)
   ORDER BY c.table_name, c.column_name,
     CASE tc.constraint_type
       WHEN 'PRIMARY KEY' THEN 0
       WHEN 'FOREIGN KEY' THEN 1
       WHEN 'UNIQUE' THEN 2
       ELSE 3
     END,
     c.ordinal_position
`;

// SPEC 2899-2910 response shape: `{ name, comment, estimated_rows,
// columns: [{ name, type, nullable, default_value, comment, key_type }] }`,
// one entry per queryable table, in `QUERYABLE_TABLES`'s fixed order
// (not whatever order Postgres happens to return rows in) so the
// response is stable across calls.
async function getTopochainSchema(pool) {
  const [{ rows: tableRows }, { rows: columnRows }] = await Promise.all([
    pool.query(TABLE_INFO_SQL, [QUERYABLE_TABLES]),
    pool.query(COLUMN_INFO_SQL, [QUERYABLE_TABLES]),
  ]);

  const tableByName = new Map(tableRows.map((r) => [r.name, r]));
  const columnsByTable = new Map(QUERYABLE_TABLES.map((t) => [t, []]));
  for (const row of columnRows) {
    const list = columnsByTable.get(row.table_name);
    if (!list) continue; // defensive: ignore anything outside the allow-list
    if (isExcludedColumn(row.table_name, row.column_name)) continue;
    list.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.nullable,
      default_value: row.default_value,
      comment: row.comment ?? null,
      key_type: row.key_type ?? null,
    });
  }

  return QUERYABLE_TABLES.map((name) => {
    const info = tableByName.get(name);
    const estimate = info && info.estimated_rows != null ? Number(info.estimated_rows) : 0;
    return {
      name,
      comment: (info && info.comment) ?? null,
      estimated_rows: Number.isFinite(estimate) ? Math.max(0, Math.round(estimate)) : 0,
      columns: columnsByTable.get(name) || [],
    };
  });
}

module.exports = { getTopochainSchema, TABLE_INFO_SQL, COLUMN_INFO_SQL };
