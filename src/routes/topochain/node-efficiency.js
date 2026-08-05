'use strict';

const { Router } = require('express');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { mobileTokenAuth } = require('../../middleware/topochain-auth');
const { ok, fail, num } = require('./helpers');

const ALLOWED_WINDOWS = new Set([24, 168, 720]);
const DEFAULT_WINDOW_HOURS = 168;

function parseWindowHours(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_WINDOW_HOURS;
  const encoded = String(raw).trim();
  if (!/^\d+$/.test(encoded)) return null;
  const value = Number(encoded);
  if (String(value) !== encoded) return null;
  return Number.isInteger(value) && ALLOWED_WINDOWS.has(value) ? value : null;
}

function count(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableNumber(value) {
  const parsed = num(value);
  return parsed === null ? null : parsed;
}

function percent(numerator, denominator) {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

const SUMMARY_SQL = `
  WITH scoped AS (
    SELECT id, captured_at_ms, outcome, canonical, battery_level,
           wakelock_held, foreground_service_running, app_state,
           network_connected, network_type, alarm_scheduled_at_ms,
           alarm_fired_at_ms, build_ms, db_diff_ms, sign_ms, inject_ms,
           batch_fetch_ms, hydration_visible_ms
      FROM slot_outcome_reports
     WHERE user_id = $1
       AND captured_at_ms >= FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
                            - ($2::bigint * 3600000)
  )
  SELECT
    COUNT(*) AS report_count,
    COUNT(*) FILTER (WHERE outcome = 'produced') AS produced_count,
    COUNT(*) FILTER (WHERE canonical IS TRUE) AS canonical_count,
    COUNT(battery_level) AS battery_sample_count,
    MIN(battery_level) AS battery_min,
    MAX(battery_level) AS battery_max,
    (SELECT battery_level
       FROM scoped
      WHERE battery_level IS NOT NULL
      ORDER BY captured_at_ms DESC, id DESC
      LIMIT 1) AS battery_latest,
    COUNT(*) FILTER (WHERE wakelock_held IS TRUE) AS wakelock_held_count,
    COUNT(*) FILTER (WHERE foreground_service_running IS TRUE) AS foreground_service_count,
    COUNT(*) FILTER (
      WHERE wakelock_held IS TRUE AND LOWER(COALESCE(app_state, '')) = 'background'
    ) AS background_wakelock_count,
    COUNT(*) FILTER (WHERE network_connected IS TRUE) AS connected_count,
    COUNT(*) FILTER (WHERE network_connected IS FALSE) AS disconnected_count,
    COUNT(*) FILTER (WHERE LOWER(COALESCE(network_type, '')) IN ('wifi', 'wi-fi')) AS wifi_count,
    COUNT(*) FILTER (
      WHERE LOWER(COALESCE(network_type, '')) IN ('cellular', 'mobile', '4g', '5g', 'lte')
    ) AS cellular_count,
    COUNT(*) FILTER (
      WHERE network_type IS NOT NULL
        AND LOWER(network_type) NOT IN ('wifi', 'wi-fi', 'cellular', 'mobile', '4g', '5g', 'lte')
    ) AS other_network_count,
    PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY alarm_fired_at_ms - alarm_scheduled_at_ms)
      FILTER (WHERE alarm_fired_at_ms >= alarm_scheduled_at_ms) AS alarm_lateness_p50,
    PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY alarm_fired_at_ms - alarm_scheduled_at_ms)
      FILTER (WHERE alarm_fired_at_ms >= alarm_scheduled_at_ms) AS alarm_lateness_p95,
    PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY build_ms)
      FILTER (WHERE build_ms IS NOT NULL) AS build_p50,
    PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY build_ms)
      FILTER (WHERE build_ms IS NOT NULL) AS build_p95,
    PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY db_diff_ms)
      FILTER (WHERE db_diff_ms IS NOT NULL) AS db_diff_p50,
    PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY db_diff_ms)
      FILTER (WHERE db_diff_ms IS NOT NULL) AS db_diff_p95,
    PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY sign_ms)
      FILTER (WHERE sign_ms IS NOT NULL) AS sign_p50,
    PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY sign_ms)
      FILTER (WHERE sign_ms IS NOT NULL) AS sign_p95,
    PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY inject_ms)
      FILTER (WHERE inject_ms IS NOT NULL) AS inject_p50,
    PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY inject_ms)
      FILTER (WHERE inject_ms IS NOT NULL) AS inject_p95,
    PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY batch_fetch_ms)
      FILTER (WHERE batch_fetch_ms IS NOT NULL) AS batch_fetch_p50,
    PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY batch_fetch_ms)
      FILTER (WHERE batch_fetch_ms IS NOT NULL) AS batch_fetch_p95,
    PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY hydration_visible_ms)
      FILTER (WHERE hydration_visible_ms IS NOT NULL) AS hydration_visible_p50,
    PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY hydration_visible_ms)
      FILTER (WHERE hydration_visible_ms IS NOT NULL) AS hydration_visible_p95
  FROM scoped
`;

function timing(row, field) {
  return {
    p50: nullableNumber(row[`${field}_p50`]),
    p95: nullableNumber(row[`${field}_p95`]),
  };
}

function buildSummary(row, windowHours) {
  const reports = count(row.report_count);
  const produced = count(row.produced_count);
  return {
    window_hours: windowHours,
    source: 'device_reported',
    advisory: true,
    affects_rewards: false,
    telemetry_collection_changed: false,
    production: {
      reports,
      produced_reports: produced,
      canonical_reports: count(row.canonical_count),
      reported_production_rate_percent: percent(produced, reports),
    },
    battery: {
      sample_count: count(row.battery_sample_count),
      min_percent: nullableNumber(row.battery_min),
      max_percent: nullableNumber(row.battery_max),
      latest_percent: nullableNumber(row.battery_latest),
    },
    runtime: {
      wakelock_held_reports: count(row.wakelock_held_count),
      foreground_service_reports: count(row.foreground_service_count),
      background_wakelock_reports: count(row.background_wakelock_count),
    },
    connectivity: {
      connected_reports: count(row.connected_count),
      disconnected_reports: count(row.disconnected_count),
      wifi_reports: count(row.wifi_count),
      cellular_reports: count(row.cellular_count),
      other_network_reports: count(row.other_network_count),
    },
    timing_ms: {
      alarm_lateness: timing(row, 'alarm_lateness'),
      build: timing(row, 'build'),
      db_diff: timing(row, 'db_diff'),
      sign: timing(row, 'sign'),
      inject: timing(row, 'inject'),
      batch_fetch: timing(row, 'batch_fetch'),
      hydration_visible: timing(row, 'hydration_visible'),
    },
  };
}

function topochainNodeEfficiencyRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/v4/mobile/me/node-efficiency', mobileTokenAuth(config), async (req, res) => {
    const windowHours = parseWindowHours(req.query.window_hours);
    if (windowHours === null) {
      return fail(res, 422, 'The given data was invalid.', {
        details: { window_hours: ['The window_hours field must be one of 24, 168, or 720.'] },
      });
    }

    try {
      const { rows } = await pool.query(SUMMARY_SQL, [req.user.id, windowHours]);
      return ok(res, { data: buildSummary(rows[0] || {}, windowHours) });
    } catch (err) {
      log.error('topochain-node-efficiency', 'GET /me/node-efficiency failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = {
  topochainNodeEfficiencyRoutes,
  parseWindowHours,
  buildSummary,
  SUMMARY_SQL,
};
