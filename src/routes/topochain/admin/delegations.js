// Topochain v4 admin API — read-only delegations surface. The partner API
// (../partner.js) owns the delegation state machine; these routes only
// make `account_delegation_periods` legible to admins without the SQL
// console. Deliberately read-only: the mobile app is the delegation
// actor and reconciles its local state against the backend flag, so an
// admin mutation surface would desync phones.
//
// HISTORY MODEL (see the table's schema.sql comment): every period is
// kept; the partial unique index allows one OPEN period per account. The
// index route therefore lists ONE row per account — its latest period,
// with a period_count — and /:account/history serves the full trail.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { toIntId } = require('./util');
const {
  ok, fail, iso, paginate, meta, ValidationError,
} = require('../helpers');

// One row per account: its most recent period (started_at DESC, id DESC
// as the same-instant tie-break) plus how many periods it has ever had.
const LATEST_PERIODS = `
  SELECT p.*, COUNT(*) OVER (PARTITION BY p.account)::int AS period_count,
         ROW_NUMBER() OVER (PARTITION BY p.account ORDER BY p.started_at DESC, p.id DESC) AS rn
    FROM account_delegation_periods p
`;

// No FK ties `account` to `onchain_accounts` (delegations may outlive
// the accounts table across seasons — schema.sql's own comment), so the
// join is LEFT and `onchain_account_id`/`user_id` are null for a
// vanished account rather than the row being hidden.
//
// LATERAL, not a plain LEFT JOIN: the same address exists once PER
// SEASON EVENT in `onchain_accounts` (prod holds up to 9 rows for one
// address, claimed by different users across events), so a plain join
// fans one delegation period out into N list rows while COUNT(*) — which
// only scans adp — still says 1. The lateral picks the account's CURRENT
// claim: a claimed (is_used) row over an unclaimed one, the most recent
// claim first, newest account row as the final tie-break.
const DELEGATION_COLUMNS = [
  'adp.id', 'adp.account', 'adp.started_at', 'adp.ended_at',
  'adp.created_at', 'adp.updated_at', 'adp.period_count',
  'oa.id AS onchain_account_id', 'oa.user_id',
  'u.username', 'u.display_name', 'av.id AS avatar_id',
].join(', ');
const DELEGATION_FROM = `
  FROM (${LATEST_PERIODS}) adp
  LEFT JOIN LATERAL (
    SELECT o.id, o.user_id
      FROM onchain_accounts o
     WHERE o.address = adp.account
     ORDER BY o.is_used DESC, o.used_at DESC NULLS LAST, o.id DESC
     LIMIT 1
  ) oa ON TRUE
  LEFT JOIN users u ON u.id = oa.user_id
  LEFT JOIN user_avatars av ON av.user_id = oa.user_id
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
    period_count: Number(r.period_count),
    onchain_account_id: r.onchain_account_id != null ? Number(r.onchain_account_id) : null,
    user_id: r.user_id != null ? Number(r.user_id) : null,
    // The delegating party, resolved to a person where the account has a
    // current claimant: the same identity fields the console's Users and
    // account-detail surfaces show (username, display name, id) plus the
    // platform avatar. Null when the account is unclaimed or vanished —
    // the UI names those states rather than hiding the row.
    delegator: r.user_id != null ? {
      user_id: Number(r.user_id),
      username: r.username ?? null,
      display_name: r.display_name ?? null,
      avatar_url: r.avatar_id ? `/avatars/${r.avatar_id}` : null,
    } : null,
  };
}

function formatPeriod(r) {
  return {
    id: Number(r.id),
    account: r.account,
    delegated: r.ended_at == null,
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function delegationsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/delegations/stats ──────────────────────────────
  //
  // The screen's summary strip: account-level tallies (an account counts
  // once, by its LATEST period's state) plus the raw period total.
  // "Orphaned" = the address no longer exists in onchain_accounts at all
  // (representable on purpose — the table carries no FK).
  router.get('/api/v4/admin/delegations/stats', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE adp.rn = 1 AND adp.ended_at IS NULL)::int AS delegated_accounts,
          COUNT(*) FILTER (WHERE adp.rn = 1 AND adp.ended_at IS NOT NULL)::int AS ended_accounts,
          COUNT(*) FILTER (WHERE adp.rn = 1 AND NOT EXISTS (
            SELECT 1 FROM onchain_accounts f WHERE f.address = adp.account))::int AS orphaned_accounts,
          COUNT(*)::int AS total_periods
        FROM (${LATEST_PERIODS}) adp
      `);
      const s = rows[0];
      return ok(res, {
        data: {
          delegated_accounts: Number(s.delegated_accounts),
          ended_accounts: Number(s.ended_accounts),
          orphaned_accounts: Number(s.orphaned_accounts),
          total_periods: Number(s.total_periods),
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/delegations/stats failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/delegations ────────────────────────────────────
  router.get('/api/v4/admin/delegations', async (req, res) => {
    try {
      const { page, perPage } = paginate(req);

      const params = [];
      let where = 'WHERE adp.rn = 1';
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
      // Season/event scoping goes through EXISTS over every duplicate of
      // the address (the per-season-event fan-out the LATERAL note above
      // describes): the account belongs to a season/event when ANY of its
      // onchain_accounts rows does. Present-but-malformed 404s, mirroring
      // the onchain-accounts filters.
      if (req.query.season_id !== undefined) {
        const seasonId = toIntId(req.query.season_id);
        if (!seasonId) return fail(res, 404, 'Season not found.');
        params.push(seasonId);
        where += ` AND EXISTS (SELECT 1 FROM onchain_accounts f
                     WHERE f.address = adp.account AND f.season_id = $${params.length})`;
      }
      if (req.query.season_event_id !== undefined) {
        const seasonEventId = toIntId(req.query.season_event_id);
        if (!seasonEventId) return fail(res, 404, 'Event not found.');
        params.push(seasonEventId);
        where += ` AND EXISTS (SELECT 1 FROM onchain_accounts f
                     WHERE f.address = adp.account AND f.season_event_id = $${params.length})`;
      }
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      if (search) {
        params.push(`%${search}%`);
        where += ` AND adp.account ILIKE $${params.length}`;
      }

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM (${LATEST_PERIODS}) adp ${where}`, params
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

  // ── GET /api/v4/admin/delegations/:account/history ───────────────────
  //
  // The full trail for one account, newest first. An account with no
  // periods gets an empty list, not a 404 — "no history" is a legitimate
  // answer, and the UI only asks for rows it is already showing.
  router.get('/api/v4/admin/delegations/:account/history', async (req, res) => {
    try {
      const account = String(req.params.account || '');
      if (!account || account.length > 255) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { account: ['The account field must be at most 255 characters.'] },
        });
      }
      const { rows } = await pool.query(
        `SELECT id, account, started_at, ended_at, created_at, updated_at
           FROM account_delegation_periods
          WHERE account = $1
          ORDER BY started_at DESC, id DESC`,
        [account]
      );
      return ok(res, { data: rows.map(formatPeriod) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/delegations/:account/history failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { delegationsAdminRoutes };
