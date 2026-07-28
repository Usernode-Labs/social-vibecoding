// Topochain v4 admin API — the D10 SQL console's REAL security boundary
// (Task 13 fix round; controller ruling amending Global Constraints #9
// to match SPEC 2893's normative text: "execute under a read-only
// database role scoped to the migrated tables").
//
// WHY THIS EXISTS: a live security review reproduced two ways past
// sql-console.js's regex-based checks (validateStatement's table
// allow-list, by-name secret-column deny, and wildcard ban):
//   1. Old-style comma joins: `SELECT u.password FROM onchain_accounts
//      a, users u WHERE ...` — READ ONLY restricts WRITES, not which
//      tables a SELECT may touch; a regex that only looked at the
//      first identifier after FROM/JOIN missed every table after a
//      comma. (`extractReferencedTables` in sql-console.js has since
//      been fixed to also parse comma-separated FROM lists, but that
//      fix is still just a regex — see point 2.)
//   2. Whole-row serialization: `row_to_json(o)` / `to_jsonb(o)` / a
//      bare `SELECT o FROM onchain_accounts o` / `o::text` returns
//      EVERY column, including secret_key/registration_code, without
//      ever spelling either name out as a token or using a `*` — both
//      the by-name deny check and the wildcard ban are structurally
//      blind to this (there is no finite blocklist of functions/casts
//      that closes this off completely; a regex is not a permissions
//      system).
//
// NO REGEX FIXES POINT 2. The only thing that actually closes it is
// making the DATABASE refuse to hand back `secret_key`/
// `registration_code` values AT ALL to whatever role runs the query —
// regardless of how cleverly the query asks for them. This module
// creates and maintains that role: `topochain_console_ro`, granted
// SELECT on exactly `db-allowlist.js`'s QUERYABLE_TABLES, with a
// COLUMN-LEVEL grant on `onchain_accounts` that explicitly excludes
// `secret_key`/`registration_code` (Postgres column-level GRANT SELECT
// means every OTHER access path — direct reference, `SELECT *`,
// `row_to_json`, a cast, a future function nobody's thought of yet — is
// refused at the executor with "permission denied for table
// onchain_accounts", full stop). `sql-console.js`'s `runConsoleQuery`
// executes every console query with `SET LOCAL ROLE
// topochain_console_ro` inside the same transaction, so the pooled
// connection is never permanently repointed (`SET LOCAL` reverts at
// transaction end regardless of COMMIT/ROLLBACK).
//
// sql-console.js's regex validation (single-statement, SELECT/WITH-
// only, deny-substrings, mutating-keyword scan, table allow-list,
// secret-column-by-name, wildcard ban) is KEPT — not because it's the
// security boundary (it never fully was one, and IS NOT one now), but
// because it gives a caller an immediate, specific 400 explaining what's
// wrong with their query instead of waiting on a round-trip to discover
// a bare Postgres "permission denied". The role's grants are what
// actually make every bypass this file's header describes come back
// empty/denied no matter what the regex missed.
//
// MIRRORS src/services/debug-access.js's `ensureRole` almost exactly
// (read it first) — same boot-time create/reset-grants/degrade-
// gracefully shape, same "non-blocking, capability disabled on
// failure" posture in server.js's start(). The one structural
// difference: debug-access.js's role is LOGIN (it's used from a
// SEPARATE physical connection/pool with its own generated password,
// because the Claude Code worker process is a different OS process
// with no shared connection to reuse). This role is NOLOGIN and is
// only ever reached via `SET LOCAL ROLE` from WITHIN the app's own
// already-authenticated pooled connection — there is no separate
// credential to generate, rotate, or leak.
'use strict';

const log = require('../logger');
const { getPool } = require('../../db/pool');
const { QUERYABLE_TABLES, EXCLUDED_EXPORT_COLUMNS } = require('./db-allowlist');

const ROLE = 'topochain_console_ro';
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

let _available = false;
let _unavailableReason = 'topochain console role not initialized';

function quoteIdent(name) {
  return `"${name}"`;
}

