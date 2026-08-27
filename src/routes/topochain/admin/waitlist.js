// Topochain v4 admin API — platform waitlist + block-producer queue
// (onboarding flow alignment). Reads are covered by the router-wide
// `adminReadGate` applied in ../admin.js; every mutating route is gated
// by `adminWriteGate`, matching users.js.
//
// Two queues, two release actions:
//   - Platform waitlist (`waitlist_signups`, keyed by EMAIL): "release"
//     marks the row released and grants `has_platform_access` to the
//     linked account if one exists — otherwise the grant happens
//     automatically when the email registers (services/waitlist.js).
//   - Block-producer queue (`users.bp_requested_at`): "release" sets
//     `bp_released_at`, which is what lets the mobile node enable its
//     block producer (surfaced via GET /api/v4/mobile/me).
// Plus a direct per-user access grant for accounts that never joined
// the waitlist.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const waitlist = require('../../../services/waitlist');
const { signalsFor } = require('../../../services/waitlist-signals');
const { sendWaitlistReleaseMail } = require('../../../services/topochain/mailer');
const { adminWriteGate } = require('./auth');
const { toIntId } = require('./util');
const { ok, fail, iso, paginate, meta } = require('../helpers');

function formatSignup(row) {
  return {
    id: Number(row.id),
    email: row.email,
    submitted_at: iso(row.submitted_at),
    released_at: iso(row.released_at),
    // NULL after a join means the address never followed the confirm link
    // in its mail — it was never proved able to receive mail at all, which
    // is worth seeing before releasing the row.
    confirmed_at: iso(row.confirmed_at),
    linked_user_id: row.linked_user_id != null ? Number(row.linked_user_id) : null,
    linked_username: row.linked_username ?? null,
    has_platform_access: row.has_platform_access ?? null,
    // Two-stage survey payload (versioned JSON — stage 1 at join, stage 2
    // merged in via the "Want in sooner?" form). Null for plain-email rows.
    answers: row.answers && typeof row.answers === 'object' ? row.answers : null,
    // What this signup actually DID, derived in one place
    // (services/waitlist-signals.js) so this screen and any future ranking
    // read the same facts. Facts only: there is deliberately no score.
    signals: signalsFor(row),
  };
}

function formatBpUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    bp_requested_at: iso(row.bp_requested_at),
    bp_released_at: iso(row.bp_released_at),
    has_platform_access: row.has_platform_access,
  };
}

function waitlistAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/waitlist ────────────────────────────────────────
  // `?status=pending|released` filters; default lists everything,
  // pending first, oldest submission first within each group (FIFO —
  // the natural release order for a queue, and the only order this ships).
  //
  // `?only=confirmed|invited` narrows further, and `?sort=answered` is an
  // admin's manual lens over the same rows — how much someone filled in,
  // which is a coarse proxy and deliberately NOT a score. Nothing here
  // ranks the queue automatically.
  router.get('/api/v4/admin/waitlist', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 200 });
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      const only = typeof req.query.only === 'string' ? req.query.only : '';
      const clauses = [];
      if (status === 'pending') clauses.push('w.released_at IS NULL');
      else if (status === 'released') clauses.push('w.released_at IS NOT NULL');
      if (only === 'confirmed') clauses.push('w.confirmed_at IS NOT NULL');
      else if (only === 'invited') {
        clauses.push('EXISTS (SELECT 1 FROM waitlist_signups c WHERE c.invited_by = w.id)');
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

      // The key count is computed in SQL rather than from signalsFor
      // because the list is PAGINATED: sorting the 200 rows a page happens
      // to contain would order each page against itself. jsonb_object_keys
      // rejects a non-object and these rows come from a public endpoint
      // across several schema versions, so the typeof guard is
      // load-bearing. `_version` is counted along with the real sections;
      // for a coarse ordering that is fine.
      const answeredCount = `
        CASE WHEN jsonb_typeof(w.answers) = 'object'
             THEN (SELECT COUNT(*) FROM jsonb_object_keys(w.answers))
             ELSE 0 END`;
      const order = req.query.sort === 'answered'
        ? `ORDER BY (w.released_at IS NOT NULL),
                    (w.confirmed_at IS NOT NULL) DESC,
                    ${answeredCount} DESC,
                    w.submitted_at ASC, w.id ASC`
        : 'ORDER BY (w.released_at IS NOT NULL), w.submitted_at ASC, w.id ASC';

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM waitlist_signups w ${where}`
      );
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT w.id, w.email, w.submitted_at, w.released_at, w.confirmed_at,
                w.linked_user_id, w.answers,
                (SELECT COUNT(*)::int FROM waitlist_signups c WHERE c.invited_by = w.id)
                  AS invited_count,
                u.username AS linked_username, u.has_platform_access
           FROM waitlist_signups w
           LEFT JOIN users u ON u.id = w.linked_user_id
          ${where}
          ${order}
          LIMIT $1 OFFSET $2`,
        [perPage, (page - 1) * perPage]
      );

      return ok(res, { data: rows.map(formatSignup) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/waitlist failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/waitlist/:id/release ──────────────────────────
  // Idempotent: re-releasing keeps the original released_at. Works with
  // or without a linked account (see services/waitlist.js).
  router.post('/api/v4/admin/waitlist/:id/release', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Waitlist entry not found.');
      const released = await waitlist.releaseWaitlistSignup(pool, id);
      if (!released) return fail(res, 404, 'Waitlist entry not found.');
      log.info('topochain-admin', 'Waitlist entry released', {
        signupId: id, linkedUserId: released.linked_user_id, adminId: req.user?.id,
      });
      // "You're in" notification — first release only (re-releases are
      // idempotent no-ops and must not re-email). Degrades silently when
      // no mail transport is configured; never fails the release.
      if (released.newly_released) {
        await sendWaitlistReleaseMail(config, released.email, {
          hasAccount: released.linked_user_id != null,
        });
      }
      return ok(res, {
        data: {
          id: Number(released.id),
          email: released.email,
          released_at: iso(released.released_at),
          linked_user_id: released.linked_user_id != null ? Number(released.linked_user_id) : null,
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/waitlist/:id/release failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/users/:id/grant-access ────────────────────────
  // Direct platform-access grant for an account that never joined the
  // waitlist. Idempotent.
  router.post('/api/v4/admin/users/:id/grant-access', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'User not found.');
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
      if (!rows.length) return fail(res, 404, 'User not found.');
      await waitlist.grantPlatformAccess(pool, id);
      log.info('topochain-admin', 'Platform access granted directly', { userId: id, adminId: req.user?.id });
      return ok(res, { data: { id, has_platform_access: true } });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/users/:id/grant-access failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/bp-queue ────────────────────────────────────────
  // Users who asked to produce blocks. `?status=pending|released`;
  // default everything, pending first, oldest request first.
  router.get('/api/v4/admin/bp-queue', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 200 });
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      let where = 'WHERE bp_requested_at IS NOT NULL';
      if (status === 'pending') where += ' AND bp_released_at IS NULL';
      else if (status === 'released') where += ' AND bp_released_at IS NOT NULL';

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM users ${where}`
      );
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT id, username, email, display_name, bp_requested_at, bp_released_at,
                has_platform_access
           FROM users ${where}
          ORDER BY (bp_released_at IS NOT NULL), bp_requested_at ASC, id ASC
          LIMIT $1 OFFSET $2`,
        [perPage, (page - 1) * perPage]
      );

      return ok(res, { data: rows.map(formatBpUser) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/bp-queue failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/users/:id/release-bp ──────────────────────────
  // Manual block-producer key release. Idempotent. Allowed even if the
  // user never formally requested (bp_requested_at is backfilled) so an
  // admin can hand-pick producers.
  router.post('/api/v4/admin/users/:id/release-bp', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'User not found.');
      const { rows } = await pool.query(
        `UPDATE users
            SET bp_requested_at = COALESCE(bp_requested_at, NOW()),
                bp_released_at = COALESCE(bp_released_at, NOW())
          WHERE id = $1
          RETURNING id, username, email, display_name, bp_requested_at, bp_released_at,
                    has_platform_access`,
        [id]
      );
      if (!rows.length) return fail(res, 404, 'User not found.');
      log.info('topochain-admin', 'Block production released', { userId: id, adminId: req.user?.id });
      return ok(res, { data: formatBpUser(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/users/:id/release-bp failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { waitlistAdminRoutes };
