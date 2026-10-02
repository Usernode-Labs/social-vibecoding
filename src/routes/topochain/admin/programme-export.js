// Topochain v4 admin API — the whole programme as one CSV.
//
// GET /api/v4/admin/programme/export.csv is what an organiser hands to
// someone helping set a season up: every challenge in every season event,
// as the participant would read it, with the scoring rule that pays it, plus
// the templates nothing has been stamped from yet. One flat file, so the
// answer can come back as "change row 14's target to 3" rather than a
// screenshot tour of four admin screens.
//
// ROWS. One per challenge in every season event — internal (staff dry-run)
// events included, and flagged in `event_internal` so they can be filtered
// out rather than silently missing. A challenge that more than one rule
// applies to gets one row per rule: a rule binds either to the challenge
// itself or to the template it was stamped from (the
// `challenge_scoring_rules_one_binding` CHECK in src/db/schema.sql), the
// scorer pays both (services/topochain/challenge-scorer.js's
// RULE_CHALLENGES_SQL uses the same join), and the unique indexes allow at
// most one of each — so a challenge has zero, one or two rows, challenge-bound
// first. Then one row per template no challenge uses, last, with the
// template-bound rule it would carry (at most one, by the same index).
//
// VALUES. The text, metric and schedule columns are EFFECTIVE values — the
// challenge's own override, else its template's — because that is what the
// card shows. The one exception is the reward, kept as two columns
// (`template_reward`, `reward_override`), since "is this challenge's reward
// its own or inherited" is exactly the question a reviewer asks. Rule
// target/points are the rule's own overrides; empty means the rule pays by
// the challenge's metric_target and reward.
//
// FORMAT. RFC 4180: CRLF records, a header row, and every field through
// ../helpers.js `csvField`, which quotes on a comma, quote, CR or LF and
// neutralises a leading `=`, `+`, `-` or `@` with the spreadsheet-standard
// `'` — admin-typed text is going into a spreadsheet. Numeric columns are
// written bare instead, so a negative points value stays a number; only a
// value that IS a plain decimal skips the guard (see numberCell). A UTF-8
// BOM leads the file so Excel reads it as UTF-8 rather than the system code
// page.
//
// GATE. The router-wide adminReadGate in ../admin.js and nothing more: a
// view-only admin may download it. That is deliberately NOT the
// adminWriteGate the users and waitlist exports carry — those stream emails
// and registration codes, a data-egress class of their own. This file holds
// no personal data at all, only the programme configuration every admin can
// already read screen by screen.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { fail, iso, csvField } = require('../helpers');

// The CSV's columns, in file order, each with how its value is written.
// `text` goes through csvField; `number`, `bool` and `date` are values this
// system generated, written in a fixed shape.
const PROGRAMME_CSV_COLUMNS = [
  ['row_kind', 'text'],
  ['season_id', 'number'],
  ['season', 'text'],
  ['season_active', 'bool'],
  ['event_id', 'number'],
  ['event', 'text'],
  ['event_type', 'text'],
  ['event_internal', 'bool'],
  ['event_active', 'bool'],
  ['event_starts_at', 'date'],
  ['event_ends_at', 'date'],
  ['challenge_id', 'number'],
  ['display_order', 'number'],
  ['enabled', 'bool'],
  ['completed', 'bool'],
  ['template_id', 'number'],
  ['category', 'text'],
  ['title', 'text'],
  ['task', 'text'],
  ['template_reward', 'text'],
  ['reward_override', 'text'],
  ['cta_label', 'text'],
  ['cta_link', 'text'],
  ['metric_type', 'text'],
  ['metric_target', 'number'],
  ['schedule_start', 'date'],
  ['schedule_end', 'date'],
  ['rule_id', 'number'],
  ['rule_name', 'text'],
  ['rule_measure', 'text'],
  ['rule_bound_to', 'text'],
  ['rule_target', 'number'],
  ['rule_points', 'number'],
  ['rule_enabled', 'bool'],
  ['rule_interval_minutes', 'number'],
].map(([name, type]) => ({ name, type }));