// Pure-ish (only reads, never writes): turns a live column inventory for
// QUERYABLE_TABLES into the GRANT statements the role needs. Queries
// information_schema itself for the column list (rather than hardcoding
// it) so a column added to an allow-listed table by a future migration
// becomes selectable automatically on the NEXT boot's grant refresh,
// while `EXCLUDED_EXPORT_COLUMNS` is still consulted for the deny side —
// same "fail toward re-granting the good ones, never silently widen the
// denied ones" shape as debug-access.js's `buildGrantStatements`.
// Exported for unit tests (with a mock pool).
async function buildGrantStatements(pool) {
  const { rows } = await pool.query(
    `SELECT table_name AS table, array_agg(column_name::text ORDER BY ordinal_position) AS columns
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      GROUP BY table_name`,
    [QUERYABLE_TABLES]
  );
  const columnsByTable = new Map(rows.map((r) => [r.table, r.columns]));

  const stmts = [];
  for (const table of QUERYABLE_TABLES) {
    if (!SAFE_IDENT.test(table)) continue;
    const columns = columnsByTable.get(table) || [];
    const denied = EXCLUDED_EXPORT_COLUMNS[table];
    if (denied && denied.length) {
      const allowed = columns.filter((c) => SAFE_IDENT.test(c) && !denied.includes(c));
      if (!allowed.length) continue;
      stmts.push(
        `GRANT SELECT (${allowed.map(quoteIdent).join(', ')}) ON public.${quoteIdent(table)} TO ${ROLE}`
      );
    } else {
      stmts.push(`GRANT SELECT ON public.${quoteIdent(table)} TO ${ROLE}`);
    }
  }
  return stmts;
}

// Boot-time ensure (called from server.js's start(), right beside
// debugAccess.ensureRole): create the role if missing, lock it down,
// and refresh grants so tables/columns added by this deploy's
// migrations are covered on every boot. Any failure leaves the
// capability cleanly unavailable — `sql-query/execute` returns 503
// rather than ever falling back to running a console query unscoped.
async function ensureConsoleRole(config) {
  try {
    const pool = getPool(config);

    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
        CREATE ROLE ${ROLE} NOLOGIN;
      END IF;
    END $$;`);
    // NOLOGIN: this role is never connected-to directly, only reached
    // via SET LOCAL ROLE from the app's own pooled connection — there
    // is no password to generate or rotate.
    await pool.query(`ALTER ROLE ${ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOLOGIN`);
    await pool.query(`ALTER ROLE ${ROLE} SET default_transaction_read_only = on`);
    await pool.query(`ALTER ROLE ${ROLE} SET statement_timeout = '10s'`);

    const { rows: dbRows } = await pool.query('SELECT current_database() AS db, current_user AS usr');
    const dbName = dbRows[0].db;
    const dbUser = dbRows[0].usr;
    if (!SAFE_IDENT.test(dbName)) throw new Error(`unsafe database name ${dbName}`);

    await pool.query(`REVOKE ALL ON DATABASE ${quoteIdent(dbName)} FROM ${ROLE}`);
    await pool.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${ROLE}`);
    await pool.query(`REVOKE CREATE ON SCHEMA public FROM ${ROLE}`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);

    // Reset then re-grant (same rationale as debug-access.js: deny-list
    // or allow-list changes take effect on the next boot without
    // needing a manual REVOKE anywhere).
    await pool.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${ROLE}`);
    const grants = await buildGrantStatements(pool);
    for (const stmt of grants) {
      await pool.query(stmt);
    }

    // Let the app's own connecting role SET ROLE to this one. A no-op
    // in this repo's dev/self-hosted setup (the connecting user is
    // Postgres superuser, which can SET ROLE to anything already), but
    // this is what makes `SET LOCAL ROLE` work at all on a deployment
    // where the app connects as a non-superuser role — harmless either
    // way, so it's unconditional rather than superuser-detected.
    if (SAFE_IDENT.test(dbUser)) {
      await pool.query(`GRANT ${ROLE} TO ${quoteIdent(dbUser)}`).catch((err) => {
        log.warn('topochain-console', 'GRANT role-to-connection-user failed (harmless if already superuser)', {
          err: err.message,
        });
      });
    }

    _available = true;
    _unavailableReason = null;
    log.info('topochain-console', 'SQL console role ensured', {
      role: ROLE, db: dbName, grantedTables: grants.length,
    });
  } catch (err) {
    _available = false;
    _unavailableReason = `topochain console role bootstrap failed: ${err.message}`;
    log.warn('topochain-console', 'Role bootstrap failed — console disabled', { err: err.message });
  }
}

function isAvailable() {
  return _available;
}

function unavailableReason() {
  return _unavailableReason;
}

// Test-only reset so a unit test can simulate "never booted" without
// requiring a fresh process.
function _resetForTests() {
  _available = false;
  _unavailableReason = 'topochain console role not initialized';
}

module.exports = {
  ROLE,
  ensureConsoleRole,
  isAvailable,
  unavailableReason,
  buildGrantStatements,
  _resetForTests,
};
