// Topochain v4 admin API — D10 database tooling, hardened (Task 13;
// SPEC 2852-2920, Global Constraints #9). Four endpoints:
//   GET  /api/v4/admin/database/export       — scoped, redacted SQL dump
//   POST /api/v4/admin/sql-query/execute     — read-only ad-hoc SELECT/WITH
//   GET  /api/v4/admin/sql-query/schema      — queryable-table metadata
//   GET  /api/v4/admin/sql-query/templates   — six canned example queries
//
// AUTH POSTURE (task brief: "read the existing platform export route and
// match its posture for the topochain export"): the platform's OWN
// `GET /api/admin/db-export` (src/routes/admin.js) gates the actual
// download behind `requireAdminWrite` (full admins only — never a
// view-only admin), on top of a password-re-entry ticket, a 3/day rate
// limit, and an audit row, because it streams an UNREDACTED pg_dump of
// the entire platform database (every user's password hash, every app's
// secrets — see that file's own comment block). This export is a much
// smaller blast radius (20 tables, secrets already column-scrubbed, no
// non-topochain data at all), and SPEC 2856 itself only says "Auth:
// admin" for D10 with no confirm step — so the ticket/password-re-entry/
// rate-limit/audit-row machinery is deliberately NOT reproduced here
// (SPEC doesn't ask for it, and it would be a lot of new surface for a
// dump that's already redacted at the source). What IS matched is the
// PRIVILEGE LEVEL: this router's export route requires `adminWriteGate`
// (full admin), not just the router-wide `adminReadGate` a view-only
// admin already passes — a data-egress action stays reserved for full
// admins, consistent with the platform's own stance that "can this admin
// walk away with a copy of the data" is a write-tier decision. The
// `admin.js` composer already applies `adminReadGate` to every request
// under `/api/v4/admin/`, so this file adds `adminWriteGate` ONLY to
// export.
//
// `execute`/`schema`/`templates` stay at the router-wide read gate only
// (no extra `adminWriteGate`) — DELIBERATELY, for `execute` in
// particular: the whole point of Global Constraints #9's hardening is
// that this endpoint CANNOT mutate anything (SELECT/WITH-only statement,
// executed inside `BEGIN TRANSACTION READ ONLY`) — gating a read-only-
// by-construction endpoint behind the write gate would contradict its
// own hardening story: a view-only admin is, by definition, allowed to
// read, and this endpoint is read no matter who calls it.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { fail } = require('../helpers');
const { adminWriteGate } = require('./auth');
const { streamTopochainExport } = require('../../../services/topochain/db-export');
const {
  MAX_QUERY_LENGTH,
  parseLimit,
  runConsoleQuery,
} = require('../../../services/topochain/sql-console');
const { getTopochainSchema } = require('../../../services/topochain/db-schema-info');
const { TEMPLATES } = require('../../../services/topochain/db-query-templates');

function dbToolsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/database/export (SPEC 2854-2862) ───────────────
  //
  // Not §4.8-enveloped (like the platform's own raw file download) — the
  // response body IS the file. Headers are set before any query runs
  // (unlike the platform's docker-exec export, there's no external
  // process here that might fail to even start; the very first bytes
  // written are this module's own header comment, which cannot fail) so
  // a 200 is always committed before the per-table loop begins — exactly
  // the case SPEC 2862's "honest failure" fix has to handle if a LATER
  // table's query throws.
  router.get('/api/v4/admin/database/export', adminWriteGate, async (req, res) => {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const filename = `topochain-export-${stamp}.sql`;
    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200);

    try {
      const result = await streamTopochainExport(pool, res);
      if (result.status === 'failed') {
        log.error('topochain-admin', 'GET /database/export ended in failure', {
          userId: req.user?.id, message: result.error,
        });
      }
    } catch (err) {
      // streamTopochainExport is written to never throw; this is a last-
      // resort net so a bug there can't leave the response hanging open.
      log.error('topochain-admin', 'GET /database/export crashed', { message: err.message });
      try { res.end(`\n-- EXPORT FAILED: ${err.message}\n`); } catch { /* socket already gone */ }
    }
  });

  // ── POST /api/v4/admin/sql-query/execute (SPEC 2864-2893) ────────────
  router.post('/api/v4/admin/sql-query/execute', async (req, res) => {
    const body = req.body || {};
    const query = body.query;

    // Base validation (SPEC 2889: "422 for base validation") — shape/
    // presence/length, BEFORE any statement-content check.
    if (typeof query !== 'string' || query.trim() === '') {
      return fail(res, 422, 'The given data was invalid.', {
        details: { query: ['The query field is required and must be a non-empty string.'] },
      });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return fail(res, 422, 'The given data was invalid.', {
        details: { query: [`The query field must not exceed ${MAX_QUERY_LENGTH} characters.`] },
      });
    }
    const limitResult = parseLimit(body.limit);
    if (limitResult.error) {
      return fail(res, 422, 'The given data was invalid.', {
        details: { limit: ['The limit field must be an integer between 1 and 1000.'] },
      });
    }

    try {
      const outcome = await runConsoleQuery(pool, { query, limit: limitResult.value });

      // Blocked patterns AND SQL errors are both a 400 carrying the
      // original query text back (SPEC 2889) — the only difference is
      // whether `error` explains itself (validation) or stays generic
      // (driver failure; the real message is logged, never echoed —
      // this is `runConsoleQuery`'s own contract, see sql-console.js).
      if (outcome.kind === 'validation_error') {
        return res.status(400).json({ success: false, error: outcome.reason, query });
      }
      if (outcome.kind === 'driver_error') {
        return res.status(400).json({ success: false, error: 'Query failed.', query });
      }

      return res.json({
        success: true,
        data: outcome.data,
        columns: outcome.columns,
        execution_time_ms: outcome.execution_time_ms,
        row_count: outcome.row_count,
        limited: outcome.limited,
        query,
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /sql-query/execute failed unexpectedly', { message: err.message });
      return res.status(400).json({ success: false, error: 'Query failed.', query });
    }
  });

  // ── GET /api/v4/admin/sql-query/schema (SPEC 2895-2912) ──────────────
  router.get('/api/v4/admin/sql-query/schema', async (_req, res) => {
    try {
      const data = await getTopochainSchema(pool);
      return res.json({ success: true, data });
    } catch (err) {
      log.error('topochain-admin', 'GET /sql-query/schema failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/sql-query/templates (SPEC 2914-2920) ───────────
  router.get('/api/v4/admin/sql-query/templates', (_req, res) => {
    return res.json({ success: true, data: TEMPLATES });
  });

  return router;
}

module.exports = { dbToolsAdminRoutes };
