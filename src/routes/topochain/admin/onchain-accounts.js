// Topochain v4 admin API — D5 onchain accounts (SPEC 2591-2642, v1
// `/admin/accounts`; Task 12). An `onchain_accounts` row is a testnet
// account (address + keys) granted to a user, scoped to a season or one
// season_event (mirroring `user_enrollments`). Every mutating route is
// gated by `adminWriteGate`; reads are covered by the router-wide
// `adminReadGate` applied in ../admin.js.
'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const { toIntId, toBool, toNumber } = require('./util');
const {
  ok, fail, iso, paginate, meta, ValidationError,
} = require('../helpers');

// ─── Row shaping ────────────────────────────────────────────────────────
//
// `secret_key` is a real testnet credential (schema.sql's own comment on
// `onchain_accounts` calls it out alongside `apps.db_password`) — SPEC
// 2599 is explicit that "secret_key is never exposed by any endpoint",
// so it is kept out of this shared SELECT list, not merely omitted
// from the formatted response (a `SELECT *` that later dropped the key
// in JS would still leak it to a logging/serialization bug downstream).
// ONE deliberate exception, made at the platform owner's explicit
// request (#admin/onchain-accounts detail dialog): the show route below
// appends `oa.secret_key` for FULL admins only (`req.user.canAdminWrite`)
// and attaches it to the response itself — view-only admins and every
// other route (index, import, reset) never carry the column, and the
// staging scrub / prod-debug denial on it are untouched.
const ACCOUNT_COLUMNS = [
  'oa.id', 'oa.season_event_id', 'oa.season_id', 'oa.amount', 'oa.identity_uid',
  'oa.address', 'oa.public_key', 'oa.tier', 'oa.description', 'oa.registration_code',
  'oa.user_id', 'oa.is_used', 'oa.used_at', 'oa.created_at', 'oa.updated_at',
  'se.id AS event_id', 'se.name AS event_name',
  'u.id AS user_id_full', 'u.username AS user_username', 'u.email AS user_email',
  'u.display_name AS user_display_name', 'u.discord AS user_discord',
  // Pre-cutover timestamp history, by address. Once the immutable cutover C
  // exists every period is closed, so these compatibility fields read false
  // and do not compete with the epoch ledger's current policy.
  `EXISTS (SELECT 1 FROM account_delegation_periods adp
            WHERE adp.account = oa.address AND adp.ended_at IS NULL) AS delegated`,
  `(SELECT adp.started_at FROM account_delegation_periods adp
     WHERE adp.account = oa.address AND adp.ended_at IS NULL LIMIT 1) AS delegated_since`,
].join(', ');
const ACCOUNT_FROM = `
  FROM onchain_accounts oa
  LEFT JOIN season_events se ON se.id = oa.season_event_id
  LEFT JOIN users u ON u.id = oa.user_id
`;

