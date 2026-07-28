// Topochain v4 admin API — the D10 SQL console's hardening (Task 13;
// SPEC 2864-2893, Global Constraints #9 — "SQL console hardening" is
// listed there as a settled, non-relitigable architecture decision).
//
// THE FINDING THIS FIXES (SPEC 2891, "the most important finding in this
// audit"): the source's read-only allow-list is commented out, so
// arbitrary INSERT/UPDATE/DELETE/DROP/TRUNCATE reach the live database;
// only a handful of substrings are blocked and one check is dead code;
// the row cap is declared but never applied and is skipped entirely for
// CTEs or any query containing the word "LIMIT"; raw driver errors go
// straight to the client.
//
// THIS MODULE'S LAYERS, IN THE ORDER THEY RUN (`runConsoleQuery` below):
//   1. `validateStatement` — comment-stripped prefix must be SELECT or
//      WITH; exactly one statement; a fixed deny-substring list; a
//      defense-in-depth mutating-keyword scan (catches a
//      write-inside-a-CTE trick a bare SELECT/WITH prefix check misses,
//      e.g. `WITH x AS (DELETE FROM foo RETURNING *) SELECT * FROM x`);
//      a deny check for `onchain_accounts.secret_key`/`.registration_code`
//      by NAME (this console reads the live table directly — the table-
//      allow-list check alone would happily let `SELECT secret_key FROM
//      onchain_accounts` through, since that's an allowed table with an
//      allowed verb; the export's column-level redaction has to be
//      repeated here or it's meaningless); table references restricted
//      to the topochain allow-list; AND a ban on bare wildcard column
//      lists (`SELECT *`/`alias.*`, though not `COUNT(*)`) — a by-name
//      deny check is useless against `SELECT * FROM onchain_accounts`,
//      which never spells `secret_key` out but returns it anyway.
//   2. `wrapWithLimit` — the row cap, enforced server-side by wrapping
//      the WHOLE validated statement in an outer
//      `SELECT * FROM (<query>) AS _topochain_console_q LIMIT <cap+1>`,
//      never by string-editing/appending a LIMIT clause into the
//      original text. This is what makes CTEs and "the query already
//      contains the word LIMIT" both work correctly: the wrapper only
//      ever looks at the OUTSIDE of the parenthesized subquery, so it
//      neither needs to parse the query's own (possibly absent, possibly
///     tighter) LIMIT nor cares whether the query starts with WITH.
//   3. Execution inside `BEGIN TRANSACTION READ ONLY` +
//      `SET LOCAL statement_timeout = '10s'`.
//   4. Raw driver errors are logged, never echoed (`{success:false,
//      "error":"Query failed."}`); ONLY validation-layer rejections
//      (steps 1-2, and the length/shape checks the route handler itself
//      does before calling in here) explain themselves, per SPEC 2889's
//      400 shape (`{"success": false, "error": "...", "query": "..."}`).
//
// ON THE TABLE ALLOW-LIST CHECK, HONESTLY: table references are found by
// a regex over identifiers following `FROM`/`JOIN` (Global Constraints #9
// explicitly permits this: "regex over FROM/JOIN identifiers is
// acceptable... document the approach"). This is NOT a SQL parser and
// has known blind spots in both directions:
//   - FALSE POSITIVES: `EXTRACT(EPOCH FROM created_at)` contains the
//     literal token sequence "FROM created_at" — a query using EXTRACT
//     would have `created_at` misidentified as a referenced "table" and
//     get rejected as not on the allow-list, even though it's a builtin
//     SQL function argument, not a table. Nothing here special-cases
//     EXTRACT; write admin SQL-console queries in a form that avoids it
//     if this surfaces.
//   - FALSE NEGATIVES: a query could reference an allow-listed table
//     through a view, a function, or dynamic SQL this regex doesn't
//     walk into, and a sufficiently exotic reference the regex just
//     doesn't recognize as an identifier slips through unflagged.
// This check is a UX-layer speed bump, not the security boundary. THE
// ACTUAL BOUNDARY is `BEGIN TRANSACTION READ ONLY`: Postgres itself
// refuses every data-modifying statement inside a read-only transaction
// at the executor level, regardless of what any regex here did or didn't
// catch, and regardless of which table it touches. Every layer above
// this comment exists to fail fast and explain itself; this one is the
// one that cannot be bypassed by a cleverer query.
'use strict';