// Both kinds of row in one statement, so the file is one consistent snapshot
// (a template cannot show up as both used and unused). The `sort_*` columns
// exist only for the ORDER BY a UNION needs on its output; the CSV never
// writes them.
//
// Order: season display_order (events with no season after every season),
// event starts_at (event id breaks a tie, so one event's rows stay together),
// category the way the challenge lists group it (UPPER(TRIM(...))), the
// challenge's display_order, its id, then challenge-bound rule before
// template-bound. Unused templates last, by category then id.
const PROGRAMME_EXPORT_SQL = `
  SELECT 'challenge' AS row_kind,
         s.id AS season_id, s.name AS season, s.is_active AS season_active,
         se.id AS event_id, se.name AS event, se.type AS event_type,
         se.internal AS event_internal, se.is_active AS event_active,
         se.starts_at AS event_starts_at, se.ends_at AS event_ends_at,
         c.id AS challenge_id, c.display_order, c.enabled, c.completed,
         ct.id AS template_id, ct.category,
         COALESCE(c.goal, ct.goal) AS title,
         COALESCE(c.task, ct.task) AS task,
         ct.reward AS template_reward,
         c.reward AS reward_override,
         COALESCE(c.cta_label, ct.cta_label) AS cta_label,
         COALESCE(c.cta_link, ct.cta_link) AS cta_link,
         COALESCE(c.metric_type, ct.metric_type) AS metric_type,
         COALESCE(c.metric_target, ct.metric_target) AS metric_target,
         COALESCE(c.schedule_start, ct.schedule_start) AS schedule_start,
         COALESCE(c.schedule_end, ct.schedule_end) AS schedule_end,
         r.id AS rule_id, r.name AS rule_name, r.measure AS rule_measure,
         CASE WHEN r.challenge_id IS NOT NULL THEN 'challenge'
              WHEN r.challenge_template_id IS NOT NULL THEN 'template' END AS rule_bound_to,
         r.target AS rule_target, r.points AS rule_points, r.enabled AS rule_enabled,
         r.interval_minutes AS rule_interval_minutes,
         0 AS sort_group, s.display_order AS sort_season, se.starts_at AS sort_starts,
         se.id AS sort_event, UPPER(TRIM(ct.category)) AS sort_category,
         c.display_order AS sort_order, c.id AS sort_id,
         CASE WHEN r.challenge_id IS NOT NULL THEN 0 ELSE 1 END AS sort_binding,
         r.id AS sort_rule
    FROM challenges c
    JOIN season_events se ON se.id = c.season_event_id
    LEFT JOIN seasons s ON s.id = se.season_id
    JOIN challenge_templates ct ON ct.id = c.challenge_template_id
    LEFT JOIN challenge_scoring_rules r
      ON r.challenge_id = c.id OR r.challenge_template_id = c.challenge_template_id
  UNION ALL
  SELECT 'unused_template',
         NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL,
         ct.id, ct.category,
         ct.goal, ct.task, ct.reward, NULL, ct.cta_label, ct.cta_link,
         ct.metric_type, ct.metric_target,
         ct.schedule_start, ct.schedule_end,
         r.id, r.name, r.measure,
         CASE WHEN r.id IS NOT NULL THEN 'template' END,
         r.target, r.points, r.enabled, r.interval_minutes,
         1, NULL, NULL, NULL, UPPER(TRIM(ct.category)), NULL, ct.id, 1, r.id
    FROM challenge_templates ct
    LEFT JOIN challenge_scoring_rules r ON r.challenge_template_id = ct.id
   WHERE NOT EXISTS (SELECT 1 FROM challenges c WHERE c.challenge_template_id = ct.id)
   ORDER BY sort_group ASC, sort_season ASC NULLS LAST, sort_starts ASC NULLS LAST,
            sort_event ASC NULLS LAST, sort_category ASC, sort_order ASC NULLS LAST,
            sort_id ASC, sort_binding ASC, sort_rule ASC NULLS LAST
`;

// A plain decimal: what pg hands back for BIGINT and NUMERIC columns. The
// only strings allowed past csvField's formula guard, and none of them can
// be a formula.
const PLAIN_DECIMAL_RE = /^-?\d+(\.\d+)?$/;

// A number written bare. NUMERIC(20,4) comes back as "100.0000"; trimming
// the zero fraction gives the 100 the admin typed, without the precision
// loss a round trip through a JS double could cause. Anything that is not
// a plain decimal falls back to csvField, so this path can never be used to
// smuggle text past the guard.
function numberCell(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = String(v).trim();
  if (!PLAIN_DECIMAL_RE.test(s)) return csvField(v);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function cell(type, v) {
  if (type === 'number') return numberCell(v);
  if (type === 'bool') return v == null ? '' : String(v === true);
  if (type === 'date') return iso(v) || '';
  return csvField(v);
}

const CRLF = '\r\n';
const BOM = '﻿';

// The whole file for a set of query rows: BOM, header, one record per row,
// each record CRLF-terminated (RFC 4180 §2.1-2.3).
function buildProgrammeCsv(rows) {
  const lines = [PROGRAMME_CSV_COLUMNS.map((c) => c.name).join(',')];
  for (const row of rows) {
    lines.push(PROGRAMME_CSV_COLUMNS.map((c) => cell(c.type, row[c.name])).join(','));
  }
  return `${BOM}${lines.join(CRLF)}${CRLF}`;
}

// `programme-<YYYY-MM-DD>.csv`, the UTC day — the same clock the waitlist
// export names its file by.
function programmeCsvFilename(now = new Date()) {
  return `programme-${now.toISOString().slice(0, 10)}.csv`;
}

function programmeExportAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/programme/export.csv ───────────────────────────
  // Read-only, so the router-wide adminReadGate is its whole gate (see the
  // file header for why it is not the write gate).
  router.get('/api/v4/admin/programme/export.csv', async (_req, res) => {
    try {
      const { rows } = await pool.query(PROGRAMME_EXPORT_SQL);
      const body = buildProgrammeCsv(rows);
      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${programmeCsvFilename()}"`);
      // A snapshot of configuration that changes while a season is being
      // set up: never answer a second download from a cache.
      res.setHeader('Cache-Control', 'no-store');
      return res.end(body);
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/programme/export.csv failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = {
  programmeExportAdminRoutes,
  buildProgrammeCsv,
  programmeCsvFilename,
  PROGRAMME_CSV_COLUMNS,
  PROGRAMME_EXPORT_SQL,
};