// `r` is one row from a query using ACCOUNT_COLUMNS/ACCOUNT_FROM above —
// `event`/`user` are null projections (SPEC 2599: "an `event` projection
// and a `user` projection (null when unassigned)").
function formatAccount(r) {
  return {
    id: Number(r.id),
    season_event_id: r.season_event_id != null ? Number(r.season_event_id) : null,
    season_id: Number(r.season_id),
    amount: Number(r.amount),
    identity_uid: r.identity_uid,
    address: r.address,
    public_key: r.public_key,
    tier: r.tier,
    description: r.description,
    registration_code: r.registration_code,
    user_id: r.user_id != null ? Number(r.user_id) : null,
    is_used: r.is_used,
    used_at: iso(r.used_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    delegated: !!r.delegated,
    delegated_since: iso(r.delegated_since),
    event: r.event_id != null ? { id: Number(r.event_id), name: r.event_name } : null,
    user: r.user_id_full != null ? {
      id: Number(r.user_id_full),
      username: r.user_username,
      email: r.user_email,
      display_name: r.user_display_name,
      discord: r.user_discord != null ? r.user_discord : null,
    } : null,
  };
}

// Server-generated registration code (SPEC 2632: "not accepted from
// input"). 24 random bytes -> 48 hex chars comfortably fits the
// VARCHAR(64) column with enormous (192-bit) collision headroom; the
// caller still verifies uniqueness against the DB before committing
// (belt-and-suspenders — the column also carries a real UNIQUE
// constraint as the final backstop).
function generateRegistrationCode() {
  return crypto.randomBytes(24).toString('hex');
}

function onchainAccountsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/onchain-accounts (SPEC 2593-2599) ──────────────
  //
  // CAP TENSION (documented per plan Task 11 precedent, e.g. admin/
  // users.js's own `defaultPerPage: 200` at SPEC 2277): SPEC's documented
  // default here is 200, but the shared §4.8 `per_page` validation
  // (helpers.js `paginate`) only checks a value the CALLER explicitly
  // supplies against the 1..100 range — it never re-validates the
  // `defaultPerPage` a route passes in, so this route's own 200 default
  // applies untouched when `per_page` is omitted. An explicit
  // `?per_page=200` from a caller, by contrast, DOES 422 (out of range) —
  // only the silent default is allowed to exceed 100. This mirrors admin/
  // users.js's identical resolution of the same tension; not re-litigated
  // per file.
  router.get('/api/v4/admin/onchain-accounts', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 200 }); // SPEC 2597
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const like = search ? `%${search}%` : null;

      const params = [];
      let where = 'WHERE 1=1';
      // THE FIX (code-review finding): a PRESENT-but-malformed
      // `season_event_id` (e.g. `?season_event_id=abc`) used to silently
      // bind a NULL param — `column = NULL` is never true in Postgres, so
      // the query quietly returned zero rows instead of signaling the bad
      // input. Mirrors admin/users.js's own `season_event_id` filter
      // (SPEC 2277 area): a present-but-invalid value 404s.
      if (req.query.season_event_id !== undefined) {
        const seasonEventId = toIntId(req.query.season_event_id);
        if (!seasonEventId) return fail(res, 404, 'Event not found.');
        params.push(seasonEventId);
        where += ` AND oa.season_event_id = $${params.length}`;
      }
      // Mirrors the season_event_id filter above exactly (same
      // present-but-malformed handling): `?season_id=abc` 404s instead of
      // silently binding NULL and returning zero rows.
      if (req.query.season_id !== undefined) {
        const seasonId = toIntId(req.query.season_id);
        if (!seasonId) return fail(res, 404, 'Season not found.');
        params.push(seasonId);
        where += ` AND oa.season_id = $${params.length}`;
      }
      // THE FIX (code-review finding): a PRESENT-but-unparseable `is_used`
      // (e.g. `?is_used=on`) used to make `toBool` return `undefined`,
      // which the old `if (isUsed !== undefined)` guard read as "filter
      // not requested" — silently returning EVERY account (used and
      // unused) with a 200 instead of rejecting the bad input.
      if (req.query.is_used !== undefined) {
        const isUsed = toBool(req.query.is_used);
        if (isUsed === undefined) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { is_used: ['The is_used field must be a boolean.'] },
          });
        }
        params.push(isUsed);
        where += ` AND oa.is_used = $${params.length}`;
      }
      // Legacy-history compatibility filter. Param-less on purpose (EXISTS
      // over open periods) so the shared
      // filter-param ordering the count/list queries rely on is
      // untouched. Same present-but-unparseable discipline as is_used.
      if (req.query.delegated !== undefined) {
        const delegated = toBool(req.query.delegated);
        if (delegated === undefined) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { delegated: ['The delegated field must be a boolean.'] },
          });
        }
        where += delegated
          ? ` AND EXISTS (SELECT 1 FROM account_delegation_periods adp
                WHERE adp.account = oa.address AND adp.ended_at IS NULL)`
          : ` AND NOT EXISTS (SELECT 1 FROM account_delegation_periods adp
                WHERE adp.account = oa.address AND adp.ended_at IS NULL)`;
      }
      if (like) {
        params.push(like);
        const idx = params.length;
        where += ` AND (oa.public_key ILIKE $${idx} OR oa.identity_uid ILIKE $${idx}
                        OR oa.registration_code ILIKE $${idx} OR oa.tier ILIKE $${idx})`;
      }

      const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS c FROM onchain_accounts oa ${where}`, params);
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT ${ACCOUNT_COLUMNS} ${ACCOUNT_FROM} ${where}
          ORDER BY oa.amount DESC, oa.id ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, perPage, (page - 1) * perPage]
      );

      return ok(res, { data: rows.map(formatAccount) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-admin', 'GET /admin/onchain-accounts failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/onchain-accounts/import (SPEC 2605-2632) ──────
  //
  // Registered BEFORE GET /:id below (same route-shadowing discipline as
  // D4's /categories) so "import" is never swallowed as an `:id`.
  //
  // THE FIX (SPEC 2632's ⚠ "row-level errors are caught inside the
  // transaction, so partial imports commit" note, §4.8 item 7): made
  // genuinely atomic by validating EVERY row (types, lengths, and
  // (season_id, public_key) duplicate detection — both against
  // already-stored season-scoped accounts and against earlier rows in
  // this SAME payload) BEFORE issuing a single INSERT. If any row fails, nothing
  // is written at all: the response still reports the row errors (same
  // 201 envelope shape as the source, so existing callers don't need a
  // new error-handling branch), but `imported_count` is 0 and every
  // submitted row counts as skipped, honestly reflecting that none of
  // them landed. Only once every row is clean does the loop open a
  // transaction and commit all of them together.
  router.post('/api/v4/admin/onchain-accounts/import', adminWriteGate, async (req, res) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const details = {};

      // Accounts are season-scoped from Pre Season 2 onward (0..1 per user
      // per season, `onchain_accounts_user_season_unique`). A caller still
      // sending the retired event scope fails loudly rather than silently
      // importing rows the season pool (wallet/provision, CSV linking)
      // would never see.
      if (body.season_event_id !== undefined) {
        details.season_event_id = ['Accounts are imported per season now; send season_id instead of season_event_id.'];
      }

      const seasonId = toIntId(body.season_id);
      if (!seasonId) details.season_id = ['The selected season_id is invalid.'];

      const accounts = Array.isArray(body.accounts) ? body.accounts : null;
      if (!accounts || accounts.length < 1) details.accounts = ['The accounts field is required and must have at least 1 item.'];

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows: seasonRows } = await client.query('SELECT id FROM seasons WHERE id = $1', [seasonId]);
      if (!seasonRows.length) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_id: ['The selected season_id is invalid.'] },
        });
      }

      // Existing (season_id, public_key) pairs among season-scoped rows,
      // fetched once (not per row — the source's N+1 shape task 11 already
      // flagged elsewhere is avoided here too). Event-scoped legacy rows
      // are deliberately NOT consulted: carry-over re-imports the same keys
      // season over season, and the DB's partial uniques agree.
      const { rows: existingRows } = await client.query(
        'SELECT public_key FROM onchain_accounts WHERE season_id = $1 AND season_event_id IS NULL', [seasonId]
      );
      const existingKeys = new Set(existingRows.map((r) => r.public_key));
      const seenInBatch = new Set();

      const errors = [];
      const validated = [];
      for (let i = 0; i < accounts.length; i++) {
        const row = accounts[i] || {};
        const rowNum = i + 1;
        const rowErrors = [];

        // THE FIX (code-review finding): plain `Number(row.amount)` turns
        // `null`/`""`/`[]`/`false` into a "valid" 0, so a malformed CSV
        // cell (a blank string is the realistic case) would silently
        // import as amount 0 instead of tripping the all-or-nothing
        // atomicity this endpoint is built around. `toNumber` rejects all
        // of those up front.
        const amount = toNumber(row.amount);
        if (amount === undefined || !Number.isInteger(amount)) rowErrors.push('amount is required and must be an integer');

        const identityUid = typeof row.identity_uid === 'string' ? row.identity_uid : '';
        if (!identityUid || identityUid.length > 64) rowErrors.push('identity_uid is required and must be at most 64 characters');

        const address = typeof row.address === 'string' ? row.address : '';
        if (!address || address.length > 100) rowErrors.push('address is required and must be at most 100 characters');

        const publicKey = typeof row.public_key === 'string' ? row.public_key : '';
        if (!publicKey || publicKey.length > 64) rowErrors.push('public_key is required and must be at most 64 characters');

        const secretKey = typeof row.secret_key === 'string' ? row.secret_key : '';
        if (!secretKey || secretKey.length > 64) rowErrors.push('secret_key is required and must be at most 64 characters');

        const tier = typeof row.tier === 'string' ? row.tier : '';
        if (!tier || tier.length > 50) rowErrors.push('tier is required and must be at most 50 characters');

        const description = row.description === undefined || row.description === null ? null : String(row.description);

        if (!rowErrors.length && publicKey) {
          if (existingKeys.has(publicKey) || seenInBatch.has(publicKey)) {
            rowErrors.push(`an account with public_key "${publicKey}" already exists for this season`);
          } else {
            seenInBatch.add(publicKey);
          }
        }

        if (rowErrors.length) {
          errors.push(`Row ${rowNum}: ${rowErrors.join('; ')}.`);
        } else {
          validated.push({ amount, identityUid, address, publicKey, secretKey, tier, description });
        }
      }

      if (errors.length) {
        return res.status(201).json({
          success: true,
          data: { imported_count: 0, skipped_count: accounts.length, errors },
        });
      }

      await client.query('BEGIN');
      try {
        for (const acc of validated) {
          // Collision-retry loop (belt-and-suspenders — see
          // generateRegistrationCode's own comment on how unlikely this
          // branch actually is).
          let code = generateRegistrationCode();
          for (let attempt = 0; attempt < 5; attempt++) {
            const { rows: clashRows } = await client.query('SELECT 1 FROM onchain_accounts WHERE registration_code = $1', [code]);
            if (!clashRows.length) break;
            code = generateRegistrationCode();
          }

          await client.query(
            `INSERT INTO onchain_accounts
               (amount, identity_uid, address, public_key, secret_key, tier, description,
                registration_code, season_event_id, season_id, user_id, is_used, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,NULL,FALSE,NOW(),NOW())`,
            [acc.amount, acc.identityUid, acc.address, acc.publicKey, acc.secretKey, acc.tier, acc.description,
              code, seasonId]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }

      return res.status(201).json({
        success: true,
        data: { imported_count: validated.length, skipped_count: 0, errors: [] },
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/onchain-accounts/import failed', { message: err.message });
      return fail(res, 400, 'Account import failed', { code: 'account_import_failed' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/v4/admin/onchain-accounts/:id (SPEC 2601-2603) ──────────
  //
  // The one place `secret_key` is served (see the ACCOUNT_COLUMNS comment
  // above): appended to the SELECT and the response only for full admins.
  // The decision is made on `canAdminWrite`, never on "was the column in
  // the row" — a mock or a future `SELECT *` must not widen the audience.
  router.get('/api/v4/admin/onchain-accounts/:id', async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Account not found.');

      const withSecret = !!(req.user && req.user.canAdminWrite);
      const columns = withSecret ? `${ACCOUNT_COLUMNS}, oa.secret_key` : ACCOUNT_COLUMNS;
      const { rows } = await pool.query(`SELECT ${columns} ${ACCOUNT_FROM} WHERE oa.id = $1`, [id]);
      if (!rows.length) return fail(res, 404, 'Account not found.');

      const account = formatAccount(rows[0]);
      if (withSecret) account.secret_key = rows[0].secret_key;
      return ok(res, { data: account });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/onchain-accounts/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/onchain-accounts/:id/reset (SPEC 2634-2642) ──
  //
  // READING (documented per the task brief's own prompt to decide this
  // carefully): SPEC 2640 only ever says the endpoint "clears" the
  // account's assignment; nothing in the SPEC text says a NEW code is
  // generated, and the surrounding D5 note (2632) treats the code as
  // something issued once at import time, never re-issued afterwards.
  // The verb in the endpoint's NAME ("registration code reset") is read
  // as "reset the account to its pre-registration state" (i.e. undo a
  // user's claim) rather than "regenerate the code" — regenerating would
  // silently invalidate a code that may already be printed/distributed
  // to a participant, which the rest of D5 never asks for. So this
  // clears `user_id`/`is_used`/`used_at` only; `registration_code` is
  // left untouched, and the freed account becomes assignable again
  // (picked up by admin/users.js's own `link_accounts` queue, which
  // selects `is_used = FALSE` rows).
  router.post('/api/v4/admin/onchain-accounts/:id/reset', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Account not found.');

      const { rows: existingRows } = await pool.query('SELECT id FROM onchain_accounts WHERE id = $1', [id]);
      if (!existingRows.length) return fail(res, 404, 'Account not found.');

      await pool.query(
        `UPDATE onchain_accounts SET user_id = NULL, is_used = FALSE, used_at = NULL, updated_at = NOW() WHERE id = $1`,
        [id]
      );

      const { rows } = await pool.query(`SELECT ${ACCOUNT_COLUMNS} ${ACCOUNT_FROM} WHERE oa.id = $1`, [id]);
      // THE FIX (SPEC 2640: "the account object is not returned; v4
      // returns it").
      return ok(res, { data: formatAccount(rows[0]) }, { message: 'Registration code reset successfully.' });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/onchain-accounts/:id/reset failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { onchainAccountsAdminRoutes };
