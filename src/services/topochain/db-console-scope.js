// The admin SQL console's TABLE SCOPE — every table in the platform
// database, not just the topochain ones.
//
// WHY THIS FILE EXISTS: the console (`#admin/seasons/sql-console`) shipped
// scoped to `db-allowlist.js`'s 20 topochain tables, because that is what
// the topochain SPEC's D10 task asked for. The console is, in practice,
// the platform's only browse-any-table surface for an admin who is
// already looking at the admin console — and an admin who cannot see
// `apps`, `events` or `chat_sessions` from it just goes and reads them
// some other way (the unredacted `pg_dump` behind `#admin/db-export`, or
// the prod-debug SQL proxy) with strictly LESS redaction than this
// console applies. So the scope is now "the whole `public` schema, minus
// the credential-bearing tables and columns", which is a real widening of
// what is BROWSABLE and no widening at all of what is READABLE.
//
// THE DENY LISTS ARE NOT NEW ONES. They are `services/debug-access.js`'s
// `DENIED_TABLES` / `DENIED_COLUMNS` — the same lists that scope the
// production read-only debug role, kept in sync with `schema.sql`'s
// `staging:private` credential tags by a test in
// `tests/prod-debug-access.test.js`. Reusing them (rather than writing a
// second, slightly-different list here) is the whole point: a
// credential-bearing table or column added to the schema has exactly ONE
// place to be declared, and both read surfaces pick it up. On top of
// them, `db-allowlist.js`'s `EXCLUDED_EXPORT_COLUMNS` is merged in so the
// topochain export's own column redactions can never be narrower here
// than they are there (today the two agree on
// `onchain_accounts.secret_key`/`.registration_code`; the merge means a
// future addition on either side lands on both).
//
// WHAT ENFORCES IT, IN ORDER OF WHO ACTUALLY DECIDES:
//   1. `db-console-role.js` — grants `topochain_console_ro` SELECT on
//      exactly the tables this module resolves, with COLUMN-LEVEL grants
//      wherever a table has denied columns. This is the security
//      boundary: Postgres itself refuses a denied table/column through
//      ANY access path (`SELECT *`, `row_to_json`, a cast, a comma join,
//      a function nobody has thought of yet).
//   2. `sql-console.js`'s `validateStatement` — a fast, specific 400
//      instead of a bare "permission denied" round trip. A UX layer, and
//      documented as one in that file's header.
//   3. `db-schema-info.js` — what the console's schema browser LISTS, so
//      an admin is never shown a table or column every query against it
//      then gets rejected for touching.
// All three resolve their scope from THIS module, so they cannot drift.
//
// `db-allowlist.js` is untouched and still means what it always meant:
// the scope of the topochain SQL EXPORT (a FK-ordered dump that replays
// into a fresh database). That is a deliberately different, much
// narrower thing than "which tables may an admin SELECT from", and
// widening the export was never asked for.
'use strict';

const { DENIED_TABLES, DENIED_COLUMNS } = require('../debug-access');
const { EXCLUDED_EXPORT_COLUMNS } = require('./db-allowlist');

// Tables the console never lists, never grants, and rejects by name.
// A straight copy of the prod-debug deny list (see the header) — copied
// into a new Set rather than aliased so a mutation here could never
// reach back into the other capability's list.
const DENIED_CONSOLE_TABLES = new Set(DENIED_TABLES);

// Columns denied per table: the prod-debug list merged with the
// topochain export's own column exclusions. Union semantics — whichever
// list names a column, it is denied.
const DENIED_CONSOLE_COLUMNS = (() => {
  const merged = {};
  for (const source of [DENIED_COLUMNS, EXCLUDED_EXPORT_COLUMNS]) {
    for (const [table, columns] of Object.entries(source || {})) {
      merged[table] = [...new Set([...(merged[table] || []), ...columns])];
    }
  }
  return merged;
})();

