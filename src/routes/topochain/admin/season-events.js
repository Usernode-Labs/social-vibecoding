// Topochain v4 admin API — D1 season-events (SPEC 2199-2269, v1
// `/admin/phases`; Task 11). Season -> Event -> Challenge: this is the
// Event level. Every mutating route is gated by `adminWriteGate`; reads
// are covered by the router-wide `adminReadGate` applied in ../admin.js.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const { toIntId, toBool } = require('./util');
const {
  ok, fail, iso, num, paginate, meta, ValidationError,
} = require('../helpers');

// ─── Row shaping ──────────────────────────────────────────────────────

// Full `season_events` row -> the v4 JSON shape, plus whatever `counts`
// the caller already fetched (index: users_count/onchain_accounts_count;
// show: + user_activities_count; create/update: none — SPEC 2238/2262 say
// create/update return the bare row).
function formatEvent(r, counts = {}) {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description,
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    is_active: r.is_active,
    scoring_formula: r.scoring_formula,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    start_epoch: r.start_epoch != null ? Number(r.start_epoch) : null,
    end_epoch: r.end_epoch != null ? Number(r.end_epoch) : null,
    internal: r.internal,
    disclaimer: r.disclaimer,
    display_leaderboard: r.display_leaderboard,
    score_start_time: iso(r.score_start_time),
    score_end_time: iso(r.score_end_time),
    display_disclaimer: r.display_disclaimer,
    chain_id: r.chain_id,
    rank_based_on_bp_or_success_rate: r.rank_based_on_bp_or_success_rate,
    display_activities: r.display_activities,
    season_id: r.season_id != null ? Number(r.season_id) : null,
    type: r.type,
    account_inheritance_mode: r.account_inheritance_mode,
    account_source_season_event_id: r.account_source_season_event_id != null
      ? Number(r.account_source_season_event_id) : null,
    ...counts,
  };
}

// ─── Create/update validation (SPEC 2213-2238, 2244-2262) ─────────────

// Validates the nested `scoring_formula` object: `metrics` (array) and
// `offchain_weight` (numeric >= 0) are both required WHENEVER
// `scoring_formula` itself is present (create: always present; update:
// only when the caller is touching it at all — SPEC 2262 "nested keys
// are required whenever scoring_formula is present").
function validateScoringFormula(value, details) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    details.scoring_formula = ['The scoring_formula field must be an object.'];
    return undefined;
  }
  if (!Array.isArray(value.metrics)) {
    details['scoring_formula.metrics'] = ['The scoring_formula.metrics field is required and must be an array.'];
  }
  const weight = Number(value.offchain_weight);
  if (value.offchain_weight === undefined || value.offchain_weight === null || Number.isNaN(weight) || weight < 0) {
    details['scoring_formula.offchain_weight'] = [
      'The scoring_formula.offchain_weight field is required and must be a number >= 0.',
    ];
  }
  return value;
}

const RANK_BASIS_VALUES = new Set(['BP', 'RATE']);
const EVENT_TYPE_VALUES = new Set(['regular', 'season']);

