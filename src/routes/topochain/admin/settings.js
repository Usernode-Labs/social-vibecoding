// Topochain v4 admin API — D9 settings (SPEC 2793-2850, v1 `/admin/
// point-settings`; Task 12). In v4 these live as `topochain_`-prefixed
// rows in the platform's own `platform_settings` table (§3.5; schema.sql
// Task 2), NOT a separate table — this router is scoped to ONLY that key
// namespace, enforced on every read and write.
//
// RESOURCE ID (documented per the task brief's prompt): `platform_settings`
// has no numeric id — `key` (TEXT) is its primary key — so every route
// below addresses a setting by `/:key`, not `/:id`. `toIntId` (used by
// every OTHER admin resource in this task) doesn't apply here at all.
//
// CACHE INTERACTION (documented per the task brief's prompt to check this):
// `src/services/limits.js` keeps a 10s in-process cache, but its
// `readSettingCents` is only ever called with one of its own three
// hardcoded keys (`KEY_USER` = 'user_daily_limit_cents', `KEY_GLOBAL` =
// 'global_daily_limit_cents', `KEY_SYSTEM` = 'system_tokens_daily_limit_
// cents') — nothing in this codebase reads a `topochain_*` key through
// that module, and this router never writes to KEY_USER/KEY_GLOBAL/
// KEY_SYSTEM (the prefix guard below makes that structurally impossible).
// So a `topochain_*` row can never enter limits.js's cache in the first
// place, and calling `invalidate()` from any route below would be an
// inert no-op — deliberately NOT called here, so a future reader doesn't
// mistake its absence for a missed fix.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const { toNumber } = require('./util');
const { ok, fail, iso } = require('../helpers');

const PREFIX = 'topochain_';
// THE FIX (code-review finding): a plain `LIKE 'topochain_%'` pattern does
// NOT enforce the literal `topochain_` prefix — SQL LIKE treats a bare `_`
// as a single-character WILDCARD, so e.g. `topochainXfoo` or exactly
// `topochain_` (with nothing after it, which `isTopochainKey` below
// rejects) would ALSO match, diverging from every other route in this
// file (which all gate via `isTopochainKey`, a literal-prefix JS check).
// Escaping the literal underscore makes the SQL-side filter agree with
// the JS-side one.
const PREFIX_LIKE_PATTERN = `${PREFIX.replace('_', '\\_')}%`;

// The six keys POST /reset re-seeds (SPEC 2829-2840, verbatim values —
// the exact same six rows schema.sql's Task-2 seed inserts). Note this is
// six, not the seven `topochain_*` keys that actually exist in
// `platform_settings` today: `topochain_inviting_new_participant_points`
// (schema.sql's own Task-2 comment explains why a 7th key was seeded at
// all) is real and reachable through every OTHER route in this file, but
// is deliberately NOT one of the defaults /reset restores — SPEC's own
// reset table only ever lists six.
const RESET_DEFAULTS = [
  { key: 'topochain_first_block_points', value: '250', description: "Points awarded for producing a season event's first block." },
  { key: 'topochain_produced_half_blocks_points', value: '0', description: 'Points awarded for producing at least half of the expected blocks.' },
  { key: 'topochain_top_1_points', value: '1500', description: 'Points awarded for finishing rank 1 on the leaderboard.' },
  { key: 'topochain_top_2_points', value: '1000', description: 'Points awarded for finishing rank 2 on the leaderboard.' },
  { key: 'topochain_top_3_points', value: '500', description: 'Points awarded for finishing rank 3 on the leaderboard.' },
  { key: 'topochain_success_50_percent_points', value: '1000', description: 'Points awarded for a block-production success rate of at least 50%.' },
];

function isTopochainKey(key) {
  return typeof key === 'string' && key.startsWith(PREFIX) && key.length > PREFIX.length;
}

function formatSetting(row) {
  return {
    key: row.key,
    value: Number(row.value),
    description: row.description,
    updated_at: iso(row.updated_at),
    updated_by: row.updated_by != null ? Number(row.updated_by) : null,
  };
}

// Numeric >= 0 (SPEC's `value` rule on both create and update); returns
// `undefined` (not NaN) on anything that doesn't qualify, so callers can
// tell "not a valid number" from "legitimately 0". Built on `toNumber`
// (code-review finding), not bare `Number()`: the latter silently turns
// `true`/`[]` into a "valid" 0 or 1 instead of rejecting them.
function parseValue(v) {
  const n = toNumber(v);
  if (n === undefined || n < 0) return undefined;
  return n;
}

function settingsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/settings (SPEC 2797-2799) ──────────────────────
  router.get('/api/v4/admin/settings', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM platform_settings WHERE key LIKE $1 ESCAPE '\\' ORDER BY key ASC`,
        [PREFIX_LIKE_PATTERN]
      );
      return ok(res, { data: rows.map(formatSetting) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/settings failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/settings/mail-status ───────────────────────────
  //
  // NOT a platform_settings row — outbound mail is configured through
  // platform_env (dapp.json → "Platform mail"), not this table. It is
  // surfaced here because Topochain → Settings is where an admin looks
  // when asking "is this subsystem actually working?", and mail is the
  // one part that can be entirely broken while every endpoint reports
  // success: both senders are always-200 by contract (SPEC 1667), so an
  // unconfigured transport is invisible from the outside.
  //
  // MUST stay registered ahead of GET /:key below, or `mail-status` is
  // swallowed as a settings key.
  //
  // Returns presence only — never the endpoint, never the credential. The
  // sender address IS returned: it is public (it's in the From of every
  // mail we send) and it is the one value an admin has to be able to
  // check.
  router.get('/api/v4/admin/settings/mail-status', (_req, res) => {
    const mail = require('../../../services/mail');
    return ok(res, { data: mail.describe(process.env) });
  });

  // ── GET /api/v4/admin/settings/mail-activity ─────────────────────────
  //
  // The other half of the same question. mail-status says whether mail
  // CAN go out; this says what actually happened to the last few sends —
  // which is the only place that shows up, because the endpoints that
  // trigger mail are always-200 and cannot report a delivery failure to
  // the user who was waiting for it.
  //
  // Recipients are returned in full: an admin chasing "this user says the
  // code never arrived" needs to match the address, and this route already
  // sits behind the admin guard on the whole router. The message body is
  // never stored, so a login code cannot appear here.
  //
  // MUST stay registered ahead of GET /:key below, same reason as
  // mail-status.
  router.get('/api/v4/admin/settings/mail-activity', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, kind, recipient, provider, status, error, created_at
           FROM mail_deliveries
          ORDER BY created_at DESC, id DESC
          LIMIT 20`
      );
      const { rows: totals } = await pool.query(
        `SELECT status, COUNT(*)::int AS n
           FROM mail_deliveries
          WHERE created_at > NOW() - INTERVAL '24 hours'
          GROUP BY status`
      );
      return ok(res, {
        data: {
          recent: rows,
          last24h: totals.reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {}),
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/settings/mail-activity failed',
        { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/settings/reset (SPEC 2825-2840) ──────────────
  //
  // Registered BEFORE POST /:key-shaped routes below is moot here (this
  // whole group has no generic POST /:key route to shadow), but kept
  // ahead of the /batch-update route textually for readability, matching
  // this task's "specific routes before resource routes" convention.
  //
  // THE FIX (SPEC 2840's ⚠ "source TRUNCATEs the whole table... no
  // confirmation" note, §4.8 item 7): requires an explicit
  // `{"confirm": true}` body, and UPSERTs only the six named defaults
  // above — every OTHER `topochain_*` key (including the 7th,
  // `topochain_inviting_new_participant_points`, and any admin-created
  // custom key) is left completely untouched, not truncated.
  router.post('/api/v4/admin/settings/reset', adminWriteGate, async (req, res) => {
    try {
      const body = req.body || {};
      if (body.confirm !== true) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { confirm: ['The confirm field must be true to reset settings.'] },
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const def of RESET_DEFAULTS) {
          await client.query(
            `INSERT INTO platform_settings (key, value, description, updated_at, updated_by)
             VALUES ($1, $2, $3, NOW(), $4)
             ON CONFLICT (key) DO UPDATE
               SET value = EXCLUDED.value, description = EXCLUDED.description,
                   updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
            [def.key, def.value, def.description, req.user.id]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const { rows } = await pool.query(
        `SELECT * FROM platform_settings WHERE key = ANY($1) ORDER BY key ASC`,
        [RESET_DEFAULTS.map((d) => d.key)]
      );
      return ok(res, { data: rows.map(formatSetting) }, { message: 'Settings reset to defaults successfully.' });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/settings/reset failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/settings/batch-update (SPEC 2842-2850) ────────
  //
  // THE FIX (SPEC 2850's ⚠ "no transaction and no cache invalidation in
  // source" note): applied inside one transaction. ("No cache
  // invalidation" is moot here — see this file's top-of-file comment on
  // why `topochain_*` keys never enter limits.js's cache.) Every key is
  // validated (must exist AND be topochain_*-prefixed) BEFORE any write,
  // same ownership-first discipline as D6's update-display-orders.
  router.post('/api/v4/admin/settings/batch-update', adminWriteGate, async (req, res) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const items = Array.isArray(body.settings) ? body.settings : null;
      if (!items || items.length < 1) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { settings: ['The settings field is required and must have at least 1 item.'] },
        });
      }

      const parsed = [];
      const details = {};
      for (let i = 0; i < items.length; i++) {
        const item = items[i] || {};
        const key = item.key;
        const value = parseValue(item.value);
        if (!isTopochainKey(key)) { details[`settings.${i}.key`] = ['The key field must reference an existing topochain_ setting.']; continue; }
        if (value === undefined) { details[`settings.${i}.value`] = ['The value field must be numeric and >= 0.']; continue; }
        parsed.push({ key, value });
      }
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const keys = parsed.map((p) => p.key);
      const { rows: existingRows } = await client.query(
        `SELECT key FROM platform_settings WHERE key = ANY($1) AND key LIKE $2 ESCAPE '\\'`, [keys, PREFIX_LIKE_PATTERN]
      );
      const existingKeys = new Set(existingRows.map((r) => r.key));
      const offenders = keys.filter((k) => !existingKeys.has(k));
      if (offenders.length) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { settings: [`The following key(s) do not exist: ${offenders.join(', ')}.`] },
        });
      }

      await client.query('BEGIN');
      try {
        for (const item of parsed) {
          await client.query(
            'UPDATE platform_settings SET value = $1, updated_at = NOW(), updated_by = $2 WHERE key = $3',
            [String(item.value), req.user.id, item.key]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }

      const { rows } = await client.query(
        'SELECT * FROM platform_settings WHERE key = ANY($1) ORDER BY key ASC', [keys]
      );
      return ok(res, { data: rows.map(formatSetting) }, { message: 'Settings updated successfully.' });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/settings/batch-update failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    } finally {
      client.release();
    }
  });

  // ── POST /api/v4/admin/settings (SPEC 2801-2807) ─────────────────────
  router.post('/api/v4/admin/settings', adminWriteGate, async (req, res) => {
    try {
      const body = req.body || {};
      const details = {};

      const key = typeof body.key === 'string' ? body.key : '';
      if (!key || key.length > 255) {
        details.key = ['The key field is required and must be a string of at most 255 characters.'];
      } else if (!isTopochainKey(key)) {
        details.key = ['The key field must start with "topochain_".'];
      }

      const value = parseValue(body.value);
      if (value === undefined) details.value = ['The value field is required and must be numeric and >= 0.'];

      let description = null;
      if (body.description !== undefined && body.description !== null) {
        if (typeof body.description !== 'string' || body.description.length > 500) {
          details.description = ['The description field must be a string of at most 500 characters.'];
        } else {
          description = body.description;
        }
      }
      // SPEC 2805: "defaults to a generated sentence" when omitted.
      if (description === null && (body.description === undefined)) {
        description = `Custom topochain setting: ${key}.`;
      }

      if (!Object.keys(details).length) {
        const { rows: existingRows } = await pool.query('SELECT key FROM platform_settings WHERE key = $1', [key]);
        if (existingRows.length) details.key = ['The key has already been taken.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows } = await pool.query(
        `INSERT INTO platform_settings (key, value, description, updated_at, updated_by)
         VALUES ($1, $2, $3, NOW(), $4) RETURNING *`,
        [key, String(value), description, req.user.id]
      );

      return res.status(201).json({ success: true, data: formatSetting(rows[0]) });
    } catch (err) {
      if (err && err.code === '23505') {
        return fail(res, 422, 'The given data was invalid.', { details: { key: ['The key has already been taken.'] } });
      }
      log.error('topochain-admin', 'POST /admin/settings failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/settings/:key (SPEC 2809-2811) ─────────────────
  router.get('/api/v4/admin/settings/:key', async (req, res) => {
    try {
      const key = req.params.key;
      if (!isTopochainKey(key)) return fail(res, 404, 'Setting not found.');

      const { rows } = await pool.query('SELECT * FROM platform_settings WHERE key = $1', [key]);
      if (!rows.length) return fail(res, 404, 'Setting not found.');

      return ok(res, { data: formatSetting(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/settings/:key failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PUT|PATCH /api/v4/admin/settings/:key (SPEC 2813-2819) ───────────
  //
  // THE FIX (SPEC 2819's ⚠ "writes raw request input rather than
  // validated data... explicit null description causes a 500" note):
  // every write below comes from the VALIDATED `fields` object, never
  // straight off `req.body`. An explicit `description: null` is read
  // here as "clear it" (stores a real NULL, not the generated-default
  // sentence) — the smallest, least-surprising behavior for an explicit
  // null, and the one this file's own top comment on `formatSetting`
  // documents as a deliberate choice among the two the brief allows.
  async function updateSetting(req, res) {
    const currentKey = req.params.key;
    if (!isTopochainKey(currentKey)) return fail(res, 404, 'Setting not found.');

    try {
      const { rows: existingRows } = await pool.query('SELECT * FROM platform_settings WHERE key = $1', [currentKey]);
      const existing = existingRows[0];
      if (!existing) return fail(res, 404, 'Setting not found.');

      const body = req.body || {};
      const details = {};
      const fields = {};

      if (body.key !== undefined) {
        const newKey = typeof body.key === 'string' ? body.key : '';
        if (!newKey || newKey.length > 255) {
          details.key = ['The key field must be a string of at most 255 characters.'];
        } else if (!isTopochainKey(newKey)) {
          details.key = ['The key field must start with "topochain_".'];
        } else {
          fields.key = newKey;
        }
      }

      if (body.value !== undefined) {
        const value = parseValue(body.value);
        if (value === undefined) details.value = ['The value field must be numeric and >= 0.'];
        else fields.value = value;
      }

      // Explicit-null-vs-absent distinguished via `in`, not `!== undefined`
      // alone, since both null and undefined would otherwise collapse —
      // this is exactly the distinction the source's raw-input bug lost.
      if ('description' in body) {
        if (body.description === null) {
          fields.description = null;
        } else if (typeof body.description !== 'string' || body.description.length > 500) {
          details.description = ['The description field must be a string of at most 500 characters.'];
        } else {
          fields.description = body.description;
        }
      }

      if (!Object.keys(details).length && fields.key !== undefined && fields.key !== currentKey) {
        const { rows: clashRows } = await pool.query('SELECT key FROM platform_settings WHERE key = $1', [fields.key]);
        if (clashRows.length) details.key = ['The key has already been taken.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const columns = Object.keys(fields);
      if (columns.length === 0) return ok(res, { data: formatSetting(existing) });

      const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
      const values = columns.map((col) => (col === 'value' ? String(fields[col]) : fields[col]));
      const { rows: updatedRows } = await pool.query(
        `UPDATE platform_settings SET ${setClauses.join(', ')}, updated_at = NOW(), updated_by = $${columns.length + 2}
          WHERE key = $1 RETURNING *`,
        [currentKey, ...values, req.user.id]
      );

      return ok(res, { data: formatSetting(updatedRows[0]) });
    } catch (err) {
      if (err && err.code === '23505') {
        return fail(res, 422, 'The given data was invalid.', { details: { key: ['The key has already been taken.'] } });
      }
      log.error('topochain-admin', 'PUT /admin/settings/:key failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }
  router.put('/api/v4/admin/settings/:key', adminWriteGate, updateSetting);
  router.patch('/api/v4/admin/settings/:key', adminWriteGate, updateSetting);

  // ── DELETE /api/v4/admin/settings/:key (SPEC 2821-2823) ──────────────
  router.delete('/api/v4/admin/settings/:key', adminWriteGate, async (req, res) => {
    try {
      const key = req.params.key;
      if (!isTopochainKey(key)) return fail(res, 404, 'Setting not found.');

      const { rows } = await pool.query('DELETE FROM platform_settings WHERE key = $1 RETURNING key', [key]);
      if (!rows.length) return fail(res, 404, 'Setting not found.');

      return ok(res, {}, { message: 'Setting deleted successfully.' });
    } catch (err) {
      log.error('topochain-admin', 'DELETE /admin/settings/:key failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { settingsAdminRoutes };