// Postgres identifiers we are willing to splice into a GRANT statement.
// Anything else is skipped rather than quoted-and-hoped-for; the platform
// has no such table or column, so skipping is a no-op in practice and a
// hard stop for a hypothetical hostile identifier.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

// Every base table in `public` with its column list. `BASE TABLE` skips
// views and materialized views deliberately: the console's role is
// granted per-table, and a view would need its own grant plus grants on
// whatever it selects from — out of scope for "list the tables".
const TABLE_INVENTORY_SQL = `
  SELECT c.table_name AS table,
         array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
   GROUP BY c.table_name
   ORDER BY c.table_name
`;

// ── The cached scope ────────────────────────────────────────────────────
//
// `validateStatement` is synchronous (it is called from a request handler
// that has already decided not to touch the database yet), so the set of
// real table names has to be available without awaiting. It is loaded at
// boot by `db-console-role.js`'s grant refresh and again on every schema
// -browser fetch, both of which call `loadConsoleScope` below.
//
// Until the first load, `knownTables()` is EMPTY, and every consumer
// treats that as "I don't know the table list yet" rather than "no table
// is allowed" — see `sql-console.js`'s scope check, which then falls back
// to the deny list alone. That ordering matters: the alternative
// (empty set == reject everything) would turn a slow first load into a
// console that rejects every query with a nonsense reason.
let _tables = [];
let _tableSet = new Set();

function isDeniedTable(name) {
  return DENIED_CONSOLE_TABLES.has(String(name).toLowerCase());
}

function isDeniedColumn(table, column) {
  const denied = DENIED_CONSOLE_COLUMNS[table];
  return !!denied && denied.includes(column);
}

// Denied column names for a set/array of referenced table names — what
// `sql-console.js` uses to reject `SELECT u.password FROM ... users u`
// without blanket-denying the word "password" (or, worse, generic names
// like `data` and `ip`) for every other table in the database.
function deniedColumnsForTables(tables) {
  const names = new Set();
  for (const table of tables) {
    for (const column of DENIED_CONSOLE_COLUMNS[String(table).toLowerCase()] || []) {
      names.add(column);
    }
  }
  return names;
}

// Loads (and caches) the live scope: `[{ table, columns }]`, alphabetical
// by table, denied tables dropped and denied columns filtered out of the
// ones that remain. A table whose EVERY column is denied is dropped too —
// there would be nothing to select from it.
async function loadConsoleScope(pool) {
  const { rows } = await pool.query(TABLE_INVENTORY_SQL);
  const scope = [];
  for (const row of rows || []) {
    const table = row.table;
    if (!SAFE_IDENT.test(table) || isDeniedTable(table)) continue;
    const columns = (row.columns || []).filter(
      (c) => SAFE_IDENT.test(c) && !isDeniedColumn(table, c)
    );
    if (!columns.length) continue;
    scope.push({ table, columns });
  }
  // Alphabetical, so the schema browser's ~90-entry list is scannable and
  // stable across calls regardless of what order Postgres answered in.
  scope.sort((a, b) => a.table.localeCompare(b.table));
  _tables = scope.map((e) => e.table);
  _tableSet = new Set(_tables);
  return scope;
}

function knownTables() {
  return _tables;
}

function knownTableSet() {
  return _tableSet;
}

// Test-only helpers: seed / clear the cache without a database.
function _setKnownTablesForTests(names) {
  _tables = [...names];
  _tableSet = new Set(_tables);
}

function _resetForTests() {
  _tables = [];
  _tableSet = new Set();
}

module.exports = {
  DENIED_CONSOLE_TABLES,
  DENIED_CONSOLE_COLUMNS,
  TABLE_INVENTORY_SQL,
  SAFE_IDENT,
  isDeniedTable,
  isDeniedColumn,
  deniedColumnsForTables,
  loadConsoleScope,
  knownTables,
  knownTableSet,
  _setKnownTablesForTests,
  _resetForTests,
};
