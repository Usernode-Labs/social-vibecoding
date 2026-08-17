// Topochain v4 admin API — read-only delegations list. The partner API
// (../partner.js) owns the delegation state machine; this route only
// makes `account_delegation_periods` legible to admins without the SQL
// console. Deliberately read-only: the mobile app is the delegation
// actor and reconciles its local state against the backend flag, so an
// admin mutation surface would desync phones — see the partner.js header
// for the single-row-per-account model this list inherits (a row is the
// CURRENT or LAST period; re-delegation overwrites history).
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const {
  ok, fail, iso, paginate, meta, ValidationError,
} = require('../helpers');

// No FK ties `account` to `onchain_accounts` (delegations may outlive
// the accounts table across seasons — schema.sql's own comment), so the
// join is LEFT and `onchain_account_id`/`user_id` are null for a
// vanished account rather than the row being hidden.
const DELEGATION_COLUMNS = [
  'adp.id', 'adp.account', 'adp.started_at', 'adp.ended_at',
  'adp.created_at', 'adp.updated_at',
  'oa.id AS onchain_account_id', 'oa.user_id',
].join(', ');
const DELEGATION_FROM = `
  FROM account_delegation_periods adp
  LEFT JOIN onchain_accounts oa ON oa.address = adp.account
`;

function formatDelegation(r) {
  return {
    id: Number(r.id),
    account: r.account,
    delegated: r.ended_at == null,
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    onchain_account_id: r.onchain_account_id != null ? Number(r.onchain_account_id) : null,
    user_id: r.user_id != null ? Number(r.user_id) : null,
  };
}

function delegationsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/delegations ────────────────────────────────────
  router.get('/api/v4/admin/delegations', async (req, res) => {
    try {
      const { page, perPage } = paginate(req);

      const params = [];
      let where = 'WHERE 1=1';
      // Same present-but-malformed discipline as onchain-accounts.js's
      // filters: an unknown status value 422s instead of silently
      // returning the unfiltered list.
      const status = req.query.status === undefined ? 'all' : String(req.query.status);
      if (status === 'delegated') where += ' AND adp.ended_at IS NULL';
      else if (status === 'ended') where += ' AND adp.ended_at IS NOT NULL';
      else if (status !== 'all') {
        return fail(res, 422, 'The given data was invalid.', {
          details: { status: ['The status field must be one of: all, delegated, ended.'] },
        });
      }
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      if (search) {
        params.push(`%${search}%`);
        where += ` AND adp.account ILIKE $${params.length}`;
      }

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM account_delegation_periods adp ${where}`, params
      );
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT ${DELEGATION_COLUMNS} ${DELEGATION_FROM} ${where}
          ORDER BY adp.started_at DESC, adp.id ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, perPage, (page - 1) * perPage]
      );

      return ok(res, { data: rows.map(formatDelegation) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-admin', 'GET /admin/delegations failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { delegationsAdminRoutes };