// Shared field parser for both create (`required = true`) and update
// (`required = false`, every field optional). Returns `{ details, fields }`
// where `fields` only contains keys actually present in `body` (update
// builds a dynamic SET list from this; create fills in defaults for
// anything absent that the DB doesn't already default).
function parseEventFields(body, { required }) {
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

  for (const key of ['starts_at', 'ends_at', 'score_start_time', 'score_end_time']) {
    const nullable = key === 'score_start_time' || key === 'score_end_time';
    if (body[key] === undefined) {
      if (required && (key === 'starts_at' || key === 'ends_at')) details[key] = [`The ${key} field is required.`];
      continue;
    }
    if (body[key] === null) {
      if (nullable) { fields[key] = null; continue; }
      details[key] = [`The ${key} field must be a valid date.`];
      continue;
    }
    const d = new Date(body[key]);
    if (Number.isNaN(d.getTime())) details[key] = [`The ${key} field must be a valid date.`];
    else fields[key] = d;
  }

  if (body.scoring_formula !== undefined) {
    const v = validateScoringFormula(body.scoring_formula, details);
    if (v !== undefined) fields.scoring_formula = v;
  } else if (required) {
    details.scoring_formula = ['The scoring_formula field is required.'];
  }

  if (body.rank_based_on_bp_or_success_rate !== undefined) {
    if (!RANK_BASIS_VALUES.has(body.rank_based_on_bp_or_success_rate)) {
      details.rank_based_on_bp_or_success_rate = ['The rank_based_on_bp_or_success_rate field must be one of: BP, RATE.'];
    } else {
      fields.rank_based_on_bp_or_success_rate = body.rank_based_on_bp_or_success_rate;
    }
  } else if (required) {
    details.rank_based_on_bp_or_success_rate = ['The rank_based_on_bp_or_success_rate field is required.'];
  }

  for (const key of ['description', 'disclaimer', 'chain_id']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string') { details[key] = [`The ${key} field must be a string.`]; continue; }
    fields[key] = body[key];
  }

  for (const key of ['display_disclaimer', 'display_leaderboard', 'display_activities', 'is_active', 'internal']) {
    if (body[key] === undefined) continue;
    const b = toBool(body[key]);
    if (b === undefined) { details[key] = [`The ${key} field must be a boolean.`]; continue; }
    fields[key] = b;
  }

  for (const key of ['start_epoch', 'end_epoch']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < 0) { details[key] = [`The ${key} field must be an integer >= 0.`]; continue; }
    fields[key] = n;
  }

  if (body.season_id !== undefined) {
    if (body.season_id === null) {
      fields.season_id = null;
    } else {
      const id = toIntId(body.season_id);
      if (!id) details.season_id = ['The selected season_id is invalid.'];
      else fields.season_id = id;
    }
  }

  if (body.type !== undefined) {
    if (!EVENT_TYPE_VALUES.has(body.type)) details.type = ['The type field must be one of: regular, season.'];
    else fields.type = body.type;
  }

  // v4 addition (SPEC 2243 note): writable on the model but not accepted
  // by the source endpoint at all — v4 adds them here.
  if (body.account_inheritance_mode !== undefined) {
    if (typeof body.account_inheritance_mode !== 'string' || body.account_inheritance_mode.length > 32) {
      details.account_inheritance_mode = ['The account_inheritance_mode field must be a string of at most 32 characters.'];
    } else {
      fields.account_inheritance_mode = body.account_inheritance_mode;
    }
  }
  if (body.account_source_season_event_id !== undefined) {
    if (body.account_source_season_event_id === null) {
      fields.account_source_season_event_id = null;
    } else {
      const id = toIntId(body.account_source_season_event_id);
      if (!id) details.account_source_season_event_id = ['The selected account_source_season_event_id is invalid.'];
      else fields.account_source_season_event_id = id;
    }
  }

  return { details, fields };
}

function seasonEventsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/season-events (SPEC 2201-2213) ────────────────
  router.get('/api/v4/admin/season-events', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 20 }); // SPEC 2205
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const like = search ? `%${search}%` : null;

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM season_events WHERE ($1::text IS NULL OR name ILIKE $1)`,
        [like]
      );
      const total = countRows[0].c;

      // users_count/onchain_accounts_count are scoped to THIS event only
      // (season_event_id = se.id) — the direct analog of the source's
      // phase-scoped pivot counts, not a season-wide fallback.
      const { rows } = await pool.query(
        `SELECT se.*,
                (SELECT COUNT(*) FROM user_enrollments ue WHERE ue.season_event_id = se.id)::int AS users_count,
                (SELECT COUNT(*) FROM onchain_accounts oa WHERE oa.season_event_id = se.id)::int AS onchain_accounts_count
           FROM season_events se
          WHERE ($1::text IS NULL OR se.name ILIKE $1)
          ORDER BY se.starts_at DESC, se.id DESC
          LIMIT $2 OFFSET $3`,
        [like, perPage, (page - 1) * perPage]
      );

      const data = rows.map((r) => formatEvent(r, {
        users_count: r.users_count,
        onchain_accounts_count: r.onchain_accounts_count,
      }));

      return ok(res, { data }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-admin', 'GET /admin/season-events failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── Business rule shared by create+update: one type='season' event per
  // season (SPEC 2226's note + 2261's "same season-uniqueness rule") ────
  async function seasonAlreadyHasSeasonEvent(seasonId, excludeId) {
    if (seasonId == null) return false;
    const { rows } = await pool.query(
      `SELECT id FROM season_events WHERE season_id = $1 AND type = 'season' AND id IS DISTINCT FROM $2 LIMIT 1`,
      [seasonId, excludeId]
    );
    return rows.length > 0;
  }

  // ── POST /api/v4/admin/season-events (SPEC 2215-2243) ───────────────
  router.post('/api/v4/admin/season-events', adminWriteGate, async (req, res) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const { details, fields } = parseEventFields(body, { required: true });

      if (fields.starts_at && fields.ends_at && !(fields.ends_at > fields.starts_at)) {
        details.ends_at = ['The ends_at field must be a date after starts_at.'];
      }

      const seasonId = fields.season_id ?? null;
      const type = fields.type || 'regular';
      if (!Object.keys(details).length && seasonId != null) {
        const { rows: seasonRows } = await client.query('SELECT id FROM seasons WHERE id = $1', [seasonId]);
        if (!seasonRows.length) details.season_id = ['The selected season_id is invalid.'];
      }
      if (!Object.keys(details).length && fields.account_source_season_event_id != null) {
        const { rows: srcRows } = await client.query(
          'SELECT id FROM season_events WHERE id = $1', [fields.account_source_season_event_id]
        );
        if (!srcRows.length) {
          details.account_source_season_event_id = ['The selected account_source_season_event_id is invalid.'];
        }
      }
      if (!Object.keys(details).length && type === 'season' && seasonId != null
          && await seasonAlreadyHasSeasonEvent(seasonId, null)) {
        details.type = ['A season may only have one event of type season.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      await client.query('BEGIN');
      try {
        const { rows: insertRows } = await client.query(
          `INSERT INTO season_events
             (name, description, starts_at, ends_at, is_active, scoring_formula, created_at, updated_at,
              start_epoch, end_epoch, internal, disclaimer, display_leaderboard, score_start_time,
              score_end_time, display_disclaimer, chain_id, rank_based_on_bp_or_success_rate,
              display_activities, season_id, type, account_inheritance_mode, account_source_season_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW(),$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           RETURNING *`,
          [
            fields.name, fields.description ?? null, fields.starts_at, fields.ends_at,
            fields.is_active ?? true, JSON.stringify(fields.scoring_formula),
            fields.start_epoch ?? null, fields.end_epoch ?? null, fields.internal ?? false,
            fields.disclaimer ?? null, fields.display_leaderboard ?? true,
            fields.score_start_time ?? null, fields.score_end_time ?? null,
            fields.display_disclaimer ?? false, fields.chain_id ?? null,
            fields.rank_based_on_bp_or_success_rate, fields.display_activities ?? false,
            seasonId, type, fields.account_inheritance_mode ?? 'none',
            fields.account_source_season_event_id ?? null,
          ]
        );
        const event = insertRows[0];

        // SPEC 2243: setting season_id auto-enrolls the season's users —
        // every user_enrollments row scoped to the whole season
        // (season_event_id IS NULL) gets a matching event-scoped row.
        // ON CONFLICT DO NOTHING guards the partial unique index (a user
        // already enrolled directly in this brand-new event is
        // impossible, but keeps this idempotent/defensive regardless).
        //
        // JUDGMENT CALL (raised in review, kept as-is): this deliberately
        // does NOT also pull in users who are enrolled in some OTHER
        // event of the same season but have no season-wide row — the
        // schema's own two-tier model (schema.sql's comment on
        // `user_enrollments`) treats a season-wide row as "this user is
        // in the whole season" and an event-scoped row as "this user is
        // in THIS event only"; a user in event A having no bearing on
        // event B is the model working as designed, not a gap. "The
        // season's users" (SPEC 2243) is read as the season-wide set.
        // If a later task's SPEC re-read produces a different verdict,
        // this is the one line to broaden.
        if (seasonId != null) {
          await client.query(
            `INSERT INTO user_enrollments (season_event_id, user_id, season_id, registered_at, created_at, updated_at)
             SELECT $1, ue.user_id, $2, NOW(), NOW(), NOW()
               FROM user_enrollments ue
              WHERE ue.season_id = $2 AND ue.season_event_id IS NULL
             ON CONFLICT DO NOTHING`,
            [event.id, seasonId]
          );
        }

        await client.query('COMMIT');
        return res.status(201).json({ success: true, data: formatEvent(event) });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/season-events failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    } finally {
      client.release();
    }
  });

  // ── GET /api/v4/admin/season-events/:id (SPEC 2245-2247) ────────────
  router.get('/api/v4/admin/season-events/:id', async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Event not found.');

      const { rows } = await pool.query(
        `SELECT se.*,
                (SELECT COUNT(*) FROM user_enrollments ue WHERE ue.season_event_id = se.id)::int AS users_count,
                (SELECT COUNT(*) FROM onchain_accounts oa WHERE oa.season_event_id = se.id)::int AS onchain_accounts_count,
                (SELECT COUNT(*) FROM user_activities ua WHERE ua.season_event_id = se.id)::int AS user_activities_count
           FROM season_events se WHERE se.id = $1`,
        [id]
      );
      const event = rows[0];
      if (!event) return fail(res, 404, 'Event not found.');

      return ok(res, {
        data: formatEvent(event, {
          users_count: event.users_count,
          onchain_accounts_count: event.onchain_accounts_count,
          user_activities_count: event.user_activities_count,
        }),
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/season-events/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PUT|PATCH /api/v4/admin/season-events/:id (SPEC 2249-2262) ───────
  //
  // THE MANDATED FIX (SPEC 2262, §4.8 rule 7): `ends_at` sent alone (no
  // `starts_at` in this same request) must validate `after:starts_at`
  // against the PERSISTED starts_at, not silently pass because there's no
  // sibling value in the body to compare against.
  async function updateEvent(req, res) {
    const id = toIntId(req.params.id);
    if (!id) return fail(res, 404, 'Event not found.');

    try {
      const { rows: existingRows } = await pool.query('SELECT * FROM season_events WHERE id = $1', [id]);
      const existing = existingRows[0];
      if (!existing) return fail(res, 404, 'Event not found.');

      const body = req.body || {};
      const { details, fields } = parseEventFields(body, { required: false });

      const effectiveStarts = fields.starts_at || existing.starts_at;
      const effectiveEnds = fields.ends_at || existing.ends_at;
      if ((fields.starts_at || fields.ends_at) && !(new Date(effectiveEnds) > new Date(effectiveStarts))) {
        details.ends_at = ['The ends_at field must be a date after starts_at.'];
      }

      if (fields.season_id !== undefined && fields.season_id != null) {
        const { rows: seasonRows } = await pool.query('SELECT id FROM seasons WHERE id = $1', [fields.season_id]);
        if (!seasonRows.length) details.season_id = ['The selected season_id is invalid.'];
      }

      const effectiveType = fields.type || existing.type;
      const effectiveSeasonId = fields.season_id !== undefined ? fields.season_id : existing.season_id;
      if (!Object.keys(details).length && effectiveType === 'season' && effectiveSeasonId != null
          && await seasonAlreadyHasSeasonEvent(effectiveSeasonId, id)) {
        details.type = ['A season may only have one event of type season.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const columns = Object.keys(fields);
      if (columns.length === 0) return ok(res, { data: formatEvent(existing) });

      const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
      const values = columns.map((col) => (col === 'scoring_formula' ? JSON.stringify(fields[col]) : fields[col]));
      const { rows: updatedRows } = await pool.query(
        `UPDATE season_events SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...values]
      );

      // No auto-enrollment on update (SPEC 2262's explicit note).
      return ok(res, { data: formatEvent(updatedRows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'PUT /admin/season-events/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }
  router.put('/api/v4/admin/season-events/:id', adminWriteGate, updateEvent);
  router.patch('/api/v4/admin/season-events/:id', adminWriteGate, updateEvent);

  // ── DELETE /api/v4/admin/season-events/:id (SPEC 2264-2269) ─────────
  //
  // Hard delete; every FK from challenges/user_activities/onchain_accounts/
  // user_enrollments/leaderboard_snapshots down to season_events is
  // ON DELETE CASCADE (schema.sql), so this one statement removes the
  // whole subtree exactly as SPEC 2269 describes.
  router.delete('/api/v4/admin/season-events/:id', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Event not found.');

      const { rows } = await pool.query('DELETE FROM season_events WHERE id = $1 RETURNING id', [id]);
      if (!rows.length) return fail(res, 404, 'Event not found.');

      return ok(res, {}, { message: 'Event deleted successfully.' });
    } catch (err) {
      log.error('topochain-admin', 'DELETE /admin/season-events/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { seasonEventsAdminRoutes, formatEvent };
