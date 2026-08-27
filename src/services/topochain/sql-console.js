// Topochain v4 admin API — the D10 SQL console's hardening (Task 13;
// SPEC 2864-2893, Global Constraints #9 — "SQL console hardening" is
// listed there as a settled, non-relitigable architecture decision;
// AMENDED by a controller ruling after a live security review to match
// SPEC 2893's normative text: "execute under a read-only database role
// scoped to the migrated tables").
//
// THE FINDING THIS FIXES (SPEC 2891, "the most important finding in this
// audit"): the source's read-only allow-list is commented out, so
// arbitrary INSERT/UPDATE/DELETE/DROP/TRUNCATE reach the live database;
// only a handful of substrings are blocked and one check is dead code;
// the row cap is declared but never applied and is skipped entirely for
// CTEs or any query containing the word "LIMIT"; raw driver errors go
// straight to the client.
//
// ⚠ CORRECTED AFTER A LIVE SECURITY REVIEW: an earlier version of this
// file's header claimed "`BEGIN TRANSACTION READ ONLY` is the actual
// security boundary... regardless of which table it touches." That
// claim was WRONG and has been live-reproduced as wrong: READ ONLY
// restricts WRITES, not which tables a SELECT may read, and TWO shapes
// of query walked straight past every regex check below while reading
// real secrets out of `onchain_accounts` from the live seeded database:
//   1. Old-style comma joins — `SELECT u.password FROM onchain_accounts
//      a, users u WHERE ...` — the table allow-list regex used to only
//      look at the first identifier after FROM/JOIN, so `users` (after
//      the comma) was invisible to it. FIXED below: `extractReferenced
//      Tables` now parses the whole FROM-clause table LIST, not just
//      its first entry (see that function's own comment).
//   2. Whole-row serialization — `row_to_json(o)` / `to_jsonb(o)` /
//      a bare `SELECT o FROM onchain_accounts o` / `o::text` returns
//      EVERY column, including `secret_key`/`registration_code`,
//      without the query ever spelling either name out as a token or
//      using a `*` — both the by-name deny check and the wildcard ban
//      are structurally blind to this, and there is no finite denylist
//      of functions/casts that closes it off completely (a regex is
//      not a permissions system). NOT FIXABLE at this layer.
// THE REAL FIX for #2 (and the thing that ALSO makes #1 harmless even
// if a future regex change reopens it): `db-console-role.js` creates a
// dedicated Postgres role, `topochain_console_ro`, granted SELECT on
// exactly the queryable tables with a COLUMN-LEVEL grant on
// `onchain_accounts` that excludes `secret_key`/`registration_code`.
// `runConsoleQuery` below executes every console query with
// `SET LOCAL ROLE topochain_console_ro` inside the transaction — so
// Postgres itself refuses to return either column's value through ANY
// access path (direct reference, wildcard, `row_to_json`, a cast, a
// comma join reaching `users`, or a function nobody's thought of yet),
// at the executor level, independent of anything this file's regexes
// do or don't recognize. THIS is the security boundary now. Read
// `db-console-role.js`'s header before touching any of this.
//
// THIS MODULE'S LAYERS, IN THE ORDER THEY RUN (`runConsoleQuery` below):
//   1. `validateStatement` — comment-stripped prefix must be SELECT or
//      WITH; exactly one statement; a fixed deny-substring list; a
//      defense-in-depth mutating-keyword scan (catches a
//      write-inside-a-CTE trick a bare SELECT/WITH prefix check misses,
//      e.g. `WITH x AS (DELETE FROM foo RETURNING *) SELECT * FROM x`);
//      a deny check for `onchain_accounts.secret_key`/`.registration_code`
//      by NAME; a table-aware deny check for every OTHER credential
//      column (`sessions.token`, `mcp_tokens.token_hash`, …); table
//      references checked against the live `public` inventory and against
//      the (now-empty) console table deny list, comma-join-aware, see
//      above; a ban on bare wildcard column
//      lists (`SELECT *`/`alias.*`, though not `COUNT(*)`); and a
//      best-effort denylist of whole-row-serialization function names
//      (`row_to_json`, `to_jsonb`, `to_json`, `hstore`). EVERY check in
//      this list is a UX-layer speed bump — a fast, specific 400 instead
//      of waiting on a round trip to discover a bare Postgres
//      "permission denied" — NONE of them, individually or combined, is
//      exhaustive (see `o::text` above, which no keyword/function
//      denylist here catches). The role's grants (below) are what
//      actually make every one of these bypasses come back
//      empty/denied no matter what this layer missed.
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
//      `SET LOCAL ROLE topochain_console_ro` + `SET LOCAL
//      statement_timeout = '10s'`, then unconditionally `ROLLBACK`
//      (never `COMMIT` — there is nothing to persist, and `SET LOCAL`
//      settings revert at end-of-transaction either way, so ROLLBACK is
//      simply the more obviously-inert choice). If the role failed to
//      bootstrap at boot, `runConsoleQuery` refuses to run the query
//      unscoped — it returns `{ kind: 'unavailable' }` instead, which
//      the route handler turns into a 503.
//   4. Raw driver errors are logged, never echoed (`{success:false,
//      "error":"Query failed."}`); ONLY validation-layer rejections
//      (steps 1-2, and the length/shape checks the route handler itself
//      does before calling in here) explain themselves, per SPEC 2889's
//      400 shape (`{"success": false, "error": "...", "query": "..."}`).
//
// SCOPE (WIDENED TWICE): the console lists and queries EVERY base table
// in `public` — all ~108 of them, not just the 20 topochain ones, and
// (since #1130) not minus a table list either. What is withheld is
// per-COLUMN: the credential columns inside those tables. So
// `mobile_push_deliveries` is fully readable, `mobile_push_registrations`
// is readable without `registration_enc`/`registration_hash`, `sessions`
// without `token`. `db-console-scope.js` resolves that scope (from
// `debug-access.js`'s shared column deny list, the topochain export's
// column exclusions, and its own `CONSOLE_CREDENTIAL_COLUMNS` map) and is
// the single source all three layers below read, so the schema browser,
// this validator, and the role's grants cannot disagree about what is in
// scope. Read that file's header before changing anything about which
// tables reach this console.
//
// A CONSEQUENCE FOR THE COLUMN CHECKS BELOW, worth stating outright: the
// denied column names now include GENERIC ones — `token`, `code`,
// `user_code`, `value_enc`, `data`. Those must only ever be matched
// TABLE-AWARELY, via `deniedColumnMatch` + `scope.deniedColumnsForTables`,
// which asks "is this name denied on a table THIS query references".
// Never add such a name to `EXCLUDED_SECRET_COLUMN_NAMES`: that list
// feeds `EXCLUDED_COLUMNS_RE`, a BLANKET regex over the whole statement,
// and blanket-denying the word `token` or `code` would reject a large
// share of legitimate queries against unrelated tables (`activation_codes`
// is not the only table in this database with a `code` column).
//
// ON THE TABLE SCOPE CHECK, HONESTLY: table references are found by
// a regex over identifiers following `FROM`/`JOIN` (Global Constraints #9
// explicitly permits this: "regex over FROM/JOIN identifiers is
// acceptable... document the approach"). This is NOT a SQL parser and
// has known blind spots in both directions, EVEN AFTER the comma-join
// fix:
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
// This check (and every other check in `validateStatement`) is a
// UX-layer speed bump, NOT the security boundary — see the ⚠ correction
// above for what actually is.
'use strict';