const log = require('../logger');
const { QUERYABLE_TABLES_SET, EXCLUDED_SECRET_COLUMN_NAMES } = require('./db-allowlist');

// SPEC 2872: `limit` is optional int, 1..1000, default 100.
const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;

// SPEC 2872: `query` is required, `max:10000`.
const MAX_QUERY_LENGTH = 10000;

// SPEC 2891's exact deny-substring list ("DROP DATABASE, DROP SCHEMA,
// SHUTDOWN, file-access functions") plus its own named "and friends":
// every other Postgres builtin that reads/writes the filesystem or large
// objects from SQL. Checked case-insensitively against the
// comment-stripped statement text (see `stripCommentsTrackingSemicolons`
// below) — a match found only INSIDE a string literal still triggers
// this (we don't distinguish "appears in a string" from "appears as a
// keyword" for this list), which can over-block a query that legitimately
// searches for one of these words as plain text. That's an accepted
// false-positive cost for keeping this check a simple substring scan.
const DENIED_SUBSTRINGS = [
  'DROP DATABASE',
  'DROP SCHEMA',
  'SHUTDOWN',
  'PG_READ_FILE',
  'PG_READ_BINARY_FILE',
  'PG_LS_DIR',
  'PG_STAT_FILE',
  'LO_IMPORT',
  'LO_EXPORT',
  'PG_TERMINATE_BACKEND',
];

// Defense-in-depth beyond SPEC's literal deny list (documented above):
// whole-word scan for any statement keyword that mutates data or schema,
// checked ANYWHERE in the statement (not just its prefix). The
// SELECT/WITH prefix check alone would still let a data-modifying CTE
// through — `WITH x AS (DELETE FROM foo RETURNING *) SELECT * FROM x`
// starts with WITH — so this list is what actually catches that shape.
// `BEGIN TRANSACTION READ ONLY` (see module header) is what makes this
// airtight even if a future keyword is missed here.
//
// Same string-literal caveat as `DENIED_SUBSTRINGS`: this scans the
// comment-stripped text, which still includes string/identifier
// contents verbatim, so a query with e.g. `WHERE note = 'please drop
// by tomorrow'` gets over-blocked too. Accepted for the same reason —
// this is a fast, simple heuristic layer, not the security boundary.
const MUTATING_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'GRANT',
  'REVOKE', 'CREATE', 'VACUUM', 'COPY', 'CALL', 'MERGE', 'EXECUTE', 'DO',
];
const MUTATING_KEYWORDS_RE = new RegExp(`\\b(${MUTATING_KEYWORDS.join('|')})\\b`, 'i');

// db-export.js excludes `onchain_accounts.secret_key`/`.registration_code`
// at the column level; this console reads the SAME live table, and
// nothing about the table-allow-list check below would stop
// `SELECT secret_key FROM onchain_accounts` (it references an allowed
// table with an allowed verb) — so that redaction is repeated here as a
// query-time deny check, word-bounded and checked anywhere in the
// statement (not just the column list), same posture as the mutating-
// keyword scan above. Both excluded names are specific enough that
// blanket-denying them regardless of which table a query touches costs
// nothing real (see `db-allowlist.js` — neither name is used as a column
// on any OTHER topochain table).
const EXCLUDED_COLUMNS_RE = EXCLUDED_SECRET_COLUMN_NAMES.length
  ? new RegExp(`\\b(${EXCLUDED_SECRET_COLUMN_NAMES.join('|')})\\b`, 'i')
  : null;

// ─── Statement scanning ─────────────────────────────────────────────────
//
// One pass over the raw query text that simultaneously:
//   - drops `--` line comments and `/* ... */` block comments (replaced
//     with a single space each, so tokens on either side of a stripped
//     comment don't get glued together, e.g. `SELECT/*x*/1`);
//   - copies '...'-quoted string literals and "..."-quoted identifiers
//     through VERBATIM (so a `;` or a keyword INSIDE a string can't be
//     misread as a statement separator or a real keyword); and
//   - records the position, in the OUTPUT text, of every `;` that is NOT
//     inside a string/identifier or a comment — i.e. every genuine
//     top-level statement separator.
// Both `validateStatement`'s single-statement check and its
// SELECT/WITH-prefix check work off this same stripped text, not the
// raw input, so a comment can never be used to smuggle a second
// statement or a disallowed keyword past either check.
function stripCommentsTrackingSemicolons(sql) {
  let stripped = '';
  const topLevelSemicolons = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = i + 1 < n ? sql[i + 1] : '';

    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') i++;
      stripped += ' ';
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      stripped += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      stripped += c;
      i++;
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) { stripped += quote + quote; i += 2; continue; }
        stripped += sql[i];
        const closed = sql[i] === quote;
        i++;
        if (closed) break;
      }
      continue;
    }
    if (c === ';') topLevelSemicolons.push(stripped.length);
    stripped += c;
    i++;
  }
  return { stripped, topLevelSemicolons };
}

