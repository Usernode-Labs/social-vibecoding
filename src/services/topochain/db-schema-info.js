// Topochain v4 admin API — D10 `GET /sql-query/schema` (Task 13; SPEC
// 2895-2912).
//
// SCOPE: every base table in `public`, not just the topochain ones. The
// list, and the per-table column redactions applied to it, come from
// `db-console-scope.js` — the same module that decides what the console's
// Postgres role is granted and what its statement validator accepts, so
// the schema browser can never advertise a table or column that a query
// against it is then rejected for touching. See that file's header for
// why the scope widened and where its deny lists come from.
//
// The redaction is not about the values (this endpoint returns metadata
// only, never a row) — it is about not showing an admin a column, like
// `users.password` or `onchain_accounts.secret_key`, that they cannot
// select.
//
// SPEC 2912's two findings this fixes:
//   1. "`estimated_rows` is a lifetime write counter, not a row count" ->
//      this reads `pg_class.reltuples` (Postgres's own row-count
//      estimate, refreshed by autovacuum/ANALYZE — the same number
//      `EXPLAIN` and the query planner use), not an app-level counter.
//   2. "columns appearing in several constraints are listed more than
//      once" -> the column query below reads one `pg_attribute` row per
//      column, so "at most one row per (table, column)" is a property of
//      the query itself rather than something the caller has to de-dupe
//      after the fact; a `key_type` priority (primary > foreign > unique
//      > none) picks ONE constraint to report when a column is covered
//      by more than one.
//
// BOTH QUERIES READ THE SYSTEM CATALOG, NOT information_schema. The column
// query used to join `information_schema.columns`, `key_column_usage` and
// `table_constraints`. Postgres cannot push the join keys into those
// views, so it rebuilt `table_constraints` (every constraint plus a row
// per NOT NULL column) once for each key column: about 2 million buffer
// reads and a second of CPU against the full schema on an idle server.
// In a new database whose catalogs autovacuum has not analyzed yet, which
// is what a fresh preview's is, the planner chose worse nested loops and
// it took about nine seconds. On 7 Oct 2026, with about 20 previews
// checking at once on one PostgreSQL, the schema list came back after the
// declared checks had stopped waiting for it, so two of them failed on
// proposals that never touched the console. The catalog version answers
// the same question with index lookups in about 25 ms, analyzed or not.
// The table inventory this request runs first (`db-console-scope.js`)
// moved to the catalog for the same reason.
// `tests/topochain-db-schema-catalog-postgres.test.js` runs each old query
// beside its replacement on the full schema and asserts the rows are
// identical.
'use strict';

const { loadConsoleScope, isDeniedColumn } = require('./db-console-scope');

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

// One row per (table, column), ordered by table and then column NAME (not
// position): the browser has always listed columns alphabetically, and a
// drafted SELECT names them in that order. Each value is what
// `information_schema.columns` would say, spelled against the catalog:
//
//   - `data_type` is information_schema's own expression, copied from the
//     view: `format_type` for a built-in type ('integer', 'character
//     varying', 'timestamp with time zone'), 'ARRAY' for an array,
//     'USER-DEFINED' for an enum or any other type outside pg_catalog, and
//     a domain reported as its base type.
//   - `nullable` is false for a NOT NULL column or a NOT NULL domain.
//   - `default_value` is NULL for a generated column, whose expression is
//     not a default (`attgenerated`).
//   - `key_type` is the strongest key constraint whose `conkey` holds the
//     column: primary, then foreign, then unique.
//   - Dropped and system columns are skipped (`attisdropped`, `attnum > 0`),
//     and so is a column the caller has no privilege on, which is
//     information_schema's visibility rule. The platform's pool owns every
//     table, so in practice that rule hides nothing.
const COLUMN_INFO_SQL = `
  SELECT c.relname::text AS table_name,
         a.attname::text AS column_name,
         CASE
           WHEN t.typtype = 'd' THEN
             CASE
               WHEN bt.typelem <> 0 AND bt.typlen = -1 THEN 'ARRAY'
               WHEN nbt.nspname = 'pg_catalog' THEN format_type(t.typbasetype, NULL)
               ELSE 'USER-DEFINED'
             END
           ELSE
             CASE
               WHEN t.typelem <> 0 AND t.typlen = -1 THEN 'ARRAY'
               WHEN nt.nspname = 'pg_catalog' THEN format_type(a.atttypid, NULL)
               ELSE 'USER-DEFINED'
             END
         END AS data_type,
         NOT (a.attnotnull OR (t.typtype = 'd' AND t.typnotnull)) AS nullable,
         CASE WHEN a.attgenerated = '' THEN pg_get_expr(ad.adbin, ad.adrelid) END AS default_value,
         col_description(c.oid, a.attnum) AS comment,
         (SELECT CASE min(CASE con.contype WHEN 'p' THEN 0 WHEN 'f' THEN 1 ELSE 2 END)
                   WHEN 0 THEN 'primary'
                   WHEN 1 THEN 'foreign'
                   WHEN 2 THEN 'unique'
                 END
            FROM pg_constraint con
           WHERE con.conrelid = c.oid
             AND con.contype IN ('p', 'f', 'u')
             AND a.attnum = ANY (con.conkey)) AS key_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_namespace nt ON nt.oid = t.typnamespace
    LEFT JOIN (pg_type bt JOIN pg_namespace nbt ON nbt.oid = bt.typnamespace)
      ON t.typtype = 'd' AND bt.oid = t.typbasetype
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND c.relname = ANY ($1)
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND (pg_has_role(c.relowner, 'USAGE')
       OR has_column_privilege(c.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES'))
   ORDER BY c.relname, a.attname
`;

// SPEC 2899-2910 response shape: `{ name, comment, estimated_rows,
// columns: [{ name, type, nullable, default_value, comment, key_type }] }`,
// one entry per in-scope table, alphabetically (not whatever order
// Postgres happens to return rows in) so the response is stable across
// calls and the now ~90-entry list is scannable in the browser panel.
//
// `loadConsoleScope` doubles as the refresh of the scope cache that
// `sql-console.js`'s synchronous validator reads, which is why the schema
// fetch — the thing the console does before an admin types a query — is
// one of the two places that calls it.
async function getConsoleSchema(pool) {
  const scope = await loadConsoleScope(pool);
  const names = scope.map((entry) => entry.table);

  const [{ rows: tableRows }, { rows: columnRows }] = await Promise.all([
    pool.query(TABLE_INFO_SQL, [names]),
    pool.query(COLUMN_INFO_SQL, [names]),
  ]);

  const tableByName = new Map(tableRows.map((r) => [r.name, r]));
  const columnsByTable = new Map(names.map((t) => [t, []]));
  for (const row of columnRows) {
    const list = columnsByTable.get(row.table_name);
    if (!list) continue; // defensive: ignore anything outside the scope
    if (isDeniedColumn(row.table_name, row.column_name)) continue;
    list.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.nullable,
      default_value: row.default_value,
      comment: row.comment ?? null,
      key_type: row.key_type ?? null,
    });
  }

  return names.map((name) => {
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

module.exports = { getConsoleSchema, TABLE_INFO_SQL, COLUMN_INFO_SQL };