const log = require('../logger');
const { EXCLUDED_SECRET_COLUMN_NAMES } = require('./db-allowlist');
const scope = require('./db-console-scope');
const consoleRole = require('./db-console-role');

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
// nothing about the table-scope check below would stop
// `SELECT secret_key FROM onchain_accounts` (it references an in-scope
// table with an allowed verb) — so that redaction is repeated here as a
// query-time deny check, word-bounded and checked anywhere in the
// statement (not just the column list), same posture as the mutating-
// keyword scan above. Both excluded names are specific enough that
// blanket-denying them regardless of which table a query touches costs
// nothing real (see `db-allowlist.js` — neither name is used as a column
// on any OTHER table in this schema).
const EXCLUDED_COLUMNS_RE = EXCLUDED_SECRET_COLUMN_NAMES.length
  ? new RegExp(`\\b(${EXCLUDED_SECRET_COLUMN_NAMES.join('|')})\\b`, 'i')
  : null;

// Every OTHER denied column (`users.password`, `apps.llm_proxy_token`,
// `chat_session_attachments.data`, …) is checked TABLE-AWARELY rather
// than blanket: the console's scope now spans the whole platform schema,
// and some denied names are generic enough (`data`, `ip`, and — since
// #1130 replaced the table-level denials with column-level ones —
// `token`, `code`, `user_code`, `value_enc`) that denying them everywhere
// would reject a pile of perfectly legitimate queries against tables that
// have no such secret. So the check is built from
// the deny lists of the tables the query actually references — see
// `db-console-scope.js`'s `deniedColumnsForTables`. Same caveat as every
// other regex here: it is the fast-400 layer, and the role's
// column-level GRANT is what actually refuses the value.
function deniedColumnMatch(body, tables) {
  const names = [...scope.deniedColumnsForTables(tables)].filter(
    (n) => !EXCLUDED_SECRET_COLUMN_NAMES.includes(n)
  );
  if (!names.length) return null;
  const match = body.match(new RegExp(`\\b(${names.join('|')})\\b`, 'i'));
  return match ? match[1].toLowerCase() : null;
}

