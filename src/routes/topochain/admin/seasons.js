// Topochain v4 admin API — seasons CRUD. Season -> Event -> Challenge:
// this is the SEASON level, the one tier of the hierarchy that had no
// admin API at all until now (the admin console's Seasons screen used to
// be a client-side grouping of `season-events` by their `season_id`).
//
// NOTE there is no schema work here: `seasons` already exists in
// src/db/schema.sql with every column this module writes. `created_at` /
// `updated_at` are nullable with NO database default though, so both
// INSERT and UPDATE set them to NOW() explicitly, exactly as
// ./season-events.js does.
//
// Every mutating route is gated by `adminWriteGate`; reads are covered by
// the router-wide `adminReadGate` applied in ../admin.js.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const { toIntId, toBool, toNumber } = require('./util');
const {
  ok, fail, iso, paginate, meta, ValidationError,
} = require('../helpers');

// ─── Row shaping ──────────────────────────────────────────────────────

// Full `seasons` row -> the v4 JSON shape, plus whatever `counts` the
// caller already fetched (index: season_events_count/users_count/
// onchain_accounts_count; show: + token_allocation_count; create/update:
// none — matching season-events.js, whose create/update return the bare
// row).
function formatSeason(r, counts = {}) {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description,
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    is_active: r.is_active,
    internal: r.internal,
    display_order: r.display_order != null ? Number(r.display_order) : 0,
    pool_info: r.pool_info,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    ...counts,
  };
}

// ─── Create/update validation ─────────────────────────────────────────

// Shared by create (`required = true`: name/starts_at/ends_at mandatory)
// and update (`required = false`: every field optional, same rules once
// present). `fields` only contains keys actually present in `body`, so
// update's caller can build a dynamic SET list from it.
//
// The `ends_at > starts_at` rule is deliberately NOT enforced here: on a
// partial update only the ROUTE knows the persisted counterpart of a
// field sent alone (the same §4.8 rule-7 pitfall season-events.js:396 and
// challenge-templates.js:296 already fix).
function parseSeasonFields(body, { required }) {
  const details = {};
  const fields = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 255) {
      details.name = ['The name field is required and must be a string of at most 255 characters.'];
    } else {
      fields.name = body.name;
    }
  } else if (required) {
    details.name = ['The name field is required.'];
  }

  for (const key of ['starts_at', 'ends_at']) {
    if (body[key] === undefined) {
      if (required) details[key] = [`The ${key} field is required.`];
      continue;
    }
    if (body[key] === null) {
      details[key] = [`The ${key} field must be a valid date.`];
      continue;
    }
    const d = new Date(body[key]);
    if (Number.isNaN(d.getTime())) details[key] = [`The ${key} field must be a valid date.`];
    else fields[key] = d;
  }

  // Nullable free text. `pool_info` is VARCHAR(255) on the table (it holds
  // a human-readable prize/token-pool blurb — production stores the bare
  // string "500000"); `description` is unbounded TEXT.
  if (body.description !== undefined) {
    if (body.description === null) {
      fields.description = null;
    } else if (typeof body.description !== 'string') {
      details.description = ['The description field must be a string.'];
    } else {
      fields.description = body.description;
    }
  }
  if (body.pool_info !== undefined) {
    if (body.pool_info === null) {
      fields.pool_info = null;
    } else if (typeof body.pool_info !== 'string' || body.pool_info.length > 255) {
      details.pool_info = ['The pool_info field must be a string of at most 255 characters.'];
    } else {
      fields.pool_info = body.pool_info;
    }
  }

  for (const key of ['is_active', 'internal']) {
    if (body[key] === undefined) continue;
    const b = toBool(body[key]);
    if (b === undefined) { details[key] = [`The ${key} field must be a boolean.`]; continue; }
    fields[key] = b;
  }

  // display_order is a SORT KEY, not a count — negatives are legal (they
  // simply sort a season above the default 0 block). `toNumber` rather
  // than bare `Number()` so `true`/`[]`/`''` 422 instead of silently
  // becoming 1/0.
  if (body.display_order !== undefined) {
    const n = toNumber(body.display_order);
    if (n === undefined || !Number.isInteger(n)) {
      details.display_order = ['The display_order field must be an integer.'];
    } else {
      fields.display_order = n;
    }
  }

  return { details, fields };
}