// ─── Table allow-list extraction (documented at length in the file
// header comment above) ─────────────────────────────────────────────────
function extractReferencedTables(strippedSql) {
  const cteNames = new Set();
  const cteRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi;
  let m;
  while ((m = cteRe.exec(strippedSql))) cteNames.add(m[1].toLowerCase());

  const tables = new Set();
  const refRe = /\b(?:FROM|JOIN)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  while ((m = refRe.exec(strippedSql))) tables.add(m[1].toLowerCase());

  return { tables, cteNames };
}

// Returns `{ ok: true }` or `{ ok: false, reason: '<explains itself>' }`.
// Every rejection reason here is safe (and, per SPEC 2889, REQUIRED) to
// send straight back to the caller — none of them come from the driver.
function validateStatement(query) {
  const { stripped, topLevelSemicolons } = stripCommentsTrackingSemicolons(query);

  // Single statement only: 0 semicolons is fine (no trailing `;`); with
  // exactly 1, everything after it must be pure whitespace; more than 1
  // is always multiple statements.
  if (topLevelSemicolons.length > 1) {
    return { ok: false, reason: 'Only a single SQL statement is allowed.' };
  }
  if (topLevelSemicolons.length === 1) {
    const after = stripped.slice(topLevelSemicolons[0] + 1);
    if (after.trim() !== '') {
      return { ok: false, reason: 'Only a single SQL statement is allowed.' };
    }
  }

  const bodyEnd = topLevelSemicolons.length === 1 ? topLevelSemicolons[0] : stripped.length;
  const body = stripped.slice(0, bodyEnd).trim();
  if (!/^(SELECT|WITH)\b/i.test(body)) {
    return { ok: false, reason: 'Only SELECT and WITH statements are allowed.' };
  }

  const upperStripped = stripped.toUpperCase();
  for (const denied of DENIED_SUBSTRINGS) {
    if (upperStripped.includes(denied)) {
      return { ok: false, reason: `Query contains a disallowed keyword: ${denied}.` };
    }
  }

  // Mutating-keyword scan runs over the body AFTER the leading SELECT/
  // WITH keyword has been confirmed, so this only ever fires on a
  // mutating statement nested somewhere inside (a CTE body, typically) —
  // a plain `SELECT ... FROM inserted_log` referencing a column or table
  // NAME that happens to contain "insert" would not match (`\b` requires
  // the token to be exactly one of the listed keywords, not a substring
  // of a longer identifier).
  const mutatingMatch = body.match(MUTATING_KEYWORDS_RE);
  if (mutatingMatch) {
    return { ok: false, reason: `Query contains a disallowed keyword: ${mutatingMatch[1].toUpperCase()}.` };
  }

  if (EXCLUDED_COLUMNS_RE) {
    const columnMatch = body.match(EXCLUDED_COLUMNS_RE);
    if (columnMatch) {
      return {
        ok: false,
        reason: `Query references a column that is not accessible through this console: ${columnMatch[1].toLowerCase()}.`,
      };
    }
  }

  const { tables, cteNames } = extractReferencedTables(body);
  const offenders = [...tables].filter((t) => !QUERYABLE_TABLES_SET.has(t) && !cteNames.has(t));
  if (offenders.length) {
    return {
      ok: false,
      reason: `Query references table(s) outside the allowed list: ${offenders.join(', ')}.`,
    };
  }

  // A bare wildcard (`SELECT *`, `SELECT alias.*`) would silently pull
  // in `onchain_accounts.secret_key`/`.registration_code` — the
  // by-name deny check above only catches an EXPLICIT reference to
  // either column, and `*` never spells them out. Checked last (after
  // the table allow-list) so a query that ALSO references a disallowed
  // table still gets that more fundamental rejection reason first. The
  // one thing this deliberately does NOT flag is a `*` immediately
  // after `(` (`COUNT(*)`, `array_agg(*)`, ...) — an aggregate/function
  // star never returns column data, only a computed scalar, so it can't
  // leak anything a by-name check would have caught anyway. Every
  // template in db-query-templates.js already writes explicit column
  // lists for exactly this reason.
  if (hasBareWildcard(body)) {
    return {
      ok: false,
      reason: 'Query must list columns explicitly — a bare wildcard (*) is not allowed.',
    };
  }

  return { ok: true };
}