// BEST-EFFORT ONLY — NOT EXHAUSTIVE (see the file header's ⚠ correction).
// The most common ways to serialize an entire row as one value (dodging
// both the by-name column check and the wildcard ban, since none of
// these spell out `secret_key`/`registration_code` or use `*`):
// `row_to_json(o)`, `to_jsonb(o)`, `to_json(o)`, `hstore(o)`. A plain
// cast (`o::text`, `o::jsonb`) does the SAME thing and is NOT caught
// here — there is no finite list of casts/functions that closes this
// off completely, which is exactly why `db-console-role.js`'s
// column-level GRANT is the real fix, not this list. Kept anyway
// because it turns the MOST common form of this bypass into an
// immediate, specific 400 instead of a bare Postgres permission error.
const ROW_SERIALIZATION_FUNCTIONS = ['ROW_TO_JSON', 'TO_JSONB', 'TO_JSON', 'HSTORE'];
const ROW_SERIALIZATION_RE = new RegExp(`\\b(${ROW_SERIALIZATION_FUNCTIONS.join('|')})\\s*\\(`, 'i');

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
//
// A `JOIN` target is always a single identifier — `joinRe` below is
// unchanged from the original, simpler version of this function.
//
// A `FROM` clause is NOT always a single identifier: old-style implicit
// joins write it as a COMMA-SEPARATED list (`FROM a, b, c` / `FROM a x,
// b y`). The bypass a live security review reproduced —
// `SELECT u.password FROM onchain_accounts a, users u WHERE ...` — got
// past an earlier version of this function because it only ever
// captured the FIRST identifier after `FROM`, silently missing every
// table after a comma. `extractFromWindow`/`splitTopLevelCommas` below
// fix that: for each `FROM` occurrence, isolate the table-list window
// (stopping at the next clause keyword, `JOIN`, a closing paren that
// belongs to an ENCLOSING expression, a `;`, or end-of-string — paren-
// depth-aware so a `FROM` inside a nested subquery doesn't run past its
// own closing paren), split that window on TOP-LEVEL commas, and read
// the leading identifier of each piece (discarding any alias that
// follows it).
function extractReferencedTables(strippedSql) {
  const cteNames = new Set();
  const cteRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi;
  let m;
  while ((m = cteRe.exec(strippedSql))) cteNames.add(m[1].toLowerCase());

  const tables = new Set();

  const joinRe = /\bJOIN\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  while ((m = joinRe.exec(strippedSql))) tables.add(m[1].toLowerCase());

  const fromRe = /\bFROM\b/gi;
  while ((m = fromRe.exec(strippedSql))) {
    const window = extractFromWindow(strippedSql, fromRe.lastIndex);
    for (const piece of splitTopLevelCommas(window)) {
      const identMatch = piece.trim().match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?/);
      if (identMatch) tables.add(identMatch[1].toLowerCase());
    }
  }

  return { tables, cteNames };
}

// Keywords/clauses that end a FROM-clause table list. Checked with a
// leading AND trailing `\b` (via the sticky regex below) so a substring
// hit inside a longer identifier (`workgroup_id` containing "group")
// never counts as a stop.
const FROM_WINDOW_STOP_RE = /\b(WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|WINDOW|UNION|INTERSECT|EXCEPT|JOIN)\b/iy;

// The substring of `text` starting at `start` that makes up one FROM
// clause's table list — depth-aware so a `)` that closes an ENCLOSING
// paren (not one opened inside this window) ends the window instead of
// being consumed by it.
function extractFromWindow(text, start) {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (ch === ';') break;
    if (depth === 0 && /[A-Za-z]/.test(ch)) {
      FROM_WINDOW_STOP_RE.lastIndex = i;
      if (FROM_WINDOW_STOP_RE.test(text)) break;
    }
  }
  return text.slice(start, i);
}

