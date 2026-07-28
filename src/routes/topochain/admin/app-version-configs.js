// Topochain v4 admin API — D7 app version configs (SPEC 2747-2787;
// Task 12). One row per mobile OS, gating minimum/recommended client
// build numbers (mobile.js reads these to decide must-update/should-
// update prompts). Every mutating route is gated by `adminWriteGate`;
// reads are covered by the router-wide `adminReadGate` applied in
// ../admin.js.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const {
  toIntId, toBool, toNumber,
} = require('./util');
const { ok, fail, iso } = require('../helpers');

const OS_VALUES = new Set(['ios', 'android']);
const URL_RE = /^https?:\/\/[^\s]+$/i;

function formatConfig(row) {
  return {
    id: Number(row.id),
    os: row.os,
    min_build_number: Number(row.min_build_number),
    recommended_build_number: row.recommended_build_number != null ? Number(row.recommended_build_number) : null,
    current_version: row.current_version,
    must_update_message: row.must_update_message,
    should_update_message: row.should_update_message,
    update_url: row.update_url,
    is_active: row.is_active,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

// Shared field parser for create (`required = true`: os/min_build_number
// mandatory) and update (`required = false`, `os` never accepted at all —
// see the route's own comment on immutability).
function parseConfigFields(body, { required }) {
  const details = {};
  const fields = {};

  if (required) {
    if (body.os === undefined || !OS_VALUES.has(body.os)) {
      details.os = ['The os field is required and must be one of: ios, android.'];
    } else {
      fields.os = body.os;
    }
  }

  if (body.min_build_number !== undefined) {
    // `toNumber` (code-review finding), not bare `Number()`: the latter
    // silently turns `true`/`[]` into a "valid" integer instead of 422ing.
    const n = toNumber(body.min_build_number);
    if (n === undefined || !Number.isInteger(n) || n < 1) details.min_build_number = ['The min_build_number field must be an integer >= 1.'];
    else fields.min_build_number = n;
  } else if (required) {
    details.min_build_number = ['The min_build_number field is required.'];
  }

  if (body.recommended_build_number !== undefined) {
    if (body.recommended_build_number === null) {
      fields.recommended_build_number = null;
    } else {
      const n = toNumber(body.recommended_build_number);
      if (n === undefined || !Number.isInteger(n) || n < 1) details.recommended_build_number = ['The recommended_build_number field must be an integer >= 1.'];
      else fields.recommended_build_number = n;
    }
  }

  if (body.current_version !== undefined) {
    if (body.current_version === null) {
      fields.current_version = null;
    } else if (typeof body.current_version !== 'string' || body.current_version.length > 50) {
      details.current_version = ['The current_version field must be a string of at most 50 characters.'];
    } else {
      fields.current_version = body.current_version;
    }
  }

  for (const key of ['must_update_message', 'should_update_message']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string' || body[key].length > 1000) {
      details[key] = [`The ${key} field must be a string of at most 1000 characters.`];
      continue;
    }
    fields[key] = body[key];
  }

  if (body.update_url !== undefined) {
    if (body.update_url === null) {
      fields.update_url = null;
    } else if (typeof body.update_url !== 'string' || body.update_url.length > 500 || !URL_RE.test(body.update_url)) {
      details.update_url = ['The update_url field must be a valid URL of at most 500 characters.'];
    } else {
      fields.update_url = body.update_url;
    }
  }

  if (body.is_active !== undefined) {
    const b = toBool(body.is_active);
    if (b === undefined) details.is_active = ['The is_active field must be a boolean.'];
    else fields.is_active = b;
  }

  return { details, fields };
}

function appVersionConfigsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/app-version-configs (SPEC 2749-2751) ──────────
  router.get('/api/v4/admin/app-version-configs', async (_req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM app_version_configs ORDER BY os ASC');
      return ok(res, { data: rows.map(formatConfig) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/app-version-configs failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/app-version-configs (SPEC 2753-2769) ─────────
  router.post('/api/v4/admin/app-version-configs', adminWriteGate, async (req, res) => {
    try {
      const body = req.body || {};
      const { details, fields } = parseConfigFields(body, { required: true });

      if (!Object.keys(details).length && fields.recommended_build_number != null
          && fields.recommended_build_number < fields.min_build_number) {
        details.recommended_build_number = ['Recommended build number must be greater than or equal to minimum build number.'];
      }

      if (!Object.keys(details).length) {
        const { rows: existingRows } = await pool.query('SELECT id FROM app_version_configs WHERE os = $1', [fields.os]);
        if (existingRows.length) details.os = ['The os has already been taken.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows } = await pool.query(
        `INSERT INTO app_version_configs
           (os, min_build_number, recommended_build_number, current_version, must_update_message,
            should_update_message, update_url, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
         RETURNING *`,
        [
          fields.os, fields.min_build_number, fields.recommended_build_number ?? null,
          fields.current_version ?? null, fields.must_update_message ?? null,
          fields.should_update_message ?? null, fields.update_url ?? null, fields.is_active ?? true,
        ]
      );

      return res.status(201).json({ success: true, data: formatConfig(rows[0]) });
    } catch (err) {
      // Defense in depth against a concurrent insert racing the pre-check
      // above (app_version_configs.os carries a real UNIQUE constraint).
      if (err && err.code === '23505') {
        return fail(res, 422, 'The given data was invalid.', { details: { os: ['The os has already been taken.'] } });
      }
      log.error('topochain-admin', 'POST /admin/app-version-configs failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/app-version-configs/:id (SPEC 2771-2773) ──────
  router.get('/api/v4/admin/app-version-configs/:id', async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'App version configuration not found.');

      const { rows } = await pool.query('SELECT * FROM app_version_configs WHERE id = $1', [id]);
      if (!rows.length) return fail(res, 404, 'App version configuration not found.');

      return ok(res, { data: formatConfig(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/app-version-configs/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PUT|PATCH /api/v4/admin/app-version-configs/:id (SPEC 2775-2783) ─
  //
  // `os` is immutable (SPEC 2779: "which cannot be changed") — any `os`
  // in the body is silently ignored rather than 422ing, matching D6's
  // `challenge_template_id` and D4-analog conventions elsewhere in this
  // task for "field simply isn't writable here".
  async function updateConfig(req, res) {
    const id = toIntId(req.params.id);
    if (!id) return fail(res, 404, 'App version configuration not found.');

    try {
      const { rows: existingRows } = await pool.query('SELECT * FROM app_version_configs WHERE id = $1', [id]);
      const existing = existingRows[0];
      if (!existing) return fail(res, 404, 'App version configuration not found.');

      const body = req.body || {};
      const { details, fields } = parseConfigFields(body, { required: false });

      // Same persisted-value discipline as the `after:schedule_start`
      // fix elsewhere in this task (§4.8 item 7's general principle):
      // sending `recommended_build_number` alone must compare against the
      // PERSISTED `min_build_number` when the caller isn't touching it in
      // this same request, not silently pass for lack of a sibling value.
      const effectiveMin = fields.min_build_number !== undefined ? fields.min_build_number : existing.min_build_number;
      const effectiveRecommended = fields.recommended_build_number !== undefined
        ? fields.recommended_build_number : existing.recommended_build_number;
      if ((fields.min_build_number !== undefined || fields.recommended_build_number !== undefined)
          && effectiveRecommended != null && effectiveRecommended < effectiveMin) {
        details.recommended_build_number = ['Recommended build number must be greater than or equal to minimum build number.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const columns = Object.keys(fields);
      if (columns.length === 0) return ok(res, { data: formatConfig(existing) });

      const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
      const values = columns.map((col) => fields[col]);
      const { rows: updatedRows } = await pool.query(
        `UPDATE app_version_configs SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...values]
      );

      return ok(res, { data: formatConfig(updatedRows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'PUT /admin/app-version-configs/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }
  router.put('/api/v4/admin/app-version-configs/:id', adminWriteGate, updateConfig);
  router.patch('/api/v4/admin/app-version-configs/:id', adminWriteGate, updateConfig);

  // ── DELETE /api/v4/admin/app-version-configs/:id (SPEC 2785-2787) ────
  router.delete('/api/v4/admin/app-version-configs/:id', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'App version configuration not found.');

      const { rows } = await pool.query('DELETE FROM app_version_configs WHERE id = $1 RETURNING id', [id]);
      if (!rows.length) return fail(res, 404, 'App version configuration not found.');

      return ok(res, {}, { message: 'App version configuration deleted successfully.' });
    } catch (err) {
      log.error('topochain-admin', 'DELETE /admin/app-version-configs/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { appVersionConfigsAdminRoutes };