// True if `text` contains a `*` NOT immediately preceded (ignoring
// whitespace) by `(` — see the comment above this function's one call
// site for what that distinction is for.
function hasBareWildcard(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '*') continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j < 0 || text[j] !== '(') return true;
  }
  return false;
}

// The row cap (SPEC 2872/2891): wraps the ENTIRE validated statement in
// an outer SELECT rather than editing/appending a LIMIT into it. This is
// what makes the wrap correct for both cases the source got wrong:
//   - a CTE (`WITH x AS (...) SELECT ...`) — wrapping the whole thing in
//     `SELECT * FROM (<the WITH query>) AS _q LIMIT n` is valid SQL
//     regardless of what's inside; there is no need to parse past the
//     CTE to find "the real SELECT" to attach a LIMIT to.
//   - a query that already contains the word "LIMIT" (its own, tighter,
//     inner limit, or just a column/string containing the word) — the
//     inner LIMIT (if any) still applies first, and our LIMIT on the
//     OUTER select is simply an additional ceiling on top; nothing here
//     greps for or rewrites the word "LIMIT" anywhere in the input.
function wrapWithLimit(query, cap) {
  const trimmed = query.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (${trimmed}) AS _topochain_console_q LIMIT ${cap + 1}`;
}

function parseLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
    return { value: DEFAULT_LIMIT };
  }
  let n;
  if (typeof rawLimit === 'number') n = rawLimit;
  else if (typeof rawLimit === 'string' && rawLimit.trim() !== '') n = Number(rawLimit);
  else return { error: true };
  if (!Number.isInteger(n) || n < MIN_LIMIT || n > MAX_LIMIT) return { error: true };
  return { value: n };
}

// Runs the validated, wrapped query inside a read-only transaction and
// returns a discriminated result the route handler translates into the
// SPEC 2877-2889 response shapes:
//   { kind: 'validation_error', reason }   -> 400 (explains itself)
//   { kind: 'driver_error' }                -> 400, generic "Query failed."
//   { kind: 'ok', data, columns, execution_time_ms, row_count, limited }
//
// `pool` only needs `.connect()` returning a client with `.query()` /
// `.release()` — exactly the shape both the real `pg` Pool and this
// task's test mock provide.
async function runConsoleQuery(pool, { query, limit }) {
  const validation = validateStatement(query);
  if (!validation.ok) {
    return { kind: 'validation_error', reason: validation.reason };
  }

  const wrapped = wrapWithLimit(query, limit);
  const client = await pool.connect();
  const startedAt = process.hrtime.bigint();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    // Fixed literal, never interpolated from request input — Postgres's
    // SET command does not accept a bind parameter for its value, so
    // this has to be a constant string; it IS one, hard-coded here, not
    // derived from anything the caller sent.
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await client.query(wrapped);
    await client.query('COMMIT');

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const limited = result.rows.length > limit;
    const data = limited ? result.rows.slice(0, limit) : result.rows;
    const columns = Array.isArray(result.fields) && result.fields.length
      ? result.fields.map((f) => f.name)
      : (data[0] ? Object.keys(data[0]) : []);

    return {
      kind: 'ok',
      data,
      columns,
      execution_time_ms: Math.round(elapsedMs * 100) / 100,
      row_count: data.length,
      limited,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('topochain-sql-console', 'Query execution failed', { message: err.message });
    return { kind: 'driver_error' };
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_LIMIT,
  MIN_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  validateStatement,
  wrapWithLimit,
  parseLimit,
  runConsoleQuery,
  // exported for the test file's direct unit coverage of the scanner
  stripCommentsTrackingSemicolons,
  extractReferencedTables,
};