// Splits `text` on commas that are NOT nested inside parens (so a
// subquery in the FROM list, `(SELECT ... ) x, other_table y`, doesn't
// get split on a comma that lives INSIDE the subquery).
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
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

  // Table scope, checked BEFORE the column rules so an admin gets the
  // more fundamental reason first ("that table isn't available here"
  // rather than "that column isn't"). Two distinct failures, because
  // they mean different things to whoever is typing:
  //   - DENIED: a table `DENIED_CONSOLE_TABLES` names. DORMANT since
  //     #1130 — that set is deliberately empty and the credential-bearing
  //     tables it used to hold (`sessions`, `app_secrets`, the mobile
  //     push and CLI/MCP auth tables) are now readable with only their
  //     credential COLUMNS masked, so this branch fires on nothing today.
  //     It is kept wired up because the escape hatch is still real: see
  //     `db-console-scope.js`'s header for when a table, rather than a
  //     column, is the thing to hide.
  //   - UNKNOWN: an identifier that is not a table in `public` at all.
  //     Usually a typo, occasionally this regex mistaking a function
  //     argument for a table (see `EXTRACT(EPOCH FROM created_at)` in the
  //     file header's blind-spot list).
  const { tables, cteNames } = extractReferencedTables(body);
  const referenced = [...tables].filter((t) => !cteNames.has(t));
  const denied = referenced.filter((t) => scope.isDeniedTable(t));
  if (denied.length) {
    return {
      ok: false,
      reason: `Query references table(s) that are not available in this console: ${denied.join(', ')}.`,
    };
  }
  // An empty `knownTableSet()` means the live table list has not been
  // loaded yet (see db-console-scope.js) — fall through on the deny list
  // alone rather than rejecting every table as "unknown".
  const known = scope.knownTableSet();
  if (known.size) {
    const unknown = referenced.filter((t) => !known.has(t));
    if (unknown.length) {
      return {
        ok: false,
        reason: `Query references table(s) that do not exist in this database: ${unknown.join(', ')}.`,
      };
    }
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
  const deniedColumn = deniedColumnMatch(body, referenced);
  if (deniedColumn) {
    return {
      ok: false,
      reason: `Query references a column that is not accessible through this console: ${deniedColumn}.`,
    };
  }

  // Best-effort only (see this constant's own comment and the file
  // header's ⚠ correction) — catches the most common whole-row-
  // serialization functions, not every shape of the bypass (a bare
  // cast like `o::text` is NOT caught here).
  const rowFuncMatch = body.match(ROW_SERIALIZATION_RE);
  if (rowFuncMatch) {
    return {
      ok: false,
      reason: `Query uses a whole-row serialization function that is not allowed: ${rowFuncMatch[1].toLowerCase()}.`,
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
      reason: 'Query must list columns explicitly; a bare wildcard (*) is not allowed.',
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

  // The regex checks above are a UX layer, not the boundary (see file
  // header). If the console role failed to bootstrap at boot, refuse to
  // run the query at all rather than silently falling back to running
  // it unscoped as the app's normal (unrestricted) connection — the
  // route handler turns this into a 503.
  if (!consoleRole.isAvailable()) {
    return { kind: 'unavailable', reason: consoleRole.unavailableReason() };
  }

  const wrapped = wrapWithLimit(query, limit);
  const client = await pool.connect();
  const startedAt = process.hrtime.bigint();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    // `consoleRole.ROLE` is a hardcoded module constant (never derived
    // from request input — see db-console-role.js), so splicing it into
    // this SET command is as safe as the fixed statement_timeout
    // literal right below it; neither could carry a bind parameter
    // anyway (Postgres's SET does not accept one). THIS is the actual
    // security boundary: every SELECT/WITH runs AS this restricted
    // role, which the database itself refuses to let read
    // secret_key/registration_code or any non-allow-listed table
    // through ANY access path — see db-console-role.js's header.
    await client.query(`SET LOCAL ROLE ${consoleRole.ROLE}`);
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await client.query(wrapped);
    // Always ROLLBACK, never COMMIT: there is nothing to persist (this
    // role has no write grants regardless), and `SET LOCAL` — the role
    // switch included — reverts at end-of-transaction either way, so
    // ROLLBACK is simply the more obviously-inert choice for a query
    // that only ever reads.
    await client.query('ROLLBACK');

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