// The four tables whose FK to `seasons(id)` is ON DELETE CASCADE
// (schema.sql: season_events, user_enrollments, onchain_accounts,
// token_allocation). See the DELETE route for why we refuse rather than
// let that cascade run.
const REFERENCING_TABLES = [
  { table: 'season_events', label: 'season event' },
  { table: 'user_enrollments', label: 'enrollment' },
  { table: 'onchain_accounts', label: 'onchain account' },
  { table: 'token_allocation', label: 'token allocation' },
];

function seasonsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/seasons ───────────────────────────────────────
  //
  // Counts are scalar sub-selects, matching the season-events index. At
  // this table's scale (a handful of seasons) that is free; a seasons
  // list that ever grew past a page or two would want one grouped
  // aggregate instead.
  //
  // `users_count` counts the SEASON-WIDE enrollments only
  // (season_event_id IS NULL) — the schema's own two-tier model treats a
  // season-wide row as "this user is in the whole season" and an
  // event-scoped row as "this user is in THIS event only", so summing
  // both would double-count anyone auto-enrolled into an event.
  router.get('/api/v4/admin/seasons', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 20 });
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const like = search ? `%${search}%` : null;

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM seasons
          WHERE ($1::text IS NULL OR name ILIKE $1 OR description ILIKE $1)`,
        [like]
      );
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT s.*,
                (SELECT COUNT(*) FROM season_events se WHERE se.season_id = s.id)::int AS season_events_count,
                (SELECT COUNT(*) FROM user_enrollments ue
                  WHERE ue.season_id = s.id AND ue.season_event_id IS NULL)::int AS users_count,
                (SELECT COUNT(*) FROM onchain_accounts oa WHERE oa.season_id = s.id)::int AS onchain_accounts_count
           FROM seasons s
          WHERE ($1::text IS NULL OR s.name ILIKE $1 OR s.description ILIKE $1)
          ORDER BY s.display_order ASC, s.starts_at DESC, s.id DESC
          LIMIT $2 OFFSET $3`,
        [like, perPage, (page - 1) * perPage]
      );

      const data = rows.map((r) => formatSeason(r, {
        season_events_count: r.season_events_count,
        users_count: r.users_count,
        onchain_accounts_count: r.onchain_accounts_count,
      }));

      return ok(res, { data }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-admin', 'GET /admin/seasons failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/seasons ──────────────────────────────────────
  router.post('/api/v4/admin/seasons', adminWriteGate, async (req, res) => {
    try {
      const body = req.body || {};
      const { details, fields } = parseSeasonFields(body, { required: true });

      if (fields.starts_at && fields.ends_at && !(fields.ends_at > fields.starts_at)) {
        details.ends_at = ['The ends_at field must be a date after starts_at.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows } = await pool.query(
        `INSERT INTO seasons
           (name, description, starts_at, ends_at, is_active, internal, display_order, pool_info,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
         RETURNING *`,
        [
          fields.name, fields.description ?? null, fields.starts_at, fields.ends_at,
          fields.is_active ?? true, fields.internal ?? false,
          fields.display_order ?? 0, fields.pool_info ?? null,
        ]
      );

      return res.status(201).json({ success: true, data: formatSeason(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/seasons failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/seasons/:id ───────────────────────────────────
  router.get('/api/v4/admin/seasons/:id', async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Season not found.');

      const { rows } = await pool.query(
        `SELECT s.*,
                (SELECT COUNT(*) FROM season_events se WHERE se.season_id = s.id)::int AS season_events_count,
                (SELECT COUNT(*) FROM user_enrollments ue
                  WHERE ue.season_id = s.id AND ue.season_event_id IS NULL)::int AS users_count,
                (SELECT COUNT(*) FROM onchain_accounts oa WHERE oa.season_id = s.id)::int AS onchain_accounts_count,
                (SELECT COUNT(*) FROM token_allocation ta WHERE ta.season_id = s.id)::int AS token_allocation_count
           FROM seasons s WHERE s.id = $1`,
        [id]
      );
      const season = rows[0];
      if (!season) return fail(res, 404, 'Season not found.');

      return ok(res, {
        data: formatSeason(season, {
          season_events_count: season.season_events_count,
          users_count: season.users_count,
          onchain_accounts_count: season.onchain_accounts_count,
          token_allocation_count: season.token_allocation_count,
        }),
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/seasons/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PUT|PATCH /api/v4/admin/seasons/:id ─────────────────────────────
  //
  // Same §4.8 rule-7 fix as events/templates: `ends_at` sent alone (no
  // `starts_at` in this same request) validates against the PERSISTED
  // starts_at rather than silently passing for want of a sibling value.
  async function updateSeason(req, res) {
    const id = toIntId(req.params.id);
    if (!id) return fail(res, 404, 'Season not found.');

    try {
      const { rows: existingRows } = await pool.query('SELECT * FROM seasons WHERE id = $1', [id]);
      const existing = existingRows[0];
      if (!existing) return fail(res, 404, 'Season not found.');

      const body = req.body || {};
      const { details, fields } = parseSeasonFields(body, { required: false });

      const effectiveStarts = fields.starts_at !== undefined ? fields.starts_at : existing.starts_at;
      const effectiveEnds = fields.ends_at !== undefined ? fields.ends_at : existing.ends_at;
      if ((fields.starts_at !== undefined || fields.ends_at !== undefined)
          && effectiveStarts && effectiveEnds
          && !(new Date(effectiveEnds) > new Date(effectiveStarts))) {
        details.ends_at = ['The ends_at field must be a date after starts_at.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const columns = Object.keys(fields);
      if (columns.length === 0) return ok(res, { data: formatSeason(existing) });

      const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
      const values = columns.map((col) => fields[col]);
      const { rows: updatedRows } = await pool.query(
        `UPDATE seasons SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...values]
      );

      return ok(res, { data: formatSeason(updatedRows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'PUT /admin/seasons/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }
  router.put('/api/v4/admin/seasons/:id', adminWriteGate, updateSeason);
  router.patch('/api/v4/admin/seasons/:id', adminWriteGate, updateSeason);

  // ── DELETE /api/v4/admin/seasons/:id ────────────────────────────────
  //
  // GUARDED, not a cascade — the same stance challenge-templates.js takes,
  // and for a much bigger blast radius. Four tables carry ON DELETE
  // CASCADE to `seasons` (season_events, user_enrollments,
  // onchain_accounts, token_allocation), so a bare DELETE of a live season
  // would silently destroy every event under it and, transitively, those
  // events' challenges and user activity. Worse,
  // `leaderboard_snapshots.season_id` is a plain BIGINT with NO foreign
  // key at all, so its rows would be left DANGLING rather than cleaned.
  // A season only deletes once nothing references it.
  router.delete('/api/v4/admin/seasons/:id', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Season not found.');

      const { rows: existingRows } = await pool.query('SELECT id FROM seasons WHERE id = $1', [id]);
      if (!existingRows.length) return fail(res, 404, 'Season not found.');

      const blockers = [];
      for (const { table, label } of REFERENCING_TABLES) {
        // Table names come from the module-level constant above, never
        // from request input — there is nothing to parameterize here.
        const { rows: refRows } = await pool.query(
          `SELECT COUNT(*)::int AS c FROM ${table} WHERE season_id = $1`, [id]
        );
        if (refRows[0].c > 0) blockers.push(`${refRows[0].c} ${label}(s)`);
      }
      if (blockers.length) {
        return fail(
          res, 409,
          `Cannot delete this season: ${blockers.join(', ')} still reference it.`,
          { code: 'season_in_use' }
        );
      }

      await pool.query('DELETE FROM seasons WHERE id = $1', [id]);
      return ok(res, {}, { message: 'Season deleted successfully.' });
    } catch (err) {
      // Defense in depth: a concurrent insert between the counts above and
      // this DELETE would otherwise surface as a raw 23503.
      if (err && err.code === '23503') {
        return fail(res, 409, 'Cannot delete this season: it is still referenced by other records.', {
          code: 'season_in_use',
        });
      }
      log.error('topochain-admin', 'DELETE /admin/seasons/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { seasonsAdminRoutes, formatSeason };
