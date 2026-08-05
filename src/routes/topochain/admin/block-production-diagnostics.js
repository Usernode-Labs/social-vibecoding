// Topochain admin — privacy-safe block-production diagnostics.
//
// This is deliberately an aggregate READ over receiver-maintained
// epoch_stats. It does not infer a target, inspect raw device reports, or
// claim to diagnose the native producer. The parent admin router supplies
// the platform admin read gate.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { ok, fail, iso } = require('../helpers');
const { toIntId } = require('./util');

const MIN_COHORT_WALLETS = 5;
const LIMITATIONS = Object.freeze([
  'Receiver-reported aggregate diagnostics only; no success target or SLA is configured.',
  'App-version device reports do not provide the authoritative won-slot denominator, so app-version cohorts are not shown.',
  'Historical paused, delegated, and block-production-release state is unavailable per epoch, so those eligibility filters are not applied.',
  'Both event epoch bounds must be configured; unbounded events are reported as unavailable and never trigger an all-history scan.',
  'Current epoch rows are recomputed on every read; late receiver corrections and reorg updates appear only after their upsert lands.',
]);

function chainIds(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((v) => v.trim()).filter(Boolean))];
}

function whole(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function percent(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return Math.round((numerator / denominator) * 10000) / 100;
}

function formatCohort(chainId, row) {
  if (!row) return { chain_id: chainId, status: 'no_data' };

  const wallets = whole(row.wallet_count);
  if (wallets == null || wallets < MIN_COHORT_WALLETS) {
    return {
      chain_id: chainId,
      status: 'suppressed',
      minimum_cohort_wallets: MIN_COHORT_WALLETS,
    };
  }

  const counts = {
    epoch_wallet_rows: whole(row.epoch_wallet_rows),
    won_slots: whole(row.won_slots),
    produced_blocks: whole(row.produced_blocks),
    canonical_blocks: whole(row.canonical_blocks),
    orphaned_blocks: whole(row.orphaned_blocks),
    failed_blocks: whole(row.failed_blocks),
  };
  const qualityFlags = [];
  if (Object.values(counts).some((v) => v == null || v < 0)) {
    qualityFlags.push('invalid_aggregate_counter');
  }
  if (counts.produced_blocks > counts.won_slots) qualityFlags.push('produced_blocks_exceed_won_slots');
  if (counts.canonical_blocks > counts.produced_blocks) qualityFlags.push('canonical_blocks_exceed_produced_blocks');
  if (counts.canonical_blocks > counts.won_slots) qualityFlags.push('canonical_blocks_exceed_won_slots');
  if (counts.failed_blocks > counts.won_slots) qualityFlags.push('failed_blocks_exceed_won_slots');

  return {
    chain_id: chainId,
    status: 'ready',
    wallet_count: wallets,
    ...counts,
    first_epoch: whole(row.first_epoch),
    last_epoch: whole(row.last_epoch),
    canonical_success_rate: percent(counts.canonical_blocks, counts.won_slots),
    produced_success_rate: percent(counts.produced_blocks, counts.won_slots),
    canonicality_rate: percent(counts.canonical_blocks, counts.produced_blocks),
    last_updated_at: iso(row.last_updated_at),
    quality_flags: qualityFlags,
  };
}

function blockProductionDiagnosticsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/v4/admin/block-production-diagnostics', async (req, res) => {
    const suppliedEventId = req.query.season_event_id;
    const eventId = suppliedEventId == null || suppliedEventId === ''
      ? null : toIntId(suppliedEventId);
    if (suppliedEventId != null && suppliedEventId !== '' && !eventId) {
      return fail(res, 422, 'The given data was invalid.', {
        details: { season_event_id: ['The selected season_event_id is invalid.'] },
      });
    }

    try {
      const eventQuery = eventId
        ? {
            text: `SELECT id, name, chain_id, start_epoch, end_epoch, starts_at, ends_at
                     FROM season_events WHERE id = $1`,
            values: [eventId],
          }
        : {
            text: `SELECT id, name, chain_id, start_epoch, end_epoch, starts_at, ends_at
                     FROM season_events
                    WHERE is_active = TRUE AND internal = FALSE
                      AND starts_at <= NOW() AND ends_at >= NOW()
                    ORDER BY starts_at DESC, id DESC
                    LIMIT 1`,
            values: [],
          };
      const { rows: eventRows } = await pool.query(eventQuery.text, eventQuery.values);
      const event = eventRows[0] || null;
      if (eventId && !event) return fail(res, 404, 'Season event not found.');

      const baseData = {
        metric: {
          name: 'receiver_reported_canonical_success_rate',
          numerator: 'sum(epoch_canonical_blocks)',
          denominator: 'sum(epoch_won_slots)',
          aggregation: 'weighted_ratio_of_sums',
          target: null,
        },
        privacy: { minimum_cohort_wallets: MIN_COHORT_WALLETS },
        limitations: LIMITATIONS,
      };
      if (!event) {
        return ok(res, {
          data: {
            ...baseData,
            selection: 'latest_active_event',
            event: null,
            cohorts: [],
          },
        });
      }

      const configuredChains = chainIds(event.chain_id);
      const startEpoch = whole(event.start_epoch);
      const endEpoch = whole(event.end_epoch);
      const hasBoundedEpochs = startEpoch != null && startEpoch >= 0
        && endEpoch != null && endEpoch >= startEpoch;
      let rows = [];
      if (configuredChains.length && hasBoundedEpochs) {
        const params = [configuredChains, startEpoch, endEpoch];
        const outcome = await pool.query(
          `SELECT chain_id,
                  COUNT(DISTINCT wallet_address)::int AS wallet_count,
                  COUNT(*)::int AS epoch_wallet_rows,
                  MIN(epoch)::int AS first_epoch,
                  MAX(epoch)::int AS last_epoch,
                  SUM(epoch_won_slots)::bigint AS won_slots,
                  SUM(epoch_produced_blocks)::bigint AS produced_blocks,
                  SUM(epoch_canonical_blocks)::bigint AS canonical_blocks,
                  SUM(epoch_orphaned_blocks)::bigint AS orphaned_blocks,
                  SUM(epoch_failed_blocks)::bigint AS failed_blocks,
                  MAX(updated_at) AS last_updated_at
             FROM epoch_stats
            WHERE chain_id = ANY($1) AND epoch >= $2 AND epoch <= $3
            GROUP BY chain_id
            ORDER BY chain_id`,
          params
        );
        rows = outcome.rows;
      }
      const byChain = new Map(rows.map((row) => [row.chain_id, row]));

      return ok(res, {
        data: {
          ...baseData,
          selection: eventId ? 'explicit_event' : 'latest_active_event',
          event: {
            id: Number(event.id),
            name: event.name,
            chain_ids: configuredChains,
            start_epoch: startEpoch,
            end_epoch: endEpoch,
            starts_at: iso(event.starts_at),
            ends_at: iso(event.ends_at),
          },
          cohorts: configuredChains.map((id) => hasBoundedEpochs
            ? formatCohort(id, byChain.get(id))
            : {
                chain_id: id,
                status: 'unavailable',
                reason: 'event_epoch_bounds_required',
              }),
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /block-production-diagnostics failed', {
        message: err.message,
      });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = {
  MIN_COHORT_WALLETS,
  LIMITATIONS,
  chainIds,
  formatCohort,
  blockProductionDiagnosticsAdminRoutes,
};
